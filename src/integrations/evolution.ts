// Cliente Evolution API bidirecional e multi-instância.
//
// Diferente de integrations/whatsapp.ts, que é só de SAÍDA e está no caminho
// quente da URA (não mexer nele por causa disto aqui). Este atende o assistente
// dos técnicos, que roda em outra instância / outro número, e precisa também
// RECEBER: webhook, download de áudio e envio de PTT.

import axios, { AxiosInstance, AxiosError } from 'axios';
import { logger } from '../logger';

export interface EvolutionCfg {
  apiUrl: string;
  instance: string;
  apiKey: string;
}

export type FormatoMensagem = 'texto' | 'audio' | 'outro';

export interface MensagemRecebida {
  /** ID da mensagem no WhatsApp — usado para baixar mídia e marcar como lida. */
  id: string;
  /** JID do remetente: 5585xxxxxxxxx@s.whatsapp.net ou 1203…@g.us */
  jid: string;
  /** Em grupo, o participante que falou; fora de grupo, igual a jid. */
  autorJid: string;
  nome: string | null;
  ehGrupo: boolean;
  formato: FormatoMensagem;
  texto: string | null;
  /** Só para formato 'audio': duração informada pelo WhatsApp. */
  duracaoSeg: number | null;
  at: string;
}

/** Normaliza para o JID que a Evolution aceita em `number`. */
export function paraJid(destino: string): string {
  const d = destino.trim();
  if (d.includes('@')) return d;
  const digitos = d.replace(/\D/g, '');
  if (!digitos) return d;
  const comPais = digitos.length === 10 || digitos.length === 11 ? `55${digitos}` : digitos;
  return `${comPais}@s.whatsapp.net`;
}

/** Só o número, sem sufixo de JID — algumas rotas da Evolution preferem assim. */
export function soNumero(jid: string): string {
  return jid.split('@')[0];
}

export class EvolutionClient {
  private http: AxiosInstance | null = null;

  constructor(private readonly cfg: EvolutionCfg, private readonly rotulo = 'evolution') {}

  get disponivel(): boolean {
    return !!(this.cfg.apiUrl && this.cfg.instance && this.cfg.apiKey);
  }

  private get client(): AxiosInstance {
    if (!this.http) {
      this.http = axios.create({
        baseURL: this.cfg.apiUrl,
        timeout: 30_000,
        maxBodyLength: 32 * 1024 * 1024,   // áudio em base64 estoura o default
        maxContentLength: 32 * 1024 * 1024,
        headers: { apikey: this.cfg.apiKey, 'Content-Type': 'application/json' },
      });
    }
    return this.http;
  }

  private falha(acao: string, err: unknown, extra: Record<string, unknown> = {}): void {
    const ax = err as AxiosError;
    logger.error(`${this.rotulo}: ${acao} falhou`, {
      ...extra,
      status: ax.response?.status,
      body: JSON.stringify(ax.response?.data ?? '').slice(0, 300),
      err: ax.message,
    });
  }

  // ─── Envio ─────────────────────────────────────────────────────────────────

  async enviarTexto(destino: string, texto: string): Promise<boolean> {
    if (!this.disponivel) {
      logger.error(`${this.rotulo}: não configurado`);
      return false;
    }
    const number = paraJid(destino);
    const path = `/message/sendText/${this.cfg.instance}`;

    try {
      await this.client.post(path, { number, text: texto });
      return true;
    } catch (err) {
      // Evolution varia por versão — tenta o formato clássico antes de desistir.
      const status = (err as AxiosError).response?.status;
      if (status === 400 || status === 422) {
        try {
          await this.client.post(path, { number, textMessage: { text: texto } });
          return true;
        } catch (err2) {
          this.falha('enviarTexto (clássico)', err2, { destino: number });
          return false;
        }
      }
      this.falha('enviarTexto', err, { destino: number });
      return false;
    }
  }

  /** Envia áudio como PTT (mensagem de voz). Espera OGG/Opus. */
  async enviarAudio(destino: string, ogg: Buffer): Promise<boolean> {
    if (!this.disponivel) return false;
    const number = paraJid(destino);
    const base64 = ogg.toString('base64');
    const path = `/message/sendWhatsAppAudio/${this.cfg.instance}`;

    try {
      await this.client.post(path, { number, audio: base64 });
      return true;
    } catch (err) {
      const status = (err as AxiosError).response?.status;
      if (status === 400 || status === 422) {
        try {
          await this.client.post(path, { number, audioMessage: { audio: base64 } });
          return true;
        } catch (err2) {
          this.falha('enviarAudio (clássico)', err2, { destino: number, kb: Math.round(ogg.length / 1024) });
          return false;
        }
      }
      this.falha('enviarAudio', err, { destino: number, kb: Math.round(ogg.length / 1024) });
      return false;
    }
  }

  /** "digitando…" / "gravando áudio…" — o técnico vê que a consulta começou. */
  async presenca(destino: string, estado: 'composing' | 'recording' | 'paused'): Promise<void> {
    if (!this.disponivel) return;
    try {
      await this.client.post(`/chat/sendPresence/${this.cfg.instance}`, {
        number: paraJid(destino),
        presence: estado,
        delay: 0,
      });
    } catch {
      // presença é cosmético — nunca deve derrubar a resposta
    }
  }

  async marcarLida(jid: string, messageId: string, fromMe = false): Promise<void> {
    if (!this.disponivel) return;
    try {
      await this.client.post(`/chat/markMessageAsRead/${this.cfg.instance}`, {
        readMessages: [{ remoteJid: jid, id: messageId, fromMe }],
      });
    } catch {
      // idem — cosmético
    }
  }

  /** Baixa o áudio de uma mensagem recebida. Devolve o buffer bruto (OGG/Opus). */
  async baixarMidia(messageId: string): Promise<Buffer | null> {
    if (!this.disponivel) return null;
    try {
      const res = await this.client.post<{ base64?: string }>(
        `/chat/getBase64FromMediaMessage/${this.cfg.instance}`,
        { message: { key: { id: messageId } }, convertToMp4: false },
      );
      const b64 = res.data?.base64;
      if (!b64) {
        logger.warn(`${this.rotulo}: mídia sem base64 na resposta`, { messageId });
        return null;
      }
      return Buffer.from(b64, 'base64');
    } catch (err) {
      this.falha('baixarMidia', err, { messageId });
      return null;
    }
  }

  /** Checa se a instância está conectada — alimenta o painel de integrações. */
  async estadoConexao(): Promise<{ ok: boolean; estado?: string; erro?: string }> {
    if (!this.disponivel) return { ok: false, erro: 'nao_configurado' };
    try {
      const res = await this.client.get<{ instance?: { state?: string } }>(
        `/instance/connectionState/${this.cfg.instance}`,
      );
      const estado = res.data?.instance?.state;
      return { ok: estado === 'open', estado };
    } catch (err) {
      const ax = err as AxiosError;
      return { ok: false, erro: ax.message };
    }
  }
}

// ─── Webhook ─────────────────────────────────────────────────────────────────

/** Forma (parcial) do payload messages.upsert da Evolution. */
interface WebhookBruto {
  event?: string;
  instance?: string;
  data?: {
    key?: { remoteJid?: string; fromMe?: boolean; id?: string; participant?: string };
    pushName?: string;
    messageType?: string;
    messageTimestamp?: number | string;
    message?: {
      conversation?: string;
      extendedTextMessage?: { text?: string };
      audioMessage?: { seconds?: number; ptt?: boolean };
      imageMessage?: { caption?: string };
      documentMessage?: { caption?: string };
    };
  };
}

/**
 * Extrai a mensagem do payload do webhook. Devolve null para tudo que o
 * assistente não deve processar: evento de outro tipo, mensagem própria,
 * status@broadcast ou formato não suportado.
 */
export function parseWebhook(body: unknown): MensagemRecebida | null {
  const b = body as WebhookBruto | undefined;
  if (!b || b.event !== 'messages.upsert') return null;

  const d = b.data;
  const jid = d?.key?.remoteJid;
  const id = d?.key?.id;
  if (!jid || !id) return null;

  // Eco da própria mensagem enviada pelo assistente — ignorar sempre,
  // sob pena de loop infinito de resposta.
  if (d?.key?.fromMe) return null;
  if (jid === 'status@broadcast') return null;

  const ehGrupo = jid.endsWith('@g.us');
  const autorJid = ehGrupo ? (d?.key?.participant ?? jid) : jid;

  const m = d?.message ?? {};
  let formato: FormatoMensagem = 'outro';
  let texto: string | null = null;
  let duracaoSeg: number | null = null;

  if (typeof m.conversation === 'string' && m.conversation.trim()) {
    formato = 'texto';
    texto = m.conversation.trim();
  } else if (typeof m.extendedTextMessage?.text === 'string' && m.extendedTextMessage.text.trim()) {
    formato = 'texto';
    texto = m.extendedTextMessage.text.trim();
  } else if (m.audioMessage) {
    formato = 'audio';
    duracaoSeg = m.audioMessage.seconds ?? null;
  } else if (m.imageMessage?.caption || m.documentMessage?.caption) {
    // Mídia com legenda: trata a legenda como texto; o arquivo em si é ignorado.
    formato = 'texto';
    texto = (m.imageMessage?.caption ?? m.documentMessage?.caption ?? '').trim() || null;
    if (!texto) formato = 'outro';
  }

  const ts = Number(d?.messageTimestamp ?? 0);
  return {
    id,
    jid,
    autorJid,
    nome: d?.pushName ?? null,
    ehGrupo,
    formato,
    texto,
    duracaoSeg,
    at: ts ? new Date(ts * 1000).toISOString() : new Date().toISOString(),
  };
}
