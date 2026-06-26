// SGP.net.br API client
// Docs: https://documenter.getpostman.com/view/6682240/2sB34hHg2V
//
// Auth: todas as requisições enviam token + app no body (POST) ou query (GET)
// Base URL: SGP_BASE_URL  (ex: https://sys.aquitelecom.com)

import axios, { AxiosInstance } from 'axios';
import http from 'http';
import https from 'https';
import { config } from '../config';
import { logger } from '../logger';

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 12 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 12 });

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SgpOnu {
  id: number;
  serial: string;
  rx: string | null;      // dBm como string ex: "-20.500"
  tx: string | null;
  slot: number;
  pon: number;
  olt_id: number;
  olt_nome: string;
  cto_nome?: string;
  caixa?: string;
  conexao: {
    status: 'online' | 'offline' | string;
    ip: string;
    data_conexao: string;
    data_desconexao: string;
  } | null;
}

export interface SgpServico {
  id: number;
  tipo: string;
  plano: { id: number; descricao: string };
  login: string;
  onu?: SgpOnu;
}

export interface SgpContrato {
  contrato: number;       // contratoId — chave usada em quase todas as chamadas
  dataCadastro: string;
  status: string;
  motivo_status: string;
  servicos: SgpServico[];
  endereco?: {
    logradouro: string;
    numero: number;
    bairro: string;
    cidade: string;
    uf: string;
    cep: string;
    complemento?: string;
  };
}

export interface SgpTitulo {
  id: number;
  portador: string;
  numeroDocumento: number;
  contrato: number;
  status: 'aberto' | 'pago' | 'cancelado' | string;
  valor: number;
  valorCorrigido: number;
  valorPago: number | string;
  diasAtraso: number;
  codigoBarras: string;
  codigoPix: string;
  link?: string;                 // presente no endpoint /titulos/, ausente no /clientes/
  link_cobranca?: string;
  dataEmissao: string;
  dataVencimento: string;
  dataPagamento: string;
  dataCancelamento: string;
}

export interface SgpCliente {
  nome: string;
  cpfcnpj: string;
  telefones?: string[];
  endereco?: {
    logradouro: string;
    numero: number;
    bairro: string;
    cidade: string;
    uf: string;
    cep: string;
    complemento?: string;
  };
  contratos: SgpContrato[];
  titulos: SgpTitulo[];
  // conveniences preenchidos depois do parse:
  contratoId?: number;           // primeiro contrato ativo
  onuId?: number;                // ID da ONU do primeiro serviço
  clienteId?: number;            // preenchido via consultacliente se disponível
}

export interface SgpFatura2via {
  status: number;
  razaoSocial: string;
  protocolo: string;
  links: Array<{
    linhadigitavel: string;
    fatura: number;
    vencimento: string;
    link: string;
    valor: number;
    vencimento_original?: string;
    valor_original?: number;
  }>;
  link: string;   // link do boleto mais recente
}

export interface SgpChamado {
  status: number;
  protocolo: string;
  razaoSocial: string;
  msg: string;
  contratoId: number;
}

export interface SgpLiberacao {
  status: number;
  liberado: boolean;
  liberado_dias: number;
  protocolo: string;
  msg: string;
}

export interface SgpManutencao {
  id: number;
  descricao: string;
  data_inicial: string;
  data_final: string;
  mensagem_ura: string;
  ativa: number;         // 1 = ativa
  severidade: string;
  pops: Array<{ id: number; cidade: string; uf: string }>;
  olts: Array<{ id: number; nome: string }>;
  ctos: Array<{ id: number; nome: string }>;
}

export interface SgpPlano {
  id: number;
  descricao: string;
  preco: string;
  qtd_servicos: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function firstContrato(c: SgpCliente): SgpContrato | undefined {
  return c.contratos.find((ct) =>
    ct.status.toLowerCase().includes('ativo') || ct.status === '1',
  ) ?? c.contratos[0];
}

function extrairCtoDeOnu(raw: Record<string, unknown>): string | undefined {
  for (const key of [
    'cto_nome', 'cto', 'nome_cto', 'caixa', 'caixa_nome', 'splitter',
    'fttx_cto', 'tipo_codigo', 'descricao_cto', 'nome_caixa',
  ]) {
    const v = raw[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (v && typeof v === 'object' && 'nome' in v) {
      const n = (v as { nome?: string }).nome;
      if (typeof n === 'string' && n.trim()) return n.trim();
    }
  }
  return undefined;
}

function normalizarOnu(raw: SgpOnu): SgpOnu {
  const rec = raw as unknown as Record<string, unknown>;
  const cto = extrairCtoDeOnu(rec);
  return {
    ...raw,
    cto_nome: cto ?? raw.cto_nome,
    caixa: cto ?? raw.caixa,
  };
}

function firstOnu(c: SgpCliente): SgpOnu | undefined {
  const ct = firstContrato(c);
  const onu = ct?.servicos.find((s) => s.onu)?.onu;
  return onu ? normalizarOnu(onu) : undefined;
}

function enrich(c: SgpCliente): SgpCliente {
  if (c.contratos.length === 1) {
    c.contratoId = c.contratos[0].contrato;
    if (c.contratos[0].endereco) c.endereco = c.contratos[0].endereco;
  } else if (c.contratos.length > 1) {
    c.contratoId = undefined;
  } else {
    c.contratoId = firstContrato(c)?.contrato;
  }
  const onu = firstOnu(c);
  c.onuId = onu?.id;
  return c;
}

export function formatarEndereco(
  end?: SgpContrato['endereco'] | SgpCliente['endereco'],
): string | null {
  if (!end) return null;
  const parts = [
    end.logradouro,
    end.numero ? String(end.numero) : '',
    end.bairro,
    end.cidade && end.uf ? `${end.cidade}/${end.uf}` : end.cidade,
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

// ─── Client ───────────────────────────────────────────────────────────────────

export class SgpClient {
  private http: AxiosInstance;

  constructor() {
    this.http = axios.create({
      baseURL: config.sgp.baseUrl,
      timeout: config.sgp.timeoutMs,
      httpAgent,
      httpsAgent,
    });

    this.http.interceptors.response.use(
      (r) => r,
      (err) => {
        logger.error('SGP erro', {
          url: err.config?.url,
          status: err.response?.status,
          body: JSON.stringify(err.response?.data)?.slice(0, 200),
        });
        throw err;
      },
    );
  }

  // Autenticação via form fields (token + app)
  private auth(): Record<string, string> {
    return { token: config.sgp.token, app: config.sgp.app };
  }

  private formBody(extra: Record<string, unknown> = {}): URLSearchParams {
    const p = new URLSearchParams();
    p.append('token', config.sgp.token);
    p.append('app', config.sgp.app);
    for (const [k, v] of Object.entries(extra)) {
      if (v !== undefined && v !== null) p.append(k, String(v));
    }
    return p;
  }

  private async postForm<T>(path: string, data: Record<string, unknown> = {}): Promise<T | null> {
    try {
      const res = await this.http.post<T>(path, this.formBody(data));
      return res.data;
    } catch {
      return null;
    }
  }

  private async postJson<T>(path: string, body: Record<string, unknown>): Promise<T | null> {
    try {
      const res = await this.http.post<T>(path, { ...this.auth(), ...body });
      return res.data;
    } catch {
      return null;
    }
  }

  private async getParams<T>(path: string, params: Record<string, unknown> = {}): Promise<T | null> {
    try {
      const res = await this.http.get<T>(path, { params: { ...this.auth(), ...params } });
      return res.data;
    } catch {
      return null;
    }
  }

  // ─── Clientes ──────────────────────────────────────────────────────────────

  async buscarPorTelefone(telefone: string): Promise<SgpCliente | null> {
    const tel = telefone.replace(/\D/g, '');
    const r = await this.postForm<{ clientes?: SgpCliente[] }>('/api/ura/clientes/', {
      telefone: tel,
      exibir_conexao: config.sgp.exibirConexao ? 1 : 0,
      servicos_dados: 1,
    });
    const c = r?.clientes?.[0] ?? null;
    return c ? enrich(c) : null;
  }

  async buscarPorCpf(cpf: string): Promise<SgpCliente | null> {
    const c = cpf.replace(/\D/g, '');

    // consultacliente retorna clienteId e contratoId — útil para enriquecer o contexto
    const r = await this.postForm<{
      msg: string;
      contratos?: Array<{
        clienteId: number;
        contratoId: number;
        razaoSocial: string;
        cpfCnpj: string;
        telefones: string[];
        contratoStatusDisplay: string;
        motivo_status: string;
        planointernet: string;
        endereco_logradouro: string;
        endereco_numero: number;
        endereco_bairro: string;
        endereco_cidade: string;
        endereco_uf: string;
        endereco_cep: string;
        contratoValorAberto: number;
      }>;
    }>('/api/ura/consultacliente/', {
      cpfcnpj: c,
      servicos_dados: config.sgp.servicosDados ? 1 : 0,
    });

    const items = r?.contratos ?? [];
    if (!items.length) return null;

    const first = items[0];
    const contratos: SgpContrato[] = items.map((ct) => ({
      contrato: ct.contratoId,
      dataCadastro: '',
      status: ct.contratoStatusDisplay.trim(),
      motivo_status: ct.motivo_status,
      servicos: [{
        id: ct.contratoId,
        tipo: 'Internet',
        plano: { id: 0, descricao: ct.planointernet },
        login: '',
      }],
      endereco: {
        logradouro: ct.endereco_logradouro,
        numero: ct.endereco_numero,
        bairro: ct.endereco_bairro,
        cidade: ct.endereco_cidade,
        uf: ct.endereco_uf,
        cep: ct.endereco_cep,
      },
    }));

    const cliente: SgpCliente = {
      nome: first.razaoSocial,
      cpfcnpj: first.cpfCnpj,
      telefones: first.telefones ?? [],
      endereco: contratos[0].endereco,
      contratos,
      titulos: [],
      clienteId: first.clienteId,
      contratoId: items.length === 1 ? first.contratoId : undefined,
    };

    return cliente;
  }

  // ─── Financeiro ────────────────────────────────────────────────────────────

  async titulos(contratoId: number, status = 'abertos'): Promise<SgpTitulo[]> {
    const r = await this.postForm<{ titulos?: SgpTitulo[] }>('/api/ura/titulos/', {
      contrato: contratoId,
      status,
      ordenar: 'data_vencimento',
      ordenar_ordem: 'desc',
    });
    return r?.titulos ?? [];
  }

  async fatura2via(contratoId: number, faturaId?: number): Promise<SgpFatura2via | null> {
    const body: Record<string, string | number> = {
      contrato: contratoId,
      nao_gerar_os: 1,
    };
    if (faturaId) {
      body.fatura = faturaId;
    } else {
      body.faturas_abertas_todas = 1;
    }
    return this.postForm<SgpFatura2via>('/api/ura/fatura2via/', body);
  }

  async gerarPix(faturaId: number, contratoId: number): Promise<string | null> {
    // Tenta via endpoint específico de PIX
    const r = await this.postForm<{ codigoPix?: string; pix?: string; codigo?: string }>(
      `/api/ura/pagamento/pix/${faturaId}`,
      { contrato: contratoId },
    );
    return r?.codigoPix ?? r?.pix ?? r?.codigo ?? null;
  }

  async desbloquearConfianca(contratoId: number): Promise<SgpLiberacao | null> {
    return this.postForm<SgpLiberacao>('/api/ura/liberacaopromessa/', {
      contrato: contratoId,
      enviar_sms: 1,
    });
  }

  // ─── ONU / FTTH ────────────────────────────────────────────────────────────

  // Busca status da ONU via endpoint de cliente (mais completo para a URA)
  async onuDoContrato(contratoId: number, opts?: { fullFttx?: boolean }): Promise<SgpOnu | null> {
    const full = opts?.fullFttx === true;
    const r = await this.postForm<{ clientes?: SgpCliente[] }>('/api/ura/clientes/', {
      contrato: contratoId,
      exibir_conexao: full || config.sgp.exibirConexao ? 1 : 0,
      servicos_dados: full || config.sgp.servicosDados ? 1 : 0,
    });
    const cliente = r?.clientes?.[0];
    if (!cliente) return null;
    return firstOnu(enrich(cliente)) ?? null;
  }

  async resetarOnu(onuId: number): Promise<boolean> {
    // GET /api/fttx/onu/{id_onu}/reset/ — autenticação via query params
    const r = await this.getParams<{ success?: boolean; msg?: string; status?: number }>(
      `/api/fttx/onu/${onuId}/reset/`,
    );
    // SGP retorna status 1 ou success true em caso de sucesso
    return r?.success === true || r?.status === 1;
  }

  // ─── Chamados ──────────────────────────────────────────────────────────────

  async abrirChamado(params: {
    contratoId: number;
    ocorrenciaTipo: number;
    classificacoes: number[];
    conteudo?: string;
  }): Promise<SgpChamado | null> {
    // Este endpoint usa JSON body (não form-data)
    return this.postJson<SgpChamado>('/api/ura/chamado/', {
      contrato: params.contratoId,
      ocorrenciatipo: params.ocorrenciaTipo,
      tipoclassificacoes: params.classificacoes,
      ...(params.conteudo ? { conteudo: params.conteudo } : {}),
    });
  }

  // ─── Manutenção / Massiva ──────────────────────────────────────────────────

  async manutencoesAtivas(): Promise<SgpManutencao[]> {
    const r = await this.getParams<SgpManutencao[]>('/api/ura/manutencao/list/');
    if (!Array.isArray(r)) return [];
    return r.filter((m) => m.ativa === 1);
  }

  // ─── Viabilidade ───────────────────────────────────────────────────────────

  async viabilidade(params: {
    cep?: string;
    logradouro?: string;
    numero_inicial?: string;
    numero_final?: string;
    bairro?: string;
    cidade?: string;
  }): Promise<boolean> {
    // Pelo menos cep ou (logradouro + bairro + cidade) deve ser informado
    const r = await this.postForm<{ viabilidade?: boolean }>('/api/ura/viabilidade/', {
      ...(params.cep ? { cep: params.cep.replace(/\D/g, '') } : {}),
      ...(params.logradouro ? { logradouro: params.logradouro } : {}),
      ...(params.numero_inicial ? { numero_inicial: params.numero_inicial } : {}),
      ...(params.numero_final ? { numero_final: params.numero_final } : {}),
      ...(params.bairro ? { bairro: params.bairro } : {}),
      ...(params.cidade ? { cidade: params.cidade } : {}),
    });
    return r?.viabilidade === true;
  }

  // ─── Planos ────────────────────────────────────────────────────────────────

  async planos(): Promise<SgpPlano[]> {
    const r = await this.getParams<{ planos?: SgpPlano[] }>('/api/ura/consultaplano/');
    return r?.planos ?? [];
  }

  // ─── Anotações ─────────────────────────────────────────────────────────────

  async adicionarAnotacao(params: {
    clienteId: number;
    contratoId?: number;
    anotacao: string;
  }): Promise<boolean> {
    const r = await this.postForm('/api/ura/cliente/anotacao/add', {
      cliente_id: params.clienteId,
      ...(params.contratoId ? { contrato_id: params.contratoId } : {}),
      anotacao: params.anotacao,
    });
    return r !== null;
  }
}

export const sgp = new SgpClient();
