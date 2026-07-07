import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { config } from '../config';
import { logger } from '../logger';
import type { RealtimeEvent, ToolDefinition, RealtimeSessionConfig, TurnDetectionConfig } from './types';

export type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

type TranscriptionConfig = {
  model: string;
  language?: string;
  delay?: string;
  prompt?: string;
};

function buildTranscriptionCfg(): TranscriptionConfig {
  const model = config.openai.transcriptionModel;
  const cfg: TranscriptionConfig = { model };
  if (model === 'gpt-realtime-whisper') {
    cfg.language = 'pt';
    cfg.delay = config.openai.transcriptionDelay;
  } else if (!config.openai.realtimeModel.startsWith('gpt-realtime')) {
    cfg.language = 'pt';
    cfg.prompt =
      'O cliente está falando em português do Brasil. Ele vai dizer números como CPF, telefone, e responder perguntas.';
  }
  return cfg;
}

export class RealtimeClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private tools = new Map<string, ToolHandler>();
  private callId = '';
  private toolTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private responseActive = false;
  private responsePending = false;
  private pendingWatchdog: ReturnType<typeof setTimeout> | null = null;
  private static readonly PENDING_TIMEOUT_MS = 6_000;
  private toolPreambleHook: ((name: string) => Promise<void>) | null = null;
  private toolChain: Promise<void> = Promise.resolve();
  private responseTextEmitted = false;
  private useNewSchema = false;
  private transcriptionReinforced = false;

  registerTool(name: string, handler: ToolHandler): void {
    this.tools.set(name, handler);
  }

  onToolPreamble(hook: (name: string) => Promise<void>): void {
    this.toolPreambleHook = hook;
  }

  async connect(callId: string, instructions: string, toolDefs: ToolDefinition[]): Promise<void> {
    this.callId = callId;

    let model = config.openai.realtimeModel;
    if (!model.startsWith('gpt-')) {
      model = 'gpt-4o-realtime-preview';
      logger.warn(`[${callId}] REALTIME_MODEL inválido, usando: ${model}`);
    }

    const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${config.openai.apiKey}`,
    };
    if (config.openai.realtimeSchema !== 'ga') {
      headers['OpenAI-Beta'] = 'realtime=v1';
    }

    this.ws = new WebSocket(url, { headers });

    await new Promise<void>((resolve, reject) => {
      this.ws!.once('open', resolve);
      this.ws!.once('error', reject);
      setTimeout(() => reject(new Error('Realtime WS connect timeout')), 15_000);
    });

    logger.info(`[${callId}] Realtime WebSocket conectado (model=${model}, transcription=${config.openai.transcriptionModel})`);

    this.responseActive = false;
    this.responsePending = false;

    this.ws.on('message', (data) => this.onMessage(data.toString()));
    this.ws.on('close', (code) => {
      logger.info(`[${callId}] Realtime WS fechado (code=${code})`);
      this.emit('close');
    });
    this.ws.on('error', (err) => {
      logger.error(`[${callId}] Realtime WS erro`, { err: err.message });
      this.emit('error', err);
    });

    const useAudio = config.tts.provider === 'openai';
    const modalities: ('text' | 'audio')[] = useAudio ? ['text', 'audio'] : ['text'];
    const outputModalities: ('text' | 'audio')[] = useAudio ? ['audio'] : ['text'];
    const isNewSchema = model.startsWith('gpt-realtime');
    this.useNewSchema = isNewSchema;
    this.transcriptionReinforced = false;

    const turnFlags = {
      create_response: false,
      interrupt_response: config.vad.interruptResponse,
    };

    const newTurnDetection: TurnDetectionConfig =
      config.vad.type === 'semantic_vad'
        ? { type: 'semantic_vad', eagerness: config.vad.eagerness, ...turnFlags }
        : {
            type: 'server_vad',
            threshold: config.vad.threshold,
            silence_duration_ms: config.vad.silenceMs,
            ...turnFlags,
          };

    const transcriptionCfg = buildTranscriptionCfg();

    const sessionCfg: RealtimeSessionConfig = isNewSchema
      ? {
          type: 'realtime',
          output_modalities: outputModalities,
          instructions,
          audio: {
            input: {
              format: { type: 'audio/pcm', rate: 24000 },
              turn_detection: newTurnDetection,
              transcription: transcriptionCfg,
            },
            ...(useAudio
              ? {
                  output: {
                    format: { type: 'audio/pcm', rate: 24000 },
                    voice: config.openai.voice,
                  },
                }
              : {}),
          },
          tools: toolDefs,
          tool_choice: 'auto',
        }
      : {
          type: 'realtime',
          modalities,
          instructions,
          voice: config.openai.voice,
          input_audio_format: 'pcm16',
          output_audio_format: 'pcm16',
          input_audio_transcription: transcriptionCfg,
          turn_detection: config.vad.type === 'semantic_vad'
            ? { type: 'semantic_vad', eagerness: config.vad.eagerness, create_response: false, interrupt_response: config.vad.interruptResponse }
            : { type: 'server_vad', threshold: config.vad.threshold, silence_duration_ms: config.vad.silenceMs, create_response: false, interrupt_response: config.vad.interruptResponse },
          tools: toolDefs,
          tool_choice: 'auto',
          temperature: config.openai.temperature,
          max_response_output_tokens: config.openai.maxTokens,
        };

    this.send({ type: 'session.update', session: sessionCfg });
  }

  sendAudio(pcm24kHz: Buffer): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.send({
      type: 'input_audio_buffer.append',
      audio: pcm24kHz.toString('base64'),
    });
  }

  sendFunctionResult(callId: string, result: unknown): void {
    const res = typeof result === 'object' && result !== null ? { ...result } : result;
    if (typeof res === 'object' && res !== null) {
      (res as any)._INSTRUCAO_SISTEMA = "IMPORTANTE: Agora você DEVE gerar uma resposta em voz para o cliente com base no resultado desta ferramenta. NUNCA fique em silêncio. Fale com o cliente IMEDIATAMENTE.";
    }

    this.send({
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: callId,
        output: typeof res === 'string' ? res : JSON.stringify(res),
      },
    });
    this.createResponse(true, "Você acabou de receber o resultado de uma ferramenta. Gere uma fala natural para o cliente com base no resultado. IMPORTANTE: Fale algo, NUNCA responda vazio.");
  }

  private clearToolTimer(callId: string): void {
    const t = this.toolTimers.get(callId);
    if (t) { clearTimeout(t); this.toolTimers.delete(callId); }
  }

  injectSystemNote(text: string): void {
    this.send({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: `[INSTRUÇÃO DO SISTEMA OBRIGATÓRIA]\n${text}` }],
      },
    });
    this.createResponse(true, "Responda adequadamente à instrução do sistema que acabou de ser enviada. Fale com o cliente de forma natural.");
  }

  createResponse(force = false, instructions?: string): boolean {
    if (!force && (this.responseActive || this.responsePending)) {
      logger.warn(`[${this.callId}] createResponse bloqueado (active=${this.responseActive}, pending=${this.responsePending})`);
      return false;
    }
    if (force && (this.responseActive || this.responsePending)) {
      logger.warn(`[${this.callId}] createResponse forçado (active=${this.responseActive}, pending=${this.responsePending})`);
      // Continua e tenta forçar mesmo assim
    }

    this.responsePending = true;
    this.armPendingWatchdog();
    this.send({ 
      type: 'response.create',
      ...(instructions ? { response: { instructions } } : {})
    });
    return true;
  }

  isResponsePending(): boolean {
    return this.responsePending;
  }

  private armPendingWatchdog(): void {
    this.clearPendingWatchdog();
    this.pendingWatchdog = setTimeout(() => {
      this.pendingWatchdog = null;
      if (this.responsePending && !this.responseActive) {
        logger.warn(`[${this.callId}] response.create sem confirmação em ${RealtimeClient.PENDING_TIMEOUT_MS}ms — liberando pending`);
        this.responsePending = false;
        this.emit('responsePendingTimeout');
      }
    }, RealtimeClient.PENDING_TIMEOUT_MS);
  }

  private clearPendingWatchdog(): void {
    if (this.pendingWatchdog) {
      clearTimeout(this.pendingWatchdog);
      this.pendingWatchdog = null;
    }
  }

  cancelResponse(): void {
    if (!this.responseActive && !this.responsePending) return;
    this.send({ type: 'response.cancel' });
    this.clearPendingWatchdog();
    this.responseActive = false;
    this.responsePending = false;
  }

  isResponseActive(): boolean {
    return this.responseActive;
  }

  /** Executa tool pelo servidor (sem function_call do modelo) e pede resposta. */
  async runServerTool(name: string, args: Record<string, unknown> = {}): Promise<unknown | null> {
    const handler = this.tools.get(name);
    if (!handler) {
      logger.warn(`[${this.callId}] runServerTool: ${name} não registrada`);
      return null;
    }

    logger.info(`[${this.callId}] Server tool: ${name}`, args);
    this.emit('toolStart', name);

    if (this.toolPreambleHook) {
      try {
        await this.toolPreambleHook(name);
      } catch (err: any) {
        logger.warn(`[${this.callId}] Falha no preâmbulo da server tool ${name}`, { err: err.message });
      }
    }

      try {
      const result = await handler(args);
      logger.info(`[${this.callId}] Server tool ${name} resultado`, result);
      await this.waitResponseDone();
      this.send({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [{
            type: 'input_text',
            text:
              `[INSTRUÇÃO DO SISTEMA OBRIGATÓRIA]\nA ferramenta ${name} foi executada pelo sistema em segundo plano e retornou:\n${JSON.stringify(result)}\n\nSiga a "orientacao" retornada e responda ao cliente IMEDIATAMENTE. NUNCA fique em silêncio.`,
          }],
        },
      });
      this.createResponse(true, `Você acabou de receber o resultado da ferramenta ${name} (enviada pelo sistema). Informe o resultado ao cliente seguindo as orientações do json recebido. Mantenha a naturalidade e NÃO FIQUE EM SILÊNCIO.`);
      this.emit('toolDone', name, result, { serverSide: true });
      return result;
    } catch (err: any) {
      logger.error(`[${this.callId}] Erro server tool ${name}`, { err: err.message });
      await this.waitResponseDone();
      this.emit('toolDone', name, { error: err.message }, { serverSide: true });
      return null;
    }
  }

  private waitResponseDone(): Promise<void> {
    if (!this.responseActive) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const done = () => resolve();
      this.once('responseDone', done);
      setTimeout(() => { this.removeListener('responseDone', done); resolve(); }, 3_000);
    });
  }

  close(): void {
    this.clearPendingWatchdog();
    this.ws?.close();
    this.ws = null;
  }

  private send(obj: unknown): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    if (config.debug.tx) logger.debug(`[${this.callId}] → ${(obj as any).type}`);
    this.ws.send(JSON.stringify(obj));
  }

  private async onMessage(raw: string): Promise<void> {
    let event: RealtimeEvent;
    try {
      event = JSON.parse(raw) as RealtimeEvent;
    } catch {
      return;
    }

    if (config.debug.tx) logger.debug(`[${this.callId}] ← ${event.type}`);

    this.emit('event', event);

    switch (event.type) {
      case 'response.audio.delta':
      case 'response.output_audio.delta': {
        if (config.tts.provider !== 'openai') break;
        const buf = Buffer.from(event.delta, 'base64');
        logger.debug(`[${this.callId}] audio chunk bytes=${buf.length}`);
        this.emit('audio', buf);
        break;
      }

      case 'response.output_audio.done':
        if (config.tts.provider === 'openai') this.emit('audioOutputDone');
        break;

      case 'response.text.delta':
      case 'response.output_text.delta':
      case 'response.output_audio_transcript.delta':
        this.emit('textDelta', event.delta);
        break;

      case 'response.text.done':
        if (!this.responseTextEmitted) {
          this.responseTextEmitted = true;
          this.emit('textDone', event.text);
        }
        break;

      case 'response.output_text.done':
        if (!this.responseTextEmitted) {
          this.responseTextEmitted = true;
          this.emit('textDone', event.text);
        }
        break;

      case 'response.output_audio_transcript.done':
        if (!this.responseTextEmitted) {
          this.responseTextEmitted = true;
          this.emit('textDone', event.transcript);
        }
        break;

      case 'input_audio_buffer.speech_started':
        this.emit('speechStart');
        break;

      case 'input_audio_buffer.speech_stopped':
        this.emit('speechStop');
        break;

      case 'response.function_call_arguments.done':
        void this.handleToolCall(event);
        break;

      case 'session.updated':
        if (!this.transcriptionReinforced) {
          this.transcriptionReinforced = true;
          const reinforceCfg = buildTranscriptionCfg();
          logger.info(`[${this.callId}] Reforçando transcrição (${reinforceCfg.model})`);
          this.send({
            type: 'session.update',
            session: this.useNewSchema
              ? { type: 'realtime', audio: { input: { transcription: reinforceCfg } } }
              : { type: 'realtime', input_audio_transcription: reinforceCfg },
          });
        }
        this.emit('sessionReady');
        break;

      case 'response.created':
        this.clearPendingWatchdog();
        this.responsePending = false;
        this.responseActive = true;
        this.responseTextEmitted = false;
        this.emit('responseCreated');
        break;

      case 'response.done': {
        this.clearPendingWatchdog();
        this.responseActive = false;
        this.responsePending = false;
        logger.debug(`[${this.callId}] RAW response.done: ${JSON.stringify(event.response)}`);
        if (!this.responseTextEmitted) {
          const text = extractResponseText(event.response);
          if (text) {
            this.responseTextEmitted = true;
            this.emit('textDone', text);
          }
        }
        this.emit('responseDone');
        break;
      }

      case 'conversation.item.input_audio_transcription.completed':
      case 'input_audio_buffer.transcript':
        if (event.transcript?.trim()) {
          logger.info(`[${this.callId}] 👤 Cliente disse: ${event.transcript.trim()}`);
          this.emit('userSpeech', event.transcript.trim());
        }
        break;

      case 'conversation.item.created':
        if (event.item?.role === 'user' && Array.isArray(event.item?.content)) {
          for (const c of event.item.content) {
            if (c.transcript?.trim()) {
              logger.info(`[${this.callId}] 👤 Cliente disse: ${c.transcript.trim()}`);
              this.emit('userSpeech', c.transcript.trim());
              break;
            }
          }
        }
        break;

      case 'conversation.item.input_audio_transcription.failed': {
        const err = (event as { error?: { type?: string; message?: string } }).error;
        logger.warn(`[${this.callId}] 👤 Transcrição do cliente FALHOU`, {
          model: config.openai.transcriptionModel,
          type: err?.type,
          message: err?.message,
        });
        this.emit('transcriptFailed');
        break;
      }

      case 'error':
        logger.error(`[${this.callId}] Realtime error`, event.error);
        break;
    }
  }

  private handleToolCall(event: RealtimeEvent & { call_id?: string; name?: string; arguments?: string }): void {
    const run = async () => {
      const call_id = event.call_id!;
      const name = event.name!;
      const argsStr = event.arguments ?? '{}';
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(argsStr); } catch { /* empty */ }

      logger.info(`[${this.callId}] Tool: ${name}`, args);

      const handler = this.tools.get(name);
      if (!handler) {
        logger.warn(`[${this.callId}] Tool desconhecida: ${name}`);
        await this.waitResponseDone();
        this.sendFunctionResult(call_id, { error: `Tool '${name}' não registrada` });
        return;
      }

      this.emit('toolStart', name);

      if (this.toolPreambleHook) {
        try {
          await this.toolPreambleHook(name);
        } catch (err: any) {
          logger.warn(`[${this.callId}] Falha no preâmbulo da tool ${name}`, { err: err.message });
        }
      }

      const slowTimer = setTimeout(() => {
        this.emit('toolSlowdown');
        this.toolTimers.delete(call_id);
      }, config.sgp.toolSlowdownMs);
      this.toolTimers.set(call_id, slowTimer);

      try {
        const result = await handler(args);
        this.clearToolTimer(call_id);
        logger.info(`[${this.callId}] Tool ${name} resultado`, result);
        await this.waitResponseDone();
        this.sendFunctionResult(call_id, result);
        this.emit('toolDone', name, result, { serverSide: false });
      } catch (err: any) {
        this.clearToolTimer(call_id);
        logger.error(`[${this.callId}] Erro na tool ${name}`, { err: err.message });
        await this.waitResponseDone();
        this.sendFunctionResult(call_id, { error: err.message });
        this.emit('toolDone', name, { error: err.message }, { serverSide: false });
      }
    };

    this.toolChain = this.toolChain.then(run).catch((err) => {
      logger.error(`[${this.callId}] Falha na cadeia de tools`, { err: String(err) });
    });
  }
}

function extractResponseText(response: unknown): string {
  if (!response || typeof response !== 'object') return '';
  const output = (response as { output?: unknown[] }).output;
  if (!Array.isArray(output)) return '';

  const parts: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== 'object') continue;
    const row = item as { type?: string; content?: unknown[] };
    if (row.type !== 'message') continue;
    for (const part of row.content ?? []) {
      if (!part || typeof part !== 'object') continue;
      const p = part as { type?: string; text?: string; transcript?: string };
      if ((p.type === 'output_text' || p.type === 'text') && p.text?.trim()) {
        parts.push(p.text.trim());
      } else if (p.transcript?.trim()) {
        parts.push(p.transcript.trim());
      }
    }
  }
  return parts.join('\n').trim();
}
