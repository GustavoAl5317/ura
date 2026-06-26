import net from 'net';
import { AudioSocketProtocol, AUDIOSOCKET_TYPE } from './protocol';
import { getRegistration } from '../http/sidecar';
import { ami } from '../integrations/ami';
import { config } from '../config';
import { logger } from '../logger';

/** URA desligada no painel: redireciona a chamada para o atendente via AMI. */
export function handleUraOffFallback(socket: net.Socket): void {
  const parser = new AudioSocketProtocol();
  const addr = `${socket.remoteAddress}:${socket.remotePort}`;
  let done = false;

  const finish = () => {
    if (done) return;
    done = true;
    socket.removeAllListeners('data');
    if (!socket.destroyed) socket.destroy();
  };

  const onData = (raw: Buffer) => {
    for (const msg of parser.feed(raw)) {
      if (msg.type !== AUDIOSOCKET_TYPE.UUID) continue;

      const hex = msg.payload.toString('hex');
      const uuid = hex.replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5');
      const reg = getRegistration(uuid) ?? getRegistration(hex);

      void (async () => {
        try {
          await ami.connect();
          if (reg?.channel) {
            await ami.redirect(
              reg.channel,
              config.ami.transferExten,
              config.ami.transferContext,
            );
            logger.info(
              `URA desligada — chamada ${reg.callerNumber || uuid} → ${config.ami.transferExten}`,
            );
          } else {
            logger.warn(`URA desligada — canal Asterisk ausente (${uuid})`);
          }
        } catch (err: any) {
          logger.error(`URA desligada — falha ao redirecionar (${addr})`, { err: err.message });
        } finally {
          finish();
        }
      })();
      return;
    }
  };

  socket.setNoDelay(true);
  socket.on('data', onData);
  socket.on('close', finish);
  socket.on('error', finish);
  setTimeout(() => {
    if (!done) {
      logger.warn(`URA desligada — timeout aguardando UUID (${addr})`);
      finish();
    }
  }, 10_000);
}
