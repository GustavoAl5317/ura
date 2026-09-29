// Janela de manutenção: o que já se sabe que vai cair não precisa acordar
// ninguém.
//
// Troca de placa na OLT gera dezenas de alertas verdadeiros e inúteis. Sem
// janela, a equipe aprende a ignorar alerta durante manutenção, e passa a
// ignorar também o que não era manutenção.
//
// O efeito é escolhido por janela, porque as situações são diferentes:
//   nao_notificar — registra no painel, não manda mensagem (o padrão);
//   rebaixar      — manda, mas como informativo, sem furar silêncio;
//   suprimir      — nem registra alerta (só o rastro da janela);
//   manter        — janela declarada, alerta normal. Serve para avisar a
//                   equipe sem mudar o comportamento.

import { randomUUID } from 'crypto';
import { db, registrarAuditoria } from './store/db';
import type { Alerta } from './alertas';

export const ALVOS_MANUTENCAO = ['tudo', 'equipamento', 'pon', 'olt', 'pop', 'regiao', 'origem'] as const;
export type AlvoManutencao = (typeof ALVOS_MANUTENCAO)[number];

export const EFEITOS = ['nao_notificar', 'rebaixar', 'suprimir', 'manter'] as const;
export type EfeitoManutencao = (typeof EFEITOS)[number];

export const ROTULO_EFEITO: Record<EfeitoManutencao, string> = {
  nao_notificar: 'Registra no painel, não avisa',
  rebaixar: 'Avisa como informativo',
  suprimir: 'Não registra nem avisa',
  manter: 'Avisa normalmente',
};

export const ROTULO_ALVO: Record<AlvoManutencao, string> = {
  tudo: 'Tudo', equipamento: 'Equipamento', pon: 'PON', olt: 'OLT',
  pop: 'POP', regiao: 'Região', origem: 'Origem do alerta',
};

export interface Manutencao {
  id: string;
  alvo_tipo: AlvoManutencao;
  alvo: string | null;
  inicio: string;
  fim: string;
  efeito: EfeitoManutencao;
  motivo: string | null;
  criado_por: string | null;
  criado_em: string;
}

export function listar(opts: { vigentes?: boolean; desde?: string; limite?: number } = {}): Manutencao[] {
  const cond: string[] = [];
  const params: unknown[] = [];
  if (opts.vigentes) {
    const agora = new Date().toISOString();
    cond.push('inicio <= ? AND fim > ?');
    params.push(agora, agora);
  }
  if (opts.desde) { cond.push('fim >= ?'); params.push(opts.desde); }
  params.push(Math.min(500, opts.limite ?? 200));
  return db().prepare(
    `SELECT * FROM manutencao ${cond.length ? `WHERE ${cond.join(' AND ')}` : ''} ORDER BY inicio DESC LIMIT ?`,
  ).all(...params) as Manutencao[];
}

export function criar(d: {
  alvo_tipo?: string; alvo?: string; inicio?: string; fim?: string; efeito?: string; motivo?: string;
}, autor: string): Manutencao {
  const tipo = String(d.alvo_tipo ?? 'tudo') as AlvoManutencao;
  if (!ALVOS_MANUTENCAO.includes(tipo)) throw new Error(`alvo inválido; use ${ALVOS_MANUTENCAO.join(', ')}`);
  const efeito = String(d.efeito ?? 'nao_notificar') as EfeitoManutencao;
  if (!EFEITOS.includes(efeito)) throw new Error(`efeito inválido; use ${EFEITOS.join(', ')}`);
  const alvo = String(d.alvo ?? '').trim() || null;
  if (tipo !== 'tudo' && !alvo) throw new Error(`diga qual ${ROTULO_ALVO[tipo].toLowerCase()} entra em manutenção`);
  const inicio = new Date(String(d.inicio ?? ''));
  const fim = new Date(String(d.fim ?? ''));
  if (Number.isNaN(inicio.getTime()) || Number.isNaN(fim.getTime())) throw new Error('informe início e fim da janela');
  if (fim.getTime() <= inicio.getTime()) throw new Error('o fim precisa ser depois do início');

  const m: Manutencao = {
    id: randomUUID(), alvo_tipo: tipo, alvo, inicio: inicio.toISOString(), fim: fim.toISOString(),
    efeito, motivo: String(d.motivo ?? '').trim() || null, criado_por: autor, criado_em: new Date().toISOString(),
  };
  db().prepare(
    `INSERT INTO manutencao (id, alvo_tipo, alvo, inicio, fim, efeito, motivo, criado_por, criado_em)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(m.id, m.alvo_tipo, m.alvo, m.inicio, m.fim, m.efeito, m.motivo, m.criado_por, m.criado_em);
  registrarAuditoria(autor, 'manutencao.criar', `${tipo}:${alvo ?? 'tudo'}`, undefined, m);
  return m;
}

export function remover(id: string, autor: string): void {
  const antes = db().prepare(`SELECT * FROM manutencao WHERE id = ?`).get(id) as Manutencao | undefined;
  if (!antes) throw new Error('janela não encontrada');
  db().prepare(`DELETE FROM manutencao WHERE id = ?`).run(id);
  registrarAuditoria(autor, 'manutencao.remover', antes.id, antes, undefined);
}

/** Encerra agora uma janela em andamento, sem apagar o registro dela. */
export function encerrar(id: string, autor: string): Manutencao {
  const antes = db().prepare(`SELECT * FROM manutencao WHERE id = ?`).get(id) as Manutencao | undefined;
  if (!antes) throw new Error('janela não encontrada');
  const agora = new Date().toISOString();
  db().prepare(`UPDATE manutencao SET fim = ? WHERE id = ?`).run(agora, id);
  const depois = db().prepare(`SELECT * FROM manutencao WHERE id = ?`).get(id) as Manutencao;
  registrarAuditoria(autor, 'manutencao.encerrar', antes.id, antes, depois);
  return depois;
}

const texto = (v: unknown): string => String(v ?? '').trim().toLowerCase();

/** A janela cobre este alerta? Compara o alvo dela com os dados do alerta. */
export function cobre(m: Manutencao, a: Pick<Alerta, 'origem' | 'dados' | 'titulo'>): boolean {
  if (m.alvo_tipo === 'tudo') return true;
  const d = (a.dados ?? {}) as Record<string, unknown>;
  const alvo = texto(m.alvo);
  if (!alvo) return false;

  switch (m.alvo_tipo) {
    case 'origem': return texto(a.origem) === alvo;
    case 'equipamento': {
      const host = texto(d.host ?? d.equipamento);
      return !!host && (host === alvo || host.includes(alvo));
    }
    case 'pon': return texto(d.pon) === alvo;
    case 'olt': {
      const olt = texto(d.olt ?? d.olt_nome ?? d.host);
      return !!olt && (olt === alvo || olt.includes(alvo));
    }
    case 'pop': return texto(d.pop) === alvo;
    case 'regiao': {
      const r = texto(d.regiao ?? d.cidade ?? d.bairro);
      return !!r && (r.includes(alvo) || alvo.includes(r));
    }
    default: return false;
  }
}

/** Janela vigente que cobre este alerta. A mais restritiva ganha. */
export function janelaDoAlerta(a: Pick<Alerta, 'origem' | 'dados' | 'titulo'>, quando = new Date()): Manutencao | null {
  const iso = quando.toISOString();
  const vigentes = db().prepare(
    `SELECT * FROM manutencao WHERE inicio <= ? AND fim > ? ORDER BY criado_em DESC`,
  ).all(iso, iso) as Manutencao[];
  const cobrem = vigentes.filter((m) => cobre(m, a));
  if (!cobrem.length) return null;
  // Janela específica vale mais que "tudo": manutenção de uma OLT não deve
  // ser apagada por uma janela geral esquecida aberta.
  return cobrem.sort((x, y) => Number(x.alvo_tipo === 'tudo') - Number(y.alvo_tipo === 'tudo'))[0];
}
