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

const ORDINAIS: Record<string, string> = {
  primeira: '1', primeiro: '1', segunda: '2', segundo: '2', terceira: '3', terceiro: '3',
  quarta: '4', quarto: '4', quinta: '5', quinto: '5', sexta: '6', sexto: '6',
  setima: '7', setimo: '7', oitava: '8', oitavo: '8', nona: '9', nono: '9', decima: '10', decimo: '10',
};
const ABREVIACOES: Record<string, string> = { jd: 'jardim', jdm: 'jardim', vl: 'vila', pq: 'parque', conj: 'conjunto', cj: 'conjunto', res: 'residencial', n: 'nossa', sra: 'senhora', s: 'sao' };
/** Palavras que a pessoa fala mas não fazem parte do nome. */
const DE_FALA = new Set(['bairro', 'etapa', 'setor', 'regiao', 'area', 'la', 'ai', 'ali', 'aqui', 'no', 'na', 'do', 'da', 'de', 'dos', 'das', 'o', 'a']);

function romano(p: string): string | null {
  if (!/^[ivxl]+$/.test(p)) return null;
  const v: Record<string, number> = { i: 1, v: 5, x: 10, l: 50 };
  let total = 0;
  for (let i = 0; i < p.length; i++) {
    const a = v[p[i]];
    const b = v[p[i + 1]] ?? 0;
    total += a < b ? -a : a;
  }
  // Só o que se escreve assim de verdade: "xxiii" sim, "il" não.
  const volta = (n: number): string => {
    const tab: Array<[number, string]> = [[50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']];
    let s = '';
    for (const [k, r] of tab) while (n >= k) { s += r; n -= k; }
    return s;
  };
  return total > 0 && volta(total) === p ? String(total) : null;
}

/**
 * Como o nome SOA. Quem fala no áudio diz "Bolsa Fesso", "João vinte e três",
 * "Grande Lisboa", "quarta etapa"; o cadastro tem BONSUCESSO, JOAO XXIII,
 * GRANJA LISBOA, CONJUNTO CEARA IV. A chave tira acento e palavra de fala,
 * troca número romano e ordinal por algarismo e junta as letras que soam
 * igual em português (ss/ç/c/z, qu/k, lh/nh, m antes de consoante).
 */
export function chaveFalada(s: string): string {
  const palavras = norm(s).replace(/[^a-z0-9ºª ]/g, ' ').split(/\s+/).filter(Boolean)
    .map((p) => p.replace(/^(\d+)[ºªao]$/, '$1'))
    .map((p) => ABREVIACOES[p] ?? p)
    .map((p) => ORDINAIS[p] ?? romano(p) ?? p)
    .filter((p) => !DE_FALA.has(p));
  // Número vai para o fim: "segunda etapa do Conjunto Ceará" e "CONJUNTO
  // CEARA II" dizem o número em lugares diferentes da frase.
  const ordenadas = [...palavras.filter((p) => !/^\d+$/.test(p)), ...palavras.filter((p) => /^\d+$/.test(p))];
  return ordenadas.join('')
    .replace(/ph/g, 'f').replace(/ch/g, 'x').replace(/lh/g, 'l').replace(/nh/g, 'n')
    .replace(/qu/g, 'k').replace(/gu(?=[ei])/g, 'g').replace(/c(?=[ei])/g, 's').replace(/c/g, 'k')
    .replace(/[zç]/g, 's').replace(/y/g, 'i').replace(/w/g, 'v').replace(/h/g, '')
    .replace(/m(?=[^aeiou0-9]|$)/g, 'n')
    .replace(/(.)\1+/g, '$1');
}

/**
 * Qual bairro a pessoa quis dizer. "bom sucesso" é "BONSUCESSO" no cadastro:
 * difere em espaço e numa letra, e nenhuma comparação por trecho acha. Ordem:
 * igual (ignorando espaço e acento), igual pelo som, contém, e por último
 * parecido — este só quando um candidato ganha com folga, senão pergunta.
 * "pelo_som" avisa que a transcrição do áudio provavelmente trocou palavras:
 * a resposta deve dizer o que foi entendido.
 */
type ComoResolveu = 'exato' | 'contem' | 'aproximado' | 'pelo_som' | null;

export function resolverBairro(termo: string, conhecidos: readonly string[]): {
  bairro: string | null; candidatos: string[]; como: ComoResolveu;
  /**
   * Todas as grafias do cadastro que soam como o bairro achado: "BOM SUCESSO",
   * "BONSUCESSO" e "BOM SUCESO" são o mesmo lugar. Filtro tem que usar todas,
   * senão parte dos clientes do bairro fica de fora.
   */
  variantes: string[];
} {
  const unicos = [...new Set(conhecidos.filter(Boolean).map((b) => b.trim()))];
  const somDe = (b: string) => chaveFalada(b) || compacto(b);
  const grupos = new Map<string, string[]>();
  for (const b of unicos) grupos.set(somDe(b), [...(grupos.get(somDe(b)) ?? []), b]);
  // Um representante por som: duas grafias do mesmo bairro não empatam entre si.
  const representantes = [...grupos.values()].map((g) => g[0]);
  const r = resolverEntre(termo, unicos, representantes);
  return {
    ...r,
    variantes: r.bairro ? grupos.get(somDe(r.bairro)) ?? [r.bairro] : [],
    candidatos: [...new Set(r.candidatos.map((c) => grupos.get(somDe(c))?.join(' / ') ?? c))],
  };
}

function resolverEntre(termo: string, todos: string[], unicos: string[]): {
  bairro: string | null; candidatos: string[]; como: ComoResolveu;
} {
  const t = compacto(termo);
  if (!t) return { bairro: null, candidatos: [], como: null };
  const igual = todos.filter((b) => compacto(b) === t);
  if (igual.length) return { bairro: igual[0], candidatos: [], como: 'exato' };

  const som = chaveFalada(termo);
  const chaves = unicos.map((b) => ({ b, k: chaveFalada(b) }));
  const mesmoSom = som ? chaves.filter((x) => x.k === som) : [];
  if (mesmoSom.length === 1) return { bairro: mesmoSom[0].b, candidatos: [], como: 'pelo_som' };

  const contem = unicos.filter((b) => compacto(b).includes(t) || (t.length >= 5 && t.includes(compacto(b))));
  if (contem.length === 1) return { bairro: contem[0], candidatos: [], como: 'contem' };
  if (contem.length > 1) return { bairro: null, candidatos: contem.slice(0, 8), como: null };
  // Pelo som: "conjunto ceara quarta etapa" contém "conjunto ceara" quando o
  // cadastro não separa por etapa.
  const contemSom = som.length >= 5
    ? chaves.filter((x) => x.k.length >= 4 && (x.k.includes(som) || som.includes(x.k)))
    : [];
  if (contemSom.length) {
    // O mais longo é o mais específico: "conjunto ceara 4" antes de "conjunto ceara".
    const maior = Math.max(...contemSom.map((x) => x.k.length));
    const melhores = contemSom.filter((x) => x.k.length === maior);
    if (melhores.length === 1) return { bairro: melhores[0].b, candidatos: [], como: 'contem' };
    return { bairro: null, candidatos: melhores.slice(0, 8).map((x) => x.b), como: null };
  }

  if (t.length >= 5) {
    // Distância contada no SOM, com limite proporcional ao tamanho: "bolsa
    // fesso" fica a 3 trocas de "bom sucesso", e em nome de 9 letras isso
    // ainda é o mesmo nome mal ouvido. Acima de 2 trocas, exige folga de 2
    // sobre o segundo colocado, para não escolher no cara ou coroa.
    const limite = Math.max(2, Math.floor(som.length / 3));
    const perto = chaves
      .map((x) => ({ b: x.b, d: Math.min(edicao(x.k, som), edicao(compacto(x.b), t)) }))
      .filter((x) => x.d <= limite)
      .sort((a, b) => a.d - b.d);
    const folga = perto.length > 1 ? perto[1].d - perto[0].d : Infinity;
    if (perto.length && (perto[0].d <= 2 ? folga >= 1 : folga >= 2)) {
      return { bairro: perto[0].b, candidatos: [], como: perto[0].d <= 2 ? 'aproximado' : 'pelo_som' };
    }
    if (perto.length > 1) return { bairro: null, candidatos: perto.slice(0, 8).map((x) => x.b), como: null };
  }
  return { bairro: null, candidatos: [], como: null };
}

// ─── Endereço da CTO ────────────────────────────────────────────────────────
//
// "Em que rua fica essa caixa?" O QuestDB tem a coordenada; ninguém no campo
// pensa em coordenada. A rua sai de quem está ligado nela: a caixa fica no
// poste da rua onde mora a maioria dos clientes dela. É dedução, e sai com a
// conta junto ("12 dos 14 clientes moram na Rua X") e o link do mapa, que é a
// posição exata.

export interface EnderecoDaCto {
  rua: string;
  /** Faixa de números dos clientes nessa rua: diz em que trecho da rua a caixa está. */
  numeros: string | null;
  bairro: string | null;
  clientes_na_rua: number;
  clientes_total: number;
}

let cacheEnderecos: { em: number; mapa: Map<string, EnderecoDaCto> } | null = null;

function faixa(nums: Array<string | null>): string | null {
  const n = nums.map((x) => Number(String(x ?? '').replace(/\D.*$/, ''))).filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b);
  if (!n.length) return null;
  return n[0] === n[n.length - 1] ? String(n[0]) : `${n[0]} a ${n[n.length - 1]}`;
}

/** Rua predominante dos clientes de cada CTO, por id e por nome. Cache de 10 min: o cadastro muda à noite. */
export function enderecosDasCtos(): Map<string, EnderecoDaCto> {
  if (cacheEnderecos && Date.now() - cacheEnderecos.em < 600_000) return cacheEnderecos.mapa;
  const linhas = db().prepare(
    `SELECT s.cto_id, s.cto_nome, c.logradouro, c.numero, c.bairro
       FROM sgp_servico s
       JOIN sgp_contrato ct ON ct.contrato_id = s.contrato_id
       JOIN sgp_cliente  c  ON c.cliente_id  = ct.cliente_id
      WHERE (s.cto_id IS NOT NULL OR s.cto_nome IS NOT NULL)
        AND c.logradouro IS NOT NULL AND TRIM(c.logradouro) <> ''`,
  ).all() as Array<{ cto_id: number | null; cto_nome: string | null; logradouro: string; numero: string | null; bairro: string | null }>;

  const porCto = new Map<string, typeof linhas>();
  for (const l of linhas) {
    for (const k of [l.cto_id !== null ? `id:${l.cto_id}` : null, l.cto_nome ? `nome:${norm(l.cto_nome)}` : null]) {
      if (!k) continue;
      const lista = porCto.get(k) ?? [];
      lista.push(l);
      porCto.set(k, lista);
    }
  }
  const mapa = new Map<string, EnderecoDaCto>();
  for (const [k, lista] of porCto) {
    const porRua = new Map<string, typeof linhas>();
    for (const l of lista) {
      const r = norm(l.logradouro);
      porRua.set(r, [...(porRua.get(r) ?? []), l]);
    }
    const [, daRua] = [...porRua.entries()].sort((a, b) => b[1].length - a[1].length)[0];
    const bairros = new Map<string, number>();
    for (const l of daRua) if (l.bairro?.trim()) bairros.set(l.bairro.trim(), (bairros.get(l.bairro.trim()) ?? 0) + 1);
    mapa.set(k, {
      rua: daRua[0].logradouro.trim(),
      numeros: faixa(daRua.map((l) => l.numero)),
      bairro: [...bairros.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
      clientes_na_rua: daRua.length,
      clientes_total: lista.length,
    });
  }
  cacheEnderecos = { em: Date.now(), mapa };
  return mapa;
}

/** Endereço provável de uma CTO, ou null quando ela não tem cliente com endereço. */
export function enderecoDaCto(c: { cto_id: number; nome: string }): EnderecoDaCto | null {
  const m = enderecosDasCtos();
  return m.get(`id:${c.cto_id}`) ?? m.get(`nome:${norm(c.nome)}`) ?? null;
}

/** Texto curto para a resposta: "Rua X, 120 a 180 - Bairro (12 de 14 clientes moram nessa rua)". */
export function enderecoEmTexto(e: EnderecoDaCto | null): string | null {
  if (!e) return null;
  return `${e.rua}${e.numeros ? `, ${e.numeros}` : ''}${e.bairro ? ` - ${e.bairro}` : ''}` +
    ` (${e.clientes_na_rua} de ${e.clientes_total} clientes moram nessa rua)`;
}

/** Palavras de um nome de rua que distinguem: sem "rua", "avenida", "de". */
export function palavrasDaRua(s: string): string[] {
  return norm(s).replace(/[^a-z0-9 ]/g, ' ').split(' ')
    .filter((p) => p.length >= 2 && !['rua', 'r', 'av', 'avenida', 'travessa', 'tv', 'trav', 'alameda', 'al', 'estrada', 'rodovia', 'da', 'do', 'de', 'dos', 'das', 'na', 'no'].includes(p));
}

/** A rua falada ("rua bias mendes") casa com a rua do cadastro ("R. BIAS MENDES")? */
export function ruaCasa(pedida: string, doCadastro: string): boolean {
  const p = palavrasDaRua(pedida);
  if (!p.length) return false;
  const c = palavrasDaRua(doCadastro);
  const somC = c.map(chaveFalada);
  // Palavra igual, começo de palavra, mesmo som, ou uma letra trocada em
  // palavra longa ("Bias Mendes" contra "BIAS MENDEZ").
  return p.every((x) => c.includes(x) || c.some((w) => x.length >= 4 && w.startsWith(x)) ||
    somC.includes(chaveFalada(x)) || (x.length >= 5 && c.some((w) => w.length >= 5 && edicao(w, x) <= 1)));
}

/**
 * CTOs que atendem uma rua: as que têm cliente morando nela. Chave por id e
 * por nome, com quantos clientes daquela rua cada uma atende e o nome da rua
 * como está no cadastro.
 */
export function ctosDaRua(rua: string): { ruas: string[]; porCto: Map<string, number> } {
  const linhas = db().prepare(
    `SELECT s.cto_id, s.cto_nome, c.logradouro
       FROM sgp_servico s
       JOIN sgp_contrato ct ON ct.contrato_id = s.contrato_id
       JOIN sgp_cliente  c  ON c.cliente_id  = ct.cliente_id
      WHERE (s.cto_id IS NOT NULL OR s.cto_nome IS NOT NULL)
        AND c.logradouro IS NOT NULL AND TRIM(c.logradouro) <> ''`,
  ).all() as Array<{ cto_id: number | null; cto_nome: string | null; logradouro: string }>;
  const ruas = new Set<string>();
  const porCto = new Map<string, number>();
  for (const l of linhas) {
    if (!ruaCasa(rua, l.logradouro)) continue;
    ruas.add(l.logradouro.trim());
    for (const k of [l.cto_id !== null ? `id:${l.cto_id}` : null, l.cto_nome ? `nome:${norm(l.cto_nome)}` : null]) {
      if (k) porCto.set(k, (porCto.get(k) ?? 0) + 1);
    }
  }
  return { ruas: [...ruas].sort(), porCto };
}

/** Bairro de cada contrato, pelo cadastro do cliente. */
export function bairroDosContratos(): Map<number, string> {
  const linhas = db().prepare(
    `SELECT ct.contrato_id, c.bairro FROM sgp_contrato ct JOIN sgp_cliente c ON c.cliente_id = ct.cliente_id
      WHERE c.bairro IS NOT NULL AND TRIM(c.bairro) <> ''`,
  ).all() as Array<{ contrato_id: number; bairro: string }>;
  return new Map(linhas.map((l) => [l.contrato_id, l.bairro.trim()]));
}

/**
 * O bairro falado, resolvido contra o cadastro de clientes. Para filtro de
 * O.S. e cancelamento: lá não há CTO, há contrato, e o contrato tem bairro.
 */
export function bairroPedido(termo: string): {
  bairro: string | null; candidatos: string[]; variantes: string[];
  entendido: { pedido: string; entendido: string; como: string } | null;
} {
  const conhecidos = (db().prepare(
    `SELECT DISTINCT TRIM(bairro) b FROM sgp_cliente WHERE bairro IS NOT NULL AND TRIM(bairro) <> ''`,
  ).all() as Array<{ b: string }>).map((l) => l.b);
  const r = resolverBairro(termo, conhecidos);
  return {
    bairro: r.bairro,
    candidatos: r.candidatos,
    variantes: r.variantes,
    entendido: r.bairro && (r.como !== 'exato' || r.variantes.length > 1)
      ? { pedido: termo, entendido: r.variantes.join(' / '), como: r.como ?? '' } : null,
  };
}

/** Mesmo bairro, ignorando acento, caixa e espaço. */
export const mesmoBairro = (a: string | null | undefined, b: string | null | undefined): boolean =>
  !!a && !!b && compacto(a) === compacto(b);

/** O bairro do cadastro é alguma das grafias aceitas? */
export const bairroEntre = (a: string | null | undefined, variantes: readonly string[]): boolean =>
  variantes.some((v) => mesmoBairro(a, v));

export const chaveCto =(c: { cto_id: number; nome: string }): string[] => [`id:${c.cto_id}`, `nome:${norm(c.nome)}`];

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
): {
  ctos: CtoAtual[]; lugares: Map<number, BairroDaCto>; exatos: number; provaveis: number;
  /** Quando o nome pedido não era o do cadastro: o que foi entendido. A resposta deve dizer. */
  entendido: { pedido: string; entendido: string; como: string } | null;
} {
  const lugares = new Map<number, BairroDaCto>();
  for (const b of bairrosDasCtos(universo, f.raioM)) lugares.set(b.cto_id, b);
  if (!f.bairro && !f.cidade) return { ctos, lugares, exatos: 0, provaveis: 0, entendido: null };

  // Interpreta o nome falado ("bom sucesso") contra os bairros que existem.
  let alvos: string[] = f.bairro ? [norm(f.bairro)] : [];
  let entendido: { pedido: string; entendido: string; como: string } | null = null;
  if (f.bairro) {
    const conhecidos = [...lugares.values()].map((l) => l.bairro).filter((b): b is string => !!b);
    const r = resolverBairro(f.bairro, conhecidos);
    if (r.bairro) {
      alvos = r.variantes.map(norm);
      if (r.como !== 'exato' || r.variantes.length > 1) {
        entendido = { pedido: f.bairro, entendido: r.variantes.join(' / '), como: r.como ?? '' };
      }
    }
  }
  const alvoBairro = alvos.length ? alvos : null;
  const alvoCidade = f.cidade ? norm(f.cidade) : null;
  let exatos = 0;
  let provaveis = 0;

  const saida = ctos.filter((c) => {
    const b = lugares.get(c.cto_id);
    if (!b || b.qualidade === 'desconhecido') return false;
    if (b.qualidade === 'provavel' && f.aceitarProvavel === false) return false;
    const casaBairro = !alvoBairro || (!!b.bairro && alvoBairro.some((a) => norm(b.bairro!).includes(a) || a.includes(norm(b.bairro!))));
    const casaCidade = !alvoCidade || (!!b.cidade && (norm(b.cidade).includes(alvoCidade) || alvoCidade.includes(norm(b.cidade))));
    if (!casaBairro || !casaCidade) return false;
    if (b.qualidade === 'exato') exatos++; else provaveis++;
    return true;
  });
  return { ctos: saida, lugares, exatos, provaveis, entendido };
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
