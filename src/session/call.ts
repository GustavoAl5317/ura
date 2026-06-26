import net from 'net';
import { RealtimeClient } from '../realtime/client';
import { AudioSocketProtocol, AUDIOSOCKET_TYPE } from '../audiosocket/protocol';
import { upsample8to24, downsample24to8 } from '../audio/resampler';
import { AudioPacer, SLIN_CHUNK_BYTES, writeAudioSocketFrame } from '../audio/pacer';
import { MicRingBuffer } from '../audio/mic-ring';
import { synthesize, synthesizeStream } from '../tts/elevenlabs';
import { registerTools } from '../tools/handlers';
import { createContext } from './context';
import { buildSystemPrompt } from '../prompts/system';
import { TOOL_DEFINITIONS } from '../tools/definitions';
import { sgp } from '../integrations/sgp';
import { ami } from '../integrations/ami';
import { getRegistration } from '../http/sidecar';
import { config } from '../config';
import { logger } from '../logger';
import { getWaitSound } from '../audio/wait-sound';
import { sessionRegistry } from '../admin/registry';
import { saveCallHistory } from '../admin/history';

const SILENCE_WARN_MS  = 35_000;
const SILENCE_HANGUP_MS = 20_000;

export class CallSession {
  private parser = new AudioSocketProtocol();
  private rt = new RealtimeClient();
  private ctx = createContext('', '');
  private socket: net.Socket;
  private pacer: AudioPacer;
  private ttsQueue: Promise<void> = Promise.resolve();
  private textBuf = '';
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  private hangupTimer: ReturnType<typeof setTimeout> | null = null;
  private tearing = false;
  private fillerCancel = { cancelled: false };
  private toolsInFlight = 0;
  private waitingAnaAfterTool = false;
  private fillerLoopRunning = false;
  private releaseHoldTimer: ReturnType<typeof setTimeout> | null = null;
  private userResponseTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingSpeechStop = false;
  private ttsGeneration = 0;
  private lastToolName = '';
  private clientSpeaking = false;
  private respondedSinceLastSpeech = false;
  private readonly micRing: MicRingBuffer;

  constructor(socket: net.Socket) {
    this.socket = socket;
    this.pacer = new AudioPacer(
      (frame) => writeAudioSocketFrame(this.socket, frame),
      {
        preBufferMs: config.audio.preBufferMs,
        startBufferMs: config.audio.startBufferMs,
        minBufferMs: config.audio.minBufferMs,
        maxBufferMs: config.audio.maxBufferMs,
        inputMuteMs: config.audio.inputMuteMs,
      },
    );
    const ringBytes = Math.ceil(24_000 * 2 * (config.audio.inputRingMs / 1000));
    this.micRing = new MicRingBuffer(ringBytes);
  }

  start(): void {
    this.socket.on('data', (d) => this.onData(d));
    this.socket.on('end', () => this.teardown());
    this.socket.on('error', (e) => {
      logger.error('Socket erro', { err: e.message });
      this.teardown();
    });
  }

  private onData(raw: Buffer): void {
    for (const msg of this.parser.feed(raw)) {
      switch (msg.type) {
        case AUDIOSOCKET_TYPE.UUID:
          void this.onUuid(msg.payload);
          break;
        case AUDIOSOCKET_TYPE.AUDIO:
          this.onAudio(msg.payload);
          break;
        case AUDIOSOCKET_TYPE.HANGUP:
          this.teardown();
          break;
      }
    }
  }

  private async onUuid(payload: Buffer): Promise<void> {
    const hex = payload.toString('hex');
    const uuid = hex.replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5');
    const reg = getRegistration(uuid) ?? getRegistration(hex);
    const callerNumber = reg?.callerNumber ?? '';

    this.ctx = createContext(uuid, callerNumber);
    if (reg?.channel) this.ctx.asteriskChannel = reg.channel;
    logger.info(`[${uuid}] Chamada iniciada`, {
      callerNumber: callerNumber || '(desconhecido)',
      channel: reg?.channel || '(desconhecido)',
    });

    sessionRegistry.register(uuid, { callerNumber, channel: reg?.channel });

    if (callerNumber) {
      try {
        const cliente = await sgp.buscarPorTelefone(callerNumber);
        if (cliente) {
          this.ctx.cliente = cliente;
          this.ctx.clienteIdentificado = true;
          this.ctx.clienteConfirmado = true;
          this.ctx.contratoSelecionado = cliente.contratos.length === 1 && !!cliente.contratoId;
          logger.info(`[${uuid}] Cliente identificado pelo telefone: ${cliente.nome}` +
            (cliente.contratos.length > 1 ? ` (${cliente.contratos.length} contratos — aguardando seleção)` : ''));
          sessionRegistry.updateMeta(uuid, {
            clienteNome: cliente.nome,
            contratoId: cliente.contratoId,
          });
        }
      } catch (err: any) {
        logger.warn(`[${uuid}] Não foi possível identificar pelo telefone`, { err: err.message });
      }
    }

    registerTools(this.rt, this.ctx);
    this.setupRealtimeEvents(uuid);

    const instructions = buildSystemPrompt(this.ctx);
    try {
      await this.rt.connect(uuid, instructions, TOOL_DEFINITIONS);
      logger.info(`[${uuid}] Sessão pronta`);
      this.pacer.start();
      this.resetSilenceTimer();
      this.rt.once('sessionReady', () => {
        logger.info(`[${uuid}] Sessão configurada — iniciando saudação`);
        this.rt.createResponse();
      });
    } catch (err: any) {
      logger.error(`[${uuid}] Falha ao conectar Realtime`, { err: err.message });
      this.teardown();
    }
  }

  private onAudio(pcm8k: Buffer): void {
    const pcm24 = upsample8to24(pcm8k);
    if (this.isMicBlocked()) {
      this.micRing.push(pcm24);
      return;
    }
    this.micRing.drain((chunk) => this.rt.sendAudio(chunk));
    this.rt.sendAudio(pcm24);
  }

  private isMicBlocked(): boolean {
    return this.rt.isResponseActive() || this.pacer.isMicGated();
  }

  private scheduleUserResponse(callId: string, retries = 0, delayMs?: number): void {
    const MAX_RETRIES = 20;
    const RETRY_INTERVAL_MS = 300;
    const firstDelay = delayMs ?? config.vad.speechStopDelayMs;
    if (this.userResponseTimer) clearTimeout(this.userResponseTimer);
    this.userResponseTimer = setTimeout(() => {
      this.userResponseTimer = null;
      if (this.tearing || this.socket.destroyed) return;
      if (this.rt.isResponseActive()) {
        if (retries < MAX_RETRIES) {
          logger.debug(`[${callId}] scheduleUserResponse reagendado (retry=${retries + 1})`);
          this.scheduleUserResponse(callId, retries + 1, RETRY_INTERVAL_MS);
        } else {
          logger.warn(`[${callId}] scheduleUserResponse esgotou retries — forçando`);
          this.rt.createResponse(true);
        }
        return;
      }
      logger.info(`[${callId}] Gerando resposta após fala do cliente`);
      this.rt.createResponse();
    }, retries === 0 ? firstDelay : RETRY_INTERVAL_MS);
  }

  private tryPendingSpeechStop(callId: string): void {
    if (!this.pendingSpeechStop) return;
    this.pendingSpeechStop = false;
    // Delay curto pois já esperamos no holdRelease
    this.scheduleUserResponse(callId, 0, 300);
  }

  private setupRealtimeEvents(callId: string): void {
    this.rt.on('responseCreated', () => {
      if (this.userResponseTimer) {
        clearTimeout(this.userResponseTimer);
        this.userResponseTimer = null;
      }
      // Resposta já criada — cancela pending para evitar resposta dupla
      this.pendingSpeechStop = false;
      this.respondedSinceLastSpeech = true;
      this.pacer.setHoldStream(true);
    });

    this.rt.on('audio', (pcm24k: Buffer) => {
      if (this.waitingAnaAfterTool && this.toolsInFlight === 0) {
        this.fillerCancel.cancelled = true;
        this.fillerLoopRunning = false;
        this.waitingAnaAfterTool = false;
      }

      this.pacer.enqueue(downsample24to8(pcm24k), true);
    });

    this.rt.on('textDelta', (delta: string) => {
      this.textBuf += delta;
    });

    const useNativeAudio = config.openai.realtimeModel.startsWith('gpt-realtime');

    this.rt.on('textDone', (text: string) => {
      if (text.trim()) {
        logger.info(`[${callId}] 🤖 Ana (texto): ${text.trim()}`);
        sessionRegistry.emit(callId, 'assistant_text', text.trim());
      }
      if (config.tts.provider === 'elevenlabs' && !useNativeAudio && text.trim()) {
        this.ttsQueue = this.ttsQueue.then(() => this.synthesizeAndSend(text));
      }
      this.textBuf = '';

      if (this.ctx.pendingTransfer) {
        this.ctx.pendingTransfer = false;
        void this.executeTransfer(callId);
      } else if (this.ctx.pendingHangup) {
        this.ctx.pendingHangup = false;
        setTimeout(() => this.teardown(), config.audio.endPauseMs + 500);
      }
      this.resetSilenceTimer();
    });

    this.rt.on('toolStart', (name: string) => {
      this.lastToolName = name;
      this.toolsInFlight++;
      this.waitingAnaAfterTool = false;
      this.startTypingSound();
      sessionRegistry.emit(callId, 'tool_start', `Consulta: ${name}`, { tool: name });
    });

    this.rt.on('toolSlowdown', () => {
      // Mantém som de digitação — não interrompe com fala da Ana
      this.startTypingSound();
    });

    this.rt.on('toolDone', () => {
      this.toolsInFlight = Math.max(0, this.toolsInFlight - 1);
      if (this.toolsInFlight === 0) {
        this.waitingAnaAfterTool = true;
      }
      if (this.lastToolName) {
        sessionRegistry.emit(callId, 'tool_done', `Concluído: ${this.lastToolName}`, { tool: this.lastToolName });
      }
    });

    this.rt.on('speechStart', () => {
      logger.info(`[${callId}] 🎤 Cliente falando...`);
      this.clientSpeaking = true;
      this.respondedSinceLastSpeech = false;
      if (this.userResponseTimer) {
        clearTimeout(this.userResponseTimer);
        this.userResponseTimer = null;
      }
      if (this.pacer.isPlaying() || this.rt.isResponseActive() || this.fillerLoopRunning) {
        this.interruptAssistantSpeech(callId);
      }
    });

    this.rt.on('speechStop', () => {
      logger.info(`[${callId}] 🎤 Cliente parou de falar`);
      this.clientSpeaking = false;
      if (this.rt.isResponseActive()) {
        this.pendingSpeechStop = true;
        return;
      }
      this.scheduleUserResponse(callId);
    });

    this.rt.on('userSpeech', (text: string) => {
      logger.info(`[${callId}] 👤 Cliente (transcrição): ${text}`);
      sessionRegistry.emit(callId, 'client_speech', text);
      this.resetSilenceTimer();

      // Não cria fallback se:
      // 1) Timer do speechStop já ativo (caminho rápido)
      // 2) Já respondemos desde o último speechStop (transcrição tardia)
      // 3) Cliente ainda está falando (não interromper)
      if (this.userResponseTimer || this.respondedSinceLastSpeech || this.clientSpeaking) {
        logger.debug(`[${callId}] Transcrição: skip fallback (timer=${!!this.userResponseTimer} responded=${this.respondedSinceLastSpeech} speaking=${this.clientSpeaking})`);
        return;
      }

      const scheduleTranscriptFallback = (attempt = 0) => {
        const MAX_ATTEMPTS = 8;
        this.userResponseTimer = setTimeout(() => {
          this.userResponseTimer = null;
          if (this.tearing || this.socket.destroyed) return;
          // Não responde se cliente voltou a falar
          if (this.clientSpeaking) {
            logger.debug(`[${callId}] Fallback cancelado — cliente falando`);
            return;
          }
          if (this.rt.isResponseActive()) {
            if (attempt < MAX_ATTEMPTS) {
              scheduleTranscriptFallback(attempt + 1);
            } else {
              logger.warn(`[${callId}] Forçando resposta após ${MAX_ATTEMPTS} tentativas`);
              this.rt.createResponse(true);
            }
            return;
          }
          logger.warn(`[${callId}] Sem resposta após transcrição — forçando`);
          this.rt.createResponse();
        }, attempt === 0 ? 3_000 : 1_000);
      };
      scheduleTranscriptFallback();
    });

    const HOLD_RELEASE_MAX_MS = 15_000;

    const scheduleHoldRelease = () => {
      if (this.releaseHoldTimer) clearTimeout(this.releaseHoldTimer);
      const startedAt = Date.now();
      const attempt = () => {
        if (Date.now() - startedAt > HOLD_RELEASE_MAX_MS) {
          logger.warn(`[${callId}] holdStream forçado a liberar (timeout)`);
          this.pacer.setHoldStream(false);
          this.tryPendingSpeechStop(callId);
          return;
        }
        if (this.pacer.getQueueLength() > 0 || this.rt.isResponseActive()) {
          this.releaseHoldTimer = setTimeout(attempt, 40);
          return;
        }
        this.releaseHoldTimer = setTimeout(() => {
          if (this.pacer.getQueueLength() === 0 && !this.rt.isResponseActive()) {
            this.pacer.setHoldStream(false);
            this.tryPendingSpeechStop(callId);
          }
        }, 250);
      };
      attempt();
    };

    this.rt.on('audioOutputDone', () => scheduleHoldRelease());

    this.rt.on('responseDone', () => scheduleHoldRelease());

    this.rt.on('close', () => {
      logger.info(`[${callId}] Realtime fechado`);
      void this.handleRealtimeDisconnect(callId);
    });

    this.rt.on('error', (err: Error) => {
      logger.error(`[${callId}] Realtime erro`, { err: err.message });
      void this.handleRealtimeDisconnect(callId);
    });
  }

  private interruptAssistantSpeech(callId: string): void {
    this.ttsGeneration++;
    this.stopTypingSound();
    this.pacer.flush();
    this.pacer.setHoldStream(false);
    if (this.releaseHoldTimer) {
      clearTimeout(this.releaseHoldTimer);
      this.releaseHoldTimer = null;
    }
    if (this.rt.isResponseActive()) {
      this.rt.cancelResponse();
    }
    logger.info(`[${callId}] Cliente interrompeu a fala da Ana`);
  }

  private async synthesizeAndSend(text: string): Promise<void> {
    const gen = this.ttsGeneration;
    this.startTypingSound();
    try {
      let firstChunk = true;
      await synthesizeStream(text, (pcm8k) => {
        if (gen !== this.ttsGeneration) return;
        if (firstChunk) {
          this.stopTypingSound();
          firstChunk = false;
        }
        this.pacer.enqueue(pcm8k);
      });
      if (gen !== this.ttsGeneration) return;
      this.stopTypingSound();
      await this.pacer.drain();
      if (gen !== this.ttsGeneration) return;
      await sleep(config.audio.endPauseMs);
    } catch (err: any) {
      if (gen === this.ttsGeneration) {
        logger.error(`[${this.ctx.callId}] TTS erro`, { err: err.message });
      }
    }
  }

  private async executeTransfer(callId: string): Promise<void> {
    logger.info(`[${callId}] Executando transferência para atendente`);
    try {
      await ami.connect();
      if (this.ctx.asteriskChannel) {
        await ami.redirect(
          this.ctx.asteriskChannel,
          config.ami.transferExten,
          config.ami.transferContext,
        );
      } else {
        logger.warn(`[${callId}] Canal Asterisk não conhecido — não foi possível redirecionar via AMI`);
      }
    } catch (err: any) {
      logger.error(`[${callId}] Erro na transferência AMI`, { err: err.message });
    }
  }

  private startTypingSound(): void {
    if (this.fillerLoopRunning) return;
    this.fillerCancel = { cancelled: false };
    this.fillerLoopRunning = true;
    void this.playFillerLoop(this.fillerCancel, getWaitSound());
  }

  private stopTypingSound(): void {
    this.fillerCancel.cancelled = true;
    this.fillerLoopRunning = false;
    this.waitingAnaAfterTool = false;
    this.toolsInFlight = 0;
  }

  private async playFillerLoop(cancel: { cancelled: boolean }, sample?: Buffer): Promise<void> {
    const loop = sample ?? getWaitSound();
    let pos = 0;
    while (!cancel.cancelled && !this.socket.destroyed && !this.tearing) {
      const end = Math.min(pos + SLIN_CHUNK_BYTES, loop.length);
      const slice = loop.subarray(pos, end);
      if (slice.length > 0) {
        this.pacer.enqueue(Buffer.from(slice));
      }
      pos = end >= loop.length ? 0 : end;
      await sleep(20);
    }
    this.fillerLoopRunning = false;
  }

  private resetSilenceTimer(): void {
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    if (this.hangupTimer) clearTimeout(this.hangupTimer);
    this.hangupTimer = null;
    this.silenceTimer = setTimeout(() => this.onSilenceWarning(), SILENCE_WARN_MS);
  }

  private onSilenceWarning(): void {
    if (this.tearing || this.socket.destroyed) return;
    logger.warn(`[${this.ctx.callId}] Silêncio prolongado — verificando linha`);
    this.rt.injectSystemNote('[SISTEMA: silêncio prolongado detectado]');
    this.hangupTimer = setTimeout(() => {
      logger.warn(`[${this.ctx.callId}] Sem resposta após aviso — encerrando`);
      this.teardown();
    }, SILENCE_HANGUP_MS);
  }

  private async handleRealtimeDisconnect(callId: string): Promise<void> {
    if (this.tearing) return;
    logger.warn(`[${callId}] OpenAI desconectado — executando fallback`);

    if (config.tts.provider === 'elevenlabs' && !this.socket.destroyed) {
      try {
        const pcm = await synthesize(
          'Tive uma instabilidade no sistema. Vou te transferir para um de nossos atendentes agora.',
        );
        this.pacer.enqueue(pcm);
        await sleep(Math.ceil(pcm.length / SLIN_CHUNK_BYTES) * 20 + 200);
      } catch {
        // sem áudio
      }
    }

    await this.executeTransfer(callId);
    setTimeout(() => this.teardown(), 3_000);
  }

  private teardown(): void {
    if (this.tearing) return;
    this.tearing = true;
    this.stopTypingSound();
    this.pacer.stop();
    if (this.releaseHoldTimer) clearTimeout(this.releaseHoldTimer);
    if (this.userResponseTimer) clearTimeout(this.userResponseTimer);
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    if (this.hangupTimer) clearTimeout(this.hangupTimer);
    const ended = sessionRegistry.end(this.ctx.callId);
    if (ended) saveCallHistory(ended, [...this.ctx.log]);
    logger.info(`[${this.ctx.callId}] Chamada encerrada`);
    if (!this.socket.destroyed) {
      this.socket.write(AudioSocketProtocol.hangup());
      this.socket.destroy();
    }
    this.rt.close();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
