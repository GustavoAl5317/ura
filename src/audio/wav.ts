/** Lê WAV PCM 16-bit (mono ou stereo) e retorna PCM cru + taxa de amostragem. */
export function parseWavPcm(wav: Buffer): { pcm: Buffer; sampleRate: number; channels: number } {
  if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Arquivo não é WAV válido');
  }

  let offset = 12;
  let sampleRate = 0;
  let channels = 1;
  let bitsPerSample = 16;
  let audioFormat = 1;
  let dataOffset = -1;
  let dataSize = 0;

  while (offset + 8 <= wav.length) {
    const chunkId = wav.toString('ascii', offset, offset + 4);
    const chunkSize = wav.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;

    if (chunkId === 'fmt ') {
      audioFormat = wav.readUInt16LE(chunkStart);
      channels = wav.readUInt16LE(chunkStart + 2);
      sampleRate = wav.readUInt32LE(chunkStart + 4);
      bitsPerSample = wav.readUInt16LE(chunkStart + 14);
    } else if (chunkId === 'data') {
      dataOffset = chunkStart;
      dataSize = chunkSize;
    }

    offset = chunkStart + chunkSize + (chunkSize % 2);
  }

  if (audioFormat !== 1 || bitsPerSample !== 16) {
    throw new Error('Som de espera: use WAV PCM 16-bit (converta MP3 com ffmpeg)');
  }
  if (dataOffset < 0 || dataSize <= 0) {
    throw new Error('WAV sem chunk de dados');
  }

  let pcm = wav.subarray(dataOffset, dataOffset + dataSize);

  if (channels === 2) {
    const mono = Buffer.allocUnsafe(pcm.length / 2);
    for (let i = 0; i < mono.length; i += 2) {
      const l = pcm.readInt16LE(i * 2);
      const r = pcm.readInt16LE(i * 2 + 2);
      mono.writeInt16LE(Math.round((l + r) / 2), i);
    }
    pcm = mono;
  } else if (channels !== 1) {
    throw new Error(`WAV com ${channels} canais não suportado`);
  }

  return { pcm: Buffer.from(pcm), sampleRate, channels: 1 };
}
