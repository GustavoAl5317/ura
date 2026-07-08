import axios, { AxiosInstance, AxiosError, AxiosResponse } from 'axios';
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
  messageId?: string;
  remoteJid?: string;
}

export class WhatsAppClient {
  private http: AxiosInstance | null = null;

  private get client(): AxiosInstance {
    if (!this.http) {
      this.http = axios.create({
        baseURL: config.whatsapp.apiUrl,
        timeout: 15_000,
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

  private extractSendMeta(data: unknown): { ok: boolean; messageId?: string; remoteJid?: string; status?: string } {
    if (!data || typeof data !== 'object') return { ok: false };
    const row = data as Record<string, unknown>;
    if (row.success === false || row.error) return { ok: false, status: String(row.status ?? 'error') };

    const key = row.key as Record<string, unknown> | undefined;
    const messageId = typeof key?.id === 'string' ? key.id : undefined;
    const remoteJid = typeof key?.remoteJid === 'string' ? key.remoteJid : undefined;
    const status = typeof row.status === 'string' ? row.status : undefined;

    if (messageId || remoteJid || row.message) {
      return { ok: true, messageId, remoteJid, status };
    }
    return { ok: false, status };
  }

  /** Verifica se o número tem WhatsApp (Evolution API). null = não foi possível verificar. */
  private async verificarNumeroWhatsApp(number: string): Promise<boolean | null> {
    try {
      const res = await this.client.post(
        `/chat/whatsappNumbers/${config.whatsapp.instance}`,
        { numbers: [number] },
      );
      const rows = Array.isArray(res.data) ? res.data : [];
      if (!rows.length) return null;
      return rows.some((r: { exists?: boolean }) => r.exists === true);
    } catch (err: unknown) {
      const ax = err as AxiosError;
      logger.warn('WhatsApp: verificação de número indisponível', {
        number,
        status: ax.response?.status,
        err: ax.message,
      });
      return null;
    }
  }

  // Evolution API varia por versão — tenta formato moderno e clássico.
  private async postSendText(number: string, text: string): Promise<AxiosResponse> {
    const path = `/message/sendText/${config.whatsapp.instance}`;
    const modern = { number, text };
    const classic = {
      number,
      textMessage: { text },
      options: { delay: 1000, presence: 'composing' as const },
    };

    try {
      return await this.client.post(path, modern);
    } catch (errModern: unknown) {
      const ax = errModern as AxiosError;
      const status = ax.response?.status;
      const body = JSON.stringify(ax.response?.data ?? '');

      if (status === 500) {
        logger.warn('WhatsApp: erro 500, retentando', { number });
        await new Promise((r) => setTimeout(r, 800));
        return await this.client.post(path, modern);
      }

      if ((status === 400 || status === 422) && !body.includes('requires property "text"')) {
        logger.info('WhatsApp: formato moderno falhou, tentando clássico', { number, status });
        return await this.client.post(path, classic);
      }

      throw errModern;
    }
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
    const existe = await this.verificarNumeroWhatsApp(numero);
    if (existe === false) {
      logger.warn('WhatsApp: número sem conta WhatsApp', { para: numero });
      return { enviado: false, motivo: 'numero_sem_whatsapp' };
    }

    try {
      const res = await this.postSendText(numero, mensagem);
      const meta = this.extractSendMeta(res.data);
      if (!meta.ok) {
        logger.error('WhatsApp: API respondeu sem confirmação de mensagem', {
          para: numero,
          statusHttp: res.status,
          body: JSON.stringify(res.data ?? '').slice(0, 400),
        });
        return { enviado: false, motivo: 'falha_api' };
      }

      logger.info('WhatsApp enviado', {
        para: numero,
        chars: mensagem.length,
        messageId: meta.messageId,
        remoteJid: meta.remoteJid,
        status: meta.status,
      });
      return { enviado: true, messageId: meta.messageId, remoteJid: meta.remoteJid };
    } catch (err: unknown) {
      const { motivo, status, body } = this.parseSendError(err);
      const ax = err as AxiosError;
      logger.error('WhatsApp erro', {
        para: numero,
        motivo,
        url: `${config.whatsapp.apiUrl}/message/sendText/${config.whatsapp.instance}`,
        status,
        body: body.slice(0, 400),
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
      const res = await this.postSendText(formattedGrupo, mensagem);
      const meta = this.extractSendMeta(res.data);
      if (!meta.ok) {
        return { enviado: false, motivo: 'falha_api' };
      }
      return { enviado: true, messageId: meta.messageId, remoteJid: meta.remoteJid };
    } catch (err: unknown) {
      const { motivo, status, body } = this.parseSendError(err);
      const ax = err as AxiosError;
      logger.error('WhatsApp grupo erro', {
        grupoId,
        motivo,
        status,
        body: body.slice(0, 400),
        err: ax.message,
      });
      return { enviado: false, motivo };
    }
  }
}

export const whatsapp = new WhatsAppClient();
