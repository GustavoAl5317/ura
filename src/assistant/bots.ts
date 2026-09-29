// Bots: sistemas internos que mandam evento para o assistente.
//
// Qualquer sistema da casa (Zabbix, SGP, Central Técnica, script de plantão)
// ganha um bot com chave própria e passa a publicar alerta pela API. Chave por
// bot, e não uma chave geral: se a de um vazar, desliga só ele, e a auditoria
// diz qual sistema mandou.
//
// A chave só aparece UMA vez, quando é criada ou trocada. No banco fica o hash.

import crypto from 'crypto';
import { db, registrarAuditoria } from './store/db';
import { emitir, Severidade } from './alertas';

export interface Bot {
  id: string;
  slug: string;
  nome: string;
  descricao: string | null;
  ativo: boolean;
  criado_em: string;
  ultimo_uso: string | null;
  eventos: number;
}

interface LinhaBot extends Omit<Bot, 'ativo'> { chave_hash: string; ativo: number }

export const SEVERIDADES_BOT: Severidade[] = ['info', 'aviso', 'critico'];

function paraBot(l: LinhaBot): Bot {
  return {
    id: l.id, slug: l.slug, nome: l.nome, descricao: l.descricao,
    ativo: l.ativo === 1, criado_em: l.criado_em, ultimo_uso: l.ultimo_uso, eventos: l.eventos,
  };
}

/** "Central Técnica" → "central-tecnica". */
export function slugDe(nome: string): string {
  return nome.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
}

function hashChave(chave: string): string {
  return crypto.createHash('sha256').update(chave).digest('hex');
}

export function listarBots(): Bot[] {
  return (db().prepare(`SELECT * FROM bot ORDER BY nome`).all() as LinhaBot[]).map(paraBot);
}

export function botPorSlug(slug: string): Bot | null {
  const l = db().prepare(`SELECT * FROM bot WHERE slug = ?`).get(slug) as LinhaBot | undefined;
  return l ? paraBot(l) : null;
}

export function criarBot(p: { nome: unknown; descricao?: unknown }, autor: string): { bot: Bot; chave: string } {
  const nome = String(p.nome ?? '').trim();
  if (!nome) throw new Error('informe o nome do bot');
  const slug = slugDe(nome);
  if (!slug) throw new Error('nome precisa ter letras ou números');
  if (botPorSlug(slug)) throw new Error(`já existe bot com o nome ${nome}`);

  const chave = crypto.randomBytes(24).toString('hex');
  const bot: Bot = {
    id: crypto.randomUUID(), slug, nome,
    descricao: p.descricao ? String(p.descricao).trim() : null,
    ativo: true, criado_em: new Date().toISOString(), ultimo_uso: null, eventos: 0,
  };
  db().prepare(
    `INSERT INTO bot (id, slug, nome, descricao, chave_hash, ativo, criado_em, ultimo_uso, eventos)
     VALUES (?,?,?,?,?,1,?,NULL,0)`,
  ).run(bot.id, bot.slug, bot.nome, bot.descricao, hashChave(chave), bot.criado_em);
  registrarAuditoria(autor, 'bot.criar', slug, undefined, { nome, descricao: bot.descricao });
  return { bot, chave };
}

export function trocarChave(slug: string, autor: string): string {
  const bot = botPorSlug(slug);
  if (!bot) throw new Error('bot não encontrado');
  const chave = crypto.randomBytes(24).toString('hex');
  db().prepare(`UPDATE bot SET chave_hash = ? WHERE slug = ?`).run(hashChave(chave), slug);
  registrarAuditoria(autor, 'bot.trocar_chave', slug);
  return chave;
}

export function atualizarBot(slug: string, p: { ativo?: boolean; descricao?: unknown }, autor: string): Bot {
  const antes = botPorSlug(slug);
  if (!antes) throw new Error('bot não encontrado');
  db().prepare(`UPDATE bot SET ativo = ?, descricao = ? WHERE slug = ?`).run(
    p.ativo === undefined ? (antes.ativo ? 1 : 0) : (p.ativo ? 1 : 0),
    p.descricao === undefined ? antes.descricao : (String(p.descricao).trim() || null),
    slug,
  );
  const depois = botPorSlug(slug)!;
  registrarAuditoria(autor, 'bot.editar', slug, antes, depois);
  return depois;
}

export function removerBot(slug: string, autor: string): void {
  const bot = botPorSlug(slug);
  if (!bot) throw new Error('bot não encontrado');
  db().prepare(`DELETE FROM bot WHERE slug = ?`).run(slug);
  registrarAuditoria(autor, 'bot.remover', slug, bot, undefined);
}

/** Confere a chave em tempo constante. null = slug desconhecido, chave errada ou bot pausado. */
export function autenticarBot(slug: string, chave: unknown): Bot | null {
  const l = db().prepare(`SELECT * FROM bot WHERE slug = ?`).get(slug) as LinhaBot | undefined;
  const esperado = Buffer.from(l?.chave_hash ?? '0'.repeat(64), 'hex');
  const recebido = Buffer.from(hashChave(String(chave ?? '')), 'hex');
  const bate = esperado.length === recebido.length && crypto.timingSafeEqual(esperado, recebido);
  if (!l || !bate || l.ativo !== 1) return null;
  return paraBot(l);
}

export interface EventoBot {
  titulo?: unknown;
  texto?: unknown;
  severidade?: unknown;
  /** Identificador do fato no sistema de origem. Mesmo valor não vira alerta novo. */
  chave?: unknown;
  /** Acontecimento (já terminou) em vez de problema em aberto. */
  evento?: unknown;
  /** Fato resolvido: fecha o alerta aberto com a mesma chave. */
  resolvido?: unknown;
  dados?: unknown;
}

export function validarSeveridadeBot(v: unknown): Severidade {
  const s = String(v ?? 'aviso');
  if (!SEVERIDADES_BOT.includes(s as Severidade)) throw new Error(`severidade inválida: ${s} (use info, aviso ou critico)`);
  return s as Severidade;
}

/**
 * Evento de um bot vira alerta. A chave de deduplicação leva o slug: dois
 * sistemas com o mesmo número de chamado não se atropelam.
 */
export async function receberEventoDeBot(bot: Bot, e: EventoBot): Promise<{ criado: boolean; motivo?: string; chave: string }> {
  const titulo = String(e.titulo ?? '').trim();
  if (!titulo) throw new Error('evento sem titulo');
  const texto = String(e.texto ?? '').trim() || titulo;
  const severidade = validarSeveridadeBot(e.severidade);
  const chaveFato = String(e.chave ?? '').trim().slice(0, 120);
  const chave = `bot:${bot.slug}:${chaveFato || crypto.randomUUID()}`;

  db().prepare(`UPDATE bot SET ultimo_uso = ?, eventos = eventos + 1 WHERE slug = ?`)
    .run(new Date().toISOString(), bot.slug);

  if (e.resolvido) {
    const { marcarResolvido } = await import('./alertas');
    const fechado = chaveFato ? marcarResolvido(chave) : null;
    if (!fechado) return { criado: false, motivo: 'nenhum alerta aberto com essa chave', chave };
    const a = await emitir({
      origem: 'bot',
      severidade: 'info',
      evento: true,
      titulo: `Resolvido: ${titulo}`,
      texto: `✅ *${bot.nome}*\n${texto}`,
      chave: `${chave}:resolvido`,
      dados: { bot: bot.slug, resolvido: true, ...(e.dados as object ?? {}) },
    });
    return { criado: !!a, chave };
  }

  const a = await emitir({
    origem: 'bot',
    severidade,
    evento: e.evento === true,
    titulo: `${bot.nome}: ${titulo}`,
    // Prefixo de robô: no WhatsApp a mensagem tem que se distinguir de gente.
    texto: `🤖 *${bot.nome}*\n${texto}`,
    chave,
    dados: { bot: bot.slug, ...(e.dados as object ?? {}) },
  });
  return { criado: !!a, motivo: a ? undefined : 'fato já alertado (mesma chave)', chave };
}
