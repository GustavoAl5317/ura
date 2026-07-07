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
