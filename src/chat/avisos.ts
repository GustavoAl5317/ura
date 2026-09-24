// Avisos operacionais que a IA deve comunicar: manutenção programada, mudança
// de horário, feriado, instabilidade conhecida. Diferente de promoções — aqui
// não há etapa nem condição comercial, é informação que vale para quem escrever
// enquanto o aviso estiver no ar.

import crypto from 'crypto';
import { db } from './db';
import { logger } from '../logger';

export interface Aviso {
  id: string;
  titulo: string;
  mensagem: string;
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
    mensagem: String(r.mensagem),
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
  const itens = ativos.map((a) => `• ${a.titulo}: ${a.mensagem}`).join('\n');
  return `\n═══ AVISOS EM VIGOR ═════════════════════════════════════════════════\n`
    + `Informe ao cliente quando for pertinente ao que ele perguntar. Não force o assunto\n`
    + `nem repita o aviso a cada mensagem — diga uma vez, quando fizer sentido.\n${itens}\n`;
}

export function criarAviso(d: {
  titulo: string; mensagem: string;
  inicio?: number | null; fim?: number | null; criadoPor?: string;
}): { ok: true; aviso: Aviso } | { ok: false; erro: string } {
  const titulo = d.titulo?.trim();
  const mensagem = d.mensagem?.trim();
  if (!titulo) return { ok: false, erro: 'Informe um título.' };
  if (!mensagem) return { ok: false, erro: 'Informe a mensagem do aviso.' };
  if (mensagem.length > 1500) return { ok: false, erro: 'Mensagem muito longa (máx. 1500 caracteres).' };
  if (d.inicio && d.fim && d.fim < d.inicio) {
    return { ok: false, erro: 'A data final é anterior à inicial.' };
  }

  const aviso: Aviso = {
    id: crypto.randomUUID(), titulo, mensagem,
    inicio: d.inicio ?? null, fim: d.fim ?? null,
    ativo: true, criadoEm: Date.now(), criadoPor: d.criadoPor ?? null,
  };
  db().prepare(
    `INSERT INTO avisos (id, titulo, mensagem, inicio, fim, ativo, criado_em, criado_por)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
  ).run(aviso.id, aviso.titulo, aviso.mensagem, aviso.inicio, aviso.fim, aviso.criadoEm, aviso.criadoPor);
  logger.info('[avisos] criado', { id: aviso.id, titulo, por: aviso.criadoPor });
  return { ok: true, aviso };
}

export function atualizarAviso(
  id: string,
  campos: { titulo?: string; mensagem?: string; inicio?: number | null; fim?: number | null; ativo?: boolean },
): { ok: boolean; erro?: string } {
  const atual = listarAvisos().find((a) => a.id === id);
  if (!atual) return { ok: false, erro: 'Aviso não encontrado.' };

  const titulo = campos.titulo?.trim() ?? atual.titulo;
  const mensagem = campos.mensagem?.trim() ?? atual.mensagem;
  if (!titulo || !mensagem) return { ok: false, erro: 'Título e mensagem não podem ficar em branco.' };

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
