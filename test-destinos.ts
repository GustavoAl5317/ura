// Testes de "quem recebe alertas": filtro por tipo e gravidade, envio junto
// com o grupo, falha parcial, silêncio, rotas do painel e auditoria.
// WhatsApp é dublê; banco temporário.
//
//   npm run test:destinos

import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import type { AddressInfo } from 'net';

for (const k of ['OPENAI_API_KEY', 'SGP_BASE_URL', 'SGP_TOKEN']) {
  process.env[k] ||= 'teste-destinos-sem-uso';
}
const RAIZ = __dirname;
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'aq-destinos-')));

/* eslint-disable @typescript-eslint/no-var-requires */
const { db, fecharDb } = require(path.join(RAIZ, 'src', 'assistant', 'store', 'db')) as typeof import('./src/assistant/store/db');
const alertas = require(path.join(RAIZ, 'src', 'assistant', 'alertas')) as typeof import('./src/assistant/alertas');
const dest = require(path.join(RAIZ, 'src', 'assistant', 'destinos-alerta')) as typeof import('./src/assistant/destinos-alerta');
const cfg = require(path.join(RAIZ, 'src', 'assistant', 'config-dinamica')) as typeof import('./src/assistant/config-dinamica');
const { evoTecnicos } = require(path.join(RAIZ, 'src', 'assistant', 'channels', 'whatsapp-tecnicos')) as typeof import('./src/assistant/channels/whatsapp-tecnicos');
const { rotasAdmin } = require(path.join(RAIZ, 'src', 'assistant', 'rotas-admin')) as typeof import('./src/assistant/rotas-admin');
const { ErroHttp } = require(path.join(RAIZ, 'src', 'assistant', 'http-util')) as typeof import('./src/assistant/http-util');
/* eslint-enable @typescript-eslint/no-var-requires */

let passou = 0;
let falhou = 0;
function checa(rotulo: string, ok: boolean, detalhe: unknown = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${rotulo}${ok || detalhe === '' ? '' : `\n      ${typeof detalhe === 'string' ? detalhe : JSON.stringify(detalhe).slice(0, 600)}`}`);
  ok ? passou++ : falhou++;
}

// ── WhatsApp dublê ───────────────────────────────────────────────────────────
const enviados: Array<{ para: string; texto: string }> = [];
const recusar = new Set<string>();
Object.defineProperty(evoTecnicos, 'disponivel', { get: () => true });
(evoTecnicos as any).enviarTexto = async (para: string, texto: string) => {
  if (recusar.has(para)) return false;
  enviados.push({ para, texto });
  return true;
};
const para = () => enviados.map((e) => e.para).sort();

const servidor = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  rotasAdmin(req, res, url, url.pathname).then((tratou) => {
    if (!tratou) { res.writeHead(404); res.end(); }
  }).catch((err) => {
    res.writeHead(err instanceof ErroHttp ? err.status : 500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  });
});
let BASE = '';
async function api(metodo: string, caminho: string, corpo?: unknown) {
  const r = await fetch(`${BASE}${caminho}`, {
    method: metodo,
    headers: { 'Content-Type': 'application/json', 'x-operador': 'teste' },
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
  });
  const t = await r.text();
  let j: any = null;
  try { j = JSON.parse(t); } catch { j = t; }
  return { status: r.status, j };
}

let seq = 0;
const alerta = (origem: any, severidade: any, chave?: string) => alertas.emitir({
  origem, severidade, titulo: `${origem} ${severidade}`, texto: `texto ${origem} ${severidade}`,
  chave: chave ?? `t:${origem}:${severidade}:${++seq}`,
});

const ANA = '5585911111111@s.whatsapp.net';
const BETO = '5585922222222@s.whatsapp.net';
const GRUPO = '120363000000000000@g.us';

async function main() {
  await new Promise<void>((r) => servidor.listen(0, '127.0.0.1', r));
  BASE = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;
  db();

  console.log('\n─── Rotas do painel ───');
  let r = await api('POST', '/api/alertas-destinos', { nome: 'Ana', numero: '(85) 91111-1111', tipos: ['rede', 'ctos'], severidade_minima: 'aviso' });
  checa('cadastra com número formatado', r.status === 201 && r.j.destino.numero === ANA, r);
  const idAna = r.j.destino.id;
  r = await api('POST', '/api/alertas-destinos', { nome: 'Beto', numero: '85922222222', tipos: ['rede', 'ura', 'resumo'], severidade_minima: 'critico' });
  checa('cadastra o segundo', r.status === 201);
  const idBeto = r.j.destino.id;
  r = await api('POST', '/api/alertas-destinos', { nome: 'Outra Ana', numero: '85911111111', tipos: ['rede'] });
  checa('número repetido recusado', r.status === 409, r);
  r = await api('POST', '/api/alertas-destinos', { nome: 'X', numero: '123', tipos: ['rede'] });
  checa('número curto recusado', r.status === 400 && /número inválido/.test(r.j.error), r);
  r = await api('POST', '/api/alertas-destinos', { nome: 'X', numero: '85933333333', tipos: [] });
  checa('sem tipo recusado', r.status === 400 && /pelo menos um/.test(r.j.error), r);
  r = await api('POST', '/api/alertas-destinos', { nome: 'X', numero: '85933333333', tipos: ['rede', 'inventado'] });
  checa('tipo inexistente recusado', r.status === 400 && /inventado/.test(r.j.error), r);
  r = await api('POST', '/api/alertas-destinos', { nome: 'X', numero: '85933333333', tipos: ['rede'], severidade_minima: 'urgente' });
  checa('gravidade inexistente recusada', r.status === 400, r);
  r = await api('POST', '/api/alertas-destinos', { nome: '', numero: '85933333333', tipos: ['rede'] });
  checa('sem nome recusado', r.status === 400);
  r = await api('POST', '/api/alertas-destinos', { nome: 'Grupo NOC', numero: GRUPO, tipos: ['sistema'], severidade_minima: 'info' });
  checa('aceita id de grupo', r.status === 201 && r.j.destino.numero === GRUPO, r);
  const idGrupo = r.j.destino.id;
  r = await api('GET', '/api/alertas-destinos');
  checa('lista com tipos e gravidades para o painel', r.j.destinos.length === 3 && r.j.tipos.ctos && r.j.severidades.length === 3, r.j);

  console.log('\n─── Quem recebe o quê ───');
  enviados.length = 0;
  await alerta('zabbix', 'aviso');
  checa('rede/aviso: só Ana (Beto quer só crítico)', JSON.stringify(para()) === JSON.stringify([ANA]), para());
  enviados.length = 0;
  await alerta('zabbix', 'critico');
  checa('rede/crítico: Ana e Beto', JSON.stringify(para()) === JSON.stringify([ANA, BETO].sort()), para());
  enviados.length = 0;
  await alerta('zabbix', 'info');
  checa('rede/info: ninguém (abaixo do mínimo dos dois)', para().length === 0, para());
  enviados.length = 0;
  await alerta('ctos', 'aviso');
  checa('ctos: só Ana', JSON.stringify(para()) === JSON.stringify([ANA]), para());
  enviados.length = 0;
  await alerta('ura', 'info');
  checa('URA ignora gravidade: Beto recebe mesmo sendo info', JSON.stringify(para()) === JSON.stringify([BETO]), para());
  enviados.length = 0;
  await alerta('sistema', 'info', 'resumo:2026-09-17');
  checa('resumo diário vai para quem marcou resumo', JSON.stringify(para()) === JSON.stringify([BETO]), para());
  enviados.length = 0;
  await alerta('sistema', 'info', 'sistema:x');
  checa('aviso do sistema vai para o grupo cadastrado como destino', JSON.stringify(para()) === JSON.stringify([GRUPO]), para());
  enviados.length = 0;
  const semNinguem = await alerta('netflow', 'critico');
  checa('ninguém quer tráfego: não envia e diz por quê', para().length === 0 && /ninguém recebe/.test(semNinguem?.envio_erro ?? ''), semNinguem);

  console.log('\n─── "Resolvido" herda a gravidade do original ───');
  await alerta('zabbix', 'aviso', 'zbx:1');
  enviados.length = 0;
  await alertas.emitir({ origem: 'zabbix', severidade: 'info', evento: true, titulo: 'ok', texto: 'resolvido', chave: 'zbx:1:resolvido' });
  checa('fim de um aviso vai para quem recebeu o aviso (Ana), não para Beto', JSON.stringify(para()) === JSON.stringify([ANA]), para());
  await alerta('zabbix', 'critico', 'zbx:2');
  enviados.length = 0;
  await alertas.emitir({ origem: 'zabbix', severidade: 'info', evento: true, titulo: 'ok', texto: 'resolvido', chave: 'zbx:2:resolvido' });
  checa('fim de um crítico vai para os dois', para().length === 2, para());

  console.log('\n─── Grupo junto e falha parcial ───');
  cfg.definir('alertas.destino_grupo', '120363999999999999@g.us', 'teste');
  enviados.length = 0;
  let a = await alerta('zabbix', 'aviso');
  checa('grupo recebe junto com as pessoas', para().includes('120363999999999999@g.us') && para().includes(ANA), para());
  recusar.add(ANA);
  enviados.length = 0;
  a = await alerta('zabbix', 'aviso');
  checa('falha para um: alerta conta como enviado e diz quem ficou sem', !!a?.enviado_em && /Ana/.test(a?.envio_erro ?? ''), a);
  const envios = dest.enviosDoAlerta(a!.id);
  checa('registro por destino', envios.length === 2 && envios.some((e) => e.destino === 'Ana' && !e.enviado_em) && envios.some((e) => e.destino === 'grupo' && !!e.enviado_em), envios);
  recusar.add('120363999999999999@g.us');
  a = await alerta('zabbix', 'aviso');
  checa('falha para todos: não enviado', !a?.enviado_em && /falha ao enviar/.test(a?.envio_erro ?? ''), a);
  recusar.clear();
  cfg.definir('alertas.destino_grupo', '', 'teste');

  console.log('\n─── Silêncio vale para as pessoas também ───');
  cfg.definir('alertas.silencio_inicio', '00:00', 'teste');
  cfg.definir('alertas.silencio_fim', '23:59', 'teste');
  enviados.length = 0;
  a = await alerta('zabbix', 'aviso');
  checa('aviso no silêncio não sai', para().length === 0 && /silêncio/.test(a?.envio_erro ?? ''), a);
  a = await alerta('zabbix', 'critico');
  checa('crítico fura o silêncio', para().length === 2, para());
  cfg.definir('alertas.silencio_inicio', '', 'teste');

  console.log('\n─── Editar, pausar, testar, remover ───');
  r = await api('PUT', `/api/alertas-destinos/${idBeto}`, { tipos: ['trafego'], severidade_minima: 'aviso' });
  checa('edita tipos e gravidade', r.status === 200 && r.j.destino.tipos[0] === 'trafego' && r.j.destino.severidade_minima === 'aviso', r);
  enviados.length = 0;
  await alerta('netflow', 'aviso');
  checa('passa a receber o novo tipo', JSON.stringify(para()) === JSON.stringify([BETO]), para());
  r = await api('PUT', `/api/alertas-destinos/${idBeto}`, { ativo: false });
  enviados.length = 0;
  await alerta('netflow', 'critico');
  checa('pausado não recebe', r.j.destino.ativo === false && para().length === 0, para());
  r = await api('PUT', `/api/alertas-destinos/${idBeto}`, { numero: '85911111111' });
  checa('trocar para número já usado é recusado', r.status === 409);
  r = await api('PUT', `/api/alertas-destinos/${idBeto}`, { tipos: [] });
  checa('editar para nenhum tipo é recusado', r.status === 400);
  enviados.length = 0;
  r = await api('POST', `/api/alertas-destinos/${idAna}/teste`);
  checa('teste manda mensagem para a pessoa', r.status === 200 && enviados.length === 1 && enviados[0].para === ANA && /Teste de alerta/.test(enviados[0].texto) && /Sinal das CTOs/.test(enviados[0].texto), enviados);
  recusar.add(ANA);
  r = await api('POST', `/api/alertas-destinos/${idAna}/teste`);
  checa('teste que falha avisa o painel', r.status === 502, r);
  recusar.clear();
  r = await api('DELETE', `/api/alertas-destinos/${idGrupo}`);
  checa('remove', r.status === 200 && (await api('GET', '/api/alertas-destinos')).j.destinos.length === 2);
  r = await api('PUT', '/api/alertas-destinos/9999', { ativo: false });
  checa('inexistente = 404', r.status === 404);

  const aud = db().prepare(`SELECT acao, ator FROM auditoria WHERE acao LIKE 'alerta_destino.%'`).all() as Array<{ acao: string; ator: string }>;
  checa('tudo auditado com quem fez', ['criar', 'editar', 'teste', 'remover'].every((x) => aud.some((a) => a.acao === `alerta_destino.${x}`)) && aud.every((a) => a.ator === 'painel:teste'), aud);

  servidor.close();
  fecharDb();
  console.log(`\n${passou} passaram, ${falhou} falharam\n`);
  process.exit(falhou ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
