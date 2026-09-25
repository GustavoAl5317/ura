// Webhook da WhatsApp Cloud API oficial (Meta). Formato Graph:
//   GET  /cloud/webhook  → verificação (hub.challenge)
//   POST /cloud/webhook  → mensagens (entry[].changes[].value.messages[])
// Reaproveita o mesmo ChatSessionStore/IA — muda só o transporte (Cloud API).

import http from 'http';
import crypto from 'crypto';
import { config } from '../config';
import { logger } from '../logger';
import { whatsappCloud } from '../integrations/whatsapp-cloud';
import { transcreverAudio } from './audio';
import { salvarArquivo } from './arquivos';
import type { ChatSessionStore, EnviarTexto, EnviarAudio, PanelEvent } from './session';

/** Transporte de envio pela Cloud API, amarrado a um phone_number_id. */
export function senderCloud(phoneNumberId: string): EnviarTexto {
  return (numero, texto) => whatsappCloud.enviarTexto(phoneNumberId, numero, texto);
}

/** Transporte de voz: manda o OGG/Opus como mensagem de áudio. */
export function senderAudioCloud(phoneNumberId: string): EnviarAudio {
  return (numero, ogg) => whatsappCloud.enviarMidia(phoneNumberId, numero, {
    nome: 'resposta.ogg',
    mimetype: 'audio/ogg',
    buffer: ogg,
  });
}

/** No restore do banco: instância numérica (phone_number_id) → transporte Cloud. */
export function resolveEnviarCloud(instancia?: string): EnviarTexto | undefined {
  if (!config.cloud.enabled || !instancia) return undefined;
  const ehCloud = /^\d{10,}$/.test(instancia) || config.cloud.allowedPhoneIds.includes(instancia);
  return ehCloud ? senderCloud(instancia) : undefined;
}

/** GET de verificação exigido pela Meta ao cadastrar o webhook. */
export function verificarWebhookCloud(url: URL, res: http.ServerResponse): void {
  const mode = url.searchParams.get('hub.mode');
  const token = url.searchParams.get('hub.verify_token');
  const challenge = url.searchParams.get('hub.challenge');
  if (mode === 'subscribe' && token && token === config.cloud.verifyToken && challenge) {
    logger.info('[cloud] webhook verificado pela Meta');
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(challenge);
    return;
  }
  logger.warn('[cloud] verificação de webhook recusada');
  res.writeHead(403);
  res.end('forbidden');
}

/** Valida a assinatura X-Hub-Signature-256 (se CLOUD_APP_SECRET estiver definido). */
export function assinaturaValida(rawBody: string, header?: string | string[]): boolean {
  if (!config.cloud.appSecret) return true;             // sem secret configurado → não valida
  const h = Array.isArray(header) ? header[0] : header;
  if (!h) return false;
  const esperado = 'sha256=' + crypto.createHmac('sha256', config.cloud.appSecret).update(rawBody).digest('hex');
  try {
    return h.length === esperado.length && crypto.timingSafeEqual(Buffer.from(h), Buffer.from(esperado));
  } catch {
    return false;
  }
}

// ── Tipos do payload da Meta (só o que usamos) ──────────────────────────────
interface CloudMessage {
  from?: string;
  id?: string;
  type?: string;
  text?: { body?: string };
  audio?: { id?: string; mime_type?: string; voice?: boolean };
  image?: { id?: string; mime_type?: string; caption?: string };
  video?: { id?: string; mime_type?: string; caption?: string };
  document?: { id?: string; mime_type?: string; caption?: string; filename?: string };
  button?: { text?: string };
  interactive?: {
    button_reply?: { title?: string };
    list_reply?: { title?: string };
  };
}
interface CloudValue {
  metadata?: { phone_number_id?: string; display_phone_number?: string };
  contacts?: Array<{ profile?: { name?: string }; wa_id?: string }>;
  messages?: CloudMessage[];
  statuses?: unknown[];
}

/** Status de entrega vindo da Meta (sent/delivered/read/failed). */
interface CloudStatus {
  id?: string;
  status?: string;
  recipient_id?: string;
  errors?: Array<{ code?: number; title?: string; message?: string; error_data?: unknown }>;
}

/**
 * Registra o que aconteceu com cada mensagem depois de aceita. Só `failed`
 * vira erro no log: sent/delivered/read são o caminho normal e encheriam o
 * journal sem acrescentar nada.
 */
function registrarStatus(statuses: unknown[]): void {
  for (const s of statuses as CloudStatus[]) {
    if (!s || typeof s !== 'object') continue;
    if (s.status !== 'failed') {
      logger.debug('[cloud] status de mensagem', { id: s.id, status: s.status });
      continue;
    }
    logger.error('[cloud] MENSAGEM FALHOU na entrega', {
      messageId: s.id,
      para: s.recipient_id,
      erros: JSON.stringify(s.errors ?? []).slice(0, 600),
    });
  }
}

function textoDaMensagem(m: CloudMessage): string {
  return (
    m.text?.body ||
    m.image?.caption ||
    m.video?.caption ||
    m.document?.caption ||
    m.button?.text ||
    m.interactive?.button_reply?.title ||
    m.interactive?.list_reply?.title ||
    ''
  ).trim();
}

/** Extensão a partir do mimetype — só pro nome do arquivo quando a Meta não manda filename. */
function extensaoPeloMime(mimetype: string): string {
  const m = /\/([a-z0-9.+-]+)/i.exec(mimetype);
  return (m?.[1] ?? 'bin').replace('jpeg', 'jpg');
}

/** Processa o payload do webhook e responde pela mesma Cloud API. */
export async function processarCloudPayload(
  payload: Record<string, unknown>,
  store: ChatSessionStore,
): Promise<void> {
  const entries = Array.isArray(payload.entry) ? payload.entry : [];
  for (const entry of entries) {
    const changes = Array.isArray((entry as any)?.changes) ? (entry as any).changes : [];
    for (const change of changes) {
      const value = (change?.value ?? {}) as CloudValue;
      const phoneNumberId = value.metadata?.phone_number_id;
      if (!phoneNumberId) continue;

      // Status de entrega: a Meta avisa aqui quando uma mensagem que ela
      // ACEITOU (devolveu messageId) falhou depois, no processamento ou na
      // entrega. Sem registrar isto, "o áudio não chega" fica sem explicação —
      // do nosso lado o envio parece ter dado certo.
      if (value.statuses?.length) registrarStatus(value.statuses);

      if (!value.messages?.length) continue;

      // Allowlist de números atendidos.
      if (config.cloud.allowedPhoneIds.length && !config.cloud.allowedPhoneIds.includes(phoneNumberId)) {
        logger.debug(`[cloud] phone_number_id ${phoneNumberId} fora da allowlist — ignorando`);
        continue;
      }

      const pushName = value.contacts?.[0]?.profile?.name;

      for (const msg of value.messages) {
        void tratarMensagemCloud(msg, phoneNumberId, pushName, store);
      }
    }
  }
}

async function tratarMensagemCloud(
  msg: CloudMessage,
  phoneNumberId: string,
  pushName: string | undefined,
  store: ChatSessionStore,
): Promise<void> {
  const numero = msg.from;
  if (!numero) return;
  const remoteJid = `${numero}@s.whatsapp.net`;          // mantém o mesmo formato de chave da Evolution
  const enviar = senderCloud(phoneNumberId);

  let texto = textoDaMensagem(msg);
  let deAudio = false;

  // Mensagem de voz: baixa o áudio pela Cloud API e transcreve.
  let audioCliente: PanelEvent['arquivo'];
  if (!texto && config.chat.transcribeEnabled && msg.type === 'audio' && msg.audio?.id) {
    const midia = await whatsappCloud.baixarMidia(msg.audio.id);
    if (midia?.base64) {
      // Guarda o áudio ORIGINAL: a transcrição erra, e a atendente precisa poder
      // ouvir o que o cliente realmente disse — principalmente em reclamação.
      try {
        const buffer = Buffer.from(midia.base64, 'base64');
        const mimetype = midia.mimetype || msg.audio.mime_type || 'audio/ogg';
        audioCliente = salvarArquivo(
          `${phoneNumberId}:${remoteJid}`, 'entrada',
          `audio-cliente.${extensaoPeloMime(mimetype)}`, mimetype, buffer,
        );
      } catch (err) {
        logger.warn('[cloud] não consegui guardar o áudio do cliente', { err: String(err) });
      }
      texto = (await transcreverAudio(midia.base64, midia.mimetype ?? msg.audio.mime_type)) ?? '';
    }
    if (texto) {
      deAudio = true;
      logger.info(`[cloud] 🎙️  [${phoneNumberId}] ${numero} (áudio): ${texto}`);
    } else if (audioCliente) {
      // Transcrição falhou mas o áudio existe: a atendente ainda pode ouvir no
      // painel, então registra em vez de descartar a mensagem.
      logger.warn(`[cloud] áudio de ${numero} sem transcrição — guardado para ouvir no painel`);
      deAudio = true;
    } else {
      await enviar(numero, 'Recebi seu áudio, mas não consegui entender por aqui 😕 Pode me mandar por escrito, por favor?');
      return;
    }
  }

  // Documento/imagem/vídeo: baixa e guarda pra virar link de download na
  // timeline. Sem isso, mídia sem legenda batia no `if (!texto) return` logo
  // abaixo e sumia — o cliente mandava o boleto e a IA nem ficava sabendo.
  let arquivo: PanelEvent['arquivo'];
  const midiaDoc = msg.document ?? msg.image ?? msg.video;
  if (midiaDoc?.id && msg.type !== 'audio') {
    const baixada = await whatsappCloud.baixarMidia(midiaDoc.id);
    if (baixada?.base64) {
      const buffer = Buffer.from(baixada.base64, 'base64');
      const mimetype = baixada.mimetype || midiaDoc.mime_type || 'application/octet-stream';
      const nome = msg.document?.filename || `arquivo.${extensaoPeloMime(mimetype)}`;
      arquivo = salvarArquivo(`${phoneNumberId}:${remoteJid}`, 'entrada', nome, mimetype, buffer);
      logger.info(`[cloud] 📎 [${phoneNumberId}] ${numero} enviou arquivo: ${nome} (${mimetype}, ${buffer.length}b)`);
    } else {
      logger.warn(`[cloud] não consegui baixar o arquivo de ${numero}`);
    }
  }

  // Áudio sem transcrição ainda é mensagem: o arquivo existe e a atendente ouve.
  if (!texto && !arquivo && !audioCliente) return;       // reação, status etc. — nada útil aqui

  if (msg.type !== 'audio') {
    logger.info(`[cloud] ⬇️  [${phoneNumberId}] ${numero}: ${texto || '(sem texto)'}`);
  }
  if (msg.id) void whatsappCloud.marcarLido(phoneNumberId, msg.id);

  const session = store.get(remoteJid, numero, phoneNumberId, enviar);
  // Espelha o formato do cliente: áudio recebido, áudio devolvido. O flag é por
  // mensagem — se ele voltar a digitar, a resposta volta a ser texto.
  session.responderEmAudio = config.chat.responderAudio && deAudio;
  session.enviarAudio = senderAudioCloud(phoneNumberId);

  try {
    await session.handle(texto, pushName, { deAudio, arquivo: arquivo ?? audioCliente });
  } catch (err: unknown) {
    logger.error('[cloud] erro ao processar mensagem', {
      phoneNumberId,
      err: err instanceof Error ? err.message : String(err),
    });
    await enviar(numero, 'Desculpe, tive uma instabilidade aqui 😕 pode me mandar de novo?');
  }
}
