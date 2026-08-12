// Regressão dos números ditados por áudio (CEP/CPF) e da leitura em voz alta.
// Rodar:  npx ts-node --transpile-only test-numeros-falados.ts

import {
  parseCepFromSpeech,
  parseCpfFromSpeech,
  resolveCepInformado,
} from './src/utils/spokenNumbers';
import { numerosParaFala } from './src/utils/numeroPorFala';
import { notaDeNumerosDitados } from './src/chat/numeros-falados';

let falhas = 0;

function checar(titulo: string, obtido: unknown, esperado: unknown): void {
  const ok = obtido === esperado;
  if (!ok) falhas += 1;
  console.log(`${ok ? '  ok  ' : ' FALHA'} ${titulo}`);
  if (!ok) console.log(`        esperado=${esperado}  obtido=${obtido}`);
}

console.log('\n── CEP ditado ────────────────────────────────────────────');
const cepsFalados: [string, string | null][] = [
  // O caso que motivou a correção: a IA respondia 60534-300.
  ['É o meu CEP aqui é sessenta mil quinhentos e trinta e quatrocentos e trinta.', '60530430'],
  ['sessenta mil, duzentos e vinte e dois', '60000222'],
  ['sessenta setecentos e catorze duzentos e vinte e dois', '60714222'],
  ['sessenta, quinhentos e trinta, quatrocentos e trinta', '60530430'],
  ['sessenta mil quinhentos e trinta traço quatrocentos e trinta', '60530430'],
  ['seis zero cinco três zero quatro três zero', '60530430'],
  ['meia zero cinco três zero quatro três zero', '60530430'],
  ['sessenta e um mil, oitocentos e cinquenta, cento e dez', '61850110'],
  ['meu cep é 60530-430', '60530430'],
  ['meu cep é 60530430', '60530430'],
  ['cep 60530 430', '60530430'],
  // Não são CEP:
  ['meu cpf é oitocentos e dez, duzentos e vinte, trezentos e trinta, quarenta', null],
  ['é na rua 830, casa 71', null],
  ['bom dia, quero contratar internet', null],
  ['meu telefone é oitenta e cinco nove nove seis um dois três quatro cinco', null],
  ['meu cep é sessenta mil', null],
  // "mil E quinhentos" amarra o número: 60500, CEP incompleto — não completar.
  ['meu cep é sessenta mil e quinhentos', null],
  ['CPF 123.456.789-00', null],
];
for (const [fala, esperado] of cepsFalados) checar(`"${fala}"`, parseCepFromSpeech(fala), esperado);

console.log('\n── CEP: fala do cliente corrige o modelo ─────────────────');
const corrigido = resolveCepInformado('60534300', 'meu CEP é sessenta mil quinhentos e trinta e quatrocentos e trinta');
checar('modelo errou a conversão → vale a fala', corrigido.cep, '60530430');
checar('marcado como corrigido', corrigido.fonte, 'corrigido');
checar('cliente digitou → mantém', resolveCepInformado('60530430', 'meu cep é 60530-430').cep, '60530430');
checar('fala sem CEP → mantém o informado', resolveCepInformado('60530430', 'sim, pode verificar').cep, '60530430');
checar('só a fala tem CEP', resolveCepInformado('', 'sessenta mil quinhentos e trinta quatrocentos e trinta').cep, '60530430');

console.log('\n── CPF ditado ────────────────────────────────────────────');
checar(
  'número no meio da frase ("meu cpf é ...")',
  parseCpfFromSpeech('meu cpf é oitocentos e dez, duzentos e vinte, trezentos e trinta, quarenta'),
  '81022033040',
);
checar(
  'grupos sem preâmbulo',
  parseCpfFromSpeech('oitocentos e dez, duzentos e vinte, trezentos e trinta, quarenta'),
  '81022033040',
);
checar('digitado com máscara', parseCpfFromSpeech('meu cpf é 123.456.789-00'), '12345678900');
checar(
  'dígito a dígito',
  parseCpfFromSpeech('meu cpf é um dois três quatro cinco seis sete oito nove zero zero'),
  '12345678900',
);
// Telefone ditado tem grupos que cabem nos grupos de CPF — não pode virar documento.
checar(
  'telefone não vira CPF',
  parseCpfFromSpeech('meu telefone é oitenta e cinco nove nove seis um dois três quatro cinco seis'),
  null,
);
checar(
  'telefone dígito a dígito não vira CPF',
  parseCpfFromSpeech('pode ligar no oito cinco nove nove seis um dois três quatro cinco seis'),
  null,
);

console.log('\n── Nota de áudio para o modelo ───────────────────────────');
const notaCep = notaDeNumerosDitados('você podia ver a viabilidade? meu CEP é sessenta mil quinhentos e trinta e quatrocentos e trinta');
checar('nota traz o CEP em dígitos', notaCep?.includes('60530430'), true);
const notaCpf = notaDeNumerosDitados('meu cpf é oitocentos e dez, duzentos e vinte, trezentos e trinta, quarenta');
checar('nota traz o CPF em dígitos', notaCpf?.includes('81022033040'), true);
checar('endereço falado não vira nota', notaDeNumerosDitados('é na rua 830, casa 71'), null);
checar('conversa sem número não vira nota', notaDeNumerosDitados('bom dia, minha internet caiu'), null);
const notaIncompleta = notaDeNumerosDitados('meu cep é sessenta mil e quinhentos');
checar('número incompleto vira pedido de repetir', notaIncompleta?.includes('NÃO invente'), true);

console.log('\n── Leitura em voz alta ───────────────────────────────────');
checar(
  'valor por extenso',
  numerosParaFala('Seu plano custa R$ 99,90 por mês.'),
  'Seu plano custa noventa e nove reais e noventa centavos por mês.',
);
checar(
  'CEP dígito a dígito',
  numerosParaFala('Confirma o CEP 60530-430?'),
  'Confirma o CEP seis, zero, cinco, três, zero, quatro, três, zero?',
);
checar(
  'protocolo dígito a dígito',
  numerosParaFala('Anote o protocolo 20260501330.'),
  'Anote o protocolo dois, zero, dois, seis, zero, cinco, zero, um, três, três, zero.',
);
checar(
  'velocidade e data ficam como estão',
  numerosParaFala('Plano de 600 Mega, vence em 05/09/2026.'),
  'Plano de 600 Mega, vence em 05/09/2026.',
);

console.log(falhas ? `\n${falhas} FALHA(S)\n` : '\nTudo certo.\n');
process.exit(falhas ? 1 : 0);
