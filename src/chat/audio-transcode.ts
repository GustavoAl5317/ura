// Converte o áudio gravado no navegador (webm/opus, mp4/aac — o que o
// MediaRecorder do atendente produzir) para OGG/Opus, o formato nativo de
// mensagem de voz do WhatsApp. Mesmo binário ffmpeg-static já usado pelo som
// de espera da URA — sem dependência nova.

import ffmpegPath from 'ffmpeg-static';
import { spawnSync } from 'child_process';
import { logger } from '../logger';

function ffmpegBinario(): string {
  return ffmpegPath || 'ffmpeg';
}

/**
 * Devolve null se a conversão falhar — quem chama cai no envio como arquivo comum.
 *
 * Sem fixar canal/taxa, o ffmpeg herda o que o navegador gravou e sai ESTÉREO.
 * O WhatsApp aceita subir esse arquivo, mas nota de voz é mono: no iPhone o
 * áudio chegava e não tocava ("Este áudio não está mais disponível"). Daí
 * `-ac 1` (mono) e `-ar 48000` (taxa nativa do Opus — a única que o libopus
 * aceita junto de 24k/16k). `-application voip` otimiza o codec para fala.
 */
export function paraOggOpus(buffer: Buffer): Buffer | null {
  const resultado = spawnSync(ffmpegBinario(), [
    '-hide_banner', '-loglevel', 'error',
    '-i', 'pipe:0',
    '-vn',
    '-map_metadata', '-1',          // metadado do navegador não serve de nada aqui
    '-ac', '1',                     // nota de voz é mono
    '-ar', '48000',                 // taxa nativa do Opus
    '-c:a', 'libopus',
    '-b:a', '32k',
    '-application', 'voip',         // perfil otimizado para fala
    '-f', 'ogg',
    'pipe:1',
  ], { input: buffer, maxBuffer: 32 * 1024 * 1024 });

  if (resultado.status !== 0 || !resultado.stdout?.length) {
    logger.error('[audio] falha ao converter gravação da atendente para OGG/Opus', {
      status: resultado.status,
      err: resultado.stderr?.toString().slice(0, 400) || resultado.error?.message,
    });
    return null;
  }
  logger.info('[audio] gravação da atendente convertida', {
    entrada: buffer.length, saida: resultado.stdout.length,
  });
  return resultado.stdout;
}
