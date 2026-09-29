// Testes de roteamento, SLA do incidente e escalonamento por tempo.
//
//   npm run test:escalonamento

import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import type { AddressInfo } from 'net';

for (const k of ['OPENAI_API_KEY', 'SGP_BASE_URL', 'SGP_TOKEN']) {
  process.env[k] ||= 'teste-escalonamento-sem-uso';
}
process.env.TZ ||= 'America/Fortaleza';
const RAIZ = __dirname;
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'aq-escal-')));

/* eslint-disable @typescript-eslint/no-var-requires */
const { db, fecharDb } = require(path.join(RAIZ, 'src', 'assistant', 'store', 'db')) as typeof import('./src/assistant/store/db');
const pl = require(path.join(RAIZ, 'src', 'assistant', 'plantao')) as typeof import('./src/assistant/plantao');
const inc = require(path.join(RAIZ, 'src', 'assistant', 'incidentes')) as typeof import('./src/assistant/incidentes');
const alertas = require(path.join(RAIZ, 'src', 'assistant', 'alertas')) as typeof import('./src/assistant/alertas');
const rot = require(path.join(RAIZ, 'src', 'assistant', 'roteamento')) as typeof import('./src/assistant/roteamento');
const sla = require(path.join(RAIZ, 'src', 'assistant', 'sla-incidente')) as typeof import('./src/assistant/sla-incidente');
const dest = require(path.join(RAIZ, 'src', 'assistant', 'destinos-alerta')) as typeof import('./src/assistant/destinos-alerta');
const cfg = require(path.join(RAIZ, 'src', 'assistant', 'config-dinamica')) as typeof import('./src/assistant/config-dinamica');
const { evoTecnicos } = require(path.join(RAIZ, 'src', 'assistant', 'channels', 'whatsapp-tecnicos')) as typeof import('./src/assistant/channels/whatsapp-tecnicos');
const { parseRecibo } = require(path.join(RAIZ, 'src', 'integrations', 'evolution')) as typeof import('./src/integrations/evolution');
const { rotasAdmin } = require(path.join(RAIZ, 'src', 'assistant', 'rotas-admin')) as typeof import('./src/assistant/rotas-admin');
const { rotasOperacao } = require(path.join(RAIZ, 'src', 'assistant', 'rotas-operacao')) as typeof import('./src/assistant/rotas-operacao');
const { ErroHttp } = require(path.join(RAIZ, 'src', 'assistant', 'http-util')) as typeof import('./src/assistant/http-util');
/* eslint-enable @typescript-eslint/no-var-requires */

let passou = 0;
let falhou = 0;
function checa(rotulo: string, ok: boolean, detalhe: unknown = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${rotulo}${ok || detalhe === '' ? '' : `\n      ${typeof detalhe === 'string' ? detalhe : JSON.stringify(detalhe).slice(0, 500)}`}`);
  ok ? passou++ : falhou++;
}
function erroDe(fn: () => unknown): string {
  try { fn(); return ''; } catch (e) { return (e as Error).message; }
}

let proximoId = 0;
const enviados: Array<{ para: string; texto: string; id: string }> = [];
Object.defineProperty(evoTecnicos, 'disponivel', { get: () => true });
(evoTecnicos as any).enviarTextoComId = async (para: string, texto: string) => {
  const id = `MSG${++proximoId}`;
  enviados.push({ para, texto, id });
  return { ok: true, id };
};
(evoTecnicos as any).enviarTexto = async (para: string, texto: string) =>
  (await (evoTecnicos as any).enviarTextoComId(para, texto)).ok;

const servidor = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  rotasAdmin(req, res, url, url.pathname)
    .then((t) => (t ? true : rotasOperacao(req, res, url, url.pathname)))
    .then((t) => { if (!t) { res.writeHead(404); res.end(); } })
    .catch((err) => {
      res.writeHead(err instanceof ErroHttp ? err.status : 500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    });
});
let BASE = '';
async function api(metodo: string, caminho: string, corpo?: unknown) {
  const r = await fetch(`${BASE}${caminho}`, {
    method: metodo, headers: { 'Content-Type': 'application/json', 'x-operador': 'ana' },
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
  });
  const t = await r.text();
  let j: any = null;
  try { j = JSON.parse(t); } catch { j = t; }
  return { status: r.status, j };
}

function pessoa(nome: string, numero: string): number {
  return Number(db().prepare(
    `INSERT INTO alerta_destino (nome, numero, tipos, severidade_minima, ativo, criado_em) VALUES (?,?,?,?,1,?)`,
  ).run(nome, numero, JSON.stringify(['rede']), 'aviso', new Date().toISOString()).lastInsertRowid);
}

/** Empurra o incidente para trás no tempo, para o prazo vencer sem esperar. */
function envelhecer(id: string, minutos: number): void {
  const novo = new Date(Date.now() - minutos * 60_000).toISOString();
  db().prepare(`UPDATE incidente SET aberto_em = ? WHERE id = ?`).run(novo, id);
}

async function main(): Promise<void> {
  db();
  await new Promise<void>((r) => servidor.listen(0, '127.0.0.1', r));
  BASE = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;

  const ana = pessoa('Ana', '5585900000001@s.whatsapp.net');
  const bruno = pessoa('Bruno', '5585900000002@s.whatsapp.net');
  const supervisora = pessoa('Sara', '5585900000003@s.whatsapp.net');
  const gerente = pessoa('Gil', '5585900000009@s.whatsapp.net');
  db().prepare(`INSERT INTO equipe (id, nome, fontes, ativo, criado_em) VALUES ('noc','NOC',NULL,1,?)`).run(new Date().toISOString());
  pl.criarEscala({
    equipe_id: 'noc', nome: 'Integral', tipo: 'fixa', dias: [0, 1, 2, 3, 4, 5, 6],
    hora_inicio: '00:00', hora_fim: '00:00', pessoas: [ana],
  }, 'teste');
  pl.atualizarEquipe('noc', { supervisor_id: supervisora, substituto_id: bruno }, 'teste');
  cfg.definir('plantao.gerencia', [String(gerente)], 'teste');
  cfg.definir('alertas.destino_grupo', '12345@g.us', 'teste');

  console.log('\n─── Prazos do SLA ───');
  checa('cada severidade tem os três prazos', sla.listarRegras().length === 6 && sla.listarRegras().every((r) => r.reconhecer_min > 0));
  checa('quanto pior, menos tempo',
    sla.regraDe('desastre').reconhecer_min < sla.regraDe('critico').reconhecer_min
    && sla.regraDe('critico').reconhecer_min < sla.regraDe('atencao').reconhecer_min);
  checa('atender não pode vencer antes de reconhecer',
    /antes de reconhecer/.test(erroDe(() => sla.salvarRegra('critico', { reconhecer_min: 30, atender_min: 10 }, 'teste'))));
  checa('resolver não pode vencer antes de atender',
    /antes de atender/.test(erroDe(() => sla.salvarRegra('critico', { atender_min: 100, resolver_min: 50 }, 'teste'))));
  checa('minuto fora da faixa é recusado',
    /1 a 10080/.test(erroDe(() => sla.salvarRegra('critico', { reconhecer_min: 0 }, 'teste'))));
  checa('severidade inexistente é recusada',
    /severidade inválida/.test(erroDe(() => sla.salvarRegra('gravissimo', { reconhecer_min: 5 }, 'teste'))));
  sla.salvarRegra('critico', { reconhecer_min: 15, atender_min: 30, resolver_min: 240 }, 'teste');
  checa('regra editada fica salva', sla.regraDe('critico').reconhecer_min === 15);

  console.log('\n─── Roteamento por gravidade ───');
  cfg.definir('roteamento.canais_info', ['grupo'], 'teste');
  cfg.definir('roteamento.canais_critico', ['grupo', 'pessoas', 'plantao'], 'teste');
  let alvos = rot.alvosDoAlerta({ origem: 'zabbix', chave: 'x:1', severidade: 'info', dados: {} });
  checa('informativo fica só no grupo', alvos.length === 1 && alvos[0].origem === 'grupo', alvos);
  alvos = rot.alvosDoAlerta({ origem: 'zabbix', chave: 'x:2', severidade: 'critico', dados: {} });
  checa('crítico vai para grupo, pessoas e plantão',
    alvos.some((a) => a.origem === 'grupo') && alvos.some((a) => a.origem === 'pessoas') && alvos.some((a) => a.origem === 'plantao'), alvos);
  checa('ninguém aparece duas vezes', new Set(alvos.map((a) => a.jid)).size === alvos.length);
  cfg.definir('alertas.destino_grupo', '', 'teste');
  cfg.definir('roteamento.canais_critico', [], 'teste');
  alvos = rot.alvosDoAlerta({ origem: 'zabbix', chave: 'x:3', severidade: 'critico', dados: {} });
  checa('crítico que ficaria sem ninguém cai na gerência',
    alvos.length === 1 && alvos[0].rotulo === 'Gil', alvos);
  cfg.definir('roteamento.critico_nunca_sem_destino', false, 'teste');
  checa('desligada a garantia, crítico sem destino fica sem destino mesmo',
    rot.alvosDoAlerta({ origem: 'zabbix', chave: 'x:4', severidade: 'critico', dados: {} }).length === 0);
  cfg.definir('roteamento.critico_nunca_sem_destino', true, 'teste');
  cfg.definir('roteamento.canais_critico', ['grupo', 'pessoas', 'plantao'], 'teste');
  cfg.definir('alertas.destino_grupo', '12345@g.us', 'teste');
  cfg.definir('roteamento.ativo', false, 'teste');
  alvos = rot.alvosDoAlerta({ origem: 'zabbix', chave: 'x:5', severidade: 'info', dados: {} });
  checa('roteamento desligado volta ao comportamento antigo (grupo e pessoas)',
    alvos.some((a) => a.origem === 'grupo') && !alvos.some((a) => a.origem === 'plantao'), alvos);
  cfg.definir('roteamento.ativo', true, 'teste');

  console.log('\n─── Entrega: enviado, entregue, visto, reconhecido ───');
  enviados.length = 0;
  const a1 = (await alertas.emitir({
    origem: 'zabbix', severidade: 'critico', titulo: 'OLT 1 fora', texto: 'OLT 1 fora',
    chave: 'zabbix:olt1', dados: { host: 'OLT-1' },
  }))!;
  let envios = dest.enviosDoAlerta(a1.id);
  checa('cada destino vira uma linha de envio', envios.length === enviados.length && envios.length >= 2, envios.length);
  checa('a linha nasce como enviado, com o id da mensagem',
    envios.every((e) => e.estado === 'enviado' && !!e.mensagem_id));
  checa('a linha guarda de onde veio o destino', envios.some((e) => e.motivo === 'plantao'), envios.map((e) => e.motivo));
  dest.marcarRecibo(envios[0].mensagem_id!, 'entregue');
  checa('recibo de entrega muda o estado', dest.enviosDoAlerta(a1.id)[0].estado === 'entregue');
  dest.marcarRecibo(envios[0].mensagem_id!, 'visualizado');
  checa('leitura muda para visualizado', dest.enviosDoAlerta(a1.id)[0].estado === 'visualizado');
  dest.marcarRecibo(envios[0].mensagem_id!, 'entregue');
  checa('recibo atrasado não rebaixa quem já viu', dest.enviosDoAlerta(a1.id)[0].estado === 'visualizado');
  checa('recibo de mensagem desconhecida não quebra', dest.marcarRecibo('NAO-EXISTE', 'entregue') === false);
  checa('o webhook do WhatsApp vira recibo',
    parseRecibo({ event: 'messages.update', data: { keyId: 'MSG1', status: 'READ' } })?.estado === 'visualizado');
  checa('status sem valor de recibo é ignorado',
    parseRecibo({ event: 'messages.update', data: { keyId: 'MSG1', status: 'PENDING' } }) === null);
  checa('mensagem nova não é recibo', parseRecibo({ event: 'messages.upsert', data: { key: { id: 'X' } } }) === null);

  const inc1 = inc.listar({ abertos: true })[0];
  inc.assumir(inc1.id, 'Ana');
  checa('assumir marca todos os envios como reconhecido',
    dest.enviosDoAlerta(a1.id).every((e) => e.estado === 'reconhecido' && !!e.reconhecido_em));

  console.log('\n─── Relógio do incidente ───');
  const s1 = sla.situacao(inc.porId(inc1.id)!);
  checa('os três marcos aparecem', s1.marcos.length === 3);
  checa('reconhecer já está cumprido', !!s1.marcos.find((m) => m.marco === 'reconhecer')!.cumprido_em);
  checa('quem cumpriu no prazo não conta violação', s1.violados.length === 0, s1.violados);
  inc.mudarEstado(inc1.id, 'atendimento', 'Ana');
  checa('entrar em atendimento carimba o marco', !!inc.porId(inc1.id)!.atendido_em);
  checa('e o SLA passa a mostrar atender como cumprido',
    !!sla.situacao(inc.porId(inc1.id)!).marcos.find((m) => m.marco === 'atender')!.cumprido_em);

  const a2 = (await alertas.emitir({
    origem: 'zabbix', severidade: 'critico', titulo: 'OLT 2 fora', texto: 'OLT 2 fora',
    chave: 'zabbix:olt2', dados: { host: 'OLT-2' },
  }))!;
  const inc2 = inc.listar({ abertos: true }).find((i) => i.titulo === 'OLT 2 fora')!;
  envelhecer(inc2.id, 40);
  const s2 = sla.situacao(inc.porId(inc2.id)!);
  checa('sem ninguém, o prazo de reconhecer estoura', s2.violados.includes('reconhecer'), s2.violados);
  checa('o tempo que falta vira negativo', s2.marcos[0].restante_seg < 0);
  const novos = sla.registrarViolacoes(inc.porId(inc2.id)!);
  const linhasSla = () => inc.linhaDoTempo(inc2.id).filter((l) => l.tipo === 'sla').length;
  checa('a violação entra na linha do tempo', novos.includes('reconhecer') && linhasSla() === novos.length, novos);
  const antesDeRepetir = linhasSla();
  checa('rodar de novo não duplica a violação',
    sla.registrarViolacoes(inc.porId(inc2.id)!).length === 0 && linhasSla() === antesDeRepetir);
  sla.salvarRegra('critico', { ativo: false }, 'teste');
  checa('regra desligada não gera violação', sla.situacao(inc.porId(inc2.id)!).violados.length === 0);
  sla.salvarRegra('critico', { ativo: true }, 'teste');

  console.log('\n─── Escalonamento degrau a degrau ───');
  enviados.length = 0;
  cfg.definir('escalonamento.intervalo_min', 5, 'teste');
  let subiram = await alertas.escalarPendentes();
  checa('quem estourou o prazo sobe um degrau', subiram === 1, subiram);
  let atual = inc.porId(inc2.id)!;
  checa('o incidente guarda em que degrau está', atual.degrau === 1 && !!atual.escalonado_em);
  checa('o primeiro degrau é o plantonista', enviados.some((e) => e.para.includes('5585900000001')), enviados.map((e) => e.para));
  checa('a mensagem diz o atraso e como assumir',
    /sem reconhecimento/.test(enviados[0].texto) && /assumir INC-/.test(enviados[0].texto), enviados[0]?.texto);
  checa('a subida fica na linha do tempo',
    inc.linhaDoTempo(inc2.id).some((l) => l.tipo === 'escalonado' && /Plantonista/.test(l.texto)));

  checa('não sobe dois degraus no mesmo minuto', (await alertas.escalarPendentes()) === 0);
  db().prepare(`UPDATE incidente SET escalonado_em = ? WHERE id = ?`)
    .run(new Date(Date.now() - 10 * 60_000).toISOString(), inc2.id);
  enviados.length = 0;
  await alertas.escalarPendentes();
  atual = inc.porId(inc2.id)!;
  checa('passado o intervalo, sobe para o substituto', atual.degrau === 2 && enviados.some((e) => e.para.includes('5585900000002')), enviados.map((e) => e.para));
  db().prepare(`UPDATE incidente SET escalonado_em = ? WHERE id = ?`)
    .run(new Date(Date.now() - 10 * 60_000).toISOString(), inc2.id);
  enviados.length = 0;
  await alertas.escalarPendentes();
  checa('depois vai para o supervisor', inc.porId(inc2.id)!.degrau === 3 && enviados.some((e) => e.para.includes('5585900000003')));

  inc.assumir(inc2.id, 'Bruno');
  db().prepare(`UPDATE incidente SET escalonado_em = ? WHERE id = ?`)
    .run(new Date(Date.now() - 60 * 60_000).toISOString(), inc2.id);
  checa('incidente com dono para de escalar', (await alertas.escalarPendentes()) === 0);

  const a3 = (await alertas.emitir({
    origem: 'zabbix', severidade: 'critico', titulo: 'OLT 3 fora', texto: 'OLT 3 fora',
    chave: 'zabbix:olt3', dados: { host: 'OLT-3' },
  }))!;
  const inc3 = inc.listar({ abertos: true }).find((i) => i.titulo === 'OLT 3 fora')!;
  envelhecer(inc3.id, 40);
  cfg.definir('escalonamento.ativo', false, 'teste');
  checa('escalonamento desligado não sobe nada', (await alertas.escalarPendentes()) === 0);
  cfg.definir('escalonamento.ativo', true, 'teste');
  cfg.definir('escalonamento.max_degraus', 1, 'teste');
  await alertas.escalarPendentes();
  db().prepare(`UPDATE incidente SET escalonado_em = ? WHERE id = ?`)
    .run(new Date(Date.now() - 60 * 60_000).toISOString(), inc3.id);
  checa('o teto de degraus é respeitado',
    (await alertas.escalarPendentes()) === 0 && inc.porId(inc3.id)!.degrau === 1);
  cfg.definir('escalonamento.max_degraus', 5, 'teste');
  checa('a cadeia do incidente sai da equipe dele',
    rot.cadeiaDoIncidente(inc.porId(inc3.id)!)[0].nivel === 'plantonista');
  void a2; void a3;

  console.log('\n─── Rotas ───');
  let r = await api('GET', '/api/sla');
  checa('painel lê as regras de SLA', r.status === 200 && r.j.regras.length === 6);
  r = await api('PUT', '/api/sla/maior', { reconhecer_min: 7, atender_min: 14, resolver_min: 90 });
  checa('painel edita a regra', r.status === 200 && r.j.regra.reconhecer_min === 7);
  r = await api('PUT', '/api/sla/maior', { reconhecer_min: 900 });
  checa('regra incoerente devolve 400 com motivo', r.status === 400 && /antes de reconhecer/.test(r.j.error), r.j);
  r = await api('GET', '/api/incidentes?abertos=1');
  checa('a lista de incidentes traz o relógio', r.status === 200 && !!r.j.incidentes[0].sla.marcos);
  r = await api('GET', `/api/incidentes/${inc3.numero}`);
  checa('o detalhe traz SLA, cadeia e entregas',
    r.status === 200 && !!r.j.sla && Array.isArray(r.j.cadeia) && Array.isArray(r.j.entregas), Object.keys(r.j));
  checa('as entregas mostram para quem foi e em que estado',
    r.j.entregas.length > 0 && r.j.entregas.every((e: any) => !!e.estado));

  servidor.close();
  fecharDb();
  console.log(`\n${passou} passaram, ${falhou} falharam\n`);
  process.exit(falhou ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
