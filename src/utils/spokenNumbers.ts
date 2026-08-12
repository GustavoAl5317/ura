/** Corrige confusões comuns de STT em números de telefone ditados. */
function applyPhoneSttFixes(text: string): string {
  let t = text.toLowerCase();
  t = t
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\w\s]/g, ' ');

  const fixes: [RegExp, string][] = [
    [/um\s+dois\s+tres\s+trinta\s+e\s+tres/g, 'um dois tres tres zero dois tres'],
    [/um\s+dois\s+trez\s+trinta\s+e\s+tres/g, 'um dois tres tres zero dois tres'],
    [/tres\s+trinta\s+e\s+tres/g, 'tres zero dois tres'],
  ];

  for (const [re, rep] of fixes) {
    t = t.replace(re, rep);
  }
  return t;
}

const DIGIT_WORD: Record<string, string> = {
  zero: '0',
  um: '1',
  dois: '2',
  tres: '3',
  quatro: '4',
  cinco: '5',
  seis: '6',
  sete: '7',
  oito: '8',
  nove: '9',
  // No Brasil se dita "meia" para não confundir "seis" com "três" ao telefone.
  meia: '6',
};

const TWO_DIGIT_WORD: Record<string, string> = {
  dez: '10',
  onze: '11',
  doze: '12',
  treze: '13',
  quatorze: '14',
  catorze: '14',
  quinze: '15',
  dezesseis: '16',
  dezessete: '17',
  dezoito: '18',
  dezenove: '19',
};

const HUNDREDS: Record<string, number> = {
  cem: 100,
  cento: 100,
  duzentos: 200,
  trezentos: 300,
  quatrocentos: 400,
  quinhentos: 500,
  seiscentos: 600,
  setecentos: 700,
  oitocentos: 800,
  novecentos: 900,
};

const TENS: Record<string, number> = {
  vinte: 20,
  trinta: 30,
  quarenta: 40,
  cinquenta: 50,
  sessenta: 60,
  setenta: 70,
  oitenta: 80,
  noventa: 90,
};

function normalizeToken(tok: string): string {
  return tok
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase();
}

/** Extrai sequência de dígitos de fala em português (CPF, CEP, telefone). */
export function digitsFromSpoken(text: string): string {
  const fixed = applyPhoneSttFixes(text);
  const raw = fixed.replace(/\s+/g, ' ').trim();
  if (!raw) return '';

  const parts = raw.split(/\s+/).filter(Boolean);
  let out = '';
  let i = 0;

  while (i < parts.length) {
    const tok = normalizeToken(parts[i]!);
    const next = i + 1 < parts.length ? normalizeToken(parts[i + 1]!) : '';

    if (tok === 'e' && next) {
      i += 1;
      continue;
    }

    if (tok === 'trinta' && next === 'e') {
      const unit = i + 2 < parts.length ? normalizeToken(parts[i + 2]!) : '';
      if (unit === 'tres') {
        out += '33';
        i += 3;
        continue;
      }
    }

    if (TWO_DIGIT_WORD[tok]) {
      out += TWO_DIGIT_WORD[tok];
      i += 1;
      continue;
    }

    if (DIGIT_WORD[tok]) {
      out += DIGIT_WORD[tok];
      i += 1;
      continue;
    }

    if (/^\d+$/.test(tok)) {
      out += tok;
      i += 1;
      continue;
    }

    i += 1;
  }

  return out.replace(/\D/g, '');
}

function isCelularBrDigits(digits: string): boolean {
  const local = digits.startsWith('55') ? digits.slice(2) : digits;
  return local.length === 11 && local[2] === '9';
}

/** Tenta obter celular BR (11 dígitos) a partir de fala ou texto misto. */
export function parseCelularFromSpeech(text: string): string | null {
  const digits = digitsFromSpoken(text);
  if (!digits) return null;

  const candidates = new Set<string>();
  candidates.add(digits);
  if (digits.startsWith('55') && digits.length >= 13) {
    candidates.add(digits.slice(2));
  }
  if (digits.length > 11) {
    candidates.add(digits.slice(-11));
  }

  for (const c of candidates) {
    if (isCelularBrDigits(c)) return c;
  }
  return null;
}

function looksLikePhoneDictation(text: string): boolean {
  const t = text.toLowerCase();
  return (
    /\b(onze|doze|treze|quatorze|quinze|dezesseis|dezessete|dezoito|dezenove|trinta)\b/.test(t) ||
    digitsFromSpoken(text).length >= 10
  );
}

function tokenizeSpeech(text: string): string[] {
  return applyPhoneSttFixes(text)
    .replace(/[,.-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map(normalizeToken);
}

function collectDigitRun(
  tokens: string[],
  start: number,
  maxLen: number,
): { digits: string; end: number } | null {
  let i = start;
  let out = '';
  while (i < tokens.length && out.length < maxLen) {
    const tok = tokens[i]!;
    if (tok === 'e' && out.length > 0) {
      i += 1;
      continue;
    }
    if (DIGIT_WORD[tok]) {
      out += DIGIT_WORD[tok];
      i += 1;
      continue;
    }
    if (/^\d+$/.test(tok)) {
      out += tok.slice(0, maxLen - out.length);
      i += 1;
      continue;
    }
    break;
  }
  return out ? { digits: out, end: i } : null;
}

function parseTensAndUnits(tokens: string[], start: number): { value: number; end: number } | null {
  let i = start;
  let value = 0;
  const startI = i;

  if (i < tokens.length && TENS[tokens[i]!] !== undefined) {
    value += TENS[tokens[i]!]!;
    i += 1;
  }

  if (i < tokens.length && tokens[i]! === 'e') i += 1;

  if (i < tokens.length && TWO_DIGIT_WORD[tokens[i]!]) {
    value += parseInt(TWO_DIGIT_WORD[tokens[i]!]!, 10);
    i += 1;
  } else if (i < tokens.length && DIGIT_WORD[tokens[i]!]) {
    value += parseInt(DIGIT_WORD[tokens[i]!]!, 10);
    i += 1;
  }

  if (i === startI) return null;
  return { value, end: i };
}

function parseOneCpfGroup(
  tokens: string[],
  start: number,
  maxDigits: number,
): { digits: string; end: number } | null {
  if (maxDigits === 2) {
    const run = collectDigitRun(tokens, start, 2);
    if (run) {
      return { digits: run.digits.padStart(2, '0').slice(-2), end: run.end };
    }
    const small = parseTensAndUnits(tokens, start);
    if (small) {
      return { digits: String(small.value).padStart(2, '0').slice(-2), end: small.end };
    }
    return null;
  }

  let i = start;
  let value = 0;
  const startI = i;

  if (i < tokens.length && HUNDREDS[tokens[i]!] !== undefined) {
    value += HUNDREDS[tokens[i]!]!;
    i += 1;
  }

  if (i < tokens.length && tokens[i]! === 'e') i += 1;

  const rest = parseTensAndUnits(tokens, i);
  if (rest) {
    value += rest.value;
    i = rest.end;
  } else if (i === startI) {
    const run = collectDigitRun(tokens, start, 3);
    if (run) {
      return { digits: run.digits.padStart(3, '0').slice(-3), end: run.end };
    }
    return null;
  }

  if (i === startI) return null;
  return { digits: String(value).padStart(3, '0').slice(-3), end: i };
}

/** Token que carrega número ("oitocentos", "trinta", "sete", "42"). */
function ehTokenNumerico(tok: string): boolean {
  return (
    DIGIT_WORD[tok] !== undefined ||
    TWO_DIGIT_WORD[tok] !== undefined ||
    TENS[tok] !== undefined ||
    HUNDREDS[tok] !== undefined ||
    /^\d+$/.test(tok)
  );
}

/** Posições onde um número pode começar — o cliente raramente abre a frase com ele. */
function iniciosNumericos(tokens: string[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    if (ehTokenNumerico(tokens[i]!)) out.push(i);
  }
  return out;
}

/** Extrai CPF (11 dígitos) de fala agrupada (ex.: "oitocentos... sessenta e nove...") ou dígito a dígito. */
export function parseCpfFromSpeech(text: string): string | null {
  if (!text?.trim()) return null;

  // "Meu telefone é oitenta e cinco, nove nove..." não é CPF: os grupos de DDD
  // caberiam nos grupos de CPF e sairia um documento inventado. Celular tem
  // parser próprio (parseCelularFromSpeech).
  const falouCpf = /\bcpf\b/i.test(text);
  const falouTelefone = /\b(telefone|celular|whats\s?app|zap|contato)\b/i.test(text);
  if (falouTelefone && !falouCpf) return null;

  const hasGrouped =
    /\b(oitocentos|novecentos|seiscentos|setecentos|duzentos|trezentos|quatrocentos|quinhentos|cento|cem)\b/i.test(
      text,
    );

  /** Sem palavra de centena, fala longa de dígitos é telefone — não force um CPF. */
  const aceitarAgrupado = (cpf: string | null): string | null => {
    if (!cpf) return null;
    if (!hasGrouped && !falouCpf && looksLikePhoneDictation(text)) return null;
    return cpf;
  };

  // "Meu CPF é oitocentos e dez..." — o número quase nunca abre a frase, então
  // a varredura tenta cada ponto onde ele pode começar.
  const tryGrouped = (): string | null => {
    const tokens = tokenizeSpeech(text);

    for (const start of iniciosNumericos(tokens)) {
      const groups: string[] = [];
      let i = start;

      while (i < tokens.length && groups.length < 4) {
        const isLast = groups.length === 3;
        const parsed = parseOneCpfGroup(tokens, i, isLast ? 2 : 3);
        if (!parsed) break;
        groups.push(parsed.digits);
        i = parsed.end;
      }

      if (groups.length === 4) {
        const cpf = groups.join('');
        if (cpf.length === 11) return cpf;
      }
    }
    return null;
  };

  const acceptDigitCpf = (digits: string): string | null => {
    if (digits.length !== 11) return null;
    if (isCelularBrDigits(digits) && looksLikePhoneDictation(text)) return null;
    return digits;
  };

  const looksLikePhoneDdd = /\b(onze|doze|treze|quatorze|quinze|dezesseis|dezessete|dezoito|dezenove)\b/i.test(
    text,
  );

  if (hasGrouped) {
    const grouped = aceitarAgrupado(tryGrouped());
    if (grouped) return grouped;
  }

  if (!hasGrouped && looksLikePhoneDdd) return null;

  const tokens = tokenizeSpeech(text);
  for (const start of iniciosNumericos(tokens)) {
    const digitRun = collectDigitRun(tokens, start, 11);
    const fromDigits = acceptDigitCpf(digitRun?.digits ?? '');
    if (fromDigits) return fromDigits;
  }

  if (!hasGrouped) {
    const grouped = aceitarAgrupado(tryGrouped());
    if (grouped) return grouped;
  }

  return acceptDigitCpf(digitsFromSpoken(text));
}

export function looksLikeCpfDictation(text: string): boolean {
  if (looksLikePhoneDictation(text) && parseCelularFromSpeech(text)) return false;
  const t = text.toLowerCase();
  if (
    /\b(oitocentos|novecentos|seiscentos|setecentos|duzentos|trezentos|quatrocentos|quinhentos|cento|cem)\b/.test(
      t,
    )
  ) {
    return true;
  }
  const d = digitsFromSpoken(text);
  return d.length >= 9 && d.length <= 11;
}

// ── CEP ditado por extenso ──────────────────────────────────────────────────
//
// CEP é ditado de um jeito que os parsers de CPF/telefone não cobrem: o cliente
// mistura milhar com centena — "sessenta mil quinhentos e trinta, quatrocentos e
// trinta" = 60530-430. Sem "mil" o valor sai errado (o modelo chuta 60534-300),
// então aqui a fala é lida como uma sequência de números por extenso e os
// dígitos de cada um são concatenados na ordem em que foram ditos.

/** Tokeniza sem os "consertos" de telefone — eles corrompem grupos de CEP. */
function tokenizePlain(text: string): string[] {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/** Palavras que só separam grupos do número — não encerram a sequência. */
const SEPARADORES = new Set(['e', 'traco', 'tracinho', 'hifen', 'ifen', 'menos', 'barra', 'ponto', 'virgula']);

/** Lê "quatrocentos e trinta e dois" a partir de `start`. Máximo 999. */
function parseAte999(tokens: string[], start: number): { valor: number; end: number } | null {
  let i = start;
  let valor = 0;
  let leu = false;

  if (i < tokens.length && HUNDREDS[tokens[i]!] !== undefined) {
    valor += HUNDREDS[tokens[i]!]!;
    i += 1;
    leu = true;
  }

  // O "e" só é consumido se de fato houver continuação numérica depois dele.
  let j = i;
  if (leu && tokens[j] === 'e') j += 1;

  if (j < tokens.length && TENS[tokens[j]!] !== undefined) {
    valor += TENS[tokens[j]!]!;
    i = j + 1;
    leu = true;

    let k = i;
    if (tokens[k] === 'e') k += 1;
    const unidade = k < tokens.length ? DIGIT_WORD[tokens[k]!] : undefined;
    if (unidade && unidade !== '0') {
      valor += Number(unidade);
      i = k + 1;
    }
  } else if (j < tokens.length && TWO_DIGIT_WORD[tokens[j]!]) {
    valor += Number(TWO_DIGIT_WORD[tokens[j]!]);
    i = j + 1;
    leu = true;
  } else if (j < tokens.length && DIGIT_WORD[tokens[j]!] !== undefined) {
    // "cento e cinco" = 105; sozinho, é dígito a dígito ("cinco" = 5).
    valor += Number(DIGIT_WORD[tokens[j]!]);
    i = j + 1;
    leu = true;
  }

  return leu ? { valor, end: i } : null;
}

/**
 * Lê um número por extenso, inclusive com milhar ("sessenta mil quinhentos e trinta").
 *
 * `milAbsorve` resolve a ambiguidade do CEP ditado: "sessenta mil duzentos e
 * vinte e dois" pode ser 60222 (leitura natural) ou 60000 + 222 = 60000-222
 * (leitura de CEP). Quem chama tenta as duas e fica com a que fecha 8 dígitos.
 */
function parseNumeroExtenso(
  tokens: string[],
  start: number,
  milAbsorve = true,
): { valor: number; end: number } | null {
  const antes = parseAte999(tokens, start);
  let i = antes ? antes.end : start;
  let valor = antes?.valor ?? 0;
  let leu = !!antes;

  if (i < tokens.length && tokens[i] === 'mil') {
    valor = (leu ? valor : 1) * 1000;
    i += 1;
    leu = true;

    // O "e" logo depois de "mil" amarra o número: "sessenta mil E quinhentos"
    // é 60500, nunca 60000 + 500. Sem ele ("sessenta mil, quinhentos e trinta")
    // a separação em grupos de CEP é legítima.
    const amarradoPeloE = tokens[i] === 'e';
    if (milAbsorve || amarradoPeloE) {
      let j = i;
      if (amarradoPeloE) j += 1;
      const depois = parseAte999(tokens, j);
      if (depois) {
        valor += depois.valor;
        i = depois.end;
      }
    }
  }

  return leu ? { valor, end: i } : null;
}

/**
 * Extrai um CEP (8 dígitos) de fala em português ou de texto já digitado.
 * Aceita "sessenta mil quinhentos e trinta, quatrocentos e trinta",
 * "sessenta, quinhentos e trinta, quatrocentos e trinta" e dígito a dígito.
 * Retorna null quando a sequência não fecha exatamente 8 dígitos — chutar CEP
 * manda o cliente para a cobertura de outra rua.
 */
export function parseCepFromSpeech(text: string): string | null {
  if (!text?.trim()) return null;

  // Já veio escrito (cliente digitou): 60530-430, 60530 430 ou 60530430.
  const escrito = text.match(/(?<!\d)(\d{5})\s*[-–.\s]?\s*(\d{3})(?!\d)/);
  if (escrito) return escrito[1]! + escrito[2]!;

  const tokens = tokenizePlain(text);

  // Só serve o que fecha 8 dígitos: 11 dígitos é CPF/celular, 5 é CEP pela metade.
  return sequenciasDeDigitos(tokens, true).find((s) => s.length === 8)
    ?? sequenciasDeDigitos(tokens, false).find((s) => s.length === 8)
    ?? null;
}

/** Concatena os dígitos dos números ditos em sequência, cortando nas palavras. */
function sequenciasDeDigitos(tokens: string[], milAbsorve: boolean): string[] {
  const sequencias: string[] = [];
  let atual = '';
  let i = 0;

  const fechar = () => {
    if (atual) sequencias.push(atual);
    atual = '';
  };

  while (i < tokens.length) {
    const tok = tokens[i]!;

    if (atual && SEPARADORES.has(tok)) {
      i += 1;
      continue;
    }

    if (/^\d+$/.test(tok)) {
      atual += tok;
      i += 1;
      continue;
    }

    const num = parseNumeroExtenso(tokens, i, milAbsorve);
    if (num) {
      atual += String(num.valor);
      i = num.end;
      continue;
    }

    fechar();                                        // palavra sem número corta a sequência
    i += 1;
  }
  fechar();

  return sequencias;
}

/** O cliente estava ditando um CEP (e não um endereço ou outro número). */
export function looksLikeCepDictation(text: string): boolean {
  if (!text?.trim()) return false;
  return /\bcep\b/i.test(text) || parseCepFromSpeech(text) !== null;
}

/** Normaliza CEP informado pelo modelo, com fallback na última fala do cliente. */
export function resolveCepInformado(
  informado: string,
  ultimaFala?: string,
): { cep: string | null; fonte?: 'informado' | 'fala' | 'corrigido' } {
  const digitos = (informado ?? '').replace(/\D/g, '');
  const daFala = ultimaFala ? parseCepFromSpeech(ultimaFala) : null;

  // A fala do cliente é a fonte da verdade: o modelo erra ao converter "mil".
  if (digitos.length === 8 && daFala && daFala !== digitos) {
    return { cep: daFala, fonte: 'corrigido' };
  }
  if (digitos.length === 8) return { cep: digitos, fonte: 'informado' };
  if (daFala) return { cep: daFala, fonte: 'fala' };
  return { cep: null };
}

/** Normaliza CPF informado pelo modelo, com fallback na última fala do cliente. */
export function resolveCpfInformado(
  informado: string,
  ultimaFala?: string,
): { cpf: string | null; fonte?: 'informado' | 'fala' | 'corrigido' } {
  const digitosInformado = informado.replace(/\D/g, '');
  const daFala = ultimaFala ? parseCpfFromSpeech(ultimaFala) : null;

  if (
    digitosInformado.length === 11 &&
    daFala &&
    daFala !== digitosInformado &&
    looksLikeCpfDictation(ultimaFala!)
  ) {
    return { cpf: daFala, fonte: 'corrigido' };
  }
  if (digitosInformado.length === 11) return { cpf: digitosInformado, fonte: 'informado' };
  if (daFala) return { cpf: daFala, fonte: 'fala' };
  return { cpf: null };
}

/** Normaliza celular informado pelo modelo, com fallback na última fala do cliente. */
export function resolveCelularInformado(
  informado: string,
  ultimaFala?: string,
): { numero: string | null; fonte?: 'informado' | 'fala' | 'corrigido' } {
  const direto = informado.replace(/\D/g, '');
  const doInformado = isCelularBrDigits(direto)
    ? direto.startsWith('55')
      ? direto.slice(2)
      : direto
    : parseCelularFromSpeech(informado);

  const daFala = ultimaFala ? parseCelularFromSpeech(ultimaFala) : null;

  if (daFala && doInformado && daFala !== doInformado && looksLikePhoneDictation(ultimaFala!)) {
    return { numero: daFala, fonte: 'corrigido' };
  }

  if (doInformado) return { numero: doInformado, fonte: 'informado' };
  if (daFala) return { numero: daFala, fonte: 'fala' };
  return { numero: null };
}
