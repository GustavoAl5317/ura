// Gera buffer PCM 8kHz 16-bit mono para tocar enquanto a IA consulta APIs.
// Tom suave tipo "processando" — um tique curto a cada segundo.

const SAMPLE_RATE = 8000;

function sine(freq: number, durationMs: number, amplitude: number): Buffer {
  const n = Math.floor(SAMPLE_RATE * durationMs / 1000);
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    // Envelope: ataque rápido, decaimento suave
    const env = Math.exp(-i / (SAMPLE_RATE * 0.05));
    const v = Math.round(env * amplitude * Math.sin(2 * Math.PI * freq * t));
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, v)), i * 2);
  }
  return buf;
}

function silence(durationMs: number): Buffer {
  return Buffer.alloc(Math.floor(SAMPLE_RATE * durationMs / 1000) * 2);
}

// Tique a 700Hz (50ms) + silêncio (950ms) = loop de 1 segundo
export const PROCESSING_TONE: Buffer = Buffer.concat([
  sine(700, 50, 4000),
  silence(950),
]);
