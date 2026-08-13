// Prepara o texto da resposta para ser LIDO em voz alta.
//
// O modelo escreve para o WhatsApp: "*R$ 79,90*", "CEP 60530-430", protocolo
// "20260501330". Lido cru, isso sai como "erre cifrão setenta e nove vírgula
// noventa" ou vira uma sequência atropelada de dígitos. Aqui cada número vira a
// forma que um atendente usaria ao telefone: valor por extenso e documento
// dígito a dígito.

const UNIDADES = [
  'zero', 'um', 'dois', 'três', 'quatro', 'cinco', 'seis', 'sete', 'oito', 'nove',
  'dez', 'onze', 'doze', 'treze', 'quatorze', 'quinze', 'dezesseis', 'dezessete',
  'dezoito', 'dezenove',
];

const DEZENAS = [
  '', '', 'vinte', 'trinta', 'quarenta', 'cinquenta', 'sessenta', 'setenta',
  'oitenta', 'noventa',
];

const CENTENAS = [
  '', 'cento', 'duzentos', 'trezentos', 'quatrocentos', 'quinhentos',
  'seiscentos', 'setecentos', 'oitocentos', 'novecentos',
];

/** Número por extenso em pt-BR (0 a 999.999) — o suficiente para valores e prazos. */
export function porExtenso(n: number): string {
  if (!Number.isFinite(n) || n < 0) return String(n);
  if (n < 20) return UNIDADES[n]!;
  if (n < 100) {
    const d = Math.floor(n / 10);
    const u = n % 10;
    return u ? `${DEZENAS[d]} e ${UNIDADES[u]}` : DEZENAS[d]!;
  }
  if (n === 100) return 'cem';
  if (n < 1000) {
    const c = Math.floor(n / 100);
    const resto = n % 100;
    return resto ? `${CENTENAS[c]} e ${porExtenso(resto)}` : CENTENAS[c]!;
  }
  if (n < 1_000_000) {
    const milhares = Math.floor(n / 1000);
    const resto = n % 1000;
    const cabeca = milhares === 1 ? 'mil' : `${porExtenso(milhares)} mil`;
    if (!resto) return cabeca;
    // "mil e quinhentos" x "mil duzentos e trinta": o "e" só entra em resto redondo.
    const juncao = resto < 100 || resto % 100 === 0 ? ' e ' : ' ';
    return `${cabeca}${juncao}${porExtenso(resto)}`;
  }
  return String(n);
}

/** "60530" → "seis, zero, cinco, três, zero" (leitura de documento). */
export function digitosPorExtenso(digitos: string): string {
  return digitos
    .split('')
    .filter((d) => /\d/.test(d))
    .map((d) => UNIDADES[Number(d)]!)
    .join(', ');
}

function valorPorExtenso(inteiro: string, centavos: string): string {
  const reais = Number(inteiro.replace(/\./g, ''));
  const cents = Number(centavos);
  const parteReais = `${porExtenso(reais)} ${reais === 1 ? 'real' : 'reais'}`;
  if (!cents) return parteReais;
  return `${parteReais} e ${porExtenso(cents)} ${cents === 1 ? 'centavo' : 'centavos'}`;
}

/**
 * Reescreve os números do texto para leitura em voz alta.
 * Números curtos (velocidade, prazo, hora) ficam como estão — o TTS já os lê bem.
 */
export function numerosParaFala(texto: string): string {
  let t = texto;

  // Dinheiro: R$ 1.234,56 → "mil duzentos e trinta e quatro reais e cinquenta e seis centavos"
  t = t.replace(/R\$\s*([\d.]+),(\d{2})\b/g, (_m, i: string, c: string) => valorPorExtenso(i, c));
  t = t.replace(/R\$\s*([\d.]+)(?!\d)/g, (_m, i: string) => {
    const n = Number(i.replace(/\./g, ''));
    return Number.isFinite(n) ? `${porExtenso(n)} ${n === 1 ? 'real' : 'reais'}` : _m;
  });

  // CPF/CNPJ mascarado
  t = t.replace(/(?<!\d)(\d{3})\.(\d{3})\.(\d{3})-(\d{2})(?!\d)/g,
    (_m, a: string, b: string, c: string, d: string) =>
      `${digitosPorExtenso(a)}, ${digitosPorExtenso(b)}, ${digitosPorExtenso(c)}, ${digitosPorExtenso(d)}`);

  // CEP mascarado
  t = t.replace(/(?<!\d)(\d{5})-(\d{3})(?!\d)/g,
    (_m, a: string, b: string) => `${digitosPorExtenso(a)}, ${digitosPorExtenso(b)}`);

  // Telefone com DDD
  t = t.replace(/\((\d{2})\)\s*(\d{4,5})-?(\d{4})(?!\d)/g,
    (_m, ddd: string, a: string, b: string) =>
      `${digitosPorExtenso(ddd)}, ${digitosPorExtenso(a)}, ${digitosPorExtenso(b)}`);

  // Documentos e protocolos sem máscara: 6 dígitos ou mais, sempre dígito a dígito.
  t = t.replace(/(?<!\d)(\d{6,})(?!\d)/g, (_m, d: string) => digitosPorExtenso(d));

  return t;
}
