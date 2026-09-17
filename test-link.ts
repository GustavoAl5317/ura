// Testes da validação de UM link (zabbix_link) e da classificação de
// "Interface ... down" no monitor. Zabbix é dublê.
//
//   npm run test:link

import fs from 'fs';
import os from 'os';
import path from 'path';

for (const k of ['OPENAI_API_KEY', 'SGP_BASE_URL', 'SGP_TOKEN']) {
  process.env[k] ||= 'teste-link-sem-uso';
}
process.env.ZABBIX_ENABLED = '1';
const RAIZ = __dirname;
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'aq-link-')));

/* eslint-disable @typescript-eslint/no-var-requires */
const zm = require(path.join(RAIZ, 'src', 'integrations', 'zabbix-metricas')) as Record<string, any>;
const { zabbix, ZabbixClient } = require(path.join(RAIZ, 'src', 'integrations', 'zabbix')) as typeof import('./src/integrations/zabbix');
const m = require(path.join(RAIZ, 'src', 'assistant', 'tools', 'metricas')) as typeof import('./src/assistant/tools/metricas');
const { ferramentas } = require(path.join(RAIZ, 'src', 'assistant', 'tools', 'base')) as typeof import('./src/assistant/tools/base');
/* eslint-enable @typescript-eslint/no-var-requires */

let passou = 0;
let falhou = 0;
function checa(rotulo: string, ok: boolean, detalhe: unknown = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${rotulo}${ok || detalhe === '' ? '' : `\n      ${typeof detalhe === 'string' ? detalhe : JSON.stringify(detalhe).slice(0, 800)}`}`);
  ok ? passou++ : falhou++;
}

const HOST = 'NE20E-AQUI-VS-BGP';
const agora = () => new Date().toISOString();
const it = (nome: string, chave: string, valor: number | null, unidade = '', coleta = 'viva') => ({
  itemid: chave, hostid: '1', host: HOST, nome, chave, unidade,
  valor: valor === null ? null : String(valor), valorNumerico: valor,
  valorFormatado: valor === null ? null : `${valor} ${unidade}`.trim(),
  coleta, coletadoEm: coleta === 'viva' ? agora() : null, idadeSeg: 30, valueType: 3,
});
const prob = (name: string, minAtras: number) => ({
  eventid: name, name, severity: '4', clock: String(Math.floor(Date.now() / 1000) - minAtras * 60),
  hosts: [{ hostid: '1', host: HOST, name: HOST }],
});

let cenario: Record<string, { problemas: any[]; itens: any[] }> = {};
const buscasFeitas: string[] = [];
(zabbix as any).problemasPorPadroes = async (p: string[]) => { buscasFeitas.push(`p:${p[0]}`); return cenario[p[0].toLowerCase()]?.problemas ?? []; };
zm.buscarItens = async (o: { nome?: string; host?: string }) => {
  if (o.host === 'BGP') {
    return [
      it('Interface XGigabitEthernet0/0/5 - OPER_ANGOLA: Bits received', 'a1', 0, 'bps'),
      it('Interface XGigabitEthernet0/0/7 - IX-CE V4: Bits received', 'a2', 0, 'bps'),
      it('Interface Eth-Trunk0: Bits received', 'a3', 0, 'bps'),
    ];
  }
  buscasFeitas.push(`i:${o.nome}`);
  return cenario[String(o.nome).toLowerCase()]?.itens ?? [];
};

async function main() {
  console.log('\n─── Peças ───');
  checa('porta do alerta', m.portaDoTexto('Interface XGigabitEthernet0/0/5 - OPER_ANGOLA down') === 'XGigabitEthernet0/0/5');
  checa('porta com subinterface', m.portaDoTexto('Interface Eth-Trunk1.100(IX): Operational status') === 'Eth-Trunk1.100');
  checa('sem porta', m.portaDoTexto('Link ETICE fora') === null);
  checa('alerta "down" = fora', m.situacaoDoLink({ problemas: [{ nome: 'Interface X - OPER_ANGOLA down' }], operStatus: 1, trafegoVivo: true }).situacao === 'fora');
  checa('porta down sem alerta = fora', m.situacaoDoLink({ problemas: [], operStatus: 2, trafegoVivo: false }).situacao === 'fora');
  checa('lowerLayerDown = fora', m.situacaoDoLink({ problemas: [], operStatus: 7, trafegoVivo: false }).situacao === 'fora');
  checa('alerta que não é queda = com problema', m.situacaoDoLink({ problemas: [{ nome: 'Interface X: High bandwidth usage' }], operStatus: 1, trafegoVivo: true }).situacao === 'com_problema');
  checa('up sem alerta = no ar', m.situacaoDoLink({ problemas: [], operStatus: 1, trafegoVivo: false }).situacao === 'no_ar');
  checa('só tráfego = no ar', m.situacaoDoLink({ problemas: [], operStatus: null, trafegoVivo: true }).situacao === 'no_ar');
  checa('nada = desconhecida (nunca "no ar")', m.situacaoDoLink({ problemas: [], operStatus: null, trafegoVivo: false }).situacao === 'desconhecida');
  checa('"inativo" conta como fora', m.situacaoDoLink({ problemas: [{ nome: 'Link ETICE inativo' }], operStatus: null, trafegoVivo: false }).situacao === 'fora');

  console.log('\n─── Monitor: classificação ───');
  checa('"Interface ... OPER_ANGOLA down" é link', ZabbixClient.classificar('Interface XGigabitEthernet0/0/5 - OPER_ANGOLA down', HOST) === 'link');
  checa('"Interface ...: Link down" é link', ZabbixClient.classificar('Interface Eth-Trunk2(IX-CE): Link down', HOST) === 'link');
  checa('uso alto de banda não é link', ZabbixClient.classificar('Interface XGigabitEthernet0/0/5: High bandwidth usage', HOST) === 'outro');
  checa('CTO continua CTO', ZabbixClient.classificar('CTO 3 - Rua Araçá, 194- OFFLINE', 'OLT-3') === 'cto_off');
  const { config } = require(path.join(RAIZ, 'src', 'config')) as typeof import('./src/config');
  checa('padrões de busca do monitor incluem "Interface"', config.zabbix.searchPatterns.includes('Interface'), config.zabbix.searchPatterns);

  console.log('\n─── zabbix_link ───');
  m.registrarFerramentasMetricas();
  let n = 0;
  const ctx = { proximoId: () => `evd_${++n}`, usuario: 't', fontesPermitidas: null };
  const rodar = async (link: string) => (await ferramentas.get('zabbix_link')!.executar({ link }, ctx))[0] as any;

  // O caso real de 17/09: alerta aberto, tráfego sem coleta.
  cenario = {
    angola: {
      problemas: [prob('Interface XGigabitEthernet0/0/5 - OPER_ANGOLA down', 42)],
      itens: [
        it('Interface XGigabitEthernet0/0/5 - OPER_ANGOLA: Bits received', 'net.if.in[ifHCInOctets.488]', null, 'bps', 'sem_coleta'),
        it('Interface XGigabitEthernet0/0/5 - OPER_ANGOLA: Bits sent', 'net.if.out[ifHCOutOctets.488]', null, 'bps', 'sem_coleta'),
        it('Interface XGigabitEthernet0/0/5 - OPER_ANGOLA: Operational status', 'net.if.status[ifOperStatus.488]', 2),
      ],
    },
  };
  let e = await rodar('angola');
  let d = e.dados;
  checa('Angola: FORA', e.ok && d.situacao_geral === 'fora', d);
  checa('um link só, na porta certa', d.links.length === 1 && d.links[0].interface === 'XGigabitEthernet0/0/5' && d.links[0].equipamento === HOST, d.links);
  checa('motivo cita o alerta', /OPER_ANGOLA down/.test(d.links[0].motivo), d.links[0]);
  checa('estado da porta: down', d.links[0].estado_da_porta === 'down', d.links[0]);
  checa('desde quando: 42 min', d.links[0].alertas_abertos[0].ha_min === 42 && /-03:00$/.test(d.links[0].alertas_abertos[0].desde), d.links[0].alertas_abertos);
  checa('tráfego sem coleta aparece como sem coleta', d.links[0].trafego.every((t: any) => t.coleta === 'sem_coleta' && t.valor === null), d.links[0].trafego);
  checa('buscou alerta e itens pelo nome', buscasFeitas.includes('p:angola') && buscasFeitas.includes('i:angola'), buscasFeitas);

  // Link no ar.
  cenario = {
    seaborn: {
      problemas: [],
      itens: [
        it('Interface XGigabitEthernet0/0/2 - SEABORN: Bits received', 'in.487', 850_000_000, 'bps'),
        it('Interface XGigabitEthernet0/0/2 - SEABORN: Operational status', 'net.if.status[ifOperStatus.487]', 1),
      ],
    },
  };
  d = (await rodar('seaborn')).dados;
  checa('Seaborn: no ar, porta up', d.situacao_geral === 'no_ar' && d.links[0].estado_da_porta === 'up', d);

  // Alerta sem item: ETICE só aparece no nome do alerta.
  cenario = { etice: { problemas: [prob('Link ETICE inativo', 10)], itens: [] } };
  d = (await rodar('ETICE')).dados;
  checa('ETICE só em alerta sem porta: com problema, alerta listado', d.situacao_geral === 'com_problema' && d.outros_alertas_com_o_nome[0].alerta === 'Link ETICE inativo', d);

  // Alerta com porta, sem item correspondente.
  cenario = { etice: { problemas: [prob('Interface GigabitEthernet0/0/9 - ETICE down', 5)], itens: [] } };
  d = (await rodar('etice')).dados;
  checa('ETICE com porta no alerta: fora mesmo sem item', d.situacao_geral === 'fora' && d.links[0].interface === 'GigabitEthernet0/0/9', d);

  // Nada encontrado: não diz que está no ar e oferece nomes.
  cenario = {};
  e = await rodar('inexistente');
  d = e.dados;
  checa('nada achado: vazio, "nao_encontrado"', e.vazio && d.situacao_geral === 'nao_encontrado' && /Não afirme/.test(d.nao_encontrado), d);
  checa('oferece portas com nome dos roteadores de borda (sem as genéricas)',
    d.portas_dos_roteadores_de_borda.some((x: string) => /OPER_ANGOLA/.test(x)) && !d.portas_dos_roteadores_de_borda.some((x: string) => x === 'Eth-Trunk0'), d.portas_dos_roteadores_de_borda);

  e = await rodar('x');
  checa('nome curto demais: erro legível', !e.ok && /informe o nome/.test(e.erro), e);

  // Zabbix fora: falha, não "no ar".
  (zabbix as any).problemasPorPadroes = async () => { throw new Error('Zabbix inacessível'); };
  e = await rodar('angola');
  checa('Zabbix fora = fonte indisponível', !e.ok && /inacessível/.test(e.erro), e);

  console.log(`\n${passou} passaram, ${falhou} falharam\n`);
  process.exit(falhou ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
