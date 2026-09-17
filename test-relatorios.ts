// Testes de clientes online (Zabbix), instalações e cancelamentos (SGP).
// Zabbix e SGP são dublês; banco temporário.
//
//   npm run test:relatorios

import fs from 'fs';
import os from 'os';
import path from 'path';

for (const k of ['OPENAI_API_KEY', 'SGP_BASE_URL', 'SGP_TOKEN']) {
  process.env[k] ||= 'teste-relatorios-sem-uso';
}
process.env.ZABBIX_ENABLED = '1';

const RAIZ = __dirname;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aq-relatorios-'));
process.chdir(dir);

/* eslint-disable @typescript-eslint/no-var-requires */
const { db, fecharDb } = require(path.join(RAIZ, 'src', 'assistant', 'store', 'db')) as typeof import('./src/assistant/store/db');
const { indexar } = require(path.join(RAIZ, 'src', 'assistant', 'store', 'sgp-index')) as typeof import('./src/assistant/store/sgp-index');
const zm = require(path.join(RAIZ, 'src', 'integrations', 'zabbix-metricas')) as Record<string, unknown>;
const { sgp } = require(path.join(RAIZ, 'src', 'integrations', 'sgp')) as { sgp: Record<string, unknown> };
const { ferramentas } = require(path.join(RAIZ, 'src', 'assistant', 'tools', 'base')) as typeof import('./src/assistant/tools/base');
const { registrarFerramentasRelatorios } = require(path.join(RAIZ, 'src', 'assistant', 'tools', 'relatorios')) as typeof import('./src/assistant/tools/relatorios');
/* eslint-enable @typescript-eslint/no-var-requires */

let passou = 0;
let falhou = 0;
function checa(rotulo: string, ok: boolean, detalhe: unknown = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${rotulo}${ok || detalhe === '' ? '' : `\n      ${typeof detalhe === 'string' ? detalhe : JSON.stringify(detalhe).slice(0, 700)}`}`);
  ok ? passou++ : falhou++;
}

const agoraIso = () => new Date().toISOString();
const item = (host: string, chave: string, valor: number | null, coleta = 'viva') => ({
  itemid: `${host}-${chave}`, hostid: host, host, nome: chave, chave, unidade: '',
  valor: valor === null ? null : String(valor), valorNumerico: valor, valorFormatado: valor === null ? null : String(valor),
  coleta, coletadoEm: coleta === 'viva' ? agoraIso() : null, idadeSeg: 30, valueType: 3,
});

const TOTAL = 'grpsum["CONCENTRADORES","pppoeTotal",last]';
let cenario: 'normal' | 'sem_total' | 'nada' = 'normal';
zm.buscarItens = async (o: { chave?: string }) => {
  if (o.chave === TOTAL) return cenario === 'normal' ? [item('Zabbix server', TOTAL, 1158)] : [item('Zabbix server', TOTAL, null, 'sem_coleta')];
  if (cenario === 'nada') return [item('NE20-BGP-01', 'pppoeTotal', null, 'sem_coleta')];
  return [
    item('NE20-BGP-01', 'pppoeTotal', 1100),
    item('NE8K-01', 'pppoeTotal', 58),
    item('PPPOE-01 - BKP', 'pppoeTotal', null, 'sem_coleta'),
    item('Zabbix server', TOTAL, 1158),   // a busca por substring também traz o agregado
  ];
};
zm.resumoSerie = async () => ({ itemid: 'x', janelaHoras: 1, origem: 'historico', amostras: 60, minimo: 1150, maximo: 1200, media: 1170, primeiro: 1200, ultimo: 1158, tendenciaPct: -3, inicio: null, fim: null });
zm.valorEm = async () => ({ valor: 1100, em: '2026-09-15T19:00:00.000Z' });

const OS = [
  { id: 1, cliente: 'MARIA', contrato: 101, status: 'Encerrada', status_id: 1, motivo: 'ADESÃO - instalação de KIT', data_cadastro: 'HOJE', hora_cadastro: '08:00:00', data_finalizacao: 'HOJE', hora_finalizacao: '14:00:00', responsavel: 'Carlos', pop: 'Centro' },
  { id: 2, cliente: 'JOAO', contrato: 102, status: 'Aberta', status_id: 0, motivo: 'ADESAO - Instalacao de Kit', data_cadastro: 'HOJE', responsavel: 'Carlos', pop: 'Sul' },
  { id: 6, cliente: 'RITA', contrato: 106, status: 'Aberta', status_id: 0, motivo: 'ADESÃO - Mudança de Endereço', data_cadastro: 'HOJE' },
  { id: 7, cliente: 'LUIS', contrato: 107, status: 'Encerrada', status_id: 1, motivo: 'ADESÃO - Retirada', data_cadastro: 'HOJE' },
  { id: 3, cliente: 'ANA', contrato: 103, status: 'Aberta', status_id: 0, motivo: 'SUPORTE - Corretiva', data_cadastro: 'HOJE' },
  { id: 4, cliente: 'PEDRO', contrato: 104, status: 'Aberta', status_id: 0, motivo: 'CANCELAMENTO - Retirada de equipamento', data_cadastro: 'HOJE' },
  { id: 5, cliente: 'VELHA', contrato: 105, status: 'Encerrada', status_id: 1, motivo: 'ADESÃO - instalação', data_cadastro: '2020-01-01' },
];
let pedidoSgp: unknown[] = [];
sgp.ordensServicoPorCadastro = async (...a: unknown[]) => {
  pedidoSgp = a;
  const hoje = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Fortaleza' });
  return { janelaCompleta: true, ordens: OS.map((o) => ({ ...o, data_cadastro: o.data_cadastro === 'HOJE' ? hoje : o.data_cadastro, data_finalizacao: o.data_finalizacao === 'HOJE' ? hoje : o.data_finalizacao })) };
};

const cliente = (id: number, status: string, motivo: string | null = null) => ({
  id, nome: `CLIENTE ${id}`, contratos: [{ id: 100 + id, status, motivo_status: motivo ?? undefined, servicos: [] }],
});

async function main() {
  registrarFerramentasRelatorios();
  let n = 0;
  const ctx = { proximoId: () => `evd_${++n}`, usuario: 'teste', fontesPermitidas: null };
  const rodar = async (nome: string, args: Record<string, unknown> = {}) => ferramentas.get(nome)!.executar(args, ctx);
  const dados = (e: { dados?: unknown }) => e.dados as Record<string, any>;

  console.log('\n─── Clientes online (Zabbix) ───');
  let [e] = await rodar('clientes_online');
  checa('total vem do item agregado', dados(e).online_agora === 1158 && /agregado/.test(dados(e).origem), dados(e));
  checa('queda desde o máximo da última hora', dados(e).ultima_hora.queda_desde_o_maximo === 42 && dados(e).ultima_hora.queda_pct === 3.5, dados(e).ultima_hora);
  checa('comparação com ontem', dados(e).ontem_mesmo_horario.diferenca === 58, dados(e).ontem_mesmo_horario);
  checa('lista concentradores vivos e o sem coleta separado',
    dados(e).por_concentrador.length === 2 && dados(e).concentradores_sem_coleta[0].concentrador === 'PPPOE-01 - BKP', dados(e));
  checa('agregado não aparece como concentrador', !dados(e).por_concentrador.some((c: any) => c.concentrador === 'Zabbix server'));

  cenario = 'sem_total';
  [e] = await rodar('clientes_online');
  checa('agregado sem coleta: soma os concentradores e avisa', dados(e).online_agora === 1158 && /sem coleta/.test(dados(e).origem), dados(e).origem);
  checa('com vários concentradores não inventa série', dados(e).ultima_hora === null);

  cenario = 'nada';
  [e] = await rodar('clientes_online');
  checa('nada coletando: fonte falha, não "0 online"', !e.ok && /nenhum item de sessões/.test(e.erro ?? ''), e);
  cenario = 'normal';

  console.log('\n─── Mudança de situação no espelho ───');
  indexar([cliente(1, 'Ativo'), cliente(2, 'Ativo')]);
  const eventos = () => db().prepare(`SELECT * FROM sgp_contrato_evento ORDER BY id`).all() as Array<{ contrato_id: number; de: string | null; para: string; motivo: string | null }>;
  checa('primeiro sync não gera evento', eventos().length === 0);
  indexar([cliente(1, 'Cancelado', 'Financeiro'), cliente(2, 'Ativo'), cliente(3, 'Ativo')]);
  const ev = eventos();
  checa('mudança Ativo → Cancelado registrada com motivo',
    ev.some((x) => x.contrato_id === 101 && x.de === 'Ativo' && x.para === 'Cancelado' && x.motivo === 'Financeiro'), ev);
  checa('contrato novo registrado (de = nulo)', ev.some((x) => x.contrato_id === 103 && x.de === null && x.para === 'Ativo'));
  checa('contrato sem mudança não gera evento', !ev.some((x) => x.contrato_id === 102));
  indexar([cliente(1, 'Cancelado', 'Financeiro')]);
  checa('sync repetido não duplica', eventos().length === 2, eventos());

  console.log('\n─── Ativos x online (offline estimado) ───');
  const comServicos = (id: number, status: string, servicos: Array<{ id: number; status?: string }>) => ({
    id, nome: `CLIENTE ${id}`, contratos: [{ id: 100 + id, status, servicos }],
  });
  indexar([
    cliente(1, 'Cancelado', 'Financeiro'),
    comServicos(10, 'Ativo', [{ id: 1001, status: 'Ativo' }, { id: 1002, status: 'Suspenso' }]),
    comServicos(11, 'Suspenso', [{ id: 1101, status: 'Ativo' }]),
    comServicos(12, 'ATIVO', [{ id: 1201 }]),
  ] as any);
  let envs = await rodar('clientes_online');
  checa('com SGP liberado vêm duas evidências', envs.length === 2 && envs[1].fonte === 'sgp', envs.map((x) => x.consulta));
  const ax = dados(envs[1]);
  checa('conta só serviço ativo de contrato ativo (sem status do serviço = ativo)', ax.servicos_ativos === 2, ax);
  checa('contratos ativos pelo cadastro', ax.contratos_ativos === 4, ax);
  checa('offline estimado = ativos − online, nunca negativo', ax.offline_estimado === 0 && ax.online_agora === 1158, ax);
  checa('diz que é estimativa', /Estimativa/.test(ax.leitura));
  const soZabbix = { ...ctx, fontesPermitidas: ['zabbix'] as any };
  envs = await ferramentas.get('clientes_online')!.executar({}, soZabbix);
  checa('sem acesso ao SGP: só o número online', envs.length === 1 && envs[0].fonte === 'zabbix');
  cenario = 'nada';
  envs = await rodar('clientes_online');
  checa('sem sessões lidas: offline fica sem número', dados(envs[1]).offline_estimado === null, dados(envs[1]));
  cenario = 'normal';

  console.log('\n─── Instalações ───');
  [e] = await rodar('relatorio_instalacoes', { dias: 7 });
  const inst = dados(e).instalacoes;
  checa('pede ao SGP com até 10 páginas', pedidoSgp[3] === 10, pedidoSgp);
  checa('classifica sem depender de acento (instalação/instalacao)', inst.total === 2, inst);
  checa('"ADESÃO - Retirada" e mudança de endereço NÃO são instalação', !JSON.stringify(inst).includes('Retirada') && !JSON.stringify(inst).includes('Mudança'), inst.por_motivo);
  checa('concluídas e em aberto', inst.concluidas === 1 && inst.em_aberto === 1);
  checa('tempo médio de conclusão (6 h)', inst.tempo_medio_conclusao_horas === 6, inst.tempo_medio_conclusao_horas);
  checa('O.S. fora do período fica de fora', !JSON.stringify(inst).includes('VELHA'));
  checa('mostra o que não foi classificado, para conferir o critério',
    dados(e).criterio.motivos_nao_classificados.some((m: any) => m.nome === 'SUPORTE - Corretiva'), dados(e).criterio);

  console.log('\n─── Cancelamentos ───');
  const [porOs, porEspelho] = await rodar('relatorio_cancelamentos', { dias: 30 });
  checa('O.S. de retirada conta como cancelamento, inclusive "ADESÃO - Retirada"', dados(porOs).os_de_cancelamento_ou_retirada.total === 2, dados(porOs));
  checa('mudança de endereço não é instalação nem cancelamento', !JSON.stringify(dados(porOs).os_de_cancelamento_ou_retirada).includes('Mudança'));
  checa('espelho: cancelamento detectado no período', dados(porEspelho).cancelados_detectados_no_periodo === 1, dados(porEspelho));
  checa('diz que o registro começou depois do início do período', /parcial/.test(dados(porEspelho).cobertura), dados(porEspelho).cobertura);
  checa('foto atual por situação', Array.isArray(dados(porEspelho).situacao_atual_dos_contratos));

  sgp.ordensServicoPorCadastro = async () => { throw new Error('timeout'); };
  const [osFalhou, espelhoOk] = await rodar('relatorio_cancelamentos');
  checa('SGP fora: parte das O.S. falha, parte do espelho continua', !osFalhou.ok && espelhoOk.ok);

  fecharDb();
  console.log(`\n${passou} passaram, ${falhou} falharam\n`);
  process.exit(falhou ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
