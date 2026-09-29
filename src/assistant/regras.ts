// Motor de regras e freio de enxurrada.
//
// Duas coisas que só aparecem depois que o sistema está em produção:
//   1. a operação quer exceções ("porta do cliente X às 2h não me acorda"),
//      e essas exceções não podem virar deploy;
//   2. um evento único vira cem mensagens, e a equipe silencia o grupo.
//
// Aqui moram as duas. A regra é "quando isto, e aquilo, então", guardada em
// banco e editável no painel. O freio tem três formas, e elas resolvem coisas
// diferentes:
//   DEBOUNCE   — espera antes de avisar. Mata o que se resolve sozinho.
//   COOLDOWN   — depois de avisar, silencia o MESMO problema por um tempo.
//   THROTTLING — teto de mensagens por hora, para o dia ruim não virar spam.
//
// Nada disso apaga o alerta: ele continua no painel, com o motivo de não ter
// saído. O que se perde é a mensagem, nunca o registro.

import { randomUUID } from 'crypto';
import { db, registrarAuditoria } from './store/db';
import { config } from '../config';
import { obter } from './config-dinamica';
import { logger } from '../logger';
import type { Alerta, Severidade } from './alertas';
import { TIPOS_ALERTA, TipoAlerta, tipoDoAlerta } from './destinos-alerta';
import { EfeitoManutencao, Manutencao, janelaDoAlerta } from './manutencao';

export const CAMPOS = ['origem', 'tipo', 'severidade', 'titulo', 'equipamento', 'pon', 'regiao', 'clientes', 'hora'] as const;
export type Campo = (typeof CAMPOS)[number];

export const ROTULO_CAMPO: Record<Campo, string> = {
  origem: 'Origem (zabbix, ctos…)', tipo: 'Tipo de alerta', severidade: 'Gravidade',
  titulo: 'Texto do título', equipamento: 'Equipamento', pon: 'PON', regiao: 'Região',
  clientes: 'Clientes afetados', hora: 'Hora do dia (HH:MM)',
};

export const OPERADORES = ['igual', 'diferente', 'contem', 'nao_contem', 'maior', 'menor', 'entre'] as const;
export type Operador = (typeof OPERADORES)[number];

export const ROTULO_OPERADOR: Record<Operador, string> = {
  igual: 'é igual a', diferente: 'é diferente de', contem: 'contém', nao_contem: 'não contém',
  maior: 'é maior que', menor: 'é menor que', entre: 'está entre (valor e valor2)',
};

export const ACOES = ['suprimir', 'so_painel', 'mudar_severidade', 'sempre_avisar'] as const;
export type Acao = (typeof ACOES)[number];

export const ROTULO_ACAO: Record<Acao, string> = {
  suprimir: 'Não registrar nem avisar',
  so_painel: 'Registrar no painel, sem avisar',
  mudar_severidade: 'Mudar a gravidade',
  sempre_avisar: 'Avisar sempre (ignora silêncio, cooldown e teto)',
};

export interface Condicao {
  campo: Campo;
  operador: Operador;
  valor: string;
  valor2?: string;
}

export interface Regra {
  id: string;
  nome: string;
  ordem: number;
  ativo: boolean;
  condicoes: Condicao[];
  acao: Acao;
  /** Para mudar_severidade. */
  severidade: Severidade | null;
  /** "Por tempo": só vale se o mesmo problema repetiu N vezes na janela. */
  repeticoes: number;
  janela_min: number;
  criado_em: string;
  /** Quantas vezes a regra já decidiu algo. Regra que nunca bate é regra morta. */
  acionada: number;
  ultima_em: string | null;
}

interface LinhaRegra extends Omit<Regra, 'condicoes' | 'ativo'> { condicoes: string; ativo: number }

function paraRegra(l: LinhaRegra): Regra {
  let condicoes: Condicao[] = [];
  try { condicoes = JSON.parse(l.condicoes); } catch { condicoes = []; }
  return { ...l, condicoes, ativo: l.ativo === 1 };
}

export function listarRegras(): Regra[] {
  return (db().prepare(`SELECT * FROM regra_alerta ORDER BY ordem, criado_em`).all() as LinhaRegra[]).map(paraRegra);
}

export function regraPorId(id: string): Regra | null {
  const l = db().prepare(`SELECT * FROM regra_alerta WHERE id = ?`).get(id) as LinhaRegra | undefined;
  return l ? paraRegra(l) : null;
}

const SEVERIDADES: Severidade[] = ['info', 'aviso', 'critico'];

function validarCondicoes(v: unknown): Condicao[] {
  const arr = Array.isArray(v) ? v : [];
  if (!arr.length) throw new Error('a regra precisa de pelo menos uma condição');
  return arr.map((x) => {
    const c = x as Partial<Condicao>;
    if (!CAMPOS.includes(c.campo as Campo)) throw new Error(`campo inválido: ${c.campo}`);
    if (!OPERADORES.includes(c.operador as Operador)) throw new Error(`comparação inválida: ${c.operador}`);
    const valor = String(c.valor ?? '').trim();
    if (!valor) throw new Error(`diga com o que comparar em "${ROTULO_CAMPO[c.campo as Campo]}"`);
    if (c.operador === 'entre' && !String(c.valor2 ?? '').trim()) throw new Error('"está entre" precisa de dois valores');
    return { campo: c.campo as Campo, operador: c.operador as Operador, valor, valor2: c.valor2 ? String(c.valor2) : undefined };
  });
}

export function criarRegra(d: Record<string, unknown>, autor: string): Regra {
  const nome = String(d.nome ?? '').trim();
  if (!nome) throw new Error('dê um nome à regra');
  const acao = String(d.acao ?? '') as Acao;
  if (!ACOES.includes(acao)) throw new Error(`ação inválida; use ${ACOES.join(', ')}`);
  const severidade = d.severidade ? String(d.severidade) as Severidade : null;
  if (acao === 'mudar_severidade' && (!severidade || !SEVERIDADES.includes(severidade))) {
    throw new Error('escolha a gravidade nova (info, aviso ou critico)');
  }
  const repeticoes = Number(d.repeticoes ?? 0);
  const janela = Number(d.janela_min ?? 0);
  if (repeticoes && (!Number.isInteger(repeticoes) || repeticoes < 2)) throw new Error('repetições: use 2 ou mais, ou deixe vazio');
  if (repeticoes && (!Number.isInteger(janela) || janela < 1)) throw new Error('com repetições, diga em quantos minutos');

  const r: Regra = {
    id: randomUUID(), nome, ordem: Number(d.ordem ?? 100), ativo: d.ativo !== false,
    condicoes: validarCondicoes(d.condicoes), acao, severidade,
    repeticoes: repeticoes || 0, janela_min: janela || 0,
    criado_em: new Date().toISOString(), acionada: 0, ultima_em: null,
  };
  db().prepare(
    `INSERT INTO regra_alerta (id, nome, ordem, ativo, condicoes, acao, severidade, repeticoes,
       janela_min, criado_em, acionada, ultima_em)
     VALUES (?,?,?,?,?,?,?,?,?,?,0,NULL)`,
  ).run(r.id, r.nome, r.ordem, r.ativo ? 1 : 0, JSON.stringify(r.condicoes), r.acao, r.severidade,
    r.repeticoes, r.janela_min, r.criado_em);
  registrarAuditoria(autor, 'regra.criar', r.nome, undefined, r);
  return r;
}

export function atualizarRegra(id: string, d: Record<string, unknown>, autor: string): Regra {
  const antes = regraPorId(id);
  if (!antes) throw new Error('regra não encontrada');
  const acao = d.acao !== undefined ? String(d.acao) as Acao : antes.acao;
  if (!ACOES.includes(acao)) throw new Error(`ação inválida; use ${ACOES.join(', ')}`);
  const severidade = d.severidade !== undefined
    ? (d.severidade ? String(d.severidade) as Severidade : null) : antes.severidade;
  if (acao === 'mudar_severidade' && (!severidade || !SEVERIDADES.includes(severidade))) {
    throw new Error('escolha a gravidade nova (info, aviso ou critico)');
  }
  const r = {
    nome: d.nome !== undefined && String(d.nome).trim() ? String(d.nome).trim() : antes.nome,
    ordem: d.ordem !== undefined ? Number(d.ordem) : antes.ordem,
    ativo: d.ativo !== undefined ? d.ativo !== false : antes.ativo,
    condicoes: d.condicoes !== undefined ? validarCondicoes(d.condicoes) : antes.condicoes,
    acao, severidade,
    repeticoes: d.repeticoes !== undefined ? Number(d.repeticoes) || 0 : antes.repeticoes,
    janela_min: d.janela_min !== undefined ? Number(d.janela_min) || 0 : antes.janela_min,
  };
  db().prepare(
    `UPDATE regra_alerta SET nome = ?, ordem = ?, ativo = ?, condicoes = ?, acao = ?, severidade = ?,
       repeticoes = ?, janela_min = ? WHERE id = ?`,
  ).run(r.nome, r.ordem, r.ativo ? 1 : 0, JSON.stringify(r.condicoes), r.acao, r.severidade,
    r.repeticoes, r.janela_min, id);
  const depois = regraPorId(id)!;
  registrarAuditoria(autor, 'regra.editar', depois.nome, antes, depois);
  return depois;
}

export function removerRegra(id: string, autor: string): void {
  const antes = regraPorId(id);
  if (!antes) throw new Error('regra não encontrada');
  db().prepare(`DELETE FROM regra_alerta WHERE id = ?`).run(id);
  registrarAuditoria(autor, 'regra.remover', antes.nome, antes, undefined);
}

// ─── Avaliação ───────────────────────────────────────────────────────────────

type Fato = Pick<Alerta, 'origem' | 'chave' | 'severidade' | 'titulo' | 'dados'>;

function valorDoCampo(campo: Campo, a: Fato, quando: Date): string | number | null {
  const d = (a.dados ?? {}) as Record<string, unknown>;
  switch (campo) {
    case 'origem': return a.origem;
    case 'tipo': return tipoDoAlerta(a);
    case 'severidade': return a.severidade;
    case 'titulo': return a.titulo;
    case 'equipamento': return (d.host ?? d.equipamento ?? null) as string | null;
    case 'pon': return (d.pon ?? null) as string | null;
    case 'regiao': return (d.regiao ?? d.cidade ?? d.bairro ?? d.pop ?? null) as string | null;
    case 'clientes': {
      const c = d.clientes_afetados ?? d.clientes ?? (d.impacto as Record<string, unknown> | undefined)?.clientes;
      return typeof c === 'number' ? c : null;
    }
    case 'hora':
      // Hora local da operação: regra de madrugada é escrita em hora daqui.
      return quando.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: config.tz });
    default: return null;
  }
}

function comparar(c: Condicao, valor: string | number | null): boolean {
  if (valor === null || valor === undefined) return false;
  const texto = String(valor).toLowerCase();
  const alvo = c.valor.toLowerCase();
  const num = Number(valor);
  switch (c.operador) {
    case 'igual': return texto === alvo || (Number.isFinite(num) && num === Number(c.valor));
    case 'diferente': return !(texto === alvo || (Number.isFinite(num) && num === Number(c.valor)));
    case 'contem': return texto.includes(alvo);
    case 'nao_contem': return !texto.includes(alvo);
    case 'maior': return Number.isFinite(num) ? num > Number(c.valor) : texto > alvo;
    case 'menor': return Number.isFinite(num) ? num < Number(c.valor) : texto < alvo;
    case 'entre': {
      const a2 = c.valor;
      const b2 = c.valor2 ?? c.valor;
      if (Number.isFinite(num) && Number.isFinite(Number(a2))) return num >= Number(a2) && num <= Number(b2);
      // Texto: serve para hora, inclusive janela que vira a meia-noite.
      return a2 <= b2 ? (texto >= a2.toLowerCase() && texto <= b2.toLowerCase())
        : (texto >= a2.toLowerCase() || texto <= b2.toLowerCase());
    }
    default: return false;
  }
}

/** Quantas vezes este mesmo problema apareceu na janela. É o "por tempo". */
export function repeticoesRecentes(a: Fato, minutos: number): number {
  const desde = new Date(Date.now() - minutos * 60_000).toISOString();
  const raiz = a.chave.split(':').slice(0, 2).join(':');
  return (db().prepare(
    `SELECT COUNT(*) n FROM alerta WHERE criado_em >= ? AND (chave = ? OR chave LIKE ?)`,
  ).get(desde, a.chave, `${raiz}%`) as { n: number }).n;
}

export function regraCasa(r: Regra, a: Fato, quando = new Date()): boolean {
  if (!r.ativo) return false;
  if (!r.condicoes.every((c) => comparar(c, valorDoCampo(c.campo, a, quando)))) return false;
  if (r.repeticoes && repeticoesRecentes(a, r.janela_min) < r.repeticoes) return false;
  return true;
}

export interface Decisao {
  /** Registrar o alerta no banco. Falso só na supressão total. */
  registrar: boolean;
  /** Mandar mensagem. */
  avisar: boolean;
  severidade: Severidade;
  /** Ignora silêncio, cooldown e teto. */
  prioritario: boolean;
  /** Segurar o aviso até este horário (debounce). */
  esperar_ate: string | null;
  motivo: string | null;
  regra: string | null;
  manutencao: Manutencao | null;
}

const EFEITO_MOTIVO: Record<EfeitoManutencao, string> = {
  nao_notificar: 'janela de manutenção (registrado sem avisar)',
  rebaixar: 'janela de manutenção (rebaixado para informativo)',
  suprimir: 'janela de manutenção (suprimido)',
  manter: 'janela de manutenção (avisado assim mesmo)',
};

/** Quantos avisos saíram na última hora. Base do teto. */
export function enviadosNaUltimaHora(quando = new Date()): number {
  const desde = new Date(quando.getTime() - 3_600_000).toISOString();
  return (db().prepare(`SELECT COUNT(*) n FROM alerta WHERE enviado_em >= ?`).get(desde) as { n: number }).n;
}

/** Já avisamos este mesmo problema há pouco? Base do cooldown. */
export function dentroDoCooldown(a: Fato, quando = new Date()): number | null {
  const min = obter<number>('regras.cooldown_min');
  if (!min) return null;
  const raiz = a.chave.split(':').slice(0, 2).join(':');
  const ultimo = db().prepare(
    `SELECT enviado_em FROM alerta WHERE enviado_em IS NOT NULL AND (chave = ? OR chave LIKE ?)
      ORDER BY enviado_em DESC LIMIT 1`,
  ).get(a.chave, `${raiz}%`) as { enviado_em: string } | undefined;
  if (!ultimo) return null;
  const passou = (quando.getTime() - new Date(ultimo.enviado_em).getTime()) / 60_000;
  return passou < min ? Math.ceil(min - passou) : null;
}

/**
 * Decide o destino do alerta antes de ele sair. A ordem importa: manutenção
 * primeiro (é declarada por gente), depois as regras (também são), e só então
 * os freios automáticos.
 */
export function decidir(a: Fato, quando = new Date()): Decisao {
  const d: Decisao = {
    registrar: true, avisar: true, severidade: a.severidade, prioritario: false,
    esperar_ate: null, motivo: null, regra: null, manutencao: null,
  };

  const janela = janelaDoAlerta(a, quando);
  if (janela) {
    d.manutencao = janela;
    d.motivo = EFEITO_MOTIVO[janela.efeito] + (janela.motivo ? `: ${janela.motivo}` : '');
    if (janela.efeito === 'suprimir') return { ...d, registrar: false, avisar: false };
    if (janela.efeito === 'nao_notificar') return { ...d, avisar: false };
    if (janela.efeito === 'rebaixar') d.severidade = 'info';
    if (janela.efeito === 'manter') d.motivo = null;
  }

  if (obter<boolean>('regras.ativo')) {
    for (const r of listarRegras()) {
      if (!regraCasa(r, { ...a, severidade: d.severidade }, quando)) continue;
      marcarAcionada(r);
      d.regra = r.nome;
      if (r.acao === 'suprimir') return { ...d, registrar: false, avisar: false, motivo: `regra "${r.nome}": não registrar` };
      if (r.acao === 'so_painel') return { ...d, avisar: false, motivo: `regra "${r.nome}": só no painel` };
      if (r.acao === 'mudar_severidade' && r.severidade) d.severidade = r.severidade;
      if (r.acao === 'sempre_avisar') { d.prioritario = true; break; }
    }
  }

  if (d.prioritario) return d;

  // Freios automáticos. Crítico não é freado por debounce nem por teto: o
  // custo de atrasar um crítico é maior que o custo de uma mensagem a mais.
  const critico = d.severidade === 'critico';
  const cooldown = dentroDoCooldown(a, quando);
  if (cooldown && !critico) {
    return { ...d, avisar: false, motivo: `mesmo problema avisado há pouco; próximo aviso em ${cooldown} min (cooldown)` };
  }

  const teto = obter<number>('regras.teto_hora');
  if (teto && !critico && enviadosNaUltimaHora(quando) >= teto) {
    return { ...d, avisar: false, motivo: `teto de ${teto} avisos por hora atingido; o alerta está no painel` };
  }

  const debounce = obter<number>('regras.debounce_min');
  if (debounce && !critico) {
    d.esperar_ate = new Date(quando.getTime() + debounce * 60_000).toISOString();
    d.motivo = `aguardando ${debounce} min para ver se normaliza sozinho (debounce)`;
  }
  return d;
}

function marcarAcionada(r: Regra): void {
  db().prepare(`UPDATE regra_alerta SET acionada = acionada + 1, ultima_em = ? WHERE id = ?`)
    .run(new Date().toISOString(), r.id);
}

/**
 * Alertas que estavam em espera e já podem sair. Some da lista o que se
 * resolveu sozinho — que é exatamente o ponto do debounce.
 */
export function esperaVencida(quando = new Date()): Array<{ id: string; resolvido: boolean }> {
  const linhas = db().prepare(
    `SELECT id, resolvido_em FROM alerta WHERE aguardando_ate IS NOT NULL AND aguardando_ate <= ?`,
  ).all(quando.toISOString()) as Array<{ id: string; resolvido_em: string | null }>;
  return linhas.map((l) => ({ id: l.id, resolvido: !!l.resolvido_em }));
}

export function limparEspera(id: string, motivo: string | null): void {
  db().prepare(`UPDATE alerta SET aguardando_ate = NULL, envio_erro = ? WHERE id = ?`).run(motivo, id);
}

export function registrarDecisao(a: Pick<Alerta, 'id'>, d: Decisao): void {
  if (d.regra || d.manutencao) {
    logger.info('Alerta filtrado por regra ou manutenção', {
      alerta: a.id, regra: d.regra, manutencao: d.manutencao?.id ?? null, avisar: d.avisar,
    });
  }
}

/** Só para o painel: tipos disponíveis nas condições de tipo. */
export const TIPOS_PARA_REGRA: Record<TipoAlerta, string> = TIPOS_ALERTA;
