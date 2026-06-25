/** Guarda áudio do microfone enquanto a saída está bloqueada — evita perder a fala do cliente. */
export class MicRingBuffer {
  private chunks: Buffer[] = [];
  private totalBytes = 0;

  constructor(private readonly maxBytes: number) {}

  push(pcm: Buffer): void {
    if (!pcm.length) return;
    this.chunks.push(pcm);
    this.totalBytes += pcm.length;
    while (this.totalBytes > this.maxBytes && this.chunks.length > 0) {
      const dropped = this.chunks.shift()!;
      this.totalBytes -= dropped.length;
    }
  }

  drain(send: (pcm: Buffer) => void): void {
    if (!this.chunks.length) return;
    for (const chunk of this.chunks) send(chunk);
    this.chunks = [];
    this.totalBytes = 0;
  }

  get length(): number {
    return this.totalBytes;
  }
}
