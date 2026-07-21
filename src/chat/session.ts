// Sessão de atendimento por chat: uma por número de WhatsApp. Mantém o contexto
// (CallContext, reaproveitado da URA), o histórico de mensagens e o registry de
// ferramentas. Roda o loop agêntico (OpenAI Chat Completions + function calling).
//
// Supervisão humana (painel): cada sessão tem um modo —
//   'ia'     → a IA responde sozinha (padrão)
//   'humano' → atendente assumiu; mensagens do cliente são registradas mas a IA
//              não responde. O que a atendente enviar entra no histórico como
//              fala do assistente, então ao devolver para a IA ela continua
//              exatamente de onde a conversa parou.

import { createContext, type CallContext } from '../session/context';
import { registerTools } from '../tools/handlers';
import { whatsapp } from '../integrations/whatsapp';
import { config } from '../config';
import { logger } from '../logger';
import { ChatToolRegistry } from './tool-registry';
import { registerChatOverrides, ajustarArgsWhatsapp } from './overrides';
import { buildChatSystemPrompt } from './prompt';
import { buildChatTools } from './definitions';
import { chatCompletion, type ChatMessage, type ChatToolFunction } from './openai';

const TOOLS: ChatToolFunction[] = buildChatTools();

export type ChatMode = 'ia' | 'humano';

export interface PanelEvent {
  id: number;
  ts: number;
  /** cliente = msg recebida · ia = resposta da IA · atendente = humano via painel ·
   *  tool = consulta executada · sistema = troca de modo/avisos */
  tipo: 'cliente' | 'ia' | 'atendente' | 'tool' | 'sistema';
  texto?: string;
  tool?: { name: string; args: Record<string, unknown>; resultado: string };
}

let eventSeq = 1;

export class ChatSession {
  readonly ctx: CallContext;
  private readonly registry = new ChatToolRegistry();
  private history: ChatMessage[] = [];
  readonly eventos: PanelEvent[] = [];
  modo: ChatMode = 'ia';
  pushName?: string;
  lastActivity = Date.now();
  readonly startedAt = Date.now();
  private chain: Promise<void> = Promise.resolve();

  constructor(readonly remoteJid: string, readonly numero: string, readonly instance?: string) {
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

  get key(): string {
    return `${this.instance ?? ''}:${this.remoteJid}`;
  }

  get encerrada(): boolean {
    return this.ctx.pendingHangup === true;
  }

  // ── Eventos (timeline do painel) ─────────────────────────────────────────

  private record(ev: Omit<PanelEvent, 'id' | 'ts'>): void {
    this.eventos.push({ id: eventSeq++, ts: Date.now(), ...ev });
    if (this.eventos.length > 300) this.eventos.splice(0, this.eventos.length - 300);
  }

  // ── Controle do painel ───────────────────────────────────────────────────

  /** Atendente assume a conversa: IA para de responder até retomar(). */
  intervir(atendente?: string): void {
    if (this.modo === 'humano') return;
    this.modo = 'humano';
    this.record({ tipo: 'sistema', texto: `${atendente || 'Atendente'} assumiu a conversa — IA pausada` });
    logger.info(`[${this.ctx.callId}] painel: atendente assumiu (${this.numero})`);
  }

  /** Devolve para a IA. Se houver mensagem do cliente sem resposta, a IA responde já. */
  retomar(): void {
    if (this.modo === 'ia') return;
    this.modo = 'ia';
    this.record({ tipo: 'sistema', texto: 'Conversa devolvida para a IA' });
    logger.info(`[${this.ctx.callId}] painel: conversa devolvida à IA (${this.numero})`);

    const last = [...this.history].reverse().find((m) => m.role === 'user' || m.role === 'assistant');
    if (last?.role === 'user') {
      this.chain = this.chain.catch(() => undefined).then(() => this.run());
    }
  }

  /** Mensagem digitada pela atendente no painel: envia ao cliente e entra no
   *  histórico como fala do assistente (a IA continua a partir dela). */
  async enviarComoAtendente(texto: string): Promise<{ enviado: boolean; motivo?: string }> {
    const t = texto.trim();
    if (!t) return { enviado: false, motivo: 'texto_vazio' };
    if (this.modo !== 'humano') return { enviado: false, motivo: 'modo_ia' };

    const r = await whatsapp.enviarTexto(this.numero, t, this.instance);
    if (r.enviado) {
      this.history.push({ role: 'assistant', content: t });
      this.record({ tipo: 'atendente', texto: t });
      this.trimHistory();
      this.lastActivity = Date.now();
    }
    return { enviado: r.enviado, motivo: r.motivo };
  }

  // ── Fluxo de mensagens ───────────────────────────────────────────────────

  /** Enfileira o processamento de uma mensagem (garante ordem por cliente). */
  handle(userText: string, pushName?: string): Promise<void> {
    if (pushName?.trim()) this.pushName = pushName.trim();
    this.chain = this.chain
      .catch(() => undefined)
      .then(() => this.process(userText));
    return this.chain;
  }

  private async process(userText: string): Promise<void> {
    this.lastActivity = Date.now();
    this.ctx.lastClientSpeech = userText;
    this.history.push({ role: 'user', content: userText });
    this.record({ tipo: 'cliente', texto: userText });

    // Atendente no comando: só registra — quem responde é o humano pelo painel.
    if (this.modo === 'humano') return;

    await this.run();
  }

  /** Roda o loop agêntico sobre o histórico atual e entrega a resposta. */
  private async run(): Promise<void> {
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
        await this.entregar('Tive uma instabilidade aqui no sistema 😕 pode repetir, por favor?');
        return;
      }

      // Sem ferramentas: resposta final ao cliente.
      if (!result.toolCalls.length) {
        const texto = (result.content ?? '').trim();
        this.history.push({ role: 'assistant', content: texto || null });
        this.trimHistory();
        if (texto) await this.entregar(texto);
        return;
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

        const resultadoStr = JSON.stringify(toolResult ?? {});
        this.record({
          tipo: 'tool',
          tool: {
            name: call.function.name,
            args,
            resultado: resultadoStr.length > 2500 ? resultadoStr.slice(0, 2500) + '…' : resultadoStr,
          },
        });

        this.history.push({
          role: 'tool',
          tool_call_id: call.id,
          content: resultadoStr,
        });
      }
      // Volta ao topo do while para o modelo responder com base nos resultados.
    }

    logger.warn(`[${this.ctx.callId}] chat: limite de rodadas de ferramentas atingido`);
    await this.entregar('Consegui adiantar algumas verificações por aqui. Pode me confirmar como posso te ajudar? 🙂');
  }

  /** Envia texto da IA ao cliente pela instância da conversa e registra na timeline. */
  private async entregar(texto: string): Promise<void> {
    logger.info(`[chat] ⬆️  [${this.instance ?? 'padrão'}] ${this.numero}: ${texto}`);
    this.record({ tipo: 'ia', texto });
    await whatsapp.enviarTexto(this.numero, texto, this.instance);
  }

  // ── Snapshot para o painel ───────────────────────────────────────────────

  resumo() {
    const ultimo = [...this.eventos].reverse().find((e) => e.tipo !== 'tool' && e.tipo !== 'sistema');
    return {
      key: this.key,
      numero: this.numero,
      instance: this.instance ?? config.whatsapp.instance,
      pushName: this.pushName ?? null,
      clienteNome: this.ctx.cliente?.nome ?? null,
      modo: this.modo,
      encerrada: this.encerrada,
      pendingTransfer: this.ctx.pendingTransfer,
      ultimaMsg: ultimo?.texto ?? null,
      ultimaTs: ultimo?.ts ?? this.lastActivity,
      lastActivity: this.lastActivity,
    };
  }

  detalhe() {
    const c = this.ctx.cliente;
    const contrato = c?.contratoId
      ? c.contratos.find((ct) => ct.contrato === c.contratoId) ?? c.contratos[0]
      : c?.contratos[0];
    return {
      ...this.resumo(),
      startedAt: this.startedAt,
      cliente: c
        ? {
            nome: c.nome,
            cpf: c.cpfcnpj,
            confirmado: this.ctx.clienteConfirmado,
            contratoId: c.contratoId ?? null,
            totalContratos: c.contratos.length,
            status: contrato?.status ?? null,
            motivoStatus: contrato?.motivo_status ?? null,
            plano: contrato?.servicos[0]?.plano?.descricao ?? null,
            endereco: c.endereco
              ? [c.endereco.logradouro, c.endereco.numero, c.endereco.bairro, c.endereco.cidade]
                  .filter(Boolean).join(', ')
              : null,
            telefones: c.telefones ?? [],
          }
        : null,
      financeiro: {
        consultado: this.ctx.consultaFinanceiraFeita === true,
        bloqueado: this.ctx.financeiroBloqueado === true,
        faturasAbertas: this.ctx.titulos?.length ?? null,
      },
      onu: this.ctx.onu
        ? {
            status: this.ctx.onu.conexao?.status ?? 'desconhecido',
            sinalRx: this.ctx.onu.rx,
            olt: this.ctx.onu.olt_nome,
            cto: this.ctx.onu.cto_nome ?? this.ctx.onu.caixa ?? null,
          }
        : null,
      massivaAtiva: this.ctx.massivaAtiva,
      protocolos: this.ctx.protocolos,
      transferMotivo: this.ctx.transferMotivo ?? null,
      eventos: this.eventos,
    };
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
      for (const [key, s] of this.sessions) {
        // Sessões encerradas ficam visíveis no painel até expirar por inatividade.
        if (agora - s.lastActivity > idleMs) {
          this.sessions.delete(key);
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

  find(key: string): ChatSession | undefined {
    return this.sessions.get(key);
  }

  list(): ChatSession[] {
    return [...this.sessions.values()].sort((a, b) => b.lastActivity - a.lastActivity);
  }

  drop(remoteJid: string, instance?: string): void {
    this.sessions.delete(`${instance ?? ''}:${remoteJid}`);
  }
}
