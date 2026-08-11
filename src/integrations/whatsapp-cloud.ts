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

/** Arquivo enviado pela atendente no painel. */
export interface ArquivoEnvio {
  nome: string;
  mimetype: string;
  buffer: Buffer;
  legenda?: string;
}

/** Categoria da mídia na Cloud API — define o campo do payload. */
export type TipoMidia = 'image' | 'video' | 'audio' | 'document';

export function tipoDaMidia(mimetype: string): TipoMidia {
  if (mimetype.startsWith('image/')) return 'image';
  if (mimetype.startsWith('video/')) return 'video';
  if (mimetype.startsWith('audio/')) return 'audio';
  return 'document';
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

  /**
   * Envia um arquivo: 1) sobe os bytes para /media, 2) manda a mensagem pelo id
   * retornado. Imagem/vídeo aceitam legenda; documento leva legenda e nome.
   */
  async enviarMidia(phoneNumberId: string, para: string, arq: ArquivoEnvio): Promise<CloudSendResult> {
    if (!this.disponivel) {
      logger.error('Cloud API sem token (CLOUD_API_TOKEN)');
      return { enviado: false, motivo: 'nao_configurado' };
    }
    if (!phoneNumberId) return { enviado: false, motivo: 'sem_phone_number_id' };

    const tipo = tipoDaMidia(arq.mimetype);

    let mediaId: string;
    try {
      const form = new FormData();
      form.append('messaging_product', 'whatsapp');
      form.append('type', arq.mimetype);
      form.append('file', new Blob([new Uint8Array(arq.buffer)], { type: arq.mimetype }), arq.nome);

      // Content-Type é definido pelo FormData (precisa do boundary) — sobrescreve o padrão JSON.
      const up = await this.client.post(`/${phoneNumberId}/media`, form, {
        headers: { 'Content-Type': undefined },
        maxBodyLength: Infinity,
      });
      const id = up.data?.id as string | undefined;
      if (!id) return { enviado: false, motivo: 'upload_sem_id' };
      mediaId = id;
    } catch (err: unknown) {
      const ax = err as AxiosError;
      const body = JSON.stringify(ax.response?.data ?? '');
      logger.error('Cloud API erro no upload de mídia', {
        phoneNumberId,
        nome: arq.nome,
        status: ax.response?.status,
        body: body.slice(0, 400),
      });
      return { enviado: false, motivo: 'falha_upload' };
    }

    const conteudo: Record<string, unknown> = { id: mediaId };
    if (tipo === 'document') conteudo.filename = arq.nome;
    // Áudio é o único que a Meta não aceita legenda.
    if (arq.legenda && tipo !== 'audio') conteudo.caption = arq.legenda;

    try {
      const res = await this.client.post(`/${phoneNumberId}/messages`, {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: this.normalize(para),
        type: tipo,
        [tipo]: conteudo,
      });
      const messageId = res.data?.messages?.[0]?.id as string | undefined;
      logger.info('Cloud API mídia enviada', { phoneNumberId, tipo, nome: arq.nome, messageId });
      return { enviado: true, messageId };
    } catch (err: unknown) {
      const ax = err as AxiosError;
      const body = JSON.stringify(ax.response?.data ?? '');
      logger.error('Cloud API erro ao enviar mídia', {
        phoneNumberId,
        tipo,
        status: ax.response?.status,
        body: body.slice(0, 400),
      });
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
