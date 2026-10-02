// Quem recebe cada alerta no WhatsApp, além do grupo.
//
// Cada pessoa escolhe no painel os TIPOS que quer (rede, CTOs, tráfego,
// atendimento, URA, resumo, sistema) e a gravidade mínima. Chamada da URA e
// resumo diário são acontecimentos, não problemas: a gravidade mínima não vale
// para eles — quem marcou o tipo recebe. Aviso de "resolvido" herda a
// gravidade do alerta que resolveu, para ninguém receber o fim de um problema
// cujo começo não recebeu.

import { db } from './store/db';
import type { Alerta, Severidade } from './alertas';

export const TIPOS_ALERTA = {
  rede: 'Incidentes da rede (Zabbix)',
  ctos: 'Sinal das CTOs',
  trafego: 'Tráfego e suspeita de ataque (NetFlow)',
  atendimento: 'Atendimento parado (WhatsApp)',
  ura: 'Chamadas da URA',
  bots: 'Sistemas internos (bots)',
  resumo: 'Resumo e prioridades (onde mandar equipe)',
  sistema: 'Avisos do sistema',
} as const;

export type TipoAlerta = keyof typeof TIPOS_ALERTA;
export const SEVERIDADES: Severidade[] = ['info', 'aviso', 'critico'];
const SEM_GRAVIDADE: TipoAlerta[] = ['ura', 'resumo'];

export interface Destino {
  id: number;
  nome: string;
  numero: string;
  tipos: TipoAlerta[];
  severidade_minima: Severidade;
  ativo: boolean;
  criado_em: string;
}

interface Linha extends Omit<Destino, 'tipos' | 'ativo'> { tipos: string; ativo: number }

export function tipoDoAlerta(a: Pick<Alerta, 'origem' | 'chave'>): TipoAlerta {
  switch (a.origem) {
    case 'zabbix': return 'rede';
    case 'ctos': return 'ctos';
    case 'netflow': return 'trafego';
    case 'sla': return 'atendimento';
    case 'ura': return 'ura';
    case 'bot': return 'bots';
    // Prioridade vai para quem recebe o resumo: é a mesma gestão.
    default: return a.chave.startsWith('resumo:') || a.chave.startsWith('prioridade:') ? 'resumo' : 'sistema';
  }
}

function paraDestino(l: Linha): Destino {
  let tipos: TipoAlerta[] = [];
  try { tipos = JSON.parse(l.tipos); } catch { tipos = []; }
  return { ...l, tipos, ativo: l.ativo === 1 };
}

export function listarDestinos(): Destino[] {
  return (db().prepare(`SELECT * FROM alerta_destino ORDER BY nome`).all() as Linha[]).map(paraDestino);
}

export function destinoPorId(id: number): Destino | null {
  const l = db().prepare(`SELECT * FROM alerta_destino WHERE id = ?`).get(id) as Linha | undefined;
  return l ? paraDestino(l) : null;
}

/** Gravidade que decide o envio: a do próprio alerta, ou a do original quando é um "resolvido". */
function gravidadeEfetiva(a: Pick<Alerta, 'severidade' | 'chave'>): Severidade {
  if (!a.chave.endsWith(':resolvido')) return a.severidade;
  const original = db().prepare(`SELECT severidade FROM alerta WHERE chave = ?`)
    .get(a.chave.slice(0, -':resolvido'.length)) as { severidade: Severidade } | undefined;
  return original?.severidade ?? a.severidade;
}

/** Destinos ativos que querem este alerta. */
export function destinosDoAlerta(a: Pick<Alerta, 'origem' | 'chave' | 'severidade'>): Destino[] {
  const tipo = tipoDoAlerta(a);
  const nivel = SEVERIDADES.indexOf(gravidadeEfetiva(a));
  return listarDestinos().filter((d) =>
    d.ativo &&
    d.tipos.includes(tipo) &&
    (SEM_GRAVIDADE.includes(tipo) || nivel >= SEVERIDADES.indexOf(d.severidade_minima)));
}

/**
 * Estados de entrega. "Enviado" não é "entregue", "entregue" não é "visto" e
 * nada disso é "alguém assumiu": cada um tem hora própria, e a diferença entre
 * eles é o que explica por que o problema ficou parado.
 */
export const ESTADOS_ENVIO = ['enviado', 'entregue', 'visualizado', 'reconhecido', 'falhou'] as const;
export type EstadoEnvio = (typeof ESTADOS_ENVIO)[number];

export const ROTULO_ENVIO: Record<EstadoEnvio, string> = {
  enviado: 'Enviado', entregue: 'Entregue', visualizado: 'Visualizado',
  reconhecido: 'Reconhecido', falhou: 'Falhou',
};

export interface Envio {
  id: number;
  alerta_id: string;
  destino: string;
  estado: EstadoEnvio;
  motivo: string | null;
  mensagem_id: string | null;
  enviado_em: string | null;
  entregue_em: string | null;
  visto_em: string | null;
  reconhecido_em: string | null;
  erro: string | null;
  at: string;
}

export function registrarEnvio(
  alertaId: string, destino: string, ok: boolean, erro: string | null,
  extra: { mensagemId?: string | null; motivo?: string | null } = {},
): number {
  const agora = new Date().toISOString();
  const r = db().prepare(
    `INSERT INTO alerta_envio (alerta_id, destino, enviado_em, erro, at, estado, mensagem_id, motivo)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(alertaId, destino, ok ? agora : null, ok ? null : erro, agora,
    ok ? 'enviado' : 'falhou', extra.mensagemId ?? null, extra.motivo ?? null);
  return Number(r.lastInsertRowid);
}

/** Recibo do WhatsApp: entregue no aparelho, ou aberto pela pessoa. */
export function marcarRecibo(mensagemId: string, estado: 'entregue' | 'visualizado'): boolean {
  const agora = new Date().toISOString();
  const coluna = estado === 'entregue' ? 'entregue_em' : 'visto_em';
  // Nunca rebaixa: quem já viu não volta a "entregue", e reconhecido é o fim.
  const ordem = ESTADOS_ENVIO.indexOf(estado);
  const abaixo = ESTADOS_ENVIO.filter((e) => ESTADOS_ENVIO.indexOf(e) < ordem);
  const r = db().prepare(
    `UPDATE alerta_envio SET ${coluna} = COALESCE(${coluna}, ?), estado = ?
      WHERE mensagem_id = ? AND estado IN (${abaixo.map(() => '?').join(',')})`,
  ).run(agora, estado, mensagemId, ...abaixo);
  if (r.changes) return true;
  // Chegou fora de ordem (visualizado antes do entregue): só carimba a hora.
  return db().prepare(`UPDATE alerta_envio SET ${coluna} = COALESCE(${coluna}, ?) WHERE mensagem_id = ?`)
    .run(agora, mensagemId).changes > 0;
}

/** Alguém assumiu: fecha o ciclo de todos os envios daquele alerta. */
export function marcarReconhecido(alertaId: string): number {
  return db().prepare(
    `UPDATE alerta_envio SET estado = 'reconhecido', reconhecido_em = COALESCE(reconhecido_em, ?)
      WHERE alerta_id = ? AND estado <> 'falhou'`,
  ).run(new Date().toISOString(), alertaId).changes;
}

export function enviosDoAlerta(alertaId: string): Envio[] {
  return db().prepare(`SELECT * FROM alerta_envio WHERE alerta_id = ? ORDER BY id`).all(alertaId) as Envio[];
}

export function validarTipos(v: unknown): TipoAlerta[] {
  if (!Array.isArray(v) || !v.length) throw new Error('escolha pelo menos um tipo de alerta');
  const invalidos = v.filter((x) => !(String(x) in TIPOS_ALERTA));
  if (invalidos.length) throw new Error(`tipo de alerta inválido: ${invalidos.join(', ')}`);
  return [...new Set(v.map(String))] as TipoAlerta[];
}

export function validarSeveridade(v: unknown): Severidade {
  const s = String(v ?? 'aviso');
  if (!SEVERIDADES.includes(s as Severidade)) throw new Error(`gravidade inválida: ${s}`);
  return s as Severidade;
}
