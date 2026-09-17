// Cliente do QuestDB (10.169.0.52) — série temporal das CTOs.
//
// A tabela `ctos` recebe uma linha por CTO a cada ~5 min desde 06/07/2026:
// sinal médio dos clientes (dBm), clientes ativos, portas e ocupação.
// Calibrado em 16/09/2026 com os dados reais:
//   · 294 CTOs; em 208 delas o sinal varia menos de 0,1 dB em 7 dias, e só 4
//     passam de 1 dB — o sinal é estável, e 3 dB de piora é fato, não ruído;
//   · clientes_ativos NÃO muda ao longo do dia: é cadastro, não "online".
//     Não serve para detectar queda de CTO;
//   · 3 CTOs têm sinal sempre nulo: "sem leitura", nunca 0 dBm.
//
// Duas regras desta camada:
//   1. SQL só com número e nome de tabela validado. Nome de CTO vindo do
//      usuário é resolvido em memória contra a lista, nunca interpolado.
//   2. FRESCOR: coleta que parou devolve dado velho sem erro. Consulta que
//      cobre o agora confere a última linha antes; parado = fonte indisponível.

import axios, { AxiosError, AxiosInstance } from 'axios';
import { config } from '../config';

export interface CtoAtual {
  cto_id: number;
  nome: string;
  pon: string | null;
  lat: number | null;
  long: number | null;
  /** dBm; null = sem leitura. Mais negativo = pior. */
  sinal: number | null;
  clientes: number | null;
  portas: number | null;
  ocupacao: number | null;
  em: string;
}

export interface PontoSinal {
  em: string;
  media: number | null;
  min: number | null;
  max: number | null;
}

export interface BaseSinal {
  cto_id: number;
  media: number | null;
  desvio: number | null;
  min: number | null;
  max: number | null;
  amostras: number;
}

export interface RecenteSinal {
  cto_id: number;
  media: number | null;
  amostras: number;
}

export interface FrescorQuest {
  viva: boolean;
  ultima: string | null;
  idadeMin: number | null;
  limiteMin: number;
}

const TABELA_VALIDA = /^[A-Za-z_][A-Za-z0-9_]*$/;

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Microssegundos desde a época — o literal de timestamp que o QuestDB aceita sem ambiguidade de formato. */
export function micros(d: Date): string {
  return `${Math.floor(d.getTime())}000`;
}

export class QuestdbClient {
  private http?: AxiosInstance;
  private cacheFrescor: { em: number; valor: FrescorQuest } | null = null;
  private cacheAtuais: { em: number; valor: CtoAtual[] } | null = null;

  get disponivel(): boolean {
    return config.questdb.enabled && !!config.questdb.baseUrl;
  }

  get tabela(): string {
    const t = config.questdb.tabelaSinais;
    if (!TABELA_VALIDA.test(t)) throw new Error(`QUESTDB_TABELA_SINAIS inválida: ${t}`);
    return t;
  }

  limparCache(): void {
    this.cacheFrescor = null;
    this.cacheAtuais = null;
  }

  private get client(): AxiosInstance {
    if (!this.http) {
      const { user, password } = config.questdb;
      this.http = axios.create({
        baseURL: config.questdb.baseUrl.replace(/\/+$/, ''),
        timeout: config.questdb.timeoutMs,
        ...(user ? { auth: { username: user, password } } : {}),
      });
    }
    return this.http;
  }

  /** Executa e devolve as linhas como objetos (coluna → valor). */
  async sql(query: string): Promise<Array<Record<string, unknown>>> {
    if (!this.disponivel) throw new Error('QuestDB não configurado (QUESTDB_ENABLED, QUESTDB_URL)');
    try {
      const r = await this.client.get<{ columns?: Array<{ name: string }>; dataset?: unknown[][]; error?: string }>(
        '/exec', { params: { query } },
      );
      if (r.data?.error) throw new Error(r.data.error);
      const cols = (r.data?.columns ?? []).map((c) => c.name);
      return (r.data?.dataset ?? []).map((row) => Object.fromEntries(cols.map((c, i) => [c, row[i]])));
    } catch (err) {
      const ax = err as AxiosError<{ error?: string }>;
      if (!ax.isAxiosError) throw err;
      const status = ax.response?.status;
      const detalhe = ax.response?.data?.error ? ` — ${ax.response.data.error}` : '';
      if (status === 401 || status === 403) throw new Error(`QuestDB recusou o acesso (HTTP ${status})`);
      throw new Error(`QuestDB: ${status ? `HTTP ${status}` : ax.message}${detalhe}`);
    }
  }

  /** Última linha gravada. Cache de 60 s. */
  async frescor(): Promise<FrescorQuest> {
    const agora = Date.now();
    if (this.cacheFrescor && agora - this.cacheFrescor.em < 60_000) return this.cacheFrescor.valor;
    const limiteMin = Math.max(1, config.questdb.silencioMaxMin);
    // Só a partição recente: max() na tabela toda varre meses de dado.
    const [r] = await this.sql(
      `SELECT max(created_at) ultima FROM ${this.tabela} WHERE created_at > dateadd('d', -3, now())`,
    );
    const ultima = typeof r?.ultima === 'string' ? r.ultima : null;
    const idadeMin = ultima ? Math.round((agora - Date.parse(ultima)) / 60_000) : null;
    const valor: FrescorQuest = { viva: idadeMin !== null && idadeMin <= limiteMin, ultima, idadeMin, limiteMin };
    this.cacheFrescor = { em: agora, valor };
    return valor;
  }

  async exigirColetaViva(): Promise<FrescorQuest> {
    const f = await this.frescor();
    if (!f.viva) {
      throw new Error(
        f.ultima
          ? `coleta das CTOs parada: última leitura há ${f.idadeMin} min (limite ${f.limiteMin} min). O sinal "atual" seria velho.`
          : 'coleta das CTOs parada: nenhuma leitura nos últimos 3 dias.',
      );
    }
    return f;
  }

  /** Última leitura de cada CTO. Cache de 60 s. */
  async ctosAtuais(): Promise<CtoAtual[]> {
    const agora = Date.now();
    if (this.cacheAtuais && agora - this.cacheAtuais.em < 60_000) return this.cacheAtuais.valor;
    const linhas = await this.sql(
      `SELECT cto_id, nome, pon, lat, long, sinal_medio, clientes_ativos, total_portas, ocupacao_percentual, created_at
       FROM ${this.tabela} WHERE created_at > dateadd('d', -1, now())
       LATEST ON created_at PARTITION BY cto_id`,
    );
    const valor = linhas.map((l): CtoAtual => ({
      cto_id: Number(l.cto_id),
      nome: String(l.nome ?? `CTO ${l.cto_id}`).trim(),
      pon: l.pon === null || l.pon === undefined ? null : String(l.pon),
      lat: num(l.lat),
      long: num(l.long),
      sinal: num(l.sinal_medio),
      clientes: num(l.clientes_ativos),
      portas: num(l.total_portas),
      ocupacao: num(l.ocupacao_percentual),
      em: String(l.created_at),
    }));
    this.cacheAtuais = { em: agora, valor };
    return valor;
  }

  /** Série de uma CTO em baldes de `bucketMin` minutos. */
  async serie(ctoId: number, inicio: Date, fim: Date, bucketMin: number): Promise<PontoSinal[]> {
    const id = Math.trunc(ctoId);
    const b = Math.max(1, Math.trunc(bucketMin));
    const linhas = await this.sql(
      `SELECT created_at, avg(sinal_medio) media, min(sinal_medio) mn, max(sinal_medio) mx
       FROM ${this.tabela}
       WHERE cto_id = ${id} AND created_at >= cast(${micros(inicio)} as timestamp) AND created_at < cast(${micros(fim)} as timestamp)
       SAMPLE BY ${b}m ALIGN TO CALENDAR`,
    );
    return linhas.map((l) => ({ em: String(l.created_at), media: num(l.media), min: num(l.mn), max: num(l.mx) }));
  }

  /** Média recente por CTO (últimos `minutos`). `ctoId` restringe a uma. */
  async recente(minutos: number, ctoId?: number): Promise<RecenteSinal[]> {
    const m = Math.max(1, Math.trunc(minutos));
    const filtro = ctoId !== undefined ? ` AND cto_id = ${Math.trunc(ctoId)}` : '';
    const linhas = await this.sql(
      `SELECT cto_id, avg(sinal_medio) media, count(sinal_medio) n
       FROM ${this.tabela} WHERE created_at > dateadd('m', -${m}, now())${filtro} GROUP BY cto_id`,
    );
    return linhas.map((l) => ({ cto_id: Number(l.cto_id), media: num(l.media), amostras: Number(l.n) || 0 }));
  }

  /**
   * Referência por CTO: os `dias` anteriores, SEM a janela recente — senão uma
   * piora em curso puxa a própria referência e se esconde.
   */
  async referencia(dias: number, excluirMin: number, ctoId?: number): Promise<BaseSinal[]> {
    const d = Math.max(1, Math.trunc(dias));
    const x = Math.max(0, Math.trunc(excluirMin));
    const filtro = ctoId !== undefined ? ` AND cto_id = ${Math.trunc(ctoId)}` : '';
    const linhas = await this.sql(
      `SELECT cto_id, avg(sinal_medio) media, stddev_samp(sinal_medio) desvio,
              min(sinal_medio) mn, max(sinal_medio) mx, count(sinal_medio) n
       FROM ${this.tabela}
       WHERE created_at > dateadd('d', -${d}, now()) AND created_at <= dateadd('m', -${x}, now())${filtro}
       GROUP BY cto_id`,
    );
    return linhas.map((l) => ({
      cto_id: Number(l.cto_id),
      media: num(l.media),
      desvio: num(l.desvio),
      min: num(l.mn),
      max: num(l.mx),
      amostras: Number(l.n) || 0,
    }));
  }
}

export const questdb = new QuestdbClient();

// ─── Leitura do sinal ─────────────────────────────────────────────────────────

export type SituacaoSinal = 'piorou' | 'melhorou' | 'estavel' | 'sem_leitura' | 'sem_referencia';

export interface Avaliacao {
  situacao: SituacaoSinal;
  /** dB; positivo = piorou (ficou mais negativo). */
  variacao_db: number | null;
  limiar_db: number;
  atual: number | null;
  referencia: number | null;
}

/** Amostras mínimas na referência: ~2 h de coleta a cada 5 min. */
export const MIN_AMOSTRAS_REFERENCIA = 24;

/**
 * Compara a média recente com a referência. O limiar é o maior entre o fixo e
 * 3 desvios da própria CTO: a CTO que oscila 1 dB normalmente não pode alertar
 * em 3 dB, e a que nunca oscila não pode esperar 3 desvios de quase zero.
 */
export function avaliarSinal(
  recente: RecenteSinal | undefined,
  base: BaseSinal | undefined,
  limiarDb: number,
): Avaliacao {
  const limiar = Math.max(limiarDb, 3 * (base?.desvio ?? 0));
  const r = (x: number) => Math.round(x * 100) / 100;
  const atual = recente?.media ?? null;
  const ref = base?.media ?? null;
  const out = (situacao: SituacaoSinal, variacao: number | null): Avaliacao => ({
    situacao, variacao_db: variacao === null ? null : r(variacao), limiar_db: r(limiar), atual: atual === null ? null : r(atual), referencia: ref === null ? null : r(ref),
  });
  if (atual === null || !recente?.amostras) return out('sem_leitura', null);
  if (ref === null || (base?.amostras ?? 0) < MIN_AMOSTRAS_REFERENCIA) return out('sem_referencia', null);
  const piora = ref - atual;
  if (piora >= limiar) return out('piorou', piora);
  if (piora <= -limiar) return out('melhorou', piora);
  return out('estavel', piora);
}

/** Abaixo disto o sinal é ruim por si só, independente do histórico (mesmo corte do resumo diário). */
export const SINAL_RUIM_DBM = -27;

export function linkMapa(lat: number | null, long: number | null): string | null {
  if (lat === null || long === null || (lat === 0 && long === 0)) return null;
  return `https://maps.google.com/?q=${lat},${long}`;
}
