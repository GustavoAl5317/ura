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
    const caixas = Array.isArray(data) ? (data as GeositeCaixa[]) : [];
    if (!caixas.length) {
      return { temCobertura: false, caixasProximas: 0 };
    }

    const cobrindo: CaixaViabilidade[] = [...caixas]
      .sort((a, b) => a.distancia - b.distancia)
      .map((c) => ({
        tipoCodigo: c.tipoCodigo,
        distanciaMetros: c.distancia,
        portasDisponiveis: c.qtdTotalDisponivel,
        portasSplitterDisponiveis: c.qtdPortasSplitterDisp ?? 0,
        fid: c.fid,
      }));

    // Mais próxima que cobre E tem porta livre; se a mais próxima estiver lotada,
    // segue para a próxima mais próxima que cobre.
    const selecionada = cobrindo.find((c) => c.portasDisponiveis > 0);

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
