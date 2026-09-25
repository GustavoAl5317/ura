// Webhook que recebe eventos da Evolution API (mesma instância que já envia os
// resumos) e conduz o atendimento de chat. Configure na Evolution um webhook para
// http://<host>:CHAT_WEBHOOK_PORT/webhook com o evento MESSAGES_UPSERT ativo.

import http from 'http';
import fs from 'fs';
import path from 'path';
import { config } from '../config';
import { logger } from '../logger';
import { whatsapp } from '../integrations/whatsapp';
import { ChatSessionStore } from './session';
import { tratarPainel } from './panel-api';
import { initAuth } from './auth';
import { initDb } from './db';
import { transcreverAudio } from './audio';
import { verificarWebhookCloud, assinaturaValida, processarCloudPayload, resolveEnviarCloud } from './cloud-webhook';
import { salvarArquivo } from './arquivos';
import type { PanelEvent } from './session';

const store = new ChatSessionStore();

interface EvolutionKey {
  remoteJid?: string;
  fromMe?: boolean;
  id?: string;
}

interface EvolutionMessageContent {
  conversation?: string;
  extendedTextMessage?: { text?: string };
  imageMessage?: { caption?: string; mimetype?: string };
  videoMessage?: { caption?: string; mimetype?: string };
  documentMessage?: { caption?: string; mimetype?: string; fileName?: string };
  audioMessage?: { mimetype?: string; seconds?: number; ptt?: boolean };
  buttonsResponseMessage?: { selectedDisplayText?: string };
  listResponseMessage?: { title?: string };
  templateButtonReplyMessage?: { selectedDisplayText?: string };
}

/** Extensão a partir do mimetype — só pro nome do arquivo quando a Evolution não manda fileName. */
function extensaoPeloMime(mimetype: string): string {
  const m = /\/([a-z0-9.+-]+)/i.exec(mimetype);
  return (m?.[1] ?? 'bin').replace('jpeg', 'jpg');
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

  const numero = remoteJid.split('@')[0];

  let texto = extrairTexto(msg.message);
  let deAudio = false;

  // Mensagem de voz: baixa o áudio da Evolution e transcreve para texto.
  let audioCliente: PanelEvent['arquivo'];
  if (!texto && config.chat.transcribeEnabled && msg.message?.audioMessage) {
    const midia = await whatsapp.obterBase64Midia(msg.key ?? {}, instance);
    if (midia?.base64) {
      // Guarda o áudio ORIGINAL: a transcrição erra, e a atendente precisa poder
      // ouvir o que o cliente realmente disse — principalmente em reclamação.
      try {
        const buffer = Buffer.from(midia.base64, 'base64');
        const mimetype = midia.mimetype || msg.message.audioMessage.mimetype || 'audio/ogg';
        audioCliente = salvarArquivo(
          `${instance}:${remoteJid}`, 'entrada',
          `audio-cliente.${extensaoPeloMime(mimetype)}`, mimetype, buffer,
        );
      } catch (err) {
        logger.warn('[chat] não consegui guardar o áudio do cliente', { err: String(err) });
      }
      texto = (await transcreverAudio(midia.base64, midia.mimetype ?? msg.message.audioMessage.mimetype)) ?? '';
    }
    if (texto) {
      deAudio = true;
      logger.info(`[chat] 🎙️  [${instance}] ${numero} (áudio): ${texto}`);
    } else if (audioCliente) {
      // Transcrição falhou mas o áudio existe: a atendente ainda pode ouvir no
      // painel, então registra em vez de descartar a mensagem.
      logger.warn(`[chat] áudio de ${numero} sem transcrição — guardado para ouvir no painel`);
      deAudio = true;
    } else {
      logger.warn(`[chat] não consegui transcrever o áudio de ${numero}`);
      await whatsapp.enviarTexto(
        numero,
        'Recebi seu áudio, mas não consegui entender por aqui 😕 Pode me mandar por escrito, por favor?',
        instance,
      );
      return;
    }
  }

  // Documento/imagem/vídeo: baixa e guarda pra virar link de download na
  // timeline. Sem isso o painel só mostrava a legenda (se tinha) e o arquivo
  // em si nunca chegava — nem pra ver, nem pra baixar depois.
  let arquivo: PanelEvent['arquivo'];
  const midiaDoc = msg.message?.documentMessage ?? msg.message?.imageMessage ?? msg.message?.videoMessage;
  if (midiaDoc && !msg.message?.audioMessage) {
    const baixada = await whatsapp.obterBase64Midia(msg.key ?? {}, instance);
    if (baixada?.base64) {
      const buffer = Buffer.from(baixada.base64, 'base64');
      const mimetype = baixada.mimetype || midiaDoc.mimetype || 'application/octet-stream';
      const nome = msg.message?.documentMessage?.fileName || `arquivo.${extensaoPeloMime(mimetype)}`;
      arquivo = salvarArquivo(`${instance}:${remoteJid}`, 'entrada', nome, mimetype, buffer);
      logger.info(`[chat] 📎 [${instance}] ${numero} enviou arquivo: ${nome} (${mimetype}, ${buffer.length}b)`);
    } else {
      logger.warn(`[chat] não consegui baixar o arquivo de ${numero}`);
    }
  }

  // Áudio sem transcrição ainda é mensagem: o arquivo existe e a atendente ouve.
  if (!texto && !arquivo && !audioCliente) return;             // reação, status etc. — nada útil aqui

  if (!msg.message?.audioMessage) {
    logger.info(`[chat] ⬇️  [${instance}] ${numero}: ${texto || '(sem texto)'}`);
  }

  // A sessão decide: IA responde (e entrega) ou apenas registra, se a atendente
  // assumiu a conversa pelo painel.
  const session = store.get(remoteJid, numero, instance);
  try {
    await session.handle(texto, msg.pushName, { deAudio, arquivo: arquivo ?? audioCliente });
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
  const temEvolution = !!(config.whatsapp.apiUrl && config.whatsapp.instance && config.whatsapp.apiKey);
  if (!temEvolution && !config.cloud.enabled) {
    logger.warn('Chat NÃO iniciado: configure a Evolution (WHATSAPP_*) ou a Cloud API (CLOUD_*)');
    return;
  }

  initDb();
  initAuth();
  // No restore, conversas da Cloud API voltam com o transporte oficial da Meta.
  store.retomarDoBanco(resolveEnviarCloud);

  if (config.cloud.enabled) {
    logger.info(`Cloud API (Meta) habilitada — webhook em POST /cloud/webhook`);
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ online: true, canal: 'chat', model: config.chat.model }));
      return;
    }

    // Política de privacidade — pública e sem login: a Meta exige uma URL
    // acessível para publicar o app.
    if (req.method === 'GET' && (url.pathname === '/politica-de-privacidade' || url.pathname === '/privacidade')) {
      const file = path.join(process.cwd(), 'panel', 'politica-privacidade.html');
      if (!fs.existsSync(file)) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('não encontrada');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      fs.createReadStream(file).pipe(res);
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

    // Cloud API (Meta) — verificação GET do webhook.
    if (req.method === 'GET' && url.pathname === '/cloud/webhook') {
      verificarWebhookCloud(url, res);
      return;
    }

    if (req.method !== 'POST') {
      res.writeHead(404);
      res.end();
      return;
    }

    // Acumula em Buffer: concatenar como string quebraria acentos partidos entre
    // chunks e invalidaria a assinatura HMAC da Meta.
    const chunks: Buffer[] = [];
    let recebido = 0;
    req.on('data', (d: Buffer) => {
      chunks.push(d);
      recebido += d.length;
      if (recebido > 2_000_000) req.destroy();                  // proteção contra payload gigante
    });
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');

      // ── Cloud API (Meta): valida assinatura e processa ──
      if (url.pathname === '/cloud/webhook') {
        if (!assinaturaValida(body, req.headers['x-hub-signature-256'])) {
          logger.warn('[cloud] assinatura inválida — descartado');
          res.writeHead(403);
          res.end('forbidden');
          return;
        }
        res.writeHead(200);
        res.end('ok');                                          // Meta exige 200 rápido
        try {
          void processarCloudPayload(JSON.parse(body || '{}'), store);
        } catch { /* payload inválido */ }
        return;
      }

      // ── Evolution: exige o token do webhook ──
      if (!tokenValido(req)) {
        res.writeHead(401);
        res.end('unauthorized');
        return;
      }

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
