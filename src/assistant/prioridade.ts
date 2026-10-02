// Onde mandar equipe primeiro: Bairro > Rua > Cliente, com o dinheiro em risco.
//
// A saúde da rede já diz QUAIS caixas estão mal (crítico ou em degradação:
// sinal caindo, queda, incidente aberto). Faltava o corte que a gestão usa
// para decidir a rota do dia: em que bairro, em que rua, quantas casas e
// quanto isso representa por mês.
//
// "Em risco" aqui é o mesmo que na saúde da rede: cliente ligado em caixa
// crítica ou em degradação. Caixa cheia e caixa sem leitura NÃO entram: não
// são problema de serviço do cliente.
//
// O valor é a mensalidade do plano de cada contrato não cancelado, com o preço
// que o próprio SGP informa para o plano. Não é prejuízo certo: é o que a casa
// deixa de receber se esses clientes forem embora. Plano sem preço conhecido
// não vira zero nem média: é contado à parte.

import { db } from './store/db';
import { sgp } from '../integrations/sgp';
import { classificarRede, ROTULO_NIVEL, Nivel, SaudeCto } from './saude-rede';
import { resolverBairro } from './geografia';
import { logger } from '../logger';

export interface ClienteEmRisco {
  nome: string;
  contrato: number;
  rua: string;
  numero: string | null;
  plano: string | null;
  valor: number | null;
  caixa: string;
}

export interface RuaEmRisco {
  rua: string;
  clientes: number;
  valor_mensal: number;
  sem_valor: number;
  caixas: string[];
  lista: ClienteEmRisco[];
}

export interface BairroEmRisco {
  prioridade: number;
  bairro: string;
  nivel: Nivel;
  rotulo: string;
  caixas: number;
  clientes: number;
  valor_mensal: number;
  sem_valor: number;
  motivo: string;
  ruas: RuaEmRisco[];
}

/** Linha do cadastro de um cliente ligado numa caixa. */
export interface LinhaCliente {
  nome: string;
  contrato: number;
  logradouro: string | null;
  numero: string | null;
  bairro: string | null;
  plano_id: number | null;
  plano_desc: string | null;
}

const PESO: Partial<Record<Nivel, number>> = { critico: 3, degradacao: 2 };
const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/** "R$ 79,90", "79.90", "79,9" → 79.9. null quando não dá para ler. */
export function parsePreco(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? v : null;
  let s = String(v ?? '').replace(/[^\d.,]/g, '');
  if (!s) return null;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

/** R$ 1.198,80 */
export function reais(n: number): string {
  return `R$ ${n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

let cachePrecos: { em: number; mapa: Map<number, number> } | null = null;

/** Preço de cada plano, pelo SGP. Cache de 6 horas: preço de plano muda pouco. */
export async function precosDosPlanos(): Promise<{ mapa: Map<number, number>; erro: string | null }> {
  if (cachePrecos && Date.now() - cachePrecos.em < 6 * 3600_000) return { mapa: cachePrecos.mapa, erro: null };
  try {
    const planos = await sgp.planos();
    const mapa = new Map<number, number>();
    for (const p of planos) {
      const preco = parsePreco(p.preco);
      if (preco !== null) mapa.set(Number(p.id), preco);
    }
    cachePrecos = { em: Date.now(), mapa };
    return { mapa, erro: null };
  } catch (err) {
    logger.warn('Prioridade: preços dos planos indisponíveis', { err: (err as Error).message });
    return { mapa: cachePrecos?.mapa ?? new Map(), erro: 'o SGP não informou o preço dos planos agora' };
  }
}

/** Clientes com contrato não cancelado ligados numa caixa, pelo cadastro. */
export function clientesDaCaixa(c: { cto_id: number; nome: string }): LinhaCliente[] {
  const linhas = db().prepare(
    `SELECT c.nome, ct.contrato_id contrato, c.logradouro, c.numero, c.bairro, s.plano_id, s.plano_desc
       FROM sgp_servico s
       JOIN sgp_contrato ct ON ct.contrato_id = s.contrato_id
       JOIN sgp_cliente  c  ON c.cliente_id  = ct.cliente_id
      WHERE (s.cto_id = ? OR UPPER(TRIM(s.cto_nome)) = UPPER(TRIM(?)))
        AND (ct.status IS NULL OR ct.status NOT LIKE 'Cancel%')`,
  ).all(c.cto_id, c.nome) as LinhaCliente[];
  const vistos = new Set<number>();
  return linhas.filter((l) => !vistos.has(l.contrato) && vistos.add(l.contrato));
}

/**
 * Monta a lista de prioridade. Função pura: recebe as caixas em risco, como
 * achar os clientes de cada uma e os preços, e devolve os bairros na ordem em
 * que a equipe deve ir — pior nível primeiro; no empate, mais dinheiro e mais
 * clientes em risco.
 */
export function montarPrioridades(
  caixas: SaudeCto[],
  clientesDe: (c: SaudeCto) => LinhaCliente[],
  precos: Map<number, number>,
): BairroEmRisco[] {
  type Acc = {
    nomes: Map<string, number>;
    nivel: Nivel;
    caixas: Set<string>;
    motivos: Map<string, number>;
    ruas: Map<string, { nomes: Map<string, number>; caixas: Set<string>; lista: ClienteEmRisco[] }>;
  };
  const porBairro = new Map<string, Acc>();
  const contar = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
  const maisComum = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1])[0][0];

  for (const cx of caixas) {
    if (!PESO[cx.nivel]) continue;
    for (const l of clientesDe(cx)) {
      const bairro = l.bairro?.trim() || '(bairro não informado)';
      const kb = norm(bairro) || 'SEMBAIRRO';
      const acc = porBairro.get(kb) ?? { nomes: new Map(), nivel: cx.nivel, caixas: new Set(), motivos: new Map(), ruas: new Map() };
      contar(acc.nomes, bairro);
      if ((PESO[cx.nivel] ?? 0) > (PESO[acc.nivel] ?? 0)) acc.nivel = cx.nivel;
      acc.caixas.add(cx.nome);
      if (cx.motivos[0]) contar(acc.motivos, cx.motivos[0]);

      const rua = l.logradouro?.trim() || '(rua não informada)';
      const kr = norm(rua) || 'SEMRUA';
      const r = acc.ruas.get(kr) ?? { nomes: new Map(), caixas: new Set(), lista: [] };
      contar(r.nomes, rua);
      r.caixas.add(cx.nome);
      r.lista.push({
        nome: l.nome, contrato: l.contrato, rua, numero: l.numero?.trim() || null,
        plano: l.plano_desc, valor: l.plano_id !== null ? precos.get(Number(l.plano_id)) ?? null : null, caixa: cx.nome,
      });
      acc.ruas.set(kr, r);
      porBairro.set(kb, acc);
    }
  }

  const soma = (xs: ClienteEmRisco[]) => Math.round(xs.reduce((a, c) => a + (c.valor ?? 0), 0) * 100) / 100;
  const bairros = [...porBairro.values()].map((acc): Omit<BairroEmRisco, 'prioridade'> => {
    const ruas: RuaEmRisco[] = [...acc.ruas.values()].map((r) => ({
      rua: maisComum(r.nomes),
      clientes: r.lista.length,
      valor_mensal: soma(r.lista),
      sem_valor: r.lista.filter((c) => c.valor === null).length,
      caixas: [...r.caixas],
      lista: [...r.lista].sort((a, b) => (parseInt(a.numero ?? '', 10) || 0) - (parseInt(b.numero ?? '', 10) || 0)),
    })).sort((a, b) => b.valor_mensal - a.valor_mensal || b.clientes - a.clientes);
    const todos = ruas.flatMap((r) => r.lista);
    return {
      bairro: maisComum(acc.nomes),
      nivel: acc.nivel,
      rotulo: ROTULO_NIVEL[acc.nivel],
      caixas: acc.caixas.size,
      clientes: todos.length,
      valor_mensal: soma(todos),
      sem_valor: todos.filter((c) => c.valor === null).length,
      motivo: acc.motivos.size ? maisComum(acc.motivos) : '',
      ruas,
    };
  });
  return bairros
    .sort((a, b) => (PESO[b.nivel] ?? 0) - (PESO[a.nivel] ?? 0) || b.valor_mensal - a.valor_mensal || b.clientes - a.clientes)
    .map((b, i) => ({ prioridade: i + 1, ...b }));
}

export interface LeituraPrioridade {
  bairros: BairroEmRisco[];
  total: { bairros: number; caixas: number; clientes: number; valor_mensal: number; sem_valor: number };
  caixas_avaliadas: number;
  aviso_valor: string | null;
}

/** A rede inteira, já em ordem de prioridade. */
export async function lerPrioridades(): Promise<LeituraPrioridade> {
  const [base, precos] = await Promise.all([classificarRede(), precosDosPlanos()]);
  const emRisco = [...base.caixas.values()].filter((c) => PESO[c.nivel]);
  const bairros = montarPrioridades(emRisco, clientesDaCaixa, precos.mapa);
  const total = {
    bairros: bairros.length,
    caixas: emRisco.length,
    clientes: bairros.reduce((a, b) => a + b.clientes, 0),
    valor_mensal: Math.round(bairros.reduce((a, b) => a + b.valor_mensal, 0) * 100) / 100,
    sem_valor: bairros.reduce((a, b) => a + b.sem_valor, 0),
  };
  return {
    bairros, total, caixas_avaliadas: base.caixas.size,
    aviso_valor: precos.erro ?? (total.sem_valor
      ? `${total.sem_valor} cliente(s) com plano sem preço no SGP: o valor está por baixo`
      : null),
  };
}

/** Só os bairros pedidos (nome falado serve), mantendo a prioridade original. */
export function filtrarBairro(bairros: BairroEmRisco[], pedido: string): {
  bairros: BairroEmRisco[]; entendido: string | null; candidatos: string[];
} {
  const r = resolverBairro(pedido, bairros.map((b) => b.bairro));
  if (!r.bairro) return { bairros: [], entendido: null, candidatos: r.candidatos };
  return {
    bairros: bairros.filter((b) => r.variantes.includes(b.bairro)),
    entendido: r.como !== 'exato' ? r.variantes.join(' / ') : null,
    candidatos: [],
  };
}
