import net from 'net';
import { RealtimeClient } from '../realtime/client';
import { AudioSocketProtocol, AUDIOSOCKET_TYPE } from '../audiosocket/protocol';
import { upsample8to24, downsample24to8 } from '../audio/resampler';
import { AudioPacer, SLIN_CHUNK_BYTES, writeAudioSocketFrame } from '../audio/pacer';
import { MicRingBuffer } from '../audio/mic-ring';
import { synthesize, synthesizeStream } from '../tts/elevenlabs';
import { registerTools, buildFinanceiroSpeech } from '../tools/handlers';
import { createContext } from './context';
import { assignAgentVoice } from './voice-rotation';
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

const SILENCE_WARN_MS  = 12_000;
const RESPONSE_STALL_MS = 12_000;

/** Frase falada antes da consulta quando o modelo chama a tool sem avisar o cliente. */
const TOOL_PREAMBLES: Record<string, string> = {
  buscar_cliente_por_cpf: 'Vou buscar as informações do seu contrato, só um momentinho.',
  verificar_massiva: 'Vou verificar se tem algum problema na rede, aguarda um pouquinho.',
  consultar_zabbix: 'Vou consultar o monitoramento da rede, só um instante.',
  consultar_financeiro: 'Vou consultar a situação financeira aqui, só um instante.',
  consultar_onu: 'Vou verificar o equipamento aqui, um momentinho.',
  reiniciar_onu: 'Vou reiniciar o equipamento remotamente, aguarda um pouquinho.',
  abrir_chamado: 'Vou abrir o chamado aqui, só um momentinho.',
  gerar_segunda_via: 'Vou gerar a segunda via aqui, aguarda.',
  enviar_resumo_whatsapp: 'Vou enviar isso pro seu WhatsApp, um momentinho.',
  agendar_visita_tecnica: 'Vou agendar a visita técnica aqui, aguarda.',
  desbloqueio_confianca: 'Vou solicitar o desbloqueio de confiança, só um instante.',
  verificar_viabilidade: 'Vou verificar a viabilidade no seu endereço, aguarda.',
  consultar_planos: 'Vou consultar os planos disponíveis, um momentinho.',
};

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
  private silenceWarningsCount = 0;
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
  private assistantTextInResponse = false;
  private speechStartedAt = 0;
  private typingDelayTimer: ReturnType<typeof setTimeout> | null = null;
  private interruptArmTimer: ReturnType<typeof setTimeout> | null = null;
  private responseStallTimer: ReturnType<typeof setTimeout> | null = null;
  private postToolSpeechTimer: ReturnType<typeof setTimeout> | null = null;
  private titularFollowUpTimer: ReturnType<typeof setTimeout> | null = null;
  private falaObrigatoriaTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingFalaObrigatoria: string | null = null;
  private autoFinanceiroTimer: ReturnType<typeof setTimeout> | null = null;
  private autoMassivaTimer: ReturnType<typeof setTimeout> | null = null;
  private financeiroTtsTimer: ReturnType<typeof setTimeout> | null = null;
  private useElevenLabsTts = false;
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
    const agent = assignAgentVoice();
    this.ctx.agentName = agent.name;
    this.ctx.voiceId = agent.voiceId;
    this.ctx.agentGender = agent.gender;
    if (reg?.channel) this.ctx.asteriskChannel = reg.channel;
    logger.info(`[${uuid}] Chamada iniciada`, {
      callerNumber: callerNumber || '(desconhecido)',
      channel: reg?.channel || '(desconhecido)',
      agente: agent.name,
      genero: agent.gender === 'm' ? 'masculino' : 'feminino',
      voiceId: agent.voiceId ? `${agent.voiceId.slice(0, 6)}…` : '(vazio)',
    });

    sessionRegistry.register(uuid, { callerNumber, channel: reg?.channel });

    if (callerNumber) {
      try {
        const cliente = await sgp.buscarPorTelefone(callerNumber);
        if (cliente) {
          this.ctx.cliente = cliente;
          this.ctx.clienteIdentificado = true;
          this.ctx.clienteConfirmado = false;
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
    void ami.connect().catch((err) => logger.warn(`[${uuid}] AMI pre-connect falhou`, { err: err.message }));

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

  private agentLabel(): string {
    return this.ctx.agentName ?? config.company.agentName;
  }

  private isMicBlocked(): boolean {
    if (this.toolsInFlight > 0 || this.waitingAnaAfterTool) {
      return true;
    }
    if (this.useElevenLabsTts) {
      // Mic aberto durante TTS e geração OpenAI — só anti-eco pós-fala (barge-in real)
      return this.pacer.isEchoGated();
    }
    return this.rt.isResponseActive() || this.pacer.isMicGated();
  }

  /** Mais paciência na coleta de CPF; resposta rápida após identificação. */
  private speechStopDelayForContext(): number {
    if (this.ctx.clienteIdentificado) return config.vad.speechStopDelayMs;
    return config.vad.speechStopDelayCollectingMs;
  }

  private scheduleUserResponse(callId: string, retries = 0, delayMs?: number): void {
    const MAX_RETRIES = 20;
    const RETRY_INTERVAL_MS = 300;
    const firstDelay = delayMs ?? this.speechStopDelayForContext();
    if (this.userResponseTimer) clearTimeout(this.userResponseTimer);
    this.userResponseTimer = setTimeout(() => {
      this.userResponseTimer = null;
      if (this.tearing || this.socket.destroyed) return;
      if (this.rt.isResponseActive() || this.rt.isResponsePending()) {
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
      if (!this.rt.createResponse()) {
        if (retries < MAX_RETRIES) {
          this.scheduleUserResponse(callId, retries + 1, RETRY_INTERVAL_MS);
        }
      }
    }, retries === 0 ? firstDelay : RETRY_INTERVAL_MS);
  }

  private tryPendingSpeechStop(callId: string): void {
    if (!this.pendingSpeechStop) return;
    this.pendingSpeechStop = false;
    // Delay curto pois já esperamos no holdRelease
    this.scheduleUserResponse(callId, 0, 150);
  }

  private setupRealtimeEvents(callId: string): void {
    const useElevenLabsTts = config.tts.provider === 'elevenlabs';
    this.useElevenLabsTts = useElevenLabsTts;
    logger.info(`[${callId}] Pipeline áudio: ${useElevenLabsTts ? 'OpenAI texto → ElevenLabs voz' : 'OpenAI áudio nativo'}`);

    this.rt.onToolPreamble((name) => this.runToolPreamble(callId, name, useElevenLabsTts));

    this.rt.on('responsePendingTimeout', () => {
      if (this.tearing || this.socket.destroyed || this.clientSpeaking) return;
      logger.warn(`[${callId}] Retentando response.create após pending travado`);
      this.rt.createResponse(true);
    });

    this.rt.on('responseCreated', () => {
      this.assistantTextInResponse = false;
      this.armResponseStallWatchdog(callId);
      if (this.userResponseTimer) {
        clearTimeout(this.userResponseTimer);
        this.userResponseTimer = null;
      }
      this.pendingSpeechStop = false;
      this.respondedSinceLastSpeech = true;
      // Com ElevenLabs o áudio é local — holdStream bloqueava o mic por 15s sem TTS da OpenAI
      if (!useElevenLabsTts) {
        this.pacer.setHoldStream(true);
      }
    });

    this.rt.on('audio', (pcm24k: Buffer) => {
      if (useElevenLabsTts) return;
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

    this.rt.on('textDone', (text: string) => {
      if (text.trim()) {
        this.assistantTextInResponse = true;
        this.clearResponseStallWatchdog();
        this.clearPostToolSpeechWatchdog();
        this.clearFalaObrigatoriaFallback();
        this.clearFinanceiroTts();
        this.pendingFalaObrigatoria = null;
        this.waitingAnaAfterTool = false;
        logger.info(`[${callId}] 🤖 ${this.agentLabel()} (texto): ${text.trim()}`);
        sessionRegistry.emit(callId, 'assistant_text', text.trim());
        if (this.ctx.precisaConsultarFinanceiro && /vou (consultar|verificar|checar|dar uma olhad)/i.test(text)) {
          this.armTitularFollowUpWatchdog(callId);
        }
      }
      if (this.useElevenLabsTts && text.trim()) {
        this.stopTypingSound();
        this.enqueueTTS(() => this.synthesizeAndSend(text));
      }
      this.textBuf = '';
    });

    this.rt.on('toolStart', (name: string) => {
      this.clearResponseStallWatchdog();
      this.clearTitularFollowUpWatchdog();
      this.lastToolName = name;
      this.toolsInFlight++;
      this.waitingAnaAfterTool = false;
      sessionRegistry.emit(callId, 'tool_start', `Consulta: ${name}`, { tool: name });
    });

    this.rt.on('toolSlowdown', () => {
      logger.info(`[${callId}] 🤖 ${this.agentLabel()} (lentidão na consulta): Só mais um minutinho tá? Estou terminando.`);
      sessionRegistry.emit(callId, 'assistant_text', 'Só mais um minutinho tá? Estou terminando.');
      if (this.useElevenLabsTts) {
        this.enqueueTTS(() => this.synthesizeAndSend('Só mais um minutinho tá? Estou terminando.'));
      }
      this.startTypingSound();
    });

    this.rt.on('toolDone', (name?: string, result?: unknown, meta?: { serverSide?: boolean }) => {
      this.cancelTypingDelay();
      this.toolsInFlight = Math.max(0, this.toolsInFlight - 1);
      if (this.toolsInFlight === 0) {
        this.waitingAnaAfterTool = true;
      }
      if (name) {
        this.lastToolName = name;
        sessionRegistry.emit(callId, 'tool_done', `Concluído: ${name}`, { tool: name });
      } else if (this.lastToolName) {
        sessionRegistry.emit(callId, 'tool_done', `Concluído: ${this.lastToolName}`, { tool: this.lastToolName });
      }
      if (name === 'consultar_financeiro') {
        this.ctx.consultaFinanceiraFeita = true;
      }
      if (this.toolsInFlight === 0) {
        this.armPostToolSpeechWatchdog(callId);
        if (name === 'confirmar_titular_contrato') {
          const r = result as { sucesso?: boolean; confirmado?: boolean; multiplos_contratos?: boolean } | undefined;
          if (r?.sucesso && r?.confirmado && !r?.multiplos_contratos) {
            this.armAutoFinanceiro(callId);
          }
          this.armTitularFollowUpWatchdog(callId);
        } else if (name === 'selecionar_contrato') {
          const r = result as { sucesso?: boolean } | undefined;
          if (r?.sucesso) {
            this.armAutoFinanceiro(callId);
          }
        }
      }
    });

    this.rt.on('speechStart', () => {
      logger.info(`[${callId}] 🎤 Cliente falando...`);
      this.silenceWarningsCount = 0;
      this.clientSpeaking = true;
      this.speechStartedAt = Date.now();
      this.respondedSinceLastSpeech = false;
      this.clearSilenceTimer();
      if (this.userResponseTimer) {
        clearTimeout(this.userResponseTimer);
        this.userResponseTimer = null;
      }

      // ElevenLabs: só interrompe com áudio real na linha — ruído no início não pode cancelar texto/TTS
      const anaAudivel = this.pacer.isPlaying() || this.fillerLoopRunning;
      if (!anaAudivel) return;

      const armMs = config.vad.interruptArmMs;
      if (this.interruptArmTimer) clearTimeout(this.interruptArmTimer);
      if (armMs <= 0) {
        this.interruptAssistantSpeech(callId);
        return;
      }
      this.interruptArmTimer = setTimeout(() => {
        this.interruptArmTimer = null;
        if (this.clientSpeaking) this.interruptAssistantSpeech(callId);
      }, armMs);
    });

    this.rt.on('speechStop', () => {
      if (this.interruptArmTimer) {
        clearTimeout(this.interruptArmTimer);
        this.interruptArmTimer = null;
      }
      const spokeMs = Date.now() - this.speechStartedAt;
      logger.info(`[${callId}] 🎤 Cliente parou de falar (${spokeMs}ms)`);
      this.clientSpeaking = false;
      if (spokeMs < config.vad.minSpeechMs) {
        logger.debug(`[${callId}] speechStop ignorado (${spokeMs}ms < ${config.vad.minSpeechMs}ms)`);
        return;
      }
      if (this.rt.isResponseActive() || this.rt.isResponsePending()) {
        this.pendingSpeechStop = true;
        return;
      }
      this.scheduleUserResponse(callId);
    });

    this.rt.on('userSpeech', (text: string) => {
      logger.info(`[${callId}] 👤 Cliente (transcrição): ${text}`);
      this.ctx.lastClientSpeech = text;
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
          if (this.rt.isResponseActive() || this.rt.isResponsePending()) {
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
        if (this.pacer.getQueueLength() > 0 || this.rt.isResponseActive() || this.rt.isResponsePending()) {
          this.releaseHoldTimer = setTimeout(attempt, 40);
          return;
        }
        this.releaseHoldTimer = setTimeout(() => {
          if (this.pacer.getQueueLength() === 0 && !this.rt.isResponseActive() && !this.rt.isResponsePending()) {
            this.pacer.setHoldStream(false);
            this.tryPendingSpeechStop(callId);
          }
        }, 250);
      };
      attempt();
    };

    this.rt.on('audioOutputDone', () => {
      if (!useElevenLabsTts) scheduleHoldRelease();
    });

    this.rt.on('responseDone', () => {
      if (this.ctx.contratoSelecionado && this.ctx.consultaFinanceiraFeita && !this.ctx.consultaMassivaFeita && !this.ctx.financeiroBloqueado) {
        this.armAutoMassiva(callId);
      }
      this.clearResponseStallWatchdog();
      if (useElevenLabsTts) {
        this.pacer.setHoldStream(false);
        if (this.releaseHoldTimer) {
          clearTimeout(this.releaseHoldTimer);
          this.releaseHoldTimer = null;
        }
        const buffered = this.textBuf.trim();
        if (buffered && !this.assistantTextInResponse) {
          this.assistantTextInResponse = true;
          this.clearPostToolSpeechWatchdog();
          this.clearFalaObrigatoriaFallback();
          this.pendingFalaObrigatoria = null;
          this.waitingAnaAfterTool = false;
          this.stopTypingSound();
          logger.info(`[${callId}] 🤖 ${this.agentLabel()} (texto, fallback): ${buffered}`);
          sessionRegistry.emit(callId, 'assistant_text', buffered);
          this.enqueueTTS(() => this.synthesizeAndSend(buffered));
        }
        // Modelo encerrou sem texto após tool — reenvia e mantém teclado
        if (this.waitingAnaAfterTool && !this.assistantTextInResponse && this.toolsInFlight === 0) {
          if (!this.fillerLoopRunning) this.startTypingSound();
          setTimeout(() => {
            if (!this.tearing && !this.socket.destroyed && this.waitingAnaAfterTool) {
              if (this.rt.isResponseActive() || this.rt.isResponsePending()) {
                // A resposta para o tool output já começou, ignora o watchdog
                return;
              }
              
              const retries = (this as any).emptyResponseRetries || 0;
              if (retries >= 2) {
                logger.error(`[${callId}] Falha contínua do modelo em responder após tool. Acionando fallback de voz.`);
                (this as any).emptyResponseRetries = 0;
                this.waitingAnaAfterTool = false;
                this.stopTypingSound();
                this.enqueueTTS(() => this.synthesizeAndSend('Deu um pequeno erro na consulta, mas me diga, o que mais eu posso te ajudar?'));
                return;
              }
              
              (this as any).emptyResponseRetries = retries + 1;
              logger.warn(`[${callId}] Resposta vazia após consulta (tentativa ${retries + 1}) — injetando instrução e reenviando`);
              this.rt.injectSystemNote(
                '[SISTEMA] Você recebeu o resultado da ferramenta mas não respondeu ao cliente. Por favor, dê a resposta adequada com base nos dados que acabou de receber.'
              );
            }
          }, 400);
        }
      } else {
        scheduleHoldRelease();
      }
      this.textBuf = '';
      void this.onAssistantResponseDone(callId);
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

  private interruptAssistantSpeech(callId: string): void {
    this.ttsGeneration++;
    this.ttsQueue = Promise.resolve();
    this.stopTypingSound();
    this.pacer.flush();
    this.pacer.setHoldStream(false);
    if (this.releaseHoldTimer) {
      clearTimeout(this.releaseHoldTimer);
      this.releaseHoldTimer = null;
    }
    if (this.rt.isResponseActive() || this.rt.isResponsePending()) {
      this.rt.cancelResponse();
    }
    logger.info(`[${callId}] Cliente interrompeu a fala de ${this.agentLabel()}`);
  }

  private armResponseStallWatchdog(callId: string): void {
    this.clearResponseStallWatchdog();
    this.responseStallTimer = setTimeout(() => {
      this.responseStallTimer = null;
      if (this.tearing || this.socket.destroyed || this.clientSpeaking) return;
      if (this.toolsInFlight > 0 || this.assistantTextInResponse) return;
      if (!this.rt.isResponseActive() && !this.rt.isResponsePending()) return;
      logger.warn(`[${callId}] ${this.agentLabel()} sem resposta em ${RESPONSE_STALL_MS}ms — cancelando e reenviando`);
      this.interruptAssistantSpeech(callId);
      this.rt.createResponse(true);
    }, RESPONSE_STALL_MS);
  }

  private clearResponseStallWatchdog(): void {
    if (this.responseStallTimer) {
      clearTimeout(this.responseStallTimer);
      this.responseStallTimer = null;
    }
  }

  /** Se Ana não falar em ~5s após tool, força nova resposta. */
  private armPostToolSpeechWatchdog(callId: string): void {
    this.clearPostToolSpeechWatchdog();
    this.postToolSpeechTimer = setTimeout(() => {
      this.postToolSpeechTimer = null;
      if (this.tearing || this.socket.destroyed || this.clientSpeaking) return;
      if (!this.waitingAnaAfterTool || this.assistantTextInResponse) return;
      if (this.rt.isResponseActive() || this.rt.isResponsePending()) return;
      logger.warn(`[${callId}] Ana sem fala após tool — forçando resposta`);
      this.startTypingSound();
      if (this.pendingFalaObrigatoria) {
        const text = this.pendingFalaObrigatoria;
        this.pendingFalaObrigatoria = null;
        this.clearFalaObrigatoriaFallback();
        this.assistantTextInResponse = true;
        this.waitingAnaAfterTool = false;
        logger.warn(`[${callId}] Falando fala_obrigatoria via TTS (fallback)`);
        this.enqueueTTS(() => this.synthesizeAndSend(text));
        return;
      }
      this.rt.injectSystemNote(
        '[SISTEMA] Você não disse nada após a ferramenta. Fale com o cliente AGORA e dê andamento ao atendimento.',
      );
    }, 5_000);
  }

  /** TTS da fatura após consultar_financeiro — aguarda preâmbulo e fila liberarem. */
  private clearFinanceiroTts(): void {
    if (this.financeiroTtsTimer) {
      clearTimeout(this.financeiroTtsTimer);
      this.financeiroTtsTimer = null;
    }
  }

  private armFalaObrigatoriaFallback(callId: string, text: string): void {
    this.clearFalaObrigatoriaFallback();
    this.falaObrigatoriaTimer = setTimeout(() => {
      this.falaObrigatoriaTimer = null;
      if (this.tearing || this.socket.destroyed || this.clientSpeaking) return;
      if (this.assistantTextInResponse || !this.pendingFalaObrigatoria) return;
      if (this.rt.isResponseActive() || this.rt.isResponsePending()) {
        this.armFalaObrigatoriaFallback(callId, text);
        return;
      }
      const fala = this.pendingFalaObrigatoria;
      this.pendingFalaObrigatoria = null;
      this.assistantTextInResponse = true;
      this.waitingAnaAfterTool = false;
      this.clearPostToolSpeechWatchdog();
      logger.warn(`[${callId}] Modelo silencioso — TTS com fala_obrigatoria`);
      this.enqueueTTS(() => this.synthesizeAndSend(fala));
    }, 3_000);
  }

  private clearFalaObrigatoriaFallback(): void {
    if (this.falaObrigatoriaTimer) {
      clearTimeout(this.falaObrigatoriaTimer);
      this.falaObrigatoriaTimer = null;
    }
  }

  private clearPostToolSpeechWatchdog(): void {
    if (this.postToolSpeechTimer) {
      clearTimeout(this.postToolSpeechTimer);
      this.postToolSpeechTimer = null;
    }
  }

  /** Titular confirmado mas financeiro não consultado — força a próxima tool. */
  private armTitularFollowUpWatchdog(callId: string): void {
    this.clearTitularFollowUpWatchdog();
    this.titularFollowUpTimer = setTimeout(() => {
      this.titularFollowUpTimer = null;
      if (this.tearing || this.socket.destroyed || this.clientSpeaking) return;
      if (!this.ctx.precisaConsultarFinanceiro || this.ctx.consultaFinanceiraFeita) return;
      if (this.toolsInFlight > 0 || this.rt.isResponseActive() || this.rt.isResponsePending()) {
        this.armTitularFollowUpWatchdog(callId);
        return;
      }
      logger.warn(`[${callId}] Titular confirmado sem consulta financeira — forçando`);
      this.startTypingSound();
      void this.rt.runServerTool('consultar_financeiro', {
        cliente_id: this.ctx.cliente?.contratoId,
      });
    }, 4_000);
  }

  /** Se o modelo não chamar financeiro após titular, o servidor chama imediatamente para evitar bug de resposta vazia. */
  private armAutoFinanceiro(callId: string): void {
    this.clearAutoFinanceiro();
    this.autoFinanceiroTimer = setTimeout(() => {
      this.autoFinanceiroTimer = null;
      if (this.tearing || this.socket.destroyed || this.ctx.consultaFinanceiraFeita) return;
      if (this.toolsInFlight > 0 || this.rt.isResponseActive() || this.rt.isResponsePending()) {
        this.armAutoFinanceiro(callId);
        return;
      }
      logger.info(`[${callId}] Auto: consultar_financeiro após titular`);
      void this.rt.runServerTool('consultar_financeiro', {
        cliente_id: this.ctx.cliente?.contratoId,
      });
    }, 100);
  }

  
  /** Após o financeiro e se houve queixa de internet, aciona massiva automaticamente para forçar o sequenciamento */
  private armAutoMassiva(callId: string): void {
    this.clearAutoMassiva();
    this.autoMassivaTimer = setTimeout(() => {
      this.autoMassivaTimer = null;
      if (this.tearing || this.socket.destroyed || this.ctx.consultaMassivaFeita) return;
      if (this.toolsInFlight > 0 || this.rt.isResponseActive() || this.rt.isResponsePending()) {
        this.armAutoMassiva(callId);
        return;
      }
      logger.info(`[${callId}] Auto: verificar_massiva após financeiro (via speech sequencial)`);
      void this.rt.runServerTool("verificar_massiva", {});
    }, 500);
  }

  private clearAutoMassiva(): void {
    if (this.autoMassivaTimer) {
      clearTimeout(this.autoMassivaTimer);
      this.autoMassivaTimer = null;
    }
  }

  private clearAutoFinanceiro(): void {
    if (this.autoFinanceiroTimer) {
      clearTimeout(this.autoFinanceiroTimer);
      this.autoFinanceiroTimer = null;
    }
  }

  private clearTitularFollowUpWatchdog(): void {
    if (this.titularFollowUpTimer) {
      clearTimeout(this.titularFollowUpTimer);
      this.titularFollowUpTimer = null;
    }
  }

  private async runToolPreamble(callId: string, name: string, useElevenLabsTts: boolean): Promise<void> {
    if (this.assistantTextInResponse || this.textBuf.trim().length > 0) return;
    const phrase = TOOL_PREAMBLES[name];
    if (!phrase) return;

    logger.info(`[${callId}] 🤖 ${this.agentLabel()} (pré-consulta): ${phrase}`);
    sessionRegistry.emit(callId, 'assistant_text', phrase);

    if (useElevenLabsTts) {
      await this.speakToolPreamble(phrase);
      if (this.toolsInFlight > 0) this.startTypingSound();
    }
  }

  /** Fala preâmbulo na fila TTS — termina antes de ligar o som de consulta. */
  private async speakToolPreamble(text: string): Promise<void> {
    this.cancelTypingDelay();
    const gen = this.ttsGeneration;
    const task = this.ttsQueue.then(async () => {
      this.pacer.setHoldStream(true);
      try {
        await synthesizeStream(text, (pcm8k) => {
          if (gen !== this.ttsGeneration) return;
          this.stopTypingSound();
          this.pacer.enqueue(pcm8k);
        }, this.ctx.voiceId);
        if (gen === this.ttsGeneration) {
          this.stopTypingSound();
          await this.pacer.drain();
        }
      } catch {
        /* preâmbulo opcional */
      } finally {
        if (gen === this.ttsGeneration) {
          this.pacer.setHoldStream(false);
        }
      }
    });
    this.ttsQueue = task.catch((err: any) => {
      logger.error(`[${this.ctx.callId}] Erro no preâmbulo TTS (ignorado para não travar)`, { err: err?.message || String(err) });
    });
    await task;
  }

  private enqueueTTS(task: () => Promise<void>): void {
    this.ttsQueue = this.ttsQueue.then(task).catch((err: any) => {
      logger.error(`[${this.ctx.callId}] Erro na fila TTS (ignorado para evitar travamento)`, { err: err?.message || String(err) });
    });
  }

  private async synthesizeAndSend(text: string): Promise<void> {
    const gen = this.ttsGeneration;
    this.stopTypingSound();
    
    // Correção fonética para a ElevenLabs ler siglas e "mega" corretamente em português
    const normalizedText = text
      .replace(/\bMB\b/g, 'megabytes')
      .replace(/\bGB\b/g, 'gigabytes')
      .replace(/\bdBm\b/g, 'decibéis')
      .replace(/\bONU\b/gi, 'ônu')
      .replace(/\bCTO\b/gi, 'cê tê ó')
      .replace(/\bOLT\b/gi, 'ó éle tê')
      .replace(/\bPON\b/gi, 'pôn');

    const fmt = config.tts.elevenlabs.outputFormat;
    logger.info(`[${this.ctx.callId}] TTS ElevenLabs (${normalizedText.length} chars, ${fmt})`);
    this.pacer.setHoldStream(true);
    try {
      await synthesizeStream(normalizedText, (pcm8k) => {
        if (gen !== this.ttsGeneration) return;
        this.pacer.enqueue(pcm8k);
      }, this.ctx.voiceId);
      if (gen !== this.ttsGeneration) return;
      await this.pacer.drain();
      if (gen !== this.ttsGeneration) return;
      await sleep(config.audio.endPauseMs);
    } catch (err: any) {
      if (gen === this.ttsGeneration) {
        logger.error(`[${this.ctx.callId}] TTS erro`, { err: err.message, format: fmt });
      }
    } finally {
      if (gen === this.ttsGeneration) {
        this.pacer.setHoldStream(false);
      }
    }
  }

  private async onAssistantResponseDone(callId: string): Promise<void> {
    if (this.ctx.pendingTransfer) {
      this.ctx.pendingTransfer = false;
      if (!this.assistantTextInResponse) {
        this.enqueueTTS(() =>
          this.synthesizeAndSend('Vou te transferir para um de nossos atendentes. Um momento, por favor.'),
        );
      }
      try {
        await this.ttsQueue;
        await this.pacer.drain();
        const ok = await this.executeTransfer(callId);
        if (ok) {
          setTimeout(() => this.teardownForTransfer(), 300);
        } else {
          this.enqueueTTS(() =>
            this.synthesizeAndSend(
              'Não consegui completar a transferência agora. Aguarde um instante ou ligue novamente.',
            ),
          );
        }
      } catch (err: any) {
        logger.error(`[${callId}] Falha no pós-transferência`, { err: err.message });
      }
      return;
    }

    if (this.ctx.pendingHangup) {
      this.ctx.pendingHangup = false;
      try {
        await this.ttsQueue;
        await this.pacer.drain();
      } catch { /* ignore */ }
      setTimeout(() => this.teardown(), config.audio.endPauseMs + 500);
    }

    this.resetSilenceTimer();
  }

  private async executeTransfer(callId: string): Promise<boolean> {
    logger.info(`[${callId}] Executando transferência para atendente`);
    try {
      await ami.connect();
      if (this.ctx.asteriskChannel) {
        await ami.redirect(
          this.ctx.asteriskChannel,
          config.ami.transferExten,
          config.ami.transferContext,
        );
        logger.info(`[${callId}] Transferência AMI concluída → ${config.ami.transferExten}`);
        return true;
      }
      logger.warn(`[${callId}] Canal Asterisk não conhecido — não foi possível redirecionar via AMI`);
      return false;
    } catch (err: any) {
      logger.error(`[${callId}] Erro na transferência AMI`, { err: err.message });
      return false;
    }
  }

  private scheduleTypingSound(): void {
    this.cancelTypingDelay();
    const delay = config.audio.toolTypingDelayMs;
    if (delay <= 0) {
      this.startTypingSound();
      return;
    }
    this.typingDelayTimer = setTimeout(() => {
      this.typingDelayTimer = null;
      if (this.toolsInFlight > 0) this.startTypingSound();
    }, delay);
  }

  private cancelTypingDelay(): void {
    if (this.typingDelayTimer) {
      clearTimeout(this.typingDelayTimer);
      this.typingDelayTimer = null;
    }
  }

  private startTypingSound(): void {
    if (!this.useElevenLabsTts) return;
    if (this.toolsInFlight <= 0 && !this.waitingAnaAfterTool) return;
    this.stopWaitSound();
    this.fillerCancel = { cancelled: false };
    this.fillerLoopRunning = true;
    void this.playFillerLoop(this.fillerCancel, getWaitSound());
  }

  private stopWaitSound(): void {
    this.fillerCancel.cancelled = true;
    this.fillerLoopRunning = false;
  }

  private stopTypingSound(): void {
    this.cancelTypingDelay();
    this.stopWaitSound();
    this.waitingAnaAfterTool = false;
  }

  private async playFillerLoop(cancel: { cancelled: boolean }, sample?: Buffer): Promise<void> {
    const loop = sample ?? getWaitSound();
    let pos = 0;
    while (!cancel.cancelled && !this.socket.destroyed && !this.tearing) {
      const end = Math.min(pos + SLIN_CHUNK_BYTES, loop.length);
      const slice = loop.subarray(pos, end);
      if (slice.length === SLIN_CHUNK_BYTES) {
        this.pacer.enqueue(Buffer.from(slice));
      } else if (slice.length > 0) {
        const pad = Buffer.alloc(SLIN_CHUNK_BYTES);
        slice.copy(pad);
        this.pacer.enqueue(pad);
      }
      pos = end >= loop.length ? 0 : end;
      await sleep(20);
    }
    this.fillerLoopRunning = false;
  }

  private clearSilenceTimer(): void {
    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
  }

  private resetSilenceTimer(): void {
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    if (this.hangupTimer) clearTimeout(this.hangupTimer);
    this.hangupTimer = null;
    this.silenceTimer = setTimeout(() => this.onSilenceWarning(), SILENCE_WARN_MS);
  }

  private onSilenceWarning(): void {
    if (this.tearing || this.socket.destroyed || this.ctx.pendingTransfer) return;
    if (
      this.pacer.isEchoGated() ||
      this.pacer.isPlaying() ||
      this.toolsInFlight > 0 ||
      this.rt.isResponseActive() ||
      this.rt.isResponsePending()
    ) {
      return;
    }
    this.silenceWarningsCount++;
    if (this.silenceWarningsCount === 1) {
      logger.warn(`[${this.ctx.callId}] Silêncio prolongado — perguntando se cliente ainda está na linha`);
      this.rt.injectSystemNote('O cliente está em silêncio absoluto. Pergunte de forma breve e direta se ele ainda está na linha e aguarde a resposta.');
      this.resetSilenceTimer();
    } else {
      logger.warn(`[${this.ctx.callId}] Silêncio prolongado (segunda vez) — encerrando ligação por inatividade`);
      if (this.useElevenLabsTts) {
        this.enqueueTTS(() =>
          this.synthesizeAndSend('Como não estou te ouvindo, vou encerrar a ligação. Se precisar, é só retornar. Tchau tchau!'),
        );
        this.ttsQueue.finally(() => setTimeout(() => this.teardown(), 1_000));
      } else {
        setTimeout(() => this.teardown(), 1_000);
      }
    }
  }

  private async handleRealtimeDisconnect(callId: string): Promise<void> {
    if (this.tearing) return;
    logger.warn(`[${callId}] OpenAI desconectado — executando fallback`);

    if (config.tts.provider === 'elevenlabs' && !this.socket.destroyed) {
      try {
        const pcm = await synthesize(
          'Tive uma instabilidade no sistema. Vou te transferir para um de nossos atendentes agora.',
          this.ctx.voiceId,
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

  private teardownForTransfer(): void {
    if (this.tearing) return;
    this.tearing = true;
    this.stopTypingSound();
    this.pacer.stop();
    if (this.releaseHoldTimer) clearTimeout(this.releaseHoldTimer);
    if (this.userResponseTimer) clearTimeout(this.userResponseTimer);
    if (this.interruptArmTimer) clearTimeout(this.interruptArmTimer);
    if (this.responseStallTimer) clearTimeout(this.responseStallTimer);
    if (this.postToolSpeechTimer) clearTimeout(this.postToolSpeechTimer);
    if (this.titularFollowUpTimer) clearTimeout(this.titularFollowUpTimer);
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    if (this.hangupTimer) clearTimeout(this.hangupTimer);
    const ended = sessionRegistry.end(this.ctx.callId);
    if (ended) saveCallHistory(ended, [...this.ctx.log]);
    logger.info(`[${this.ctx.callId}] Chamada liberada após transferência`);
    if (!this.socket.destroyed) this.socket.destroy();
    this.rt.close();
  }

  private teardown(): void {
    if (this.tearing) return;
    this.tearing = true;
    this.stopTypingSound();
    this.pacer.stop();
    if (this.releaseHoldTimer) clearTimeout(this.releaseHoldTimer);
    if (this.userResponseTimer) clearTimeout(this.userResponseTimer);
    if (this.interruptArmTimer) clearTimeout(this.interruptArmTimer);
    if (this.responseStallTimer) clearTimeout(this.responseStallTimer);
    if (this.postToolSpeechTimer) clearTimeout(this.postToolSpeechTimer);
    if (this.titularFollowUpTimer) clearTimeout(this.titularFollowUpTimer);
    if (this.autoFinanceiroTimer) clearTimeout(this.autoFinanceiroTimer);
    if (this.autoMassivaTimer) clearTimeout(this.autoMassivaTimer);
    if (this.financeiroTtsTimer) clearTimeout(this.financeiroTtsTimer);
    if (this.falaObrigatoriaTimer) clearTimeout(this.falaObrigatoriaTimer);
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
