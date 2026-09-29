// Histórico, métrica e pós-incidente.
//
// Alerta responde "o que está acontecendo". Isto responde "o que vive
// acontecendo", que é a pergunta que muda investimento: qual PON quebra toda
// semana, qual equipamento come o plantão, quanto tempo a operação leva para
// reconhecer.
//
// Sobre as siglas, com o significado exato usado aqui, porque medida sem
// definição vira discussão:
//   MTTD — do primeiro alerta até o incidente existir. Mede o NOSSO pipeline,
//          não o instante real da falha, que ninguém observou.
//   MTTA — da abertura até alguém assumir.
//   MTTR — da abertura até normalizar (ou encerrar).
// Fora isso: violação de SLA, taxa de reconhecimento, taxa de reabertura e
// taxa de falso positivo.

import { db, registrarAuditoria } from './store/db';
import { ABERTOS, Incidente, ROTULO_ESTADO, ROTULO_SEVERIDADE, porId, registrarLinha } from './incidentes';

export interface FiltroHistorico {
  texto?: string;
  equipamento?: string;
  pon?: string;
  cto?: string;
  regiao?: string;
  equipe?: string;
  severidade?: string;
  estado?: string;
  dias?: number;
  desde?: string;
  ate?: string;
  limite?: number;
}

function janela(f: FiltroHistorico): { desde: string; ate: string } {
  const ate = f.ate ?? new Date().toISOString();
  const desde = f.desde ?? new Date(Date.now() - (f.dias ?? 30) * 86_400_000).toISOString();
  return { desde, ate };
}

/**
 * Busca no histórico de incidentes. PON e CTO entram pela correlação e pelo
 * alvo, que é onde o B3 guardou quem foi atingido.
 */
export function buscar(f: FiltroHistorico = {}): Incidente[] {
  const { desde, ate } = janela(f);
  const cond = ['i.aberto_em >= ?', 'i.aberto_em <= ?'];
  const params: unknown[] = [desde, ate];

  if (f.texto) {
    cond.push('(i.titulo LIKE ? OR i.alvo LIKE ? OR i.equipamento LIKE ? OR i.numero LIKE ?)');
    const t = `%${f.texto}%`;
    params.push(t, t, t, `%${f.texto}%`);
  }
  if (f.equipamento) { cond.push('i.equipamento LIKE ?'); params.push(`%${f.equipamento}%`); }
  if (f.pon) { cond.push('(i.correlacao = ? OR i.alvo LIKE ?)'); params.push(`pon:${f.pon}`, `%PON ${f.pon}%`); }
  if (f.cto) { cond.push('(i.alvo LIKE ? OR i.titulo LIKE ?)'); params.push(`%${f.cto}%`, `%${f.cto}%`); }
  if (f.regiao) { cond.push('EXISTS (SELECT 1 FROM incidente_alerta ia JOIN alerta a ON a.id = ia.alerta_id WHERE ia.incidente_id = i.id AND a.dados LIKE ?)'); params.push(`%${f.regiao}%`); }
  if (f.equipe) { cond.push('i.equipe = ?'); params.push(f.equipe); }
  if (f.severidade) { cond.push('i.severidade = ?'); params.push(f.severidade); }
  if (f.estado === 'abertos') {
    cond.push(`i.estado IN (${ABERTOS.map(() => '?').join(',')})`);
    params.push(...ABERTOS);
  } else if (f.estado) {
    cond.push('i.estado = ?');
    params.push(f.estado);
  }

  params.push(Math.min(500, f.limite ?? 100));
  return db().prepare(
    `SELECT i.* FROM incidente i WHERE ${cond.join(' AND ')} ORDER BY i.aberto_em DESC LIMIT ?`,
  ).all(...params) as Incidente[];
}

export interface LinhaRecorrencia {
  chave: string;
  rotulo: string;
  incidentes: number;
  clientes_afetados: number;
  tempo_total_seg: number;
  ultima_vez: string;
  reaberturas: number;
}

/**
 * O que mais quebra na janela. Agrupa pela correlação (PON, equipamento,
 * sistema) porque é ela que identifica o MESMO problema ao longo do tempo.
 */
export function recorrencia(f: FiltroHistorico & { por?: 'correlacao' | 'equipamento' } = {}): LinhaRecorrencia[] {
  const { desde, ate } = janela(f);
  const campo = f.por === 'equipamento' ? 'equipamento' : 'correlacao';
  const linhas = db().prepare(
    `SELECT COALESCE(${campo}, 'sem identificação') chave,
            COUNT(*) incidentes,
            COALESCE(MAX(clientes_afetados), 0) clientes_afetados,
            SUM(CAST((julianday(COALESCE(encerrado_em, normalizado_em, ?)) - julianday(aberto_em)) * 86400 AS INTEGER)) tempo_total_seg,
            MAX(aberto_em) ultima_vez,
            SUM(reaberturas) reaberturas,
            MAX(titulo) titulo, MAX(alvo) alvo
       FROM incidente
      WHERE aberto_em >= ? AND aberto_em <= ?
      GROUP BY chave
      ORDER BY incidentes DESC, tempo_total_seg DESC
      LIMIT ?`,
  ).all(ate, desde, ate, Math.min(200, f.limite ?? 20)) as Array<LinhaRecorrencia & { titulo: string; alvo: string | null }>;
  return linhas.map((l) => ({
    chave: l.chave,
    rotulo: l.alvo || l.titulo || l.chave,
    incidentes: l.incidentes,
    clientes_afetados: l.clientes_afetados,
    tempo_total_seg: l.tempo_total_seg ?? 0,
    ultima_vez: l.ultima_vez,
    reaberturas: l.reaberturas ?? 0,
  }));
}

export interface Metricas {
  periodo: { desde: string; ate: string };
  incidentes: number;
  abertos: number;
  mttd_seg: number | null;
  mtta_seg: number | null;
  mttr_seg: number | null;
  reconhecidos: number;
  taxa_reconhecimento: number;
  violacoes_sla: number;
  taxa_violacao_sla: number;
  reabertos: number;
  taxa_reabertura: number;
  falsos_positivos: number;
  taxa_falso_positivo: number;
  por_severidade: Array<{ severidade: string; rotulo: string; n: number }>;
  por_estado: Array<{ estado: string; rotulo: string; n: number }>;
  sem_dono_agora: number;
}

const seg = (de: string | null, ate: string | null): number | null =>
  de && ate ? Math.max(0, Math.round((new Date(ate).getTime() - new Date(de).getTime()) / 1000)) : null;

function media(valores: Array<number | null>): number | null {
  const v = valores.filter((x): x is number => x !== null);
  return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null;
}

export function metricas(f: FiltroHistorico = {}): Metricas {
  const { desde, ate } = janela(f);
  const lista = buscar({ ...f, desde, ate, limite: 500 });
  const total = lista.length;

  // MTTD: do primeiro alerta ligado até o incidente nascer.
  const deteccao = lista.map((i) => {
    const primeiro = db().prepare(
      `SELECT MIN(a.criado_em) em FROM incidente_alerta ia JOIN alerta a ON a.id = ia.alerta_id WHERE ia.incidente_id = ?`,
    ).get(i.id) as { em: string | null } | undefined;
    return seg(primeiro?.em ?? null, i.aberto_em);
  });

  const reconhecidos = lista.filter((i) => i.reconhecido_em).length;
  const violacoes = lista.filter((i) => {
    try { return (JSON.parse(i.violacoes ?? '[]') as string[]).length > 0; } catch { return false; }
  }).length;
  const reabertos = lista.filter((i) => i.reaberturas > 0).length;
  const falsos = lista.filter((i) => i.estado === 'falso_positivo').length;
  const taxa = (n: number) => (total ? Math.round((n / total) * 1000) / 10 : 0);

  const contar = <T extends string>(campo: 'severidade' | 'estado'): Array<{ chave: T; n: number }> => {
    const m = new Map<string, number>();
    for (const i of lista) m.set(i[campo], (m.get(i[campo]) ?? 0) + 1);
    return [...m.entries()].map(([chave, n]) => ({ chave: chave as T, n })).sort((a, b) => b.n - a.n);
  };

  return {
    periodo: { desde, ate },
    incidentes: total,
    abertos: lista.filter((i) => ABERTOS.includes(i.estado)).length,
    mttd_seg: media(deteccao),
    mtta_seg: media(lista.map((i) => seg(i.aberto_em, i.reconhecido_em))),
    mttr_seg: media(lista.map((i) => seg(i.aberto_em, i.normalizado_em ?? i.encerrado_em))),
    reconhecidos,
    taxa_reconhecimento: taxa(reconhecidos),
    violacoes_sla: violacoes,
    taxa_violacao_sla: taxa(violacoes),
    reabertos,
    taxa_reabertura: taxa(reabertos),
    falsos_positivos: falsos,
    taxa_falso_positivo: taxa(falsos),
    por_severidade: contar('severidade').map((x) => ({ severidade: x.chave, rotulo: ROTULO_SEVERIDADE[x.chave as keyof typeof ROTULO_SEVERIDADE] ?? x.chave, n: x.n })),
    por_estado: contar('estado').map((x) => ({ estado: x.chave, rotulo: ROTULO_ESTADO[x.chave as keyof typeof ROTULO_ESTADO] ?? x.chave, n: x.n })),
    sem_dono_agora: lista.filter((i) => ABERTOS.includes(i.estado) && !i.dono).length,
  };
}

// ─── Pós-incidente ───────────────────────────────────────────────────────────

export interface AcaoPos {
  o_que: string;
  responsavel: string | null;
  prazo: string | null;
  feito: boolean;
}

export interface PosIncidente {
  incidente_id: string;
  o_que_aconteceu: string;
  causa_raiz: string;
  acoes: AcaoPos[];
  licoes: string | null;
  autor: string | null;
  criado_em: string;
  atualizado_em: string;
}

interface LinhaPos extends Omit<PosIncidente, 'acoes'> { acoes: string }

function paraPos(l: LinhaPos): PosIncidente {
  let acoes: AcaoPos[] = [];
  try { acoes = JSON.parse(l.acoes); } catch { acoes = []; }
  return { ...l, acoes };
}

export function posDoIncidente(id: string): PosIncidente | null {
  const l = db().prepare(`SELECT * FROM pos_incidente WHERE incidente_id = ?`).get(id) as LinhaPos | undefined;
  return l ? paraPos(l) : null;
}

function validarAcoes(v: unknown): AcaoPos[] {
  const arr = Array.isArray(v) ? v : [];
  return arr.map((x) => {
    const a = x as Partial<AcaoPos>;
    const oQue = String(a.o_que ?? '').trim();
    if (!oQue) throw new Error('ação sem descrição');
    return {
      o_que: oQue,
      responsavel: a.responsavel ? String(a.responsavel).trim() : null,
      prazo: a.prazo ? String(a.prazo) : null,
      feito: a.feito === true,
    };
  });
}

/**
 * Grava o pós-incidente. Causa raiz é obrigatória: registro sem causa é
 * relatório, e relatório ninguém lê duas vezes.
 */
export function salvarPos(incidenteId: string, d: {
  o_que_aconteceu?: string; causa_raiz?: string; acoes?: unknown; licoes?: string;
}, autor: string): PosIncidente {
  const inc = porId(incidenteId);
  if (!inc) throw new Error('incidente não encontrado');
  const causa = String(d.causa_raiz ?? '').trim();
  if (!causa) throw new Error('escreva a causa raiz');
  const relato = String(d.o_que_aconteceu ?? '').trim();
  if (!relato) throw new Error('escreva o que aconteceu');
  const acoes = validarAcoes(d.acoes);
  const agora = new Date().toISOString();
  const antes = posDoIncidente(inc.id);

  db().prepare(
    `INSERT INTO pos_incidente (incidente_id, o_que_aconteceu, causa_raiz, acoes, licoes, autor, criado_em, atualizado_em)
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(incidente_id) DO UPDATE SET o_que_aconteceu=excluded.o_que_aconteceu,
       causa_raiz=excluded.causa_raiz, acoes=excluded.acoes, licoes=excluded.licoes,
       autor=excluded.autor, atualizado_em=excluded.atualizado_em`,
  ).run(inc.id, relato, causa, JSON.stringify(acoes), String(d.licoes ?? '').trim() || null,
    autor, antes?.criado_em ?? agora, agora);

  registrarLinha(inc.id, 'pos_incidente',
    antes ? 'Pós-incidente atualizado' : `Pós-incidente registrado: ${causa}`, autor,
    { causa_raiz: causa, acoes: acoes.length });
  registrarAuditoria(autor, antes ? 'pos_incidente.editar' : 'pos_incidente.criar', inc.numero, antes, posDoIncidente(inc.id));
  return posDoIncidente(inc.id)!;
}

/** Ações combinadas que ninguém fechou. É o que costuma virar o próximo incidente. */
export function acoesPendentes(limite = 100): Array<{ numero: string; titulo: string; acao: AcaoPos }> {
  const linhas = db().prepare(
    `SELECT p.acoes, i.numero, i.titulo FROM pos_incidente p JOIN incidente i ON i.id = p.incidente_id
      ORDER BY p.atualizado_em DESC LIMIT ?`,
  ).all(Math.min(500, limite)) as Array<{ acoes: string; numero: string; titulo: string }>;
  const saida: Array<{ numero: string; titulo: string; acao: AcaoPos }> = [];
  for (const l of linhas) {
    let acoes: AcaoPos[] = [];
    try { acoes = JSON.parse(l.acoes); } catch { acoes = []; }
    for (const a of acoes) if (!a.feito) saida.push({ numero: l.numero, titulo: l.titulo, acao: a });
  }
  return saida;
}
