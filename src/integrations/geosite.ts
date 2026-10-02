// GeoSite Telecom API client
// Docs: https://telecom.digicade.com.br/geosite-telecom-api/
//
// Auth: POST /auth/generatetoken → token válido por 30 min
// Header: Authorization: Digicade-Rest-API:{token}
// Refresh token: POST /auth/refresh (válido por 30 dias)

import axios, { AxiosInstance } from 'axios';
import { config } from '../config';
import { logger } from '../logger';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CaixaViabilidade {
  tipoCodigo: string;
  distanciaMetros: number;
  portasDisponiveis: number;
  portasSplitterDisponiveis: number;
  fid?: number;
  /** Portas do splitter, no total (ocupadas + livres). */
  capacidadeSplitter?: number;
  /** Clientes que a planta registra nesta caixa. */
  clientes?: number;
  /** Coordenada oficial da caixa, quando a planta manda a geometria. */
  latitude?: number;
  longitude?: number;
}

export interface Viabilidade {
  temCobertura: boolean;
  totalDisponiveis?: number;
  caixasProximas?: number;
  distanciaMinMetros?: number;
  portasSplitterDisponiveis?: number;
  // CTO mais próxima que cobre o endereço E tem porta disponível.
  // Se a mais próxima estiver lotada, é a próxima mais próxima com porta livre.
  caixaSelecionada?: CaixaViabilidade;
  // Todas as CTOs que cobrem o endereço (dentro do raio), ordenadas da mais próxima para a mais distante.
  caixasCobrindo?: CaixaViabilidade[];
}

interface GeositeToken {
  token: string;
  refreshToken: string;
  expiresAt: number; // timestamp ms
}

interface GeositeCaixa {
  tipoCodigo: string;
  distancia: number;
  /** A API manda qtdDisponivel; versões antigas mandavam qtdTotalDisponivel. */
  qtdDisponivel?: number;
  qtdOcupada?: number;
  geometryCaixaEmenda?: string;
  qtdTotalDisponivel: number;
  qtdSplitter: number;
  qtdPortasSplitter: number;
  qtdPortasSplitterDisp: number;
  qtdPortasSplitterOcup: number;
  qtdEquipamentosPacpon: number;
  qtdPortasEthernet: number;
  qtdPortasEthernetDisp: number;
  qtdPortasEthernetOcup: number;
  fid?: number;
  fidTipoCaixaEmenda?: number;
  capacidade?: number;
  qtdClientes?: number;
  distanciaRotaSugerida?: number;
}

// ─── Leitura da resposta ──────────────────────────────────────────────────────

/**
 * A API responde `{ success: "true", caixas: [...] }`. A primeira versão deste
 * cliente esperava um array cru e descartava tudo com Array.isArray, então
 * TODA consulta de viabilidade respondia "sem cobertura" — sem erro no log,
 * que é o pior jeito de falhar. Aceita as duas formas de propósito: se a API
 * voltar a mandar array, continua funcionando.
 */
export function extrairCaixas(data: unknown): GeositeCaixa[] {
  if (Array.isArray(data)) return data as GeositeCaixa[];
  const corpo = data as { caixas?: unknown; data?: unknown } | null | undefined;
  for (const campo of [corpo?.caixas, corpo?.data]) {
    if (Array.isArray(campo)) return campo as GeositeCaixa[];
  }
  return [];
}

/** Nomes das colunas de um /desc: `{ columns: [{ name }] }`. */
export function extrairColunas(data: unknown): string[] {
  const cols = (data as { columns?: unknown } | null)?.columns;
  if (!Array.isArray(cols)) return [];
  return cols.map((c) => (typeof c === 'string' ? c : String((c as { name?: unknown })?.name ?? ''))).filter(Boolean);
}

/**
 * Registros de um /list (`{ total, records }`) ou de outra consulta que mande
 * a lista em outro campo. Mesmo cuidado de extrairCaixas: aceitar as formas
 * conhecidas em vez de devolver vazio calado.
 */
export function extrairRegistros(data: unknown): { total: number | null; registros: Array<Record<string, unknown>> } {
  if (Array.isArray(data)) return { total: data.length, registros: data as Array<Record<string, unknown>> };
  const corpo = data as Record<string, unknown> | null | undefined;
  const total = typeof corpo?.total === 'number' ? corpo.total : Number.isFinite(Number(corpo?.total)) && corpo?.total !== undefined ? Number(corpo.total) : null;
  for (const campo of ['records', 'caixas', 'facilidades', 'data', 'itens', 'lista']) {
    const v = corpo?.[campo];
    if (Array.isArray(v)) return { total: total ?? v.length, registros: v as Array<Record<string, unknown>> };
  }
  return { total, registros: [] };
}

/**
 * Coordenada de um registro qualquer da planta: latitude/longitude, x/y
 * (EPSG:4326, x = longitude) ou geometria em WKT.
 */
export function coordenadaDe(r: Record<string, unknown>): { latitude?: number; longitude?: number } {
  const num = (v: unknown) => (v === null || v === undefined || v === '' ? NaN : Number(v));
  const lat = num(r.latitude ?? r.lat);
  const lon = num(r.longitude ?? r.lon ?? r.long ?? r.lng);
  if (Number.isFinite(lat) && Number.isFinite(lon)) return { latitude: lat, longitude: lon };
  const x = num(r.x);
  const y = num(r.y);
  if (Number.isFinite(x) && Number.isFinite(y) && Math.abs(y) <= 90 && Math.abs(x) <= 180) return { latitude: y, longitude: x };
  for (const [k, v] of Object.entries(r)) {
    if (typeof v === 'string' && /geom/i.test(k)) {
      const p = pontoWkt(v);
      if (p.latitude !== undefined) return p;
    }
  }
  return {};
}

/** "POINT (-38.59606 -3.76439)" → { lat, long }. Ordem do WKT: long, lat. */
export function pontoWkt(wkt: string | undefined): { latitude?: number; longitude?: number } {
  const m = /POINT\s*\(\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s*\)/i.exec(wkt ?? '');
  if (!m) return {};
  return { longitude: Number(m[1]), latitude: Number(m[2]) };
}

const naoNegativo = (...xs: Array<number | undefined>): number => {
  for (const x of xs) if (typeof x === 'number' && Number.isFinite(x)) return Math.max(0, x);
  return 0;
};

/**
 * Normaliza uma caixa da planta. Os nomes dos campos variam entre versões da
 * API, e porta livre é a informação que decide ir ou não ir: vale tentar as
 * formas conhecidas antes de assumir zero.
 */
export function paraCaixa(c: GeositeCaixa): CaixaViabilidade {
  const splitterTotal = c.qtdPortasSplitter;
  const splitterOcup = c.qtdPortasSplitterOcup;
  const splitterLivre = naoNegativo(
    c.qtdPortasSplitterDisp,
    typeof splitterTotal === 'number' && typeof splitterOcup === 'number' ? splitterTotal - splitterOcup : undefined,
  );
  return {
    // "CTO: CTO - CYBER VIVO, 148" → "CTO - CYBER VIVO, 148".
    tipoCodigo: String(c.tipoCodigo ?? '').replace(/^\s*CTO:\s*/i, '').trim() || String(c.tipoCodigo ?? ''),
    distanciaMetros: naoNegativo(c.distancia),
    portasDisponiveis: naoNegativo(c.qtdTotalDisponivel, c.qtdDisponivel, splitterLivre),
    portasSplitterDisponiveis: splitterLivre,
    fid: c.fid,
    capacidadeSplitter: splitterTotal,
    clientes: c.qtdClientes,
    ...pontoWkt(c.geometryCaixaEmenda),
  };
}

// ─── Client ───────────────────────────────────────────────────────────────────

export class GeositeClient {
  private http: AxiosInstance;
  private tokenData: GeositeToken | null = null;

  constructor() {
    this.http = axios.create({
      baseURL: config.geosite.baseUrl,
      timeout: config.geosite.timeoutMs,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // ─── Auth ──────────────────────────────────────────────────────────────────

  private async getToken(): Promise<string | null> {
    // Token válido por 30 min — renova com 5 min de folga
    const now = Date.now();
    if (this.tokenData && this.tokenData.expiresAt > now) {
      return this.tokenData.token;
    }

    // Tenta refresh se tiver refresh token ainda válido
    if (this.tokenData) {
      try {
        const res = await this.http.post<{ token: string; refreshToken: string }>(
          '/auth/refresh',
          null,
          { headers: { Authorization: `Digicade-Rest-API:${this.tokenData.refreshToken}` } },
        );
        if (res.data?.token) {
          this.tokenData = {
            token: res.data.token,
            refreshToken: res.data.refreshToken ?? this.tokenData.refreshToken,
            expiresAt: now + 25 * 60 * 1000,
          };
          return this.tokenData.token;
        }
      } catch {
        // Refresh falhou — tenta login completo
      }
    }

    // Login inicial
    try {
      const res = await this.http.post<{ token: string; refreshToken: string }>(
        '/auth/generatetoken',
        { username: config.geosite.username, password: config.geosite.password },
      );
      if (!res.data?.token) return null;
      this.tokenData = {
        token: res.data.token,
        refreshToken: res.data.refreshToken,
        expiresAt: now + 25 * 60 * 1000,
      };
      return this.tokenData.token;
    } catch (err: any) {
      logger.error('GeoSite auth falhou', { err: err.message });
      return null;
    }
  }

  private async authHeaders(): Promise<Record<string, string>> {
    const token = await this.getToken();
    if (!token) return {};
    return { Authorization: `Digicade-Rest-API:${token}` };
  }

  // ─── Viabilidade ───────────────────────────────────────────────────────────

  // Processa as caixas retornadas pela API: todas as caixas vêm dentro do raio
  // configurado, portanto todas "cobrem" o endereço. Ordena da mais próxima para a
  // mais distante e seleciona a primeira que tem porta disponível — se a mais
  // próxima estiver lotada, cai para a próxima mais próxima que cobre, e assim por diante.
  private processarCaixas(data: unknown): Viabilidade {
    const caixas = extrairCaixas(data);
    if (!caixas.length) {
      logger.info('Geosite: Nenhuma CTO encontrada no raio configurado.');
      return { temCobertura: false, caixasProximas: 0 };
    }

    const cobrindo: CaixaViabilidade[] = [...caixas]
      .sort((a, b) => a.distancia - b.distancia)
      .map(paraCaixa);

    // Mais próxima que cobre E tem porta livre; se a mais próxima estiver lotada,
    // segue para a próxima mais próxima que cobre.
    const selecionada = cobrindo.find((c) => c.portasDisponiveis > 0);

    if (selecionada) {
      logger.info(`Geosite: CTO escolhida -> ${selecionada.tipoCodigo} a ${Math.round(selecionada.distanciaMetros)}m com ${selecionada.portasDisponiveis} portas livres (avaliadas ${cobrindo.length} CTOs no total)`);
    } else {
      logger.info(`Geosite: Foram encontradas ${cobrindo.length} CTOs, mas TODAS estavam sem portas livres! Passando para o Fallback (SGP).`);
    }

    return {
      temCobertura: !!selecionada,
      caixasProximas: cobrindo.length,
      totalDisponiveis: cobrindo.reduce((s, c) => s + c.portasDisponiveis, 0),
      distanciaMinMetros: selecionada?.distanciaMetros ?? cobrindo[0]?.distanciaMetros,
      portasSplitterDisponiveis: cobrindo.reduce((s, c) => s + c.portasSplitterDisponiveis, 0),
      caixaSelecionada: selecionada,
      caixasCobrindo: cobrindo,
    };
  }

  // Verifica cobertura FTTH por endereço (string livre, ex: "Rua X, 123, Bairro, Cidade")
  async viabilidadePorEndereco(endereco: string): Promise<Viabilidade> {
    if (!config.geosite.enabled) return { temCobertura: false };
    try {
      const headers = await this.authHeaders();
      const res = await this.http.get<GeositeCaixa[]>('/viabilidade/caixas', {
        headers,
        params: {
          raio: config.geosite.raioMetros,
          endereco,
        },
      });

      return this.processarCaixas(res.data);
    } catch (err: any) {
      logger.error('GeoSite viabilidade endereço erro', { err: err.message });
      return { temCobertura: false };
    }
  }

  // Atalho: monta string de endereço a partir de CEP e busca cobertura
  async viabilidadePorCep(cep: string): Promise<Viabilidade> {
    return this.viabilidadePorEndereco(cep.replace(/\D/g, ''));
  }

  // Verifica cobertura por coordenadas (lat/lon)
  async viabilidadePorCoordenadas(latitude: number, longitude: number): Promise<Viabilidade> {
    if (!config.geosite.enabled) return { temCobertura: false };
    try {
      const headers = await this.authHeaders();
      const res = await this.http.get<GeositeCaixa[]>('/viabilidade/caixas', {
        headers,
        params: {
          raio: config.geosite.raioMetros,
          latitude,
          longitude,
        },
      });

      return this.processarCaixas(res.data);
    } catch (err: any) {
      logger.error('GeoSite viabilidade coordenadas erro', { err: err.message });
      return { temCobertura: false };
    }
  }

  // ─── Consulta genérica da planta (somente leitura) ─────────────────────────
  //
  // A API expõe cada feição (caixaEmenda, cto, poste...) com /desc e /list.
  // Aqui só se usa LEITURA: save e delete existem na API e nunca são chamados.

  private colunasCache = new Map<string, { em: number; nomes: string[] }>();

  /** Colunas que a feição tem nesta instalação. Cache de 1 hora. */
  async colunas(feicao: string): Promise<string[]> {
    const c = this.colunasCache.get(feicao);
    if (c && Date.now() - c.em < 3_600_000) return c.nomes;
    const headers = await this.authHeaders();
    if (!headers.Authorization) throw new Error('GeoSite: login recusado ou indisponível');
    const res = await this.http.get(`/${feicao}/desc`, { headers });
    const nomes = extrairColunas(res.data);
    this.colunasCache.set(feicao, { em: Date.now(), nomes });
    return nomes;
  }

  /** Uma página de registros da feição. */
  async listar(feicao: string, p: { columns: string[]; filter?: string; limit?: number; start?: number; sorter?: string }):
    Promise<{ total: number | null; registros: Array<Record<string, unknown>> }> {
    const headers = await this.authHeaders();
    if (!headers.Authorization) throw new Error('GeoSite: login recusado ou indisponível');
    const res = await this.http.get(`/${feicao}/list`, {
      headers,
      params: {
        columns: p.columns.join(','),
        ...(p.filter ? { filter: p.filter } : {}),
        ...(p.sorter ? { sorter: p.sorter } : {}),
        limit: p.limit ?? 500,
        start: p.start ?? 0,
      },
    });
    return extrairRegistros(res.data);
  }

  /** Todas as páginas, até `maximo` registros. `completo` diz se coube tudo. */
  async listarTudo(feicao: string, p: { columns: string[]; filter?: string }, maximo = 5000):
    Promise<{ total: number | null; registros: Array<Record<string, unknown>>; completo: boolean }> {
    const todos: Array<Record<string, unknown>> = [];
    let total: number | null = null;
    const pagina = 500;
    for (let start = 0; start < maximo; start += pagina) {
      const r = await this.listar(feicao, { ...p, limit: pagina, start });
      total = r.total ?? total;
      todos.push(...r.registros);
      if (r.registros.length < pagina || (total !== null && todos.length >= total)) break;
    }
    return { total, registros: todos, completo: total === null ? todos.length < maximo : todos.length >= total };
  }

  /**
   * Feições perto de um endereço, ponto de referência ou coordenada, filtradas
   * por tipo (caixaEmenda, cto, estacao...). A planta geocodifica o endereço.
   */
  async facilidades(p: { endereco?: string; latitude?: number; longitude?: number; raio: number; tipos: string[] }):
    Promise<Array<Record<string, unknown>>> {
    const headers = await this.authHeaders();
    if (!headers.Authorization) throw new Error('GeoSite: login recusado ou indisponível');
    const params: Record<string, unknown> = { raio: p.raio };
    if (p.endereco) params.endereco = p.endereco;
    else { params.latitude = p.latitude; params.longitude = p.longitude; }
    for (const t of p.tipos) params[t] = 1;
    const res = await this.http.get('/viabilidade/facilidade', { headers, params });
    return extrairRegistros(res.data).registros;
  }

  // Verifica existência de cabo óptico próximo a coordenadas
  async existeLanceCabo(latitude: number, longitude: number, raioMetros = 100): Promise<boolean> {
    if (!config.geosite.enabled) return false;
    try {
      const headers = await this.authHeaders();
      const res = await this.http.post<{ success: boolean; existe_lance_cabo: boolean }>(
        '/rede/existe-lance-cabo',
        { latitude, longitude, raio_metros: raioMetros },
        { headers },
      );
      return res.data?.existe_lance_cabo === true;
    } catch {
      return false;
    }
  }
}

export const geosite = new GeositeClient();
