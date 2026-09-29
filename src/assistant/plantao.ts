// Plantão: quem responde agora, e quem responde se essa pessoa não responder.
//
// O alerta já sabia PARA ONDE ir (grupo e lista de pessoas). O que faltava era
// saber DE QUEM é a vez. Sem isso, às 3 da manhã o alerta chega para dez
// pessoas e nenhuma se sente responsável — ou chega só para quem está de
// férias.
//
// Três coisas moram aqui:
//   1. ESCALA — janela de turno (dias da semana e horário) com uma fila de
//      pessoas. Fixa: todo mundo da fila. Rotativa: uma por ciclo, contada de
//      uma data âncora, então a conta vale para qualquer dia, passado ou futuro.
//   2. EXCEÇÃO — folga, férias, ausência, troca e plantão extraordinário. A
//      exceção vale mais que a escala: com substituto, passa a vez; sem
//      substituto, a rotação anda para o próximo da fila.
//   3. CADEIA — plantonista, substituto da equipe, supervisor, segundo nível e
//      gerência. Degrau vazio continua aparecendo: a lacuna é informação, e é
//      o que o escalonamento por tempo (B5) vai subir.
//
// Pessoa de plantão é uma linha de `alerta_destino`: quem já está cadastrado
// para receber alerta no WhatsApp. Não existe um segundo cadastro de gente.

import { randomUUID } from 'crypto';
import { config } from '../config';
import { db, registrarAuditoria } from './store/db';
import { obter } from './config-dinamica';
import { TIPOS_ALERTA, SEVERIDADES, TipoAlerta } from './destinos-alerta';
import type { Severidade } from './alertas';

export const TIPOS_ESCALA = ['fixa', 'rotativa'] as const;
export type TipoEscala = (typeof TIPOS_ESCALA)[number];

export const TIPOS_EXCECAO = ['folga', 'ferias', 'ausencia', 'troca', 'extra'] as const;
export type TipoExcecao = (typeof TIPOS_EXCECAO)[number];

export const ROTULO_EXCECAO: Record<TipoExcecao, string> = {
  folga: 'Folga', ferias: 'Férias', ausencia: 'Ausência', troca: 'Troca',
  extra: 'Plantão extraordinário',
};

/** Exceção que tira a pessoa do turno. "extra" não tira ninguém: acrescenta. */
const AUSENTES: TipoExcecao[] = ['folga', 'ferias', 'ausencia', 'troca'];

export const DIAS_SEMANA = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'] as const;

export interface Pessoa {
  id: number;
  nome: string;
  numero: string;
  ativo: boolean;
  grupo: boolean;
}

export interface EquipePlantao {
  id: string;
  nome: string;
  ativo: boolean;
  regiao: string | null;
  tipos: TipoAlerta[] | null;
  severidade_minima: Severidade;
  supervisor: Pessoa | null;
  substituto: Pessoa | null;
  escalonamento: string[];
  grupo: string | null;
}

export interface Escala {
  id: string;
  equipe_id: string;
  nome: string;
  tipo: TipoEscala;
  dias: number[];
  hora_inicio: string;
  hora_fim: string;
  pessoas: number[];
  rotacao_dias: number;
  ancora: string;
  ativo: boolean;
  criado_em: string;
}

export interface Excecao {
  id: string;
  tipo: TipoExcecao;
  pessoa_id: number;
  substituto_id: number | null;
  equipe_id: string | null;
  inicio: string;
  fim: string;
  motivo: string | null;
  criado_por: string | null;
  criado_em: string;
}

export interface Turno {
  escala_id: string;
  nome: string;
  /** Data local (AAAA-MM-DD) em que o turno começou: é ela que conta a rotação. */
  dia: string;
  inicio: string;
  fim: string;
  /** Turno que atravessa a meia-noite. */
  vira_o_dia: boolean;
}

export interface Substituicao {
  de: Pessoa;
  para: Pessoa | null;
  tipo: TipoExcecao;
  motivo: string | null;
}

export interface PlantaoEquipe {
  equipe: EquipePlantao;
  turnos: Array<{ turno: Turno; plantonistas: Pessoa[] }>;
  plantonistas: Pessoa[];
  substituicoes: Substituicao[];
  extras: Pessoa[];
  proximo: { turno: Turno; plantonistas: Pessoa[] } | null;
  /** Ninguém de plantão agora: a equipe está descoberta. */
  vazio: boolean;
  motivo_vazio: string | null;
}

export interface Degrau {
  nivel: 'plantonista' | 'substituto' | 'supervisor' | 'segundo_nivel' | 'gerencia';
  rotulo: string;
  pessoas: Pessoa[];
  equipe?: string;
}

const ROTULO_NIVEL: Record<Degrau['nivel'], string> = {
  plantonista: 'Plantonista', substituto: 'Substituto da equipe', supervisor: 'Supervisor',
  segundo_nivel: 'Segundo nível', gerencia: 'Gerência',
};

// ─── Horário local ───────────────────────────────────────────────────────────

interface Local { dia: string; hm: string; dow: number; minutos: number }

/** Data, hora e dia da semana no fuso da operação. A escala é escrita em hora local. */
function agoraLocal(d: Date): Local {
  const p: Record<string, string> = {};
  for (const x of new Intl.DateTimeFormat('en-GB', {
    timeZone: config.tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d)) p[x.type] = x.value;
  if (p.hour === '24') p.hour = '00';
  const dia = `${p.year}-${p.month}-${p.day}`;
  return {
    dia,
    hm: `${p.hour}:${p.minute}`,
    dow: new Date(`${dia}T00:00:00Z`).getUTCDay(),
    minutos: Number(p.hour) * 60 + Number(p.minute),
  };
}

function somarDias(dia: string, n: number): string {
  return new Date(Date.parse(`${dia}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

function diaDaSemana(dia: string): number {
  return new Date(`${dia}T00:00:00Z`).getUTCDay();
}

function emMinutos(hm: string): number {
  const [h, m] = hm.split(':').map(Number);
  return h * 60 + m;
}

/** Duração do turno em minutos. Início igual ao fim significa 24 horas. */
function duracaoTurno(e: Pick<Escala, 'hora_inicio' | 'hora_fim'>): number {
  const d = (emMinutos(e.hora_fim) - emMinutos(e.hora_inicio) + 1440) % 1440;
  return d === 0 ? 1440 : d;
}

function montarTurno(e: Escala, dia: string): Turno {
  const dur = duracaoTurno(e);
  const vira = emMinutos(e.hora_inicio) + dur > 1440;
  return {
    escala_id: e.id,
    nome: e.nome,
    dia,
    inicio: `${dia} ${e.hora_inicio}`,
    fim: `${vira ? somarDias(dia, 1) : dia} ${e.hora_fim}`,
    vira_o_dia: vira,
  };
}

// ─── Leitura ─────────────────────────────────────────────────────────────────

interface LinhaPessoa { id: number; nome: string; numero: string; ativo: number }

function paraPessoa(l: LinhaPessoa): Pessoa {
  return { id: l.id, nome: l.nome, numero: l.numero, ativo: l.ativo === 1, grupo: l.numero.endsWith('@g.us') };
}

export function pessoas(): Pessoa[] {
  return (db().prepare(`SELECT id, nome, numero, ativo FROM alerta_destino ORDER BY nome`).all() as LinhaPessoa[])
    .map(paraPessoa);
}

export function pessoaPorId(id: number | null | undefined): Pessoa | null {
  if (id === null || id === undefined || !Number.isFinite(Number(id))) return null;
  const l = db().prepare(`SELECT id, nome, numero, ativo FROM alerta_destino WHERE id = ?`).get(id) as LinhaPessoa | undefined;
  return l ? paraPessoa(l) : null;
}

interface LinhaEquipe {
  id: string; nome: string; ativo: number; regiao: string | null; tipos: string | null;
  severidade_minima: string | null; supervisor_id: number | null; substituto_id: number | null;
  escalonamento: string | null; grupo: string | null;
}

function lerLista<T>(v: string | null): T[] | null {
  if (!v) return null;
  try { const x = JSON.parse(v); return Array.isArray(x) ? x : null; } catch { return null; }
}

function paraEquipe(l: LinhaEquipe): EquipePlantao {
  return {
    id: l.id, nome: l.nome, ativo: l.ativo === 1, regiao: l.regiao || null,
    tipos: lerLista<TipoAlerta>(l.tipos),
    severidade_minima: (l.severidade_minima as Severidade) || 'aviso',
    supervisor: pessoaPorId(l.supervisor_id), substituto: pessoaPorId(l.substituto_id),
    escalonamento: lerLista<string>(l.escalonamento) ?? [],
    grupo: l.grupo || null,
  };
}

export function equipes(): EquipePlantao[] {
  return (db().prepare(`SELECT * FROM equipe ORDER BY nome`).all() as LinhaEquipe[]).map(paraEquipe);
}

export function equipePorId(id: string): EquipePlantao | null {
  const l = db().prepare(`SELECT * FROM equipe WHERE id = ?`).get(id) as LinhaEquipe | undefined;
  return l ? paraEquipe(l) : null;
}

interface LinhaEscala {
  id: string; equipe_id: string; nome: string; tipo: string; dias: string;
  hora_inicio: string; hora_fim: string; pessoas: string; rotacao_dias: number;
  ancora: string; ativo: number; criado_em: string;
}

function paraEscala(l: LinhaEscala): Escala {
  return {
    id: l.id, equipe_id: l.equipe_id, nome: l.nome, tipo: l.tipo as TipoEscala,
    dias: lerLista<number>(l.dias) ?? [], hora_inicio: l.hora_inicio, hora_fim: l.hora_fim,
    pessoas: lerLista<number>(l.pessoas) ?? [], rotacao_dias: l.rotacao_dias, ancora: l.ancora,
    ativo: l.ativo === 1, criado_em: l.criado_em,
  };
}

export function listarEscalas(equipeId?: string): Escala[] {
  const linhas = equipeId
    ? db().prepare(`SELECT * FROM escala WHERE equipe_id = ? ORDER BY nome`).all(equipeId)
    : db().prepare(`SELECT * FROM escala ORDER BY equipe_id, nome`).all();
  return (linhas as LinhaEscala[]).map(paraEscala);
}

export function escalaPorId(id: string): Escala | null {
  const l = db().prepare(`SELECT * FROM escala WHERE id = ?`).get(id) as LinhaEscala | undefined;
  return l ? paraEscala(l) : null;
}

export function listarExcecoes(
  opts: { pessoa_id?: number; equipe_id?: string; desde?: string; ate?: string; limite?: number } = {},
): Excecao[] {
  const cond: string[] = [];
  const params: unknown[] = [];
  if (opts.pessoa_id !== undefined) {
    cond.push('(pessoa_id = ? OR substituto_id = ?)');
    params.push(opts.pessoa_id, opts.pessoa_id);
  }
  if (opts.equipe_id) {
    cond.push('(equipe_id = ? OR equipe_id IS NULL)');
    params.push(opts.equipe_id);
  }
  if (opts.desde) { cond.push('fim >= ?'); params.push(opts.desde); }
  if (opts.ate) { cond.push('inicio <= ?'); params.push(opts.ate); }
  const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
  params.push(Math.min(500, opts.limite ?? 200));
  return db().prepare(`SELECT * FROM plantao_excecao ${where} ORDER BY inicio DESC LIMIT ?`).all(...params) as Excecao[];
}

/** Exceções que valem neste instante. */
function excecoesVigentes(quando: Date): Excecao[] {
  const iso = quando.toISOString();
  return db().prepare(
    `SELECT * FROM plantao_excecao WHERE inicio <= ? AND fim > ? ORDER BY criado_em`,
  ).all(iso, iso) as Excecao[];
}

// ─── Escrita ─────────────────────────────────────────────────────────────────

const HORA = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATA = /^\d{4}-\d{2}-\d{2}$/;

function validarPessoas(v: unknown): number[] {
  const arr = Array.isArray(v) ? v : [];
  const ids = [...new Set(arr.map((x) => Number(x)))].filter((n) => Number.isInteger(n));
  if (!ids.length) throw new Error('escolha pelo menos uma pessoa para a escala');
  for (const id of ids) {
    if (!pessoaPorId(id)) throw new Error(`pessoa ${id} não está cadastrada em "Quem recebe alertas"`);
  }
  return ids;
}

function validarDias(v: unknown): number[] {
  const arr = Array.isArray(v) ? v : [];
  const dias = [...new Set(arr.map((x) => Number(x)))]
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6)
    .sort((a, b) => a - b);
  if (!dias.length) throw new Error('escolha pelo menos um dia da semana');
  return dias;
}

export function criarEscala(d: {
  equipe_id?: string; nome?: string; tipo?: string; dias?: unknown; hora_inicio?: string;
  hora_fim?: string; pessoas?: unknown; rotacao_dias?: number; ancora?: string; ativo?: boolean;
}, autor: string): Escala {
  const equipe = equipePorId(String(d.equipe_id ?? ''));
  if (!equipe) throw new Error('equipe inexistente');
  const nome = String(d.nome ?? '').trim();
  if (!nome) throw new Error('dê um nome ao turno (ex.: Noturno, Fim de semana)');
  const tipo = String(d.tipo ?? 'fixa') as TipoEscala;
  if (!TIPOS_ESCALA.includes(tipo)) throw new Error(`tipo de escala inválido: ${tipo}`);
  const ini = String(d.hora_inicio ?? '');
  const fim = String(d.hora_fim ?? '');
  if (!HORA.test(ini) || !HORA.test(fim)) throw new Error('horário precisa estar no formato HH:MM');
  const ancora = String(d.ancora ?? '').trim() || agoraLocal(new Date()).dia;
  if (!DATA.test(ancora)) throw new Error('data de início da rotação precisa ser AAAA-MM-DD');
  const rot = Number(d.rotacao_dias ?? 7);
  if (!Number.isInteger(rot) || rot < 1 || rot > 90) throw new Error('ciclo da rotação precisa ser de 1 a 90 dias');

  const e: Escala = {
    id: randomUUID(), equipe_id: equipe.id, nome, tipo, dias: validarDias(d.dias),
    hora_inicio: ini, hora_fim: fim, pessoas: validarPessoas(d.pessoas), rotacao_dias: rot,
    ancora, ativo: d.ativo !== false, criado_em: new Date().toISOString(),
  };
  db().prepare(
    `INSERT INTO escala (id, equipe_id, nome, tipo, dias, hora_inicio, hora_fim, pessoas,
       rotacao_dias, ancora, ativo, criado_em)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(e.id, e.equipe_id, e.nome, e.tipo, JSON.stringify(e.dias), e.hora_inicio, e.hora_fim,
    JSON.stringify(e.pessoas), e.rotacao_dias, e.ancora, e.ativo ? 1 : 0, e.criado_em);
  registrarAuditoria(autor, 'escala.criar', `${e.equipe_id}/${e.nome}`, undefined, e);
  return e;
}

export function atualizarEscala(id: string, d: {
  nome?: string; tipo?: string; dias?: unknown; hora_inicio?: string; hora_fim?: string;
  pessoas?: unknown; rotacao_dias?: number; ancora?: string; ativo?: boolean;
}, autor: string): Escala {
  const antes = escalaPorId(id);
  if (!antes) throw new Error('escala não encontrada');
  const e = {
    nome: d.nome !== undefined && String(d.nome).trim() ? String(d.nome).trim() : antes.nome,
    tipo: d.tipo !== undefined ? String(d.tipo) as TipoEscala : antes.tipo,
    dias: d.dias !== undefined ? validarDias(d.dias) : antes.dias,
    hora_inicio: d.hora_inicio !== undefined ? String(d.hora_inicio) : antes.hora_inicio,
    hora_fim: d.hora_fim !== undefined ? String(d.hora_fim) : antes.hora_fim,
    pessoas: d.pessoas !== undefined ? validarPessoas(d.pessoas) : antes.pessoas,
    rotacao_dias: d.rotacao_dias !== undefined ? Number(d.rotacao_dias) : antes.rotacao_dias,
    ancora: d.ancora !== undefined ? String(d.ancora) : antes.ancora,
    ativo: d.ativo !== undefined ? d.ativo !== false : antes.ativo,
  };
  if (!TIPOS_ESCALA.includes(e.tipo)) throw new Error(`tipo de escala inválido: ${e.tipo}`);
  if (!HORA.test(e.hora_inicio) || !HORA.test(e.hora_fim)) throw new Error('horário precisa estar no formato HH:MM');
  if (!DATA.test(e.ancora)) throw new Error('data de início da rotação precisa ser AAAA-MM-DD');
  if (!Number.isInteger(e.rotacao_dias) || e.rotacao_dias < 1 || e.rotacao_dias > 90) {
    throw new Error('ciclo da rotação precisa ser de 1 a 90 dias');
  }

  db().prepare(
    `UPDATE escala SET nome = ?, tipo = ?, dias = ?, hora_inicio = ?, hora_fim = ?, pessoas = ?,
       rotacao_dias = ?, ancora = ?, ativo = ? WHERE id = ?`,
  ).run(e.nome, e.tipo, JSON.stringify(e.dias), e.hora_inicio, e.hora_fim, JSON.stringify(e.pessoas),
    e.rotacao_dias, e.ancora, e.ativo ? 1 : 0, id);
  const depois = escalaPorId(id)!;
  registrarAuditoria(autor, 'escala.editar', `${antes.equipe_id}/${depois.nome}`, antes, depois);
  return depois;
}

export function removerEscala(id: string, autor: string): void {
  const antes = escalaPorId(id);
  if (!antes) throw new Error('escala não encontrada');
  db().prepare(`DELETE FROM escala WHERE id = ?`).run(id);
  registrarAuditoria(autor, 'escala.remover', `${antes.equipe_id}/${antes.nome}`, antes, undefined);
}

export function criarExcecao(d: {
  tipo?: string; pessoa_id?: unknown; substituto_id?: unknown; equipe_id?: unknown;
  inicio?: string; fim?: string; motivo?: string;
}, autor: string): Excecao {
  const tipo = String(d.tipo ?? '') as TipoExcecao;
  if (!TIPOS_EXCECAO.includes(tipo)) throw new Error(`tipo inválido; use ${TIPOS_EXCECAO.join(', ')}`);
  const pessoa = pessoaPorId(Number(d.pessoa_id));
  if (!pessoa) throw new Error('pessoa não cadastrada em "Quem recebe alertas"');
  const temSub = d.substituto_id !== undefined && d.substituto_id !== null && d.substituto_id !== '';
  const sub = temSub ? pessoaPorId(Number(d.substituto_id)) : null;
  if (temSub && !sub) throw new Error('substituto não cadastrado');
  if (sub && sub.id === pessoa.id) throw new Error('a pessoa não pode ser substituta de si mesma');
  if (tipo === 'troca' && !sub) throw new Error('troca precisa de um substituto');
  const equipeId = d.equipe_id ? String(d.equipe_id) : null;
  if (tipo === 'extra' && !equipeId) throw new Error('plantão extraordinário precisa da equipe');
  if (equipeId && !equipePorId(equipeId)) throw new Error('equipe inexistente');
  const inicio = new Date(String(d.inicio ?? ''));
  const fim = new Date(String(d.fim ?? ''));
  if (Number.isNaN(inicio.getTime()) || Number.isNaN(fim.getTime())) throw new Error('informe início e fim');
  if (fim.getTime() <= inicio.getTime()) throw new Error('o fim precisa ser depois do início');

  const x: Excecao = {
    id: randomUUID(), tipo, pessoa_id: pessoa.id, substituto_id: sub?.id ?? null, equipe_id: equipeId,
    inicio: inicio.toISOString(), fim: fim.toISOString(), motivo: String(d.motivo ?? '').trim() || null,
    criado_por: autor, criado_em: new Date().toISOString(),
  };
  db().prepare(
    `INSERT INTO plantao_excecao (id, tipo, pessoa_id, substituto_id, equipe_id, inicio, fim,
       motivo, criado_por, criado_em)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(x.id, x.tipo, x.pessoa_id, x.substituto_id, x.equipe_id, x.inicio, x.fim, x.motivo, x.criado_por, x.criado_em);
  registrarAuditoria(autor, 'plantao.excecao.criar', `${ROTULO_EXCECAO[tipo]} de ${pessoa.nome}`, undefined, x);
  return x;
}

export function removerExcecao(id: string, autor: string): void {
  const antes = db().prepare(`SELECT * FROM plantao_excecao WHERE id = ?`).get(id) as Excecao | undefined;
  if (!antes) throw new Error('registro não encontrado');
  db().prepare(`DELETE FROM plantao_excecao WHERE id = ?`).run(id);
  registrarAuditoria(autor, 'plantao.excecao.remover', antes.tipo, antes, undefined);
}

export function atualizarEquipe(id: string, d: {
  regiao?: string | null; tipos?: unknown; severidade_minima?: string; supervisor_id?: unknown;
  substituto_id?: unknown; escalonamento?: unknown; grupo?: string | null;
}, autor: string): EquipePlantao {
  const antes = equipePorId(id);
  if (!antes) throw new Error('equipe não encontrada');

  let tipos = antes.tipos;
  if (d.tipos !== undefined) {
    const arr = (Array.isArray(d.tipos) ? d.tipos : []).map(String);
    const invalidos = arr.filter((t) => !(t in TIPOS_ALERTA));
    if (invalidos.length) throw new Error(`tipo de alerta inválido: ${invalidos.join(', ')}`);
    tipos = arr.length ? (arr as TipoAlerta[]) : null;
  }

  let sev = antes.severidade_minima;
  if (d.severidade_minima !== undefined) {
    const s = String(d.severidade_minima);
    if (!SEVERIDADES.includes(s as Severidade)) throw new Error(`gravidade inválida: ${s}`);
    sev = s as Severidade;
  }

  const pessoaOuNulo = (v: unknown, rotulo: string): number | null => {
    if (v === null || v === undefined || v === '') return null;
    const p = pessoaPorId(Number(v));
    if (!p) throw new Error(`${rotulo} não está cadastrado em "Quem recebe alertas"`);
    return p.id;
  };
  const supervisor = d.supervisor_id !== undefined
    ? pessoaOuNulo(d.supervisor_id, 'supervisor') : antes.supervisor?.id ?? null;
  const substituto = d.substituto_id !== undefined
    ? pessoaOuNulo(d.substituto_id, 'substituto') : antes.substituto?.id ?? null;

  let escalonamento = antes.escalonamento;
  if (d.escalonamento !== undefined) {
    const arr = (Array.isArray(d.escalonamento) ? d.escalonamento : []).map(String).filter(Boolean);
    for (const e of arr) {
      if (e === id) throw new Error('a equipe não pode escalar para ela mesma');
      if (!equipePorId(e)) throw new Error(`equipe inexistente no escalonamento: ${e}`);
    }
    escalonamento = [...new Set(arr)];
  }

  db().prepare(
    `UPDATE equipe SET regiao = ?, tipos = ?, severidade_minima = ?, supervisor_id = ?,
       substituto_id = ?, escalonamento = ?, grupo = ? WHERE id = ?`,
  ).run(
    d.regiao !== undefined ? (String(d.regiao ?? '').trim() || null) : antes.regiao,
    tipos ? JSON.stringify(tipos) : null, sev, supervisor, substituto,
    escalonamento.length ? JSON.stringify(escalonamento) : null,
    d.grupo !== undefined ? (String(d.grupo ?? '').trim() || null) : antes.grupo,
    id,
  );
  const depois = equipePorId(id)!;
  registrarAuditoria(autor, 'equipe.plantao', id, antes, depois);
  return depois;
}

// ─── Quem está de plantão ────────────────────────────────────────────────────

/** Turno desta escala que contém o instante. Compara em minutos do dia local. */
export function turnoAtivo(e: Escala, quando = new Date()): Turno | null {
  if (!e.ativo) return null;
  const L = agoraLocal(quando);
  const ini = emMinutos(e.hora_inicio);
  const dur = duracaoTurno(e);

  // Turno que começou hoje.
  if (e.dias.includes(L.dow) && L.minutos >= ini && L.minutos < ini + dur) return montarTurno(e, L.dia);

  // Turno que começou ontem e atravessou a meia-noite.
  const restante = ini + dur - 1440;
  if (restante > 0) {
    const ontem = somarDias(L.dia, -1);
    if (e.dias.includes(diaDaSemana(ontem)) && L.minutos < restante) return montarTurno(e, ontem);
  }
  return null;
}

/** Próximo turno que ainda não começou, olhando 14 dias à frente. */
export function proximoTurno(e: Escala, quando = new Date()): Turno | null {
  if (!e.ativo || !e.dias.length) return null;
  const L = agoraLocal(quando);
  const ini = emMinutos(e.hora_inicio);
  for (let i = 0; i <= 14; i++) {
    const dia = somarDias(L.dia, i);
    if (!e.dias.includes(diaDaSemana(dia))) continue;
    if (i === 0 && L.minutos >= ini) continue;
    return montarTurno(e, dia);
  }
  return null;
}

/** Posição da fila na vez, contada da âncora. Vale para qualquer data. */
export function indiceRotacao(e: Escala, dia: string): number {
  const n = e.pessoas.length;
  if (n <= 1) return 0;
  const dias = Math.floor((Date.parse(`${dia}T00:00:00Z`) - Date.parse(`${e.ancora}T00:00:00Z`)) / 86_400_000);
  const bloco = Math.floor(dias / Math.max(1, e.rotacao_dias));
  return ((bloco % n) + n) % n;
}

export interface CoberturaTurno { plantonistas: Pessoa[]; substituicoes: Substituicao[] }

/**
 * Quem cobre este turno. Exceção vale mais que escala: com substituto, passa a
 * vez; sem substituto, a rotação anda para o próximo da fila.
 */
export function plantonistasDoTurno(e: Escala, dia: string, quando = new Date()): CoberturaTurno {
  const vigentes = excecoesVigentes(quando);
  const ausencia = (id: number) => vigentes.find((x) => x.pessoa_id === id && AUSENTES.includes(x.tipo));
  const substituicoes: Substituicao[] = [];
  const saida: Pessoa[] = [];

  const resolver = (id: number): Pessoa | null => {
    const p = pessoaPorId(id);
    if (!p) return null;
    const falta = ausencia(p.id);
    if (!falta) {
      if (p.ativo) return p;
      substituicoes.push({ de: p, para: null, tipo: 'ausencia', motivo: 'cadastro desativado no painel' });
      return null;
    }
    const troca = falta.substituto_id ? pessoaPorId(falta.substituto_id) : null;
    if (troca && troca.ativo && !ausencia(troca.id)) {
      substituicoes.push({ de: p, para: troca, tipo: falta.tipo, motivo: falta.motivo });
      return troca;
    }
    substituicoes.push({ de: p, para: null, tipo: falta.tipo, motivo: falta.motivo });
    return null;
  };

  if (e.tipo === 'fixa') {
    for (const id of e.pessoas) {
      const p = resolver(id);
      if (p && !saida.some((x) => x.id === p.id)) saida.push(p);
    }
    return { plantonistas: saida, substituicoes };
  }

  // Rotativa: a vez é de um; se essa pessoa não cobre, anda na fila.
  const n = e.pessoas.length;
  const inicio = indiceRotacao(e, dia);
  for (let i = 0; i < n; i++) {
    const p = resolver(e.pessoas[(inicio + i) % n]);
    if (p) { saida.push(p); break; }
  }
  return { plantonistas: saida, substituicoes };
}

/** Plantão extraordinário vigente para a equipe. */
function extrasDaEquipe(equipeId: string, quando: Date): Pessoa[] {
  return excecoesVigentes(quando)
    .filter((x) => x.tipo === 'extra' && (x.equipe_id === equipeId || x.equipe_id === null))
    .map((x) => pessoaPorId(x.pessoa_id))
    .filter((p): p is Pessoa => !!p && p.ativo);
}

export function plantaoDaEquipe(equipeId: string, quando = new Date()): PlantaoEquipe | null {
  const equipe = equipePorId(equipeId);
  if (!equipe) return null;
  const escalas = listarEscalas(equipeId).filter((e) => e.ativo);
  const turnos: Array<{ turno: Turno; plantonistas: Pessoa[] }> = [];
  const plantonistas: Pessoa[] = [];
  const substituicoes: Substituicao[] = [];

  for (const e of escalas) {
    const t = turnoAtivo(e, quando);
    if (!t) continue;
    const r = plantonistasDoTurno(e, t.dia, quando);
    turnos.push({ turno: t, plantonistas: r.plantonistas });
    substituicoes.push(...r.substituicoes);
    for (const p of r.plantonistas) if (!plantonistas.some((x) => x.id === p.id)) plantonistas.push(p);
  }

  const extras = extrasDaEquipe(equipeId, quando);
  for (const p of extras) if (!plantonistas.some((x) => x.id === p.id)) plantonistas.push(p);

  // Próximo turno: o que começar primeiro entre as escalas da equipe.
  let proximo: { turno: Turno; plantonistas: Pessoa[] } | null = null;
  for (const e of escalas) {
    const t = proximoTurno(e, quando);
    if (!t) continue;
    if (!proximo || t.inicio < proximo.turno.inicio) {
      proximo = { turno: t, plantonistas: plantonistasDoTurno(e, t.dia, quando).plantonistas };
    }
  }

  const motivo = plantonistas.length ? null
    : !escalas.length ? 'a equipe não tem escala cadastrada'
      : !turnos.length ? 'nenhum turno desta equipe está acontecendo agora'
        : 'todos os escalados estão ausentes e ninguém foi posto no lugar';

  return {
    equipe, turnos, plantonistas, substituicoes, extras, proximo,
    vazio: plantonistas.length === 0, motivo_vazio: motivo,
  };
}

export function plantaoAgora(quando = new Date()): PlantaoEquipe[] {
  return equipes()
    .filter((e) => e.ativo)
    .map((e) => plantaoDaEquipe(e.id, quando))
    .filter((p): p is PlantaoEquipe => !!p);
}

/**
 * Cadeia de fallback, degrau a degrau. Degrau vazio continua na lista: saber
 * que não há supervisor cadastrado é a informação que interessa.
 */
export function cadeia(equipeId: string, quando = new Date()): Degrau[] {
  const p = plantaoDaEquipe(equipeId, quando);
  if (!p) return [];
  const degraus: Degrau[] = [
    { nivel: 'plantonista', rotulo: ROTULO_NIVEL.plantonista, pessoas: p.plantonistas },
    { nivel: 'substituto', rotulo: ROTULO_NIVEL.substituto, pessoas: p.equipe.substituto ? [p.equipe.substituto] : [] },
    { nivel: 'supervisor', rotulo: ROTULO_NIVEL.supervisor, pessoas: p.equipe.supervisor ? [p.equipe.supervisor] : [] },
  ];
  for (const id of p.equipe.escalonamento) {
    const outra = plantaoDaEquipe(id, quando);
    if (!outra) continue;
    const pessoasN2 = outra.plantonistas.length ? outra.plantonistas
      : [outra.equipe.substituto, outra.equipe.supervisor].filter((x): x is Pessoa => !!x);
    degraus.push({
      nivel: 'segundo_nivel', rotulo: `${ROTULO_NIVEL.segundo_nivel}: ${outra.equipe.nome}`,
      pessoas: pessoasN2, equipe: outra.equipe.id,
    });
  }
  const gerencia = obter<string[]>('plantao.gerencia')
    .map((x) => pessoaPorId(Number(x)))
    .filter((x): x is Pessoa => !!x && x.ativo);
  degraus.push({ nivel: 'gerencia', rotulo: ROTULO_NIVEL.gerencia, pessoas: gerencia });
  return degraus;
}

/** Primeiro degrau com gente. É por onde o escalonamento começa. */
export function primeiroDegrauComGente(equipeId: string, quando = new Date()): Degrau | null {
  return cadeia(equipeId, quando).find((d) => d.pessoas.length > 0) ?? null;
}

// ─── Roteamento por equipe ───────────────────────────────────────────────────

/**
 * Equipes que atendem este tipo de alerta. Equipe sem tipo marcado atende
 * tudo; com região marcada, só o que casa com a região. Mais específica antes.
 */
export function equipesParaAlerta(
  f: { tipo: TipoAlerta; severidade: Severidade; regiao?: string | null },
): EquipePlantao[] {
  const nivel = SEVERIDADES.indexOf(f.severidade);
  const regiao = (f.regiao ?? '').trim().toLowerCase();
  return equipes()
    .filter((e) => e.ativo)
    .filter((e) => !e.tipos || e.tipos.includes(f.tipo))
    .filter((e) => nivel >= SEVERIDADES.indexOf(e.severidade_minima))
    .filter((e) => {
      if (!e.regiao) return true;
      if (!regiao) return false;
      const alvo = e.regiao.toLowerCase();
      return regiao.includes(alvo) || alvo.includes(regiao);
    })
    .sort((a, b) => Number(!!b.regiao) - Number(!!a.regiao) || Number(!!b.tipos) - Number(!!a.tipos));
}

/**
 * Equipe de plantão para um alerta, já com quem está na vez. Devolve a
 * primeira equipe com gente; se nenhuma tiver, devolve a primeira candidata,
 * para o painel mostrar a lacuna em vez de esconder.
 */
export function plantaoParaAlerta(
  f: { tipo: TipoAlerta; severidade: Severidade; regiao?: string | null },
  quando = new Date(),
): PlantaoEquipe | null {
  if (!obter<boolean>('plantao.ativo')) return null;
  let primeira: PlantaoEquipe | null = null;
  for (const e of equipesParaAlerta(f)) {
    const p = plantaoDaEquipe(e.id, quando);
    if (!p) continue;
    if (!primeira) primeira = p;
    if (!p.vazio) return p;
  }
  return primeira;
}

/**
 * Linha de plantão para colar na mensagem do alerta. Equipe descoberta vira
 * aviso, não silêncio: alerta que chega sem dono precisa dizer isso.
 */
export function avisoDePlantao(equipeId: string | null, quando = new Date()): string | null {
  if (!equipeId || !obter<boolean>('plantao.ativo')) return null;
  const p = plantaoDaEquipe(equipeId, quando);
  if (!p) return null;
  if (p.plantonistas.length) {
    return `Plantão ${p.equipe.nome}: ${p.plantonistas.map((x) => x.nome).join(', ')}`;
  }
  const apoio = p.equipe.substituto ?? p.equipe.supervisor;
  return `Plantão ${p.equipe.nome}: ninguém na vez (${p.motivo_vazio})` +
    (apoio ? ` · acione ${apoio.nome}` : '');
}

/** "Noturno · 22:00–06:00 (seg, ter, qua)" — como o turno aparece no painel. */
export function rotuloEscala(e: Escala): string {
  const dias = e.dias.map((d) => DIAS_SEMANA[d].slice(0, 3)).join(', ');
  return `${e.nome} · ${e.hora_inicio}–${e.hora_fim} (${dias})`;
}
