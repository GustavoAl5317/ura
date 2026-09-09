// Testa as travas do motor de veredito. Nenhuma rede envolvida.
import { calcularVeredito, extrairCitacoes } from './src/assistant/evidence';
import { Envelope, Veredito } from './src/assistant/types';

let passou = 0;
let falhou = 0;

function checa(rotulo: string, real: unknown, esperado: unknown): void {
  const ok = JSON.stringify(real) === JSON.stringify(esperado);
  console.log(`  ${ok ? '✓' : '✗'} ${rotulo}${ok ? '' : `\n      esperado ${JSON.stringify(esperado)}, veio ${JSON.stringify(real)}`}`);
  ok ? passou++ : falhou++;
}

function evd(id: string, over: Partial<Envelope> = {}): Envelope {
  return {
    id, fonte: 'zabbix', consulta: 'zabbix.problemas', args: {},
    consultadoEm: new Date().toISOString(), duracaoMs: 10,
    ok: true, vazio: false, dados: { algo: 1 },
    ...over,
  };
}

console.log('\n─── Rebaixamento de veredito ───');

checa('sem nenhuma evidência, CONFIRMADO vira INCONCLUSIVO',
  calcularVeredito('CONFIRMADO', [], 'a rede está ótima').veredito, 'INCONCLUSIVO');

checa('todas as fontes vazias, CONFIRMADO vira INCONCLUSIVO',
  calcularVeredito('CONFIRMADO', [evd('evd_1', { vazio: true, dados: undefined })], 'tudo certo').veredito,
  'INCONCLUSIVO');

checa('todas as fontes caídas, CONFIRMADO vira INCONCLUSIVO',
  calcularVeredito('CONFIRMADO', [evd('evd_1', { ok: false, vazio: true, dados: undefined, erro: 'timeout' })], 'x').veredito,
  'INCONCLUSIVO');

checa('uma fonte caiu e outra respondeu: teto é PROVAVEL',
  calcularVeredito('CONFIRMADO', [
    evd('evd_1'),
    evd('evd_2', { fonte: 'sgp', ok: false, vazio: true, dados: undefined, erro: 'timeout' }),
  ], 'conclusão em evd_1').veredito,
  'PROVAVEL');

checa('citação fantasma derruba CONFIRMADO para PROVAVEL',
  calcularVeredito('CONFIRMADO', [evd('evd_1')], 'conforme evd_7 está tudo certo').veredito,
  'PROVAVEL');

checa('evidência sólida e sem falha mantém CONFIRMADO',
  calcularVeredito('CONFIRMADO', [evd('evd_1')], 'comprovado em evd_1').veredito,
  'CONFIRMADO');

checa('o motor nunca PROMOVE: INCONCLUSIVO com dado bom continua INCONCLUSIVO',
  calcularVeredito('INCONCLUSIVO', [evd('evd_1')], 'evd_1').veredito, 'INCONCLUSIVO');

checa('PROVAVEL com dado bom continua PROVAVEL',
  calcularVeredito('PROVAVEL', [evd('evd_1')], 'evd_1').veredito, 'PROVAVEL');

console.log('\n─── Rastreabilidade ───');

const r1 = calcularVeredito('CONFIRMADO', [
  evd('evd_1'),
  evd('evd_2', { fonte: 'sgp', ok: false, vazio: true, dados: undefined, erro: 'timeout no SGP' }),
], 'segundo evd_1');
checa('fonte que só falhou aparece como indisponível', r1.fontesIndisponiveis, ['sgp']);
checa('o rebaixamento é registrado', typeof r1.ajuste, 'string');
checa('a lacuna nomeia a consulta que falhou',
  r1.lacunas.some((l) => l.includes('timeout no SGP')), true);

const r2 = calcularVeredito('CONFIRMADO', [
  evd('evd_1', { fonte: 'sgp', ok: false, vazio: true, dados: undefined, erro: 'x' }),
  evd('evd_2', { fonte: 'sgp' }),
], 'evd_2');
checa('fonte que falhou numa consulta mas funcionou noutra NÃO é indisponível',
  r2.fontesIndisponiveis, []);

checa('extrairCitacoes acha os rótulos e deduplica',
  extrairCitacoes('vem de evd_1 e evd_2, reforçado por evd_1'), ['evd_1', 'evd_2']);

checa('citação fantasma é apontada',
  calcularVeredito('CONFIRMADO', [evd('evd_1')], 'vide evd_9').citacoesFantasma, ['evd_9']);

console.log('\n─── Cenário realista: pergunta sem dado nenhum ───');
const semDado = calcularVeredito('CONFIRMADO', [
  evd('evd_1', { fonte: 'sgp', consulta: 'sgp.localizar_cliente', vazio: true, dados: undefined }),
], 'O cliente João está com sinal em -22 dBm.');
checa('modelo inventou sinal sem dado → INCONCLUSIVO', semDado.veredito, 'INCONCLUSIVO');
console.log(`      ajuste registrado: ${semDado.ajuste}`);

console.log(`\n${passou} passaram, ${falhou} falharam\n`);
process.exit(falhou ? 1 : 0);
