import net from 'net';
import { EventEmitter } from 'events';
import { config } from '../config';
import { logger } from '../logger';

export class AmiClient extends EventEmitter {
  private socket: net.Socket | null = null;
  private buf = '';
  private cbs = new Map<string, (r: Record<string, string>) => void>();
  private counter = 0;
  private connecting: Promise<void> | null = null;

  async connect(): Promise<void> {
    if (this.socket) return;
    if (this.connecting) return this.connecting;

    this.connecting = new Promise<void>((resolve, reject) => {
      const sock = new net.Socket();

      sock.connect(config.ami.port, config.ami.host);

      sock.on('data', (d) => this.onData(d.toString()));
      sock.on('error', (err) => {
        logger.error('AMI socket erro', { err: err.message });
        this.socket = null;
        this.connecting = null;
        reject(err);
      });
      sock.on('close', () => {
        this.socket = null;
        this.connecting = null;
        logger.info('AMI desconectado');
      });

      this.once('_banner', async () => {
        this.socket = sock;
        try {
          await this.action({ Action: 'Login', Username: config.ami.user, Secret: config.ami.password });
          logger.info('AMI autenticado');
          this.connecting = null;
          resolve();
        } catch (err) {
          sock.destroy();
          reject(err);
        }
      });

      setTimeout(() => {
        if (!this.socket) {
          sock.destroy();
          this.connecting = null;
          reject(new Error('AMI connect timeout'));
        }
      }, 8_000);
    });

    return this.connecting;
  }

  async action(params: Record<string, string>): Promise<Record<string, string>> {
    if (!this.socket) await this.connect();

    const id = `ura-${++this.counter}`;
    const msg = Object.entries({ ...params, ActionID: id })
      .map(([k, v]) => `${k}: ${v}`)
      .join('\r\n') + '\r\n\r\n';

    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.cbs.delete(id);
        reject(new Error(`AMI timeout: ${params.Action}`));
      }, 6_000);

      this.cbs.set(id, (r) => {
        clearTimeout(t);
        if (r['Response'] === 'Error') reject(new Error(r['Message'] ?? 'AMI error'));
        else resolve(r);
      });

      this.socket!.write(msg);
    });
  }

  async redirect(channel: string, exten: string, context: string, priority = 1): Promise<void> {
    await this.action({ Action: 'Redirect', Channel: channel, Exten: exten, Context: context, Priority: String(priority) });
    logger.info('AMI redirect', { channel, exten, context });
  }

  async hangup(channel: string): Promise<void> {
    await this.action({ Action: 'Hangup', Channel: channel });
  }

  disconnect(): void {
    this.socket?.destroy();
    this.socket = null;
  }

  private onData(data: string): void {
    this.buf += data;
    const blocks = this.buf.split('\r\n\r\n');
    this.buf = blocks.pop() ?? '';

    for (const block of blocks) {
      if (!block.trim()) continue;

      if (block.startsWith('Asterisk Call Manager')) {
        this.emit('_banner', block);
        continue;
      }

      const fields: Record<string, string> = {};
      for (const line of block.split('\r\n')) {
        const idx = line.indexOf(': ');
        if (idx >= 0) fields[line.slice(0, idx)] = line.slice(idx + 2);
      }

      const id = fields['ActionID'];
      if (id && this.cbs.has(id)) {
        const cb = this.cbs.get(id)!;
        this.cbs.delete(id);
        cb(fields);
      } else {
        this.emit('amiEvent', fields);
      }
    }
  }
}

export const ami = new AmiClient();
