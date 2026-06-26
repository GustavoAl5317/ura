// Zabbix JSON-RPC API
// Docs: https://www.zabbix.com/documentation/current/en/manual/api

import axios, { AxiosInstance } from 'axios';
import { config } from '../config';
import { logger } from '../logger';

export type ZabbixEventoTipo = 'cto_off' | 'pop_off' | 'fibra' | 'energia' | 'pppoe_off' | 'outro';

export interface ZabbixIncidente {
  eventid: string;
  nome: string;
  severidade: number;
  host: string;
  hostVisivel: string;
  tipo: ZabbixEventoTipo;
  desde: string;
}

export interface ZabbixDiagnostico {
  temIncidente: boolean;
  /** Incidente confirmado na infraestrutura deste cliente (CTO/OLT/POP dele) */
  afetaCliente: boolean;
  incidentes: ZabbixIncidente[];
  resumo: string | null;
  tipoPrincipal: ZabbixEventoTipo | null;
  hostsConsultados: string[];
  semMapeamentoInfra?: boolean;
  erro?: string;
}

interface ZabbixProblem {
  eventid: string;
  name: string;
  severity: string;
  clock: string;
  hosts?: Array<{ hostid: string; host: string; name: string }>;
}

export class ZabbixClient {
  private http: AxiosInstance;
  private token: string | null = null;
  private tokenExpiresAt = 0;
  private requestId = 0;

  constructor() {
    const base = (config.zabbix.baseUrl || '').replace(/\/$/, '').replace(/\/zabbix\.php$/i, '');
    const apiUrl = base ? `${base}/api_jsonrpc.php` : '';
    this.http = axios.create({
      baseURL: apiUrl,
      timeout: config.zabbix.timeoutMs,
      headers: { 'Content-Type': 'application/json-rpc' },
    });
  }

  get apiUrl(): string {
    return this.http.defaults.baseURL ?? '';
  }

  private async call<T>(method: string, params: Record<string, unknown>, auth = true): Promise<T> {
    if (auth) await this.ensureAuth();

    const body: Record<string, unknown> = {
      jsonrpc: '2.0',
      method,
      params,
      id: ++this.requestId,
    };
    if (auth && this.token) body.auth = this.token;

    const res = await this.http.post<{
      result?: T;
      error?: { data?: string; message?: string; code?: number };
    }>('', body);

    if (res.data.error) {
      const msg = res.data.error.data ?? res.data.error.message ?? 'Zabbix API error';
      throw new Error(msg);
    }
    return res.data.result as T;
  }

  private async ensureAuth(): Promise<void> {
    const now = Date.now();
    if (this.token && this.tokenExpiresAt > now) return;

    const { username, password } = config.zabbix;
    let lastErr: Error | null = null;

    // Zabbix 6.4+ usa "username"; versões antigas usam "user"
    for (const params of [
      { username, password },
      { user: username, password },
    ]) {
      try {
        const result = await this.call<string>('user.login', params, false);
        if (!result) throw new Error('Zabbix login retornou token vazio');
        this.token = result;
        this.tokenExpiresAt = now + 25 * 60 * 1000;
        return;
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
        const msg = lastErr.message;
        if (!/unexpected parameter/i.test(msg)) break;
      }
    }

    throw lastErr ?? new Error('Zabbix login falhou');
  }

  /** Classifica alerta pelo nome/descrição do trigger. */
  static classificar(nome: string): ZabbixEventoTipo {
    if (/alerta:\s*cto\s*off|queda de clientes na cto/i.test(nome)) return 'cto_off';
    if (/queda da interface/i.test(nome)) return 'fibra';
    if (/pppoe|sess[oõ]es pppoe/i.test(nome) && /queda/i.test(nome)) return 'pppoe_off';
    if (/\bpop\b/i.test(nome) && /queda|off|down|indispon/i.test(nome)) return 'pop_off';
    if (/\bdse\b|energia|power|ups|bateria/i.test(nome)) return 'energia';
    return 'outro';
  }

  private static normalizarTexto(s: string): string {
    return s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  }

  /** Extrai nome da CTO entre aspas no alerta SGP SESSOES. */
  static extrairCtoDoAlerta(nome: string): string | null {
    const m = nome.match(/na CTO\s+"([^"]+)"/i)
      ?? nome.match(/CTO\s+"([^"]+)"/i);
    return m?.[1]?.trim() ?? null;
  }

  private static termoCoincide(termo: string, blob: string): boolean {
    const t = ZabbixClient.normalizarTexto(termo);
    const b = ZabbixClient.normalizarTexto(blob);
    if (t.length < 3) return false;
    if (b.includes(t) || t.includes(b)) return true;
    const palavras = t.split(' ').filter((w) => w.length >= 4);
    if (palavras.length >= 2) {
      const hits = palavras.filter((w) => b.includes(w)).length;
      if (hits >= Math.min(2, palavras.length)) return true;
    }
    return false;
  }

  private static labelTipo(tipo: ZabbixEventoTipo): string {
    switch (tipo) {
      case 'cto_off': return 'queda de CTO';
      case 'pppoe_off': return 'queda de sessões PPPoE';
      case 'pop_off': return 'queda de POP';
      case 'fibra': return 'rompimento/queda de interface';
      case 'energia': return 'falta de energia na infraestrutura';
      default: return 'incidente de rede';
    }
  }

  private static formatarData(epochSec: string): string {
    const ts = parseInt(epochSec, 10) * 1000;
    if (!ts) return '';
    return new Date(ts).toLocaleString('pt-BR', { timeZone: config.tz });
  }

  /** Busca problemas ativos cujo nome combina com algum padrão configurado. */
  async problemasPorPadroes(padroes: string[], hostFiltro?: string[]): Promise<ZabbixProblem[]> {
    if (!padroes.length) return [];

    const vistos = new Set<string>();
    const todos: ZabbixProblem[] = [];

    for (const padrao of padroes) {
      const params: Record<string, unknown> = {
        output: ['eventid', 'name', 'severity', 'clock'],
        selectHosts: ['hostid', 'host', 'name'],
        search: { name: padrao },
        searchWildcardsEnabled: true,
        suppressed: false,
        sortfield: 'clock',
        sortorder: 'DESC',
        limit: config.zabbix.problemLimit,
      };

      if (hostFiltro?.length) {
        const hostids = await this.hostIdsPorNomes(hostFiltro);
        if (hostids.length) params.hostids = hostids;
      }

      try {
        const batch = await this.call<ZabbixProblem[]>('problem.get', params);
        for (const p of batch ?? []) {
          if (!vistos.has(p.eventid)) {
            vistos.add(p.eventid);
            todos.push(p);
          }
        }
      } catch (err: any) {
        logger.warn('Zabbix problem.get falhou', { padrao, err: err.message });
      }
    }

    return todos.sort((a, b) => parseInt(b.clock, 10) - parseInt(a.clock, 10));
  }

  private async hostIdsPorNomes(nomes: string[]): Promise<string[]> {
    const ids = new Set<string>();
    for (const termo of nomes) {
      if (!termo.trim()) continue;
      try {
        const hosts = await this.call<Array<{ hostid: string }>>('host.get', {
          output: ['hostid'],
          search: { name: termo },
          searchWildcardsEnabled: true,
          limit: 20,
        });
        for (const h of hosts ?? []) ids.add(h.hostid);
      } catch {
        // ignora host não encontrado
      }
    }
    return [...ids];
  }

  /** Termo aparece no host ou no nome do alerta? */
  static incidenteAfetaTermos(incidente: ZabbixIncidente, termos: string[]): boolean {
    if (!termos.length) return false;
    const blob = `${incidente.host} ${incidente.hostVisivel} ${incidente.nome}`;
    const ctoNoAlerta = ZabbixClient.extrairCtoDoAlerta(incidente.nome);

    return termos.some((t) => {
      if (ZabbixClient.termoCoincide(t, blob)) return true;
      if (ctoNoAlerta && ZabbixClient.termoCoincide(t, ctoNoAlerta)) return true;
      return false;
    });
  }

  /** Diagnóstico restrito à infraestrutura do cliente — sem busca global. */
  async diagnosticar(termosCliente: string[]): Promise<ZabbixDiagnostico> {
    const hosts = [...new Set(termosCliente.map((h) => h.trim()).filter(Boolean))];
    const base: ZabbixDiagnostico = {
      temIncidente: false,
      afetaCliente: false,
      incidentes: [],
      resumo: null,
      tipoPrincipal: null,
      hostsConsultados: hosts,
    };

    if (!config.zabbix.enabled) return base;
    if (!config.zabbix.baseUrl || !config.zabbix.username) {
      return { ...base, erro: 'Zabbix não configurado (ZABBIX_URL / ZABBIX_USER)' };
    }

    if (!hosts.length) {
      return {
        ...base,
        semMapeamentoInfra: true,
      };
    }

    const padroes = config.zabbix.searchPatterns;

    let problemas: ZabbixProblem[];
    try {
      // Alertas SGP SESSOES ficam no host "SGP SESSOES" — CTO/OLT vêm no NOME do trigger
      problemas = await this.problemasPorPadroes(padroes);
    } catch (err: any) {
      logger.error('Zabbix diagnóstico falhou', { err: err.message });
      return { ...base, erro: err.message };
    }

    const incidentes: ZabbixIncidente[] = problemas.map((p) => {
      const host = p.hosts?.[0];
      const tipo = ZabbixClient.classificar(p.name);
      return {
        eventid: p.eventid,
        nome: p.name,
        severidade: parseInt(p.severity, 10) || 0,
        host: host?.host ?? '',
        hostVisivel: host?.name ?? host?.host ?? '',
        tipo,
        desde: ZabbixClient.formatarData(p.clock),
      };
    });

    const doCliente = incidentes.filter((i) => ZabbixClient.incidenteAfetaTermos(i, hosts));
    const relevantes = doCliente.filter((i) => i.tipo !== 'outro' || config.zabbix.includeOutros);
    const lista = relevantes.length ? relevantes : doCliente;
    const tipoPrincipal = lista[0]?.tipo ?? null;

    const resumo = lista.length
      ? lista
          .slice(0, 3)
          .map((i) => `${ZabbixClient.labelTipo(i.tipo)}: ${i.nome}${i.hostVisivel ? ` (${i.hostVisivel})` : ''}`)
          .join('; ')
      : null;

    return {
      temIncidente: lista.length > 0,
      afetaCliente: lista.length > 0,
      incidentes: lista,
      resumo,
      tipoPrincipal,
      hostsConsultados: hosts,
    };
  }
}

export const zabbix = new ZabbixClient();
