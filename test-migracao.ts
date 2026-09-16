// Regressão de migração do banco do assistente.
//
// Existe porque uma migração derrubou o serviço em produção: um UPDATE na tabela
// `alerta` rodava antes do CREATE TABLE dela. Na máquina de desenvolvimento
// passava — o banco local já tinha a tabela — e na VM, com banco anterior ao
// Bloco 4, o processo morria no boot com "no such table: alerta".
//
// Três cenários, todos em diretório temporário (nunca toca data/ do projeto):
//   1. banco inexistente;
//   2. banco com o schema EXATO da primeira versão, tirado do git, com dado sujo;
//   3. migrar duas vezes seguidas (idempotência).
//
//   npm run test:migracao

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';
import Database from 'better-sqlite3';

// O config exige estas variáveis e lê o .env do diretório atual — que, no
// diretório temporário do teste, não existe. O teste não fala com nenhum
// serviço externo; valor fictício basta.
for (const k of ['OPENAI_API_KEY', 'SGP_BASE_URL', 'SGP_TOKEN']) {
  process.env[k] ||= 'teste-migracao-sem-uso';
}

const RAIZ = __dirname;
const COMMIT_SCHEMA_ORIGINAL = 'e58d92a';

let passou = 0;
let falhou = 0;
function checa(rotulo: string, ok: boolean, detalhe = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${rotulo}${ok || !detalhe ? '' : `\n      ${detalhe}`}`);
  ok ? passou++ : falhou++;
}

/** Carrega o módulo de banco do zero, com o cwd apontando para `dir`. */
function migrarEm(dir: string): Database.Database {
  process.chdir(dir);
  for (const k of Object.keys(require.cache)) {
    if (k.includes(`${path.sep}assistant${path.sep}store${path.sep}db`)) delete require.cache[k];
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require(path.join(RAIZ, 'src', 'assistant', 'store', 'db')) as typeof import('./src/assistant/store/db');
  const d = mod.db();
  mod.fecharDb();
  return new Database(path.join(dir, 'data', 'assistant.db'));
}

function tabelas(d: Database.Database): string[] {
  return (d.prepare(`SELECT name FROM sqlite_master WHERE type IN ('table')`).all() as Array<{ name: string }>).map((t) => t.name);
}
function colunas(d: Database.Database, t: string): string[] {
  return (d.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((c) => c.name);
}

const ESPERADAS = ['sgp_cliente', 'sgp_contrato', 'sgp_servico', 'sgp_busca', 'sgp_sync', 'conversa', 'mensagem',
  'consulta', 'evidencia', 'prompt', 'permissao', 'auditoria', 'configuracao', 'alerta', 'chamada_ura', 'sla_conversa',
  'sgp_contrato_evento', 'equipe'];

function tmp(nome: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `aq-migra-${nome}-`));
}

async function main() {
  const cwdOriginal = process.cwd();
  try {
    // ── 1. Banco inexistente ────────────────────────────────────────────────
    console.log('\n─── Banco inexistente ───');
    const dirNovo = tmp('novo');
    try {
      const d = migrarEm(dirNovo);
      const faltando = ESPERADAS.filter((t) => !tabelas(d).includes(t));
      checa('cria todas as tabelas', faltando.length === 0, `faltando: ${faltando.join(', ')}`);
      d.close();
    } catch (e) {
      checa('migra banco inexistente sem lançar', false, String(e));
    }

    // ── 2. Schema da primeira versão, do git ────────────────────────────────
    console.log(`\n─── Banco com o schema original (${COMMIT_SCHEMA_ORIGINAL}) ───`);
    const dirAntigo = tmp('antigo');
    fs.mkdirSync(path.join(dirAntigo, 'data'));
    const fonteAntiga = execSync(`git show ${COMMIT_SCHEMA_ORIGINAL}:src/assistant/store/db.ts`, { cwd: RAIZ }).toString('utf8');
    const sqlAntigo = fonteAntiga.match(/d\.exec\(`([\s\S]*?)`\);/)?.[1];
    checa('extraiu o SQL original do git', !!sqlAntigo);

    const velho = new Database(path.join(dirAntigo, 'data', 'assistant.db'));
    velho.exec(sqlAntigo!);
    // Dado sujo como o que o sync antigo gravava em produção.
    const agora = new Date().toISOString();
    velho.prepare(`INSERT INTO sgp_servico (servico_id, contrato_id, slot, pon, atualizado_em) VALUES (1, 1, '', 8, ?)`).run(agora);
    velho.prepare(
      `INSERT INTO consulta (id, usuario, canal, pergunta, resposta, veredito, at) VALUES ('c1','u','chat','p','r','CONFIRMADO',?)`,
    ).run(agora);
    const antesTabelas = tabelas(velho);
    velho.close();
    checa('schema antigo NÃO tem a tabela alerta (é o cenário da VM)', !antesTabelas.includes('alerta'));

    try {
      const d = migrarEm(dirAntigo);
      const faltando = ESPERADAS.filter((t) => !tabelas(d).includes(t));
      checa('migra sem lançar e cria as tabelas novas', faltando.length === 0, `faltando: ${faltando.join(', ')}`);
      checa('sgp_sync ganhou offset_atual, lock_pid e lock_em',
        ['offset_atual', 'lock_pid', 'lock_em'].every((c) => colunas(d, 'sgp_sync').includes(c)));
      checa('consulta ganhou hipotese', colunas(d, 'consulta').includes('hipotese'));
      checa('permissao ganhou equipe', colunas(d, 'permissao').includes('equipe'));
      const s = d.prepare(`SELECT slot, pon FROM sgp_servico WHERE servico_id = 1`).get() as { slot: unknown; pon: unknown };
      checa("slot '' corrigido para NULL", s.slot === null, `slot=${JSON.stringify(s.slot)}`);
      checa('dado válido preservado (pon 8)', s.pon === 8);
      checa('consulta antiga preservada',
        (d.prepare(`SELECT COUNT(*) n FROM consulta`).get() as { n: number }).n === 1);
      d.close();
    } catch (e) {
      checa('migra banco antigo sem lançar', false, String(e));
    }

    // ── 3. Idempotência ─────────────────────────────────────────────────────
    console.log('\n─── Migrar de novo por cima ───');
    try {
      const d = migrarEm(dirAntigo);
      checa('segunda migração não lança nem duplica', tabelas(d).filter((t) => t === 'alerta').length === 1);
      d.close();
    } catch (e) {
      checa('segunda migração sem lançar', false, String(e));
    }
  } finally {
    process.chdir(cwdOriginal);
  }

  console.log(`\n${passou} passaram, ${falhou} falharam\n`);
  process.exit(falhou ? 1 : 0);
}

main();
