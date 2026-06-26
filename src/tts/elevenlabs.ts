import axios from 'axios';
import { config } from '../config';
import { logger } from '../logger';
import { downsample16to8, downsample24to8 } from '../audio/resampler';

type DownsampleFn = (input: Buffer) => Buffer;

function createStreamProcessor(onPcm8k: (chunk: Buffer) => void, downsample: DownsampleFn, alignBytes: number) {
  let pending = Buffer.alloc(0);

  const push = (buf: Buffer): void => {
    const merged = Buffer.concat([pending, buf]);
    const aligned = merged.length - (merged.length % alignBytes);
    if (aligned < alignBytes) {
      pending = Buffer.from(merged);
      return;
    }
    onPcm8k(downsample(Buffer.from(merged.subarray(0, aligned))));
    pending = Buffer.from(merged.subarray(aligned));
  };

  const flush = (): void => {
    if (pending.length < 2) return;
    const padLen = pending.length % 2 === 0 ? pending.length : pending.length + 1;
    const pad = Buffer.alloc(padLen);
    pending.copy(pad);
    push(pad);
    pending = Buffer.alloc(0);
  };

  return { push, flush };
}

/** TTS em streaming — envia PCM 8 kHz conforme chega da ElevenLabs. */
export async function synthesizeStream(
  text: string,
  onPcm8k: (chunk: Buffer) => void,
  voiceId?: string,
): Promise<void> {
  const vid = voiceId ?? config.tts.elevenlabs.voiceId;
  if (!vid) throw new Error('ELEVENLABS_VOICE_ID não configurado');

  const fmt = config.tts.elevenlabs.outputFormat;
  const downsample = fmt === 'pcm_16000' ? downsample16to8 : downsample24to8;
  const alignBytes = fmt === 'pcm_16000' ? 4 : 6;

  const res = await axios.post(
    `https://api.elevenlabs.io/v1/text-to-speech/${vid}/stream`,
    {
      text,
      model_id: config.tts.elevenlabs.modelId,
      output_format: fmt,
      voice_settings: {
        stability: config.tts.elevenlabs.stability,
        similarity_boost: config.tts.elevenlabs.similarityBoost,
        style: 0.0,
        use_speaker_boost: config.tts.elevenlabs.speakerBoost,
      },
    },
    {
      headers: {
        'xi-api-key': config.tts.elevenlabs.apiKey,
        'Content-Type': 'application/json',
      },
      responseType: 'stream',
      timeout: 30_000,
    },
  );

  let bytesIn = 0;
  const { push, flush } = createStreamProcessor(onPcm8k, downsample, alignBytes);

  await new Promise<void>((resolve, reject) => {
    res.data.on('data', (chunk: Buffer) => {
      bytesIn += chunk.length;
      push(chunk);
    });
    res.data.on('end', () => {
      flush();
      logger.debug('ElevenLabs TTS stream', { chars: text.length, bytesIn, format: fmt });
      resolve();
    });
    res.data.on('error', reject);
  });
}

export async function synthesize(text: string, voiceId?: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  await synthesizeStream(text, (pcm8k) => chunks.push(pcm8k), voiceId);
  return Buffer.concat(chunks);
}
