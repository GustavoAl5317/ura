import { logger } from '../logger';

/** Circuit breaker: após falha de crédito/auth da ElevenLabs, usa OpenAI TTS até reiniciar o processo. */
let elevenLabsUnavailable = false;
let lastReason = '';

const QUOTA_STATUS = new Set([401, 402, 403, 429]);

export function isElevenLabsCircuitOpen(): boolean {
  return elevenLabsUnavailable;
}

export function markElevenLabsUnavailable(reason: string): void {
  if (elevenLabsUnavailable) return;
  elevenLabsUnavailable = true;
  lastReason = reason;
  logger.warn(`ElevenLabs indisponível — fallback para voz OpenAI até reiniciar o processo`, { reason });
}

export function getElevenLabsCircuitReason(): string {
  return lastReason;
}

/** Detecta erros típicos de chave inválida / sem crédito / quota. */
export function isElevenLabsQuotaOrAuthError(err: unknown): boolean {
  const ax = err as {
    response?: { status?: number; data?: unknown };
    message?: string;
    code?: string;
  };
  const status = ax?.response?.status;
  if (status && QUOTA_STATUS.has(status)) return true;

  const body = typeof ax?.response?.data === 'string'
    ? ax.response.data
    : JSON.stringify(ax?.response?.data ?? '');
  const msg = `${ax?.message ?? ''} ${body}`.toLowerCase();
  return (
    /quota|credit|payment|billing|unauthorized|invalid.?api.?key|insufficient|subscription|exceeded/.test(msg)
  );
}
