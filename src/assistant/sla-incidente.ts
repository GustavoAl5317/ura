// SLA do incidente: três relógios, não um.
//
// "Resolvido em 2 horas" esconde o que interessa: quanto tempo o problema
// ficou sem ninguém olhando. Por isso são três prazos independentes, contados
// da abertura do incidente:
//   1. RECONHECER — alguém assumiu. É o relógio que dispara o escalonamento.
//   2. ATENDER    — o atendimento começou de fato (estado "em atendimento").
//   3. RESOLVER   — normalizou.
//
// O prazo vem da severidade do incidente, e a severidade sobe com o impacto
// (B3): uma queda que cresce aperta o próprio prazo, sem ninguém mexer.

import { db, registrarAuditoria } from './store/db';
import { SEVERIDADES_INCIDENTE, SeveridadeIncidente, Incidente, porId, registrarLinha } from './incidentes';

export type Marco = 'reconhecer' | 'atender' | 'resolver';
export const MARCOS: Marco[] = ['reconhecer', 'atender', 'resolver'];

export const ROTULO_MARCO: Record<Marco, string> = {
  reconhecer: 'Reconhecer', atender: 'Começar o atendimento', resolver: 'Resolver',
};

export interface RegraSla {
  severidade: SeveridadeIncidente;
  reconhecer_min: number;
  atender_min: number;
  resolver_min: number;
  ativo: boolean;
}

interface Linha extends Omit<RegraSla, 'ativo' | 'severidade'> { severidade: string; ativo: number }

export function listarRegras(): RegraSla[] {
  const linhas = db().prepare(`SELECT * FROM sla_regra`).all() as Linha[];
  const porSev = new Map(linhas.map((l) => [l.severidade, l]));
  return SEVERIDADES_INCIDENTE.map((s) => {
    const l = porSev.get(s);
    return {
      severidade: s,
      reconhecer_min: l?.reconhecer_min ?? 60,
      atender_min: l?.atender_min ?? 120,
      resolver_min: l?.resolver_min ?? 480,
      ativo: l ? l.ativo === 1 : true,
    };
  });
}

export function regraDe(sev: SeveridadeIncidente): RegraSla {
  return listarRegras().find((r) => r.severidade === sev)!;
}

export function salvarRegra(sev: string, d: { reconhecer_min?: unknown; atender_min?: unknown; resolver_min?: unknown; ativo?: boolean }, autor: string): RegraSla {
  if (!SEVERIDADES_INCIDENTE.includes(sev as SeveridadeIncidente)) throw new Error(`severidade inválida: ${sev}`);
  const antes = regraDe(sev as SeveridadeIncidente);
  const num = (v: unknown, padrao: number, rotulo: string): number => {
    if (v === undefined) return padrao;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > 10080) throw new Error(`${rotulo}: use de 1 a 10080 minutos`);
    return n;
  };
  const r: RegraSla = {
    severidade: sev as SeveridadeIncidente,
    reconhecer_min: num(d.reconhecer_min, antes.reconhecer_min, 'prazo para reconhecer'),
    atender_min: num(d.atender_min, antes.atender_min, 'prazo para atender'),
    resolver_min: num(d.resolver_min, antes.resolver_min, 'prazo para resolver'),
    ativo: d.ativo === undefined ? antes.ativo : d.ativo !== false,
  };
  if (r.atender_min < r.reconhecer_min) throw new Error('atender não pode vencer antes de reconhecer');
  if (r.resolver_min < r.atender_min) throw new Error('resolver não pode vencer antes de atender');
  db().prepare(
    `INSERT INTO sla_regra (severidade, reconhecer_min, atender_min, resolver_min, ativo) VALUES (?,?,?,?,?)
     ON CONFLICT(severidade) DO UPDATE SET reconhecer_min=excluded.reconhecer_min,
       atender_min=excluded.atender_min, resolver_min=excluded.resolver_min, ativo=excluded.ativo`,
  ).run(r.severidade, r.reconhecer_min, r.atender_min, r.resolver_min, r.ativo ? 1 : 0);
  registrarAuditoria(autor, 'sla.regra', r.severidade, antes, r);
  return r;
}

export interface SituacaoMarco {
  marco: Marco;
  prazo_min: number;
  vence_em: string;
  cumprido_em: string | null;
  /** Segundos que faltam; negativo é atraso. */
  restante_seg: number;
  estourado: boolean;
}

export interface SituacaoSla {
  severidade: SeveridadeIncidente;
  ativo: boolean;
  marcos: SituacaoMarco[];
  violados: Marco[];
  /** Próximo prazo a vencer, entre os que ainda não foram cumpridos. */
  proximo: SituacaoMarco | null;
}

function maisSeg(iso: string, min: number): string {
  return new Date(new Date(iso).getTime() + min * 60_000).toISOString();
}

/** Quando cada marco foi cumprido. null = ainda não. */
export function cumprimentos(i: Incidente): Record<Marco, string | null> {
  return {
    reconhecer: i.reconhecido_em,
    atender: i.atendido_em,
    resolver: i.normalizado_em ?? i.encerrado_em,
  };
}

export function situacao(i: Incidente, agora = new Date()): SituacaoSla {
  const regra = regraDe(i.severidade);
  const feito = cumprimentos(i);
  const marcos: SituacaoMarco[] = MARCOS.map((m) => {
    const prazo = m === 'reconhecer' ? regra.reconhecer_min : m === 'atender' ? regra.atender_min : regra.resolver_min;
    const vence = maisSeg(i.aberto_em, prazo);
    const referencia = feito[m] ? new Date(feito[m]!) : agora;
    const restante = Math.round((new Date(vence).getTime() - referencia.getTime()) / 1000);
    return {
      marco: m, prazo_min: prazo, vence_em: vence, cumprido_em: feito[m],
      restante_seg: restante, estourado: regra.ativo && restante < 0,
    };
  });
  const pendentes = marcos.filter((m) => !m.cumprido_em);
  return {
    severidade: i.severidade,
    ativo: regra.ativo,
    marcos,
    violados: marcos.filter((m) => m.estourado).map((m) => m.marco),
    proximo: pendentes.sort((a, b) => a.restante_seg - b.restante_seg)[0] ?? null,
  };
}

/**
 * Grava a violação no incidente e na linha do tempo, uma vez por marco.
 * Devolve os marcos violados agora (os que ainda não estavam registrados).
 */
export function registrarViolacoes(i: Incidente, agora = new Date()): Marco[] {
  const s = situacao(i, agora);
  if (!s.ativo || !s.violados.length) return [];
  let jaVistos: Marco[] = [];
  try { jaVistos = JSON.parse(i.violacoes ?? '[]'); } catch { jaVistos = []; }
  const novos = s.violados.filter((m) => !jaVistos.includes(m));
  if (!novos.length) return [];
  const todos = [...jaVistos, ...novos];
  db().prepare(`UPDATE incidente SET violacoes = ? WHERE id = ?`).run(JSON.stringify(todos), i.id);
  for (const m of novos) {
    const marco = s.marcos.find((x) => x.marco === m)!;
    registrarLinha(i.id, 'sla', `SLA estourado: ${ROTULO_MARCO[m].toLowerCase()} (prazo de ${marco.prazo_min} min)`, null, {
      marco: m, prazo_min: marco.prazo_min, atraso_seg: -marco.restante_seg,
    });
  }
  return novos;
}

/** Marca o começo do atendimento. Só a primeira vez conta para o SLA. */
export function marcarAtendimento(id: string, quando = new Date()): void {
  db().prepare(`UPDATE incidente SET atendido_em = COALESCE(atendido_em, ?) WHERE id = ?`).run(quando.toISOString(), id);
}

/** Incidentes abertos com o relógio de cada um. É o que o painel mostra. */
export function pendentes(lista: Incidente[], agora = new Date()): Array<{ incidente: Incidente; sla: SituacaoSla }> {
  return lista.map((i) => ({ incidente: porId(i.id) ?? i, sla: situacao(i, agora) }))
    .sort((a, b) => (a.sla.proximo?.restante_seg ?? 1e9) - (b.sla.proximo?.restante_seg ?? 1e9));
}
