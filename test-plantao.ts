// Testes de plantão: turno, rotação, folga, troca, plantão extraordinário,
// cadeia de acionamento, escolha de equipe por tipo e região, e a marca do
// plantão no incidente.
//
//   npm run test:plantao

import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import type { AddressInfo } from 'net';

for (const k of ['OPENAI_API_KEY', 'SGP_BASE_URL', 'SGP_TOKEN']) {
  process.env[k] ||= 'teste-plantao-sem-uso';
}
process.env.TZ ||= 'America/Fortaleza';
const RAIZ = __dirname;
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'aq-plantao-')));

/* eslint-disable @typescript-eslint/no-var-requires */
const { db, fecharDb } = require(path.join(RAIZ, 'src', 'assistant', 'store', 'db')) as typeof import('./src/assistant/store/db');
const pl = require(path.join(RAIZ, 'src', 'assistant', 'plantao')) as typeof import('./src/assistant/plantao');
const inc = require(path.join(RAIZ, 'src', 'assistant', 'incidentes')) as typeof import('./src/assistant/incidentes');
const alertas = require(path.join(RAIZ, 'src', 'assistant', 'alertas')) as typeof import('./src/assistant/alertas');
const cfg = require(path.join(RAIZ, 'src', 'assistant', 'config-dinamica')) as typeof import('./src/assistant/config-dinamica');
const { evoTecnicos } = require(path.join(RAIZ, 'src', 'assistant', 'channels', 'whatsapp-tecnicos')) as typeof import('./src/assistant/channels/whatsapp-tecnicos');
const { ferramentas } = require(path.join(RAIZ, 'src', 'assistant', 'tools', 'base')) as typeof import('./src/assistant/tools/base');
const { registrarFerramentasPlantao } = require(path.join(RAIZ, 'src', 'assistant', 'tools', 'plantao')) as typeof import('./src/assistant/tools/plantao');
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

// ── WhatsApp dublê ───────────────────────────────────────────────────────────
const enviados: Array<{ para: string; texto: string }> = [];
Object.defineProperty(evoTecnicos, 'disponivel', { get: () => true });
(evoTecnicos as any).enviarTexto = async (para: string, texto: string) => { enviados.push({ para, texto }); return true; };

// ── Painel ───────────────────────────────────────────────────────────────────
const servidor = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  rotasAdmin(req, res, url, url.pathname)
    .then((tratou) => (tratou ? true : rotasOperacao(req, res, url, url.pathname)))
    .then((tratou) => { if (!tratou) { res.writeHead(404); res.end(); } })
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

/** Pessoa = linha de "Quem recebe alertas". */
function pessoa(nome: string, numero: string, ativo = true): number {
  const r = db().prepare(
    `INSERT INTO alerta_destino (nome, numero, tipos, severidade_minima, ativo, criado_em) VALUES (?,?,?,?,?,?)`,
  ).run(nome, numero, JSON.stringify(['rede']), 'aviso', ativo ? 1 : 0, new Date().toISOString());
  return Number(r.lastInsertRowid);
}

function equipe(id: string, nome: string): void {
  db().prepare(`INSERT INTO equipe (id, nome, fontes, ativo, criado_em) VALUES (?,?,?,?,?)`)
    .run(id, nome, null, 1, new Date().toISOString());
}

/** Instante em hora local de Fortaleza (UTC-3), para turno não depender de "agora". */
function local(dia: string, hm: string): Date {
  return new Date(`${dia}T${hm}:00-03:00`);
}

async function main(): Promise<void> {
  db();
  await new Promise<void>((r) => servidor.listen(0, '127.0.0.1', r));
  BASE = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;

  const ana = pessoa('Ana', '5585900000001@s.whatsapp.net');
  const bruno = pessoa('Bruno', '5585900000002@s.whatsapp.net');
  const caio = pessoa('Caio', '5585900000003@s.whatsapp.net');
  const dora = pessoa('Dora', '5585900000004@s.whatsapp.net');
  const elias = pessoa('Elias', '5585900000005@s.whatsapp.net');
  const gerente = pessoa('Gerente', '5585900000009@s.whatsapp.net');
  equipe('noc', 'NOC');
  equipe('campo', 'Campo');

  console.log('\n─── Cadastro da escala ───');
  checa('equipe inexistente é recusada',
    /equipe inexistente/.test(erroDe(() => pl.criarEscala({ equipe_id: 'nao-existe', nome: 'x', hora_inicio: '08:00', hora_fim: '18:00', dias: [1], pessoas: [ana] }, 'teste'))));
  checa('turno sem nome é recusado',
    /nome ao turno/.test(erroDe(() => pl.criarEscala({ equipe_id: 'noc', nome: ' ', hora_inicio: '08:00', hora_fim: '18:00', dias: [1], pessoas: [ana] }, 'teste'))));
  checa('horário fora do formato é recusado',
    /HH:MM/.test(erroDe(() => pl.criarEscala({ equipe_id: 'noc', nome: 'x', hora_inicio: '8h', hora_fim: '18:00', dias: [1], pessoas: [ana] }, 'teste'))));
  checa('escala sem dia é recusada',
    /dia da semana/.test(erroDe(() => pl.criarEscala({ equipe_id: 'noc', nome: 'x', hora_inicio: '08:00', hora_fim: '18:00', dias: [], pessoas: [ana] }, 'teste'))));
  checa('escala sem pessoa é recusada',
    /pelo menos uma pessoa/.test(erroDe(() => pl.criarEscala({ equipe_id: 'noc', nome: 'x', hora_inicio: '08:00', hora_fim: '18:00', dias: [1], pessoas: [] }, 'teste'))));
  checa('pessoa que não está no cadastro é recusada',
    /não está cadastrada/.test(erroDe(() => pl.criarEscala({ equipe_id: 'noc', nome: 'x', hora_inicio: '08:00', hora_fim: '18:00', dias: [1], pessoas: [9999] }, 'teste'))));
  checa('ciclo de rotação fora da faixa é recusado',
    /1 a 90/.test(erroDe(() => pl.criarEscala({ equipe_id: 'noc', nome: 'x', hora_inicio: '08:00', hora_fim: '18:00', dias: [1], pessoas: [ana], rotacao_dias: 0 }, 'teste'))));

  console.log('\n─── Turno ───');
  // 2026-09-28 é segunda-feira.
  const comercial = pl.criarEscala({
    equipe_id: 'noc', nome: 'Comercial', tipo: 'fixa', dias: [1, 2, 3, 4, 5],
    hora_inicio: '08:00', hora_fim: '18:00', pessoas: [ana, bruno],
  }, 'teste');
  checa('dentro da janela o turno está ativo', !!pl.turnoAtivo(comercial, local('2026-09-28', '09:00')));
  checa('antes do início não está', !pl.turnoAtivo(comercial, local('2026-09-28', '07:59')));
  checa('no minuto do fim já não está', !pl.turnoAtivo(comercial, local('2026-09-28', '18:00')));
  checa('sábado não é dia dessa escala', !pl.turnoAtivo(comercial, local('2026-09-26', '09:00')));
  checa('o turno traz o dia em que começou', pl.turnoAtivo(comercial, local('2026-09-28', '09:00'))!.dia === '2026-09-28');

  const noturno = pl.criarEscala({
    equipe_id: 'noc', nome: 'Noturno', tipo: 'fixa', dias: [0, 1, 2, 3, 4, 5, 6],
    hora_inicio: '22:00', hora_fim: '06:00', pessoas: [caio],
  }, 'teste');
  checa('turno da noite vale às 23:00', !!pl.turnoAtivo(noturno, local('2026-09-28', '23:00')));
  checa('turno da noite vale às 02:00 da madrugada seguinte', !!pl.turnoAtivo(noturno, local('2026-09-29', '02:00')));
  checa('às 02:00 o turno ainda é o que começou ontem',
    pl.turnoAtivo(noturno, local('2026-09-29', '02:00'))!.dia === '2026-09-28');
  checa('turno da noite não vale às 10:00', !pl.turnoAtivo(noturno, local('2026-09-29', '10:00')));
  checa('turno que vira o dia é marcado como tal', pl.turnoAtivo(noturno, local('2026-09-28', '23:00'))!.vira_o_dia);

  const vintequatro = pl.criarEscala({
    equipe_id: 'campo', nome: '24 horas', tipo: 'rotativa', dias: [0, 1, 2, 3, 4, 5, 6],
    hora_inicio: '00:00', hora_fim: '00:00', pessoas: [dora, elias], rotacao_dias: 7, ancora: '2026-09-07',
  }, 'teste');
  checa('início igual ao fim é turno de 24 horas', !!pl.turnoAtivo(vintequatro, local('2026-09-28', '03:00')) && !!pl.turnoAtivo(vintequatro, local('2026-09-28', '21:00')));
  checa('escala desligada não tem turno ativo',
    !pl.turnoAtivo({ ...comercial, ativo: false }, local('2026-09-28', '09:00')));

  console.log('\n─── Rotação ───');
  const tres = pl.criarEscala({
    equipe_id: 'campo', nome: 'Sobreaviso', tipo: 'rotativa', dias: [0, 1, 2, 3, 4, 5, 6],
    hora_inicio: '00:00', hora_fim: '00:00', pessoas: [ana, bruno, caio], rotacao_dias: 7, ancora: '2026-09-07',
  }, 'teste');
  checa('na semana da âncora a vez é do primeiro', pl.indiceRotacao(tres, '2026-09-07') === 0);
  checa('último dia da primeira semana ainda é do primeiro', pl.indiceRotacao(tres, '2026-09-13') === 0);
  checa('semana seguinte passa para o segundo', pl.indiceRotacao(tres, '2026-09-14') === 1);
  checa('terceira semana é do terceiro', pl.indiceRotacao(tres, '2026-09-21') === 2);
  checa('quarta semana volta para o primeiro', pl.indiceRotacao(tres, '2026-09-28') === 0);
  checa('antes da âncora a conta não quebra', pl.indiceRotacao(tres, '2026-09-01') === 2);
  checa('rotativa põe uma pessoa por vez',
    pl.plantonistasDoTurno(tres, '2026-09-14', local('2026-09-14', '10:00')).plantonistas.map((p) => p.nome).join() === 'Bruno');
  checa('fixa põe todo mundo da fila',
    pl.plantonistasDoTurno(comercial, '2026-09-28', local('2026-09-28', '09:00')).plantonistas.map((p) => p.nome).join() === 'Ana,Bruno');

  console.log('\n─── Folga, férias e troca ───');
  checa('troca sem substituto é recusada',
    /precisa de um substituto/.test(erroDe(() => pl.criarExcecao({ tipo: 'troca', pessoa_id: ana, inicio: '2026-09-28T00:00:00Z', fim: '2026-09-29T00:00:00Z' }, 'teste'))));
  checa('fim antes do início é recusado',
    /depois do início/.test(erroDe(() => pl.criarExcecao({ tipo: 'folga', pessoa_id: ana, inicio: '2026-09-29T00:00:00Z', fim: '2026-09-28T00:00:00Z' }, 'teste'))));
  checa('ninguém é substituto de si mesmo',
    /de si mesma/.test(erroDe(() => pl.criarExcecao({ tipo: 'troca', pessoa_id: ana, substituto_id: ana, inicio: '2026-09-28T00:00:00Z', fim: '2026-09-29T00:00:00Z' }, 'teste'))));
  checa('plantão extraordinário sem equipe é recusado',
    /precisa da equipe/.test(erroDe(() => pl.criarExcecao({ tipo: 'extra', pessoa_id: ana, inicio: '2026-09-28T00:00:00Z', fim: '2026-09-29T00:00:00Z' }, 'teste'))));

  const folgaBruno = pl.criarExcecao({
    tipo: 'folga', pessoa_id: bruno, inicio: local('2026-09-14', '00:00').toISOString(),
    fim: local('2026-09-15', '00:00').toISOString(), motivo: 'folga combinada',
  }, 'teste');
  let cob = pl.plantonistasDoTurno(tres, '2026-09-14', local('2026-09-14', '10:00'));
  checa('quem está de folga sai da vez', !cob.plantonistas.some((p) => p.id === bruno));
  checa('sem substituto, a rotação anda para o próximo', cob.plantonistas.map((p) => p.nome).join() === 'Caio', cob.plantonistas);
  checa('a substituição fica registrada com o motivo',
    cob.substituicoes.some((s) => s.de.nome === 'Bruno' && s.para === null && s.motivo === 'folga combinada'), cob.substituicoes);

  pl.removerExcecao(folgaBruno.id, 'teste');
  const trocaBruno = pl.criarExcecao({
    tipo: 'troca', pessoa_id: bruno, substituto_id: dora,
    inicio: local('2026-09-14', '00:00').toISOString(), fim: local('2026-09-15', '00:00').toISOString(),
  }, 'teste');
  cob = pl.plantonistasDoTurno(tres, '2026-09-14', local('2026-09-14', '10:00'));
  checa('na troca, o substituto assume a vez', cob.plantonistas.map((p) => p.nome).join() === 'Dora', cob.plantonistas);
  checa('a troca aparece como quem saiu e quem entrou',
    cob.substituicoes.some((s) => s.de.nome === 'Bruno' && s.para?.nome === 'Dora'));
  checa('fora da janela da troca, a vez volta a ser de quem estava escalado',
    pl.plantonistasDoTurno(tres, '2026-09-21', local('2026-09-21', '10:00')).plantonistas.map((p) => p.nome).join() === 'Caio');
  pl.removerExcecao(trocaBruno.id, 'teste');

  const inativo = pessoa('Inativo', '5585900000010@s.whatsapp.net', false);
  const soInativo = pl.criarEscala({
    equipe_id: 'campo', nome: 'Só inativo', tipo: 'fixa', dias: [0, 1, 2, 3, 4, 5, 6],
    hora_inicio: '00:00', hora_fim: '00:00', pessoas: [inativo],
  }, 'teste');
  cob = pl.plantonistasDoTurno(soInativo, '2026-09-28', local('2026-09-28', '10:00'));
  checa('pessoa desativada no painel não entra de plantão', cob.plantonistas.length === 0);
  checa('e o motivo diz que o cadastro está desativado', /desativado/.test(cob.substituicoes[0]?.motivo ?? ''));
  pl.removerEscala(soInativo.id, 'teste');

  console.log('\n─── Plantão da equipe ───');
  let p = pl.plantaoDaEquipe('noc', local('2026-09-28', '09:00'))!;
  checa('plantão do horário comercial traz a dupla', p.plantonistas.map((x) => x.nome).join() === 'Ana,Bruno');
  checa('sem lacuna, não está descoberta', !p.vazio && p.motivo_vazio === null);
  p = pl.plantaoDaEquipe('noc', local('2026-09-28', '23:00'))!;
  checa('à noite a vez é de quem está no turno noturno', p.plantonistas.map((x) => x.nome).join() === 'Caio');
  p = pl.plantaoDaEquipe('noc', local('2026-09-27', '12:00'))!;
  checa('domingo de dia ninguém está de plantão no NOC', p.vazio);
  checa('e o painel diz por quê', /nenhum turno/.test(p.motivo_vazio ?? ''), p.motivo_vazio);
  checa('o próximo turno é anunciado com quem assume',
    !!p.proximo && p.proximo.turno.nome === 'Noturno' && p.proximo.plantonistas[0].nome === 'Caio', p.proximo);

  const extra = pl.criarExcecao({
    tipo: 'extra', pessoa_id: elias, equipe_id: 'noc',
    inicio: local('2026-09-27', '10:00').toISOString(), fim: local('2026-09-27', '16:00').toISOString(),
    motivo: 'mutirão',
  }, 'teste');
  p = pl.plantaoDaEquipe('noc', local('2026-09-27', '12:00'))!;
  checa('plantão extraordinário cobre a lacuna', !p.vazio && p.plantonistas.map((x) => x.nome).join() === 'Elias');
  checa('e aparece separado como extraordinário', p.extras.map((x) => x.nome).join() === 'Elias');
  pl.removerExcecao(extra.id, 'teste');

  equipe('suporte', 'Suporte');
  checa('equipe sem escala aparece descoberta com o motivo certo',
    /não tem escala/.test(pl.plantaoDaEquipe('suporte', local('2026-09-28', '09:00'))!.motivo_vazio ?? ''));

  console.log('\n─── Cadeia de acionamento ───');
  pl.atualizarEquipe('noc', { supervisor_id: dora, substituto_id: elias, escalonamento: ['campo'] }, 'teste');
  cfg.definir('plantao.gerencia', [String(gerente)], 'teste');
  let c = pl.cadeia('noc', local('2026-09-28', '09:00'));
  checa('a cadeia começa no plantonista', c[0].nivel === 'plantonista' && c[0].pessoas.map((x) => x.nome).join() === 'Ana,Bruno');
  checa('depois o substituto da equipe', c[1].nivel === 'substituto' && c[1].pessoas[0].nome === 'Elias');
  checa('depois o supervisor', c[2].nivel === 'supervisor' && c[2].pessoas[0].nome === 'Dora');
  checa('depois o segundo nível, com o nome da outra equipe',
    c[3].nivel === 'segundo_nivel' && c[3].equipe === 'campo' && /Campo/.test(c[3].rotulo));
  checa('a gerência fecha a cadeia', c[c.length - 1].nivel === 'gerencia' && c[c.length - 1].pessoas[0].nome === 'Gerente');
  c = pl.cadeia('suporte', local('2026-09-28', '09:00'));
  checa('degrau sem ninguém continua na lista, em vez de sumir',
    c[0].pessoas.length === 0 && c[1].pessoas.length === 0);
  checa('o primeiro degrau com gente é o que vale',
    pl.primeiroDegrauComGente('suporte', local('2026-09-28', '09:00'))?.nivel === 'gerencia');
  checa('equipe não pode escalar para si mesma',
    /para ela mesma/.test(erroDe(() => pl.atualizarEquipe('noc', { escalonamento: ['noc'] }, 'teste'))));

  console.log('\n─── Equipe por tipo, gravidade e região ───');
  pl.atualizarEquipe('campo', { tipos: ['ctos'], regiao: 'Maracanaú', severidade_minima: 'aviso' }, 'teste');
  pl.atualizarEquipe('noc', { tipos: ['rede'], severidade_minima: 'aviso' }, 'teste');
  pl.atualizarEquipe('suporte', { tipos: ['rede'], severidade_minima: 'critico' }, 'teste');
  let escolhidas = pl.equipesParaAlerta({ tipo: 'rede', severidade: 'aviso' }).map((e) => e.id);
  checa('só as equipes do tipo entram', escolhidas.includes('noc') && !escolhidas.includes('campo'), escolhidas);
  checa('gravidade abaixo do mínimo da equipe fica de fora', !escolhidas.includes('suporte'), escolhidas);
  escolhidas = pl.equipesParaAlerta({ tipo: 'rede', severidade: 'critico' }).map((e) => e.id);
  checa('crítico alcança a equipe de exceção', escolhidas.includes('suporte'));
  escolhidas = pl.equipesParaAlerta({ tipo: 'ctos', severidade: 'aviso', regiao: 'Maracanaú' }).map((e) => e.id);
  checa('equipe de região só entra quando a região casa', escolhidas.includes('campo'));
  escolhidas = pl.equipesParaAlerta({ tipo: 'ctos', severidade: 'aviso', regiao: 'Sobral' }).map((e) => e.id);
  checa('região diferente não aciona a equipe daquela região', !escolhidas.includes('campo'), escolhidas);
  escolhidas = pl.equipesParaAlerta({ tipo: 'ctos', severidade: 'aviso' }).map((e) => e.id);
  checa('sem região no alerta, a equipe regional não é escolhida às cegas', !escolhidas.includes('campo'), escolhidas);
  checa('tipo inválido é recusado', /tipo de alerta inválido/.test(erroDe(() => pl.atualizarEquipe('noc', { tipos: ['foguete'] }, 'teste'))));
  checa('gravidade inválida é recusada', /gravidade inválida/.test(erroDe(() => pl.atualizarEquipe('noc', { severidade_minima: 'urgentissimo' }, 'teste'))));

  checa('plantão desligado no painel não escolhe ninguém',
    (cfg.definir('plantao.ativo', false, 'teste'), pl.plantaoParaAlerta({ tipo: 'rede', severidade: 'critico' }) === null));
  cfg.definir('plantao.ativo', true, 'teste');
  checa('ligado, escolhe a equipe do tipo',
    pl.plantaoParaAlerta({ tipo: 'rede', severidade: 'critico' }, local('2026-09-28', '09:00'))?.equipe.id === 'noc');
  checa('o aviso do alerta diz quem está na vez',
    /^Plantão NOC: Ana, Bruno$/.test(pl.avisoDePlantao('noc', local('2026-09-28', '09:00')) ?? ''), pl.avisoDePlantao('noc', local('2026-09-28', '09:00')));
  checa('equipe descoberta vira aviso, não silêncio',
    /ninguém na vez/.test(pl.avisoDePlantao('suporte', local('2026-09-28', '09:00')) ?? ''), pl.avisoDePlantao('suporte', local('2026-09-28', '09:00')));

  console.log('\n─── Marca no incidente e no alerta ───');
  // Escala que cobre qualquer instante, para o alerta de agora cair no NOC.
  pl.criarEscala({
    equipe_id: 'noc', nome: 'Cobertura total', tipo: 'fixa', dias: [0, 1, 2, 3, 4, 5, 6],
    hora_inicio: '00:00', hora_fim: '00:00', pessoas: [ana],
  }, 'teste');
  const a = await alertas.emitir({
    origem: 'zabbix', severidade: 'critico', titulo: 'OLT 3 sem resposta',
    texto: 'OLT 3 sem resposta', chave: 'zabbix:olt3', dados: { host: 'OLT-3', clientes_afetados: 12 },
  });
  const incidente = inc.listar({ abertos: true })[0];
  checa('o incidente nasce com a equipe de plantão', incidente.equipe === 'noc', incidente.equipe);
  checa('a linha do tempo registra quem estava na vez',
    inc.linhaDoTempo(incidente.id).some((l) => l.tipo === 'plantao' && /Ana/.test(l.texto)));
  checa('a mensagem do alerta carrega o plantão', /Plantão NOC: Ana/.test(a?.texto ?? ''), a?.texto);
  cfg.definir('plantao.avisar_no_alerta', false, 'teste');
  const b2 = await alertas.emitir({
    origem: 'zabbix', severidade: 'critico', titulo: 'OLT 4 sem resposta',
    texto: 'OLT 4 sem resposta', chave: 'zabbix:olt4', dados: { host: 'OLT-4' },
  });
  checa('desligado o aviso, a mensagem volta a ser só o incidente', !/Plantão/.test(b2?.texto ?? ''), b2?.texto);
  cfg.definir('plantao.avisar_no_alerta', true, 'teste');

  console.log('\n─── Ferramenta da IA ───');
  registrarFerramentasPlantao();
  let k = 0;
  const ctx = { proximoId: () => `evd_${++k}`, usuario: 'teste', fontesPermitidas: null };
  const rodar = async (args: Record<string, unknown>) => (await ferramentas.get('plantao')!.executar(args, ctx))[0] as any;
  let e = await rodar({});
  checa('lista as equipes com quem está na vez', e.ok && e.dados.equipes.some((x: any) => x.equipe === 'NOC' && x.de_plantao_agora.length), e.dados.equipes);
  checa('diz quais equipes estão descobertas', e.dados.equipes_descobertas.includes('Suporte'), e.dados.equipes_descobertas);
  e = await rodar({ equipe: 'NOC', cadeia: true });
  checa('com cadeia, traz os degraus em ordem', Array.isArray(e.dados.cadeia.NOC) && e.dados.cadeia.NOC[0].ordem === 1);
  e = await rodar({ equipe: 'equipe-que-nao-existe' });
  checa('equipe inexistente devolve vazio, sem inventar', e.vazio && e.dados.encontrada === false);
  cfg.definir('plantao.ativo', false, 'teste');
  e = await rodar({});
  checa('plantão desligado = fonte indisponível, não "ninguém de plantão"', !e.ok && /desligado/.test(e.erro), e);
  cfg.definir('plantao.ativo', true, 'teste');

  console.log('\n─── Rotas ───');
  let r = await api('GET', '/api/plantao');
  checa('painel lê o plantão de agora com a cadeia', r.status === 200 && r.j.ativo === true && Array.isArray(r.j.equipes[0].cadeia));
  r = await api('GET', '/api/plantao/cadastro');
  checa('cadastro traz equipes, pessoas, escalas e ausências',
    r.status === 200 && r.j.equipes.length >= 3 && r.j.pessoas.length >= 6 && Array.isArray(r.j.escalas) && Array.isArray(r.j.excecoes));
  r = await api('POST', '/api/plantao/escalas', { equipe_id: 'suporte', nome: 'Diurno', tipo: 'fixa', dias: [1, 2, 3], hora_inicio: '08:00', hora_fim: '17:00', pessoas: [dora] });
  checa('cria escala pelo painel', r.status === 201 && !!r.j.escala.id);
  const novaId = r.j.escala.id;
  r = await api('PUT', `/api/plantao/escalas/${novaId}`, { ativo: false });
  checa('desliga a escala sem apagar', r.status === 200 && r.j.escala.ativo === false);
  r = await api('POST', '/api/plantao/escalas', { equipe_id: 'suporte', nome: 'Errado', tipo: 'fixa', dias: [1], hora_inicio: '25:00', hora_fim: '17:00', pessoas: [dora] });
  checa('horário inválido devolve 400 com motivo legível', r.status === 400 && /HH:MM/.test(r.j.error), r.j);
  r = await api('POST', '/api/plantao/excecoes', { tipo: 'ferias', pessoa_id: dora, inicio: '2026-12-01T03:00:00Z', fim: '2026-12-15T03:00:00Z', motivo: 'férias' });
  checa('registra férias pelo painel', r.status === 201 && r.j.excecao.tipo === 'ferias');
  r = await api('DELETE', `/api/plantao/excecoes/${r.j.excecao.id}`);
  checa('remove a ausência', r.status === 200);
  r = await api('PUT', '/api/plantao/equipes/campo', { regiao: 'Sobral' });
  checa('muda a região da equipe', r.status === 200 && r.j.equipe.regiao === 'Sobral');
  r = await api('PUT', '/api/plantao/equipes/nao-existe', { regiao: 'x' });
  checa('equipe inexistente devolve 404', r.status === 404);
  r = await api('DELETE', `/api/plantao/escalas/${novaId}`);
  checa('remove a escala', r.status === 200 && pl.escalaPorId(novaId) === null);

  const trilha = db().prepare(`SELECT acao FROM auditoria WHERE acao LIKE 'escala%' OR acao LIKE 'plantao%' OR acao = 'equipe.plantao'`).all() as Array<{ acao: string }>;
  checa('tudo que mexe na escala fica na auditoria',
    trilha.some((x) => x.acao === 'escala.criar') && trilha.some((x) => x.acao === 'escala.remover') && trilha.some((x) => x.acao === 'equipe.plantao'));

  servidor.close();
  fecharDb();
  console.log(`\n${passou} passaram, ${falhou} falharam\n`);
  process.exit(falhou ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
