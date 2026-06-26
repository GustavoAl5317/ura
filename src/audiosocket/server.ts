import net from 'net';
import { CallSession } from '../session/call';
import { config } from '../config';
import { logger } from '../logger';
import { isUraEnabled } from '../admin/ura-control';
import { handleUraOffFallback } from './ura-off-fallback';

export function startAudioSocketServer(): net.Server {
  const server = net.createServer((socket) => {
    const addr = `${socket.remoteAddress}:${socket.remotePort}`;

    if (!isUraEnabled()) {
      logger.warn(`URA desligada — encaminhando para atendente (${addr})`);
      handleUraOffFallback(socket);
      return;
    }

    logger.info(`Nova conexão AudioSocket: ${addr}`);

    socket.setNoDelay(true);

    const session = new CallSession(socket);
    session.start();

    socket.on('close', () => logger.debug(`Conexão fechada: ${addr}`));
  });

  server.listen(config.audiosocket.port, '0.0.0.0', () => {
    logger.info(`AudioSocket TCP escutando na porta ${config.audiosocket.port}`);
  });

  server.on('error', (err) => {
    logger.error('AudioSocket server erro', { err: err.message });
  });

  return server;
}
