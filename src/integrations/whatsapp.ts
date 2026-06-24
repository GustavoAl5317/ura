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

  async enviarTexto(para: string, mensagem: string): Promise<boolean> {
    if (!this.available) return false;
    try {
      await this.client.post(
        `/message/sendText/${config.whatsapp.instance}`,
        { number: this.normalize(para), text: mensagem },
      );
      logger.info('WhatsApp enviado', { para });
      return true;
    } catch (err: any) {
      logger.error('WhatsApp erro', { err: err.message });
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
    if (!this.available) return false;
    try {
      await this.client.post(
        `/message/sendText/${config.whatsapp.instance}`,
        { number: grupoId, text: mensagem },
      );
      return true;
    } catch (err: any) {
      logger.error('WhatsApp grupo erro', { err: err.message });
      return false;
    }
  }
}

export const whatsapp = new WhatsAppClient();
