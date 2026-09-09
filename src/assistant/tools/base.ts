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

export interface CtxFerramenta {
  /** Gera o próximo rótulo evd_N da consulta em andamento. */
  proximoId(): string;
  usuario: string;
  /** Fontes que este usuário pode consultar. */
  fontesPermitidas: FonteId[] | null;
}

export interface Ferramenta {
  nome: string;
  /** Fonte principal — usada para checar permissão antes de executar. */
  fonte: FonteId;
  /** Descrição vista pelo modelo. Precisa dizer o que a ferramenta NÃO sabe. */
  descricao: string;
  parametros: Record<string, unknown>;
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

  try {
    const r = await corpo();
    base.duracaoMs = Date.now() - t0;
    if (r === null) return envelopeVazio(base);
    return envelopeOk<T>(base, r.dados, r.vazio ?? false);
  } catch (err) {
    base.duracaoMs = Date.now() - t0;
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`Assistente: fonte ${fonte} falhou em ${consulta}`, { err: msg });
    return envelopeErro(base, msg);
  }
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
  disponiveis(fontesPermitidas: FonteId[] | null): Ferramenta[] {
    const todas = [...this.mapa.values()];
    if (!fontesPermitidas) return todas;
    return todas.filter((f) => fontesPermitidas.includes(f.fonte));
  }

  /** Formato de tool calling da API de chat da OpenAI. */
  comoOpenAiTools(fontesPermitidas: FonteId[] | null): unknown[] {
    return this.disponiveis(fontesPermitidas).map((f) => ({
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
