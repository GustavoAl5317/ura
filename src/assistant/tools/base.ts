// Contrato das ferramentas do assistente.
//
// Regra que vale para TODAS: uma ferramenta nunca devolve texto solto. Devolve
// Envelope[] — dado com fonte, horário e status. É o que permite ao veredito
// ser calculado depois, em vez de acreditado.
//
// Ferramentas atômicas devolvem 1 envelope (uma fonte). Macros (ex.: revisão
// completa de cliente) devolvem vários, um por consulta feita — assim o rastro
// de auditoria mostra as fontes de verdade, e não "revisão" como se fosse uma.

import { FonteId, Envelope, envelopeOk, envelopeVazio, envelopeErro } from '../types';
import { logger } from '../../logger';
import { config } from '../../config';

export interface CtxFerramenta {
  /** Gera o próximo rótulo evd_N da consulta em andamento. */
  proximoId(): string;
  usuario: string;
  /** Fontes que este usuário pode consultar. */
  fontesPermitidas: FonteId[] | null;
  /**
   * Pergunta de número não cadastrado (WhatsApp no modo "rede"): nada que
   * identifique cliente — nem nome, nem contrato, nem IP completo.
   */
  publico?: boolean;
}

export interface Ferramenta {
  nome: string;
  /** Fonte principal — usada para checar permissão antes de executar. */
  fonte: FonteId;
  /** Descrição vista pelo modelo. Precisa dizer o que a ferramenta NÃO sabe. */
  descricao: string;
  parametros: Record<string, unknown>;
  /** Existe para olhar UM cliente (ONU, IP, consumo por IP): fica fora do acesso público. */
  dadoPessoal?: boolean;
  executar(args: Record<string, unknown>, ctx: CtxFerramenta): Promise<Envelope[]>;
}

/** Sanitiza args para gravar em auditoria sem vazar o que não deve. */
function argsSeguros(args: Record<string, unknown>): Record<string, unknown> {
  const fora = /senha|password|token|apikey|secret/i;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    out[k] = fora.test(k) ? '[omitido]' : v;
  }
  return out;
}

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z$/;

/** "…Z" → mesmo instante no fuso da operação, com o deslocamento explícito (…-03:00). */
export function isoLocal(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p: Record<string, string> = {};
  for (const x of new Intl.DateTimeFormat('en-GB', {
    timeZone: config.tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(d)) p[x.type] = x.value;
  if (p.hour === '24') p.hour = '00';
  const comoUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  const offMin = Math.round((comoUtc - Math.floor(d.getTime() / 1000) * 1000) / 60_000);
  const sinal = offMin < 0 ? '-' : '+';
  const abs = Math.abs(offMin);
  const off = `${sinal}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${off}`;
}

/**
 * Troca todo horário UTC ("…Z") dos dados por horário local com fuso.
 * Existe porque o modelo não converte: com "19:12Z" na mão, respondeu "pico
 * às 19:12" para um pico das 16:12 de Fortaleza.
 */
export function horariosLocais<T>(v: T, prof = 0): T {
  if (prof > 12 || v === null || v === undefined) return v;
  if (typeof v === 'string') return (ISO_UTC.test(v) ? isoLocal(v) : v) as T;
  if (Array.isArray(v)) return v.map((x) => horariosLocais(x, prof + 1)) as T;
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = horariosLocais(x, prof + 1);
    return out as T;
  }
  return v;
}

/**
 * Executa o corpo de uma ferramenta atômica já embrulhando em Envelope:
 * cronometra, captura exceção e distingue "não achei" de "a fonte caiu".
 * Essa distinção é o que separa INCONCLUSIVO de fonte indisponível.
 */
export async function medir<T>(
  ctx: CtxFerramenta,
  fonte: FonteId,
  consulta: string,
  args: Record<string, unknown>,
  corpo: () => Promise<{ dados: T; vazio?: boolean } | null>,
): Promise<Envelope> {
  const base = {
    id: ctx.proximoId(),
    fonte,
    consulta,
    args: argsSeguros(args),
    consultadoEm: new Date().toISOString(),
    duracaoMs: 0,
  };
  const t0 = Date.now();

  // Trava central: uma macro de uma fonte liberada não pode consultar, por
  // dentro, uma fonte bloqueada (ex.: analisar_pon é zabbix, mas cruza com o SGP).
  if (!podeFonte(ctx, fonte)) {
    return envelopeErro(base, `fonte ${fonte} bloqueada para este usuário`);
  }

  try {
    const r = await corpo();
    base.duracaoMs = Date.now() - t0;
    if (r === null) return envelopeVazio(base);
    return envelopeOk<T>(base, horariosLocais(r.dados), r.vazio ?? false);
  } catch (err) {
    base.duracaoMs = Date.now() - t0;
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`Assistente: fonte ${fonte} falhou em ${consulta}`, { err: msg });
    return envelopeErro(base, msg);
  }
}

export function podeFonte(ctx: CtxFerramenta, fonte: FonteId): boolean {
  return !ctx.fontesPermitidas || ctx.fontesPermitidas.includes(fonte);
}

/** "10.20.30.40" → "10.20.30.x"; IPv6 fica só com o /48. Para acesso público. */
export function mascararIp(ip: string): string {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return ip.replace(/\.\d+$/, '.x');
  if (ip.includes(':')) return ip.split(':').slice(0, 3).join(':') + '::x';
  return 'x';
}

/** Registro global das ferramentas disponíveis. */
export class RegistroFerramentas {
  private mapa = new Map<string, Ferramenta>();

  registrar(...fs: Ferramenta[]): void {
    for (const f of fs) this.mapa.set(f.nome, f);
  }

  get(nome: string): Ferramenta | undefined {
    return this.mapa.get(nome);
  }

  /** Ferramentas que o usuário pode usar, dadas suas fontes permitidas. */
  disponiveis(fontesPermitidas: FonteId[] | null, publico = false): Ferramenta[] {
    const todas = [...this.mapa.values()].filter((f) => !(publico && f.dadoPessoal));
    if (!fontesPermitidas) return todas;
    return todas.filter((f) => fontesPermitidas.includes(f.fonte));
  }

  /** Formato de tool calling da API de chat da OpenAI. */
  comoOpenAiTools(fontesPermitidas: FonteId[] | null, publico = false): unknown[] {
    return this.disponiveis(fontesPermitidas, publico).map((f) => ({
      type: 'function',
      function: {
        name: f.nome,
        description: f.descricao,
        parameters: f.parametros,
      },
    }));
  }
}

export const ferramentas = new RegistroFerramentas();
