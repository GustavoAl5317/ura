// Testes da ferramenta de atendimento dos clientes (banco do ura-chat, só leitura).
//
//   npm run test:atendimento

import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';

for (const k of ['OPENAI_API_KEY', 'SGP_BASE_URL', 'SGP_TOKEN']) {
  process.env[k] ||= 'teste-atendimento-sem-uso';
}
const RAIZ = __dirname;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aq-atendimento-'));
process.chdir(dir);
const ARQ = path.join(dir, 'atendimento.db');
process.env.CHAT_DB_PATH = ARQ;

/* eslint-disable @typescript-eslint/no-var-requires */
const t = require(path.join(RAIZ, 'src', 'assistant', 'tools', 'atendimento')) as typeof import('./src/assistant/tools/atendimento');
const { ferramentas } = require(path.join(RAIZ, 'src', 'assistant', 'tools', 'base')) as typeof import('./src/assistant/tools/base');
const { localParaUtc, partesLocais } = require(path.join(RAIZ, 'src', 'assistant', 'datas')) as typeof import('./src/assistant/datas');
/* eslint-enable @typescript-eslint/no-var-requires */

let passou = 0;
let falhou = 0;
function checa(rotulo: string, ok: boolean, detalhe: unknown = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${rotulo}${ok || detalhe === '' ? '' : `\n      ${typeof detalhe === 'string' ? detalhe : JSON.stringify(detalhe).slice(0, 700)}`}`);
  ok ? passou++ : falhou++;
}

const chat = new Database(ARQ);
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

const AGORA = new Date();
const p = partesLocais(AGORA);
const HOJE = localParaUtc(+p.year, +p.month, +p.day, 0, 0, 0).getTime();
const ONTEM = HOJE - 86400_000;
// Evento "hoje" sempre antes de agora: a partir da meia-noite local + minutos, limitado a agora.
const hoje = (min: number) => Math.min(HOJE + min * 60_000, AGORA.getTime() - 60_000);
const minAtras = (m: number) => AGORA.getTime() - m * 60_000;

const conv = chat.prepare(`INSERT INTO conversas (chave, numero, push_name, cliente_nome, modo, atendente_nome, iniciada_em, ultima_atividade, ctx_json) VALUES (?,?,?,?,?,?,?,?,?)`);
const ev = chat.prepare(`INSERT INTO eventos (conversa, ts, tipo, texto, autor, tool_name) VALUES (?,?,?,?,?,?)`);

// Maria: só IA hoje (2 mensagens).
conv.run('maria', '1', 'Maria', null, 'ia', null, hoje(1), hoje(3), '{}');
ev.run('maria', hoje(1), 'cliente', 'oi', null, null);
ev.run('maria', hoje(2), 'ia', 'olá', null, null);
ev.run('maria', hoje(3), 'cliente', 'obrigada', null, null);
// João: transferido e atendido pela Carla hoje; última mensagem dele, esperando resposta há 20 min.
conv.run('joao', '2', 'João', 'JOAO DA SILVA', 'humano', 'Carla', ONTEM + 3600_000, minAtras(20), '{}');
ev.run('joao', hoje(1), 'cliente', 'sem internet', null, null);
ev.run('joao', hoje(1), 'tool', null, null, 'transferir_para_atendente');
ev.run('joao', hoje(1), 'atendente', 'vou ver', 'Carla', null);
ev.run('joao', minAtras(20), 'cliente', 'e aí?', null, null);
// Pedro: pediu transferência há 8 min e ninguém assumiu.
conv.run('pedro', '3', 'Pedro', null, 'ia', null, minAtras(9), minAtras(8), JSON.stringify({ pendingTransfer: true }));
ev.run('pedro', minAtras(9), 'cliente', 'quero atendente', null, null);
ev.run('pedro', minAtras(8), 'tool', null, null, 'transferir_para_atendente');
// Ana: só ontem.
conv.run('ana', '4', 'Ana', null, 'ia', null, ONTEM + 7200_000, ONTEM + 7300_000, '{}');
ev.run('ana', ONTEM + 7200_000, 'cliente', 'boleto', null, null);
ev.run('ana', ONTEM + 7250_000, 'atendente', 'segue', 'Bruno', null);

async function main() {
  console.log('\n─── Janela ───');
  const j = t.janelaAtendimento({}, AGORA);
  checa('hoje começa à meia-noite local', j.inicio.getTime() === HOJE && /hoje/.test(j.rotulo), j);
  const o = t.janelaAtendimento({ periodo: 'ontem' }, AGORA);
  checa('ontem é o dia inteiro anterior', o.inicio.getTime() === ONTEM && o.fim.getTime() === HOJE, o);
  const s = t.janelaAtendimento({ dias: 7 }, AGORA);
  checa('últimos 7 dias contando hoje', s.inicio.getTime() === HOJE - 6 * 86400_000, { inicio: s.inicio, esperado: new Date(HOJE - 6 * 86400_000) });

  console.log('\n─── Contagens de hoje ───');
  const r = t.resumoAtendimento(ARQ, new Date(HOJE), AGORA);
  checa('3 clientes mandaram mensagem hoje (Ana foi ontem)', r.clientes_que_mandaram_mensagem === 3, r);
  checa('5 mensagens de clientes', r.mensagens_de_clientes === 5, r);
  checa('2 conversas novas hoje (João começou ontem)', r.conversas_novas === 2, r);
  checa('2 transferidas', r.transferidas_para_atendente === 2, r);
  checa('1 atendida por atendente', r.atendidas_por_atendente === 1, r);
  checa('2 sem atendente (Maria e Pedro)', r.resolvidas_so_pela_ia === 2, r);
  checa('por atendente', r.por_atendente.length === 1 && r.por_atendente[0].atendente === 'Carla', r.por_atendente);
  checa('pico por hora', !!r.horario_de_pico && r.mensagens_por_hora.reduce((a, x) => a + x.mensagens, 0) === 5, r.mensagens_por_hora);

  const ro = t.resumoAtendimento(ARQ, new Date(ONTEM), new Date(HOJE));
  checa('ontem: só Ana, atendida pelo Bruno', ro.clientes_que_mandaram_mensagem === 1 && ro.por_atendente[0]?.atendente === 'Bruno', ro);

  console.log('\n─── Ferramenta ───');
  t.registrarFerramentasAtendimento();
  let n = 0;
  const ctx = { proximoId: () => `evd_${++n}`, usuario: 'teste', fontesPermitidas: null };
  const [e] = await ferramentas.get('atendimento_whatsapp')!.executar({}, ctx);
  const d = e.dados as any;
  checa('responde com fonte whatsapp', e.ok && e.fonte === 'whatsapp', e);
  checa('esperando agora: João e Pedro', d.esperando_agora.total === 2, d.esperando_agora);
  checa('separa quem aguarda assumir de quem aguarda resposta',
    d.esperando_agora.aguardando_atendente_assumir === 1 && d.esperando_agora.aguardando_resposta_do_atendente === 1, d.esperando_agora);
  checa('mais antigo primeiro, com nome do cadastro e minutos', d.esperando_agora.mais_antigos[0].cliente === 'JOAO DA SILVA' && d.esperando_agora.mais_antigos[0].espera_min === 20, d.esperando_agora.mais_antigos);
  checa('horários em -03:00', /-03:00$/.test(d.inicio), d.inicio);

  const semPermissao = await ferramentas.get('atendimento_whatsapp')!.executar({}, { ...ctx, fontesPermitidas: ['zabbix'] as any });
  checa('sem acesso à fonte whatsapp: bloqueada', !semPermissao[0].ok && /bloqueada/.test(semPermissao[0].erro ?? ''), semPermissao[0]);

  const antes = fs.statSync(ARQ).mtimeMs;
  await ferramentas.get('atendimento_whatsapp')!.executar({ periodo: 'ontem' }, ctx);
  checa('não escreve no banco do ura-chat', fs.statSync(ARQ).mtimeMs === antes);

  process.env.CHAT_DB_PATH = path.join(dir, 'nao-existe.db');
  const { config } = require(path.join(RAIZ, 'src', 'config')) as typeof import('./src/config');
  (config.chatAtendimento as { dbPath: string }).dbPath = path.join(dir, 'nao-existe.db');
  const [falta] = await ferramentas.get('atendimento_whatsapp')!.executar({}, ctx);
  checa('banco ausente = fonte indisponível, não "0 clientes"', !falta.ok && /não encontrado/.test(falta.erro ?? ''), falta);

  console.log('\n─── Chamadas da URA ───');
  const { db } = require(path.join(RAIZ, 'src', 'assistant', 'store', 'db')) as typeof import('./src/assistant/store/db');
  const [vaziaUra] = await ferramentas.get('chamadas_ura')!.executar({}, ctx);
  checa('sem nenhuma chamada registrada: diz que a ponte não enviou, não "0 chamadas"', !vaziaUra.ok && /ponte da URA/.test(vaziaUra.erro ?? ''), vaziaUra);
  const insUra = db().prepare(`INSERT INTO chamada_ura (call_id, numero, cliente_nome, contrato_id, intencao, status, iniciada_em, duracao_seg, atualizada_em) VALUES (?,?,?,?,?,?,?,?,?)`);
  const iso = (ms: number) => new Date(ms).toISOString();
  insUra.run('c1', '85988887777', 'JOAO DA SILVA', 3351, 'suporte técnico', 'encerrada', iso(hoje(2)), 120, iso(hoje(2)));
  insUra.run('c2', '85988887777', 'JOAO DA SILVA', 3351, 'suporte técnico', 'transferida', iso(hoje(4)), 300, iso(hoje(4)));
  insUra.run('c3', '85911112222', null, null, null, 'em_andamento', iso(minAtras(1)), null, iso(minAtras(1)));
  insUra.run('c4', '85933334444', 'ANA', 10, 'financeiro', 'encerrada', iso(ONTEM + 3600_000), 60, iso(ONTEM + 3600_000));
  const [u] = await ferramentas.get('chamadas_ura')!.executar({}, ctx);
  const du = u.dados as any;
  checa('3 chamadas hoje (a de ontem fica de fora)', u.ok && du.chamadas === 3, du);
  checa('status separados', du.em_andamento === 1 && du.encerradas === 1 && du.transferidas_para_atendente === 1, du);
  checa('identificados x não identificados', du.clientes_identificados === 2 && du.nao_identificados === 1, du);
  checa('por intenção, com "não identificada"', du.por_intencao[0].nome === 'suporte técnico' && du.por_intencao[0].n === 2 && du.por_intencao.some((x: any) => x.nome === 'não identificada'), du.por_intencao);
  checa('quem ligou mais de uma vez', du.numeros_que_ligaram_mais_de_uma_vez[0]?.numero === '85988887777' && du.numeros_que_ligaram_mais_de_uma_vez[0].chamadas === 2, du.numeros_que_ligaram_mais_de_uma_vez);
  checa('duração média só das que têm duração', du.duracao_media_seg === 210, du.duracao_media_seg);
  checa('última primeiro, com horário local', du.ultimas[0].status === 'em_andamento' && /-03:00$/.test(du.ultimas[0].inicio), du.ultimas[0]);
  insUra.run('c5', '85955556666', null, null, null, 'em_andamento', iso(minAtras(180)), null, iso(minAtras(180)));
  const [u72] = await ferramentas.get('chamadas_ura')!.executar({ horas: 4 }, ctx);
  checa('em andamento há 3 h vira "sem aviso de encerramento"', (u72.dados as any).sem_aviso_de_encerramento === 1 && (u72.dados as any).em_andamento === 1, u72.dados);
  db().prepare(`DELETE FROM chamada_ura WHERE call_id = 'c5'`).run();
  const [uo] = await ferramentas.get('chamadas_ura')!.executar({ periodo: 'ontem' }, ctx);
  checa('ontem: 1 chamada financeira', (uo.dados as any).chamadas === 1 && (uo.dados as any).por_intencao[0].nome === 'financeiro', uo.dados);
  const [uh] = await ferramentas.get('chamadas_ura')!.executar({ horas: 72 }, ctx);
  checa('últimas 72 horas pega as 4', (uh.dados as any).chamadas === 4, uh.dados);
  const cfgDin = require(path.join(RAIZ, 'src', 'assistant', 'config-dinamica')) as typeof import('./src/assistant/config-dinamica');
  cfgDin.definir('monitor.ura.ativo', false, 'teste');
  const [desl] = await ferramentas.get('chamadas_ura')!.executar({}, ctx);
  checa('monitor desligado = fonte indisponível com motivo', !desl.ok && /desligado/.test(desl.erro ?? ''), desl);

  chat.close();
  console.log(`\n${passou} passaram, ${falhou} falharam\n`);
  process.exit(falhou ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
