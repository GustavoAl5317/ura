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

/** 24 kHz → 8 kHz (downsample ÷3, average 3 samples) */
export function downsample24to8(input: Buffer): Buffer {
  const n = Math.floor(input.length / 6);
  const out = Buffer.allocUnsafe(n * 2);

  for (let i = 0; i < n; i++) {
    const base = i * 6;
    const s0 = input.readInt16LE(base);
    const s1 = input.readInt16LE(base + 2);
    const s2 = input.readInt16LE(base + 4);
    out.writeInt16LE(clamp(Math.round((s0 + s1 + s2) / 3)), i * 2);
  }

  return out;
}

/** 16 kHz → 8 kHz (downsample ÷2, average 2 samples) */
export function downsample16to8(input: Buffer): Buffer {
  const n = Math.floor(input.length / 4);
  const out = Buffer.allocUnsafe(n * 2);

  for (let i = 0; i < n; i++) {
    const s0 = input.readInt16LE(i * 4);
    const s1 = input.readInt16LE(i * 4 + 2);
    out.writeInt16LE(clamp(Math.round((s0 + s1) / 2)), i * 2);
  }

  return out;
}
