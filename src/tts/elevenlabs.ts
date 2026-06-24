import axios from 'axios';
import { config } from '../config';
import { logger } from '../logger';
import { downsample16to8 } from '../audio/resampler';

export async function synthesize(text: string, voiceId?: string): Promise<Buffer> {
  const vid = voiceId ?? config.tts.elevenlabs.voiceId;
  if (!vid) throw new Error('ELEVENLABS_VOICE_ID não configurado');

  const res = await axios.post(
    `https://api.elevenlabs.io/v1/text-to-speech/${vid}/stream`,
    {
      text,
      model_id: config.tts.elevenlabs.modelId,
      output_format: 'pcm_16000',
      voice_settings: {
        stability: 0.50,
        similarity_boost: 0.75,
        style: 0.0,
        use_speaker_boost: true,
      },
    },
    {
      headers: {
        'xi-api-key': config.tts.elevenlabs.apiKey,
        'Content-Type': 'application/json',
      },
      responseType: 'arraybuffer',
      timeout: 30_000,
    },
  );

  const pcm16k = Buffer.from(res.data as ArrayBuffer);
  const pcm8k = downsample16to8(pcm16k);

  logger.debug('ElevenLabs TTS', {
    chars: text.length,
    bytes16k: pcm16k.length,
    bytes8k: pcm8k.length,
  });

  return pcm8k;
}
