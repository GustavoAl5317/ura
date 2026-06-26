// HTTP sidecar para receber o número do chamador do Asterisk
// O Asterisk chama POST /register com {uuid, callerNumber} via curl/AGI
// antes de conectar via AudioSocket

import http from 'http';
import { config } from '../config';
import { logger } from '../logger';
import { isUraEnabled } from '../admin/ura-control';

export interface CallRegistration {
  callerNumber: string;
  channel?: string; // canal Asterisk (ex.: PJSIP/xxx-0000001) — usado na transferência via AMI
}

const registrations = new Map<string, CallRegistration>(); // uuid → dados da chamada

// Consome o registro uma única vez (retorna e remove).
export function getRegistration(uuid: string): CallRegistration | undefined {
  const r = registrations.get(uuid);
  if (r) registrations.delete(uuid);
  return r;
}

export function startSidecar(): void {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ online: true, uraEnabled: isUraEnabled() }));
      return;
    }

    if (req.method !== 'POST' || req.url !== '/register') {
      res.writeHead(404);
      res.end();
      return;
    }

    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      try {
        const { uuid, callerNumber, channel } = JSON.parse(body) as Record<string, string>;
        if (uuid && callerNumber) {
          registrations.set(uuid, { callerNumber, channel: channel || undefined });
          // Auto-cleanup após 5 minutos
          setTimeout(() => registrations.delete(uuid), 5 * 60_000);
          logger.debug('Sidecar registro', { uuid, callerNumber, channel: channel || '(não informado)' });
        }
        res.writeHead(200);
        res.end('ok');
      } catch {
        res.writeHead(400);
        res.end('bad request');
      }
    });
  });

  server.listen(config.sidecar.port, '0.0.0.0', () => {
    logger.info(`Sidecar HTTP escutando na porta ${config.sidecar.port}`);
  });
}
