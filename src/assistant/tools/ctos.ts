// Ferramentas da série das CTOs (QuestDB): sinal ao longo do tempo e ocupação.
//
// O valor aqui é o HISTÓRICO: o Zabbix diz se a CTO caiu agora, e só na OLT-3;
// o QuestDB diz como o sinal médio de cada CTO se comportou nos últimos meses,
// em todas as OLTs. Piora gradual de sinal (fibra dobrada, conector sujo,
// splitter) aparece aqui antes de virar queda.

import {
  questdb, avaliarSinal, CtoAtual, SINAL_RUIM_DBM, linkMapa, PontoSinal,
} from '../../integrations/questdb';
import { ZabbixClient } from '../../integrations/zabbix';
import { obter } from '../config-dinamica';
import { Ferramenta, CtxFerramenta, medir, ferramentas } from './base';
import { config } from '../../config';

const r2 = (x: number | null) => (x === null ? null : Math.round(x * 100) / 100);

const NOTA_SINAL =
  'sinal_medio é a média, em dBm, do sinal óptico dos clientes da CTO. Mais negativo = pior. ' +
  `Abaixo de ${SINAL_RUIM_DBM} dBm é ruim por si só. Sem leitura (null) não é 0 dBm. ` +
  'É média: um cliente ruim numa CTO de 16 mexe pouco; a CTO toda piorando mexe muito.';

/** Resolve o nome dito pelo técnico para UMA CTO da série, ou devolve candidatas. */
export function resolverCto(
  termo: string,
  lista: CtoAtual[],
): { cto: CtoAtual | null; candidatas: string[]; por: 'id' | 'nome exato' | 'semelhança' | null } {
  const t = termo.trim();
  if (/^\d+$/.test(t)) {
    const porId = lista.find((c) => c.cto_id === Number(t));
    if (porId) return { cto: porId, candidatas: [], por: 'id' };
  }
  const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
  const exato = lista.filter((c) => norm(c.nome) === norm(t));
  if (exato.length === 1) return { cto: exato[0], candidatas: [], por: 'nome exato' };

  const ranking = lista
    .map((c) => ({ c, s: ZabbixClient.semelhanca(t, c.nome) }))
    .filter((x) => x.s >= ZabbixClient.LIMIAR_SEMELHANCA)
    .sort((a, b) => b.s - a.s);
  if (!ranking.length) return { cto: null, candidatas: [], por: null };
  const empatadas = ranking.filter((x) => x.s === ranking[0].s);
  if (empatadas.length > 1) return { cto: null, candidatas: empatadas.slice(0, 8).map((x) => x.c.nome), por: null };
  return { cto: ranking[0].c, candidatas: [], por: 'semelhança' };
}

function resumoAtual(c: CtoAtual) {
  return {
    cto_id: c.cto_id,
    nome: c.nome,
    pon: c.pon,
    sinal_medio_dbm: c.sinal,
    sinal_ruim: c.sinal !== null && c.sinal <= SINAL_RUIM_DBM,
    clientes: c.clientes,
    portas: c.portas,
    portas_livres: c.portas !== null && c.clientes !== null ? Math.max(0, c.portas - c.clientes) : null,
    ocupacao_pct: c.ocupacao,
    mapa: linkMapa(c.lat, c.long),
    leitura_em: c.em,
  };
}

/**
 * "Desde quando": o primeiro ponto do trecho final em que o sinal já estava
 * pior que a referência além do limiar. Null se o último ponto não está pior.
 */
export function inicioDaPiora(serie: PontoSinal[], referencia: number | null, limiar: number): string | null {
  if (referencia === null) return null;
  const pior = (p: PontoSinal) => p.media !== null && referencia - p.media >= limiar;
  const comDado = serie.filter((p) => p.media !== null);
  if (!comDado.length || !pior(comDado[comDado.length - 1])) return null;
  let i = comDado.length - 1;
  while (i > 0 && pior(comDado[i - 1])) i--;
  return comDado[i].em;
}

/** Análise de UMA CTO — usada pela ferramenta e pelo analisar_cto. */
export async function sinalDaCto(c: CtoAtual, horas: number) {
  const recenteMin = obter<number>('monitor.ctos.janela_min');
  const dias = obter<number>('monitor.ctos.dias_referencia');
  const limiarDb = obter<number>('monitor.ctos.limiar_db');
  const fim = new Date();
  const inicio = new Date(fim.getTime() - horas * 3600_000);
  // ~24 pontos, em múltiplos de 5 min (a cadência da coleta).
  const bucket = Math.max(5, Math.round((horas * 60) / 24 / 5) * 5);
  const [serie, [rec], [base]] = await Promise.all([
    questdb.serie(c.cto_id, inicio, fim, bucket),
    questdb.recente(recenteMin, c.cto_id),
    questdb.referencia(dias, recenteMin, c.cto_id),
  ]);
  const av = avaliarSinal(rec, base, limiarDb);
  const comDado = serie.filter((p) => p.media !== null);
  const pior = comDado.reduce<PontoSinal | null>((m, p) => (!m || p.media! < m.media! ? p : m), null);
  return {
    atual: resumoAtual(c),
    avaliacao: {
      situacao: av.situacao,
      explicacao: {
        piorou: `sinal dos últimos ${recenteMin} min está ${av.variacao_db} dB pior que a média dos ${dias} dias anteriores`,
        melhorou: `sinal dos últimos ${recenteMin} min está ${Math.abs(av.variacao_db ?? 0)} dB melhor que a média dos ${dias} dias anteriores`,
        estavel: `dentro da variação normal (±${av.limiar_db} dB) dos ${dias} dias anteriores`,
        sem_leitura: `sem leitura de sinal nos últimos ${recenteMin} min`,
        sem_referencia: `histórico insuficiente nos ${dias} dias anteriores para comparar`,
      }[av.situacao],
      sinal_recente_dbm: av.atual,
      referencia_dbm: av.referencia,
      variacao_db: av.variacao_db,
      limiar_db: av.limiar_db,
      piorou_desde: av.situacao === 'piorou' ? inicioDaPiora(serie, av.referencia, av.limiar_db) : null,
    },
    referencia: base ? {
      dias, media_dbm: r2(base.media), desvio_db: r2(base.desvio), min_dbm: r2(base.min), max_dbm: r2(base.max), leituras: base.amostras,
    } : null,
    janela: { inicio: inicio.toISOString(), fim: fim.toISOString(), horas, ponto_a_cada_min: bucket },
    pior_momento: pior ? { em: pior.em, sinal_dbm: r2(pior.min ?? pior.media) } : null,
    serie: serie.map((p) => ({ em: p.em, media_dbm: r2(p.media), min_dbm: r2(p.min) })),
    nota: NOTA_SINAL,
  };
}

// ─── Sinal de uma CTO ─────────────────────────────────────────────────────────

const sinalCto: Ferramenta = {
  nome: 'cto_sinal',
  fonte: 'questdb',
  descricao:
    'Histórico do sinal óptico médio de UMA CTO (todas as OLTs), com a comparação contra os dias ' +
    'anteriores: se piorou, quanto e desde quando. Mostra também clientes, portas livres, ocupação e mapa. ' +
    'Use para "o sinal da CTO X piorou?", "desde quando a CTO X está ruim?", "como estava o sinal ontem?". ' +
    'Aceita nome aproximado ou o id. Não diz se a CTO está fora do ar agora: para isso, analisar_cto (Zabbix).',
  parametros: {
    type: 'object',
    properties: {
      cto: { type: 'string', description: 'Nome da CTO (exato ou aproximado) ou id' },
      horas: { type: 'number', description: 'Janela do histórico em horas (padrão 24, máx 2160 = 90 dias)' },
    },
    required: ['cto'],
  },
  async executar(args, ctx: CtxFerramenta) {
    const termo = String(args.cto ?? '').trim();
    const horas = Math.min(2160, Math.max(1, Number(args.horas) || 24));
    return [await medir<Record<string, unknown>>(ctx, 'questdb', 'questdb.cto_sinal', { cto: termo, horas }, async () => {
      await questdb.exigirColetaViva();
      const res = resolverCto(termo, await questdb.ctosAtuais());
      if (!res.cto) {
        return {
          vazio: true,
          dados: res.candidatas.length
            ? { termo, ambiguo: true, candidatas: res.candidatas, instrucao: 'Pergunte qual destas é a CTO.' }
            : { termo, resolvida: null, instrucao: 'Nenhuma CTO com nome parecido na série. Peça o nome como está no SGP.' },
        };
      }
      return { dados: { termo, resolvida_por: res.por, ...(await sinalDaCto(res.cto, horas)) } };
    })];
  },
};

// ─── CTOs com sinal piorando ──────────────────────────────────────────────────

const sinalPiorando: Ferramenta = {
  nome: 'ctos_sinal_piorando',
  fonte: 'questdb',
  descricao:
    'Varre TODAS as CTOs e lista as que estão com o sinal pior que o normal delas (média dos dias ' +
    'anteriores), e as que estão com sinal ruim em valor absoluto. Agrupa por PON: várias CTOs da mesma ' +
    'PON piorando juntas apontam para o tronco/PON, não para cada CTO. ' +
    'Use para "tem CTO com sinal ruim?", "alguma CTO degradando?", "onde a rede está piorando?".',
  parametros: {
    type: 'object',
    properties: {
      minutos: { type: 'number', description: 'Janela recente em minutos (padrão: a do monitor, 30)' },
      dias_referencia: { type: 'number', description: 'Dias anteriores usados como normal (padrão 7, máx 60)' },
      limite: { type: 'number', description: 'Quantas CTOs listar (padrão 15, máx 50)' },
    },
    required: [],
  },
  async executar(args, ctx) {
    return [await medir<Record<string, unknown>>(ctx, 'questdb', 'questdb.ctos_sinal_piorando', args, async () => {
      await questdb.exigirColetaViva();
      const minutos = Math.min(24 * 60, Math.max(5, Number(args.minutos) || obter<number>('monitor.ctos.janela_min')));
      const dias = Math.min(60, Math.max(1, Number(args.dias_referencia) || obter<number>('monitor.ctos.dias_referencia')));
      const limite = Math.min(50, Math.max(1, Number(args.limite) || 15));
      const limiarDb = obter<number>('monitor.ctos.limiar_db');
      const [atuais, recentes, bases] = await Promise.all([
        questdb.ctosAtuais(), questdb.recente(minutos), questdb.referencia(dias, minutos),
      ]);
      const rec = new Map(recentes.map((x) => [x.cto_id, x]));
      const bas = new Map(bases.map((x) => [x.cto_id, x]));
      const avaliadas = atuais.map((c) => ({ c, av: avaliarSinal(rec.get(c.cto_id), bas.get(c.cto_id), limiarDb) }));

      const conta: Record<string, number> = {};
      for (const a of avaliadas) conta[a.av.situacao] = (conta[a.av.situacao] ?? 0) + 1;

      const pioraram = avaliadas.filter((a) => a.av.situacao === 'piorou')
        .sort((a, b) => (b.av.variacao_db ?? 0) - (a.av.variacao_db ?? 0));
      const porPon = new Map<string, number>();
      for (const a of pioraram) porPon.set(a.c.pon ?? '?', (porPon.get(a.c.pon ?? '?') ?? 0) + 1);
      const totalPorPon = new Map<string, number>();
      for (const c of atuais) totalPorPon.set(c.pon ?? '?', (totalPorPon.get(c.pon ?? '?') ?? 0) + 1);

      const ruins = avaliadas
        .filter((a) => a.av.atual !== null && a.av.atual <= SINAL_RUIM_DBM)
        .sort((a, b) => (a.av.atual ?? 0) - (b.av.atual ?? 0));

      const linha = (a: (typeof avaliadas)[number]) => ({
        cto_id: a.c.cto_id, nome: a.c.nome, pon: a.c.pon,
        sinal_recente_dbm: a.av.atual, referencia_dbm: a.av.referencia,
        piora_db: a.av.variacao_db, limiar_db: a.av.limiar_db,
        clientes: a.c.clientes, mapa: linkMapa(a.c.lat, a.c.long),
      });

      return {
        vazio: pioraram.length === 0 && ruins.length === 0,
        dados: {
          janela_recente_min: minutos,
          referencia_dias: dias,
          limiar_minimo_db: limiarDb,
          ctos_avaliadas: atuais.length,
          por_situacao: conta,
          pioraram: pioraram.slice(0, limite).map(linha),
          pons_com_varias_ctos_piorando: [...porPon.entries()].filter(([, n]) => n >= 2)
            .map(([pon, n]) => ({ pon, ctos_piorando: n, ctos_na_pon: totalPorPon.get(pon) ?? null }))
            .sort((a, b) => b.ctos_piorando - a.ctos_piorando),
          sinal_ruim_absoluto: {
            corte_dbm: SINAL_RUIM_DBM,
            total: ruins.length,
            ctos: ruins.slice(0, limite).map(linha),
          },
          sem_leitura: avaliadas.filter((a) => a.av.situacao === 'sem_leitura').map((a) => a.c.nome).slice(0, 20),
          nota: `${NOTA_SINAL} "PON" é o número da porta como está na série, sem a OLT.`,
        },
      };
    })];
  },
};

// ─── Ocupação ─────────────────────────────────────────────────────────────────

const ocupacao: Ferramenta = {
  nome: 'ctos_ocupacao',
  fonte: 'questdb',
  descricao:
    'Ocupação das CTOs agora: lotadas, quase cheias ou com mais portas livres, com totais da rede e link ' +
    'do mapa. Use para "quais CTOs estão lotadas?", "tem porta livre na CTO X?", "quantas portas livres ' +
    'temos?", "CTOs com vaga na PON 5". Ocupação vem do cadastro (clientes ativos / portas).',
  parametros: {
    type: 'object',
    properties: {
      ordem: { type: 'string', enum: ['mais_cheias', 'mais_livres'], description: 'Padrão: mais_cheias' },
      min_ocupacao: { type: 'number', description: 'Só CTOs com ocupação ≥ este % (padrão 0)' },
      max_ocupacao: { type: 'number', description: 'Só CTOs com ocupação ≤ este % (padrão 100)' },
      pon: { type: 'string', description: 'Filtra por PON' },
      busca: { type: 'string', description: 'Trecho do nome da CTO ou rua' },
      limite: { type: 'number', description: 'Quantas listar (padrão 20, máx 100)' },
    },
    required: [],
  },
  async executar(args, ctx) {
    return [await medir<Record<string, unknown>>(ctx, 'questdb', 'questdb.ctos_ocupacao', args, async () => {
      await questdb.exigirColetaViva();
      const todas = await questdb.ctosAtuais();
      const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
      const min = Number(args.min_ocupacao) || 0;
      const max = args.max_ocupacao === undefined ? 100 : Number(args.max_ocupacao);
      const pon = typeof args.pon === 'string' && args.pon.trim() ? args.pon.trim() : null;
      const busca = typeof args.busca === 'string' && args.busca.trim() ? norm(args.busca.trim()) : null;
      const limite = Math.min(100, Math.max(1, Number(args.limite) || 20));
      const filtradas = todas.filter((c) =>
        (c.ocupacao ?? 0) >= min && (c.ocupacao ?? 0) <= max &&
        (!pon || c.pon === pon) &&
        (!busca || norm(c.nome).includes(busca)));
      const cheias = args.ordem !== 'mais_livres';
      filtradas.sort((a, b) => cheias
        ? (b.ocupacao ?? 0) - (a.ocupacao ?? 0)
        : ((b.portas ?? 0) - (b.clientes ?? 0)) - ((a.portas ?? 0) - (a.clientes ?? 0)));

      const soma = (l: CtoAtual[], f: (c: CtoAtual) => number | null) => l.reduce((s, c) => s + (f(c) ?? 0), 0);
      const portas = soma(todas, (c) => c.portas);
      const ocupadas = soma(todas, (c) => c.clientes);
      return {
        vazio: filtradas.length === 0,
        dados: {
          rede: {
            ctos: todas.length,
            portas,
            ocupadas,
            livres: Math.max(0, portas - ocupadas),
            ocupacao_pct: portas ? Math.round((ocupadas / portas) * 1000) / 10 : null,
            lotadas: todas.filter((c) => (c.ocupacao ?? 0) >= 100).length,
            acima_de_85pct: todas.filter((c) => (c.ocupacao ?? 0) >= 85).length,
          },
          filtro: { ordem: cheias ? 'mais_cheias' : 'mais_livres', min_ocupacao: min, max_ocupacao: max, pon, busca: args.busca ?? null },
          encontradas: filtradas.length,
          ctos: filtradas.slice(0, limite).map(resumoAtual),
        },
      };
    })];
  },
};

export function registrarFerramentasCtos(): void {
  if (!config.questdb.enabled) return;
  ferramentas.registrar(sinalCto, sinalPiorando, ocupacao);
}
