// API do painel de atendimento: lista conversas, mostra o que a IA consultou,
// permite a atendente assumir (intervir), enviar mensagens e devolver para a IA.

import http from 'http';
import fs from 'fs';
import path from 'path';
import { config } from '../config';
import { logger } from '../logger';
import type { ChatSessionStore } from './session';

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function panelAutorizado(req: http.IncomingMessage, url: URL): boolean {
  if (!config.chat.panelToken) return true;
  const q = url.searchParams.get('token');
  const header = req.headers['x-panel-token'] || req.headers['authorization'];
  const h = Array.isArray(header) ? header[0] : header;
  const bearer = h?.replace(/^Bearer\s+/i, '');
  return q === config.chat.panelToken || bearer === config.chat.panelToken;
}

function lerCorpo(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (d) => {
      body += d;
      if (body.length > 200_000) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

/** Serve o HTML do painel (arquivo estático em panel/chat.html). */
function servirPainel(res: http.ServerResponse): void {
  const file = path.join(process.cwd(), 'panel', 'chat.html');
  if (!fs.existsSync(file)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('painel/chat.html não encontrado');
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}

/**
 * Trata rotas do painel. Retorna true se a requisição foi atendida aqui.
 * Rotas:
 *   GET  /                          → HTML do painel
 *   GET  /api/conversas             → lista (polling)
 *   GET  /api/conversas/:key        → detalhe + timeline + dados do cliente
 *   POST /api/conversas/:key/intervir
 *   POST /api/conversas/:key/retomar
 *   POST /api/conversas/:key/enviar { texto }
 */
export async function tratarPainel(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  store: ChatSessionStore,
): Promise<boolean> {
  const p = url.pathname;

  if (req.method === 'GET' && (p === '/' || p === '/painel' || p === '/painel/')) {
    servirPainel(res);
    return true;
  }

  if (!p.startsWith('/api/')) return false;

  if (!panelAutorizado(req, url)) {
    json(res, 401, { erro: 'nao_autorizado' });
    return true;
  }

  // Lista de conversas
  if (req.method === 'GET' && p === '/api/conversas') {
    json(res, 200, {
      agora: Date.now(),
      empresa: config.company.name,
      agente: config.company.agentName,
      conversas: store.list().map((s) => s.resumo()),
    });
    return true;
  }

  const m = /^\/api\/conversas\/(.+?)(?:\/(intervir|retomar|enviar))?$/.exec(p);
  if (!m) return false;

  const key = decodeURIComponent(m[1]);
  const acao = m[2];
  const session = store.find(key);
  if (!session) {
    json(res, 404, { erro: 'conversa_nao_encontrada' });
    return true;
  }

  if (req.method === 'GET' && !acao) {
    json(res, 200, session.detalhe());
    return true;
  }

  if (req.method === 'POST' && acao === 'intervir') {
    const body = await lerCorpo(req);
    session.intervir(typeof body.atendente === 'string' ? body.atendente : undefined);
    json(res, 200, { ok: true, modo: session.modo });
    return true;
  }

  if (req.method === 'POST' && acao === 'retomar') {
    session.retomar();
    json(res, 200, { ok: true, modo: session.modo });
    return true;
  }

  if (req.method === 'POST' && acao === 'enviar') {
    const body = await lerCorpo(req);
    const texto = typeof body.texto === 'string' ? body.texto : '';
    const r = await session.enviarComoAtendente(texto);
    if (!r.enviado) {
      logger.warn('[painel] falha ao enviar mensagem da atendente', { key, motivo: r.motivo });
      json(res, 400, { ok: false, motivo: r.motivo ?? 'falha_envio' });
      return true;
    }
    json(res, 200, { ok: true });
    return true;
  }

  json(res, 405, { erro: 'metodo_nao_suportado' });
  return true;
}
