// Testes da fala (texto → o que a voz lê) e da resposta de conversa.
// Sem rede: não chama o TTS.
//
//   npm run test:fala

import fs from 'fs';
import os from 'os';
import path from 'path';

for (const k of ['OPENAI_API_KEY', 'SGP_BASE_URL', 'SGP_TOKEN']) {
  process.env[k] ||= 'teste-fala-sem-uso';
}
const RAIZ = __dirname;
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'aq-fala-')));

/* eslint-disable @typescript-eslint/no-var-requires */
const { extenso, textoParaFala } = require(path.join(RAIZ, 'src', 'assistant', 'fala')) as typeof import('./src/assistant/fala');
const { falaDaResposta } = require(path.join(RAIZ, 'src', 'assistant', 'voice')) as typeof import('./src/assistant/voice');
const { conversaValida } = require(path.join(RAIZ, 'src', 'assistant', 'agent')) as typeof import('./src/assistant/agent');
const { formatarResposta } = require(path.join(RAIZ, 'src', 'assistant', 'evidence')) as typeof import('./src/assistant/evidence');
/* eslint-enable @typescript-eslint/no-var-requires */

let passou = 0;
let falhou = 0;
function checa(rotulo: string, ok: boolean, detalhe: unknown = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${rotulo}${ok || detalhe === '' ? '' : `\n      ${typeof detalhe === 'string' ? detalhe : JSON.stringify(detalhe)}`}`);
  ok ? passou++ : falhou++;
}
const AGORA = new Date('2026-09-17T12:00:00-03:00');
function fala(entrada: string, esperado: string | RegExp, rotulo = entrada): void {
  const r = textoParaFala(entrada, AGORA);
  const ok = typeof esperado === 'string' ? r === esperado : esperado.test(r);
  checa(rotulo, ok, `recebido: "${r}"`);
}
function naoTem(entrada: string, proibido: RegExp, rotulo: string): void {
  const r = textoParaFala(entrada, AGORA);
  checa(rotulo, !proibido.test(r), `recebido: "${r}"`);
}

console.log('\n─── Números por extenso ───');
const casos: Array<[number, string, boolean?]> = [
  [0, 'zero'], [1, 'um'], [1, 'uma', true], [2, 'duas', true], [15, 'quinze'], [21, 'vinte e um'],
  [100, 'cem'], [101, 'cento e um'], [200, 'duzentos'], [200, 'duzentas', true], [999, 'novecentos e noventa e nove'],
  [1000, 'mil'], [1005, 'mil e cinco'], [1157, 'mil cento e cinquenta e sete'], [1200, 'mil e duzentos'],
  [2026, 'dois mil e vinte e seis'], [21000, 'vinte e um mil'], [1_000_000, 'um milhão'],
  [2_500_000, 'dois milhões e quinhentos mil'], [-19, 'menos dezenove'],
];
for (const [n, e, f] of casos) checa(`${n}${f ? ' (fem.)' : ''} → ${e}`, extenso(n, f) === e, extenso(n, f));

console.log('\n─── Medidas ───');
fala('RX -19.17 dBm', 'érre xis menos dezenove vírgula dezessete dê bê ême');
fala('sinal de -23,18 dBm', 'sinal de menos vinte e três vírgula dezoito dê bê ême');
fala('TX 2.09 dBm', 'tê xis dois vírgula zero nove dê bê ême');
fala('tráfego de 2,1 Gbps', 'tráfego de dois vírgula um gigabits por segundo');
fala('1 Mbps', 'um megabit por segundo');
fala('850 Mbps', 'oitocentos e cinquenta megabits por segundo');
fala('ocupação de 12,5%', 'ocupação de doze vírgula cinco por cento');
fala('100%', 'cem por cento');
fala('piora de 3 dB', 'piora de três decibéis');
fala('12 min fora', 'doze minutos fora');
fala('1 min', 'um minuto');
fala('38 GB', 'trinta e oito gigabytes');

console.log('\n─── Milhar e identificadores ───');
fala('1.157 clientes online', 'mil cento e cinquenta e sete clientes online');
fala('12.345.678 bytes', 'doze milhões trezentos e quarenta e cinco mil seiscentos e setenta e oito bytes');
fala('contrato 33510', 'contrato três três cinco um zero');
fala('SN RCMG19c050ca', 'número de série R C M G um nove C zero cinco zero C A');
fala('294 CTOs', 'duzentos e noventa e quatro cê tê ós');
fala('IP 177.10.20.30', 'i pê cento e setenta e sete ponto dez ponto vinte ponto trinta');
fala('alvo 177.10.20.x', 'alvo cento e setenta e sete ponto dez ponto vinte ponto xis');

console.log('\n─── Data e hora ───');
fala('às 21:33', 'às vinte e uma horas e trinta e três');
fala('às 14:05:10', 'às quatorze horas e cinco');
fala('às 00:05', 'à meia-noite e cinco');
fala('às 12:00', 'ao meio-dia');
fala('às 1:00', 'às uma hora');
fala('desde 16/09', 'desde dezesseis de setembro');
fala('em 01/10/2026', 'em primeiro de outubro');
fala('em 25/12/2025', 'em vinte e cinco de dezembro de dois mil e vinte e cinco');
fala('2026-09-16T21:33:00-03:00', 'dezesseis de setembro, às vinte e uma horas e trinta e três');
fala('2026-09-16T00:31:07.000000Z', 'dezesseis de setembro, à meia-noite e trinta e um');
fala('dia 2026-07-06', 'dia seis de julho');
fala('às 21h33', 'às vinte e uma horas e trinta e três');
fala('nas últimas 24h', 'nas últimas vinte e quatro horas');
fala('há 1h', 'há uma hora');
fala('nas últimas 12h', 'nas últimas doze horas', '12h é duração, não meio-dia');
fala('amostragem 1:1024', 'amostragem um para mil e vinte e quatro');

console.log('\n─── Porta de OLT não é data ───');
fala('PON 0/1/8', 'PON zero barra um barra oito');
fala('porta 1/8 da OLT-3', 'porta um barra oito da ó éle tê-três');
fala('na 0/2/15', 'na zero barra dois barra quinze');

console.log('\n─── Siglas e ordem de serviço ───');
fala('O.S. 4521 aberta', 'ordem de serviço quatro mil quinhentos e vinte e um aberta');
fala('há 3 O.S. abertas', 'há três ordens de serviço abertas');
fala('SGP e Zabbix', 'ésse gê pê e zábix');
fala('login PPPoE', 'login pê pê pê ó é');

console.log('\n─── Limpeza da resposta de tela ───');
const TELA = `🟢 *CONFIRMADO*

*Cliente* — ABACOS IRAPUAN, contrato 3351
• RX -19.17 dBm (evd_1)
• 3 quedas nas últimas 24h (evd_2, evd_3)
Mapa: https://maps.google.com/?q=-3.7,-38.5

_Fontes:_
_evd_1 · sgp · sgp.onu_ao_vivo · 09:14_`;
const limpo = textoParaFala(TELA, AGORA);
checa('sem selo, asterisco, marcador, link e rodapé', !/CONFIRMADO|\*|•|https|Fontes|evd_|sgp\./i.test(limpo), limpo);
checa('mantém o conteúdo', /Cliente: ABACOS IRAPUAN, contrato três mil trezentos e cinquenta e um/.test(limpo) && /três quedas nas últimas vinte e quatro horas/.test(limpo), limpo);
naoTem('🟡 *PROVÁVEL*\nTexto', /PROV/, 'provável vira frase');
fala('🔴 *INCONCLUSIVO*', 'Não consegui confirmar.');
naoTem('Tudo certo 👍✅', /[👍✅]/u, 'emoji some');
naoTem(TELA, /\d/, 'nenhum dígito sobra para o TTS');

console.log('\n─── Resposta montada para ouvir ───');
const base = { texto: 'A CTO 5 está sem luz.', hipotese: undefined as string | undefined, fontesIndisponiveis: [] as any[] };
checa('confirmado: vai direto', falaDaResposta({ ...base, veredito: 'CONFIRMADO' }) === 'A CTO 5 está sem luz.');
checa('provável: avisa antes', falaDaResposta({ ...base, veredito: 'PROVAVEL' }).startsWith('Ainda não está confirmado.'));
checa('hipótese é dita como hipótese', /Minha hipótese, sem confirmação: rompimento/.test(falaDaResposta({ ...base, veredito: 'PROVAVEL', hipotese: 'rompimento' })));
checa('fonte fora é dita', /não consegui consultar zabbix/.test(falaDaResposta({ ...base, veredito: 'PROVAVEL', fontesIndisponiveis: ['zabbix'] })));
checa('conversa: só o texto', falaDaResposta({ ...base, veredito: 'CONVERSA', texto: 'Bom dia!' }) === 'Bom dia!');

console.log('\n─── Conversa: quando o código aceita ───');
const ev = [{ id: 'evd_1', fonte: 'questdb', consulta: 'x', args: {}, consultadoEm: '', duracaoMs: 0, ok: true, vazio: true }] as any;
const aceita: Array<[string, any[]]> = [
  ['Bom dia! Em que posso ajudar?', []],
  ['Por nada, qualquer coisa é só chamar.', []],
  ['Posso consultar incidentes, CTOs, sinal, tráfego e clientes. O que você precisa?', []],
  ['Não ficou claro qual CTO: é a CTO 3 da Rua Araçá ou a CTO 3 da Rua Nova?', ev],
  ['Você quer saber da CTO do Virgílio de Morais ou do cliente dessa rua?', []],
];
for (const [t, e] of aceita) checa(`aceita: "${t.slice(0, 50)}"`, conversaValida(t, e).ok, conversaValida(t, e));
const recusa: Array<[string, any[]]> = [
  ['Bom dia! A rede está normal.', []],
  ['Boa tarde, tá tudo ok por aqui.', []],
  ['Bom dia! Não há incidentes abertos.', []],
  ['Sem problemas na rede hoje.', []],
  ['A CTO 5 caiu, mas já voltou.', []],
  ['Boa noite, segue tudo estável.', []],
  ['Tem uma queda na PON 8.', []],
  ['Consultei e a CTO 3 tem 8 clientes.', ev],
  ['Veja evd_1.', []],
  ['', []],
];
for (const [t, e] of recusa) checa(`recusa: "${t.slice(0, 50)}"`, !conversaValida(t, e).ok, conversaValida(t, e));

console.log('\n─── Formatação da conversa no WhatsApp ───');
const f = formatarResposta({ veredito: 'CONVERSA', texto: '  Boa tarde! Em que posso ajudar?  ', evidencias: [], fontesIndisponiveis: [], lacunas: ['x'] });
checa('sem selo, sem lacunas, sem rodapé', f === 'Boa tarde! Em que posso ajudar?', f);

console.log(`\n${passou} passaram, ${falhou} falharam\n`);
process.exit(falhou ? 1 : 0);
