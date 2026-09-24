// Orientações temporárias para a IA: data comemorativa, manutenção programada,
// feriado, instabilidade conhecida, postura que a operação quer naquele período.
//
// NÃO é mensagem pronta. O que se cadastra aqui é o que a IA deve CONSIDERAR, e
// ela escreve com as próprias palavras no momento em que couber. "Hoje é Dia dos
// Pais, pode desejar boas festas a quem falar disso" funciona; um texto fixo
// para ela repetir a cada conversa soaria robótico e apareceria fora de hora.

import crypto from 'crypto';
import { db } from './db';
import { logger } from '../logger';

export interface Aviso {
  id: string;
  titulo: string;
  /** O que a IA deve fazer/considerar — não um texto para repetir literalmente. */
  instrucao: string;
  inicio: number | null;
  fim: number | null;
  ativo: boolean;
  criadoEm: number;
  criadoPor: string | null;
}

function linha(r: Record<string, unknown>): Aviso {
  return {
    id: String(r.id),
    titulo: String(r.titulo),
    instrucao: String(r.mensagem),
    inicio: r.inicio === null || r.inicio === undefined ? null : Number(r.inicio),
    fim: r.fim === null || r.fim === undefined ? null : Number(r.fim),
    ativo: Number(r.ativo) === 1,
    criadoEm: Number(r.criado_em),
    criadoPor: r.criado_por === null || r.criado_por === undefined ? null : String(r.criado_por),
  };
}

export function listarAvisos(): Aviso[] {
  return (db().prepare('SELECT * FROM avisos ORDER BY criado_em DESC').all() as Record<string, unknown>[])
    .map(linha);
}

/**
 * Avisos no ar agora. A janela é conferida NA LEITURA, não por um processo que
 * desliga no horário: se o serviço ficar fora do ar na virada da data, o aviso
 * não continua valendo por acidente.
 */
export function avisosVigentes(agora = Date.now()): Aviso[] {
  return listarAvisos().filter((a) =>
    a.ativo && (a.inicio === null || a.inicio <= agora) && (a.fim === null || a.fim >= agora));
}

/** Bloco pronto para o prompt. Vazio quando não há aviso — não suja o prompt à toa. */
export function blocoAvisosParaPrompt(agora = Date.now()): string {
  const ativos = avisosVigentes(agora);
  if (!ativos.length) return '';
  const itens = ativos.map((a) => `• ${a.titulo}: ${a.instrucao}`).join(String.fromCharCode(10));
  return [
    '',
    '═══ ORIENTAÇÕES EM VIGOR ════════════════════════════════════════════',
    'Isto NÃO é texto para copiar e colar: é orientação para VOCÊ seguir, com as suas',
    'palavras, no momento em que fizer sentido na conversa. Não force o assunto, não',
    'repita a cada mensagem e não anuncie de cara se não vier ao caso.',
    itens,
    '',
  ].join(String.fromCharCode(10));
}

export function criarAviso(d: {
  titulo: string; instrucao: string;
  inicio?: number | null; fim?: number | null; criadoPor?: string;
}): { ok: true; aviso: Aviso } | { ok: false; erro: string } {
  const titulo = d.titulo?.trim();
  const mensagem = d.instrucao?.trim();
  if (!titulo) return { ok: false, erro: 'Informe um nome para a orientação.' };
  if (!mensagem) return { ok: false, erro: 'Escreva a orientação que a IA deve seguir.' };
  if (mensagem.length > 1500) return { ok: false, erro: 'Orientação muito longa (máx. 1500 caracteres).' };
  if (d.inicio && d.fim && d.fim < d.inicio) {
    return { ok: false, erro: 'A data final é anterior à inicial.' };
  }

  const aviso: Aviso = {
    id: crypto.randomUUID(), titulo, instrucao: mensagem,
    inicio: d.inicio ?? null, fim: d.fim ?? null,
    ativo: true, criadoEm: Date.now(), criadoPor: d.criadoPor ?? null,
  };
  db().prepare(
    `INSERT INTO avisos (id, titulo, mensagem, inicio, fim, ativo, criado_em, criado_por)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
  ).run(aviso.id, aviso.titulo, aviso.instrucao, aviso.inicio, aviso.fim, aviso.criadoEm, aviso.criadoPor);
  logger.info('[avisos] criado', { id: aviso.id, titulo, por: aviso.criadoPor });
  return { ok: true, aviso };
}

export function atualizarAviso(
  id: string,
  campos: { titulo?: string; instrucao?: string; inicio?: number | null; fim?: number | null; ativo?: boolean },
): { ok: boolean; erro?: string } {
  const atual = listarAvisos().find((a) => a.id === id);
  if (!atual) return { ok: false, erro: 'Aviso não encontrado.' };

  const titulo = campos.titulo?.trim() ?? atual.titulo;
  const mensagem = campos.instrucao?.trim() ?? atual.instrucao;
  if (!titulo || !mensagem) return { ok: false, erro: 'Nome e orientação não podem ficar em branco.' };

  const inicio = campos.inicio === undefined ? atual.inicio : campos.inicio;
  const fim = campos.fim === undefined ? atual.fim : campos.fim;
  if (inicio && fim && fim < inicio) return { ok: false, erro: 'A data final é anterior à inicial.' };

  db().prepare('UPDATE avisos SET titulo=?, mensagem=?, inicio=?, fim=?, ativo=? WHERE id=?')
    .run(titulo, mensagem, inicio, fim, (campos.ativo ?? atual.ativo) ? 1 : 0, id);
  return { ok: true };
}

export function removerAviso(id: string): { ok: boolean; erro?: string } {
  const r = db().prepare('DELETE FROM avisos WHERE id = ?').run(id);
  return r.changes > 0 ? { ok: true } : { ok: false, erro: 'Aviso não encontrado.' };
}
