// Banco de dados do atendimento (SQLite via node:sqlite — embutido no Node,
// sem dependência externa nem compilação nativa. Requer Node >= 22.5).
//
// Guarda usuários, sessões de login, conversas (com o contexto e o histórico
// que a IA usa) e a timeline de eventos — é o que permite sobreviver a um
// restart e o que alimenta a tela de Auditoria.

import fs from 'fs';
import path from 'path';
import { logger } from '../logger';

// node:sqlite ainda não está no @types/node 20 — declaração mínima do que usamos.
interface SqlStatement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
}
interface SqlDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
  close(): void;
}

const ARQUIVO = path.join(process.cwd(), 'data', 'atendimento.db');

let bd: SqlDatabase | null = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS usuarios (
  id            TEXT PRIMARY KEY,
  login         TEXT UNIQUE NOT NULL,
  nome          TEXT NOT NULL,
  papel         TEXT NOT NULL DEFAULT 'atendente',
  senha_hash    TEXT NOT NULL,
  ativo         INTEGER NOT NULL DEFAULT 1,
  criado_em     INTEGER NOT NULL,
  ultimo_acesso INTEGER
);

CREATE TABLE IF NOT EXISTS sessoes (
  token     TEXT PRIMARY KEY,
  user_id   TEXT NOT NULL,
  expira_em INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_sessoes_user ON sessoes(user_id);

CREATE TABLE IF NOT EXISTS conversas (
  chave            TEXT PRIMARY KEY,
  numero           TEXT NOT NULL,
  instancia        TEXT,
  push_name        TEXT,
  cliente_nome     TEXT,
  cliente_cpf      TEXT,
  contrato_id      INTEGER,
  modo             TEXT NOT NULL DEFAULT 'ia',
  atendente_id     TEXT,
  atendente_nome   TEXT,
  encerrada        INTEGER NOT NULL DEFAULT 0,
  iniciada_em      INTEGER NOT NULL,
  ultima_atividade INTEGER NOT NULL,
  ctx_json         TEXT,
  history_json     TEXT
);
CREATE INDEX IF NOT EXISTS ix_conversas_atividade ON conversas(ultima_atividade DESC);

CREATE TABLE IF NOT EXISTS eventos (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  conversa       TEXT NOT NULL,
  ts             INTEGER NOT NULL,
  tipo           TEXT NOT NULL,
  texto          TEXT,
  autor          TEXT,
  tool_name      TEXT,
  tool_args      TEXT,
  tool_resultado TEXT
);
CREATE INDEX IF NOT EXISTS ix_eventos_conversa ON eventos(conversa, id);
CREATE INDEX IF NOT EXISTS ix_eventos_ts ON eventos(ts DESC);
`;

export function db(): SqlDatabase {
  if (!bd) throw new Error('Banco não inicializado — chame initDb() antes.');
  return bd;
}

export function initDb(): void {
  if (bd) return;

  let DatabaseSync: new (caminho: string) => SqlDatabase;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch {
    throw new Error(
      'Este Node não tem node:sqlite (precisa da versão 22.5 ou maior). ' +
      `Versão atual: ${process.version}. Aponte o serviço para um Node 22+.`,
    );
  }

  fs.mkdirSync(path.dirname(ARQUIVO), { recursive: true });
  bd = new DatabaseSync(ARQUIVO);
  bd.exec('PRAGMA journal_mode = WAL');
  bd.exec('PRAGMA foreign_keys = ON');
  bd.exec(SCHEMA);

  migrarUsuariosDoJson();
  limparSessoesExpiradas();

  logger.info(`Banco do atendimento: ${ARQUIVO}`);
}

/** Traz os usuários do arquivo JSON antigo (versão anterior do painel). */
function migrarUsuariosDoJson(): void {
  const antigo = path.join(process.cwd(), 'data', 'chat-usuarios.json');
  if (!fs.existsSync(antigo)) return;

  const jaTem = db().prepare('SELECT COUNT(*) AS n FROM usuarios').get() as { n: number };
  if (jaTem.n > 0) return;

  try {
    const lista = JSON.parse(fs.readFileSync(antigo, 'utf8')) as Array<Record<string, unknown>>;
    const ins = db().prepare(
      `INSERT INTO usuarios (id, login, nome, papel, senha_hash, ativo, criado_em, ultimo_acesso)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const u of lista) {
      ins.run(
        String(u.id), String(u.login), String(u.nome), String(u.papel ?? 'atendente'),
        String(u.senhaHash), u.ativo === false ? 0 : 1,
        Number(u.criadoEm ?? Date.now()), u.ultimoAcesso ? Number(u.ultimoAcesso) : null,
      );
    }
    fs.renameSync(antigo, antigo + '.migrado');
    logger.info(`Migrados ${lista.length} usuário(s) do JSON para o banco`);
  } catch (err) {
    logger.error('Falha ao migrar usuários do JSON', { err: String(err) });
  }
}

export function limparSessoesExpiradas(): void {
  db().prepare('DELETE FROM sessoes WHERE expira_em < ?').run(Date.now());
}

/** Remove conversas antigas encerradas — mantém o histórico recente para auditoria. */
export function limparConversasAntigas(diasRetencao: number): number {
  if (diasRetencao <= 0) return 0;
  const limite = Date.now() - diasRetencao * 86_400_000;
  const chaves = db().prepare('SELECT chave FROM conversas WHERE ultima_atividade < ?').all(limite);
  if (!chaves.length) return 0;
  const delEv = db().prepare('DELETE FROM eventos WHERE conversa = ?');
  const delCv = db().prepare('DELETE FROM conversas WHERE chave = ?');
  for (const c of chaves) {
    delEv.run(String(c.chave));
    delCv.run(String(c.chave));
  }
  return chaves.length;
}

export function fecharDb(): void {
  if (bd) { bd.close(); bd = null; }
}
