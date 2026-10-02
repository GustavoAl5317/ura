// Testes de fabricante e de busca de equipamento no Zabbix: "quais
// equipamentos Huawei?" sem depender de "huawei" no nome, e problemas de um
// equipamento sem esconder CPU, temperatura ou BGP.
//
//   npm run test:fabricante

import fs from 'fs';
import os from 'os';
import path from 'path';

for (const k of ['OPENAI_API_KEY', 'SGP_BASE_URL', 'SGP_TOKEN']) {
  process.env[k] ||= 'teste-fabricante-sem-uso';
}
process.env.ZABBIX_ENABLED = 'true';
process.env.ZABBIX_URL ||= 'http://127.0.0.1:1/zabbix';
process.env.ZABBIX_USER ||= 'teste';
process.env.TZ ||= 'America/Fortaleza';
const RAIZ = __dirname;
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'aq-fab-')));

/* eslint-disable @typescript-eslint/no-var-requires */
const { db, fecharDb } = require(path.join(RAIZ, 'src', 'assistant', 'store', 'db')) as typeof import('./src/assistant/store/db');
const fab = require(path.join(RAIZ, 'src', 'integrations', 'fabricante')) as typeof import('./src/integrations/fabricante');
const zm = require(path.join(RAIZ, 'src', 'integrations', 'zabbix-metricas'));
const { zabbix } = require(path.join(RAIZ, 'src', 'integrations', 'zabbix')) as typeof import('./src/integrations/zabbix');
const { ferramentas } = require(path.join(RAIZ, 'src', 'assistant', 'tools', 'base')) as typeof import('./src/assistant/tools/base');
const { registrarFerramentasMetricas } = require(path.join(RAIZ, 'src', 'assistant', 'tools', 'metricas')) as typeof import('./src/assistant/tools/metricas');
const { registrarFerramentas } = require(path.join(RAIZ, 'src', 'assistant', 'tools', 'consultas')) as typeof import('./src/assistant/tools/consultas');
/* eslint-enable @typescript-eslint/no-var-requires */

let passou = 0;
let falhou = 0;
function checa(rotulo: string, ok: boolean, detalhe: unknown = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${rotulo}${ok || detalhe === '' ? '' : `\n      ${typeof detalhe === 'string' ? detalhe : JSON.stringify(detalhe).slice(0, 400)}`}`);
  ok ? passou++ : falhou++;
}

async function main(): Promise<void> {
  db();

  console.log('\n─── Quem fabricou ───');
  let i = fab.identificar({ nome: 'NE8K-AQUI-FOR-BGP' });
  checa('NE8K e Huawei, pelo nome do modelo', i.fabricante === 'Huawei' && i.por === 'nome', i);
  checa('e e roteador', i.tipo === 'roteador', i.tipo);
  i = fab.identificar({ nome: 'OLT-MA5800-HENRIQUE' });
  checa('MA5800 e OLT Huawei', i.fabricante === 'Huawei' && i.tipo === 'olt' && i.modelo === 'MA5800', i);
  i = fab.identificar({ nome: 'CORE-01', templates: ['Huawei VRP by SNMP', 'ICMP Ping'] });
  checa('nome sem pista, template Huawei: Huawei pelo template', i.fabricante === 'Huawei' && i.por === 'template', i);
  i = fab.identificar({ nome: 'NE8K-X', inventario: { vendor: 'ZTE Corporation', model: 'C600' } });
  checa('inventario vale mais que o nome', i.fabricante === 'ZTE' && i.por === 'inventario' && i.modelo === 'C600', i);
  i = fab.identificar({ nome: 'OLT-3' });
  checa('sem pista nenhuma: fabricante desconhecido, nao chutado', i.fabricante === null && i.por === null, i);
  checa('mas o tipo ainda sai do nome', i.tipo === 'olt');
  checa('CCR e MikroTik', fab.identificar({ nome: 'CCR1036-POP-CENTRO' }).fabricante === 'MikroTik');
  checa('S6730 e switch Huawei', (() => { const x = fab.identificar({ nome: 'SW-S6730-CORE' }); return x.fabricante === 'Huawei' && x.tipo === 'switch'; })());
  checa('C600 ZTE pelo nome', fab.identificar({ nome: 'OLT ZTE C600 BOM JARDIM' }).fabricante === 'ZTE');
  checa('"Interface" no nome nao vira fabricante', fab.identificar({ nome: 'Interface Virtual-Ethernet0/2/201' }).fabricante === null);

  console.log('--- Nomes reais da rede ---');
  i = fab.identificar({ nome: 'Retificadora ETP4860-B1A2 - 172.16.22.254' });
  checa('retificadora ETP4860 e Huawei, tipo energia', i.fabricante === 'Huawei' && i.tipo === 'energia', i);
  checa('VM-CORE-DATABASE e servidor, nao roteador', fab.identificar({ nome: 'VM-CORE-DATABASE' }).tipo === 'servidor');
  checa('nobreak e energia', fab.identificar({ nome: 'Nobreak 1 - 172.16.6.43' }).tipo === 'energia');
  checa('gerador e energia', fab.identificar({ nome: 'Gerador - 172.16.6.45' }).tipo === 'energia');
  checa('ESXI e servidor', fab.identificar({ nome: 'ESXI-02 - BKP' }).tipo === 'servidor');
  checa('servidor do SGP e servidor, sem fabricante', (() => { const x = fab.identificar({ nome: 'SGP SESSOES' }); return x.tipo === 'servidor' && x.fabricante === null; })());
  checa('NE8K continua roteador', fab.identificar({ nome: 'NE8K-AQUI-FOR-BGP' }).tipo === 'roteador');
  checa('OLT continua OLT', fab.identificar({ nome: 'OLT-3' }).tipo === 'olt');

  console.log('\n─── Fabricante como a pessoa escreve ───');
  checa('hawuei vira Huawei', fab.fabricantePedido('hawuei') === 'Huawei');
  checa('huawey vira Huawei', fab.fabricantePedido('huawey') === 'Huawei');
  checa('mikrotic vira MikroTik', fab.fabricantePedido('mikrotic') === 'MikroTik');
  checa('zte continua zte', fab.fabricantePedido('ZTE') === 'ZTE');
  checa('datacon vira Datacom', fab.fabricantePedido('datacon') === 'Datacom');
  checa('nome que nao parece nada fica nulo', fab.fabricantePedido('xptozz') === null);

  console.log('\n─── Ferramenta de equipamentos ───');
  const HOSTS = [
    { nome: 'NE8K-AQUI-FOR-BGP', templates: [] as string[] },
    { nome: 'OLT-MA5800-HENRIQUE', templates: [] },
    { nome: 'CORE-01', templates: ['Huawei VRP by SNMP'] },
    { nome: 'OLT ZTE C600 BOM JARDIM', templates: [] },
    { nome: 'OLT-3', templates: [] },
    { nome: 'CCR1036-POP-CENTRO', templates: [] },
  ].map((h, k) => {
    const id = fab.identificar(h);
    return {
      hostid: String(k + 1), nome: h.nome, habilitado: true, emManutencao: false,
      disponibilidade: k === 1 ? 'indisponivel' : 'disponivel', erroInterface: k === 1 ? 'SNMP timeout' : null,
      problemasAbertos: k === 0 ? 2 : 0, problemasCronicos: k === 0 ? 2 : 0, piorSeveridade: k === 0 ? 4 : null,
      fabricante: id.fabricante, fabricantePor: id.por, modelo: id.modelo, tipo: id.tipo,
    };
  });
  let filtroRecebido: string | undefined;
  zm.statusHosts = async (f?: string) => { filtroRecebido = f; return f ? HOSTS.filter((h) => h.nome.toLowerCase().includes(f.toLowerCase())) : HOSTS; };
  registrarFerramentasMetricas();
  const ctx = { proximoId: (() => { let n = 0; return () => `evd_${++n}`; })(), usuario: 'teste', fontesPermitidas: null };
  const equip = async (args: Record<string, unknown>) => (await ferramentas.get('zabbix_equipamentos')!.executar(args, ctx))[0] as any;

  let e = await equip({ fabricante: 'hawuei' });
  checa('"hawuei" lista os 3 Huawei', e.ok && e.dados.total === 3 && e.dados.fabricante === 'Huawei', e.dados);
  checa('o fabricante NAO vai como filtro de nome (huawei nao esta no nome)', filtroRecebido === undefined, filtroRecebido);
  checa('diz como entendeu o nome', /entendido como Huawei/.test(e.dados.fabricante_entendido ?? ''));
  checa('lista cada um com modelo, tipo e de onde veio o fabricante',
    e.dados.equipamentos.some((x: any) => x.nome === 'CORE-01' && x.por === 'template')
    && e.dados.equipamentos.some((x: any) => x.modelo === 'MA5800' && x.tipo === 'olt'), e.dados.equipamentos);
  checa('o Huawei fora aparece como indisponivel', e.dados.indisponiveis.some((x: any) => x.nome === 'OLT-MA5800-HENRIQUE'));
  checa('o resumo diz quantos foram identificados so pelo nome', e.dados.como_o_fabricante_foi_identificado.pelo_nome_do_modelo === 2, e.dados.como_o_fabricante_foi_identificado);
  checa('a conta por fabricante separa o nao identificado',
    e.dados.por_fabricante_na_rede['não identificado'] === 1 && e.dados.por_fabricante_na_rede.Huawei === 3, e.dados.por_fabricante_na_rede);

  e = await equip({ tipo: 'olt' });
  checa('por tipo: as tres OLTs, de qualquer fabricante', e.dados.total === 3, e.dados.equipamentos?.map((x: any) => x.nome));
  e = await equip({ fabricante: 'huawei', tipo: 'olt' });
  checa('OLTs Huawei: so a MA5800', e.dados.total === 1 && e.dados.equipamentos[0].nome === 'OLT-MA5800-HENRIQUE');
  e = await equip({ fabricante: 'juniper' });
  checa('fabricante sem nenhum equipamento: "nenhum" e resposta', e.ok && e.vazio === false && e.dados.total === 0, e);
  e = await equip({ filtro: 'NOME-QUE-NAO-EXISTE' });
  checa('trecho de nome sem resultado continua sem dado (pode ser nome errado)', e.vazio === true);
  e = await equip({ fabricante: 'xptozz' });
  checa('fabricante desconhecido: pergunta, com a lista dos conhecidos', e.vazio === true && e.dados.fabricantes_conhecidos.includes('Huawei'));

  console.log('\n─── Problemas de um equipamento ───');
  registrarFerramentas();
  const probs = async (args: Record<string, unknown>) => (await ferramentas.get('zabbix_problemas')!.executar(args, ctx))[0] as any;
  let usouPadroes = false;
  (zabbix as any).problemasPorPadroes = async () => { usouPadroes = true; return []; };
  (zabbix as any).hostsPorNome = async (t: string) => (t === 'NE8K' ? [{ hostid: '1', nome: 'NE8K-AQUI-FOR-BGP' }] : []);
  (zabbix as any).problemasDosHosts = async () => [
    { eventid: '1', name: 'High CPU utilization (over 90% for 5m)', severity: '3', clock: String(Math.floor(Date.now() / 1000) - 600), objectid: '9', hosts: [{ host: 'NE8K-AQUI-FOR-BGP', name: 'NE8K-AQUI-FOR-BGP' }] },
    { eventid: '2', name: 'BGP peer 200.1.1.1 down', severity: '4', clock: String(Math.floor(Date.now() / 1000) - 400 * 86400), objectid: '10', hosts: [{ host: 'NE8K-AQUI-FOR-BGP', name: 'NE8K-AQUI-FOR-BGP' }] },
  ];
  e = await probs({ host: 'NE8K' });
  checa('equipamento sem filtro: traz TODOS os problemas, inclusive CPU e BGP',
    e.ok && e.dados.total === 2 && e.dados.incidentes.some((x: any) => /CPU/.test(x.nome)) && e.dados.incidentes.some((x: any) => /BGP/.test(x.nome)), e.dados);
  checa('e nao passa pelos padroes da operacao', usouPadroes === false);

  checa('o problema de agora e novo', e.dados.incidentes.find((x: any) => /CPU/.test(x.nome)).idade === 'novo');
  checa('o de 400 dias e cronico', e.dados.incidentes.find((x: any) => /BGP/.test(x.nome)).idade === 'cronico');
  checa('a conta por idade separa os dois', e.dados.por_idade.novos_hoje === 1 && e.dados.por_idade.cronicos_mais_de_30_dias === 1, e.dados.por_idade);
  checa('e proibe chamar o antigo de urgente', /NÃO chame de urgente/.test(e.dados.como_ler_a_idade ?? ''));
  const { idadeDoProblema } = require(path.join(RAIZ, 'src', 'assistant', 'tools', 'consultas'));
  checa('fronteiras da idade', idadeDoProblema(0) === 'novo' && idadeDoProblema(30) === 'recente' && idadeDoProblema(31) === 'cronico');

  const antesProbs = (zabbix as any).problemasDosHosts;
  (zabbix as any).problemasDosHosts = async () => [];
  e = await probs({ host: 'NE8K' });
  checa('equipamento que existe, sem problema: zero e resposta', e.ok && e.vazio === false && e.dados.total === 0, e);
  (zabbix as any).problemasDosHosts = antesProbs;
  e = await probs({ host: 'NOME-ERRADO' });
  checa('host que nao existe: diz que nao encontrou, sem buscar na rede toda',
    e.vazio === true && e.dados.host_encontrado === false && usouPadroes === false, e.dados);
  checa('e proibe dizer que esta sem problema', /NÃO diga que ele está sem problema/.test(e.dados.instrucao));

  e = await probs({});
  checa('sem host continua a varredura pelos padroes da operacao', usouPadroes === true);

  fecharDb();
  console.log(`\n${passou} passaram, ${falhou} falharam\n`);
  process.exit(falhou ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
