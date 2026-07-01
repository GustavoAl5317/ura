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

  /** Celular BR: DDD + 9 dígitos começando com 9 (WhatsApp não funciona em fixo). */
  isCelularBr(phone: string): boolean {
    const d = phone.replace(/\D/g, '');
    const local = d.startsWith('55') ? d.slice(2) : d;
    return local.length === 11 && local[2] === '9';
  }

  private get available(): boolean {
    return !!(config.whatsapp.apiUrl && config.whatsapp.instance && config.whatsapp.apiKey);
  }

  // Evolution API varia por versão. Tentamos formatos compatíveis sem trocar em erro 500
  // (500 costuma ser instância/desconexão — trocar o payload piora e mascara a causa).
  private async postSendText(number: string, text: string): Promise<void> {
    const path = `/message/sendText/${config.whatsapp.instance}`;
    const modern = { number, text };
    const classic = {
      number,
      textMessage: { text },
      options: { delay: 1000, presence: 'composing' as const },
    };

    try {
      await this.client.post(path, modern);
      return;
    } catch (errModern: any) {
      const status = errModern.response?.status;
      const body = JSON.stringify(errModern.response?.data ?? '');

      // 500 = erro interno/instância — retenta o mesmo formato uma vez
      if (status === 500) {
        logger.warn('WhatsApp: erro 500, retentando mesmo formato', { number });
        await new Promise((r) => setTimeout(r, 800));
        await this.client.post(path, modern);
        return;
      }

      // 400 por schema — tenta formato clássico só se não exigir "text" na raiz
      if ((status === 400 || status === 422) && !body.includes('requires property "text"')) {
        logger.info('WhatsApp: formato moderno falhou, tentando formato clássico', { status });
        await this.client.post(path, classic);
        return;
      }

      throw errModern;
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
  }): Promise<boolean> {
    const mensagem = this.montarMensagemAtendimento(params);
    return this.enviarTexto(para, mensagem);
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
      const formattedGrupo = grupoId.includes('@g.us') ? grupoId : `${grupoId}@g.us`;
      await this.postSendText(formattedGrupo, mensagem);
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
