// HTTP sidecar para receber o número do chamador do Asterisk
// O Asterisk chama POST /register com {uuid, callerNumber} via curl/AGI
// antes de conectar via AudioSocket

import http from 'http';
import { config } from '../config';
import { logger } from '../logger';

const registrations = new Map<string, string>(); // uuid → callerNumber

export function getCallerNumber(uuid: string): string | undefined {
  const n = registrations.get(uuid);
  if (n) registrations.delete(uuid); // consume once
  return n;
}

export function startSidecar(): void {
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/register') {
      res.writeHead(404);
      res.end();
      return;
    }

    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      try {
        const { uuid, callerNumber } = JSON.parse(body) as Record<string, string>;
        if (uuid && callerNumber) {
          registrations.set(uuid, callerNumber);
          // Auto-cleanup após 5 minutos
          setTimeout(() => registrations.delete(uuid), 5 * 60_000);
          logger.debug('Sidecar registro', { uuid, callerNumber });
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
