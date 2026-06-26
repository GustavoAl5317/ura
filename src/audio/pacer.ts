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
  /** Limite máximo da fila (ms) — só aplica em streaming ao vivo (chunks pequenos) */
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
  private underrunTicks = 0;
  private idleTicks = 0;
  private micMuteUntil = 0;
  private lastFrame = SILENCE_CHUNK;
  private hasLastFrame = false;
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
    this.underrunTicks = 0;
    this.idleTicks = 0;
    this.micMuteUntil = 0;
    this.lastFrame = SILENCE_CHUNK;
    this.hasLastFrame = false;
  }

  flush(): void {
    this.queue = [];
    this.remainder = Buffer.alloc(0);
    this.streaming = false;
    this.primed = false;
    this.underrun = false;
    this.underrunTicks = 0;
    this.idleTicks = 0;
    this.micMuteUntil = 0;
    this.lastFrame = SILENCE_CHUNK;
    this.hasLastFrame = false;
  }

  isPlaying(): boolean {
    return this.holdStream || this.queue.length > 0 || this.streaming;
  }

  /**
   * @param streaming true = chunks ao vivo (OpenAI); aplica teto de latência na fila
   */
  enqueue(pcm8k: Buffer, streaming = false): void {
    if (!pcm8k.length) return;

    const beforeLen = this.queue.length;

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

    // Só limita fila em streaming ao vivo — bulk TTS (ElevenLabs) não pode cortar o início
    if (
      streaming
      && this.maxBufferChunks > 0
      && beforeLen > 0
      && this.queue.length > this.maxBufferChunks
    ) {
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

  /** Só janela anti-eco pós-fala — permite barge-in durante TTS (ElevenLabs). */
  isEchoGated(): boolean {
    return Date.now() < this.micMuteUntil;
  }

  /** Aguarda a fila esvaziar (útil após TTS em streaming). */
  async drain(timeoutMs = 120_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.queue.length > 0 || this.remainder.length > 0) {
      if (Date.now() > deadline) return;
      await new Promise((r) => setTimeout(r, 40));
    }
    await new Promise((r) => setTimeout(r, SLIN_TICK_MS * 2));
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

      this.onTick();
      this.nextTickAt += SLIN_TICK_MS;

      if (Date.now() - this.nextTickAt > SLIN_TICK_MS * 6) {
        this.nextTickAt = Date.now() + SLIN_TICK_MS;
      }

      this.scheduleTick();
    }, delay);
  }

  private onTick(): void {
    const active = this.streaming || this.holdStream;
    if (!active) return;

    const required = this.requiredBufferChunks();
    const gated = required > 0 && this.queue.length < required;

    if (!gated && required > 0) {
      this.primed = true;
      this.underrun = false;
      this.underrunTicks = 0;
    }

    let out: Buffer;
    let dequeued = false;

    if (gated) {
      out = SILENCE_CHUNK;
    } else {
      const hadQueuedAudio = this.queue.length > 0;
      const frame = this.queue.shift();
      if (frame) {
        out = frame;
        dequeued = true;
        this.lastFrame = Buffer.from(frame);
        this.hasLastFrame = true;
        this.underrun = false;
        this.underrunTicks = 0;
        if (hadQueuedAudio && this.queue.length === 0) {
          this.armMicMute();
        }
      } else {
        this.underrun = true;
        this.underrunTicks++;
        const hold = this.holdStream && this.hasLastFrame && this.underrunTicks <= 2;
        out = hold ? this.lastFrame : SILENCE_CHUNK;
      }
    }

    if (!this.write(out)) {
      if (dequeued) this.queue.unshift(out);
    }

    if (dequeued || gated || this.underrun) {
      this.streaming = true;
      this.idleTicks = gated ? 0 : (dequeued ? 0 : this.idleTicks + 1);
    }

    if (!this.holdStream && !dequeued && !gated && this.idleTicks >= 30) {
      this.streaming = false;
      this.primed = false;
      this.underrun = false;
      this.idleTicks = 0;
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
