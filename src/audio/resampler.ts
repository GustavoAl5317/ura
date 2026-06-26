// PCM resampling for the audio pipeline
//
// Asterisk AudioSocket   → slin: 8 kHz, 16-bit signed LE, mono
// OpenAI Realtime input  → pcm16: 24 kHz, 16-bit signed LE, mono
// ElevenLabs output      → pcm_16000: 16 kHz, 16-bit signed LE, mono

function clamp(n: number): number {
  return n < -32768 ? -32768 : n > 32767 ? 32767 : n;
}

/** 8 kHz → 24 kHz (upsample ×3, linear interpolation) */
export function upsample8to24(input: Buffer): Buffer {
  const n = input.length >> 1;
  const out = Buffer.allocUnsafe(n * 3 * 2);

  for (let i = 0; i < n; i++) {
    const s0 = input.readInt16LE(i * 2);
    const s1 = i + 1 < n ? input.readInt16LE((i + 1) * 2) : s0;
    const d = s1 - s0;
    out.writeInt16LE(s0,                               i * 6);
    out.writeInt16LE(clamp(s0 + Math.round(d / 3)),   i * 6 + 2);
    out.writeInt16LE(clamp(s0 + Math.round(d * 2 / 3)), i * 6 + 4);
  }

  return out;
}

/** 24 kHz → 8 kHz (decimação ÷3 com filtro passa-baixa 5-tap — reduz chiado) */
export function downsample24to8(input: Buffer): Buffer {
  const samples = input.length >> 1;
  const outSamples = Math.floor(samples / 3);
  const out = Buffer.allocUnsafe(outSamples * 2);

  const at = (idx: number): number => {
    const clamped = idx < 0 ? 0 : idx >= samples ? samples - 1 : idx;
    return input.readInt16LE(clamped * 2);
  };

  for (let i = 0; i < outSamples; i++) {
    const c = i * 3;
    const v = at(c - 1) + at(c) * 2 + at(c + 1) * 3 + at(c + 2) * 2 + at(c + 3);
    out.writeInt16LE(clamp(Math.round(v / 9)), i * 2);
  }

  return out;
}

/** 16 kHz → 8 kHz (decimação ÷2 com filtro passa-baixa 5-tap) */
export function downsample16to8(input: Buffer): Buffer {
  const samples = input.length >> 1;
  const outSamples = Math.floor(samples / 2);
  const out = Buffer.allocUnsafe(outSamples * 2);

  const at = (idx: number): number => {
    const clamped = idx < 0 ? 0 : idx >= samples ? samples - 1 : idx;
    return input.readInt16LE(clamped * 2);
  };

  for (let i = 0; i < outSamples; i++) {
    const c = i * 2;
    const v = at(c - 1) + at(c) * 2 + at(c + 1) * 3 + at(c + 2) * 2 + at(c + 3);
    out.writeInt16LE(clamp(Math.round(v / 9)), i * 2);
  }

  return out;
}
