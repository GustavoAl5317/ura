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

function clamp(n: number): number {
  return n < -32768 ? -32768 : n > 32767 ? 32767 : n;
}

// Clique curto simulando tecla de teclado (40ms)
function keyClick(amplitude = 2200): Buffer {
  const n = Math.floor(SAMPLE_RATE * 0.04);
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const env = Math.exp(-i / (SAMPLE_RATE * 0.006));
    const t = i / SAMPLE_RATE;
    const v = env * amplitude * (
      Math.sin(2 * Math.PI * 1800 * t) * 0.6 +
      Math.sin(2 * Math.PI * 3200 * t) * 0.4
    );
    buf.writeInt16LE(clamp(Math.round(v)), i * 2);
  }
  return buf;
}

function buildKeyboardLoop(): Buffer {
  // Padrão irregular de cliques + pausas — simula digitação humana (~2,5s por loop)
  const gapsMs = [120, 90, 140, 320, 100, 110, 280, 85, 130, 380];
  const parts: Buffer[] = [];
  for (let i = 0; i < gapsMs.length; i++) {
    parts.push(keyClick(i % 3 === 0 ? 2400 : 1800));
    parts.push(silence(gapsMs[i]));
  }
  return Buffer.concat(parts);
}

// Tique a 700Hz (50ms) + silêncio (950ms) = loop de 1 segundo
export const PROCESSING_TONE: Buffer = Buffer.concat([
  sine(700, 50, 4000),
  silence(950),
]);

// Som de digitação em loop — toca enquanto a IA consulta ferramentas
export const KEYBOARD_TYPING: Buffer = buildKeyboardLoop();
