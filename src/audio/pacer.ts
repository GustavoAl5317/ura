import { AudioSocketProtocol } from '../audiosocket/protocol';

export const SLIN_CHUNK_BYTES = 320; // 20 ms @ 8 kHz 16-bit mono
export const SLIN_TICK_MS = 20;
export const SILENCE_CHUNK = Buffer.alloc(SLIN_CHUNK_BYTES);

export interface AudioPacerOptions {
  /** Pré-buffer inicial (ms) — aguarda fila encher antes de começar a tocar */
  preBufferMs: number;
  /** Pré-buffer extra no início de cada bloco (ms) — usa o maior entre pre e start */
  startBufferMs?: number;
  /** Após underrun, exige este mínimo na fila antes de retomar (ms) */
  minBufferMs?: number;
  /** Limite máximo da fila (ms) — descarta frames antigos se exceder */
  maxBufferMs?: number;
  /** Janela anti-eco após a fala (ms) */
  inputMuteMs?: number;
}

/** Pacer de saída: 1 frame SLIN a cada 20 ms, clock estável para o Asterisk. */
export class AudioPacer {
  private queue: Buffer[] = [];
  private remainder = Buffer.alloc(0);
  private timer: ReturnType<typeof setTimeout> | null = null;
  private ticking = false;
  private nextTickAt = 0;
  private streaming = false;
  private holdStream = false;
  private primed = false;
  private underrun = false;
  private idleTicks = 0;
  private micMuteUntil = 0;
  private readonly startBufferChunks: number;
  private readonly minBufferChunks: number;
  private readonly maxBufferChunks: number;
  private readonly inputMuteMs: number;

  constructor(
    private readonly write: (frame: Buffer) => boolean,
    opts: AudioPacerOptions,
  ) {
    const startMs = Math.max(opts.preBufferMs, opts.startBufferMs ?? 0);
    this.startBufferChunks = Math.max(0, Math.ceil(startMs / SLIN_TICK_MS));
    this.minBufferChunks = Math.max(0, Math.ceil((opts.minBufferMs ?? 0) / SLIN_TICK_MS));
    this.maxBufferChunks = Math.max(0, Math.ceil((opts.maxBufferMs ?? 0) / SLIN_TICK_MS));
    this.inputMuteMs = opts.inputMuteMs ?? 1500;
  }

  start(): void {
    if (this.ticking) return;
    this.ticking = true;
    this.nextTickAt = Date.now() + SLIN_TICK_MS;
    this.scheduleTick();
  }

  stop(): void {
    this.ticking = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.queue = [];
    this.remainder = Buffer.alloc(0);
    this.streaming = false;
    this.holdStream = false;
    this.primed = false;
    this.underrun = false;
    this.idleTicks = 0;
    this.micMuteUntil = 0;
  }

  flush(): void {
    this.queue = [];
    this.remainder = Buffer.alloc(0);
    this.streaming = false;
    this.primed = false;
    this.underrun = false;
    this.idleTicks = 0;
    this.micMuteUntil = 0;
  }

  isPlaying(): boolean {
    return this.holdStream || this.queue.length > 0 || this.streaming;
  }

  enqueue(pcm8k: Buffer): void {
    if (!pcm8k.length) return;

    const combined = Buffer.concat([this.remainder, pcm8k]);
    const fullChunks = Math.floor(combined.length / SLIN_CHUNK_BYTES);
    for (let i = 0; i < fullChunks; i++) {
      const start = i * SLIN_CHUNK_BYTES;
      this.queue.push(combined.subarray(start, start + SLIN_CHUNK_BYTES));
    }

    const consumed = fullChunks * SLIN_CHUNK_BYTES;
    this.remainder = consumed < combined.length
      ? Buffer.from(combined.subarray(consumed))
      : Buffer.alloc(0);

    if (this.maxBufferChunks > 0 && this.queue.length > this.maxBufferChunks) {
      this.queue.splice(0, this.queue.length - this.maxBufferChunks);
    }

    if (this.underrun && this.primed) {
      this.primed = false;
    }

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
      this.underrun = false;
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

  private requiredBufferChunks(): number {
    if (!this.primed) return this.startBufferChunks;
    if (this.underrun && this.minBufferChunks > 0) return this.minBufferChunks;
    return 0;
  }

  private scheduleTick(): void {
    if (!this.ticking) return;
    const delay = Math.max(0, this.nextTickAt - Date.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.ticking) return;
      const now = Date.now();
      const lateMs = now - this.nextTickAt;
      const catchUp = lateMs > SLIN_TICK_MS
        ? Math.min(3, Math.floor(lateMs / SLIN_TICK_MS))
        : 1;

      for (let i = 0; i < catchUp; i++) {
        this.onTick();
        this.nextTickAt += SLIN_TICK_MS;
      }

      if (now - this.nextTickAt > SLIN_TICK_MS * 4) {
        this.nextTickAt = now + SLIN_TICK_MS;
      }

      if (this.ticking) this.scheduleTick();
    }, delay);
  }

  private onTick(): void {
    const active = this.streaming || this.holdStream;

    const required = this.requiredBufferChunks();
    if (active && required > 0 && this.queue.length < required) {
      return;
    }
    if (active && required > 0) {
      this.primed = true;
      this.underrun = false;
    }

    const hadQueuedAudio = this.queue.length > 0;
    const frame = this.queue.shift();
    if (frame) {
      if (!this.write(frame)) {
        this.queue.unshift(frame);
      }
      this.streaming = true;
      this.idleTicks = 0;
      this.underrun = false;
      if (hadQueuedAudio && this.queue.length === 0) {
        this.armMicMute();
      }
      return;
    }

    if (active) {
      this.underrun = true;
      if (!this.write(SILENCE_CHUNK)) return;
      this.idleTicks++;
      if (!this.holdStream && this.idleTicks >= 30) {
        this.streaming = false;
        this.primed = false;
        this.underrun = false;
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
