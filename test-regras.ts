// Testes do motor de regras, do freio de enxurrada (debounce, cooldown,
// teto) e das janelas de manutenção.
//
//   npm run test:regras

import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import type { AddressInfo } from 'net';

for (const k of ['OPENAI_API_KEY', 'SGP_BASE_URL', 'SGP_TOKEN']) {
  process.env[k] ||= 'teste-regras-sem-uso';
}
process.env.TZ ||= 'America/Fortaleza';
const RAIZ = __dirname;
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'aq-regras-')));

/* eslint-disable @typescript-eslint/no-var-requires */
const { db, fecharDb } = require(path.join(RAIZ, 'src', 'assistant', 'store', 'db')) as typeof import('./src/assistant/store/db');
const alertas = require(path.join(RAIZ, 'src', 'assistant', 'alertas')) as typeof import('./src/assistant/alertas');
const regras = require(path.join(RAIZ, 'src', 'assistant', 'regras')) as typeof import('./src/assistant/regras');
const man = require(path.join(RAIZ, 'src', 'assistant', 'manutencao')) as typeof import('./src/assistant/manutencao');
const inc = require(path.join(RAIZ, 'src', 'assistant', 'incidentes')) as typeof import('./src/assistant/incidentes');
const cfg = require(path.join(RAIZ, 'src', 'assistant', 'config-dinamica')) as typeof import('./src/assistant/config-dinamica');
const { evoTecnicos } = require(path.join(RAIZ, 'src', 'assistant', 'channels', 'whatsapp-tecnicos')) as typeof import('./src/assistant/channels/whatsapp-tecnicos');
const { rotasAdmin } = require(path.join(RAIZ, 'src', 'assistant', 'rotas-admin')) as typeof import('./src/assistant/rotas-admin');
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
const enviados: Array<{ para: string; texto: string }> = [];
Object.defineProperty(evoTecnicos, 'disponivel', { get: () => true });
(evoTecnicos as any).enviarTextoComId = async (para: string, texto: string) => {
  enviados.push({ para, texto });
  return { ok: true, id: `MSG${++idMsg}` };
};
(evoTecnicos as any).enviarTexto = async (para: string, texto: string) =>
  (await (evoTecnicos as any).enviarTextoComId(para, texto)).ok;

const servidor = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  rotasAdmin(req, res, url, url.pathname).then((t) => { if (!t) { res.writeHead(404); res.end(); } })
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

let n = 0;
const chave = () => `zabbix:teste${++n}`;
const emitir = (p: Partial<Parameters<typeof alertas.emitir>[0]> = {}) => alertas.emitir({
  origem: 'zabbix', severidade: 'aviso', titulo: 'Porta down', texto: 'Porta down',
  chave: chave(), dados: { host: 'OLT-1' }, ...p,
} as Parameters<typeof alertas.emitir>[0]);

const emJanela = (min: number) => ({
  inicio: new Date(Date.now() - 60_000).toISOString(),
  fim: new Date(Date.now() + min * 60_000).toISOString(),
});

async function main(): Promise<void> {
  db();
  await new Promise<void>((r) => servidor.listen(0, '127.0.0.1', r));
  BASE = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;
  cfg.definir('alertas.destino_grupo', '99999@g.us', 'teste');
  cfg.definir('incidentes.ativo', false, 'teste');

  console.log('\n─── Condições da regra ───');
  checa('regra sem condição é recusada',
    /pelo menos uma condição/.test(erroDe(() => regras.criarRegra({ nome: 'x', acao: 'suprimir', condicoes: [] }, 'teste'))));
  checa('campo inexistente é recusado',
    /campo inválido/.test(erroDe(() => regras.criarRegra({ nome: 'x', acao: 'suprimir', condicoes: [{ campo: 'lua', operador: 'igual', valor: '1' }] }, 'teste'))));
  checa('comparação inexistente é recusada',
    /comparação inválida/.test(erroDe(() => regras.criarRegra({ nome: 'x', acao: 'suprimir', condicoes: [{ campo: 'origem', operador: 'parecido', valor: 'x' }] }, 'teste'))));
  checa('mudar gravidade sem dizer qual é recusado',
    /escolha a gravidade/.test(erroDe(() => regras.criarRegra({ nome: 'x', acao: 'mudar_severidade', condicoes: [{ campo: 'origem', operador: 'igual', valor: 'zabbix' }] }, 'teste'))));
  checa('"entre" precisa dos dois valores',
    /dois valores/.test(erroDe(() => regras.criarRegra({ nome: 'x', acao: 'suprimir', condicoes: [{ campo: 'hora', operador: 'entre', valor: '22:00' }] }, 'teste'))));
  checa('repetição sem janela é recusada',
    /em quantos minutos/.test(erroDe(() => regras.criarRegra({ nome: 'x', acao: 'suprimir', repeticoes: 3, condicoes: [{ campo: 'origem', operador: 'igual', valor: 'zabbix' }] }, 'teste'))));

  const r1 = regras.criarRegra({
    nome: 'Teste de laboratório não avisa', ordem: 10, acao: 'suprimir',
    condicoes: [{ campo: 'titulo', operador: 'contem', valor: 'laboratorio' }],
  }, 'teste');
  checa('regra criada nasce ativa e sem acionamento', r1.ativo && r1.acionada === 0);

  console.log('\n─── Regra decide o destino do alerta ───');
  enviados.length = 0;
  let a = await emitir({ titulo: 'Porta do laboratorio down' });
  checa('suprimir não registra o alerta', a === null && enviados.length === 0);
  checa('a regra conta quantas vezes bateu', regras.regraPorId(r1.id)!.acionada === 1);

  const r2 = regras.criarRegra({
    nome: 'Cliente VIP é sempre crítico', ordem: 20, acao: 'mudar_severidade', severidade: 'critico',
    condicoes: [{ campo: 'titulo', operador: 'contem', valor: 'hospital' }],
  }, 'teste');
  a = await emitir({ titulo: 'Link do hospital down', severidade: 'aviso' });
  checa('mudar gravidade vale para o alerta gravado', a?.severidade === 'critico', a?.severidade);

  regras.criarRegra({
    nome: 'Sinal fraco de madrugada só no painel', ordem: 30, acao: 'so_painel',
    condicoes: [{ campo: 'origem', operador: 'igual', valor: 'ctos' }],
  }, 'teste');
  enviados.length = 0;
  a = await emitir({ origem: 'ctos', titulo: 'CTO com sinal pior' });
  checa('só painel registra sem avisar', !!a && enviados.length === 0 && !a.enviado_em);
  checa('e o painel mostra por que não saiu', /só no painel/.test(a?.envio_erro ?? ''), a?.envio_erro);

  checa('regra desligada não decide nada',
    (regras.atualizarRegra(r2.id, { ativo: false }, 'teste'),
      !regras.regraCasa(regras.regraPorId(r2.id)!, { origem: 'zabbix', chave: 'k', severidade: 'aviso', titulo: 'Link do hospital down', dados: {} })));
  regras.atualizarRegra(r2.id, { ativo: true }, 'teste');
  cfg.definir('regras.ativo', false, 'teste');
  enviados.length = 0;
  a = await emitir({ titulo: 'Porta do laboratorio down' });
  checa('motor desligado ignora todas as regras', !!a && enviados.length > 0);
  cfg.definir('regras.ativo', true, 'teste');

  console.log('\n─── Regra por tempo (repetição) ───');
  const r4 = regras.criarRegra({
    nome: 'Flap: três vezes em 10 min vira crítico', ordem: 40, acao: 'mudar_severidade', severidade: 'critico',
    repeticoes: 3, janela_min: 10,
    condicoes: [{ campo: 'equipamento', operador: 'igual', valor: 'OLT-FLAP' }],
  }, 'teste');
  const fato = { origem: 'zabbix' as const, chave: 'zabbix:flap:1', severidade: 'aviso' as const, titulo: 'flap', dados: { host: 'OLT-FLAP' } };
  checa('sem repetição suficiente a regra não bate', !regras.regraCasa(regras.regraPorId(r4.id)!, fato));
  for (let i = 0; i < 3; i++) {
    await emitir({ chave: `zabbix:flap:${i}`, titulo: 'Porta oscilando', dados: { host: 'OLT-FLAP' } });
  }
  checa('a partir da terceira vez na janela, bate', regras.regraCasa(regras.regraPorId(r4.id)!, fato), regras.repeticoesRecentes(fato, 10));
  checa('a contagem olha só a janela', regras.repeticoesRecentes(fato, 10) >= 3);

  console.log('\n─── Janela de manutenção ───');
  checa('janela sem alvo é recusada',
    /diga qual/.test(erroDe(() => man.criar({ alvo_tipo: 'olt', ...emJanela(60) }, 'teste'))));
  checa('fim antes do início é recusado',
    /depois do início/.test(erroDe(() => man.criar({ alvo_tipo: 'tudo', inicio: new Date(Date.now() + 3600_000).toISOString(), fim: new Date().toISOString() }, 'teste'))));
  const jan = man.criar({ alvo_tipo: 'equipamento', alvo: 'OLT-9', efeito: 'nao_notificar', motivo: 'troca de placa', ...emJanela(60) }, 'teste');
  enviados.length = 0;
  a = await emitir({ titulo: 'OLT 9 sem resposta', dados: { host: 'OLT-9' } });
  checa('dentro da janela registra e não avisa', !!a && enviados.length === 0);
  checa('e diz que foi manutenção, com o motivo', /manutenção/.test(a?.envio_erro ?? '') && /troca de placa/.test(a?.envio_erro ?? ''), a?.envio_erro);
  enviados.length = 0;
  a = await emitir({ titulo: 'OLT 8 sem resposta', dados: { host: 'OLT-8' } });
  checa('equipamento fora da janela continua avisando', enviados.length > 0);

  man.encerrar(jan.id, 'teste');
  enviados.length = 0;
  a = await emitir({ titulo: 'OLT 9 sem resposta de novo', dados: { host: 'OLT-9' } });
  checa('janela encerrada volta a avisar', enviados.length > 0);

  const supressao = man.criar({ alvo_tipo: 'origem', alvo: 'netflow', efeito: 'suprimir', ...emJanela(30) }, 'teste');
  a = await emitir({ origem: 'netflow', titulo: 'Queda de tráfego', dados: {} });
  checa('efeito suprimir não registra nem alerta', a === null);
  man.remover(supressao.id, 'teste');

  const rebaixa = man.criar({ alvo_tipo: 'pon', alvo: '3', efeito: 'rebaixar', ...emJanela(30) }, 'teste');
  a = await emitir({ severidade: 'critico', titulo: 'PON 3 caiu', dados: { pon: 3 } });
  checa('efeito rebaixar entrega como informativo', a?.severidade === 'info', a?.severidade);
  man.remover(rebaixa.id, 'teste');

  const geral = man.criar({ alvo_tipo: 'tudo', efeito: 'nao_notificar', ...emJanela(30) }, 'teste');
  const especifica = man.criar({ alvo_tipo: 'equipamento', alvo: 'OLT-7', efeito: 'manter', ...emJanela(30) }, 'teste');
  enviados.length = 0;
  a = await emitir({ titulo: 'OLT 7 caiu', dados: { host: 'OLT-7' } });
  checa('janela específica vale mais que a janela geral', enviados.length > 0, a?.envio_erro);
  man.remover(especifica.id, 'teste');
  man.remover(geral.id, 'teste');

  console.log('\n─── Cooldown, teto e debounce ───');
  cfg.definir('regras.cooldown_min', 30, 'teste');
  enviados.length = 0;
  await emitir({ chave: 'zabbix:cool:1', titulo: 'Porta X down', dados: { host: 'OLT-C' } });
  const depois = await emitir({ chave: 'zabbix:cool:2', titulo: 'Porta X down de novo', dados: { host: 'OLT-C' } });
  checa('o mesmo problema de novo não vira segunda mensagem', enviados.length === 1, enviados.length);
  checa('e o painel diz quando volta a avisar', /cooldown/.test(depois?.envio_erro ?? ''), depois?.envio_erro);
  const critico = await emitir({ chave: 'zabbix:cool:3', severidade: 'critico', titulo: 'Porta X down crítico', dados: { host: 'OLT-C' } });
  checa('crítico fura o cooldown', !!critico?.enviado_em, critico?.envio_erro);
  cfg.definir('regras.cooldown_min', 0, 'teste');

  cfg.definir('regras.teto_hora', 1, 'teste');
  const acima = await emitir({ titulo: 'Mais um aviso', dados: { host: 'OLT-T' } });
  checa('passado o teto, o aviso fica só no painel', !acima?.enviado_em && /teto de 1/.test(acima?.envio_erro ?? ''), acima?.envio_erro);
  cfg.definir('regras.teto_hora', 0, 'teste');

  cfg.definir('regras.debounce_min', 5, 'teste');
  enviados.length = 0;
  const espera = await emitir({ chave: 'zabbix:deb:1', titulo: 'Talvez volte sozinho', dados: { host: 'OLT-D' } });
  checa('com debounce o aviso não sai na hora', enviados.length === 0 && /debounce/.test(espera?.envio_erro ?? ''), espera?.envio_erro);
  checa('nada a soltar antes da hora', (await alertas.soltarEspera()).enviados === 0);
  const daquiSeisMin = new Date(Date.now() + 6 * 60_000);
  let solta = await alertas.soltarEspera(daquiSeisMin);
  checa('vencida a espera, o aviso sai', solta.enviados === 1 && enviados.length === 1, solta);

  const espera2 = await emitir({ chave: 'zabbix:deb:2', titulo: 'Esse volta sozinho', dados: { host: 'OLT-D2' } });
  alertas.marcarResolvido('zabbix:deb:2');
  enviados.length = 0;
  solta = await alertas.soltarEspera(daquiSeisMin);
  checa('o que normalizou durante a espera não vira mensagem', solta.descartados === 1 && enviados.length === 0, solta);
  checa('e fica registrado que normalizou sozinho',
    /normalizou sozinho/.test(alertas.porId(espera2!.id)?.envio_erro ?? ''), alertas.porId(espera2!.id)?.envio_erro);
  cfg.definir('regras.debounce_min', 0, 'teste');

  const sempre = regras.criarRegra({
    nome: 'Energia do POP avisa sempre', ordem: 1, acao: 'sempre_avisar',
    condicoes: [{ campo: 'titulo', operador: 'contem', valor: 'energia' }],
  }, 'teste');
  cfg.definir('regras.teto_hora', 1, 'teste');
  cfg.definir('alertas.silencio_inicio', '00:00', 'teste');
  cfg.definir('alertas.silencio_fim', '23:59', 'teste');
  enviados.length = 0;
  const prioritario = await emitir({ severidade: 'aviso', titulo: 'Falta de energia no POP centro', dados: { host: 'POP-1' } });
  checa('"avisar sempre" fura silêncio e teto', !!prioritario?.enviado_em && enviados.length === 1, prioritario?.envio_erro);
  cfg.definir('alertas.silencio_inicio', '', 'teste');
  cfg.definir('alertas.silencio_fim', '', 'teste');
  cfg.definir('regras.teto_hora', 0, 'teste');
  void sempre; void inc;

  console.log('\n─── Rotas ───');
  let r = await api('GET', '/api/regras');
  checa('painel lê regras, campos e manutenções',
    r.status === 200 && r.j.regras.length >= 4 && !!r.j.campos.origem && Array.isArray(r.j.manutencoes));
  r = await api('POST', '/api/regras', { nome: 'Pela rota', acao: 'so_painel', condicoes: [{ campo: 'origem', operador: 'igual', valor: 'ura' }] });
  checa('cria regra pela rota', r.status === 201 && !!r.j.regra.id);
  const idRegra = r.j.regra.id;
  r = await api('PUT', `/api/regras/${idRegra}`, { ativo: false });
  checa('desliga a regra sem apagar', r.status === 200 && r.j.regra.ativo === false);
  r = await api('POST', '/api/regras', { nome: 'Sem condição', acao: 'suprimir', condicoes: [] });
  checa('regra inválida devolve 400 com motivo', r.status === 400 && /condição/.test(r.j.error));
  r = await api('DELETE', `/api/regras/${idRegra}`);
  checa('remove a regra', r.status === 200 && regras.regraPorId(idRegra) === null);
  r = await api('POST', '/api/manutencoes', { alvo_tipo: 'olt', alvo: 'OLT-5', efeito: 'nao_notificar', ...emJanela(120) });
  checa('cria janela pela rota', r.status === 201 && !!r.j.manutencao.id);
  const idMan = r.j.manutencao.id;
  r = await api('POST', `/api/manutencoes/${idMan}/encerrar`);
  checa('encerra a janela agora', r.status === 200 && new Date(r.j.manutencao.fim).getTime() <= Date.now() + 1000);
  r = await api('DELETE', `/api/manutencoes/${idMan}`);
  checa('remove a janela', r.status === 200);
  r = await api('DELETE', '/api/manutencoes/00000000-0000-4000-8000-000000000000');
  checa('janela inexistente devolve 404', r.status === 404);

  const trilha = db().prepare(`SELECT acao FROM auditoria WHERE acao LIKE 'regra%' OR acao LIKE 'manutencao%'`).all() as Array<{ acao: string }>;
  checa('tudo que mexe em regra ou janela fica na auditoria',
    trilha.some((x) => x.acao === 'regra.criar') && trilha.some((x) => x.acao === 'manutencao.criar'));

  servidor.close();
  fecharDb();
  console.log(`\n${passou} passaram, ${falhou} falharam\n`);
  process.exit(falhou ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
