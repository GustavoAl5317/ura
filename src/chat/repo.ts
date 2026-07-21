// Persistência das conversas e da timeline. Guardamos o contexto (CallContext)
// e o histórico de mensagens da IA, para que um restart do serviço não perca o
// atendimento em andamento — e para alimentar a Auditoria.

import { db } from './db';
import type { CallContext } from '../session/context';
import type { PanelEvent } from './session';

export interface ConversaSalva {
  chave: string;
  numero: string;
  instancia?: string;
  pushName?: string;
  modo: 'ia' | 'humano';
  atendenteId?: string;
  atendenteNome?: string;
  encerrada: boolean;
  iniciadaEm: number;
  ultimaAtividade: number;
  ctx: Partial<CallContext>;
  history: unknown[];
  eventos: PanelEvent[];
}

/** Grava (ou atualiza) o estado da conversa. */
export function salvarConversa(c: {
  chave: string; numero: string; instancia?: string; pushName?: string;
  modo: string; atendenteId?: string; atendenteNome?: string; encerrada: boolean;
  iniciadaEm: number; ultimaAtividade: number;
  ctx: CallContext; history: unknown[];
}): void {
  const cli = c.ctx.cliente;
  db().prepare(
    `INSERT INTO conversas
       (chave, numero, instancia, push_name, cliente_nome, cliente_cpf, contrato_id,
        modo, atendente_id, atendente_nome, encerrada, iniciada_em, ultima_atividade,
        ctx_json, history_json)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(chave) DO UPDATE SET
       push_name        = excluded.push_name,
       cliente_nome     = excluded.cliente_nome,
       cliente_cpf      = excluded.cliente_cpf,
       contrato_id      = excluded.contrato_id,
       modo             = excluded.modo,
       atendente_id     = excluded.atendente_id,
       atendente_nome   = excluded.atendente_nome,
       encerrada        = excluded.encerrada,
       ultima_atividade = excluded.ultima_atividade,
       ctx_json         = excluded.ctx_json,
       history_json     = excluded.history_json`,
  ).run(
    c.chave, c.numero, c.instancia ?? null, c.pushName ?? null,
    cli?.nome ?? null, cli?.cpfcnpj ?? null, cli?.contratoId ?? null,
    c.modo, c.atendenteId ?? null, c.atendenteNome ?? null,
    c.encerrada ? 1 : 0, c.iniciadaEm, c.ultimaAtividade,
    JSON.stringify(serializarCtx(c.ctx)), JSON.stringify(c.history),
  );
}

/** Só os campos do contexto que valem persistir (o resto é recarregável do SGP). */
function serializarCtx(ctx: CallContext): Partial<CallContext> {
  return {
    callId: ctx.callId,
    callerNumber: ctx.callerNumber,
    canal: ctx.canal,
    whatsappInstance: ctx.whatsappInstance,
    cliente: ctx.cliente,
    titulos: ctx.titulos,
    onu: ctx.onu,
    clienteIdentificado: ctx.clienteIdentificado,
    clienteConfirmado: ctx.clienteConfirmado,
    contratoSelecionado: ctx.contratoSelecionado,
    massivaAtiva: ctx.massivaAtiva,
    pendingTransfer: ctx.pendingTransfer,
    pendingHangup: ctx.pendingHangup,
    transferMotivo: ctx.transferMotivo,
    transferSummary: ctx.transferSummary,
    enderecoConsultado: ctx.enderecoConsultado,
    celularWhatsApp: ctx.celularWhatsApp,
    celularWhatsAppConfirmado: ctx.celularWhatsAppConfirmado,
    protocolos: ctx.protocolos,
    faturaWhatsApp: ctx.faturaWhatsApp,
    infraTermos: ctx.infraTermos,
    log: ctx.log,
    agentName: ctx.agentName,
    lastClientSpeech: ctx.lastClientSpeech,
    consultaFinanceiraFeita: ctx.consultaFinanceiraFeita,
    consultaMassivaFeita: ctx.consultaMassivaFeita,
    financeiroBloqueado: ctx.financeiroBloqueado,
  };
}

/** Grava um evento da timeline e devolve o id gerado pelo banco. */
export function salvarEvento(chave: string, ev: Omit<PanelEvent, 'id'>): number {
  const r = db().prepare(
    `INSERT INTO eventos (conversa, ts, tipo, texto, autor, tool_name, tool_args, tool_resultado)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(
    chave, ev.ts, ev.tipo, ev.texto ?? null, ev.autor ?? null,
    ev.tool?.name ?? null,
    ev.tool ? JSON.stringify(ev.tool.args ?? {}) : null,
    ev.tool?.resultado ?? null,
  );
  return Number(r.lastInsertRowid);
}

function linhaParaEvento(r: Record<string, unknown>): PanelEvent {
  const ev: PanelEvent = {
    id: Number(r.id),
    ts: Number(r.ts),
    tipo: String(r.tipo) as PanelEvent['tipo'],
  };
  if (r.texto != null) ev.texto = String(r.texto);
  if (r.autor != null) ev.autor = String(r.autor);
  if (r.tool_name != null) {
    let args: Record<string, unknown> = {};
    try { args = JSON.parse(String(r.tool_args ?? '{}')); } catch { /* ignora */ }
    ev.tool = { name: String(r.tool_name), args, resultado: String(r.tool_resultado ?? '') };
  }
  return ev;
}

export function eventosDaConversa(chave: string, limite = 300): PanelEvent[] {
  return db().prepare(
    'SELECT * FROM eventos WHERE conversa = ? ORDER BY id DESC LIMIT ?',
  ).all(chave, limite).map(linhaParaEvento).reverse();
}

/** Conversas recentes ainda ativas — recarregadas na memória no boot. */
export function conversasParaRetomar(idadeMaximaMs: number): ConversaSalva[] {
  const limite = Date.now() - idadeMaximaMs;
  return db().prepare(
    'SELECT * FROM conversas WHERE encerrada = 0 AND ultima_atividade >= ? ORDER BY ultima_atividade DESC',
  ).all(limite).map((r) => {
    let ctx: Partial<CallContext> = {};
    let history: unknown[] = [];
    try { ctx = JSON.parse(String(r.ctx_json ?? '{}')); } catch { /* ignora */ }
    try { history = JSON.parse(String(r.history_json ?? '[]')); } catch { /* ignora */ }
    return {
      chave: String(r.chave),
      numero: String(r.numero),
      instancia: r.instancia == null ? undefined : String(r.instancia),
      pushName: r.push_name == null ? undefined : String(r.push_name),
      modo: r.modo === 'humano' ? 'humano' : 'ia',
      atendenteId: r.atendente_id == null ? undefined : String(r.atendente_id),
      atendenteNome: r.atendente_nome == null ? undefined : String(r.atendente_nome),
      encerrada: Number(r.encerrada) === 1,
      iniciadaEm: Number(r.iniciada_em),
      ultimaAtividade: Number(r.ultima_atividade),
      ctx, history,
      eventos: eventosDaConversa(String(r.chave)),
    };
  });
}

// ── Auditoria ──────────────────────────────────────────────────────────────

export interface FiltroAuditoria {
  de?: number;
  ate?: number;
  atendenteId?: string;
  busca?: string;
  limite?: number;
}

export function auditoriaConversas(f: FiltroAuditoria) {
  const cond: string[] = [];
  const par: unknown[] = [];

  if (typeof f.de === 'number' && f.de > 0)  { cond.push('ultima_atividade >= ?'); par.push(f.de); }
  if (typeof f.ate === 'number' && f.ate > 0) { cond.push('ultima_atividade <= ?'); par.push(f.ate); }
  if (f.atendenteId) {
    // Quem atendeu agora ou em algum momento da conversa.
    cond.push(`(atendente_id = ? OR chave IN (
      SELECT DISTINCT conversa FROM eventos WHERE tipo = 'atendente' AND autor IN (
        SELECT nome FROM usuarios WHERE id = ?)))`);
    par.push(f.atendenteId, f.atendenteId);
  }
  if (f.busca) {
    cond.push('(cliente_nome LIKE ? OR numero LIKE ? OR cliente_cpf LIKE ? OR push_name LIKE ?)');
    const t = `%${f.busca}%`;
    par.push(t, t, t, t);
  }

  const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
  const limite = Math.min(Math.max(f.limite ?? 100, 1), 500);

  return db().prepare(
    `SELECT c.*,
        (SELECT COUNT(*) FROM eventos e WHERE e.conversa = c.chave) AS total_eventos,
        (SELECT COUNT(*) FROM eventos e WHERE e.conversa = c.chave AND e.tipo = 'tool') AS total_consultas,
        (SELECT COUNT(*) FROM eventos e WHERE e.conversa = c.chave AND e.tipo = 'atendente') AS msgs_atendente,
        (SELECT GROUP_CONCAT(DISTINCT e.autor) FROM eventos e
           WHERE e.conversa = c.chave AND e.tipo = 'atendente') AS atendentes
     FROM conversas c ${where}
     ORDER BY c.ultima_atividade DESC LIMIT ?`,
  ).all(...par, limite).map((r) => ({
    chave: String(r.chave),
    numero: String(r.numero),
    instancia: r.instancia == null ? null : String(r.instancia),
    cliente: (r.cliente_nome ?? r.push_name ?? null) as string | null,
    cpf: r.cliente_cpf == null ? null : String(r.cliente_cpf),
    contratoId: r.contrato_id == null ? null : Number(r.contrato_id),
    modo: String(r.modo),
    encerrada: Number(r.encerrada) === 1,
    iniciadaEm: Number(r.iniciada_em),
    ultimaAtividade: Number(r.ultima_atividade),
    duracaoMin: Math.max(1, Math.round((Number(r.ultima_atividade) - Number(r.iniciada_em)) / 60000)),
    totalEventos: Number(r.total_eventos),
    totalConsultas: Number(r.total_consultas),
    msgsAtendente: Number(r.msgs_atendente),
    atendentes: r.atendentes ? String(r.atendentes).split(',') : [],
  }));
}

export function auditoriaResumo(f: FiltroAuditoria) {
  // SQL e parâmetros montados juntos — evita descompasso quando `de` é 0.
  const usaDe = typeof f.de === 'number' && f.de > 0;
  const usaAte = typeof f.ate === 'number' && f.ate > 0;

  const cond: string[] = [];
  const par: unknown[] = [];
  if (usaDe)  { cond.push('ultima_atividade >= ?'); par.push(f.de); }
  if (usaAte) { cond.push('ultima_atividade <= ?'); par.push(f.ate); }
  const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';

  // Mesmo recorte de período, aplicado sobre a coluna ts dos eventos.
  const evCond: string[] = [];
  const evPar: unknown[] = [];
  if (usaDe)  { evCond.push('ts >= ?'); evPar.push(f.de); }
  if (usaAte) { evCond.push('ts <= ?'); evPar.push(f.ate); }
  const evWhere = evCond.length ? ' AND ' + evCond.join(' AND ') : '';

  const r = db().prepare(
    `SELECT COUNT(*) AS conversas,
       SUM(CASE WHEN encerrada = 1 THEN 1 ELSE 0 END) AS encerradas,
       SUM(CASE WHEN cliente_nome IS NOT NULL THEN 1 ELSE 0 END) AS identificados
     FROM conversas ${where}`,
  ).get(...par) as Record<string, unknown>;

  const comHumano = db().prepare(
    `SELECT COUNT(DISTINCT conversa) AS n FROM eventos WHERE tipo = 'atendente'${evWhere}`,
  ).get(...evPar) as { n: number };

  const consultas = db().prepare(
    `SELECT tool_name AS nome, COUNT(*) AS n FROM eventos
     WHERE tipo = 'tool'${evWhere}
     GROUP BY tool_name ORDER BY n DESC LIMIT 8`,
  ).all(...evPar);

  const total = Number(r.conversas ?? 0);
  return {
    conversas: total,
    encerradas: Number(r.encerradas ?? 0),
    identificados: Number(r.identificados ?? 0),
    comIntervencao: comHumano.n,
    resolvidasPelaIa: Math.max(0, total - comHumano.n),
    consultasTop: consultas.map((c) => ({ nome: String(c.nome), n: Number(c.n) })),
  };
}

export function conversaDetalheAuditoria(chave: string) {
  const r = db().prepare('SELECT * FROM conversas WHERE chave = ?').get(chave);
  if (!r) return null;
  return {
    chave: String(r.chave),
    numero: String(r.numero),
    instancia: r.instancia == null ? null : String(r.instancia),
    cliente: (r.cliente_nome ?? r.push_name ?? null) as string | null,
    cpf: r.cliente_cpf == null ? null : String(r.cliente_cpf),
    contratoId: r.contrato_id == null ? null : Number(r.contrato_id),
    encerrada: Number(r.encerrada) === 1,
    iniciadaEm: Number(r.iniciada_em),
    ultimaAtividade: Number(r.ultima_atividade),
    eventos: eventosDaConversa(chave, 1000),
  };
}
