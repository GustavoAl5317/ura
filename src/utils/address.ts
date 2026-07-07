const VIA_LABEL: Record<string, string> = {
  rua: 'Rua',
  avenida: 'Avenida',
  av: 'Avenida',
  travessa: 'Travessa',
  alameda: 'Alameda',
  rodovia: 'Rodovia',
};

function normalizeText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase();
}

/** Cliente falou endereço (rua/avenida/casa), não CEP. */
export function looksLikeEnderecoFalado(text: string): boolean {
  const t = normalizeText(text);
  return (
    /\b(rua|avenida|av\.?|travessa|alameda|rodovia)\b/.test(t) ||
    /\bcasa\s+\d/.test(t) ||
    /\bnumero\s+\d/.test(t)
  );
}

/** Extrai logradouro e número de fala como "rua 830 casa 71". */
export function parseEnderecoFalado(text: string): {
  logradouro?: string;
  numero?: string;
} {
  const norm = normalizeText(text);

  let logradouro: string | undefined;
  const viaMatch = norm.match(/\b(rua|avenida|av|travessa|alameda|rodovia)\s+(\d+[a-z]?)\b/);
  if (viaMatch) {
    const label = VIA_LABEL[viaMatch[1]!] ?? 'Rua';
    logradouro = `${label} ${viaMatch[2]!.toUpperCase()}`;
  }

  let numero: string | undefined;
  const casaMatch = norm.match(/\b(?:casa|numero|n)\s*(\d+[a-z]?)\b/);
  if (casaMatch) {
    numero = casaMatch[1]!;
  }

  return { logradouro, numero };
}

/**
 * Modelo colocou endereço no campo cep (ex.: "83071" de "Rua 830 casa 71").
 * CEP válido tem 8 dígitos — menos que isso com fala de rua/casa é endereço.
 */
export function tryRecoverFromCepConfusion(
  cepArg: string,
  speech?: string,
): { logradouro: string; numero: string } | null {
  const digits = cepArg.replace(/\D/g, '');
  if (digits.length === 8) return null;

  const fonte = [speech, cepArg].filter(Boolean).join(' ');
  if (!looksLikeEnderecoFalado(fonte)) return null;

  const parsed = parseEnderecoFalado(fonte);
  if (parsed.logradouro && parsed.numero) {
    return { logradouro: parsed.logradouro, numero: parsed.numero };
  }

  return null;
}
