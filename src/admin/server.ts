import http from 'http';
import fs from 'fs';
import path from 'path';
import { config } from '../config';
import { logger } from '../logger';
import { sessionRegistry } from './registry';
import { listHistory, getHistory } from './history';
import { isUraEnabled, setUraEnabled, getUraState } from './ura-control';
import { listAlerts, markAlertRead } from './alerts';
import { getOpenAiAuditStatus, refreshOpenAiAudit, startOpenAiAuditMonitor } from './openai-audit-monitor';
import { getOpenAiSnapshot, refreshOpenAiUsage, startOpenAiMonitor } from './openai-monitor';

const PANEL_DIR = path.join(process.cwd(), 'panel');

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function isAuthorized(req: http.IncomingMessage, url?: URL): boolean {
  const key = config.admin.apiKey;
  if (!key) return true;
  const header = req.headers.authorization;
  if (header === `Bearer ${key}`) return true;
  if (req.headers['x-admin-key'] === key) return true;
  if (url?.searchParams.get('key') === key) return true;
  return false;
}

function unauthorized(res: http.ServerResponse): void {
  json(res, 401, { error: 'unauthorized' });
}

function servePanel(res: http.ServerResponse, file: string): void {
  const safe = path.normalize(file).replace(/^(\.\.(\/|\\|$))+/, '');
  const full = path.join(PANEL_DIR, safe);
  if (!full.startsWith(PANEL_DIR)) {
    res.writeHead(403);
    res.end();
    return;
  }
  if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) {
    res.writeHead(404);
    res.end('not found');
    return;
  }
  const ext = path.extname(full);
  const types: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript',
    '.css': 'text/css',
  };
  res.writeHead(200, { 'Content-Type': types[ext] ?? 'application/octet-stream' });
  fs.createReadStream(full).pipe(res);
}

export function startAdminServer(): void {
  if (!config.admin.enabled) {
    logger.info('Painel admin desabilitado (ADMIN_ENABLED=0)');
    return;
  }

  startOpenAiMonitor();
  startOpenAiAuditMonitor();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const pathname = url.pathname;

    // Painel estático (HTML) — sem auth para carregar UI; API exige chave
    if (req.method === 'GET' && (pathname === '/' || pathname === '/panel' || pathname === '/panel/')) {
      return servePanel(res, 'index.html');
    }
    if (req.method === 'GET' && pathname.startsWith('/panel/')) {
      return servePanel(res, pathname.slice('/panel/'.length) || 'index.html');
    }

    if (!pathname.startsWith('/api/')) {
      res.writeHead(404);
      res.end();
      return;
    }

    if (!isAuthorized(req, url)) return unauthorized(res);

  try {
    // ── Status geral ─────────────────────────────────────────────────────
    if (req.method === 'GET' && pathname === '/api/status') {
      const ura = getUraState();
      return json(res, 200, {
        uraEnabled: isUraEnabled(),
        uraUpdatedAt: ura.updatedAt,
        activeCalls: sessionRegistry.activeCount(),
        sessions: sessionRegistry.getActive(),
        openai: getOpenAiSnapshot(),
        openaiAudit: getOpenAiAuditStatus(),
        alerts: listAlerts(10),
        uptimeSec: Math.round(process.uptime()),
      });
    }

    if (req.method === 'GET' && pathname === '/api/health') {
      return json(res, 200, { ok: true, uraEnabled: isUraEnabled() });
    }

    // ── URA ligar/desligar ───────────────────────────────────────────────
    if (req.method === 'POST' && pathname === '/api/ura/enable') {
      setUraEnabled(true, 'painel');
      return json(res, 200, { enabled: true });
    }

    if (req.method === 'POST' && pathname === '/api/ura/disable') {
      setUraEnabled(false, 'painel');
      return json(res, 200, { enabled: false });
    }

    // ── Sessões ativas ───────────────────────────────────────────────────
    if (req.method === 'GET' && pathname === '/api/sessions') {
      return json(res, 200, { sessions: sessionRegistry.getActive() });
    }

    const sessionMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/);
    if (req.method === 'GET' && sessionMatch) {
      const s = sessionRegistry.get(sessionMatch[1]);
      if (!s) return json(res, 404, { error: 'not_found' });
      return json(res, 200, s);
    }

    // ── SSE tempo real ───────────────────────────────────────────────────
    if (req.method === 'GET' && pathname === '/api/events/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      const id = sessionRegistry.subscribeSse(
        (chunk) => res.write(chunk),
        () => res.end(),
      );
      req.on('close', () => sessionRegistry.unsubscribeSse(id));
      return;
    }

    // ── Histórico ────────────────────────────────────────────────────────
    if (req.method === 'GET' && pathname === '/api/history') {
      const limit = Math.min(200, parseInt(url.searchParams.get('limit') ?? '50', 10) || 50);
      return json(res, 200, { records: listHistory(limit) });
    }

    const histMatch = pathname.match(/^\/api\/history\/([^/]+)$/);
    if (req.method === 'GET' && histMatch) {
      const r = getHistory(histMatch[1]);
      if (!r) return json(res, 404, { error: 'not_found' });
      return json(res, 200, r);
    }

    // ── OpenAI ───────────────────────────────────────────────────────────
    if (req.method === 'GET' && pathname === '/api/openai/audit') {
      await refreshOpenAiAudit();
      return json(res, 200, getOpenAiAuditStatus() ?? { ok: false });
    }

    if (req.method === 'GET' && pathname === '/api/openai/usage') {
      const snap = await refreshOpenAiUsage();
      return json(res, 200, snap);
    }

    // ── Alertas ──────────────────────────────────────────────────────────
    if (req.method === 'GET' && pathname === '/api/alerts') {
      return json(res, 200, { alerts: listAlerts(50) });
    }

    if (req.method === 'POST' && pathname === '/api/alerts/read') {
      const body = JSON.parse(await readBody(req)) as { id?: string };
      if (body.id) markAlertRead(body.id);
      return json(res, 200, { ok: true });
    }

    res.writeHead(404);
    res.end();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    json(res, 500, { error: msg });
  }
  });

  server.listen(config.admin.port, '0.0.0.0', () => {
    logger.info(`Painel admin em http://0.0.0.0:${config.admin.port}/panel/`);
    if (!config.admin.apiKey) {
      logger.warn('ADMIN_API_KEY não definido — API admin aberta sem autenticação');
    }
  });
}
