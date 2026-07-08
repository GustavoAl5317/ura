import axios from 'axios';
import { config } from '../config';
import { logger } from '../logger';
import { downsample24to8 } from '../audio/resampler';

/** Vozes seguras para /v1/audio/speech (gpt-4o-mini-tts / tts-1). */
function voiceCandidates(preferred?: string, gender?: 'f' | 'm'): string[] {
  const female = ['marin', 'coral', 'shimmer', 'sage', 'alloy'];
  const male = ['cedar', 'onyx', 'echo', 'ash', 'alloy'];
  const base = gender === 'm' ? male : female;
  const list = preferred ? [preferred, ...base.filter((v) => v !== preferred)] : base;
  return [...new Set(list)];
}

function modelCandidates(): string[] {
  const preferred = config.tts.openaiSpeechModel || 'gpt-4o-mini-tts';
  return [...new Set([preferred, 'gpt-4o-mini-tts', 'tts-1-hd', 'tts-1'])];
}

async function requestSpeech(text: string, voice: string, model: string): Promise<Buffer> {
  const res = await axios.post(
    'https://api.openai.com/v1/audio/speech',
    {
      model,
      input: text,
      voice,
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
  return Buffer.from(res.data);
}

/**
 * TTS OpenAI HTTP → PCM 24 kHz → 8 kHz.
 * Tenta várias vozes/modelos (403 em marin/cedar em algumas contas).
 */
export async function synthesizeOpenAiStream(
  text: string,
  onPcm8k: (chunk: Buffer) => void,
  voice?: string,
  gender?: 'f' | 'm',
): Promise<void> {
  const voices = voiceCandidates(voice, gender);
  const models = modelCandidates();
  const t0 = Date.now();
  let lastErr: unknown;

  for (const model of models) {
    for (const v of voices) {
      try {
        const pcm24 = await requestSpeech(text, v, model);
        logger.info('TTS OpenAI HTTP ok', {
          voice: v,
          model,
          bytes: pcm24.length,
          elapsedMs: Date.now() - t0,
        });
        const pcm8 = downsample24to8(pcm24);
        const SLICE = 640;
        for (let i = 0; i < pcm8.length; i += SLICE) {
          onPcm8k(pcm8.subarray(i, Math.min(i + SLICE, pcm8.length)));
        }
        return;
      } catch (err: any) {
        lastErr = err;
        const status = err?.response?.status;
        logger.warn('TTS OpenAI tentativa falhou', { voice: v, model, status, err: err?.message });
        if (status && ![400, 403, 404].includes(status)) throw err;
      }
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr ?? 'OpenAI Speech falhou'));
}

export async function synthesizeOpenAi(
  text: string,
  voice?: string,
  gender?: 'f' | 'm',
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  await synthesizeOpenAiStream(text, (c) => chunks.push(c), voice, gender);
  return Buffer.concat(chunks);
}
