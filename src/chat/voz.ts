// Resposta em áudio no chat: só quando o cliente mandou áudio.
//
// A síntese da URA de voz devolve PCM para telefonia; o WhatsApp quer
// OGG/Opus. Aqui o texto vira MP3 na ElevenLabs e o ffmpeg converte para
// OGG/Opus mono 48 kHz, que é o formato de mensagem de voz do WhatsApp.

import { spawn } from 'child_process';
import axios from 'axios';
import ffmpegPath from 'ffmpeg-static';
import { config } from '../config';
import { logger } from '../logger';

/** Texto longo vira áudio arrastado e caro — acima disto responde por escrito. */
const MAX_CHARS_AUDIO = 700;

/** Emoji e markdown do WhatsApp são lidos em voz alta — limpa antes de sintetizar. */
function limparParaFala(texto: string): string {
  return texto
    .replace(/[*_~`]/g, '')
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/https?:\/\/\S+/g, 'o link que enviei')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{2,}/g, '. ')
    .replace(/\n/g, '. ')
    .trim();
}

async function mp3ParaOggOpus(mp3: Buffer): Promise<Buffer | null> {
  const bin = ffmpegPath as unknown as string | null;
  if (!bin) {
    logger.error('[voz] ffmpeg-static indisponível');
    return null;
  }
  return new Promise((resolve) => {
    const ff = spawn(bin, [
      '-hide_banner', '-loglevel', 'error',
      '-i', 'pipe:0',
      '-c:a', 'libopus', '-b:a', '32k', '-ar', '48000', '-ac', '1',
      '-f', 'ogg', 'pipe:1',
    ]);

    const saida: Buffer[] = [];
    let erro = '';
    ff.stdout.on('data', (d: Buffer) => saida.push(d));
    ff.stderr.on('data', (d: Buffer) => { erro += d.toString(); });
    ff.on('error', (e) => {
      logger.error('[voz] falha ao executar ffmpeg', { err: e.message });
      resolve(null);
    });
    ff.on('close', (code) => {
      if (code !== 0 || !saida.length) {
        logger.error('[voz] ffmpeg falhou', { code, erro: erro.slice(0, 300) });
        resolve(null);
        return;
      }
      resolve(Buffer.concat(saida));
    });

    ff.stdin.on('error', () => undefined);   // evita EPIPE se o ffmpeg morrer antes
    ff.stdin.end(mp3);
  });
}

/**
 * Converte a resposta em áudio de mensagem de voz do WhatsApp.
 * Retorna null quando não deve/não dá para responder em áudio — quem chama
 * cai no texto, que é sempre o caminho seguro.
 */
export async function sintetizarParaWhatsapp(
  texto: string,
  voiceId?: string,
): Promise<Buffer | null> {
  const chave = config.tts.elevenlabs.apiKey;
  const voz = voiceId || config.tts.elevenlabs.voiceId;
  if (!chave || !voz) {
    logger.warn('[voz] ElevenLabs sem chave ou voz configurada');
    return null;
  }

  const fala = limparParaFala(texto);
  if (!fala) return null;
  if (fala.length > MAX_CHARS_AUDIO) {
    logger.info('[voz] resposta longa demais para áudio, enviando texto', { chars: fala.length });
    return null;
  }

  try {
    const res = await axios.post<ArrayBuffer>(
      `https://api.elevenlabs.io/v1/text-to-speech/${voz}`,
      {
        text: fala,
        model_id: config.tts.elevenlabs.modelId,
        voice_settings: {
          stability: config.tts.elevenlabs.stability,
          similarity_boost: config.tts.elevenlabs.similarityBoost,
          use_speaker_boost: config.tts.elevenlabs.speakerBoost,
        },
      },
      {
        params: { output_format: 'mp3_44100_128' },
        headers: { 'xi-api-key': chave, 'Content-Type': 'application/json' },
        responseType: 'arraybuffer',
        timeout: 25_000,
      },
    );

    const ogg = await mp3ParaOggOpus(Buffer.from(res.data));
    if (ogg) logger.info('[voz] áudio gerado', { chars: fala.length, bytes: ogg.length });
    return ogg;
  } catch (err: unknown) {
    const e = err as { response?: { status?: number }; message?: string };
    logger.error('[voz] falha na síntese', { status: e.response?.status, err: e.message });
    return null;
  }
}
