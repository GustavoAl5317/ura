// Motor de veredito — Projeto 2.
//
// O modelo PROPÕE um veredito; este módulo DECIDE. A diferença importa: se a
// conclusão dependesse só do que o modelo escreve, "sem dado = sem conclusão"
// seria uma instrução de prompt, e instrução de prompt falha em silêncio.
// Aqui é aritmética sobre os envelopes: um CONFIRMADO sem evidência que o
// sustente é rebaixado antes de sair, e o rebaixamento fica registrado.

import { Envelope, FonteId, Veredito, sustenta } from './types';

export interface ResultadoVeredito {
  veredito: Veredito;
  /** Preenchido quando o código discordou do modelo. Vira nota na resposta. */
  ajuste?: string;
  fontesIndisponiveis: FonteId[];
  lacunas: string[];
  /** Rótulos citados no texto que não correspondem a nenhuma evidência real. */
  citacoesFantasma: string[];
}

const ORDEM: Record<Veredito, number> = { INCONCLUSIVO: 0, PROVAVEL: 1, CONFIRMADO: 2 };

function menor(a: Veredito, b: Veredito): Veredito {
  return ORDEM[a] <= ORDEM[b] ? a : b;
}

/** Rótulos evd_N mencionados no texto da resposta. */
export function extrairCitacoes(texto: string): string[] {
  const achados = texto.match(/evd_\d+/gi) ?? [];
  return [...new Set(achados.map((s) => s.toLowerCase()))];
}

export function fontesIndisponiveis(evidencias: Envelope[]): FonteId[] {
  const falhou = new Set<FonteId>();
  const funcionou = new Set<FonteId>();
  for (const e of evidencias) {
    if (e.ok) funcionou.add(e.fonte);
    else falhou.add(e.fonte);
  }
  // Uma fonte só conta como indisponível se NENHUMA consulta a ela deu certo.
  return [...falhou].filter((f) => !funcionou.has(f));
}

/**
 * Decide o veredito final.
 *
 * Teto imposto pelos dados, independentemente do que o modelo propôs:
 *   • nenhuma evidência sustentante          → INCONCLUSIVO
 *   • alguma fonte consultada caiu           → no máximo PROVAVEL
 *   • citou evidência que não existe         → no máximo PROVAVEL (e registra)
 *   • todas as consultas vazias (sem erro)   → INCONCLUSIVO
 */
export function calcularVeredito(
  propostoPeloModelo: Veredito,
  evidencias: Envelope[],
  textoResposta: string,
): ResultadoVeredito {
  const sustentantes = evidencias.filter(sustenta);
  const caidas = evidencias.filter((e) => !e.ok);
  const indisponiveis = fontesIndisponiveis(evidencias);

  const idsReais = new Set(evidencias.map((e) => e.id.toLowerCase()));
  const citacoes = extrairCitacoes(textoResposta);
  const fantasmas = citacoes.filter((c) => !idsReais.has(c));

  let teto: Veredito = 'CONFIRMADO';
  const lacunas: string[] = [];
  const motivos: string[] = [];

  if (evidencias.length === 0) {
    teto = 'INCONCLUSIVO';
    motivos.push('nenhuma fonte foi consultada');
    lacunas.push('Nenhuma consulta às fontes foi feita para esta pergunta.');
  } else if (sustentantes.length === 0) {
    teto = 'INCONCLUSIVO';
    if (caidas.length) {
      motivos.push('todas as fontes consultadas falharam');
      lacunas.push(`Fontes indisponíveis: ${indisponiveis.join(', ')}.`);
    } else {
      motivos.push('as fontes responderam, mas sem dado para a pergunta');
      lacunas.push('As fontes consultadas não têm registro para o que foi perguntado.');
    }
  }

  if (caidas.length && sustentantes.length) {
    teto = menor(teto, 'PROVAVEL');
    motivos.push(`${caidas.length} consulta(s) falharam`);
    for (const e of caidas) {
      lacunas.push(`${e.consulta} (${e.fonte}) não respondeu: ${e.erro ?? 'erro desconhecido'}.`);
    }
  }

  if (fantasmas.length) {
    teto = menor(teto, 'PROVAVEL');
    motivos.push(`citou evidência inexistente (${fantasmas.join(', ')})`);
  }

  const vazias = evidencias.filter((e) => e.ok && e.vazio);
  for (const e of vazias) {
    lacunas.push(`${e.consulta} (${e.fonte}) respondeu, mas sem registros.`);
  }

  const final = menor(propostoPeloModelo, teto);
  const ajuste =
    final === propostoPeloModelo
      ? undefined
      : `Modelo propôs ${propostoPeloModelo}; rebaixado para ${final} porque ${motivos.join('; ')}.`;

  return {
    veredito: final,
    ajuste,
    fontesIndisponiveis: indisponiveis,
    lacunas,
    citacoesFantasma: fantasmas,
  };
}

const EMOJI: Record<Veredito, string> = {
  CONFIRMADO: '🟢',
  PROVAVEL: '🟡',
  INCONCLUSIVO: '🔴',
};

const ROTULO: Record<Veredito, string> = {
  CONFIRMADO: 'CONFIRMADO',
  PROVAVEL: 'PROVÁVEL',
  INCONCLUSIVO: 'INCONCLUSIVO',
};

function horaCurta(iso: string): string {
  return new Date(iso).toLocaleTimeString('pt-BR', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'America/Fortaleza',
  });
}

/**
 * Monta a mensagem que vai ao técnico: conclusão, corpo e rastro.
 * O rastro não é enfeite — é o que permite conferir a resposta sem acreditar nela.
 */
export function formatarResposta(params: {
  veredito: Veredito;
  ajuste?: string;
  texto: string;
  evidencias: Envelope[];
  fontesIndisponiveis: FonteId[];
  lacunas: string[];
  incluirRastro?: boolean;
}): string {
  const linhas: string[] = [];
  linhas.push(`${EMOJI[params.veredito]} *${ROTULO[params.veredito]}*`);
  linhas.push('');
  linhas.push(params.texto.trim());

  if (params.fontesIndisponiveis.length) {
    linhas.push('');
    linhas.push(`⚠️ Fonte indisponível: ${params.fontesIndisponiveis.join(', ')}`);
  }

  if (params.veredito !== 'CONFIRMADO' && params.lacunas.length) {
    linhas.push('');
    linhas.push('*O que falta para confirmar*');
    for (const l of params.lacunas.slice(0, 4)) linhas.push(`• ${l}`);
  }

  if (params.incluirRastro !== false) {
    const usadas = params.evidencias.filter(sustenta);
    if (usadas.length) {
      linhas.push('');
      linhas.push('_Fontes:_');
      for (const e of usadas) {
        linhas.push(`_${e.id} · ${e.fonte} · ${e.consulta} · ${horaCurta(e.consultadoEm)}_`);
      }
    }
  }

  if (params.ajuste) {
    linhas.push('');
    linhas.push(`_${params.ajuste}_`);
  }

  return linhas.join('\n');
}
