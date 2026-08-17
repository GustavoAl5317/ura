// Documentos/imagens trocados na conversa (enviados pela atendente ou pelo
// cliente). Guarda os bytes em disco e o metadado no banco — sem isso não
// tem como reabrir/baixar depois: só sobrava a descrição em texto na timeline.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { db } from './db';
import { logger } from '../logger';

const PASTA = path.join(process.cwd(), 'data', 'arquivos');

export interface ArquivoSalvo {
  id: string;
  nome: string;
  mimetype: string;
  tamanho: number;
}

/** Grava o arquivo em disco e registra o metadado. Devolve o que a timeline guarda. */
export function salvarArquivo(
  conversa: string,
  direcao: 'entrada' | 'saida',
  nome: string,
  mimetype: string,
  buffer: Buffer,
): ArquivoSalvo {
  fs.mkdirSync(PASTA, { recursive: true });
  const id = crypto.randomUUID();
  fs.writeFileSync(path.join(PASTA, id), buffer);

  db().prepare(
    `INSERT INTO arquivos (id, conversa, direcao, nome, mimetype, tamanho, criado_em)
     VALUES (?,?,?,?,?,?,?)`,
  ).run(id, conversa, direcao, nome, mimetype, buffer.length, Date.now());

  return { id, nome, mimetype, tamanho: buffer.length };
}

/** Para servir o download: caminho em disco + metadado pros headers HTTP. */
export function buscarArquivo(id: string): (ArquivoSalvo & { caminho: string }) | null {
  const r = db().prepare('SELECT * FROM arquivos WHERE id = ?').get(id);
  if (!r) return null;
  const caminho = path.join(PASTA, String(r.id));
  if (!fs.existsSync(caminho)) {
    logger.error('[arquivos] metadado sem arquivo em disco', { id });
    return null;
  }
  return {
    id: String(r.id),
    nome: String(r.nome),
    mimetype: String(r.mimetype),
    tamanho: Number(r.tamanho),
    caminho,
  };
}
