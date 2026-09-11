// Persistência do assistente — SQLite (better-sqlite3).
//
// Guarda três coisas distintas, e é importante não confundi-las:
//   1. o ESPELHO da base do SGP (sgp_*), que existe só para permitir busca por
//      nome/SN/login/CTO — mapeamento, nunca valor vivo;
//   2. o HISTÓRICO e a AUDITORIA do assistente (consulta/evidencia);
//   3. a CAMADA ADMIN (prompt versionado, permissão, auditoria de alteração).

import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { logger } from '../../logger';

const DATA_DIR = path.join(process.cwd(), 'data');
const DB_FILE = path.join(DATA_DIR, 'assistant.db');

let _db: Database.Database | null = null;

export function db(): Database.Database {
  if (_db) return _db;
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  const d = new Database(DB_FILE);
  d.pragma('journal_mode = WAL');   // leitura do painel não trava a escrita do sync
  d.pragma('busy_timeout = 5000');
  d.pragma('foreign_keys = ON');
  migrar(d);
  _db = d;
  logger.info(`Assistente: banco em ${DB_FILE}`);
  return d;
}

function migrar(d: Database.Database): void {
  d.exec(`
    -- ═══ Espelho do SGP ═══════════════════════════════════════════════════
    -- Sem NENHUM campo de senha: senha PPPoE, wifi_password e voip_sip_password
    -- vêm na resposta da API e são descartados no sync de propósito.
    CREATE TABLE IF NOT EXISTS sgp_cliente (
      cliente_id    INTEGER PRIMARY KEY,
      nome          TEXT NOT NULL,
      cpfcnpj       TEXT,
      tipo          TEXT,
      data_cadastro TEXT,
      logradouro    TEXT, numero TEXT, bairro TEXT, cidade TEXT, uf TEXT, cep TEXT,
      latitude      REAL, longitude REAL,
      atualizado_em TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_cliente_cpf ON sgp_cliente(cpfcnpj);

    CREATE TABLE IF NOT EXISTS sgp_contrato (
      contrato_id   INTEGER PRIMARY KEY,
      cliente_id    INTEGER NOT NULL,
      status        TEXT, motivo_status TEXT,
      pop_id        INTEGER, vencimento INTEGER, forma_cobranca TEXT,
      data_cadastro TEXT,
      atualizado_em TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_contrato_cliente ON sgp_contrato(cliente_id);
    CREATE INDEX IF NOT EXISTS ix_contrato_status  ON sgp_contrato(status);

    CREATE TABLE IF NOT EXISTS sgp_servico (
      servico_id     INTEGER PRIMARY KEY,
      contrato_id    INTEGER NOT NULL,
      tipo           TEXT, status TEXT, grupo TEXT,
      plano_id       INTEGER, plano_desc TEXT,
      login          TEXT, mac TEXT,
      onu_id         INTEGER, sn TEXT,
      rx             REAL, tx REAL,
      olt_id         INTEGER, olt_nome TEXT, slot INTEGER, pon INTEGER, vlan INTEGER,
      cto_nome       TEXT, cto_porta INTEGER, cto_id INTEGER,
      conexao_status TEXT, conexao_ip TEXT, conexao_desde TEXT, conexao_ate TEXT,
      atualizado_em  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_servico_contrato ON sgp_servico(contrato_id);
    CREATE INDEX IF NOT EXISTS ix_servico_sn       ON sgp_servico(sn);
    CREATE INDEX IF NOT EXISTS ix_servico_login    ON sgp_servico(login);
    CREATE INDEX IF NOT EXISTS ix_servico_mac      ON sgp_servico(mac);
    CREATE INDEX IF NOT EXISTS ix_servico_cto      ON sgp_servico(cto_nome);
    CREATE INDEX IF NOT EXISTS ix_servico_ip       ON sgp_servico(conexao_ip);

    -- Busca textual por nome do cliente / CTO / endereço.
    CREATE VIRTUAL TABLE IF NOT EXISTS sgp_busca USING fts5(
      nome, cpfcnpj, login, sn, cto, endereco,
      cliente_id UNINDEXED, contrato_id UNINDEXED,
      tokenize = 'unicode61 remove_diacritics 2'
    );

    CREATE TABLE IF NOT EXISTS sgp_sync (
      id          INTEGER PRIMARY KEY CHECK (id = 1),
      iniciado_em TEXT, concluido_em TEXT,
      paginas     INTEGER, clientes INTEGER, servicos INTEGER,
      ok          INTEGER, erro TEXT
    );

    -- ═══ Histórico e auditoria do assistente ══════════════════════════════
    CREATE TABLE IF NOT EXISTS conversa (
      id        TEXT PRIMARY KEY,
      canal     TEXT NOT NULL,            -- whatsapp | chat
      usuario   TEXT NOT NULL,            -- JID do técnico ou login do painel
      nome      TEXT,
      criada_em TEXT NOT NULL,
      ultima_em TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_conversa_usuario ON conversa(usuario, ultima_em DESC);

    CREATE TABLE IF NOT EXISTS mensagem (
      id          TEXT PRIMARY KEY,
      conversa_id TEXT NOT NULL REFERENCES conversa(id) ON DELETE CASCADE,
      papel       TEXT NOT NULL,          -- user | assistant
      formato     TEXT NOT NULL,          -- texto | audio
      conteudo    TEXT NOT NULL,
      at          TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_mensagem_conversa ON mensagem(conversa_id, at);

    -- Uma linha por pergunta respondida: o "histórico" do Projeto 1.
    CREATE TABLE IF NOT EXISTS consulta (
      id                   TEXT PRIMARY KEY,
      conversa_id          TEXT REFERENCES conversa(id) ON DELETE SET NULL,
      usuario              TEXT NOT NULL,
      canal                TEXT NOT NULL,
      pergunta             TEXT NOT NULL,
      resposta             TEXT NOT NULL,
      veredito             TEXT NOT NULL,
      veredito_ajustado    TEXT,
      fontes               TEXT,          -- JSON: fontes efetivamente consultadas
      fontes_indisponiveis TEXT,          -- JSON
      lacunas              TEXT,          -- JSON
      modelo               TEXT,
      tokens_entrada       INTEGER,
      tokens_saida         INTEGER,
      duracao_ms           INTEGER,
      at                   TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_consulta_at      ON consulta(at DESC);
    CREATE INDEX IF NOT EXISTS ix_consulta_usuario ON consulta(usuario, at DESC);

    -- "Dados utilizados": o que cada fonte devolveu, na íntegra, para auditoria.
    CREATE TABLE IF NOT EXISTS evidencia (
      id            TEXT PRIMARY KEY,
      consulta_id   TEXT NOT NULL REFERENCES consulta(id) ON DELETE CASCADE,
      evd           TEXT NOT NULL,        -- rótulo citado na resposta (evd_1…)
      fonte         TEXT NOT NULL,
      nome_consulta TEXT NOT NULL,
      args          TEXT,
      consultado_em TEXT NOT NULL,
      duracao_ms    INTEGER,
      ok            INTEGER NOT NULL,
      vazio         INTEGER NOT NULL,
      dados         TEXT,
      erro          TEXT
    );
    CREATE INDEX IF NOT EXISTS ix_evidencia_consulta ON evidencia(consulta_id);

    -- ═══ Camada administrativa ════════════════════════════════════════════
    CREATE TABLE IF NOT EXISTS prompt (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      chave     TEXT NOT NULL,            -- 'principal' | 'fonte:zabbix' | …
      versao    INTEGER NOT NULL,
      conteudo  TEXT NOT NULL,
      ativo     INTEGER NOT NULL DEFAULT 0,
      autor     TEXT,
      nota      TEXT,
      criado_em TEXT NOT NULL,
      UNIQUE(chave, versao)
    );
    CREATE INDEX IF NOT EXISTS ix_prompt_ativo ON prompt(chave, ativo);

    CREATE TABLE IF NOT EXISTS permissao (
      usuario   TEXT PRIMARY KEY,         -- JID do WhatsApp ou login do painel
      nome      TEXT,
      papel     TEXT NOT NULL DEFAULT 'tecnico',
      fontes    TEXT,                     -- JSON: fontes liberadas; null = todas
      ativo     INTEGER NOT NULL DEFAULT 1,
      criado_em TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS auditoria (
      id     INTEGER PRIMARY KEY AUTOINCREMENT,
      at     TEXT NOT NULL,
      ator   TEXT NOT NULL,
      acao   TEXT NOT NULL,
      alvo   TEXT,
      antes  TEXT,
      depois TEXT
    );
    CREATE INDEX IF NOT EXISTS ix_auditoria_at ON auditoria(at DESC);
  `);

  // Colunas acrescentadas depois da primeira versão do schema. SQLite não tem
  // "ADD COLUMN IF NOT EXISTS", então checa antes — bancos já em produção
  // precisam ganhar a coluna sem perder dado.
  adicionarColunaSeFaltar(d, 'sgp_sync', 'offset_atual', 'INTEGER');
  // Trava entre PROCESSOS. A flag em memória só valia dentro de um processo, e
  // o sync pode ser disparado por CLI, pela API e pelo agendador — em produção
  // dois rodaram juntos, duplicando ~20 min de trabalho no mesmo banco.
  adicionarColunaSeFaltar(d, 'sgp_sync', 'lock_pid', 'INTEGER');
  adicionarColunaSeFaltar(d, 'sgp_sync', 'lock_em', 'TEXT');
}

function adicionarColunaSeFaltar(
  d: Database.Database,
  tabela: string,
  coluna: string,
  tipo: string,
): void {
  const cols = d.prepare(`PRAGMA table_info(${tabela})`).all() as Array<{ name: string }>;
  if (cols.some((c) => c.name === coluna)) return;
  d.exec(`ALTER TABLE ${tabela} ADD COLUMN ${coluna} ${tipo}`);
  logger.info(`Assistente: coluna ${tabela}.${coluna} adicionada`);
}

export function registrarAuditoria(
  ator: string,
  acao: string,
  alvo?: string,
  antes?: unknown,
  depois?: unknown,
): void {
  db().prepare(
    `INSERT INTO auditoria (at, ator, acao, alvo, antes, depois) VALUES (?,?,?,?,?,?)`,
  ).run(
    new Date().toISOString(), ator, acao, alvo ?? null,
    antes === undefined ? null : JSON.stringify(antes),
    depois === undefined ? null : JSON.stringify(depois),
  );
}

export function fecharDb(): void {
  if (_db) { _db.close(); _db = null; }
}
