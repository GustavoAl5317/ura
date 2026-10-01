// Memória do fio da conversa: de que a gente estava falando.
//
// O histórico de mensagens já ia para o modelo, mas texto solto não resolve
// referência: "e agora?", "e a outra?", "e ela?" dependem de saber QUAL alvo
// foi tratado, e isso estava só nas evidências da consulta anterior — que o
// modelo não vê.
//
// Aqui o fio é reconstruído do banco: último alvo, quando foi, e o que foi
// respondido. Vai para o modelo como uma linha curta, não como dado para
// afirmar nada: continua valendo que afirmação exige consulta nova.

import { db } from './store/db';
import { isoLocal } from './tools/base';

export interface Fio {
  /** Alvo tratado por último, em palavras ("PON 3 da OLT-3", "cliente 12345"). */
  alvo: string | null;
  ferramentas: string[];
  pergunta: string | null;
  veredito: string | null;
  em: string | null;
  minutos: number | null;
}

/** Alvo legível a partir dos argumentos da consulta feita à fonte. */
function alvoDosArgs(args: unknown): string | null {
  const a = (typeof args === 'string' ? seguro(args) : args) as Record<string, unknown> | null;
  if (!a) return null;
  const par = (chave: string, rotulo: string): string | null => {
    const v = a[chave];
    if (v === undefined || v === null || v === '') return null;
    return `${rotulo} ${v}`;
  };
  return par('cto', 'CTO') ?? par('cto_nome', 'CTO') ?? par('nome', '')?.trim() ?? par('pon', 'PON')
    ?? par('olt', 'OLT') ?? par('host', '') ?? par('equipamento', '') ?? par('contrato', 'contrato')
    ?? par('cpf', 'CPF') ?? par('login', 'login') ?? par('sn', 'SN') ?? par('telefone', 'telefone')
    ?? par('numero', '') ?? par('termo', '') ?? par('busca', '') ?? null;
}

function seguro(json: string): Record<string, unknown> | null {
  try { const x = JSON.parse(json); return typeof x === 'object' && x ? x as Record<string, unknown> : null; } catch { return null; }
}

/**
 * Última consulta desta conversa, com o alvo que ela tocou. Devolve campos
 * nulos quando a conversa é nova — é assim que o chamador sabe que não há fio.
 */
export function fioDaConversa(conversaId: string | undefined, agora = new Date()): Fio {
  const vazio: Fio = { alvo: null, ferramentas: [], pergunta: null, veredito: null, em: null, minutos: null };
  if (!conversaId) return vazio;

  const c = db().prepare(
    `SELECT id, pergunta, veredito, at FROM consulta WHERE conversa_id = ? ORDER BY at DESC LIMIT 1`,
  ).get(conversaId) as { id: string; pergunta: string; veredito: string; at: string } | undefined;
  if (!c) return vazio;

  const evid = db().prepare(
    `SELECT nome_consulta, args FROM evidencia WHERE consulta_id = ? AND ok = 1 AND vazio = 0 ORDER BY id DESC`,
  ).all(c.id) as Array<{ nome_consulta: string; args: string | null }>;

  let alvo: string | null = null;
  for (const e of evid) {
    alvo = alvoDosArgs(e.args);
    if (alvo) break;
  }

  return {
    alvo,
    ferramentas: [...new Set(evid.map((e) => e.nome_consulta))].slice(0, 4),
    pergunta: c.pergunta.slice(0, 200),
    veredito: c.veredito,
    em: isoLocal(c.at),
    minutos: Math.max(0, Math.round((agora.getTime() - new Date(c.at).getTime()) / 60_000)),
  };
}

/**
 * Linha de contexto para o modelo. null quando não há fio ou quando é antigo
 * demais para ajudar — contexto velho atrapalha mais do que ausência dele.
 */
/**
 * Último assunto desta PESSOA, em qualquer conversa dela. Serve para quando a
 * janela fechou e o WhatsApp abriu conversa nova.
 */
export function fioDoUsuario(usuario: string | undefined, agora = new Date()): Fio {
  const vazio: Fio = { alvo: null, ferramentas: [], pergunta: null, veredito: null, em: null, minutos: null };
  if (!usuario) return vazio;
  const c = db().prepare(
    `SELECT conversa_id FROM consulta WHERE usuario = ? AND conversa_id IS NOT NULL ORDER BY at DESC LIMIT 1`,
  ).get(usuario) as { conversa_id: string } | undefined;
  return c ? fioDaConversa(c.conversa_id, agora) : vazio;
}

export function linhaDeContexto(
  conversaId: string | undefined,
  opts: { usuario?: string; maxMinutos?: number; agora?: Date } = {},
): string | null {
  const agora = opts.agora ?? new Date();
  const max = opts.maxMinutos ?? 1440;
  let f = fioDaConversa(conversaId, agora);
  let mesmaConversa = true;
  // Janela fechada e conversa nova: o fio vem da última conversa da MESMA
  // pessoa. Para ela, continuar a frase duas horas depois é a mesma conversa.
  if (!f.em) {
    f = fioDoUsuario(opts.usuario, agora);
    mesmaConversa = false;
  }
  if (!f.em || f.minutos === null || f.minutos > max) return null;
  const onde = mesmaConversa ? 'Antes nesta conversa' : 'Na última conversa desta mesma pessoa';
  const partes = [
    `${onde} (há ${f.minutos} min): ela perguntou "${f.pergunta}"`,
    f.alvo ? `e o alvo tratado foi ${f.alvo}` : null,
    f.ferramentas.length ? `(consultas usadas: ${f.ferramentas.join(', ')})` : null,
  ].filter(Boolean).join(' ');
  return (
    `${partes}.
Se a mensagem de agora for continuação ("e agora?", "e a outra?", "e ela?", "voltou?"), ` +
    'entenda que é sobre esse mesmo alvo e consulte DE NOVO, porque o estado pode ter mudado. ' +
    'Este contexto serve para entender a pergunta, nunca para afirmar o estado atual.'
  );
}
