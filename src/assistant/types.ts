// Contrato de evidência — núcleo do controle de alucinação (Projeto 2).
//
// Nenhuma resposta do assistente é montada a partir de texto livre do modelo:
// toda consulta a uma fonte devolve um Envelope, e o veredito final é
// CALCULADO sobre os envelopes coletados, não declarado pelo modelo.
// Sem dado = sem conclusão, por construção e não por instrução no prompt.

export type FonteId = 'sgp' | 'zabbix' | 'netflow' | 'questdb' | 'ura' | 'whatsapp';

export const FONTES: FonteId[] = ['sgp', 'zabbix', 'netflow', 'questdb', 'ura', 'whatsapp'];

/** Resultado de UMA consulta a UMA fonte. É a única forma de dado que entra na resposta. */
export interface Envelope<T = unknown> {
  /** Rótulo curto e estável (evd_1, evd_2…) que o modelo cita na resposta. */
  id: string;
  fonte: FonteId;
  /** Nome da ferramenta chamada — ex.: 'sgp.cliente_por_cpf' */
  consulta: string;
  /** Argumentos usados, já sanitizados para auditoria. */
  args: Record<string, unknown>;
  consultadoEm: string;
  duracaoMs: number;
  /** false = a fonte falhou (rede, auth, timeout). Não confundir com `vazio`. */
  ok: boolean;
  /** true = a fonte respondeu corretamente, mas não há dado para o que foi pedido. */
  vazio: boolean;
  dados?: T;
  erro?: string;
}

/** Envelope que efetivamente sustenta uma afirmação: respondeu e trouxe dado. */
export function sustenta(e: Envelope): boolean {
  return e.ok && !e.vazio && e.dados !== undefined;
}

export function envelopeOk<T>(base: Omit<Envelope<T>, 'ok' | 'vazio'>, dados: T, vazio = false): Envelope<T> {
  return { ...base, ok: true, vazio, dados };
}

export function envelopeVazio(base: Omit<Envelope, 'ok' | 'vazio' | 'dados'>): Envelope {
  return { ...base, ok: true, vazio: true };
}

export function envelopeErro(base: Omit<Envelope, 'ok' | 'vazio' | 'dados'>, erro: string): Envelope {
  return { ...base, ok: false, vazio: true, erro };
}

export type Veredito = 'CONFIRMADO' | 'PROVAVEL' | 'INCONCLUSIVO';

export interface RespostaAssistente {
  veredito: Veredito;
  /** Motivo do veredito quando o código rebaixou o que o modelo propôs. */
  vereditoAjustado?: string;
  texto: string;
  evidencias: Envelope[];
  /** Fontes que o assistente precisou consultar e que estavam indisponíveis. */
  fontesIndisponiveis: FonteId[];
  /** O que ficou faltando para chegar a uma conclusão mais forte. */
  lacunas: string[];
  modelo: string;
  tokensEntrada?: number;
  tokensSaida?: number;
  duracaoMs: number;
}
