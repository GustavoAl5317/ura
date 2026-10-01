// Em que bairro essa CTO está.
//
// Pergunta banal para quem olha o mapa, e sem resposta no sistema: a série das
// CTOs (QuestDB) tem nome, PON e coordenada, mas não tem bairro; o espelho do
// SGP tem o bairro do CLIENTE. Então o bairro da CTO é deduzido de quem está
// ligado nela.
//
// Duas qualidades de resposta, e elas nunca se misturam:
//   EXATO    — a CTO tem clientes, e o bairro é o que mais aparece entre eles.
//   PROVÁVEL — a CTO está vazia (nenhum cliente para perguntar). Aí vale a CTO
//              mais próxima que tenha bairro conhecido, com a distância dita em
//              metros. É palpite geográfico, e sai rotulado como palpite.
//
// "CTO vazia no Henrique Jorge" é exatamente o caso difícil: sem cliente, não
// existe bairro no cadastro. Inventar um seria pior que dizer que não sabe.

import { db } from './store/db';
import type { CtoAtual } from '../integrations/questdb';

export type Qualidade = 'exato' | 'provavel' | 'desconhecido';

export interface BairroDaCto {
  cto_id: number;
  nome: string;
  bairro: string | null;
  cidade: string | null;
  qualidade: Qualidade;
  /** Em "provavel": de qual CTO veio o palpite e a que distância. */
  base: string | null;
  distancia_m: number | null;
  clientes_no_cadastro: number;
}

interface LinhaLocal {
  cto_id: number | null;
  cto_nome: string | null;
  bairro: string | null;
  cidade: string | null;
  n: number;
}

const norm = (s: string): string =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Bairro predominante de cada CTO, pelo cadastro. Uma linha por CTO, com o
 * bairro mais frequente entre os clientes ligados nela.
 */
function bairrosDoCadastro(): Map<string, { bairro: string; cidade: string | null; n: number }> {
  const linhas = db().prepare(
    `SELECT s.cto_id, s.cto_nome, c.bairro, c.cidade, COUNT(*) n
       FROM sgp_servico s
       JOIN sgp_contrato ct ON ct.contrato_id = s.contrato_id
       JOIN sgp_cliente  c  ON c.cliente_id  = ct.cliente_id
      WHERE (s.cto_id IS NOT NULL OR s.cto_nome IS NOT NULL)
        AND c.bairro IS NOT NULL AND TRIM(c.bairro) <> ''
      GROUP BY s.cto_id, s.cto_nome, c.bairro, c.cidade
      ORDER BY n DESC`,
  ).all() as LinhaLocal[];

  const mapa = new Map<string, { bairro: string; cidade: string | null; n: number }>();
  for (const l of linhas) {
    // Primeira ocorrência ganha: a consulta já vem ordenada por frequência.
    for (const chave of [l.cto_id !== null ? `id:${l.cto_id}` : null, l.cto_nome ? `nome:${norm(l.cto_nome)}` : null]) {
      if (!chave || mapa.has(chave)) continue;
      mapa.set(chave, { bairro: l.bairro!.trim(), cidade: l.cidade?.trim() || null, n: l.n });
    }
  }
  return mapa;
}

/** Distância de edição entre duas palavras. Pequena, para nome de bairro. */
function edicao(a: string, b: string): number {
  if (a === b) return 0;
  const linha = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let anterior = linha[0];
    linha[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const guardado = linha[j];
      linha[j] = Math.min(linha[j] + 1, linha[j - 1] + 1, anterior + (a[i - 1] === b[j - 1] ? 0 : 1));
      anterior = guardado;
    }
  }
  return linha[b.length];
}

const compacto = (s: string) => norm(s).replace(/[^a-z0-9]/g, '');

/**
 * Qual bairro a pessoa quis dizer. "bom sucesso" é "BONSUCESSO" no cadastro:
 * difere em espaço e numa letra, e nenhuma comparação por trecho acha. Ordem:
 * igual (ignorando espaço e acento), contém, e por último parecido (até 2
 * letras de diferença) — este só quando sobra UM candidato, senão pergunta.
 */
export function resolverBairro(termo: string, conhecidos: readonly string[]): {
  bairro: string | null; candidatos: string[]; como: 'exato' | 'contem' | 'aproximado' | null;
} {
  const t = compacto(termo);
  if (!t) return { bairro: null, candidatos: [], como: null };
  const unicos = [...new Set(conhecidos.filter(Boolean))];
  const igual = unicos.filter((b) => compacto(b) === t);
  if (igual.length) return { bairro: igual[0], candidatos: [], como: 'exato' };

  const contem = unicos.filter((b) => compacto(b).includes(t) || (t.length >= 5 && t.includes(compacto(b))));
  if (contem.length === 1) return { bairro: contem[0], candidatos: [], como: 'contem' };
  if (contem.length > 1) return { bairro: null, candidatos: contem.slice(0, 8), como: null };

  if (t.length >= 5) {
    const perto = unicos
      .map((b) => ({ b, d: edicao(compacto(b), t) }))
      .filter((x) => x.d <= 2)
      .sort((a, b) => a.d - b.d);
    if (perto.length === 1 || (perto.length > 1 && perto[0].d < perto[1].d)) {
      return { bairro: perto[0].b, candidatos: [], como: 'aproximado' };
    }
    if (perto.length > 1) return { bairro: null, candidatos: perto.slice(0, 8).map((x) => x.b), como: null };
  }
  return { bairro: null, candidatos: [], como: null };
}

/** Distância em metros entre dois pontos. Haversine, raio médio da Terra. */
export function distanciaM(aLat: number, aLong: number, bLat: number, bLong: number): number {
  const R = 6_371_000;
  const rad = (x: number) => (x * Math.PI) / 180;
  const dLat = rad(bLat - aLat);
  const dLong = rad(bLong - aLong);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLong / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.min(1, Math.sqrt(h))));
}

/**
 * Bairro de cada CTO da lista. `raioM` limita o palpite por proximidade: além
 * dele, a resposta é "desconhecido", porque CTO a 3 km não diz nada sobre o
 * bairro da outra.
 */
export function bairrosDasCtos(ctos: CtoAtual[], raioM = 1500): BairroDaCto[] {
  const cadastro = bairrosDoCadastro();
  const doCadastro = (c: CtoAtual) =>
    cadastro.get(`id:${c.cto_id}`) ?? cadastro.get(`nome:${norm(c.nome)}`) ?? null;

  const conhecidas = ctos
    .map((c) => ({ c, b: doCadastro(c) }))
    .filter((x): x is { c: CtoAtual; b: { bairro: string; cidade: string | null; n: number } } =>
      !!x.b && x.c.lat !== null && x.c.long !== null);

  return ctos.map((c) => {
    const exato = doCadastro(c);
    if (exato) {
      return {
        cto_id: c.cto_id, nome: c.nome, bairro: exato.bairro, cidade: exato.cidade,
        qualidade: 'exato' as Qualidade, base: null, distancia_m: null, clientes_no_cadastro: exato.n,
      };
    }
    if (c.lat === null || c.long === null) {
      return {
        cto_id: c.cto_id, nome: c.nome, bairro: null, cidade: null,
        qualidade: 'desconhecido' as Qualidade, base: null, distancia_m: null, clientes_no_cadastro: 0,
      };
    }
    let melhor: { nome: string; bairro: string; cidade: string | null; d: number } | null = null;
    for (const v of conhecidas) {
      if (v.c.cto_id === c.cto_id) continue;
      const d = distanciaM(c.lat, c.long, v.c.lat!, v.c.long!);
      if (d <= raioM && (!melhor || d < melhor.d)) {
        melhor = { nome: v.c.nome, bairro: v.b.bairro, cidade: v.b.cidade, d };
      }
    }
    return {
      cto_id: c.cto_id, nome: c.nome,
      bairro: melhor?.bairro ?? null, cidade: melhor?.cidade ?? null,
      qualidade: melhor ? 'provavel' : 'desconhecido',
      base: melhor ? melhor.nome : null, distancia_m: melhor?.d ?? null,
      clientes_no_cadastro: 0,
    };
  });
}

/**
 * Filtra CTOs por bairro ou cidade. `aceitarProvavel` decide se CTO vazia com
 * bairro deduzido entra — para "CTOs vazias no bairro X" ela é o próprio
 * objetivo, então entra, rotulada.
 */
export function filtrarPorLugar(
  ctos: CtoAtual[],
  f: { bairro?: string; cidade?: string; aceitarProvavel?: boolean; raioM?: number },
  /**
   * Universo para deduzir bairro. Precisa ser a rede INTEIRA: num recorte
   * ("só as vazias") a CTO vazia perderia justamente as vizinhas que dizem
   * onde ela fica, e sumiria do próprio bairro.
   */
  universo: CtoAtual[] = ctos,
): { ctos: CtoAtual[]; lugares: Map<number, BairroDaCto>; exatos: number; provaveis: number } {
  const lugares = new Map<number, BairroDaCto>();
  for (const b of bairrosDasCtos(universo, f.raioM)) lugares.set(b.cto_id, b);
  if (!f.bairro && !f.cidade) return { ctos, lugares, exatos: 0, provaveis: 0 };

  // Interpreta o nome falado ("bom sucesso") contra os bairros que existem.
  let bairroPedido = f.bairro;
  if (f.bairro) {
    const conhecidos = [...lugares.values()].map((l) => l.bairro).filter((b): b is string => !!b);
    const r = resolverBairro(f.bairro, conhecidos);
    if (r.bairro) bairroPedido = r.bairro;
  }
  const alvoBairro = bairroPedido ? norm(bairroPedido) : null;
  const alvoCidade = f.cidade ? norm(f.cidade) : null;
  let exatos = 0;
  let provaveis = 0;

  const saida = ctos.filter((c) => {
    const b = lugares.get(c.cto_id);
    if (!b || b.qualidade === 'desconhecido') return false;
    if (b.qualidade === 'provavel' && f.aceitarProvavel === false) return false;
    const casaBairro = !alvoBairro || (!!b.bairro && (norm(b.bairro).includes(alvoBairro) || alvoBairro.includes(norm(b.bairro))));
    const casaCidade = !alvoCidade || (!!b.cidade && (norm(b.cidade).includes(alvoCidade) || alvoCidade.includes(norm(b.cidade))));
    if (!casaBairro || !casaCidade) return false;
    if (b.qualidade === 'exato') exatos++; else provaveis++;
    return true;
  });
  return { ctos: saida, lugares, exatos, provaveis };
}

export interface ResumoBairro {
  bairro: string;
  cidade: string | null;
  ctos: number;
  ctos_vazias: number;
  ctos_lotadas: number;
  clientes: number;
  portas: number;
  portas_livres: number;
  ocupacao_pct: number | null;
  sinal_medio_dbm: number | null;
  /** Quantas dessas CTOs entraram por palpite geográfico. */
  por_proximidade: number;
}

/** Rede por bairro: o corte que o dono do ISP pede e que não existia. */
export function resumoPorBairro(ctos: CtoAtual[], raioM = 1500): ResumoBairro[] {
  const lugares = bairrosDasCtos(ctos, raioM);
  const porChave = new Map<string, { b: BairroDaCto; lista: CtoAtual[]; provaveis: number }>();

  for (const c of ctos) {
    const b = lugares.find((x) => x.cto_id === c.cto_id)!;
    if (!b.bairro) continue;
    const chave = `${norm(b.bairro)}|${b.cidade ? norm(b.cidade) : ''}`;
    const atual = porChave.get(chave) ?? { b, lista: [], provaveis: 0 };
    atual.lista.push(c);
    if (b.qualidade === 'provavel') atual.provaveis++;
    porChave.set(chave, atual);
  }

  const soma = (xs: Array<number | null>): number => xs.reduce<number>((a, x) => a + (x ?? 0), 0);
  return [...porChave.values()].map(({ b, lista, provaveis }) => {
    const clientes = soma(lista.map((c) => c.clientes));
    const portas = soma(lista.map((c) => c.portas));
    const sinais = lista.map((c) => c.sinal).filter((x): x is number => x !== null);
    return {
      bairro: b.bairro!,
      cidade: b.cidade,
      ctos: lista.length,
      ctos_vazias: lista.filter((c) => (c.clientes ?? 0) === 0).length,
      ctos_lotadas: lista.filter((c) => c.portas !== null && c.clientes !== null && c.clientes >= c.portas).length,
      clientes,
      portas,
      portas_livres: Math.max(0, portas - clientes),
      ocupacao_pct: portas ? Math.round((clientes / portas) * 1000) / 10 : null,
      sinal_medio_dbm: sinais.length ? Math.round((sinais.reduce((a, x) => a + x, 0) / sinais.length) * 100) / 100 : null,
      por_proximidade: provaveis,
    };
  }).sort((a, b) => b.ctos - a.ctos);
}
