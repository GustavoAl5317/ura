import axios, { AxiosInstance, AxiosError } from 'axios';
import { config } from '../config';
import { logger } from '../logger';

export type WhatsappMotivo =
  | 'nao_configurado'
  | 'numero_sem_whatsapp'
  | 'falha_api'
  | 'erro_rede';

export interface WhatsappSendResult {
  enviado: boolean;
  motivo?: WhatsappMotivo;
}

export class WhatsAppClient {
  private http: AxiosInstance | null = null;

  private get client(): AxiosInstance {
    if (!this.http) {
      this.http = axios.create({
        baseURL: config.whatsapp.apiUrl,
        timeout: 10_000,
        headers: {
          apikey: config.whatsapp.apiKey,
          'Content-Type': 'application/json',
        },
      });
    }
    return this.http;
  }

  private normalize(phone: string): string {
    const d = phone.replace(/\D/g, '');
    if (d.length === 11 || d.length === 10) return `55${d}`;
    return d;
  }

  /** Celular BR: DDD + 9 dígitos começando com 9 (WhatsApp não funciona em fixo). */
  isCelularBr(phone: string): boolean {
    const d = phone.replace(/\D/g, '');
    const local = d.startsWith('55') ? d.slice(2) : d;
    return local.length === 11 && local[2] === '9';
  }

  private get available(): boolean {
    return !!(config.whatsapp.apiUrl && config.whatsapp.instance && config.whatsapp.apiKey);
  }

  private parseSendError(err: unknown): { motivo: WhatsappMotivo; status?: number; body: string } {
    const ax = err as AxiosError;
    const status = ax.response?.status;
    const body = JSON.stringify(ax.response?.data ?? '');
    if (body.includes('"exists":false') || body.includes('exists":false')) {
      return { motivo: 'numero_sem_whatsapp', status, body };
    }
    if (status && status >= 400 && status < 500) {
      return { motivo: 'falha_api', status, body };
    }
    return { motivo: 'erro_rede', status, body };
  }

  private async postSendText(number: string, text: string): Promise<void> {
    const path = `/message/sendText/${config.whatsapp.instance}`;
    await this.client.post(path, { number, text });
  }

  async enviarTexto(para: string, mensagem: string): Promise<WhatsappSendResult> {
    if (!this.available) {
      logger.error('WhatsApp não configurado', {
        temApiUrl: !!config.whatsapp.apiUrl,
        temInstance: !!config.whatsapp.instance,
        temApiKey: !!config.whatsapp.apiKey,
      });
      return { enviado: false, motivo: 'nao_configurado' };
    }
    const numero = this.normalize(para);
    try {
      await this.postSendText(numero, mensagem);
      logger.info('WhatsApp enviado', { para: numero });
      return { enviado: true };
    } catch (err: unknown) {
      const { motivo, status, body } = this.parseSendError(err);
      const ax = err as AxiosError;
      logger.error('WhatsApp erro', {
        para: numero,
        motivo,
        url: `${config.whatsapp.apiUrl}/message/sendText/${config.whatsapp.instance}`,
        status,
        body: body.slice(0, 300),
        err: ax.message,
      });
      return { enviado: false, motivo };
    }
  }

  montarMensagemAtendimento(params: {
    clienteNome: string;
    resumoAtendimento: string;
    respostaCliente: string;
    protocolos?: string[];
    fatura?: {
      valor: string;
      vencimento: string;
      pixCopiaCola?: string | null;
      linkBoleto?: string | null;
      linhaDigitavel?: string | null;
    };
  }): string {
    const primeiroNome = params.clienteNome.split(' ')[0];
    const linhas = [
      `Olá, ${primeiroNome}! 😊`,
      ``,
      `📋 *Resumo do atendimento*`,
      params.resumoAtendimento.trim(),
      ``,
      `💬 *Sobre o que você nos procurou*`,
      params.respostaCliente.trim(),
    ];

    if (params.protocolos?.length) {
      linhas.push(``, `🔢 *Protocolo(s)*`);
      for (const proto of params.protocolos) {
        linhas.push(`• ${proto}`);
      }
    }

    if (params.fatura) {
      linhas.push(``, `📄 *Fatura*`);
      linhas.push(`💰 Valor: ${params.fatura.valor}`);
      linhas.push(`📅 Vencimento: ${params.fatura.vencimento}`);
      if (params.fatura.pixCopiaCola) {
        linhas.push(``, `⚡ *PIX Copia e Cola:*`, params.fatura.pixCopiaCola);
      }
      if (params.fatura.linkBoleto) {
        linhas.push(``, `🔗 Boleto: ${params.fatura.linkBoleto}`);
      }
      if (params.fatura.linhaDigitavel) {
        linhas.push(``, `📋 Linha digitável:`, params.fatura.linhaDigitavel);
      }
    }

    linhas.push(``, `_${config.company.name} — sempre conectando você! 🚀_`);
    return linhas.join('\n');
  }

  async enviarResumoAtendimento(para: string, params: {
    clienteNome: string;
    resumoAtendimento: string;
    respostaCliente: string;
    protocolos?: string[];
    fatura?: {
      valor: string;
      vencimento: string;
      pixCopiaCola?: string | null;
      linkBoleto?: string | null;
      linhaDigitavel?: string | null;
    };
  }): Promise<WhatsappSendResult> {
    const mensagem = this.montarMensagemAtendimento(params);
    return this.enviarTexto(para, mensagem);
  }

  async enviarGrupo(grupoId: string, mensagem: string): Promise<WhatsappSendResult> {
    if (!this.available) {
      logger.error('WhatsApp não configurado (grupo)', {
        temApiUrl: !!config.whatsapp.apiUrl,
        temInstance: !!config.whatsapp.instance,
        temApiKey: !!config.whatsapp.apiKey,
      });
      return { enviado: false, motivo: 'nao_configurado' };
    }
    try {
      const formattedGrupo = grupoId.includes('@g.us') ? grupoId : `${grupoId}@g.us`;
      await this.postSendText(formattedGrupo, mensagem);
      return { enviado: true };
    } catch (err: unknown) {
      const { motivo, status, body } = this.parseSendError(err);
      const ax = err as AxiosError;
      logger.error('WhatsApp grupo erro', {
        grupoId,
        motivo,
        status,
        body: body.slice(0, 300),
        err: ax.message,
      });
      return { enviado: false, motivo };
    }
  }
}

export const whatsapp = new WhatsAppClient();
