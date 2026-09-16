// Cliente da Flow Guard API — o sistema de NetFlow próprio, na flow-vm.
//
// Duas coisas que esta camada resolve para quem está em cima:
//
// 1. AMOSTRAGEM. O roteador exporta 1 fluxo a cada N e a API soma o que chegou,
//    sem multiplicar. Tudo que é volume (bytes, pacotes, Mbps) sai daqui já
//    corrigido pelo fator e marcado como estimativa. Contagem de fluxos NÃO é
//    corrigida: é o número de registros amostrados, e é dito assim.
//
// 2. FRESCOR. Em 16/09/2026 a coleta estava parada havia 50 dias (disco cheio)
//    e a API respondia normalmente — só que sem dado novo. Consulta que cobre o
//    "agora" primeiro confere se chegou fluxo nos últimos minutos; se não
//    chegou, LANÇA. Coleta parada é fonte indisponível, nunca "sem tráfego".

import axios, { AxiosError, AxiosInstance } from 'axios';
import { config } from '../config';

export interface ResumoNetflow {
  total_flows: number;
  total_bytes: number;
  total_packets: number;
  peak_mbps: number;
  avg_mbps: number;
  current_mbps: number;
}

export interface TalkerNetflow {
  ip: string;
  total_bytes: number;
  total_packets: number;
  flows: number;
  src_as?: number;
  dst_as?: number;
  critical?: number;
  warning?: number;
}

export interface AsnNetflow {
  asn: number;
  total_bytes: number;
  total_packets: number;
  flows: number;
}

export interface PontoSerie {
  bucket: number;
  total_bytes: number;
  in_bytes?: number;
  out_bytes?: number;
  total_packets?: number;
  flows?: number;
  critical?: number;
  warning?: number;
}

export interface IncidenteNetflow {
  id: number;
  tstamp: number;
  severity: string;
  score: number;
  proto: string;
  ip: string;
  cli_ip?: string;
  src_port?: number;
  dst_port?: number;
  bytes: number;
  packets: number;
  duration?: number;
}

export interface AtaqueNetflow {
  victim_ip: string;
  total_bytes: number;
  total_packets: number;
  first_seen: number;
  last_seen: number;
  unique_sources: number;
  protocol_count: number;
  event_count: number;
  duration_s: number;
  max_severity: string;
  protocols?: Array<{ proto: string; cnt: number; bytes: number }>;
  top_sources?: Array<{ ip: string; cnt: number; bytes: number }>;
  top_asns?: Array<{ asn: number; cnt: number; bytes: number }>;
}

export interface Janela {
  /** epoch em segundos */
  inicio: number;
  fim: number;
}

export interface Frescor {
  viva: boolean;
  /** Fluxos amostrados recebidos na janela de silêncio. */
  fluxosRecentes: number;
  janelaMin: number;
  verificadoEm: string;
}

export class NetflowClient {
  private http?: AxiosInstance;
  private cacheFrescor: { em: number; valor: Frescor } | null = null;

  get disponivel(): boolean {
    return config.netflow.enabled && !!config.netflow.baseUrl && !!config.netflow.apiKey;
  }

  get fator(): number {
    return Math.max(1, config.netflow.fatorAmostragem);
  }

  private get client(): AxiosInstance {
    if (!this.http) {
      this.http = axios.create({
        baseURL: config.netflow.baseUrl.replace(/\/+$/, ''),
        timeout: config.netflow.timeoutMs,
        headers: { Authorization: `Bearer ${config.netflow.apiKey}` },
      });
    }
    return this.http;
  }

  private async get<T>(caminho: string, params: Record<string, unknown>): Promise<T> {
    if (!this.disponivel) throw new Error('NetFlow não configurado (NETFLOW_ENABLED, NETFLOW_URL, NETFLOW_API_KEY)');
    const limpos = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ''));
    try {
      const r = await this.client.get<T>(caminho, { params: limpos });
      return r.data;
    } catch (err) {
      const ax = err as AxiosError<{ detail?: unknown }>;
      const status = ax.response?.status;
      const detalhe = typeof ax.response?.data?.detail === 'string' ? ` — ${ax.response.data.detail}` : '';
      if (status === 401 || status === 403) throw new Error(`NetFlow recusou a chave (HTTP ${status})${detalhe}`);
      throw new Error(`NetFlow: ${status ? `HTTP ${status}` : ax.message}${detalhe}`);
    }
  }

  private static registros<T>(r: unknown, campo = 'records'): T[] {
    const v = (r as Record<string, unknown> | null)?.[campo];
    return Array.isArray(v) ? (v as T[]) : [];
  }

  /**
   * Chegou fluxo nos últimos minutos? Cache de 60 s: várias ferramentas na
   * mesma pergunta não repetem a checagem.
   */
  async frescor(): Promise<Frescor> {
    const agora = Date.now();
    if (this.cacheFrescor && agora - this.cacheFrescor.em < 60_000) return this.cacheFrescor.valor;
    const janelaMin = Math.max(1, config.netflow.silencioMaxMin);
    const fim = Math.floor(agora / 1000);
    const r = await this.get<ResumoNetflow>('/api/netflow/summary', { epoch_begin: fim - janelaMin * 60, epoch_end: fim });
    const valor: Frescor = {
      viva: (r?.total_flows ?? 0) > 0,
      fluxosRecentes: r?.total_flows ?? 0,
      janelaMin,
      verificadoEm: new Date(agora).toISOString(),
    };
    this.cacheFrescor = { em: agora, valor };
    return valor;
  }

  /**
   * Garante que a coleta está viva quando a janela pedida chega até agora.
   * Janela só do passado não exige: dado antigo continua válido.
   */
  async exigirColetaViva(j: Janela): Promise<Frescor | null> {
    const cobreAgora = j.fim >= Date.now() / 1000 - config.netflow.silencioMaxMin * 60;
    if (!cobreAgora) return null;
    const f = await this.frescor();
    if (!f.viva) {
      throw new Error(
        `coleta do NetFlow parada: nenhum fluxo recebido nos últimos ${f.janelaMin} min. ` +
        'O volume desta janela não representa o tráfego real.',
      );
    }
    return f;
  }

  resumo(j: Janela, filtro: { asn?: number; protocolo?: string } = {}): Promise<ResumoNetflow> {
    return this.get<ResumoNetflow>('/api/netflow/summary', {
      epoch_begin: j.inicio, epoch_end: j.fim, asn: filtro.asn, protocol: filtro.protocolo,
    });
  }

  async serie(j: Janela, bucketSeg: number): Promise<PontoSerie[]> {
    return NetflowClient.registros<PontoSerie>(await this.get('/api/netflow/timeseries', {
      epoch_begin: j.inicio, epoch_end: j.fim, bucket_seconds: bucketSeg,
    }));
  }

  async serieDoIp(ip: string, j: Janela, bucketSeg: number): Promise<PontoSerie[]> {
    const brutos = NetflowClient.registros<Record<string, unknown>>(await this.get('/api/netflow/ip-timeseries', {
      ip, epoch_begin: j.inicio, epoch_end: j.fim, bucket_seconds: bucketSeg,
    }));
    // Esta rota não foi vista com dado real na integração: aceita os nomes de
    // campo das rotas irmãs em vez de assumir um só e devolver zero em silêncio.
    return brutos.map((r) => {
      const n = (k: string) => (typeof r[k] === 'number' ? (r[k] as number) : null);
      const entrada = n('in_bytes') ?? n('bytes_in') ?? 0;
      const saida = n('out_bytes') ?? n('bytes_out') ?? 0;
      const bucket = n('bucket') ?? n('ts') ?? n('tstamp') ?? n('time');
      const total = n('total_bytes') ?? n('bytes') ?? (entrada + saida);
      if (bucket === null) throw new Error('NetFlow: ip-timeseries em formato inesperado (sem campo de tempo)');
      return { bucket, total_bytes: total, in_bytes: entrada, out_bytes: saida, flows: n('flows') ?? undefined };
    });
  }

  async consumoPorCliente(j: Janela, limite: number): Promise<TalkerNetflow[]> {
    return NetflowClient.registros<TalkerNetflow>(await this.get('/api/netflow/bandwidth-by-client', {
      epoch_begin: j.inicio, epoch_end: j.fim, limit: limite,
    }));
  }

  async topAsn(j: Janela, limite: number): Promise<AsnNetflow[]> {
    return NetflowClient.registros<AsnNetflow>(await this.get('/api/netflow/top-asn', {
      epoch_begin: j.inicio, epoch_end: j.fim, limit: limite,
    }));
  }

  async incidentes(j: Janela, limite: number, severidade?: string): Promise<IncidenteNetflow[]> {
    return NetflowClient.registros<IncidenteNetflow>(await this.get('/api/netflow/incidents', {
      epoch_begin: j.inicio, epoch_end: j.fim, limit: limite, severity: severidade,
    }));
  }

  async ataques(j: Janela, limite: number): Promise<AtaqueNetflow[]> {
    return NetflowClient.registros<AtaqueNetflow>(await this.get('/api/correlation/attacks', {
      epoch_begin: j.inicio, epoch_end: j.fim, limit: limite,
    }), 'attacks');
  }

  /** Para teste: esquece a checagem de frescor em cache. */
  limparCache(): void {
    this.cacheFrescor = null;
  }
}

export const netflow = new NetflowClient();

// ─── Conversões para quem está em cima ────────────────────────────────────────

/** Volume amostrado → estimado. */
export function estimar(valor: number | null | undefined, fator = netflow.fator): number {
  return Math.round((valor ?? 0) * fator);
}

export function formatarBytes(b: number): string {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = b;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`.replace('.', ',');
}

export function formatarMbps(mbps: number): string {
  if (mbps >= 1000) return `${(mbps / 1000).toFixed(2).replace('.', ',')} Gbps`;
  return `${(mbps >= 100 ? Math.round(mbps).toString() : mbps.toFixed(1)).replace('.', ',')} Mbps`;
}

/** Média de Mbps de um volume em bytes ao longo de N segundos. */
export function mbpsMedio(bytes: number, segundos: number): number {
  return segundos > 0 ? (bytes * 8) / segundos / 1_000_000 : 0;
}
