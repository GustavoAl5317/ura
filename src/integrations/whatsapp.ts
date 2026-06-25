import axios, { AxiosInstance } from 'axios';
import { config } from '../config';
import { logger } from '../logger';

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

  private get available(): boolean {
    return !!(config.whatsapp.apiUrl && config.whatsapp.instance && config.whatsapp.apiKey);
  }

  // Envia texto tentando o formato da Evolution v2 ({ number, text }) e, se a API
  // responder 400/500 (comum por incompatibilidade de versão), tenta o formato
  // legado da v1 ({ number, textMessage: { text } }).
  private async postSendText(number: string, text: string): Promise<void> {
    const path = `/message/sendText/${config.whatsapp.instance}`;
    try {
      await this.client.post(path, { number, text });
    } catch (errV2: any) {
      const status = errV2.response?.status;
      if (status === 400 || status === 500) {
        logger.info('WhatsApp: formato v2 falhou, tentando formato legado v1', { status });
        await this.client.post(path, {
          number,
          options: { delay: 1000, presence: 'composing' },
          textMessage: { text },
        });
        return;
      }
      throw errV2;
    }
  }

  async enviarTexto(para: string, mensagem: string): Promise<boolean> {
    if (!this.available) {
      logger.error('WhatsApp não configurado', {
        temApiUrl: !!config.whatsapp.apiUrl,
        temInstance: !!config.whatsapp.instance,
        temApiKey: !!config.whatsapp.apiKey,
      });
      return false;
    }
    const numero = this.normalize(para);
    try {
      await this.postSendText(numero, mensagem);
      logger.info('WhatsApp enviado', { para: numero });
      return true;
    } catch (err: any) {
      logger.error('WhatsApp erro', {
        para: numero,
        url: `${config.whatsapp.apiUrl}/message/sendText/${config.whatsapp.instance}`,
        status: err.response?.status,
        body: JSON.stringify(err.response?.data)?.slice(0, 300),
        err: err.message,
      });
      return false;
    }
  }

  async enviarBoleto(para: string, params: {
    clienteNome: string;
    valor: number;
    vencimento: string;
    linkBoleto?: string;
    codigoBarras?: string;
    pixCopiaCola?: string;
  }): Promise<boolean> {
    const primeiroNome = params.clienteNome.split(' ')[0];
    const valor = params.valor.toFixed(2).replace('.', ',');
    const linhas = [
      `Olá, ${primeiroNome}! 😊`,
      ``,
      `📄 *Segunda Via de Fatura*`,
      `💰 Valor: R$ ${valor}`,
      `📅 Vencimento: ${params.vencimento}`,
    ];

    if (params.pixCopiaCola) {
      linhas.push(``, `⚡ *PIX Copia e Cola:*`, `\`${params.pixCopiaCola}\``);
    }
    if (params.linkBoleto) {
      linhas.push(``, `🔗 Boleto: ${params.linkBoleto}`);
    }
    if (params.codigoBarras) {
      linhas.push(``, `📋 Código de barras:`, params.codigoBarras);
    }
    linhas.push(``, `_${config.company.name} — sempre conectando você! 🚀_`);

    return this.enviarTexto(para, linhas.join('\n'));
  }

  async enviarGrupo(grupoId: string, mensagem: string): Promise<boolean> {
    if (!this.available) {
      logger.error('WhatsApp não configurado (grupo)', {
        temApiUrl: !!config.whatsapp.apiUrl,
        temInstance: !!config.whatsapp.instance,
        temApiKey: !!config.whatsapp.apiKey,
      });
      return false;
    }
    try {
      await this.postSendText(grupoId, mensagem);
      return true;
    } catch (err: any) {
      logger.error('WhatsApp grupo erro', {
        grupoId,
        status: err.response?.status,
        body: JSON.stringify(err.response?.data)?.slice(0, 300),
        err: err.message,
      });
      return false;
    }
  }
}

export const whatsapp = new WhatsAppClient();
