// Barramento de eventos do assistente → painel ao vivo (SSE).
//
// Tudo que o painel mostra "acontecendo agora" passa por aqui: alerta criado,
// chamada da URA, consulta respondida, monitor que rodou ou falhou. Um
// subscritor lento ou desconectado nunca pode travar quem publica.

import { randomUUID } from 'crypto';
import type http from 'http';
import { logger } from '../logger';

export type TipoEvento = 'alerta' | 'chamada' | 'consulta' | 'monitor' | 'sistema';

export interface Evento {
  id: string;
  tipo: TipoEvento;
  at: string;
  dados: unknown;
}

const clientes = new Map<string, http.ServerResponse>();
const recentes: Evento[] = [];
const MAX_RECENTES = 200;

export function publicar(tipo: TipoEvento, dados: unknown): void {
  const ev: Evento = { id: randomUUID(), tipo, at: new Date().toISOString(), dados };
  recentes.push(ev);
  if (recentes.length > MAX_RECENTES) recentes.shift();

  const linha = `event: ${tipo}\ndata: ${JSON.stringify(ev)}\n\n`;
  for (const [id, res] of clientes) {
    try {
      res.write(linha);
    } catch {
      clientes.delete(id);
    }
  }
}

/** Abre um stream SSE. Manda os eventos recentes primeiro, para a tela não nascer vazia. */
export function assinar(req: http.IncomingMessage, res: http.ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Proxy reverso (nginx) segura o stream em buffer sem isto.
    'X-Accel-Buffering': 'no',
  });
  const id = randomUUID();
  clientes.set(id, res);

  res.write(`event: conectado\ndata: ${JSON.stringify({ recentes: recentes.slice(-50) })}\n\n`);

  // Comentário a cada 25 s: mantém a conexão viva atrás de proxy e detecta
  // cliente morto sem esperar o TCP perceber.
  const pulso = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { /* fecha abaixo */ }
  }, 25_000);

  req.on('close', () => {
    clearInterval(pulso);
    clientes.delete(id);
  });
  logger.debug(`Painel: stream aberto (${clientes.size} conectado(s))`);
}

export function eventosRecentes(limite = 50): Evento[] {
  return recentes.slice(-limite);
}
