// Incidente: o problema operacional consolidado.
//
// Alerta é um fato ("Interface X down"). Incidente é o problema que a operação
// precisa resolver, e ele junta vários alertas da mesma causa. Sem essa
// separação, uma queda de PON com 34 CTOs vira 34 problemas na tela e ninguém
// sabe quem está com qual.
//
// Três coisas moram aqui:
//   1. CORRELAÇÃO — alerta novo entra num incidente aberto quando aponta para o
//      mesmo alvo (equipamento, PON, CTO) dentro da janela; senão abre um novo.
//   2. DONO E ESTADO — quem assumiu, em que fase está, e tudo registrado na
//      linha do tempo. "Achei que a outra equipe estava cuidando" acaba aqui.
//   3. NORMALIZAÇÃO — resolveu não é encerrado. Fica em observação por alguns
//      minutos; se cair de novo, o MESMO incidente reabre, em vez de nascer
//      outro. É o que evita dezenas de incidentes por flapping.

import { randomUUID } from 'crypto';
import { db, registrarAuditoria } from './store/db';
import { logger } from '../logger';
import { obter } from './config-dinamica';
import { publicar } from './eventos';
import type { Alerta, Severidade } from './alertas';
import { marcarReconhecido, tipoDoAlerta } from './destinos-alerta';
import { plantaoParaAlerta } from './plantao';

/** Escala do incidente. Mais ampla que a do alerta: o impacto muda a leitura. */
export const SEVERIDADES_INCIDENTE = ['informacao', 'atencao', 'advertencia', 'critico', 'maior', 'desastre'] as const;
export type SeveridadeIncidente = (typeof SEVERIDADES_INCIDENTE)[number];

export const ROTULO_SEVERIDADE: Record<SeveridadeIncidente, string> = {
  informacao: 'Informação', atencao: 'Atenção', advertencia: 'Advertência',
  critico: 'Crítico', maior: 'Maior', desastre: 'Desastre',
};

export const ESTADOS = [
  'detectado', 'aberto', 'notificado', 'reconhecido', 'investigando',
  'atendimento', 'monitorando', 'normalizado', 'encerrado',
  'suprimido', 'manutencao', 'falso_positivo', 'cancelado',
] as const;
export type EstadoIncidente = (typeof ESTADOS)[number];

export const ROTULO_ESTADO: Record<EstadoIncidente, string> = {
  detectado: 'Detectado', aberto: 'Aberto', notificado: 'Notificado',
  reconhecido: 'Reconhecido', investigando: 'Em investigação', atendimento: 'Em atendimento',
  monitorando: 'Monitorando normalização', normalizado: 'Normalizado', encerrado: 'Encerrado',
  suprimido: 'Suprimido', manutencao: 'Em manutenção', falso_positivo: 'Falso positivo',
  cancelado: 'Cancelado',
};

/** Estado em que o incidente ainda pede alguém. */
export const ABERTOS: EstadoIncidente[] = ['detectado', 'aberto', 'notificado', 'reconhecido', 'investigando', 'atendimento', 'monitorando'];
const FECHADOS: EstadoIncidente[] = ['encerrado', 'falso_positivo', 'cancelado'];

export interface Incidente {
  id: string;
  numero: string;
  titulo: string;
  severidade: SeveridadeIncidente;
  estado: EstadoIncidente;
  correlacao: string;
  equipamento: string | null;
  alvo: string | null;
  clientes_afetados: number | null;
  dono: string | null;
  equipe: string | null;
  aberto_em: string;
  reconhecido_em: string | null;
  reconhecido_por: string | null;
  normalizado_em: string | null;
  encerrado_em: string | null;
  reaberturas: number;
  alertas: number;
  atualizado_em: string;
  /** Degrau atual do escalonamento (B5). 0 = ninguém foi acionado além do envio normal. */
  degrau: number;
  escalonado_em: string | null;
  /** Quando o atendimento começou de fato. Conta para o SLA de atendimento. */
  atendido_em: string | null;
  /** JSON com os marcos de SLA já estourados, para não avisar duas vezes. */
  violacoes: string | null;
}

export interface LinhaTempo {
  id: number;
  incidente_id: string;
  at: string;
  tipo: string;
  texto: string;
  ator: string | null;
  dados: unknown;
}

// ─── Leitura ─────────────────────────────────────────────────────────────────

export function porId(id: string): Incidente | null {
  return (db().prepare(`SELECT * FROM incidente WHERE id = ? OR numero = ?`).get(id, id) as Incidente | undefined) ?? null;
}

export function listar(opts: { abertos?: boolean; limite?: number; estado?: string; severidade?: string } = {}): Incidente[] {
  const cond: string[] = [];
  const params: unknown[] = [];
  if (opts.abertos) cond.push(`estado IN (${ABERTOS.map(() => '?').join(',')})`), params.push(...ABERTOS);
  if (opts.estado) cond.push('estado = ?'), params.push(opts.estado);
  if (opts.severidade) cond.push('severidade = ?'), params.push(opts.severidade);
  const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
  params.push(Math.min(500, opts.limite ?? 100));
  return db().prepare(`SELECT * FROM incidente ${where} ORDER BY aberto_em DESC LIMIT ?`).all(...params) as Incidente[];
}

export function linhaDoTempo(id: string): LinhaTempo[] {
  const linhas = db().prepare(`SELECT * FROM incidente_evento WHERE incidente_id = ? ORDER BY id`).all(id) as Array<Omit<LinhaTempo, 'dados'> & { dados: string | null }>;
  return linhas.map((l) => {
    let dados: unknown = null;
    try { dados = l.dados ? JSON.parse(l.dados) : null; } catch { dados = l.dados; }
    return { ...l, dados };
  });
}

export function alertasDoIncidente(id: string): Array<{ chave: string; titulo: string; severidade: string; criado_em: string; resolvido_em: string | null }> {
  return db().prepare(
    `SELECT a.chave, a.titulo, a.severidade, a.criado_em, a.resolvido_em
       FROM incidente_alerta ia JOIN alerta a ON a.id = ia.alerta_id
      WHERE ia.incidente_id = ? ORDER BY a.criado_em`,
  ).all(id) as Array<{ chave: string; titulo: string; severidade: string; criado_em: string; resolvido_em: string | null }>;
}

// ─── Classificação ───────────────────────────────────────────────────────────

const DO_ALERTA: Record<Severidade, SeveridadeIncidente> = {
  info: 'atencao', aviso: 'advertencia', critico: 'critico',
};

export function maiorSeveridade(a: SeveridadeIncidente, b: SeveridadeIncidente): SeveridadeIncidente {
  return SEVERIDADES_INCIDENTE.indexOf(a) >= SEVERIDADES_INCIDENTE.indexOf(b) ? a : b;
}

/**
 * Severidade do incidente: a do alerta, subida pelo impacto. Quantidade de
 * cliente afetado muda a conduta mais do que o tipo do evento.
 */
export function classificar(sevAlerta: Severidade, clientes: number | null): SeveridadeIncidente {
  let s = DO_ALERTA[sevAlerta];
  const paraMaior = obter<number>('incidentes.clientes_para_maior');
  const paraDesastre = obter<number>('incidentes.clientes_para_desastre');
  if (clientes !== null && clientes >= paraDesastre) s = maiorSeveridade(s, 'desastre');
  else if (clientes !== null && clientes >= paraMaior) s = maiorSeveridade(s, 'maior');
  return s;
}

/** Dado do alerta que interessa ao incidente: alvo, equipamento e impacto. */
export function extrairAlvo(a: Pick<Alerta, 'origem' | 'chave' | 'dados' | 'titulo'>): {
  correlacao: string; equipamento: string | null; alvo: string | null; clientes: number | null;
  regiao: string | null;
} {
  const d = (a.dados ?? {}) as Record<string, any>;
  const host: string | null = d.host ?? d.equipamento ?? null;
  const clientes: number | null =
    typeof d.clientes_afetados === 'number' ? d.clientes_afetados
      : typeof d.impacto?.clientes === 'number' ? d.impacto.clientes
        : typeof d.clientes === 'number' ? d.clientes : null;
  // Região serve para escolher a equipe de plantão; o monitor manda o que tiver.
  const regiao: string | null = d.regiao ?? d.cidade ?? d.pop ?? d.bairro ?? null;

  switch (a.origem) {
    case 'ctos': {
      const pon = d.pon ?? null;
      return {
        correlacao: pon ? `pon:${pon}` : `cto:${d.cto_id ?? d.nome ?? a.chave}`,
        equipamento: host, alvo: pon ? `PON ${pon}` : (d.nome ?? null), clientes, regiao,
      };
    }
    case 'zabbix':
      return { correlacao: host ? `host:${host}` : `zabbix:${d.tipo ?? 'outro'}`, equipamento: host, alvo: d.nome ?? a.titulo, clientes, regiao };
    case 'netflow':
      return { correlacao: 'netflow', equipamento: host, alvo: d.alvo ?? null, clientes, regiao };
    case 'sla':
      return { correlacao: 'atendimento', equipamento: null, alvo: null, clientes, regiao };
    case 'bot':
      return { correlacao: `bot:${d.bot ?? 'desconhecido'}`, equipamento: host, alvo: d.alvo ?? null, clientes, regiao };
    default:
      return { correlacao: `${a.origem}:${a.chave}`, equipamento: host, alvo: null, clientes, regiao };
  }
}

// ─── Linha do tempo ──────────────────────────────────────────────────────────

export function registrarLinha(incidenteId: string, tipo: string, texto: string, ator?: string | null, dados?: unknown): void {
  db().prepare(
    `INSERT INTO incidente_evento (incidente_id, at, tipo, texto, ator, dados) VALUES (?,?,?,?,?,?)`,
  ).run(incidenteId, new Date().toISOString(), tipo, texto, ator ?? null, dados === undefined ? null : JSON.stringify(dados));
  db().prepare(`UPDATE incidente SET atualizado_em = ? WHERE id = ?`).run(new Date().toISOString(), incidenteId);
}

function proximoNumero(): string {
  const ano = new Date().getFullYear();
  const n = (db().prepare(
    `SELECT COUNT(*) n FROM incidente WHERE numero LIKE ?`,
  ).get(`INC-${ano}-%`) as { n: number }).n + 1;
  return `INC-${ano}-${String(n).padStart(5, '0')}`;
}

// ─── Correlação ──────────────────────────────────────────────────────────────

/** Incidente aberto do mesmo alvo dentro da janela. */
function incidenteAtivo(correlacao: string): Incidente | null {
  const janelaMin = obter<number>('incidentes.janela_correlacao_min');
  const desde = new Date(Date.now() - janelaMin * 60_000).toISOString();
  return (db().prepare(
    `SELECT * FROM incidente
      WHERE correlacao = ? AND estado IN (${ABERTOS.map(() => '?').join(',')}) AND atualizado_em >= ?
      ORDER BY aberto_em DESC LIMIT 1`,
  ).get(correlacao, ...ABERTOS, desde) as Incidente | undefined) ?? null;
}

/**
 * Alerta novo entra num incidente. Devolve null quando o alerta não vira
 * incidente (tipo desligado, severidade baixa ou acontecimento já encerrado).
 */
export function correlacionar(a: Alerta, opts: { evento?: boolean } = {}): Incidente | null {
  if (!obter<boolean>('incidentes.ativo')) return null;
  // Acontecimento (chamada da URA, resumo, "voltou ao normal") não abre incidente.
  if (opts.evento || a.resolvido_em) return null;
  const origens = obter<string[]>('incidentes.origens');
  if (!origens.includes(a.origem)) return null;
  const minima = obter<string>('incidentes.severidade_minima') as Severidade;
  const ordem: Severidade[] = ['info', 'aviso', 'critico'];
  if (ordem.indexOf(a.severidade) < ordem.indexOf(minima)) return null;

  const alvo = extrairAlvo(a);
  const sev = classificar(a.severidade, alvo.clientes);
  const agora = new Date().toISOString();
  const existente = incidenteAtivo(alvo.correlacao);

  if (existente) {
    const novaSev = maiorSeveridade(existente.severidade, sev);
    const clientes = Math.max(existente.clientes_afetados ?? 0, alvo.clientes ?? 0) || existente.clientes_afetados;
    const voltou = existente.estado === 'monitorando' || existente.estado === 'normalizado';
    db().prepare(
      `UPDATE incidente SET severidade = ?, clientes_afetados = ?, alertas = alertas + 1,
         atualizado_em = ?, estado = ?, normalizado_em = ?, reaberturas = ?
       WHERE id = ?`,
    ).run(
      novaSev, clientes, agora,
      voltou ? 'aberto' : existente.estado,
      voltou ? null : existente.normalizado_em,
      voltou ? existente.reaberturas + 1 : existente.reaberturas,
      existente.id,
    );
    ligarAlerta(existente.id, a.id);
    if (novaSev !== existente.severidade) {
      registrarLinha(existente.id, 'severidade', `Severidade subiu de ${ROTULO_SEVERIDADE[existente.severidade]} para ${ROTULO_SEVERIDADE[novaSev]}`, null, { de: existente.severidade, para: novaSev });
    }
    if (voltou) {
      registrarLinha(existente.id, 'reaberto', `Reaberto: o problema voltou durante a observação (${a.titulo})`, null, { alerta: a.chave });
      logger.warn('Incidente reaberto', { numero: existente.numero, alerta: a.chave });
    }
    registrarLinha(existente.id, 'alerta', `Alerta relacionado: ${a.titulo}`, null, { chave: a.chave, severidade: a.severidade });
    const atual = porId(existente.id)!;
    publicar('incidente', atual);
    return atual;
  }

  // Equipe de plantão: o incidente já nasce sabendo de quem é a vez. Falha
  // aqui não pode impedir o incidente de existir.
  let plantao: ReturnType<typeof plantaoParaAlerta> = null;
  try {
    plantao = plantaoParaAlerta({ tipo: tipoDoAlerta(a), severidade: a.severidade, regiao: alvo.regiao });
  } catch (err) {
    logger.warn('Incidente: falha ao consultar o plantão', { err: err instanceof Error ? err.message : String(err) });
  }

  const inc: Incidente = {
    degrau: 0, escalonado_em: null, atendido_em: null, violacoes: null,
    id: randomUUID(), numero: proximoNumero(), titulo: a.titulo, severidade: sev,
    estado: 'aberto', correlacao: alvo.correlacao, equipamento: alvo.equipamento, alvo: alvo.alvo,
    clientes_afetados: alvo.clientes, dono: null, equipe: plantao?.equipe.id ?? null, aberto_em: agora,
    reconhecido_em: null, reconhecido_por: null, normalizado_em: null, encerrado_em: null,
    reaberturas: 0, alertas: 1, atualizado_em: agora,
  };
  db().prepare(
    `INSERT INTO incidente (id, numero, titulo, severidade, estado, correlacao, equipamento, alvo,
       clientes_afetados, dono, equipe, aberto_em, reconhecido_em, reconhecido_por, normalizado_em,
       encerrado_em, reaberturas, alertas, atualizado_em)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    inc.id, inc.numero, inc.titulo, inc.severidade, inc.estado, inc.correlacao, inc.equipamento,
    inc.alvo, inc.clientes_afetados, null, inc.equipe, inc.aberto_em, null, null, null, null, 0, 1, agora,
  );
  ligarAlerta(inc.id, a.id);
  registrarLinha(inc.id, 'detectado', `Detectado: ${a.titulo}`, null, {
    chave: a.chave, origem: a.origem, severidade: inc.severidade, clientes: inc.clientes_afetados,
  });
  if (plantao) {
    // Quem estava na vez quando o problema apareceu. Fica registrado mesmo que
    // a escala mude depois: a linha do tempo conta o que era verdade na hora.
    registrarLinha(inc.id, 'plantao',
      plantao.plantonistas.length
        ? `Plantão da ${plantao.equipe.nome}: ${plantao.plantonistas.map((p) => p.nome).join(', ')}`
        : `Equipe ${plantao.equipe.nome} descoberta: ${plantao.motivo_vazio}`,
      null,
      { equipe: plantao.equipe.id, plantonistas: plantao.plantonistas.map((p) => p.nome), descoberta: plantao.vazio },
    );
  }
  logger.info('Incidente aberto', { numero: inc.numero, severidade: inc.severidade, correlacao: inc.correlacao });
  publicar('incidente', inc);
  return inc;
}

function ligarAlerta(incidenteId: string, alertaId: string): void {
  db().prepare(`INSERT OR IGNORE INTO incidente_alerta (incidente_id, alerta_id) VALUES (?,?)`).run(incidenteId, alertaId);
  db().prepare(`UPDATE alerta SET incidente_id = ? WHERE id = ? AND incidente_id IS NULL`).run(incidenteId, alertaId);
}

/**
 * Alerta do incidente foi resolvido. Com todos resolvidos, o incidente NÃO
 * encerra: entra em observação, e o monitor encerra depois da estabilidade.
 */
export function alertaResolvido(a: Alerta): Incidente | null {
  const linha = db().prepare(`SELECT incidente_id FROM incidente_alerta WHERE alerta_id = ?`).get(a.id) as { incidente_id: string } | undefined;
  if (!linha) return null;
  const inc = porId(linha.incidente_id);
  if (!inc || FECHADOS.includes(inc.estado)) return null;

  const abertos = (db().prepare(
    `SELECT COUNT(*) n FROM incidente_alerta ia JOIN alerta al ON al.id = ia.alerta_id
      WHERE ia.incidente_id = ? AND al.resolvido_em IS NULL`,
  ).get(inc.id) as { n: number }).n;
  registrarLinha(inc.id, 'alerta_resolvido', `Alerta normalizado: ${a.titulo}`, null, { chave: a.chave, restantes: abertos });
  if (abertos > 0) return porId(inc.id);

  const min = obter<number>('incidentes.estabilidade_min');
  db().prepare(`UPDATE incidente SET estado = 'monitorando', normalizado_em = ?, atualizado_em = ? WHERE id = ?`)
    .run(new Date().toISOString(), new Date().toISOString(), inc.id);
  registrarLinha(inc.id, 'monitorando', `Tudo normalizado. Em observação por ${min} min antes de encerrar.`);
  const atual = porId(inc.id)!;
  publicar('incidente', atual);
  return atual;
}

// ─── Ações de gente ──────────────────────────────────────────────────────────

export function assumir(id: string, quem: string, equipe?: string | null): Incidente {
  const inc = porId(id);
  if (!inc) throw new Error('incidente não encontrado');
  if (FECHADOS.includes(inc.estado)) throw new Error(`incidente já está ${ROTULO_ESTADO[inc.estado].toLowerCase()}`);
  const agora = new Date().toISOString();
  const primeiro = !inc.reconhecido_em;
  db().prepare(
    `UPDATE incidente SET dono = ?, equipe = COALESCE(?, equipe), estado = ?,
       reconhecido_em = COALESCE(reconhecido_em, ?), reconhecido_por = COALESCE(reconhecido_por, ?), atualizado_em = ?
     WHERE id = ?`,
  ).run(quem, equipe ?? null, inc.estado === 'monitorando' ? inc.estado : 'reconhecido', agora, quem, agora, inc.id);
  registrarLinha(inc.id, primeiro ? 'reconhecido' : 'transferido',
    primeiro ? `${quem} assumiu o incidente` : `Passou para ${quem}`, quem, { de: inc.dono, para: quem });
  registrarAuditoria(quem, primeiro ? 'incidente.assumir' : 'incidente.transferir', inc.numero, { dono: inc.dono }, { dono: quem });
  // Assumir fecha o ciclo de entrega: o alerta deixa de estar "só enviado".
  for (const linha of db().prepare(`SELECT alerta_id FROM incidente_alerta WHERE incidente_id = ?`).all(inc.id) as Array<{ alerta_id: string }>) {
    marcarReconhecido(linha.alerta_id);
  }
  const atual = porId(inc.id)!;
  publicar('incidente', atual);
  return atual;
}

export function mudarEstado(id: string, estado: EstadoIncidente, quem: string, nota?: string): Incidente {
  const inc = porId(id);
  if (!inc) throw new Error('incidente não encontrado');
  if (!ESTADOS.includes(estado)) throw new Error(`estado inválido: ${estado}`);
  const agora = new Date().toISOString();
  const encerra = FECHADOS.includes(estado);
  // "Em atendimento" é marco de SLA: guarda a primeira vez, não a última.
  db().prepare(
    `UPDATE incidente SET estado = ?, encerrado_em = ?, atualizado_em = ?,
       atendido_em = CASE WHEN ? = 'atendimento' THEN COALESCE(atendido_em, ?) ELSE atendido_em END
     WHERE id = ?`,
  ).run(estado, encerra ? agora : null, agora, estado, agora, inc.id);
  registrarLinha(inc.id, 'estado', `${ROTULO_ESTADO[estado]}${nota ? `: ${nota}` : ''}`, quem, { de: inc.estado, para: estado });
  registrarAuditoria(quem, 'incidente.estado', inc.numero, { estado: inc.estado }, { estado, nota: nota ?? null });
  const atual = porId(inc.id)!;
  publicar('incidente', atual);
  return atual;
}

export function comentar(id: string, texto: string, quem: string): Incidente {
  const inc = porId(id);
  if (!inc) throw new Error('incidente não encontrado');
  const t = String(texto ?? '').trim();
  if (!t) throw new Error('comentário vazio');
  registrarLinha(inc.id, 'comentario', t, quem);
  return porId(inc.id)!;
}

/** Duração em segundos, do começo até encerrar (ou até agora). */
export function duracaoSeg(i: Incidente): number {
  const fim = i.encerrado_em ? new Date(i.encerrado_em).getTime() : Date.now();
  return Math.max(0, Math.round((fim - new Date(i.aberto_em).getTime()) / 1000));
}

/** Tempo até alguém assumir, em segundos. null = ninguém assumiu ainda. */
export function tempoAteReconhecer(i: Incidente): number | null {
  if (!i.reconhecido_em) return null;
  return Math.max(0, Math.round((new Date(i.reconhecido_em).getTime() - new Date(i.aberto_em).getTime()) / 1000));
}

// ─── Encerramento automático ─────────────────────────────────────────────────

/**
 * Passa para encerrado o que ficou estável pelo tempo configurado. Roda no
 * monitor; devolve os que fechou.
 */
export function encerrarEstaveis(agora = new Date()): Incidente[] {
  const min = obter<number>('incidentes.estabilidade_min');
  const limite = new Date(agora.getTime() - min * 60_000).toISOString();
  const prontos = db().prepare(
    `SELECT * FROM incidente WHERE estado = 'monitorando' AND normalizado_em IS NOT NULL AND normalizado_em <= ?`,
  ).all(limite) as Incidente[];
  const fechados: Incidente[] = [];
  for (const inc of prontos) {
    db().prepare(`UPDATE incidente SET estado = 'encerrado', encerrado_em = ?, atualizado_em = ? WHERE id = ?`)
      .run(agora.toISOString(), agora.toISOString(), inc.id);
    registrarLinha(inc.id, 'encerrado', `Encerrado: estável por ${min} min`);
    const atual = porId(inc.id)!;
    fechados.push(atual);
    publicar('incidente', atual);
    logger.info('Incidente encerrado', { numero: inc.numero, duracaoSeg: duracaoSeg(atual) });
  }
  return fechados;
}
