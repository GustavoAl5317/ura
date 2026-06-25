import net from 'net';
import { RealtimeClient } from '../realtime/client';
import { AudioSocketProtocol, AUDIOSOCKET_TYPE } from '../audiosocket/protocol';
import { upsample8to24, downsample24to8 } from '../audio/resampler';
import { AudioPacer, SLIN_CHUNK_BYTES, writeAudioSocketFrame } from '../audio/pacer';
import { synthesize } from '../tts/elevenlabs';
import { registerTools } from '../tools/handlers';
import { createContext } from './context';
import { buildSystemPrompt } from '../prompts/system';
import { TOOL_DEFINITIONS } from '../tools/definitions';
import { sgp } from '../integrations/sgp';
import { ami } from '../integrations/ami';
import { getRegistration } from '../http/sidecar';
import { config } from '../config';
import { logger } from '../logger';
import { KEYBOARD_TYPING } from '../audio/tone';

const FILLERS = [
  'Só um instante, estou consultando...',
  'Aguarda um momentinho, já estou verificando...',
  'Deixa eu ver aqui, me aguarda um pouquinho...',
  'Um momentinho, estou checando pra você...',
  'Estou consultando, aguarda só um instante...',
];

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

  constructor(socket: net.Socket) {
    this.socket = socket;
    this.pacer = new AudioPacer(
      (frame) => writeAudioSocketFrame(this.socket, frame),
      config.audio.preBufferMs,
    );
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

    if (callerNumber) {
      try {
        const cliente = await sgp.buscarPorTelefone(callerNumber);
        if (cliente) {
          this.ctx.cliente = cliente;
          this.ctx.clienteIdentificado = true;
          this.ctx.clienteConfirmado = true;
          logger.info(`[${uuid}] Cliente identificado pelo telefone: ${cliente.nome}`);
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
    this.rt.sendAudio(upsample8to24(pcm8k));
  }

  private setupRealtimeEvents(callId: string): void {
    this.rt.on('responseCreated', () => {
      this.pacer.setHoldStream(true);
    });

    this.rt.on('audio', (pcm24k: Buffer) => {
      if (this.waitingAnaAfterTool && this.toolsInFlight === 0) {
        this.fillerCancel.cancelled = true;
        this.fillerLoopRunning = false;
        this.waitingAnaAfterTool = false;
      }

      this.pacer.enqueue(downsample24to8(pcm24k));
    });

    this.rt.on('textDelta', (delta: string) => {
      this.textBuf += delta;
    });

    const useNativeAudio = config.openai.realtimeModel.startsWith('gpt-realtime');

    this.rt.on('textDone', (text: string) => {
      if (text.trim()) logger.info(`[${callId}] 🤖 Ana: ${text.trim()}`);
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

    this.rt.on('toolStart', () => {
      this.toolsInFlight++;
      this.waitingAnaAfterTool = false;
      this.startTypingSound();
    });

    this.rt.on('toolSlowdown', () => {
      const filler = FILLERS[Math.floor(Math.random() * FILLERS.length)];
      if (config.tts.provider === 'elevenlabs' && !useNativeAudio) {
        this.ttsQueue = this.ttsQueue.then(() => this.synthesizeAndSend(filler));
      } else {
        this.rt.injectSystemNote(`[SISTEMA: consulta em andamento, diga brevemente ao cliente: "${filler}"]`);
      }
    });

    this.rt.on('toolDone', () => {
      this.toolsInFlight = Math.max(0, this.toolsInFlight - 1);
      if (this.toolsInFlight === 0) {
        this.waitingAnaAfterTool = true;
      }
    });

    this.rt.on('userSpeech', (text: string) => {
      logger.info(`[${callId}] 👤 Cliente: ${text}`);
      // Barge-in só com fala real transcrita — speechStart/VAD cortava a Ana por eco do softphone
      if (config.vad.interruptResponse && text.trim().length >= 2) {
        this.pacer.flush();
        this.stopTypingSound();
        this.resetSilenceTimer();
      }
    });

    // speechStart: não limpar fila — VAD falso (Jabber/ruído) cortava a saudação inteira

    this.rt.on('responseDone', () => {
      this.pacer.setHoldStream(false);
    });

    this.rt.on('close', () => {
      logger.info(`[${callId}] Realtime fechado`);
      void this.handleRealtimeDisconnect(callId);
    });

    this.rt.on('error', (err: Error) => {
      logger.error(`[${callId}] Realtime erro`, { err: err.message });
      void this.handleRealtimeDisconnect(callId);
    });
  }

  private async synthesizeAndSend(text: string): Promise<void> {
    try {
      const pcm8k = await synthesize(text);
      this.pacer.enqueue(pcm8k);
      const ms = Math.ceil(pcm8k.length / SLIN_CHUNK_BYTES) * 20 + 80;
      await sleep(ms);
      await sleep(config.audio.endPauseMs);
    } catch (err: any) {
      logger.error(`[${this.ctx.callId}] TTS erro`, { err: err.message });
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
    void this.playFillerLoop(this.fillerCancel, KEYBOARD_TYPING);
  }

  private stopTypingSound(): void {
    this.fillerCancel.cancelled = true;
    this.fillerLoopRunning = false;
    this.waitingAnaAfterTool = false;
    this.toolsInFlight = 0;
  }

  private async playFillerLoop(cancel: { cancelled: boolean }, sample: Buffer = KEYBOARD_TYPING): Promise<void> {
    let pos = 0;
    while (!cancel.cancelled && !this.socket.destroyed && !this.tearing) {
      const end = Math.min(pos + SLIN_CHUNK_BYTES, sample.length);
      const slice = sample.subarray(pos, end);
      if (slice.length === SLIN_CHUNK_BYTES) {
        this.pacer.enqueue(slice);
      }
      pos = end >= sample.length ? 0 : end;
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
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    if (this.hangupTimer) clearTimeout(this.hangupTimer);
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
