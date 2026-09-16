// Leitura das conversas de atendimento a partir do banco do ura-chat.
//
// Por que daqui e não do Evolution: os clientes chegam pelo número oficial da
// Meta, que o Evolution não enxerga. E mesmo onde enxerga, não distingue a
// resposta da IA da resposta de uma atendente. O ura-chat sabe as duas coisas:
// quem está com a conversa (IA ou humano) e quem falou por último.
//
// Quando conta como espera:
//   · atendente com a conversa e a última mensagem é do cliente;
//   · IA pediu transferência e nenhuma atendente assumiu nem escreveu depois.
// Conversa com a IA, sem transferência, não conta: a IA responde na hora.
//
// O banco é de outro processo (node:sqlite, WAL). Abre só para leitura, a cada
// ciclo, e fecha em seguida — nunca segura trava no banco do atendimento.

import fs from 'fs';
import Database from 'better-sqlite3';
import { config } from '../../config';
import type { ConversaLida } from './sla';

/** Conversa parada há mais que isto não é espera, é conversa abandonada. */
export const JANELA_MAX_HORAS_CHAT = 12;

const TOOL_TRANSFERENCIA = 'transferir_para_atendente';

interface LinhaChat {
  chave: string;
  push_name: string | null;
  cliente_nome: string | null;
  modo: string;
  atendente_nome: string | null;
  ctx_json: string | null;
  ultima_atividade: number;
  ult_id: number | null;
  ult_tipo: string | null;
  ult_ts: number | null;
  transf_id: number | null;
  transf_ts: number | null;
  humano_depois: number;
}

export type Situacao = 'aguardando_resposta' | 'respondida' | 'aguardando_assumir' | 'com_ia' | 'sem_mensagem';

export interface ConversaChat extends ConversaLida {
  modo: 'ia' | 'humano';
  situacao: Situacao;
}

function abrir(arquivo: string): Database.Database {
  if (!fs.existsSync(arquivo)) {
    throw new Error(`banco do atendimento não encontrado em ${arquivo} (CHAT_DB_PATH)`);
  }
  return new Database(arquivo, { readonly: true, fileMustExist: true });
}

/** Classifica uma conversa. Separado da consulta para ser testável sem banco. */
export function classificar(l: LinhaChat): { situacao: Situacao; deMim: boolean | null; em: number | null; msgId: string | null } {
  if (l.modo === 'humano') {
    if (!l.ult_tipo || l.ult_ts === null) return { situacao: 'sem_mensagem', deMim: null, em: null, msgId: null };
    const doCliente = l.ult_tipo === 'cliente';
    return {
      situacao: doCliente ? 'aguardando_resposta' : 'respondida',
      deMim: !doCliente,
      em: l.ult_ts,
      msgId: String(l.ult_id),
    };
  }

  // Com a IA. pendingTransfer sozinho não basta: o ura-chat não o limpa quando
  // a atendente devolve a conversa, então exige o evento da transferência e
  // nenhum sinal de humano depois dele.
  let pendente = false;
  try { pendente = !!(JSON.parse(l.ctx_json || '{}') as { pendingTransfer?: boolean }).pendingTransfer; } catch { /* ctx ilegível: sem transferência */ }
  if (pendente && l.transf_id !== null && l.transf_ts !== null && !l.humano_depois) {
    return { situacao: 'aguardando_assumir', deMim: false, em: l.transf_ts, msgId: `transf:${l.transf_id}` };
  }
  return { situacao: 'com_ia', deMim: true, em: l.ult_ts ?? l.ultima_atividade, msgId: l.ult_id !== null ? String(l.ult_id) : null };
}

/**
 * Conversas abertas com atividade recente, já classificadas.
 * LANÇA se o banco não abrir: o monitor precisa distinguir "ninguém esperando"
 * de "não consegui ler".
 */
export function lerConversasDoChat(
  agora = new Date(),
  arquivo = config.chatAtendimento.dbPath,
): { conversas: ConversaChat[]; ignoradas: number } {
  const d = abrir(arquivo);
  try {
    const desde = agora.getTime() - JANELA_MAX_HORAS_CHAT * 3600_000;
    const linhas = d.prepare(
      `SELECT c.chave, c.push_name, c.cliente_nome, c.modo, c.atendente_nome, c.ctx_json, c.ultima_atividade,
         u.id AS ult_id, u.tipo AS ult_tipo, u.ts AS ult_ts,
         t.id AS transf_id, t.ts AS transf_ts,
         (SELECT COUNT(*) FROM eventos h
           WHERE h.conversa = c.chave AND t.id IS NOT NULL AND h.id > t.id
             AND (h.tipo = 'atendente' OR (h.tipo = 'sistema' AND (h.texto LIKE '%assumiu%' OR h.texto LIKE '%devolv%')))
         ) AS humano_depois
       FROM conversas c
       LEFT JOIN eventos u ON u.id = (
         SELECT e.id FROM eventos e
          WHERE e.conversa = c.chave AND e.tipo IN ('cliente','ia','atendente')
          ORDER BY e.id DESC LIMIT 1)
       LEFT JOIN eventos t ON t.id = (
         SELECT e.id FROM eventos e
          WHERE e.conversa = c.chave AND e.tipo = 'tool' AND e.tool_name = ?
          ORDER BY e.id DESC LIMIT 1)
       WHERE c.encerrada = 0 AND c.ultima_atividade >= ?
       ORDER BY c.ultima_atividade DESC`,
    ).all(TOOL_TRANSFERENCIA, desde) as LinhaChat[];

    const conversas: ConversaChat[] = [];
    let ignoradas = 0;
    for (const l of linhas) {
      const k = classificar(l);
      if (k.em === null || k.em < desde) { ignoradas++; continue; }
      conversas.push({
        jid: l.chave,
        nome: l.cliente_nome ?? l.push_name,
        ultimaMsgId: k.msgId,
        ultimaDeMim: k.deMim,
        ultimaEm: new Date(k.em),
        // Com atendente, o responsável é ela; aguardando assumir, é o setor padrão.
        setor: l.modo === 'humano' ? l.atendente_nome : null,
        origemDaUltima: 'chat',
        modo: l.modo === 'humano' ? 'humano' : 'ia',
        situacao: k.situacao,
      });
    }
    return { conversas, ignoradas };
  } finally {
    d.close();
  }
}
