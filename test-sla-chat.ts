// Testes do monitor de SLA lendo o banco do ura-chat.
//
// Recria o banco do ura-chat com o schema dele (src/chat/db.ts, branch do chat)
// e deixa uma conexão de escrita aberta o tempo todo, como o ura-chat faz em
// produção. Cada conversa reproduz um caso visto no banco real em 16/09/2026.
//
//   npm run test:sla

import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';

for (const k of ['OPENAI_API_KEY', 'SGP_BASE_URL', 'SGP_TOKEN']) {
  process.env[k] ||= 'teste-sla-sem-uso';
}

const RAIZ = __dirname;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aq-sla-'));
process.chdir(dir);

/* eslint-disable @typescript-eslint/no-var-requires */
const { config } = require(path.join(RAIZ, 'src', 'config')) as typeof import('./src/config');
const { db, fecharDb } = require(path.join(RAIZ, 'src', 'assistant', 'store', 'db')) as typeof import('./src/assistant/store/db');
const { definir } = require(path.join(RAIZ, 'src', 'assistant', 'config-dinamica')) as typeof import('./src/assistant/config-dinamica');
const { lerConversasDoChat } = require(path.join(RAIZ, 'src', 'assistant', 'monitors', 'sla-chat')) as typeof import('./src/assistant/monitors/sla-chat');
const { cicloSla, diagnosticoSla } = require(path.join(RAIZ, 'src', 'assistant', 'monitors', 'sla')) as typeof import('./src/assistant/monitors/sla');
/* eslint-enable @typescript-eslint/no-var-requires */

let passou = 0;
let falhou = 0;
function checa(rotulo: string, ok: boolean, detalhe: unknown = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${rotulo}${ok || detalhe === '' ? '' : `\n      ${typeof detalhe === 'string' ? detalhe : JSON.stringify(detalhe)}`}`);
  ok ? passou++ : falhou++;
}

// ── Banco do ura-chat ────────────────────────────────────────────────────────
const ARQ = path.join(dir, 'atendimento.db');
const chat = new Database(ARQ);
chat.pragma('journal_mode = WAL');
chat.exec(`
CREATE TABLE conversas (
  chave TEXT PRIMARY KEY, numero TEXT NOT NULL, instancia TEXT, push_name TEXT, cliente_nome TEXT,
  cliente_cpf TEXT, contrato_id INTEGER, modo TEXT NOT NULL DEFAULT 'ia', atendente_id TEXT,
  atendente_nome TEXT, encerrada INTEGER NOT NULL DEFAULT 0, iniciada_em INTEGER NOT NULL,
  ultima_atividade INTEGER NOT NULL, ctx_json TEXT, history_json TEXT);
CREATE TABLE eventos (
  id INTEGER PRIMARY KEY AUTOINCREMENT, conversa TEXT NOT NULL, ts INTEGER NOT NULL, tipo TEXT NOT NULL,
  texto TEXT, autor TEXT, tool_name TEXT, tool_args TEXT, tool_resultado TEXT);
`);
(config.chatAtendimento as { dbPath: string }).dbPath = ARQ;

const AGORA = Date.now();
const min = (m: number) => AGORA - m * 60_000;

function conversa(p: { chave: string; modo?: string; atendente?: string; encerrada?: number; transfer?: boolean; nome?: string; push?: string; ultima: number }) {
  chat.prepare(
    `INSERT INTO conversas (chave, numero, instancia, push_name, cliente_nome, modo, atendente_id, atendente_nome, encerrada, iniciada_em, ultima_atividade, ctx_json)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(p.chave, '5585999990000', '1246065728588386', p.push ?? null, p.nome ?? null, p.modo ?? 'ia',
    p.atendente ? 'u1' : null, p.atendente ?? null, p.encerrada ?? 0, min(120), p.ultima,
    JSON.stringify({ pendingTransfer: !!p.transfer }));
}
function evento(conv: string, ts: number, tipo: string, texto = 'x', tool: string | null = null) {
  chat.prepare(`INSERT INTO eventos (conversa, ts, tipo, texto, tool_name) VALUES (?,?,?,?,?)`).run(conv, ts, tipo, texto, tool);
}

// 1. atendente com a conversa, cliente falou por último há 20 min → espera
conversa({ chave: 'c1', modo: 'humano', atendente: 'Joana', nome: 'MARIA CLIENTE', push: 'Mari', ultima: min(20) });
evento('c1', min(40), 'cliente'); evento('c1', min(30), 'atendente'); evento('c1', min(20), 'cliente');
// 2. atendente respondeu por último → respondida
conversa({ chave: 'c2', modo: 'humano', atendente: 'Joana', ultima: min(5) });
evento('c2', min(20), 'cliente'); evento('c2', min(5), 'atendente');
// 3. só com a IA → não conta
conversa({ chave: 'c3', ultima: min(29) });
evento('c3', min(30), 'cliente'); evento('c3', min(29), 'ia');
// 4. IA transferiu há 35 min e ninguém assumiu → espera
conversa({ chave: 'c4', transfer: true, push: 'Pedro', ultima: min(35) });
evento('c4', min(40), 'cliente'); evento('c4', min(35), 'tool', null, 'transferir_para_atendente'); evento('c4', min(35), 'ia');
// 5. transferida, assumida e devolvida para a IA (pendingTransfer ficou true) → não conta
conversa({ chave: 'c5', transfer: true, ultima: min(39) });
evento('c5', min(60), 'tool', null, 'transferir_para_atendente');
evento('c5', min(55), 'sistema', 'Maria assumiu a conversa — IA pausada');
evento('c5', min(50), 'atendente');
evento('c5', min(45), 'sistema', 'Maria devolveu para a IA');
evento('c5', min(40), 'cliente'); evento('c5', min(39), 'ia');
// 6. encerrada → fora
conversa({ chave: 'c6', modo: 'humano', atendente: 'Joana', encerrada: 1, ultima: min(30) });
evento('c6', min(30), 'cliente');
// 7. parada há 13 h → fora (como as de 20 h a 48 h vistas no banco real)
conversa({ chave: 'c7', modo: 'humano', atendente: 'Joana', ultima: min(13 * 60) });
evento('c7', min(13 * 60), 'cliente');
// 8. assumida, nenhuma mensagem trocada → sem mensagem, ignorada
conversa({ chave: 'c8', modo: 'humano', atendente: 'Joana', ultima: min(10) });
evento('c8', min(10), 'sistema', 'Joana assumiu a conversa — IA pausada');
// 9. cliente esperando há só 5 min → aguardando, abaixo do limite
conversa({ chave: 'c9', modo: 'humano', atendente: 'Ana', ultima: min(5) });
evento('c9', min(5), 'cliente');

async function main() {
  console.log('\n─── Leitura do banco do ura-chat ───');
  const { conversas, ignoradas } = lerConversasDoChat(new Date(AGORA), ARQ);
  const sit = Object.fromEntries(conversas.map((c) => [c.jid, c.situacao]));
  checa('atendente com cliente por último → aguardando_resposta', sit.c1 === 'aguardando_resposta', sit);
  checa('atendente respondeu → respondida', sit.c2 === 'respondida', sit);
  checa('só IA → com_ia (não conta)', sit.c3 === 'com_ia', sit);
  checa('transferida sem ninguém assumir → aguardando_assumir', sit.c4 === 'aguardando_assumir', sit);
  checa('assumida e devolvida (pendingTransfer velho) → com_ia', sit.c5 === 'com_ia', sit);
  checa('encerrada e parada há 13 h ficam de fora', !('c6' in sit) && !('c7' in sit), sit);
  checa('assumida sem mensagem é ignorada', !('c8' in sit) && ignoradas === 1, { sit, ignoradas });
  const c4 = conversas.find((c) => c.jid === 'c4')!;
  checa('espera da transferência conta da hora da transferência', c4.ultimaEm!.getTime() === min(35));
  const c1 = conversas.find((c) => c.jid === 'c1')!;
  checa('nome do cadastro vence o nome do WhatsApp', c1.nome === 'MARIA CLIENTE');
  checa('responsável é a atendente', c1.setor === 'Joana');

  console.log('\n─── Ciclo do monitor ───');
  definir('monitor.sla.fonte', 'chat', 'teste');
  definir('monitor.sla.minutos', 15, 'teste');
  definir('monitor.sla.horario_inicio', '', 'teste');
  definir('monitor.sla.horario_fim', '', 'teste');

  let r = await cicloSla();
  const alertas = () => db().prepare(`SELECT * FROM alerta WHERE origem = 'sla' ORDER BY criado_em`).all() as Array<{ chave: string; titulo: string; texto: string; resolvido_em: string | null }>;
  let a = alertas();
  checa('dois alertas: c1 (20 min) e c4 (35 min)', r.alertas === 2 && a.length === 2, { r, chaves: a.map((x) => x.chave) });
  checa('c9 aguarda mas abaixo do limite: conta, não alerta', r.detalhe.aguardando === 3, r.detalhe);
  const a4 = a.find((x) => x.chave.startsWith('sla:c4:'));
  checa('transferência sem dono tem texto próprio', !!a4 && /ninguém assumiu/.test(a4.texto) && /Transferido às/.test(a4.texto), a4?.texto);
  const a1 = a.find((x) => x.chave.startsWith('sla:c1:'));
  checa('espera com atendente mostra quem está com ela', !!a1 && /Com: Joana/.test(a1.texto), a1?.texto);
  checa('detalhe informa a fonte', r.detalhe.fonte === 'chat');

  r = await cicloSla();
  checa('segundo ciclo não repete alerta', r.alertas === 0 && alertas().length === 2, r);

  console.log('\n─── Resolução ───');
  evento('c1', AGORA - 1000, 'atendente');
  r = await cicloSla();
  a = alertas();
  checa('atendente respondeu → alerta do c1 resolvido', !!a.find((x) => x.chave.startsWith('sla:c1:'))?.resolvido_em, r.detalhe);

  chat.prepare(`UPDATE conversas SET encerrada = 1 WHERE chave = 'c4'`).run();
  r = await cicloSla();
  a = alertas();
  checa('conversa encerrada → alerta resolvido', !!a.find((x) => x.chave.startsWith('sla:c4:'))?.resolvido_em);
  checa('e sai da fila de "aguardando agora"', r.detalhe.sairam_da_fila === 1 &&
    !(db().prepare(`SELECT aguardando_desde FROM sla_conversa WHERE jid = 'c4'`).get() as { aguardando_desde: string | null }).aguardando_desde, r.detalhe);

  console.log('\n─── Diagnóstico ───');
  const diag = await diagnosticoSla();
  const texto = JSON.stringify(diag);
  checa('não expõe nome de cliente nem de atendente', !/MARIA|Mari|Pedro|Joana|Ana\b/.test(texto), texto);
  checa('mostra a contagem por situação', typeof diag.por_situacao === 'object' && diag.fonte === 'chat', diag);

  console.log('\n─── Banco ausente ───');
  (config.chatAtendimento as { dbPath: string }).dbPath = path.join(dir, 'nao-existe.db');
  try {
    await cicloSla();
    checa('banco ausente faz o ciclo falhar (não vira "ninguém esperando")', false);
  } catch (err) {
    checa('banco ausente faz o ciclo falhar com o caminho', /não encontrado.*nao-existe\.db/.test(String(err)), String(err));
  }
  checa('não cria o arquivo ao tentar abrir', !fs.existsSync(path.join(dir, 'nao-existe.db')));

  chat.close();
  fecharDb();
  console.log(`\n${passou} passaram, ${falhou} falharam\n`);
  process.exit(falhou ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
