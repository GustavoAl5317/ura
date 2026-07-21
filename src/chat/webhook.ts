// Webhook que recebe eventos da Evolution API (mesma instância que já envia os
// resumos) e conduz o atendimento de chat. Configure na Evolution um webhook para
// http://<host>:CHAT_WEBHOOK_PORT/webhook com o evento MESSAGES_UPSERT ativo.

import http from 'http';
import { config } from '../config';
import { logger } from '../logger';
import { whatsapp } from '../integrations/whatsapp';
import { ChatSessionStore } from './session';
import { tratarPainel } from './panel-api';

const store = new ChatSessionStore();

interface EvolutionKey {
  remoteJid?: string;
  fromMe?: boolean;
  id?: string;
}

interface EvolutionMessageContent {
  conversation?: string;
  extendedTextMessage?: { text?: string };
  imageMessage?: { caption?: string };
  videoMessage?: { caption?: string };
  buttonsResponseMessage?: { selectedDisplayText?: string };
  listResponseMessage?: { title?: string };
  templateButtonReplyMessage?: { selectedDisplayText?: string };
}

interface EvolutionMessage {
  key?: EvolutionKey;
  message?: EvolutionMessageContent;
  pushName?: string;
  messageType?: string;
}

function extrairTexto(m?: EvolutionMessageContent): string {
  if (!m) return '';
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.buttonsResponseMessage?.selectedDisplayText ||
    m.listResponseMessage?.title ||
    m.templateButtonReplyMessage?.selectedDisplayText ||
    ''
  ).trim();
}

function tokenValido(req: http.IncomingMessage): boolean {
  if (!config.chat.webhookToken) return true;
  const url = new URL(req.url ?? '/', 'http://localhost');
  const qToken = url.searchParams.get('token');
  const header = req.headers['apikey'] || req.headers['authorization'];
  const hToken = Array.isArray(header) ? header[0] : header;
  const bearer = hToken?.replace(/^Bearer\s+/i, '');
  return qToken === config.chat.webhookToken || bearer === config.chat.webhookToken;
}

/** Processa uma mensagem recebida e responde pela MESMA instância que recebeu. */
async function processarMensagem(msg: EvolutionMessage, instance: string): Promise<void> {
  const key = msg.key;
  const remoteJid = key?.remoteJid;
  if (!remoteJid || key?.fromMe) return;                       // ignora nossas próprias mensagens
  if (remoteJid === 'status@broadcast') return;
  const isGrupo = remoteJid.endsWith('@g.us');
  if (isGrupo && !config.chat.atenderGrupos) return;

  // Allowlist de instâncias (evita responder em números com atendimento humano).
  if (config.chat.allowedInstances.length && !config.chat.allowedInstances.includes(instance)) {
    logger.debug(`[chat] instância ${instance} fora da allowlist — ignorando`);
    return;
  }

  const texto = extrairTexto(msg.message);
  if (!texto) return;                                          // mídia sem legenda, reações, etc.

  const numero = remoteJid.split('@')[0];
  logger.info(`[chat] ⬇️  [${instance}] ${numero}: ${texto}`);

  // A sessão decide: IA responde (e entrega) ou apenas registra, se a atendente
  // assumiu a conversa pelo painel.
  const session = store.get(remoteJid, numero, instance);
  try {
    await session.handle(texto, msg.pushName);
  } catch (err: unknown) {
    logger.error('[chat] erro ao processar mensagem', {
      remoteJid,
      instance,
      err: err instanceof Error ? err.message : String(err),
    });
    await whatsapp.enviarTexto(
      numero,
      'Desculpe, tive uma instabilidade aqui 😕 pode me mandar de novo?',
      instance,
    );
  }
}

/** Store de sessões — compartilhado com a API do painel. */
export function getChatStore(): ChatSessionStore {
  return store;
}

/** Extrai a lista de mensagens do payload (Evolution varia entre objeto e array). */
function extrairMensagens(payload: Record<string, unknown>): EvolutionMessage[] {
  const evento = String(payload.event ?? payload.type ?? '').toLowerCase();
  if (evento && !evento.includes('messages.upsert') && !evento.includes('messages_upsert')) {
    return [];
  }
  const data = payload.data;
  if (Array.isArray(data)) return data as EvolutionMessage[];
  if (data && typeof data === 'object') return [data as EvolutionMessage];
  return [];
}

export function startChatServer(): void {
  if (!config.chat.enabled) {
    logger.info('Chat WhatsApp desabilitado (CHAT_ENABLED=0)');
    return;
  }
  if (!config.whatsapp.apiUrl || !config.whatsapp.instance || !config.whatsapp.apiKey) {
    logger.warn('Chat WhatsApp NÃO iniciado: configure WHATSAPP_API_URL / WHATSAPP_INSTANCE / WHATSAPP_API_KEY');
    return;
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ online: true, canal: 'chat', model: config.chat.model }));
      return;
    }

    // Painel de atendimento (HTML + API) — autenticação própria.
    if (url.pathname === '/' || url.pathname.startsWith('/painel') || url.pathname.startsWith('/api/')) {
      void tratarPainel(req, res, url, store).then((tratado) => {
        if (!tratado) {
          res.writeHead(404);
          res.end();
        }
      }).catch((err) => {
        logger.error('[painel] erro', { err: err instanceof Error ? err.message : String(err) });
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ erro: 'erro_interno' }));
        }
      });
      return;
    }

    if (req.method !== 'POST') {
      res.writeHead(404);
      res.end();
      return;
    }

    if (!tokenValido(req)) {
      res.writeHead(401);
      res.end('unauthorized');
      return;
    }

    let body = '';
    req.on('data', (d) => {
      body += d;
      if (body.length > 2_000_000) req.destroy();               // proteção contra payload gigante
    });
    req.on('end', () => {
      // Responde rápido para a Evolution; processa em segundo plano.
      res.writeHead(200);
      res.end('ok');

      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(body || '{}');
      } catch {
        return;
      }

      const instance = String(payload.instance ?? payload.instanceName ?? config.whatsapp.instance);
      const mensagens = extrairMensagens(payload);
      for (const m of mensagens) {
        void processarMensagem(m, instance);
      }
    });
  });

  server.listen(config.chat.webhookPort, '0.0.0.0', () => {
    logger.info(`Chat WhatsApp escutando webhook na porta ${config.chat.webhookPort} (modelo ${config.chat.model})`);
  });
}
