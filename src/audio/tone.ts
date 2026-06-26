// Sons de espera PCM 8 kHz 16-bit mono — otimizados para telefonia (AudioSocket/Asterisk).

const SAMPLE_RATE = 8000;

function silence(durationMs: number): Buffer {
  return Buffer.alloc(Math.floor(SAMPLE_RATE * durationMs / 1000) * 2);
}

function clamp(n: number): number {
  return n < -32768 ? -32768 : n > 32767 ? 32767 : n;
}

// Clique de tecla — frequências altas cortam melhor em 8 kHz e soam como digitação
function keyClick(amplitude = 9000): Buffer {
  const n = Math.floor(SAMPLE_RATE * 0.035);
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const env = Math.exp(-i / (SAMPLE_RATE * 0.004));
    const t = i / SAMPLE_RATE;
    const v = env * amplitude * (
      Math.sin(2 * Math.PI * 2000 * t) * 0.5 +
      Math.sin(2 * Math.PI * 3400 * t) * 0.35 +
      (Math.random() * 2 - 1) * 0.08
    );
    buf.writeInt16LE(clamp(Math.round(v)), i * 2);
  }
  return buf;
}

function buildKeyboardLoop(): Buffer {
  // Ritmo irregular — simula alguém digitando em sistema (~3s por loop)
  const gapsMs = [80, 60, 95, 250, 70, 85, 220, 55, 90, 300, 75, 110, 280, 65, 100];
  const parts: Buffer[] = [];
  for (let i = 0; i < gapsMs.length; i++) {
    parts.push(keyClick(i % 4 === 0 ? 10_500 : i % 2 === 0 ? 9500 : 8500));
    parts.push(silence(gapsMs[i]));
  }
  return Buffer.concat(parts);
}

// Som de digitação em loop — toca enquanto a IA consulta ferramentas ou gera TTS
export const KEYBOARD_TYPING: Buffer = buildKeyboardLoop();
