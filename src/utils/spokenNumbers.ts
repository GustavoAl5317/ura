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

/**
 * Consome UMA frase numérica a partir de tokens[start] e devolve seus dígitos decimais,
 * sem preencher com zero à esquerda — "cinquenta" vira "50", não "050".
 *
 * Cobre tanto número por extenso ("novecentos e dezoito" → 918) quanto dígito solto
 * ("zero" → 0). Sem tratar os dois casos no mesmo lugar, uma leitura que mistura os dois
 * estilos (comum quando o cliente lê o CPF em blocos) desalinha tudo que vem depois.
 */
function parseNumberPhrase(tokens: string[], start: number): { digits: string; end: number } | null {
  let i = start;
  let value = 0;
  let matched = false;

  if (i < tokens.length && HUNDREDS[tokens[i]!] !== undefined) {
    value += HUNDREDS[tokens[i]!]!;
    i += 1;
    matched = true;
    if (i < tokens.length && tokens[i]! === 'e') i += 1;
  }

  if (i < tokens.length && TENS[tokens[i]!] !== undefined) {
    value += TENS[tokens[i]!]!;
    i += 1;
    matched = true;
    if (i < tokens.length && tokens[i]! === 'e' && DIGIT_WORD[tokens[i + 1] ?? ''] !== undefined) {
      value += parseInt(DIGIT_WORD[tokens[i + 1]!]!, 10);
      i += 2;
    }
  } else if (i < tokens.length && TWO_DIGIT_WORD[tokens[i]!] !== undefined) {
    // Sem gate por `matched`: precisa valer também depois de centena, ex. "novecentos e dezoito" = 918.
    value += parseInt(TWO_DIGIT_WORD[tokens[i]!]!, 10);
    i += 1;
    matched = true;
  } else if (i < tokens.length && DIGIT_WORD[tokens[i]!] !== undefined) {
    if (!matched) {
      // Dígito isolado (fala dígito a dígito) — consome só este token, não o resto da frase.
      return { digits: DIGIT_WORD[tokens[i]!]!, end: i + 1 };
    }
    // Unidade depois de centena sem dezena, ex. "trezentos e cinco" = 305.
    value += parseInt(DIGIT_WORD[tokens[i]!]!, 10);
    i += 1;
  }

  if (!matched) {
    if (i < tokens.length && /^\d+$/.test(tokens[i]!)) return { digits: tokens[i]!, end: i + 1 };
    return null;
  }

  return { digits: String(value), end: i };
}

/** Percorre todos os tokens somando os dígitos de cada frase numérica encontrada. */
function parseNumberStreamDigits(tokens: string[]): string {
  let out = '';
  let i = 0;
  while (i < tokens.length) {
    if (tokens[i] === 'e') {
      i += 1;
      continue;
    }
    const parsed = parseNumberPhrase(tokens, i);
    if (parsed) {
      out += parsed.digits;
      i = parsed.end;
      continue;
    }
    i += 1;
  }
  return out;
}

/** Extrai CPF (11 dígitos) de fala agrupada (ex.: "oitocentos... sessenta e nove...") ou dígito a dígito. */
export function parseCpfFromSpeech(text: string): string | null {
  if (!text?.trim()) return null;

  const hasGrouped =
    /\b(oitocentos|novecentos|seiscentos|setecentos|duzentos|trezentos|quatrocentos|quinhentos|cento|cem)\b/i.test(
      text,
    );

  const tryGrouped = (): string | null => {
    const tokens = tokenizeSpeech(text);
    const digits = parseNumberStreamDigits(tokens);
    return digits.length === 11 ? digits : null;
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
    const grouped = tryGrouped();
    if (grouped) return grouped;
  }

  if (!hasGrouped && looksLikePhoneDdd) return null;

  const tokens = tokenizeSpeech(text);
  const digitRun = collectDigitRun(tokens, 0, 11);
  const fromDigits = acceptDigitCpf(digitRun?.digits ?? '');
  if (fromDigits) return fromDigits;

  if (!hasGrouped) {
    const grouped = tryGrouped();
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
