// Testes dos canais extras: contingência quando o WhatsApp cai, evento para
// o painel avisar sozinho e as preferências que o painel lê.
//
//   npm run test:canais

import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import type { AddressInfo } from 'net';

for (const k of ['OPENAI_API_KEY', 'SGP_BASE_URL', 'SGP_TOKEN']) {
  process.env[k] ||= 'teste-canais-sem-uso';
}
process.env.TZ ||= 'America/Fortaleza';
const RAIZ = __dirname;
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'aq-canais-')));

/* eslint-disable @typescript-eslint/no-var-requires */
const { db, fecharDb } = require(path.join(RAIZ, 'src', 'assistant', 'store', 'db')) as typeof import('./src/assistant/store/db');
const alertas = require(path.join(RAIZ, 'src', 'assistant', 'alertas')) as typeof import('./src/assistant/alertas');
const eventos = require(path.join(RAIZ, 'src', 'assistant', 'eventos')) as typeof import('./src/assistant/eventos');
const cfg = require(path.join(RAIZ, 'src', 'assistant', 'config-dinamica')) as typeof import('./src/assistant/config-dinamica');
const { evoTecnicos } = require(path.join(RAIZ, 'src', 'assistant', 'channels', 'whatsapp-tecnicos')) as typeof import('./src/assistant/channels/whatsapp-tecnicos');
const { rotasOperacao } = require(path.join(RAIZ, 'src', 'assistant', 'rotas-operacao')) as typeof import('./src/assistant/rotas-operacao');
const { ErroHttp } = require(path.join(RAIZ, 'src', 'assistant', 'http-util')) as typeof import('./src/assistant/http-util');
/* eslint-enable @typescript-eslint/no-var-requires */

let passou = 0;
let falhou = 0;
function checa(rotulo: string, ok: boolean, detalhe: unknown = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${rotulo}${ok || detalhe === '' ? '' : `\n      ${typeof detalhe === 'string' ? detalhe : JSON.stringify(detalhe).slice(0, 400)}`}`);
  ok ? passou++ : falhou++;
}

let whatsFora = false;
let disponivel = true;
const enviados: Array<{ para: string; texto: string }> = [];
Object.defineProperty(evoTecnicos, 'disponivel', { get: () => disponivel });
(evoTecnicos as any).enviarTextoComId = async (para: string, texto: string) => {
  if (whatsFora) return { ok: false, id: null };
  enviados.push({ para, texto });
  return { ok: true, id: `MSG${enviados.length}` };
};
(evoTecnicos as any).enviarTexto = async (para: string, texto: string) =>
  (await (evoTecnicos as any).enviarTextoComId(para, texto)).ok;

const servidor = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  rotasOperacao(req, res, url, url.pathname).then((t) => { if (!t) { res.writeHead(404); res.end(); } })
    .catch((err) => {
      res.writeHead(err instanceof ErroHttp ? err.status : 500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    });
});
let BASE = '';
async function api(metodo: string, caminho: string) {
  const r = await fetch(`${BASE}${caminho}`, { method: metodo, headers: { 'x-operador': 'ana' } });
  const t = await r.text();
  let j: any = null;
  try { j = JSON.parse(t); } catch { j = t; }
  return { status: r.status, j };
}

let n = 0;
const emitir = (p: Record<string, unknown> = {}) => alertas.emitir({
  origem: 'zabbix', severidade: 'critico', titulo: 'OLT fora', texto: 'OLT fora',
  chave: `zabbix:c${++n}`, dados: { host: 'OLT-1' }, ...p,
} as Parameters<typeof alertas.emitir>[0]);

async function main(): Promise<void> {
  db();
  await new Promise<void>((r) => servidor.listen(0, '127.0.0.1', r));
  BASE = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;
  cfg.definir('alertas.destino_grupo', '99999@g.us', 'teste');
  cfg.definir('incidentes.ativo', false, 'teste');

  console.log('\n─── Contingência quando o WhatsApp cai ───');
  let contingencias = eventos.eventosRecentes(200).filter((e) => e.tipo === 'contingencia').length;
  whatsFora = true;
  const a = await emitir({ titulo: 'OLT 1 fora' });
  const agora = eventos.eventosRecentes(200).filter((e) => e.tipo === 'contingencia');
  checa('falha total no WhatsApp gera evento de contingência', agora.length === contingencias + 1, agora.length);
  checa('o evento leva o alerta e o motivo',
    !!(agora.at(-1)!.dados as any).alerta.titulo && /recusou/.test((agora.at(-1)!.dados as any).motivo), agora.at(-1)!.dados);
  checa('o alerta continua registrado, com o motivo da falha',
    !!a && !a.enviado_em && /falha ao enviar/.test(a.envio_erro ?? ''), a?.envio_erro);
  checa('o evento diz quantos painéis estavam ouvindo',
    typeof (agora.at(-1)!.dados as any).paineis === 'number');

  contingencias = agora.length;
  disponivel = false;
  await emitir({ titulo: 'OLT 2 fora' });
  checa('instância não configurada também vira contingência',
    eventos.eventosRecentes(200).filter((e) => e.tipo === 'contingencia').length === contingencias + 1);
  disponivel = true;

  cfg.definir('canais.contingencia', false, 'teste');
  contingencias = eventos.eventosRecentes(200).filter((e) => e.tipo === 'contingencia').length;
  await emitir({ titulo: 'OLT 3 fora' });
  checa('desligada, a contingência não gera evento',
    eventos.eventosRecentes(200).filter((e) => e.tipo === 'contingencia').length === contingencias);
  cfg.definir('canais.contingencia', true, 'teste');

  whatsFora = false;
  enviados.length = 0;
  contingencias = eventos.eventosRecentes(200).filter((e) => e.tipo === 'contingencia').length;
  const ok = await emitir({ titulo: 'OLT 4 fora' });
  checa('com WhatsApp de pé, nada de contingência',
    !!ok?.enviado_em && enviados.length > 0
    && eventos.eventosRecentes(200).filter((e) => e.tipo === 'contingencia').length === contingencias);

  console.log('\n─── Painéis conectados ───');
  checa('sem painel aberto, a conta é zero', eventos.paineisConectados() === 0);
  const controle = new AbortController();
  const stream = fetch(`${BASE}/api/eventos/stream`, { signal: controle.signal, headers: { 'x-operador': 'ana' } });
  await new Promise((r) => setTimeout(r, 150));
  checa('painel aberto aparece na conta', eventos.paineisConectados() === 1, eventos.paineisConectados());
  controle.abort();
  await stream.catch(() => {});
  await new Promise((r) => setTimeout(r, 150));
  checa('painel fechado sai da conta', eventos.paineisConectados() === 0, eventos.paineisConectados());

  console.log('\n─── Preferências que o painel lê ───');
  cfg.definir('canais.falar_a_partir_de', 'aviso', 'teste');
  cfg.definir('canais.silencio_painel_inicio', '23:00', 'teste');
  cfg.definir('canais.silencio_painel_fim', '06:00', 'teste');
  const r = await api('GET', '/api/canais');
  checa('a rota devolve as chaves de canal', r.status === 200 && r.j.falar_a_partir_de === 'aviso');
  checa('e o horário de silêncio do painel', r.j.silencio_inicio === '23:00' && r.j.silencio_fim === '06:00');
  checa('e quantos painéis estão ouvindo', typeof r.j.paineis_conectados === 'number');
  checa('a rota não devolve nada além dos canais',
    Object.keys(r.j).sort().join(',') === 'contingencia,falar_a_partir_de,paineis_conectados,push,silencio_fim,silencio_inicio',
    Object.keys(r.j));
  checa('gravidade inválida para a voz é recusada na configuração',
    (() => { try { cfg.definir('canais.falar_a_partir_de', 'urgente', 'teste'); return false; } catch { return true; } })());

  console.log('\n─── Silêncio do painel não é silêncio do WhatsApp ───');
  enviados.length = 0;
  const durante = await emitir({ severidade: 'aviso', titulo: 'Aviso qualquer' });
  checa('o silêncio do painel não bloqueia o envio no WhatsApp', !!durante?.enviado_em && enviados.length > 0, durante?.envio_erro);

  servidor.close();
  fecharDb();
  console.log(`\n${passou} passaram, ${falhou} falharam\n`);
  process.exit(falhou ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
