// Testes de bots (sistema interno manda evento) e webhooks de saída.
// WhatsApp é dublê; o receptor do webhook é um servidor HTTP local.
//
//   npm run test:bots

import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import crypto from 'crypto';
import type { AddressInfo } from 'net';

for (const k of ['OPENAI_API_KEY', 'SGP_BASE_URL', 'SGP_TOKEN']) {
  process.env[k] ||= 'teste-bots-sem-uso';
}
const RAIZ = __dirname;
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'aq-bots-')));

/* eslint-disable @typescript-eslint/no-var-requires */
const { db, fecharDb } = require(path.join(RAIZ, 'src', 'assistant', 'store', 'db')) as typeof import('./src/assistant/store/db');
const b = require(path.join(RAIZ, 'src', 'assistant', 'bots')) as typeof import('./src/assistant/bots');
const w = require(path.join(RAIZ, 'src', 'assistant', 'webhooks')) as typeof import('./src/assistant/webhooks');
const alertas = require(path.join(RAIZ, 'src', 'assistant', 'alertas')) as typeof import('./src/assistant/alertas');
const dest = require(path.join(RAIZ, 'src', 'assistant', 'destinos-alerta')) as typeof import('./src/assistant/destinos-alerta');
const { evoTecnicos } = require(path.join(RAIZ, 'src', 'assistant', 'channels', 'whatsapp-tecnicos')) as typeof import('./src/assistant/channels/whatsapp-tecnicos');
const { rotasAdmin } = require(path.join(RAIZ, 'src', 'assistant', 'rotas-admin')) as typeof import('./src/assistant/rotas-admin');
const { ErroHttp } = require(path.join(RAIZ, 'src', 'assistant', 'http-util')) as typeof import('./src/assistant/http-util');
const cfg = require(path.join(RAIZ, 'src', 'assistant', 'config-dinamica')) as typeof import('./src/assistant/config-dinamica');
/* eslint-enable @typescript-eslint/no-var-requires */

let passou = 0;
let falhou = 0;
function checa(rotulo: string, ok: boolean, detalhe: unknown = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${rotulo}${ok || detalhe === '' ? '' : `\n      ${typeof detalhe === 'string' ? detalhe : JSON.stringify(detalhe).slice(0, 500)}`}`);
  ok ? passou++ : falhou++;
}
const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── WhatsApp dublê ───────────────────────────────────────────────────────────
const enviados: Array<{ para: string; texto: string }> = [];
Object.defineProperty(evoTecnicos, 'disponivel', { get: () => true });
(evoTecnicos as any).enviarTexto = async (para: string, texto: string) => { enviados.push({ para, texto }); return true; };
(evoTecnicos as any).verificarNumero = async (n: string) => ({ existe: true, jid: n.includes('@') ? n : `${n}@s.whatsapp.net` });

// ── Receptor de webhook ──────────────────────────────────────────────────────
const recebidos: Array<{ evento: string; assinatura: string; corpo: string }> = [];
let respostaWebhook = 200;
let quedasSeguidas = 0;
const receptor = http.createServer((req, res) => {
  let corpo = '';
  req.on('data', (c) => { corpo += c; });
  req.on('end', () => {
    recebidos.push({
      evento: String(req.headers['x-assistente-evento'] ?? ''),
      assinatura: String(req.headers['x-assistente-assinatura'] ?? ''),
      corpo,
    });
    if (quedasSeguidas > 0) { quedasSeguidas--; req.destroy(); return; }
    res.writeHead(respostaWebhook);
    res.end('{}');
  });
});

// ── Painel ───────────────────────────────────────────────────────────────────
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
    headers: { 'Content-Type': 'application/json', 'x-operador': 'ana' },
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
  });
  const t = await r.text();
  let j: any = null;
  try { j = JSON.parse(t); } catch { j = t; }
  return { status: r.status, j };
}

async function main() {
  await new Promise<void>((r) => servidor.listen(0, '127.0.0.1', r));
  await new Promise<void>((r) => receptor.listen(0, '127.0.0.1', r));
  BASE = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;
  const URL_RECEPTOR = `http://127.0.0.1:${(receptor.address() as AddressInfo).port}/eventos`;
  db();

  console.log('\n─── Criar bot ───');
  checa('slug tira acento e espaço', b.slugDe('Central Técnica') === 'central-tecnica');
  const { bot, chave } = b.criarBot({ nome: 'Central Técnica', descricao: 'chamados' }, 'painel:ana');
  checa('cria com slug e chave', bot.slug === 'central-tecnica' && chave.length === 48, { slug: bot.slug, tam: chave.length });
  checa('chave não fica em claro no banco', !JSON.stringify(db().prepare(`SELECT * FROM bot`).all()).includes(chave));
  let erro = '';
  try { b.criarBot({ nome: 'central tecnica' }, 'x'); } catch (e) { erro = (e as Error).message; }
  checa('nome repetido recusado', /já existe/.test(erro), erro);

  console.log('\n─── Autenticar bot ───');
  checa('chave certa entra', b.autenticarBot('central-tecnica', chave)?.slug === 'central-tecnica');
  checa('chave errada não entra', b.autenticarBot('central-tecnica', 'x'.repeat(48)) === null);
  checa('slug inexistente não entra', b.autenticarBot('nao-existe', chave) === null);
  b.atualizarBot('central-tecnica', { ativo: false }, 'painel:ana');
  checa('bot pausado não entra', b.autenticarBot('central-tecnica', chave) === null);
  b.atualizarBot('central-tecnica', { ativo: true }, 'painel:ana');
  const nova = b.trocarChave('central-tecnica', 'painel:ana');
  checa('chave nova vale', !!b.autenticarBot('central-tecnica', nova));
  checa('chave antiga para de valer', b.autenticarBot('central-tecnica', chave) === null);

  console.log('\n─── Evento vira alerta ───');
  cfg.definir('alertas.destino_grupo', '120363000@g.us', 'teste');
  enviados.length = 0;
  const vivo = b.autenticarBot('central-tecnica', nova)!;
  let r = await b.receberEventoDeBot(vivo, { titulo: 'Chamado 458 aberto', texto: 'Cliente sem sinal', severidade: 'aviso', chave: 'os-458' });
  checa('cria alerta', r.criado && r.chave === 'bot:central-tecnica:os-458', r);
  checa('mensagem marcada como robô, com o nome do sistema', /🤖 \*Central Técnica\*/.test(enviados[0]?.texto ?? ''), enviados[0]);
  const alerta = alertas.porChave('bot:central-tecnica:os-458');
  checa('origem bot e título com o sistema', alerta?.origem === 'bot' && alerta.titulo === 'Central Técnica: Chamado 458 aberto', alerta);
  checa('tipo do alerta é "bots"', dest.tipoDoAlerta(alerta!) === 'bots');
  checa('conta uso do bot', b.botPorSlug('central-tecnica')!.eventos === 1 && !!b.botPorSlug('central-tecnica')!.ultimo_uso);

  r = await b.receberEventoDeBot(vivo, { titulo: 'Chamado 458 aberto', texto: 'de novo', chave: 'os-458' });
  checa('mesma chave não vira alerta novo', !r.criado && /já alertado/.test(r.motivo ?? ''), r);

  enviados.length = 0;
  r = await b.receberEventoDeBot(vivo, { titulo: 'Chamado 458 concluído', chave: 'os-458', resolvido: true });
  checa('resolvido fecha o alerta', r.criado && !!alertas.porChave('bot:central-tecnica:os-458')?.resolvido_em, r);
  checa('aviso de resolvido sai com ✅', /✅/.test(enviados[0]?.texto ?? ''), enviados[0]);
  r = await b.receberEventoDeBot(vivo, { titulo: 'x', chave: 'nunca-existiu', resolvido: true });
  checa('resolver o que não existe não inventa alerta', !r.criado && /nenhum alerta aberto/.test(r.motivo ?? ''), r);

  erro = '';
  try { await b.receberEventoDeBot(vivo, { texto: 'sem titulo' }); } catch (e) { erro = (e as Error).message; }
  checa('evento sem título é recusado', /sem titulo/.test(erro), erro);
  erro = '';
  try { await b.receberEventoDeBot(vivo, { titulo: 'x', severidade: 'apocalipse' }); } catch (e) { erro = (e as Error).message; }
  checa('severidade inventada recusada', /severidade inválida/.test(erro), erro);
  r = await b.receberEventoDeBot(vivo, { titulo: 'Sem chave', severidade: 'info' });
  const r2 = await b.receberEventoDeBot(vivo, { titulo: 'Sem chave', severidade: 'info' });
  checa('sem chave, cada evento é um fato novo', r.criado && r2.criado && r.chave !== r2.chave);

  console.log('\n─── Rotas do painel (bots) ───');
  let x = await api('GET', '/api/bots');
  checa('lista bots', x.status === 200 && x.j.bots.length === 1);
  x = await api('POST', '/api/bots', { nome: 'Zabbix', descricao: 'eventos de rede' });
  checa('cria pela API e devolve a chave uma vez', x.status === 201 && x.j.chave.length === 48 && /não aparece de novo/.test(x.j.aviso), x.j?.aviso);
  const chaveZabbix = x.j.chave;
  x = await api('POST', '/api/bots', { nome: 'zabbix' });
  checa('repetido = 409', x.status === 409);
  x = await api('POST', '/api/bots/zabbix/chave');
  checa('troca a chave pela API', x.status === 200 && x.j.chave !== chaveZabbix && b.autenticarBot('zabbix', chaveZabbix) === null);
  x = await api('PUT', '/api/bots/zabbix', { ativo: false });
  checa('pausa pela API', x.j.bot.ativo === false);
  x = await api('DELETE', '/api/bots/zabbix');
  checa('remove pela API', x.status === 200 && b.botPorSlug('zabbix') === null);
  x = await api('PUT', '/api/bots/nao-existe', { ativo: true });
  checa('bot inexistente = 404', x.status === 404);

  console.log('\n─── Webhook de saída ───');
  erro = '';
  try { w.criarWebhook({ nome: 'x', url: 'ftp://nao', eventos: ['alerta'] }, 'ana'); } catch (e) { erro = (e as Error).message; }
  checa('endereço que não é http é recusado', /http/.test(erro), erro);
  erro = '';
  try { w.criarWebhook({ nome: 'x', url: URL_RECEPTOR, eventos: ['nada'] }, 'ana'); } catch (e) { erro = (e as Error).message; }
  checa('evento inventado recusado', /evento inválido/.test(erro), erro);

  const { webhook, segredo } = w.criarWebhook({ nome: 'Central', url: URL_RECEPTOR, eventos: ['alerta', 'alerta.resolvido'] }, 'painel:ana');
  recebidos.length = 0;
  await alertas.emitir({ origem: 'zabbix', severidade: 'critico', titulo: 'OLT 3 fora', texto: 'ping falhou', chave: 'zbx:olt3' });
  await espera(250);
  checa('alerta novo dispara o webhook', recebidos.length === 1 && recebidos[0].evento === 'alerta', recebidos.map((x) => x.evento));
  const corpo = JSON.parse(recebidos[0].corpo);
  checa('corpo traz evento, hora e dados', corpo.evento === 'alerta' && !!corpo.em && corpo.dados.titulo === 'OLT 3 fora', corpo);
  checa('assinatura confere com o segredo', recebidos[0].assinatura === crypto.createHmac('sha256', segredo).update(recebidos[0].corpo).digest('hex'));
  checa('assinatura não bate com outro segredo', recebidos[0].assinatura !== crypto.createHmac('sha256', 'outro').update(recebidos[0].corpo).digest('hex'));

  recebidos.length = 0;
  alertas.marcarResolvido('zbx:olt3');
  await espera(250);
  checa('resolvido dispara o evento certo', recebidos.some((x) => x.evento === 'alerta.resolvido'), recebidos.map((x) => x.evento));

  recebidos.length = 0;
  w.atualizarWebhook(webhook.id, { eventos: ['chamada'] }, 'painel:ana');
  await alertas.emitir({ origem: 'zabbix', severidade: 'aviso', titulo: 'outro', texto: 'x', chave: 'zbx:2' });
  await espera(200);
  checa('só recebe o que assinou', recebidos.length === 0, recebidos);

  w.atualizarWebhook(webhook.id, { eventos: ['alerta'], ativo: false }, 'painel:ana');
  recebidos.length = 0;
  await alertas.emitir({ origem: 'zabbix', severidade: 'aviso', titulo: 'terceiro', texto: 'x', chave: 'zbx:3' });
  await espera(200);
  checa('desligado não recebe', recebidos.length === 0);
  w.atualizarWebhook(webhook.id, { ativo: true }, 'painel:ana');

  console.log('\n─── Falha na entrega ───');
  respostaWebhook = 500;
  recebidos.length = 0;
  await alertas.emitir({ origem: 'zabbix', severidade: 'aviso', titulo: 'quarto', texto: 'x', chave: 'zbx:4' });
  await espera(500);
  checa('tenta duas vezes quando o outro lado devolve erro', recebidos.length === 2, recebidos.length);
  checa('conta a falha e guarda o status', w.webhookPorId(webhook.id)!.falhas === 1 && /500/.test(w.webhookPorId(webhook.id)!.ultimo_status ?? ''), w.webhookPorId(webhook.id));
  respostaWebhook = 200;
  await alertas.emitir({ origem: 'zabbix', severidade: 'aviso', titulo: 'quinto', texto: 'x', chave: 'zbx:5' });
  await espera(400);
  checa('sucesso zera o contador de falhas', w.webhookPorId(webhook.id)!.falhas === 0, w.webhookPorId(webhook.id));

  respostaWebhook = 500;
  for (let i = 0; i < 10; i++) {
    await alertas.emitir({ origem: 'zabbix', severidade: 'aviso', titulo: `f${i}`, texto: 'x', chave: `zbx:f${i}` });
    await espera(120);
  }
  await espera(400);
  const desligado = w.webhookPorId(webhook.id)!;
  checa('dez falhas seguidas desligam o webhook', !desligado.ativo && desligado.falhas >= 10, desligado);
  respostaWebhook = 200;
  w.atualizarWebhook(webhook.id, { ativo: true }, 'painel:ana');
  checa('religar zera as falhas', w.webhookPorId(webhook.id)!.falhas === 0);

  console.log('\n─── Rotas do painel (webhooks) ───');
  x = await api('GET', '/api/webhooks');
  checa('lista webhooks e eventos possíveis', x.status === 200 && x.j.webhooks.length === 1 && !!x.j.eventos.alerta, x.j?.eventos);
  checa('segredo nunca sai na listagem', !JSON.stringify(x.j).includes(segredo));
  x = await api('POST', '/api/webhooks', { nome: 'Outro', url: URL_RECEPTOR, eventos: ['consulta'] });
  checa('cria pela API com segredo uma vez', x.status === 201 && x.j.segredo.length === 48);
  const idOutro = x.j.webhook.id;
  recebidos.length = 0;
  x = await api('POST', `/api/webhooks/${idOutro}/teste`);
  checa('teste entrega na hora e diz o status', x.j.ok === true && /200/.test(x.j.status) && recebidos.length === 1, x.j);
  x = await api('POST', '/api/webhooks', { nome: 'Ruim', url: 'nao-e-url', eventos: ['alerta'] });
  checa('endereço inválido = 400', x.status === 400);
  x = await api('DELETE', `/api/webhooks/${idOutro}`);
  checa('remove pela API', x.status === 200 && w.webhookPorId(idOutro) === null);

  console.log('\n─── Auditoria ───');
  const aud = (db().prepare(`SELECT acao FROM auditoria`).all() as Array<{ acao: string }>).map((a) => a.acao);
  for (const acao of ['bot.criar', 'bot.editar', 'bot.trocar_chave', 'bot.remover', 'webhook.criar', 'webhook.editar', 'webhook.remover', 'webhook.teste', 'webhook.desligado']) {
    checa(`registra ${acao}`, aud.includes(acao), aud.slice(0, 25));
  }
  checa('nenhuma chave de bot na auditoria', !JSON.stringify(db().prepare(`SELECT * FROM auditoria`).all()).includes(nova));

  servidor.close();
  receptor.close();
  fecharDb();
  console.log(`\n${passou} passaram, ${falhou} falharam\n`);
  process.exit(falhou ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
