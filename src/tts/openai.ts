import axios from 'axios';
import { config } from '../config';
import { logger } from '../logger';
import { downsample24to8 } from '../audio/resampler';
import { isSpeechHttpUnavailable, markSpeechHttpUnavailable } from './circuit';

/** Poucas tentativas — se a conta bloqueia Speech (403), falha rápido. */
function voiceCandidates(preferred?: string, gender?: 'f' | 'm'): string[] {
  const female = preferred ? [preferred, 'coral', 'alloy'] : ['coral', 'alloy', 'shimmer'];
  const male = preferred ? [preferred, 'onyx', 'echo'] : ['onyx', 'echo', 'ash'];
  const base = gender === 'm' ? male : female;
  return [...new Set(base)].slice(0, 3);
}

function modelCandidates(): string[] {
  const preferred = config.tts.openaiSpeechModel || 'gpt-4o-mini-tts';
  return [...new Set([preferred, 'tts-1'])].slice(0, 2);
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
      timeout: 15_000,
    },
  );
  return Buffer.from(res.data);
}

/**
 * TTS OpenAI HTTP → PCM 24 kHz → 8 kHz.
 * Desligado por padrão (OPENAI_SPEECH_FALLBACK=0); muitas contas retornam 403.
 */
export async function synthesizeOpenAiStream(
  text: string,
  onPcm8k: (chunk: Buffer) => void,
  voice?: string,
  gender?: 'f' | 'm',
): Promise<void> {
  if (isSpeechHttpUnavailable()) {
    throw new Error('OpenAI Speech HTTP marcado como indisponível');
  }

  const voices = voiceCandidates(voice, gender);
  const models = modelCandidates();
  const t0 = Date.now();
  let lastErr: unknown;
  let saw403 = false;

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
        if (status === 403) saw403 = true;
        logger.warn('TTS OpenAI tentativa falhou', { voice: v, model, status, err: err?.message });
        if (status && ![400, 403, 404].includes(status)) throw err;
      }
    }
  }

  if (saw403) markSpeechHttpUnavailable('403 em todas as tentativas');
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
