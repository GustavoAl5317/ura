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

export interface Viabilidade {
  temCobertura: boolean;
  totalDisponiveis?: number;
  caixasProximas?: number;
  distanciaMinMetros?: number;
  portasSplitterDisponiveis?: number;
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

      const caixas = Array.isArray(res.data) ? res.data : [];
      const comPortas = caixas.filter((c) => c.qtdTotalDisponivel > 0);
      const temCobertura = comPortas.length > 0;
      const distanciaMin = caixas.length
        ? Math.min(...caixas.map((c) => c.distancia))
        : undefined;
      const totalPortas = comPortas.reduce((s, c) => s + c.qtdTotalDisponivel, 0);
      const splitterDisp = comPortas.reduce((s, c) => s + (c.qtdPortasSplitterDisp ?? 0), 0);

      return {
        temCobertura,
        totalDisponiveis: totalPortas,
        caixasProximas: caixas.length,
        distanciaMinMetros: distanciaMin,
        portasSplitterDisponiveis: splitterDisp,
      };
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

      const caixas = Array.isArray(res.data) ? res.data : [];
      const comPortas = caixas.filter((c) => c.qtdTotalDisponivel > 0);

      return {
        temCobertura: comPortas.length > 0,
        totalDisponiveis: comPortas.reduce((s, c) => s + c.qtdTotalDisponivel, 0),
        caixasProximas: caixas.length,
        distanciaMinMetros: caixas.length
          ? Math.min(...caixas.map((c) => c.distancia))
          : undefined,
        portasSplitterDisponiveis: comPortas.reduce(
          (s, c) => s + (c.qtdPortasSplitterDisp ?? 0),
          0,
        ),
      };
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
