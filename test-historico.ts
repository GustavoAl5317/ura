// Testes de histórico, recorrência, métricas da operação e pós-incidente.
//
//   npm run test:historico

import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import type { AddressInfo } from 'net';

for (const k of ['OPENAI_API_KEY', 'SGP_BASE_URL', 'SGP_TOKEN']) {
  process.env[k] ||= 'teste-historico-sem-uso';
}
process.env.TZ ||= 'America/Fortaleza';
const RAIZ = __dirname;
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'aq-hist-')));

/* eslint-disable @typescript-eslint/no-var-requires */
const { db, fecharDb } = require(path.join(RAIZ, 'src', 'assistant', 'store', 'db')) as typeof import('./src/assistant/store/db');
const alertas = require(path.join(RAIZ, 'src', 'assistant', 'alertas')) as typeof import('./src/assistant/alertas');
const inc = require(path.join(RAIZ, 'src', 'assistant', 'incidentes')) as typeof import('./src/assistant/incidentes');
const hist = require(path.join(RAIZ, 'src', 'assistant', 'historico')) as typeof import('./src/assistant/historico');
const cfg = require(path.join(RAIZ, 'src', 'assistant', 'config-dinamica')) as typeof import('./src/assistant/config-dinamica');
const { evoTecnicos } = require(path.join(RAIZ, 'src', 'assistant', 'channels', 'whatsapp-tecnicos')) as typeof import('./src/assistant/channels/whatsapp-tecnicos');
const { ferramentas } = require(path.join(RAIZ, 'src', 'assistant', 'tools', 'base')) as typeof import('./src/assistant/tools/base');
const { registrarFerramentasHistorico } = require(path.join(RAIZ, 'src', 'assistant', 'tools', 'historico')) as typeof import('./src/assistant/tools/historico');
const { rotasOperacao } = require(path.join(RAIZ, 'src', 'assistant', 'rotas-operacao')) as typeof import('./src/assistant/rotas-operacao');
const { ErroHttp } = require(path.join(RAIZ, 'src', 'assistant', 'http-util')) as typeof import('./src/assistant/http-util');
/* eslint-enable @typescript-eslint/no-var-requires */

let passou = 0;
let falhou = 0;
function checa(rotulo: string, ok: boolean, detalhe: unknown = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${rotulo}${ok || detalhe === '' ? '' : `\n      ${typeof detalhe === 'string' ? detalhe : JSON.stringify(detalhe).slice(0, 400)}`}`);
  ok ? passou++ : falhou++;
}
function erroDe(fn: () => unknown): string {
  try { fn(); return ''; } catch (e) { return (e as Error).message; }
}

let idMsg = 0;
Object.defineProperty(evoTecnicos, 'disponivel', { get: () => true });
(evoTecnicos as any).enviarTextoComId = async () => ({ ok: true, id: `MSG${++idMsg}` });
(evoTecnicos as any).enviarTexto = async () => true;

const servidor = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  rotasOperacao(req, res, url, url.pathname).then((t) => { if (!t) { res.writeHead(404); res.end(); } })
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

/** Move o incidente no tempo e fecha marcos, para haver o que medir. */
function ajustar(id: string, d: { abertoHaMin?: number; assumidoAposMin?: number; encerradoAposMin?: number }): void {
  const base = Date.now() - (d.abertoHaMin ?? 60) * 60_000;
  const iso = (m?: number) => (m === undefined ? null : new Date(base + m * 60_000).toISOString());
  db().prepare(
    `UPDATE incidente SET aberto_em = ?, reconhecido_em = COALESCE(?, reconhecido_em),
       encerrado_em = COALESCE(?, encerrado_em) WHERE id = ?`,
  ).run(new Date(base).toISOString(), iso(d.assumidoAposMin), iso(d.encerradoAposMin), id);
}

let n = 0;
const emitir = (p: Record<string, unknown>) => alertas.emitir({
  origem: 'zabbix', severidade: 'critico', titulo: 'Problema', texto: 'Problema',
  chave: `zabbix:h${++n}`, ...p,
} as Parameters<typeof alertas.emitir>[0]);

async function main(): Promise<void> {
  db();
  await new Promise<void>((r) => servidor.listen(0, '127.0.0.1', r));
  BASE = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;
  cfg.definir('alertas.destino_grupo', '99999@g.us', 'teste');

  // Três quedas da mesma PON, uma de outra, e uma de equipamento.
  for (let i = 0; i < 3; i++) {
    await emitir({ titulo: `PON 3 caiu (${i})`, dados: { pon: 3, host: 'OLT-3', clientes_afetados: 12, regiao: 'Maracanaú' } });
    const atual = inc.listar({ limite: 5 })[0];
    inc.mudarEstado(atual.id, 'encerrado', 'teste');
  }
  await emitir({ titulo: 'PON 9 caiu', dados: { pon: 9, host: 'OLT-9', clientes_afetados: 80 } });
  const daPon9 = inc.listar({ limite: 5 })[0];
  await emitir({ titulo: 'Switch do POP sem resposta', dados: { host: 'SW-POP1', regiao: 'Sobral' } });
  const doSwitch = inc.listar({ limite: 5 })[0];

  console.log('\n─── Busca ───');
  checa('sem filtro traz tudo da janela', hist.buscar({ dias: 30 }).length === 5, hist.buscar({ dias: 30 }).length);
  checa('filtra por PON', hist.buscar({ pon: '3' }).length === 3, hist.buscar({ pon: '3' }).map((i) => i.titulo));
  checa('filtra por equipamento', hist.buscar({ equipamento: 'SW-POP1' }).length === 1);
  checa('filtra por texto do título', hist.buscar({ texto: 'Switch' }).length === 1);
  checa('filtra por número do incidente', hist.buscar({ texto: daPon9.numero }).length === 1);
  checa('filtra por região (vem dos dados do alerta)', hist.buscar({ regiao: 'Maracanaú' }).length === 3, hist.buscar({ regiao: 'Maracanaú' }).length);
  checa('filtra só os abertos', hist.buscar({ estado: 'abertos' }).length === 2, hist.buscar({ estado: 'abertos' }).map((i) => i.estado));
  checa('janela curta demais não traz nada', hist.buscar({ desde: new Date(Date.now() + 60_000).toISOString() }).length === 0);
  checa('filtro sem resultado devolve lista vazia, não erro', hist.buscar({ pon: '777' }).length === 0);

  console.log('\n─── Recorrência ───');
  const rec = hist.recorrencia({ dias: 30 });
  checa('a PON que mais caiu aparece primeiro', rec[0].incidentes === 3 && /3/.test(rec[0].rotulo), rec[0]);
  checa('conta o tempo somado de cada alvo', rec[0].tempo_total_seg >= 0);
  checa('a última vez é registrada', !!rec[0].ultima_vez);
  const recEquip = hist.recorrencia({ dias: 30, por: 'equipamento' });
  checa('dá para agrupar por equipamento', recEquip.some((r) => r.chave === 'OLT-3' && r.incidentes === 3), recEquip.map((r) => r.chave));

  console.log('\n─── Médias da operação ───');
  inc.assumir(daPon9.id, 'Ana');
  ajustar(daPon9.id, { abertoHaMin: 120, assumidoAposMin: 20, encerradoAposMin: 80 });
  ajustar(doSwitch.id, { abertoHaMin: 60 });
  let m = hist.metricas({ dias: 30 });
  checa('conta os incidentes do período', m.incidentes === 5, m.incidentes);
  checa('MTTA sai do tempo até assumir', m.mtta_seg !== null && m.mtta_seg > 0, m.mtta_seg);
  checa('MTTR sai do tempo até encerrar', m.mttr_seg !== null && m.mttr_seg > 0, m.mttr_seg);
  checa('MTTD existe e mede o pipeline', m.mttd_seg !== null && m.mttd_seg >= 0, m.mttd_seg);
  checa('taxa de reconhecimento em porcentagem', m.taxa_reconhecimento > 0 && m.taxa_reconhecimento <= 100, m.taxa_reconhecimento);
  checa('incidente sem dono aparece na conta', m.sem_dono_agora === 1, m.sem_dono_agora);
  inc.mudarEstado(doSwitch.id, 'falso_positivo', 'teste');
  m = hist.metricas({ dias: 30 });
  checa('falso positivo entra na taxa', m.falsos_positivos === 1 && m.taxa_falso_positivo === 20, m.taxa_falso_positivo);
  checa('a quebra por severidade soma o total',
    m.por_severidade.reduce((a, b) => a + b.n, 0) === m.incidentes);
  checa('período vazio devolve médias nulas em vez de zero enganoso',
    (() => { const x = hist.metricas({ pon: '777', dias: 30 }); return x.incidentes === 0 && x.mtta_seg === null && x.taxa_reabertura === 0; })());

  console.log('\n─── Pós-incidente ───');
  checa('sem causa raiz não grava',
    /causa raiz/.test(erroDe(() => hist.salvarPos(daPon9.id, { o_que_aconteceu: 'caiu' }, 'ana'))));
  checa('sem relato não grava',
    /o que aconteceu/.test(erroDe(() => hist.salvarPos(daPon9.id, { causa_raiz: 'fibra rompida' }, 'ana'))));
  checa('incidente inexistente não grava',
    /não encontrado/.test(erroDe(() => hist.salvarPos('INC-2030-00001', { causa_raiz: 'x', o_que_aconteceu: 'y' }, 'ana'))));
  const pos = hist.salvarPos(daPon9.id, {
    o_que_aconteceu: 'A PON 9 ficou fora por 80 minutos.',
    causa_raiz: 'Fibra rompida por obra na avenida.',
    acoes: [{ o_que: 'Mapear rota alternativa', responsavel: 'Bruno', prazo: '2026-10-15' }, { o_que: 'Falar com a prefeitura', feito: true }],
    licoes: 'Obra na via precisa de aviso prévio.',
  }, 'ana');
  checa('grava causa, relato e ações', pos.causa_raiz.length > 0 && pos.acoes.length === 2);
  checa('entra na linha do tempo do incidente',
    inc.linhaDoTempo(daPon9.id).some((l) => l.tipo === 'pos_incidente'));
  checa('ação sem descrição é recusada',
    /sem descrição/.test(erroDe(() => hist.salvarPos(daPon9.id, { o_que_aconteceu: 'x', causa_raiz: 'y', acoes: [{ responsavel: 'Ana' }] }, 'ana'))));
  const pos2 = hist.salvarPos(daPon9.id, { o_que_aconteceu: 'texto novo', causa_raiz: 'causa nova', acoes: [] }, 'bruno');
  checa('salvar de novo atualiza em vez de duplicar', pos2.criado_em === pos.criado_em && pos2.causa_raiz === 'causa nova');
  hist.salvarPos(daPon9.id, {
    o_que_aconteceu: 'texto', causa_raiz: 'causa',
    acoes: [{ o_que: 'Trocar o cabo', responsavel: 'Caio' }, { o_que: 'Feito e fechado', feito: true }],
  }, 'ana');
  const pendentes = hist.acoesPendentes();
  checa('ação em aberto aparece na lista de pendências', pendentes.length === 1 && pendentes[0].acao.o_que === 'Trocar o cabo', pendentes);
  checa('ação marcada como feita some da lista', !pendentes.some((p) => p.acao.feito));

  console.log('\n─── Ferramenta da IA ───');
  registrarFerramentasHistorico();
  let k = 0;
  const ctx = { proximoId: () => `evd_${++k}`, usuario: 'teste', fontesPermitidas: null };
  const rodar = async (args: Record<string, unknown>) => (await ferramentas.get('historico_incidentes')!.executar(args, ctx))[0] as any;
  let e = await rodar({ pon: '3', dias: 30 });
  checa('responde quantas vezes a PON caiu', e.ok && e.dados.total === 3, e.dados?.total);
  checa('traz as médias com o que elas significam', !!e.dados.medias.o_que_significam && 'mtta' in e.dados.medias);
  checa('traz o ranking do que mais repete', Array.isArray(e.dados.mais_repetem) && e.dados.mais_repetem.length > 0);
  e = await rodar({ dias: 30 });
  checa('a causa raiz aparece só onde alguém escreveu',
    e.dados.incidentes.some((i: any) => i.causa_raiz) && e.dados.incidentes.some((i: any) => !i.causa_raiz));
  e = await rodar({ pon: '777' });
  checa('sem histórico devolve vazio, sem inventar', e.vazio === true && e.dados.total === 0);
  cfg.definir('incidentes.ativo', false, 'teste');
  e = await rodar({});
  checa('incidentes desligados = fonte indisponível', !e.ok && /desligado/.test(e.erro));
  cfg.definir('incidentes.ativo', true, 'teste');

  console.log('\n─── Rotas ───');
  let r = await api('GET', '/api/historico?dias=30');
  checa('a rota traz incidentes, métricas e recorrência',
    r.status === 200 && r.j.incidentes.length === 5 && !!r.j.metricas && Array.isArray(r.j.recorrencia));
  checa('e as ações pendentes', Array.isArray(r.j.acoes_pendentes) && r.j.acoes_pendentes.length === 1);
  r = await api('GET', '/api/historico?pon=3&dias=30');
  checa('a rota respeita o filtro', r.j.incidentes.length === 3);
  r = await api('GET', `/api/incidentes/${daPon9.numero}/pos`);
  checa('lê o pós-incidente pela rota', r.status === 200 && !!r.j.pos.causa_raiz);
  r = await api('POST', `/api/incidentes/${daPon9.numero}/pos`, { o_que_aconteceu: 'a', causa_raiz: 'b', acoes: [] });
  checa('grava o pós-incidente pela rota', r.status === 200 && r.j.pos.causa_raiz === 'b');
  r = await api('POST', `/api/incidentes/${daPon9.numero}/pos`, { o_que_aconteceu: 'a' });
  checa('pós-incidente sem causa devolve 400 com motivo', r.status === 400 && /causa raiz/.test(r.j.error));
  r = await api('GET', '/api/incidentes/INC-2030-00001/pos');
  checa('incidente inexistente devolve 404', r.status === 404);

  servidor.close();
  fecharDb();
  console.log(`\n${passou} passaram, ${falhou} falharam\n`);
  process.exit(falhou ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
