// Para quem o alerta vai, e o que fazer quando ninguém responde.
//
// Antes do B5 o alerta ia para o grupo e para quem marcou o tipo. Isso resolve
// o "todo mundo vê" e não resolve o "alguém pegou". Aqui entram duas coisas:
//
//   1. ROTEAMENTO — canal por gravidade. Informativo pode ficar só no grupo;
//      crítico vai para o grupo, para quem marcou o tipo E para quem está de
//      plantão. Crítico nunca fica sem destino: sem ninguém, cai na gerência.
//   2. ESCALONAMENTO — sem reconhecimento dentro do prazo, o incidente sobe a
//      cadeia (plantonista, substituto, supervisor, segundo nível, gerência),
//      um degrau de cada vez, com registro na linha do tempo.

import { logger } from '../logger';
import { db } from './store/db';
import { obter } from './config-dinamica';
import { Alerta, Severidade } from './alertas';
import { destinosDoAlerta, tipoDoAlerta } from './destinos-alerta';
import { Degrau, Pessoa, cadeia, plantaoDaEquipe, plantaoParaAlerta } from './plantao';
import { ABERTOS, Incidente, ROTULO_SEVERIDADE, listar as listarIncidentes, porId, registrarLinha } from './incidentes';
import { ROTULO_MARCO, registrarViolacoes, situacao } from './sla-incidente';

export interface Alvo {
  rotulo: string;
  jid: string;
  /** De onde veio: grupo da operação, cadastro por tipo, plantão ou degrau da cadeia. */
  origem: 'grupo' | 'pessoas' | 'plantao' | 'equipe' | 'escalonamento';
}

const CHAVE_CANAL: Record<Severidade, 'roteamento.canais_info' | 'roteamento.canais_aviso' | 'roteamento.canais_critico'> = {
  info: 'roteamento.canais_info', aviso: 'roteamento.canais_aviso', critico: 'roteamento.canais_critico',
};

function juntar(lista: Alvo[], novos: Alvo[]): Alvo[] {
  for (const n of novos) if (!lista.some((x) => x.jid === n.jid)) lista.push(n);
  return lista;
}

const comoAlvo = (p: Pessoa, origem: Alvo['origem']): Alvo => ({ rotulo: p.nome, jid: p.numero, origem });

/**
 * Quem recebe este alerta. A gravidade escolhe os canais; o plantão entra
 * quando o canal "plantao" está ligado para aquela gravidade.
 */
export function alvosDoAlerta(a: Pick<Alerta, 'origem' | 'chave' | 'severidade' | 'dados'>): Alvo[] {
  const grupo = obter<string>('alertas.destino_grupo');
  const canais = obter<boolean>('roteamento.ativo')
    ? obter<string[]>(CHAVE_CANAL[a.severidade])
    : ['grupo', 'pessoas'];
  const alvos: Alvo[] = [];

  if (canais.includes('grupo') && grupo) alvos.push({ rotulo: 'grupo', jid: grupo, origem: 'grupo' });

  // Plantão antes de "pessoas": quem está na vez aparece como plantonista,
  // mesmo estando também no cadastro por tipo. É a origem que importa depois.
  if (canais.includes('plantao')) {
    const d = (a.dados ?? {}) as Record<string, unknown>;
    const p = plantaoParaAlerta({
      tipo: tipoDoAlerta(a), severidade: a.severidade,
      regiao: (d.regiao ?? d.cidade ?? d.pop ?? null) as string | null,
    });
    if (p) {
      juntar(alvos, p.plantonistas.map((x) => comoAlvo(x, 'plantao')));
      if (p.equipe.grupo) juntar(alvos, [{ rotulo: `grupo ${p.equipe.nome}`, jid: p.equipe.grupo, origem: 'equipe' }]);
    }
  }
  if (canais.includes('pessoas')) {
    juntar(alvos, destinosDoAlerta(a).map((d) => ({ rotulo: d.nome, jid: d.numero, origem: 'pessoas' as const })));
  }

  // Crítico sem ninguém é o pior caso possível: cai na gerência antes de sumir.
  if (!alvos.length && a.severidade === 'critico' && obter<boolean>('roteamento.critico_nunca_sem_destino')) {
    juntar(alvos, gerencia().map((x) => comoAlvo(x, 'escalonamento')));
  }
  return alvos;
}

/** Gerência configurada no painel, já resolvida em pessoas ativas. */
export function gerencia(): Pessoa[] {
  const ids = obter<string[]>('plantao.gerencia');
  if (!ids.length) return [];
  const linhas = db().prepare(
    `SELECT id, nome, numero, ativo FROM alerta_destino WHERE id IN (${ids.map(() => '?').join(',')})`,
  ).all(...ids.map((x) => Number(x))) as Array<{ id: number; nome: string; numero: string; ativo: number }>;
  return linhas.filter((l) => l.ativo === 1)
    .map((l) => ({ id: l.id, nome: l.nome, numero: l.numero, ativo: true, grupo: l.numero.endsWith('@g.us') }));
}

// ─── Escalonamento ───────────────────────────────────────────────────────────

export interface Escalada {
  incidente: Incidente;
  degrau: Degrau;
  numeroDoDegrau: number;
  motivo: string;
  texto: string;
}

/** Cadeia do incidente. Sem equipe definida, sobra a gerência. */
export function cadeiaDoIncidente(i: Incidente, quando = new Date()): Degrau[] {
  if (i.equipe && plantaoDaEquipe(i.equipe, quando)) return cadeia(i.equipe, quando);
  return [{ nivel: 'gerencia', rotulo: 'Gerência', pessoas: gerencia() }];
}

/**
 * Decide se este incidente sobe um degrau agora. Sobe quando o prazo de
 * reconhecimento estourou e ninguém assumiu, respeitando o intervalo mínimo
 * entre degraus para não disparar tudo de uma vez.
 */
export function proximaEscalada(i: Incidente, quando = new Date()): Escalada | null {
  if (!obter<boolean>('escalonamento.ativo')) return null;
  if (!ABERTOS.includes(i.estado)) return null;
  if (i.dono) return null;   // reconhecido: o relógio do escalonamento para

  const s = situacao(i, quando);
  if (!s.ativo) return null;
  const marcoReconhecer = s.marcos.find((m) => m.marco === 'reconhecer')!;
  if (!marcoReconhecer.estourado) return null;

  const intervalo = obter<number>('escalonamento.intervalo_min') * 60_000;
  if (i.escalonado_em && quando.getTime() - new Date(i.escalonado_em).getTime() < intervalo) return null;

  const degraus = cadeiaDoIncidente(i, quando);
  const maximo = Math.min(degraus.length, obter<number>('escalonamento.max_degraus'));
  const proximo = i.degrau;   // 0 = ainda não escalou: começa no primeiro degrau
  if (proximo >= maximo) return null;

  const degrau = degraus[proximo];
  const atrasoMin = Math.round(-marcoReconhecer.restante_seg / 60);
  const texto =
    `⏫ *${i.numero} sem reconhecimento*\n` +
    `${i.titulo}\n` +
    `${ROTULO_SEVERIDADE[i.severidade]} · aberto há ${Math.round((quando.getTime() - new Date(i.aberto_em).getTime()) / 60_000)} min · ` +
    `${atrasoMin} min além do prazo de ${ROTULO_MARCO.reconhecer.toLowerCase()}\n` +
    `Acionando: ${degrau.rotulo}\n\n` +
    `_responda "assumir ${i.numero}" para assumir_`;

  return {
    incidente: i, degrau, numeroDoDegrau: proximo + 1,
    motivo: `sem reconhecimento ${atrasoMin} min além do prazo`, texto,
  };
}

/** Registra a subida de degrau. Quem envia é o chamador (alertas.ts). */
export function marcarEscalada(e: Escalada, quando = new Date()): Incidente {
  db().prepare(`UPDATE incidente SET degrau = ?, escalonado_em = ?, atualizado_em = ? WHERE id = ?`)
    .run(e.numeroDoDegrau, quando.toISOString(), quando.toISOString(), e.incidente.id);
  registrarLinha(e.incidente.id, 'escalonado',
    `Escalonado para ${e.degrau.rotulo}: ${e.motivo}` +
    (e.degrau.pessoas.length ? ` (${e.degrau.pessoas.map((p) => p.nome).join(', ')})` : ' — degrau sem ninguém cadastrado'),
    null, { degrau: e.numeroDoDegrau, nivel: e.degrau.nivel, pessoas: e.degrau.pessoas.map((p) => p.nome) });
  logger.warn('Incidente escalonado', { numero: e.incidente.numero, degrau: e.degrau.rotulo });
  return porId(e.incidente.id)!;
}

/** Incidentes abertos que precisam subir agora. */
export function paraEscalar(quando = new Date()): Escalada[] {
  const saida: Escalada[] = [];
  for (const i of listarIncidentes({ abertos: true, limite: 500 })) {
    registrarViolacoes(i, quando);
    const e = proximaEscalada(porId(i.id) ?? i, quando);
    if (e) saida.push(e);
  }
  return saida;
}
