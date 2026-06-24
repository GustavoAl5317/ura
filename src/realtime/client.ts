import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { config } from '../config';
import { logger } from '../logger';
import type { RealtimeEvent, ToolDefinition, RealtimeSessionConfig } from './types';

export type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

const TOOL_SLOWDOWN_MS = 3_500; // emite toolSlowdown se tool demorar mais que isso

export class RealtimeClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private tools = new Map<string, ToolHandler>();
  private callId = '';
  private toolTimers = new Map<string, ReturnType<typeof setTimeout>>();

  registerTool(name: string, handler: ToolHandler): void {
    this.tools.set(name, handler);
  }

  async connect(callId: string, instructions: string, toolDefs: ToolDefinition[]): Promise<void> {
    this.callId = callId;

    // Normalize model name: if it's not a recognized OpenAI realtime model, fall back
    let model = config.openai.realtimeModel;
    if (!model.startsWith('gpt-')) {
      model = 'gpt-4o-realtime-preview';
      logger.warn(`[${callId}] REALTIME_MODEL inválido, usando: ${model}`);
    }

    const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${config.openai.apiKey}`,
    };
    // Beta header required only for non-GA schema
    if (config.openai.realtimeSchema !== 'ga') {
      headers['OpenAI-Beta'] = 'realtime=v1';
    }

    this.ws = new WebSocket(url, { headers });

    await new Promise<void>((resolve, reject) => {
      this.ws!.once('open', resolve);
      this.ws!.once('error', reject);
      setTimeout(() => reject(new Error('Realtime WS connect timeout')), 15_000);
    });

    logger.info(`[${callId}] Realtime WebSocket conectado (model=${model})`);

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

    // gpt-realtime-* models use a newer API schema — different from gpt-4o-realtime-preview
    const isNewSchema = model.startsWith('gpt-realtime');

    const turnDetection: RealtimeSessionConfig['turn_detection'] = isNewSchema
      ? { type: 'server_vad', threshold: config.vad.threshold, silence_duration_ms: config.vad.silenceMs, create_response: true }
      : config.vad.type === 'semantic_vad'
        ? {
            type: 'semantic_vad',
            eagerness: config.vad.eagerness,
            create_response: true,
            interrupt_response: config.vad.interruptResponse,
          }
        : {
            type: 'server_vad',
            threshold: config.vad.threshold,
            silence_duration_ms: config.vad.silenceMs,
            create_response: true,
            interrupt_response: config.vad.interruptResponse,
          };

    const sessionCfg: RealtimeSessionConfig = isNewSchema
      ? {
          type: 'realtime',
          instructions,
          input_audio_format: 'pcm16',
          output_audio_format: 'pcm16',
          turn_detection: {
            type: 'server_vad',
            threshold: config.vad.threshold,
            silence_duration_ms: config.vad.silenceMs,
            create_response: true,
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
          input_audio_transcription: { model: 'whisper-1' },
          turn_detection: turnDetection,
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
    this.send({
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: callId,
        output: typeof result === 'string' ? result : JSON.stringify(result),
      },
    });
    this.send({ type: 'response.create' });
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
        content: [{ type: 'input_text', text }],
      },
    });
    this.send({ type: 'response.create' });
  }

  createResponse(): void {
    this.send({ type: 'response.create' });
  }

  close(): void {
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
        const buf = Buffer.from(event.delta, 'base64');
        logger.debug(`[${this.callId}] audio chunk bytes=${buf.length}`);
        this.emit('audio', buf);
        break;
      }

      case 'response.text.delta':
      case 'response.output_audio_transcript.delta':
        this.emit('textDelta', event.delta);
        break;

      case 'response.text.done':
        this.emit('textDone', event.text);
        break;

      case 'response.output_audio_transcript.done':
        this.emit('textDone', event.transcript);
        break;

      case 'input_audio_buffer.speech_started':
        this.emit('speechStart');
        break;

      case 'input_audio_buffer.speech_stopped':
        this.emit('speechStop');
        break;

      case 'response.function_call_arguments.done': {
        const { call_id, name, arguments: argsStr } = event;
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(argsStr); } catch { /* empty */ }

        logger.info(`[${this.callId}] Tool: ${name}`, args);

        const handler = this.tools.get(name);
        if (!handler) {
          logger.warn(`[${this.callId}] Tool desconhecida: ${name}`);
          this.sendFunctionResult(call_id, { error: `Tool '${name}' não registrada` });
          return;
        }

        // Timer de lentidão: emite evento se a tool demorar demais
        const slowTimer = setTimeout(() => {
          this.emit('toolSlowdown');
          this.toolTimers.delete(call_id);
        }, TOOL_SLOWDOWN_MS);
        this.toolTimers.set(call_id, slowTimer);

        try {
          const result = await handler(args);
          this.clearToolTimer(call_id);
          this.emit('toolDone');
          this.sendFunctionResult(call_id, result);
        } catch (err: any) {
          this.clearToolTimer(call_id);
          this.emit('toolDone');
          logger.error(`[${this.callId}] Erro na tool ${name}`, { err: err.message });
          this.sendFunctionResult(call_id, { error: err.message });
        }
        break;
      }

      case 'session.created':
      case 'session.updated':
        this.emit('sessionReady');
        break;

      case 'error':
        logger.error(`[${this.callId}] Realtime error`, event.error);
        break;
    }
  }
}
