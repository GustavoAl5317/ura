import net from 'net';
import { RealtimeClient } from '../realtime/client';
import { AudioSocketProtocol, AUDIOSOCKET_TYPE } from '../audiosocket/protocol';
import { upsample8to24, downsample24to8, downsample16to8 } from '../audio/resampler';
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

const CHUNK = 320;  // 160 samples × 2 bytes = 20 ms at 8kHz/16-bit
const FILLERS = [
  'Só um instante, estou consultando...',
  'Aguarda um momentinho, já estou verificando...',
  'Deixa eu ver aqui, me aguarda um pouquinho...',
  'Um momentinho, estou checando pra você...',
  'Estou consultando, aguarda só um instante...',
];

const SILENCE_WARN_MS  = 35_000;  // 35s sem atividade → pergunta se está na linha
const SILENCE_HANGUP_MS = 20_000; // mais 20s sem resposta → encerra

export class CallSession {
  private parser = new AudioSocketProtocol();
  private rt = new RealtimeClient();
  private ctx = createContext('', '');
  private socket: net.Socket;
  private ttsQueue: Promise<void> = Promise.resolve();
  private textBuf = '';
  private interrupted = false;
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  private hangupTimer: ReturnType<typeof setTimeout> | null = null;
  private tearing = false;
  private fillerCancel = { cancelled: false };
  private toolsInFlight = 0;
  private waitingAnaAfterTool = false;
  private fillerLoopRunning = false;
  // Jitter buffer — um único fluxo de saída para voz + teclado (evita gargalos)
  private audioQueue: Buffer[] = [];
  private audioTimer: ReturnType<typeof setInterval> | null = null;
  private voiceRemainder = Buffer.alloc(0);
  private playbackPrimed = false;

  constructor(socket: net.Socket) {
    this.socket = socket;
  }

  start(): void {
    this.socket.on('data', (d) => this.onData(d));
    this.socket.on('end', () => this.teardown());
    this.socket.on('error', (e) => {
      logger.error('Socket erro', { err: e.message });
      this.teardown();
    });
  }

  // ─── AudioSocket inbound ───────────────────────────────────────────────────

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

    // Tenta identificar cliente pelo telefone
    if (callerNumber) {
      try {
        const cliente = await sgp.buscarPorTelefone(callerNumber);
        if (cliente) {
          this.ctx.cliente = cliente;
          this.ctx.clienteIdentificado = true;
          this.ctx.clienteConfirmado = true; // identificado pelo telefone da chamada
          logger.info(`[${uuid}] Cliente identificado pelo telefone: ${cliente.nome}`);
        }
      } catch (err: any) {
        logger.warn(`[${uuid}] Não foi possível identificar pelo telefone`, { err: err.message });
      }
    }

    // Registra tools e configura eventos do Realtime
    registerTools(this.rt, this.ctx);
    this.setupRealtimeEvents(uuid);

    // Conecta ao OpenAI Realtime
    const instructions = buildSystemPrompt(this.ctx);
    try {
      await this.rt.connect(uuid, instructions, TOOL_DEFINITIONS);
      logger.info(`[${uuid}] Sessão pronta`);
      this.startAudioTimer();
      this.resetSilenceTimer();
      // Aguarda session.updated antes de gerar resposta (garante instruções aplicadas)
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
    const pcm24k = upsample8to24(pcm8k);
    this.rt.sendAudio(pcm24k);
  }

  // ─── OpenAI Realtime events ───────────────────────────────────────────────

  private setupRealtimeEvents(callId: string): void {
    this.rt.on('audio', (pcm24k: Buffer) => {
      // Ana voltou a falar — para digitação e limpa fila de teclado pendente
      if (this.waitingAnaAfterTool && this.toolsInFlight === 0) {
        this.fillerCancel.cancelled = true;
        this.fillerLoopRunning = false;
        this.waitingAnaAfterTool = false;
        this.audioQueue = [];
        this.playbackPrimed = false;
      }

      const pcm8k = downsample24to8(pcm24k);
      this.enqueuePcm8k(pcm8k);
    });

    this.rt.on('textDelta', (delta: string) => {
      this.textBuf += delta;
    });

    // gpt-realtime-* gera áudio nativo; não usar ElevenLabs em paralelo
    const useNativeAudio = config.openai.realtimeModel.startsWith('gpt-realtime');

    this.rt.on('textDone', (text: string) => {
      if (text.trim()) logger.info(`[${callId}] 🤖 Ana: ${text.trim()}`);
      if (config.tts.provider === 'elevenlabs' && !useNativeAudio && text.trim()) {
        this.ttsQueue = this.ttsQueue.then(() => this.synthesizeAndSend(text));
      }
      this.textBuf = '';

      // Processa ações pendentes após a fala da IA terminar
      if (this.ctx.pendingTransfer) {
        this.ctx.pendingTransfer = false;
        void this.executeTransfer(callId);
      } else if (this.ctx.pendingHangup) {
        this.ctx.pendingHangup = false;
        setTimeout(() => this.teardown(), config.audio.endPauseMs + 500);
      }
    });

    this.rt.on('toolStart', () => {
      this.toolsInFlight++;
      this.waitingAnaAfterTool = false;
      this.startTypingSound();
    });

    this.rt.on('toolSlowdown', () => {
      // Consulta demorada — reforço verbal se a IA ainda não avisou o cliente
      const filler = FILLERS[Math.floor(Math.random() * FILLERS.length)];
      if (config.tts.provider === 'elevenlabs' && !useNativeAudio) {
        this.ttsQueue = this.ttsQueue.then(() => this.synthesizeAndSend(filler));
      } else {
        this.rt.injectSystemNote(`[SISTEMA: consulta em andamento, diga brevemente ao cliente: "${filler}"]`);
      }
    });

    this.rt.on('toolDone', () => {
      // Consulta terminou, mas Ana ainda não falou — mantém digitação até o áudio dela voltar
      this.toolsInFlight = Math.max(0, this.toolsInFlight - 1);
      if (this.toolsInFlight === 0) {
        this.waitingAnaAfterTool = true;
      }
    });

    this.rt.on('userSpeech', (text: string) => {
      logger.info(`[${callId}] 👤 Cliente: ${text}`);
    });

    this.rt.on('speechStart', () => {
      // Cliente começou a falar — interrompe o áudio em fila (barge-in)
      this.flushAudioQueue();
      this.stopTypingSound();
      this.resetSilenceTimer();
    });

    // speechStop: NÃO chamamos createResponse manualmente.
    // O turn_detection nativo (semantic_vad + create_response:true) decide
    // quando o cliente terminou e gera a resposta sozinho.

    this.rt.on('textDone', () => {
      this.resetSilenceTimer();
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

  // ─── Audio output ─────────────────────────────────────────────────────────

  private async synthesizeAndSend(text: string): Promise<void> {
    try {
      const pcm8k = await synthesize(text);
      await this.sendPaced(pcm8k);
      await sleep(config.audio.endPauseMs);
    } catch (err: any) {
      logger.error(`[${this.ctx.callId}] TTS erro`, { err: err.message });
    }
  }

  private enqueuePcm8k(pcm8k: Buffer): void {
    const combined = pcm8k.length
      ? Buffer.concat([this.voiceRemainder, pcm8k])
      : this.voiceRemainder;
    let offset = 0;
    while (offset + CHUNK <= combined.length) {
      this.audioQueue.push(Buffer.from(combined.subarray(offset, offset + CHUNK)));
      offset += CHUNK;
    }
    this.voiceRemainder = offset < combined.length
      ? combined.subarray(offset)
      : Buffer.alloc(0);

    // Limita latência — descarta excesso antigo se fila crescer demais
    const maxChunks = Math.ceil(config.audio.maxBufferMs / 20);
    while (this.audioQueue.length > maxChunks) {
      this.audioQueue.shift();
    }
  }

  private flushAudioQueue(): void {
    this.audioQueue = [];
    this.voiceRemainder = Buffer.alloc(0);
    this.playbackPrimed = false;
  }

  private startAudioTimer(): void {
    if (this.audioTimer) return;
    const startChunks = Math.max(1, Math.ceil(config.audio.startBufferMs / 20));

    this.audioTimer = setInterval(() => {
      if (this.socket.destroyed || this.tearing) return;

      // Pré-buffer no início de cada frase — acumula antes de tocar
      if (!this.playbackPrimed) {
        if (this.audioQueue.length >= startChunks) {
          this.playbackPrimed = true;
        } else {
          return;
        }
      }

      if (this.audioQueue.length === 0) {
        this.playbackPrimed = false;
        return;
      }

      const chunk = this.audioQueue.shift();
      if (chunk) this.sendToAsterisk(chunk);
    }, 20);
  }

  private stopAudioTimer(): void {
    if (this.audioTimer) { clearInterval(this.audioTimer); this.audioTimer = null; }
    this.flushAudioQueue();
  }

  private async sendPaced(pcm8k: Buffer): Promise<void> {
    this.enqueuePcm8k(pcm8k);
    const chunks = Math.ceil(pcm8k.length / CHUNK);
    await sleep(chunks * 20 + config.audio.startBufferMs);
  }

  private sendToAsterisk(pcm8k: Buffer): void {
    if (this.socket.destroyed) return;
    for (let i = 0; i < pcm8k.length; i += CHUNK) {
      const slice = pcm8k.subarray(i, i + CHUNK);
      if (slice.length === CHUNK) {
        this.socket.write(AudioSocketProtocol.audio(slice));
      }
    }
  }

  // ─── Transfer & teardown ──────────────────────────────────────────────────

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

  // ─── Filler tone loop ─────────────────────────────────────────────────────

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
      const end = Math.min(pos + CHUNK, sample.length);
      const slice = sample.subarray(pos, end);
      if (slice.length === CHUNK) {
        // Mesma fila da voz — evita duas escritas simultâneas no socket (causa gargalo)
        this.audioQueue.push(Buffer.from(slice));
      }
      pos = end >= sample.length ? 0 : end;
      await sleep(20);
    }
    this.fillerLoopRunning = false;
  }

  // ─── Silence detection ────────────────────────────────────────────────────

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

  // ─── OpenAI disconnect fallback ───────────────────────────────────────────

  private async handleRealtimeDisconnect(callId: string): Promise<void> {
    if (this.tearing) return;
    logger.warn(`[${callId}] OpenAI desconectado — executando fallback`);

    if (config.tts.provider === 'elevenlabs' && !this.socket.destroyed) {
      try {
        const pcm = await synthesize(
          'Tive uma instabilidade no sistema. Vou te transferir para um de nossos atendentes agora.',
        );
        await this.sendPaced(pcm);
        await sleep(config.audio.endPauseMs);
      } catch {
        // sem áudio — transfere silenciosamente
      }
    }

    await this.executeTransfer(callId);
    setTimeout(() => this.teardown(), 3_000);
  }

  private teardown(): void {
    if (this.tearing) return;
    this.tearing = true;
    this.stopTypingSound();
    this.stopAudioTimer();
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
