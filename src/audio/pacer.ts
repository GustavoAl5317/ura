import { AudioSocketProtocol } from '../audiosocket/protocol';

export const SLIN_CHUNK_BYTES = 320; // 20 ms @ 8 kHz 16-bit mono
export const SILENCE_CHUNK = Buffer.alloc(SLIN_CHUNK_BYTES);

/** Pacer de saída: 1 frame SLIN a cada 20 ms, clock estável para o Asterisk. */
export class AudioPacer {
  private queue: Buffer[] = [];
  private remainder = Buffer.alloc(0);
  private timer: ReturnType<typeof setInterval> | null = null;
  private streaming = false;
  private holdStream = false;
  private primed = false;
  private idleTicks = 0;
  private micMuteUntil = 0;
  private readonly preBufferChunks: number;
  private readonly inputMuteMs: number;

  constructor(
    private readonly write: (frame: Buffer) => boolean,
    preBufferMs: number,
    inputMuteMs = 1500,
  ) {
    this.preBufferChunks = Math.max(0, Math.ceil(preBufferMs / 20));
    this.inputMuteMs = inputMuteMs;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.onTick(), 20);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.queue = [];
    this.remainder = Buffer.alloc(0);
    this.streaming = false;
    this.holdStream = false;
    this.primed = false;
    this.idleTicks = 0;
    this.micMuteUntil = 0;
  }

  flush(): void {
    this.queue = [];
    this.remainder = Buffer.alloc(0);
    this.streaming = false;
    this.primed = false;
    this.idleTicks = 0;
    this.micMuteUntil = 0;
  }

  isPlaying(): boolean {
    return this.holdStream || this.queue.length > 0 || this.streaming;
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

    this.streaming = true;
    this.idleTicks = 0;
  }

  /** Mantém clock ativo durante toda a resposta da OpenAI (evita micro-pausas entre sílabas). */
  setHoldStream(hold: boolean): void {
    this.holdStream = hold;
    if (hold) {
      this.streaming = true;
      this.idleTicks = 0;
    } else if (this.queue.length === 0) {
      this.primed = false;
    }
  }

  getQueueLength(): number {
    return this.queue.length;
  }

  /** Bloqueia microfone enquanto há áudio na saída ou janela anti-eco após a fala. */
  isMicGated(): boolean {
    return this.holdStream || this.queue.length > 0 || Date.now() < this.micMuteUntil;
  }

  private armMicMute(): void {
    if (this.inputMuteMs > 0) {
      this.micMuteUntil = Math.max(this.micMuteUntil, Date.now() + this.inputMuteMs);
    }
  }

  private onTick(): void {
    const active = this.streaming || this.holdStream;

    if (!this.primed && active) {
      if (this.queue.length < this.preBufferChunks) return;
      this.primed = true;
    }

    const hadQueuedAudio = this.queue.length > 0;
    const frame = this.queue.shift();
    if (frame) {
      if (!this.write(frame)) {
        this.queue.unshift(frame);
      }
      this.streaming = true;
      this.idleTicks = 0;
      if (hadQueuedAudio && this.queue.length === 0) {
        this.armMicMute();
      }
      return;
    }

    if (active) {
      if (!this.write(SILENCE_CHUNK)) return;
      this.idleTicks++;
      if (!this.holdStream && this.idleTicks >= 30) {
        this.streaming = false;
        this.primed = false;
        this.idleTicks = 0;
      }
    }
  }
}

export function writeAudioSocketFrame(
  socket: { destroyed: boolean; writable: boolean; write: (buf: Buffer) => boolean },
  pcm8k: Buffer,
): boolean {
  if (socket.destroyed || pcm8k.length !== SLIN_CHUNK_BYTES) return true;
  return socket.write(AudioSocketProtocol.audio(pcm8k));
}
