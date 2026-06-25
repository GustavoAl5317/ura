import { AudioSocketProtocol } from '../audiosocket/protocol';

export const SLIN_CHUNK_BYTES = 320; // 20 ms @ 8 kHz 16-bit mono
export const SILENCE_CHUNK = Buffer.alloc(SLIN_CHUNK_BYTES);

/** Pacer de saída: 1 frame SLIN a cada 20 ms, clock estável para o Asterisk. */
export class AudioPacer {
  private queue: Buffer[] = [];
  private remainder = Buffer.alloc(0);
  private timer: ReturnType<typeof setTimeout> | null = null;
  private streaming = false;
  private idleTicks = 0;
  private readonly safetyMaxChunks: number;

  constructor(
    private readonly write: (frame: Buffer) => void,
    maxBufferMs: number,
  ) {
    // Teto de segurança alto — NÃO descartar o início da fala (causava sumir a saudação)
    this.safetyMaxChunks = Math.max(100, Math.ceil(maxBufferMs / 20));
  }

  start(): void {
    if (this.timer) return;
    const tick = () => {
      this.timer = setTimeout(tick, 20);
      this.onTick();
    };
    this.timer = setTimeout(tick, 20);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.queue = [];
    this.remainder = Buffer.alloc(0);
    this.streaming = false;
    this.idleTicks = 0;
  }

  flush(): void {
    this.queue = [];
    this.remainder = Buffer.alloc(0);
    this.streaming = false;
    this.idleTicks = 0;
  }

  enqueue(pcm8k: Buffer): void {
    if (!pcm8k.length) return;

    const combined = Buffer.concat([this.remainder, pcm8k]);
    let offset = 0;
    while (offset + SLIN_CHUNK_BYTES <= combined.length) {
      this.queue.push(Buffer.from(combined.subarray(offset, offset + SLIN_CHUNK_BYTES)));
      offset += SLIN_CHUNK_BYTES;
    }
    this.remainder = offset < combined.length
      ? combined.subarray(offset)
      : Buffer.alloc(0);

    // Só corta em filas absurdas (ex.: bug) — nunca para "controlar latência" no meio da fala
    if (this.queue.length > this.safetyMaxChunks * 4) {
      const drop = this.queue.length - this.safetyMaxChunks * 2;
      this.queue.splice(0, drop);
    }

    this.streaming = true;
    this.idleTicks = 0;
  }

  setStreaming(active: boolean): void {
    this.streaming = active;
    if (active) this.idleTicks = 0;
  }

  isStreaming(): boolean {
    return this.streaming;
  }

  getQueueLength(): number {
    return this.queue.length;
  }

  private onTick(): void {
    const frame = this.queue.shift();
    if (frame) {
      this.write(frame);
      this.streaming = true;
      this.idleTicks = 0;
      return;
    }

    if (this.streaming) {
      this.write(SILENCE_CHUNK);
      this.idleTicks++;
      if (this.idleTicks >= 15) {
        this.streaming = false;
        this.idleTicks = 0;
      }
    }
  }
}

export function writeAudioSocketFrame(socket: { destroyed: boolean; write: (buf: Buffer) => void }, pcm8k: Buffer): void {
  if (socket.destroyed || pcm8k.length !== SLIN_CHUNK_BYTES) return;
  socket.write(AudioSocketProtocol.audio(pcm8k));
}
