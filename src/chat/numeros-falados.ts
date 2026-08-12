// Números ditados em áudio: o que a URA faz com appendContextNote, o chat faz
// aqui. A transcrição chega por extenso ("sessenta mil quinhentos e trinta e
// quatrocentos e trinta") e o modelo erra ao converter — normalmente no "mil".
//
// Em vez de confiar na conta dele, o sistema extrai os dígitos com o mesmo
// parser da URA e entrega prontos junto da mensagem. O texto original continua
// no histórico: é ele que o atendente repete ao confirmar com o cliente.

import {
  looksLikeCepDictation,
  looksLikeCpfDictation,
  parseCelularFromSpeech,
  parseCepFromSpeech,
  parseCpfFromSpeech,
} from '../utils/spokenNumbers';
import { looksLikeEnderecoFalado } from '../utils/address';

/** Palavras de número por extenso — sinal de que havia algo a converter. */
const NUMERO_POR_EXTENSO =
  /\b(zero|um|uma|dois|duas|tr[eê]s|quatro|cinco|seis|meia|sete|oito|nove|dez|onze|doze|treze|quatorze|catorze|quinze|dezesseis|dezessete|dezoito|dezenove|vinte|trinta|quarenta|cinquenta|sessenta|setenta|oitenta|noventa|cem|cento|duzentos|trezentos|quatrocentos|quinhentos|seiscentos|setecentos|oitocentos|novecentos|mil)\b/i;

function formatarCep(cep: string): string {
  return `${cep.slice(0, 5)}-${cep.slice(5)}`;
}

function formatarCpf(cpf: string): string {
  return `${cpf.slice(0, 3)}.${cpf.slice(3, 6)}.${cpf.slice(6, 9)}-${cpf.slice(9)}`;
}

/**
 * Nota de sistema com os números que o cliente ditou, já em dígitos.
 * Retorna null quando não há nada de numérico a esclarecer.
 */
export function notaDeNumerosDitados(transcricao: string): string | null {
  const texto = transcricao?.trim();
  if (!texto) return null;

  const linhas: string[] = [];

  // Endereço falado ("Rua 830, casa 71") não é CEP nem CPF — o handler de
  // viabilidade já trata isso, e insistir em número aqui só atrapalha.
  const ehEndereco = looksLikeEnderecoFalado(texto);

  const cep = ehEndereco ? null : parseCepFromSpeech(texto);
  if (cep) {
    linhas.push(`• CEP ditado pelo cliente: ${cep} (${formatarCep(cep)}). `
      + 'Use exatamente esses 8 dígitos em verificar_viabilidade.');
  }

  const cpf = parseCpfFromSpeech(texto);
  if (cpf) {
    linhas.push(`• CPF ditado pelo cliente: ${cpf} (${formatarCpf(cpf)}). `
      + 'Use exatamente esses 11 dígitos em buscar_cliente_por_cpf.');
  }

  const celular = parseCelularFromSpeech(texto);
  if (celular && celular !== cpf) {
    linhas.push(`• Telefone ditado pelo cliente: ${celular}.`);
  }

  const cabecalho = '[SISTEMA] Esta mensagem do cliente veio em ÁUDIO (transcrição automática).';

  if (linhas.length) {
    return [
      cabecalho,
      'Números ditados por extenso já foram convertidos pelo sistema:',
      ...linhas,
      'Regras: use SEMPRE os dígitos acima nas ferramentas — não recalcule a conversão. '
      + 'Ao confirmar com o cliente, leia os dígitos separados (ex.: "6 0 5 3 0, 4 3 0").',
    ].join('\n');
  }

  // Ditou número e nada fechou: melhor pedir para repetir do que chutar.
  if (ehEndereco) return null;
  const pediramDado = /\bcep\b|\bcpf\b/i.test(texto);
  const pareceNumero = NUMERO_POR_EXTENSO.test(texto) || /\d/.test(texto);
  if (!pareceNumero && !pediramDado) return null;
  if (!pediramDado && !looksLikeCepDictation(texto) && !looksLikeCpfDictation(texto)) return null;

  return [
    cabecalho,
    'O cliente parece ter ditado um número, mas a transcrição NÃO fechou um CEP '
    + '(8 dígitos) nem um CPF (11 dígitos).',
    'NÃO invente os dígitos que faltam e NÃO proponha uma correção chutada. '
    + 'Repita o que ele disse e peça para confirmar, repetir devagar ou digitar.',
  ].join('\n');
}
