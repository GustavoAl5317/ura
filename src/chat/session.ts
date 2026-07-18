// Sessão de atendimento por chat: uma por número de WhatsApp. Mantém o contexto
// (CallContext, reaproveitado da URA), o histórico de mensagens e o registry de
// ferramentas. Roda o loop agêntico (OpenAI Chat Completions + function calling).

import { createContext, type CallContext } from '../session/context';
import { registerTools } from '../tools/handlers';
import { config } from '../config';
import { logger } from '../logger';
import { ChatToolRegistry } from './tool-registry';
import { registerChatOverrides, ajustarArgsWhatsapp } from './overrides';
import { buildChatSystemPrompt } from './prompt';
import { buildChatTools } from './definitions';
import { chatCompletion, type ChatMessage, type ChatToolFunction } from './openai';

const TOOLS: ChatToolFunction[] = buildChatTools();

export class ChatSession {
  readonly ctx: CallContext;
  private readonly registry = new ChatToolRegistry();
  private history: ChatMessage[] = [];
  lastActivity = Date.now();
  private chain: Promise<string | null> = Promise.resolve(null);

  constructor(readonly remoteJid: string, numero: string, instance?: string) {
    this.ctx = createContext(remoteJid, numero);
    this.ctx.canal = 'chat';
    this.ctx.agentName = config.company.agentName;
    // Responde/entrega pela MESMA instância Evolution que recebeu a mensagem.
    this.ctx.whatsappInstance = instance;
    // No chat já sabemos o WhatsApp do cliente (é o remetente): pré-confirmado.
    this.ctx.celularWhatsApp = numero;
    this.ctx.celularWhatsAppConfirmado = true;

    registerTools(this.registry, this.ctx);   // MESMOS handlers da URA
    registerChatOverrides(this.registry, this.ctx);
  }

  get encerrada(): boolean {
    return this.ctx.pendingHangup === true;
  }

  /** Enfileira o processamento de uma mensagem (garante ordem por cliente). */
  handle(userText: string): Promise<string | null> {
    this.chain = this.chain
      .catch(() => null)
      .then(() => this.process(userText));
    return this.chain;
  }

  private async process(userText: string): Promise<string | null> {
    this.lastActivity = Date.now();
    this.ctx.lastClientSpeech = userText;
    this.history.push({ role: 'user', content: userText });

    let round = 0;
    while (round < config.chat.maxToolRounds) {
      round += 1;

      const messages: ChatMessage[] = [
        { role: 'system', content: buildChatSystemPrompt(this.ctx) },
        ...this.history,
      ];

      let result;
      try {
        result = await chatCompletion(messages, TOOLS);
      } catch {
        return 'Tive uma instabilidade aqui no sistema 😕 pode repetir, por favor?';
      }

      // Sem ferramentas: resposta final ao cliente.
      if (!result.toolCalls.length) {
        const texto = (result.content ?? '').trim();
        this.history.push({ role: 'assistant', content: texto || null });
        this.trimHistory();
        return texto || null;
      }

      // Registra a decisão do modelo (assistant com tool_calls) e executa cada tool.
      this.history.push({
        role: 'assistant',
        content: result.content ?? null,
        tool_calls: result.toolCalls,
      });

      for (const call of result.toolCalls) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(call.function.arguments || '{}');
        } catch { /* args inválidos → objeto vazio */ }

        args = ajustarArgsWhatsapp(call.function.name, args, this.ctx);

        logger.info(`[${this.ctx.callId}] chat tool: ${call.function.name}`, args);
        let toolResult: unknown;
        try {
          toolResult = await this.registry.dispatch(call.function.name, args);
        } catch (err: unknown) {
          toolResult = { error: err instanceof Error ? err.message : String(err) };
        }
        logger.info(`[${this.ctx.callId}] chat tool ${call.function.name} →`, toolResult);

        this.history.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify(toolResult ?? {}),
        });
      }
      // Volta ao topo do while para o modelo responder com base nos resultados.
    }

    logger.warn(`[${this.ctx.callId}] chat: limite de rodadas de ferramentas atingido`);
    return 'Consegui adiantar algumas verificações por aqui. Pode me confirmar como posso te ajudar? 🙂';
  }

  /** Mantém o histórico enxuto (system é reconstruído a cada turno). */
  private trimHistory(): void {
    const MAX = 40;
    if (this.history.length <= MAX) return;
    this.history = this.history.slice(this.history.length - MAX);
    // Não pode começar por 'tool' (a API exige o assistant/tool_call antes).
    while (this.history.length && this.history[0].role === 'tool') {
      this.history.shift();
    }
  }
}

export class ChatSessionStore {
  private sessions = new Map<string, ChatSession>();

  constructor() {
    const idleMs = config.chat.sessionIdleMin * 60_000;
    setInterval(() => {
      const agora = Date.now();
      for (const [jid, s] of this.sessions) {
        if (s.encerrada || agora - s.lastActivity > idleMs) {
          this.sessions.delete(jid);
        }
      }
    }, 60_000).unref?.();
  }

  get(remoteJid: string, numero: string, instance?: string): ChatSession {
    const key = `${instance ?? ''}:${remoteJid}`;
    let s = this.sessions.get(key);
    if (s && s.encerrada) {
      this.sessions.delete(key);
      s = undefined;
    }
    if (!s) {
      s = new ChatSession(remoteJid, numero, instance);
      this.sessions.set(key, s);
      logger.info(`[chat] Nova sessão para ${numero} (${remoteJid}) via instância ${instance ?? '(padrão)'}`);
    }
    return s;
  }

  drop(remoteJid: string, instance?: string): void {
    this.sessions.delete(`${instance ?? ''}:${remoteJid}`);
  }
}
