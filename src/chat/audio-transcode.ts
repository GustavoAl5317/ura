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

/** Devolve null se a conversão falhar — quem chama cai no envio como arquivo comum. */
export function paraOggOpus(buffer: Buffer): Buffer | null {
  const resultado = spawnSync(ffmpegBinario(), [
    '-i', 'pipe:0',
    '-vn',
    '-c:a', 'libopus',
    '-b:a', '32k',
    '-f', 'ogg',
    'pipe:1',
  ], { input: buffer, maxBuffer: 32 * 1024 * 1024 });

  if (resultado.status !== 0 || !resultado.stdout?.length) {
    logger.error('[audio] falha ao converter gravação da atendente para OGG/Opus', {
      status: resultado.status,
      err: resultado.stderr?.toString().slice(0, 300) || resultado.error?.message,
    });
    return null;
  }
  return resultado.stdout;
}
