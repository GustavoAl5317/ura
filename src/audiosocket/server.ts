import net from 'net';
import { CallSession } from '../session/call';
import { config } from '../config';
import { logger } from '../logger';

export function startAudioSocketServer(): net.Server {
  const server = net.createServer((socket) => {
    const addr = `${socket.remoteAddress}:${socket.remotePort}`;
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
