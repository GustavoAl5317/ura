// Cliente da WhatsApp Cloud API oficial (Meta / Graph API).
// Canal alternativo à Evolution — para números na plataforma Business.
// Envio de texto, download de mídia (áudio) e marcação de leitura.

import axios, { AxiosInstance, AxiosError } from 'axios';
import { config } from '../config';
import { logger } from '../logger';

export interface CloudSendResult {
  enviado: boolean;
  motivo?: string;
  messageId?: string;
}

export class WhatsAppCloudClient {
  private http: AxiosInstance | null = null;

  private get client(): AxiosInstance {
    if (!this.http) {
      this.http = axios.create({
        baseURL: `https://graph.facebook.com/${config.cloud.graphVersion}`,
        timeout: 20_000,
        headers: {
          Authorization: `Bearer ${config.cloud.token}`,
          'Content-Type': 'application/json',
        },
      });
    }
    return this.http;
  }

  get disponivel(): boolean {
    return !!config.cloud.token;
  }

  /** Só dígitos, com DDI 55 (Cloud API aceita E.164 sem +). */
  private normalize(phone: string): string {
    const d = phone.replace(/\D/g, '');
    if (d.length === 11 || d.length === 10) return `55${d}`;
    return d;
  }

  /** Envia texto por um phone_number_id específico. */
  async enviarTexto(phoneNumberId: string, para: string, texto: string): Promise<CloudSendResult> {
    if (!this.disponivel) {
      logger.error('Cloud API sem token (CLOUD_API_TOKEN)');
      return { enviado: false, motivo: 'nao_configurado' };
    }
    if (!phoneNumberId) return { enviado: false, motivo: 'sem_phone_number_id' };

    try {
      const res = await this.client.post(`/${phoneNumberId}/messages`, {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: this.normalize(para),
        type: 'text',
        text: { preview_url: true, body: texto },
      });
      const id = res.data?.messages?.[0]?.id as string | undefined;
      logger.info('Cloud API enviado', { phoneNumberId, para: this.normalize(para), messageId: id });
      return { enviado: true, messageId: id };
    } catch (err: unknown) {
      const ax = err as AxiosError;
      const body = JSON.stringify(ax.response?.data ?? '');
      logger.error('Cloud API erro ao enviar', {
        phoneNumberId,
        status: ax.response?.status,
        body: body.slice(0, 400),
      });
      // 131047/131051 = fora da janela de 24h (precisa de template) — motivo útil ao painel.
      const motivo = body.includes('131047') || body.includes('re-engage')
        ? 'fora_da_janela_24h'
        : 'falha_api';
      return { enviado: false, motivo };
    }
  }

  /** Marca a mensagem como lida (tique azul) — opcional, melhora a UX. */
  async marcarLido(phoneNumberId: string, messageId: string): Promise<void> {
    if (!this.disponivel || !messageId) return;
    try {
      await this.client.post(`/${phoneNumberId}/messages`, {
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: messageId,
      });
    } catch {
      /* leitura é best-effort */
    }
  }

  /**
   * Baixa uma mídia (áudio) por id: 1) resolve a URL temporária, 2) baixa os bytes.
   * Retorna base64 + mimetype para a transcrição.
   */
  async baixarMidia(mediaId: string): Promise<{ base64: string; mimetype?: string } | null> {
    if (!this.disponivel || !mediaId) return null;
    try {
      const meta = await this.client.get(`/${mediaId}`);
      const url = meta.data?.url as string | undefined;
      const mimetype = meta.data?.mime_type as string | undefined;
      if (!url) return null;

      // O download exige o mesmo Bearer, mas é num host de lookaside (fora do baseURL).
      const bin = await axios.get<ArrayBuffer>(url, {
        responseType: 'arraybuffer',
        timeout: 20_000,
        headers: { Authorization: `Bearer ${config.cloud.token}` },
      });
      return { base64: Buffer.from(bin.data).toString('base64'), mimetype };
    } catch (err: unknown) {
      const ax = err as AxiosError;
      logger.error('Cloud API erro ao baixar mídia', { mediaId, status: ax.response?.status });
      return null;
    }
  }
}

export const whatsappCloud = new WhatsAppCloudClient();
