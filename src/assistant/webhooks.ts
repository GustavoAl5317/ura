// Webhooks de saída: o assistente avisa outros sistemas.
//
// Espelho do bot. O bot manda evento PARA cá; o webhook leva o que acontece
// aqui PARA fora (Central Técnica, painel de terceiro, automação).
//
// Regras:
//   · envio é fogo-e-esquece com uma retentativa — nada aqui pode atrasar um
//     alerta chegando no WhatsApp;
//   · cada corpo vai assinado (HMAC-SHA256) para o outro lado conferir que
//     veio daqui;
//   · falha seguida desliga o webhook, em vez de tentar para sempre.

import crypto from 'crypto';
import axios from 'axios';
import { db, registrarAuditoria } from './store/db';
import { logger } from '../logger';

export const EVENTOS_WEBHOOK = {
  alerta: 'Alerta novo',
  'alerta.resolvido': 'Alerta resolvido',
  chamada: 'Chamada da URA',
  consulta: 'Pergunta respondida pela IA',
} as const;

export type EventoWebhook = keyof typeof EVENTOS_WEBHOOK;

/** Falhas seguidas antes de desligar sozinho. */
const MAX_FALHAS = 10;
const TIMEOUT_MS = 5_000;

export interface Webhook {
  id: string;
  nome: string;
  url: string;
  eventos: EventoWebhook[];
  ativo: boolean;
  criado_em: string;
  ultimo_envio: string | null;
  ultimo_status: string | null;
  falhas: number;
}

interface LinhaWebhook extends Omit<Webhook, 'eventos' | 'ativo'> { eventos: string; ativo: number; segredo: string }

function paraWebhook(l: LinhaWebhook): Webhook {
  let eventos: EventoWebhook[] = [];
  try { eventos = JSON.parse(l.eventos); } catch { eventos = []; }
  return {
    id: l.id, nome: l.nome, url: l.url, eventos, ativo: l.ativo === 1,
    criado_em: l.criado_em, ultimo_envio: l.ultimo_envio, ultimo_status: l.ultimo_status, falhas: l.falhas,
  };
}

export function listarWebhooks(): Webhook[] {
  return (db().prepare(`SELECT * FROM webhook_saida ORDER BY nome`).all() as LinhaWebhook[]).map(paraWebhook);
}

export function webhookPorId(id: string): Webhook | null {
  const l = db().prepare(`SELECT * FROM webhook_saida WHERE id = ?`).get(id) as LinhaWebhook | undefined;
  return l ? paraWebhook(l) : null;
}

export function validarEventos(v: unknown): EventoWebhook[] {
  if (!Array.isArray(v) || !v.length) throw new Error('escolha pelo menos um evento');
  const ruins = v.filter((x) => !(String(x) in EVENTOS_WEBHOOK));
  if (ruins.length) throw new Error(`evento inválido: ${ruins.join(', ')}`);
  return [...new Set(v.map(String))] as EventoWebhook[];
}

/** Só http e https, e nada de endereço vazio. O resto é problema de quem recebe. */
export function validarUrl(v: unknown): string {
  const bruto = String(v ?? '').trim();
  let u: URL;
  try { u = new URL(bruto); } catch { throw new Error('endereço inválido: use http:// ou https://'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('endereço precisa ser http ou https');
  return u.toString();
}

export function criarWebhook(p: { nome: unknown; url: unknown; eventos: unknown }, autor: string): { webhook: Webhook; segredo: string } {
  const nome = String(p.nome ?? '').trim();
  if (!nome) throw new Error('informe o nome do webhook');
  const url = validarUrl(p.url);
  const eventos = validarEventos(p.eventos);
  const segredo = crypto.randomBytes(24).toString('hex');
  const id = crypto.randomUUID();
  db().prepare(
    `INSERT INTO webhook_saida (id, nome, url, eventos, segredo, ativo, criado_em, ultimo_envio, ultimo_status, falhas)
     VALUES (?,?,?,?,?,1,?,NULL,NULL,0)`,
  ).run(id, nome, url, JSON.stringify(eventos), segredo, new Date().toISOString());
  registrarAuditoria(autor, 'webhook.criar', nome, undefined, { url, eventos });
  return { webhook: webhookPorId(id)!, segredo };
}

export function atualizarWebhook(id: string, p: { nome?: unknown; url?: unknown; eventos?: unknown; ativo?: boolean }, autor: string): Webhook {
  const antes = webhookPorId(id);
  if (!antes) throw new Error('webhook não encontrado');
  const url = p.url !== undefined ? validarUrl(p.url) : antes.url;
  const eventos = p.eventos !== undefined ? validarEventos(p.eventos) : antes.eventos;
  const ativo = p.ativo === undefined ? antes.ativo : p.ativo;
  db().prepare(`UPDATE webhook_saida SET nome = ?, url = ?, eventos = ?, ativo = ?, falhas = ? WHERE id = ?`).run(
    p.nome !== undefined && String(p.nome).trim() ? String(p.nome).trim() : antes.nome,
    url, JSON.stringify(eventos), ativo ? 1 : 0,
    // Reativar zera o contador: senão ele desliga de novo no primeiro tropeço.
    ativo && !antes.ativo ? 0 : antes.falhas, id,
  );
  const depois = webhookPorId(id)!;
  registrarAuditoria(autor, 'webhook.editar', depois.nome, antes, depois);
  return depois;
}

export function removerWebhook(id: string, autor: string): void {
  const w = webhookPorId(id);
  if (!w) throw new Error('webhook não encontrado');
  db().prepare(`DELETE FROM webhook_saida WHERE id = ?`).run(id);
  registrarAuditoria(autor, 'webhook.remover', w.nome, w, undefined);
}

export function assinar(segredo: string, corpo: string): string {
  return crypto.createHmac('sha256', segredo).update(corpo).digest('hex');
}

async function entregar(l: LinhaWebhook, evento: EventoWebhook, dados: unknown): Promise<{ ok: boolean; status: string }> {
  const corpo = JSON.stringify({ evento, em: new Date().toISOString(), dados });
  const cabecalhos = {
    'Content-Type': 'application/json',
    'x-assistente-evento': evento,
    'x-assistente-assinatura': assinar(l.segredo, corpo),
  };
  for (const tentativa of [1, 2]) {
    try {
      const r = await axios.post(l.url, corpo, { headers: cabecalhos, timeout: TIMEOUT_MS, validateStatus: () => true });
      if (r.status >= 200 && r.status < 300) return { ok: true, status: `HTTP ${r.status}` };
      if (tentativa === 2) return { ok: false, status: `HTTP ${r.status}` };
    } catch (err) {
      if (tentativa === 2) return { ok: false, status: err instanceof Error ? err.message.slice(0, 120) : 'falhou' };
    }
  }
  return { ok: false, status: 'falhou' };
}

/**
 * Manda o evento para todos os webhooks que o assinaram. Não é aguardado por
 * quem chama: alerta no WhatsApp não espera sistema de terceiro responder.
 */
export function dispararWebhooks(evento: EventoWebhook, dados: unknown): void {
  let alvos: LinhaWebhook[];
  try {
    alvos = (db().prepare(`SELECT * FROM webhook_saida WHERE ativo = 1`).all() as LinhaWebhook[])
      .filter((l) => { try { return (JSON.parse(l.eventos) as string[]).includes(evento); } catch { return false; } });
  } catch {
    return;   // banco fechado (fim de teste, desligando): webhook não derruba nada
  }
  for (const l of alvos) {
    void entregar(l, evento, dados).then((r) => {
      const agora = new Date().toISOString();
      const falhas = r.ok ? 0 : l.falhas + 1;
      const desliga = falhas >= MAX_FALHAS;
      try {
        db().prepare(`UPDATE webhook_saida SET ultimo_envio = ?, ultimo_status = ?, falhas = ?, ativo = ? WHERE id = ?`)
          .run(agora, r.status, falhas, desliga ? 0 : 1, l.id);
      } catch { /* banco fechado */ }
      if (!r.ok) logger.warn('Webhook: entrega falhou', { nome: l.nome, status: r.status, falhas });
      if (desliga) {
        logger.error('Webhook desligado depois de falhas seguidas', { nome: l.nome, falhas });
        try { registrarAuditoria('sistema', 'webhook.desligado', l.nome, undefined, { falhas, ultimo: r.status }); } catch { /* idem */ }
      }
    });
  }
}

/** Envio de teste pedido no painel. Diferente do disparo automático: espera a resposta. */
export async function testarWebhook(id: string, autor: string): Promise<{ ok: boolean; status: string }> {
  const l = db().prepare(`SELECT * FROM webhook_saida WHERE id = ?`).get(id) as LinhaWebhook | undefined;
  if (!l) throw new Error('webhook não encontrado');
  const r = await entregar(l, 'alerta', { teste: true, titulo: 'Teste do webhook', por: autor });
  db().prepare(`UPDATE webhook_saida SET ultimo_envio = ?, ultimo_status = ? WHERE id = ?`)
    .run(new Date().toISOString(), r.status, id);
  registrarAuditoria(autor, 'webhook.teste', l.nome, undefined, r);
  return r;
}
