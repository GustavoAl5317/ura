// Testes de incidente: correlação, severidade por impacto, dono, linha do
// tempo, normalização com observação, reabertura e comando pelo WhatsApp.
//
//   npm run test:incidentes

import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import type { AddressInfo } from 'net';

for (const k of ['OPENAI_API_KEY', 'SGP_BASE_URL', 'SGP_TOKEN']) {
  process.env[k] ||= 'teste-incidentes-sem-uso';
}
const RAIZ = __dirname;
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'aq-incidentes-')));

/* eslint-disable @typescript-eslint/no-var-requires */
const { db, fecharDb } = require(path.join(RAIZ, 'src', 'assistant', 'store', 'db')) as typeof import('./src/assistant/store/db');
const inc = require(path.join(RAIZ, 'src', 'assistant', 'incidentes')) as typeof import('./src/assistant/incidentes');
const alertas = require(path.join(RAIZ, 'src', 'assistant', 'alertas')) as typeof import('./src/assistant/alertas');
const cfg = require(path.join(RAIZ, 'src', 'assistant', 'config-dinamica')) as typeof import('./src/assistant/config-dinamica');
const canal = require(path.join(RAIZ, 'src', 'assistant', 'channels', 'whatsapp-tecnicos')) as typeof import('./src/assistant/channels/whatsapp-tecnicos');
const { evoTecnicos } = canal;
const mon = require(path.join(RAIZ, 'src', 'assistant', 'monitors', 'incidentes')) as typeof import('./src/assistant/monitors/incidentes');
const { ferramentas } = require(path.join(RAIZ, 'src', 'assistant', 'tools', 'base')) as typeof import('./src/assistant/tools/base');
const { registrarFerramentasIncidentes } = require(path.join(RAIZ, 'src', 'assistant', 'tools', 'incidentes')) as typeof import('./src/assistant/tools/incidentes');
const { rotasOperacao } = require(path.join(RAIZ, 'src', 'assistant', 'rotas-operacao')) as typeof import('./src/assistant/rotas-operacao');
const { ErroHttp } = require(path.join(RAIZ, 'src', 'assistant', 'http-util')) as typeof import('./src/assistant/http-util');
/* eslint-enable @typescript-eslint/no-var-requires */

let passou = 0;
let falhou = 0;
function checa(rotulo: string, ok: boolean, detalhe: unknown = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${rotulo}${ok || detalhe === '' ? '' : `\n      ${typeof detalhe === 'string' ? detalhe : JSON.stringify(detalhe).slice(0, 600)}`}`);
  ok ? passou++ : falhou++;
}

const enviados: Array<{ para: string; texto: string }> = [];
Object.defineProperty(evoTecnicos, 'disponivel', { get: () => true });
(evoTecnicos as any).enviarTexto = async (para: string, texto: string) => { enviados.push({ para, texto }); return true; };
let idDublê = 0;
(evoTecnicos as any).enviarTextoComId = async (para: string, texto: string) =>
  ({ ok: await (evoTecnicos as any).enviarTexto(para, texto), id: `MSG${++idDublê}` });


const servidor = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  rotasOperacao(req, res, url, url.pathname).then((tratou) => {
    if (!tratou) { res.writeHead(404); res.end(); }
  }).catch((err) => {
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

let n = 0;
const alertar = (p: { origem?: any; severidade?: any; titulo?: string; chave?: string; dados?: unknown }) => alertas.emitir({
  origem: p.origem ?? 'zabbix', severidade: p.severidade ?? 'critico',
  titulo: p.titulo ?? `alerta ${++n}`, texto: 'texto do alerta',
  chave: p.chave ?? `k:${n}`, dados: p.dados,
});

async function main() {
  await new Promise<void>((r) => servidor.listen(0, '127.0.0.1', r));
  BASE = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;
  db();
  registrarFerramentasIncidentes();
  cfg.definir('alertas.destino_grupo', '120363@g.us', 'teste');

  console.log('\n─── Classificação ───');
  checa('aviso vira advertência', inc.classificar('aviso', null) === 'advertencia');
  checa('crítico vira crítico', inc.classificar('critico', null) === 'critico');
  checa('50 clientes sobe para maior', inc.classificar('aviso', 50) === 'maior');
  checa('200 clientes sobe para desastre', inc.classificar('aviso', 200) === 'desastre');
  checa('poucos clientes não sobe', inc.classificar('aviso', 3) === 'advertencia');
  checa('maiorSeveridade escolhe a pior', inc.maiorSeveridade('critico', 'atencao') === 'critico');

  console.log('\n─── Alvo da correlação ───');
  checa('CTO com PON agrupa pela PON', inc.extrairAlvo({ origem: 'ctos', chave: 'x', titulo: 't', dados: { pon: '1/1/6', cto_id: 5 } }).correlacao === 'pon:1/1/6');
  checa('Zabbix agrupa pelo equipamento', inc.extrairAlvo({ origem: 'zabbix', chave: 'x', titulo: 't', dados: { host: 'OLT-3' } }).correlacao === 'host:OLT-3');
  checa('impacto lido do alerta da CTO', inc.extrairAlvo({ origem: 'zabbix', chave: 'x', titulo: 't', dados: { impacto: { clientes: 34 } } }).clientes === 34);

  console.log('\n─── Abrir e agrupar ───');
  const a1 = await alertar({ titulo: 'PON 1/1/6 sem sinal', origem: 'ctos', chave: 'cto:1', dados: { pon: '1/1/6', host: 'OLT-3', impacto: { clientes: 12 } } });
  const i1 = inc.porId((await api('GET', '/api/incidentes?abertos=1')).j.incidentes[0].numero)!;
  checa('primeiro alerta abre incidente numerado', /^INC-\d{4}-\d{5}$/.test(i1.numero), i1.numero);
  checa('guarda alvo, equipamento e clientes', i1.correlacao === 'pon:1/1/6' && i1.equipamento === 'OLT-3' && i1.clientes_afetados === 12, i1);
  checa('mensagem do alerta leva o número e como assumir', /INC-\d{4}-\d{5}/.test(enviados[0]?.texto ?? '') && /assumir/.test(enviados[0]?.texto ?? ''), enviados[0]?.texto);

  const a2 = await alertar({ titulo: 'Outra CTO da mesma PON', origem: 'ctos', chave: 'cto:2', dados: { pon: '1/1/6', host: 'OLT-3', impacto: { clientes: 60 } } });
  const depois = inc.porId(i1.id)!;
  checa('segundo alerta da mesma PON entra no mesmo incidente', inc.listar({ abertos: true }).length === 1 && depois.alertas === 2, inc.listar({ abertos: true }));
  checa('severidade sobe com o impacto (60 clientes = maior)', depois.severidade === 'maior', depois.severidade);
  checa('registra a subida na linha do tempo', inc.linhaDoTempo(i1.id).some((l) => l.tipo === 'severidade'), inc.linhaDoTempo(i1.id).map((l) => l.tipo));

  await alertar({ titulo: 'Outro equipamento', origem: 'zabbix', chave: 'zbx:outro', dados: { host: 'OLT-1' } });
  checa('alvo diferente abre outro incidente', inc.listar({ abertos: true }).length === 2);

  console.log('\n─── O que não vira incidente ───');
  const antes = inc.listar({ limite: 500 }).length;
  await alertas.emitir({ origem: 'ura', severidade: 'info', evento: true, titulo: 'Chamada', texto: 'x', chave: 'ura:1' });
  await alertar({ origem: 'zabbix', severidade: 'info', chave: 'zbx:info' });
  checa('chamada da URA e alerta informativo não abrem incidente', inc.listar({ limite: 500 }).length === antes, inc.listar({ limite: 500 }).length - antes);
  cfg.definir('incidentes.ativo', false, 'teste');
  await alertar({ chave: 'zbx:desligado', dados: { host: 'OLT-9' } });
  checa('com o recurso desligado, nada é criado', inc.listar({ limite: 500 }).length === antes);
  cfg.definir('incidentes.ativo', true, 'teste');

  console.log('\n─── Dono e estado ───');
  let r = await api('POST', `/api/incidentes/${i1.numero}/assumir`, { quem: 'João' });
  checa('assumir grava dono e reconhecimento', r.status === 200 && r.j.incidente.dono === 'João' && !!r.j.incidente.reconhecido_em, r.j?.incidente);
  checa('estado vira reconhecido', inc.porId(i1.id)!.estado === 'reconhecido');
  checa('tempo até assumir é medido', inc.tempoAteReconhecer(inc.porId(i1.id)!) !== null);
  r = await api('POST', `/api/incidentes/${i1.numero}/assumir`, { quem: 'Maria' });
  checa('passar para outro registra transferência', r.j.incidente.dono === 'Maria' && inc.linhaDoTempo(i1.id).some((l) => l.tipo === 'transferido'));
  checa('quem reconheceu primeiro continua registrado', inc.porId(i1.id)!.reconhecido_por === 'João');
  r = await api('POST', `/api/incidentes/${i1.numero}/estado`, { estado: 'atendimento', nota: 'equipe a caminho' });
  checa('muda estado com nota', r.j.incidente.estado === 'atendimento' && inc.linhaDoTempo(i1.id).some((l) => /equipe a caminho/.test(l.texto)));
  r = await api('POST', `/api/incidentes/${i1.numero}/estado`, { estado: 'voando' });
  checa('estado inventado é recusado', r.status === 400, r.j);
  r = await api('POST', `/api/incidentes/${i1.numero}/comentario`, { texto: 'fibra rompida na av. principal' });
  checa('comentário entra na linha do tempo com autor', r.status === 200 && r.j.linha_do_tempo.some((l: any) => l.tipo === 'comentario' && l.ator === 'painel:ana'));

  console.log('\n─── Normalização e reabertura ───');
  alertas.marcarResolvido('cto:1');
  checa('um alerta resolvido não fecha o incidente', inc.porId(i1.id)!.estado === 'atendimento', inc.porId(i1.id)!.estado);
  alertas.marcarResolvido('cto:2');
  checa('todos resolvidos: entra em observação', inc.porId(i1.id)!.estado === 'monitorando' && !!inc.porId(i1.id)!.normalizado_em);
  checa('não encerra antes do tempo', mon.cicloIncidentes !== undefined && inc.encerrarEstaveis(new Date()).length === 0);

  await alertar({ titulo: 'PON caiu de novo', origem: 'ctos', chave: 'cto:3', dados: { pon: '1/1/6', host: 'OLT-3' } });
  const reaberto = inc.porId(i1.id)!;
  checa('cair durante a observação REABRE o mesmo incidente', reaberto.estado === 'aberto' && reaberto.reaberturas === 1 && inc.listar({ abertos: true }).length === 2, { reaberto: reaberto.numero, abertos: inc.listar({ abertos: true }).length });
  checa('reabertura fica na linha do tempo', inc.linhaDoTempo(i1.id).some((l) => l.tipo === 'reaberto'));

  alertas.marcarResolvido('cto:3');
  checa('normaliza de novo', inc.porId(i1.id)!.estado === 'monitorando');
  const futuro = new Date(Date.now() + 6 * 60_000);
  const fechados = inc.encerrarEstaveis(futuro);
  checa('estável pelo tempo configurado: encerra', fechados.length === 1 && inc.porId(i1.id)!.estado === 'encerrado', fechados.map((f) => f.numero));
  checa('duração medida do começo ao fim', inc.duracaoSeg(inc.porId(i1.id)!) >= 0);
  checa('encerrado sai da lista de abertos', !inc.listar({ abertos: true }).some((x) => x.id === i1.id));

  enviados.length = 0;
  const outro = await alertar({ titulo: 'Para encerrar', origem: 'zabbix', chave: 'zbx:fim', dados: { host: 'CORE-1' } });
  alertas.marcarResolvido('zbx:fim');
  const c = await mon.cicloIncidentes();
  checa('monitor não encerra antes da estabilidade', c.alertas === 0 && (c.detalhe.em_observacao as number) >= 1, c.detalhe);

  console.log('\n─── Comando pelo WhatsApp ───');
  const cmd = canal.comandoDeIncidente('assumir INC-2026-00002');
  checa('entende "assumir INC-..."', cmd?.acao === 'assumir' && cmd.numero === 'INC-2026-00002', cmd);
  checa('entende só o número', canal.comandoDeIncidente('assumir 2')?.numero === '2');
  checa('entende "peguei"', canal.comandoDeIncidente('peguei o incidente 3')?.acao === 'assumir');
  checa('entende "em atendimento"', canal.comandoDeIncidente('em atendimento 3')?.acao === 'atendendo');
  checa('entende "encerrar"', canal.comandoDeIncidente('encerrar INC-2026-00003')?.acao === 'encerrar');
  checa('pergunta comum não é comando', canal.comandoDeIncidente('quais incidentes estão abertos?') === null);
  checa('sem número não é comando', canal.comandoDeIncidente('assumir') === null);

  const abertoAgora = inc.listar({ abertos: true })[0];
  const resposta = canal.executarComandoIncidente({ acao: 'assumir', numero: abertoAgora.numero }, 'Pedro');
  checa('assumir pelo WhatsApp funciona e responde', /é seu, Pedro/.test(resposta) && inc.porId(abertoAgora.id)!.dono === 'Pedro', resposta);
  checa('número que não existe responde sem inventar', /Não achei o incidente/.test(canal.executarComandoIncidente({ acao: 'assumir', numero: 'INC-2030-09999' }, 'Pedro')));

  console.log('\n─── Ferramenta da IA ───');
  let k = 0;
  const ctx = { proximoId: () => `evd_${++k}`, usuario: 'teste', fontesPermitidas: null };
  const rodar = async (args: Record<string, unknown>) => (await ferramentas.get('incidentes')!.executar(args, ctx))[0] as any;
  let e = await rodar({});
  checa('lista abertos com total e sem dono', e.ok && e.dados.total >= 1 && typeof e.dados.sem_dono === 'number', e.dados);
  checa('traz dono e há quanto tempo', e.dados.incidentes[0].aberto_ha.length > 0 && 'dono' in e.dados.incidentes[0]);
  e = await rodar({ numero: abertoAgora.numero });
  checa('um incidente traz linha do tempo e alertas', e.dados.numero === abertoAgora.numero && e.dados.linha_do_tempo.length > 0, Object.keys(e.dados));
  e = await rodar({ numero: 'INC-2030-00001' });
  checa('número inexistente: vazio e instrução de não inventar', e.vazio && /Não invente/.test(e.dados.instrucao));
  e = await rodar({ sem_dono: true });
  checa('filtro sem dono só traz quem não tem', e.dados.incidentes.every((x: any) => !x.dono), e.dados.incidentes.map((x: any) => x.dono));
  cfg.definir('incidentes.ativo', false, 'teste');
  e = await rodar({});
  checa('recurso desligado = fonte indisponível, não "zero incidentes"', !e.ok && /desligado/.test(e.erro), e);
  cfg.definir('incidentes.ativo', true, 'teste');

  console.log('\n─── Rotas ───');
  r = await api('GET', '/api/incidentes?abertos=1');
  checa('lista com rótulos de estado e severidade', r.status === 200 && !!r.j.estados.aberto && !!r.j.severidades.maior);
  r = await api('GET', `/api/incidentes/${abertoAgora.numero}`);
  checa('detalhe traz linha do tempo e alertas ligados', r.status === 200 && Array.isArray(r.j.linha_do_tempo) && Array.isArray(r.j.alertas));
  r = await api('GET', '/api/incidentes/INC-2030-00001');
  checa('inexistente = 404', r.status === 404);

  servidor.close();
  fecharDb();
  console.log(`\n${passou} passaram, ${falhou} falharam\n`);
  process.exit(falhou ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
