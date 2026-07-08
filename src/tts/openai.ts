import axios from 'axios';
import { config } from '../config';
import { logger } from '../logger';
import { downsample24to8 } from '../audio/resampler';

/**
 * TTS OpenAI HTTP (gpt-4o-mini-tts / tts-1) → PCM 24 kHz → downsample 8 kHz.
 * Usado como fallback quando ElevenLabs fica sem crédito ou retorna 401.
 */
export async function synthesizeOpenAiStream(
  text: string,
  onPcm8k: (chunk: Buffer) => void,
  voice?: string,
): Promise<void> {
  const v = voice || config.openai.voice || 'marin';
  const model = config.tts.openaiSpeechModel;
  const t0 = Date.now();

  const res = await axios.post(
    'https://api.openai.com/v1/audio/speech',
    {
      model,
      input: text,
      voice: v,
      response_format: 'pcm',
    },
    {
      headers: {
        Authorization: `Bearer ${config.openai.apiKey}`,
        'Content-Type': 'application/json',
      },
      responseType: 'arraybuffer',
      timeout: 30_000,
    },
  );

  const pcm24 = Buffer.from(res.data);
  logger.info('TTS OpenAI HTTP ok', {
    voice: v,
    model,
    bytes: pcm24.length,
    elapsedMs: Date.now() - t0,
  });

  // pcm 24kHz 16-bit mono — envia em fatias para o pacer
  const pcm8 = downsample24to8(pcm24);
  const SLICE = 640; // 40ms @ 8kHz
  for (let i = 0; i < pcm8.length; i += SLICE) {
    onPcm8k(pcm8.subarray(i, Math.min(i + SLICE, pcm8.length)));
  }
}

export async function synthesizeOpenAi(text: string, voice?: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  await synthesizeOpenAiStream(text, (c) => chunks.push(c), voice);
  return Buffer.concat(chunks);
}
