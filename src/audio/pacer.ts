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
  private readonly maxChunks: number;

  constructor(
    private readonly write: (frame: Buffer) => void,
    maxBufferMs: number,
  ) {
    this.maxChunks = Math.max(4, Math.ceil(maxBufferMs / 20));
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

    // Sempre descarta o mais antigo — evita atraso crescente que parece "travamento"
    while (this.queue.length > this.maxChunks) {
      this.queue.shift();
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
      // ~100 ms de silêncio após esvaziar a fila → para o clock
      if (this.idleTicks >= 5) {
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
