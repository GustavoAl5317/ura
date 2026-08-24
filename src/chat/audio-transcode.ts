// Converte o áudio gravado no navegador (webm/opus, mp4/aac — o que o
// MediaRecorder do atendente produzir) para OGG/Opus, o formato nativo de
// mensagem de voz do WhatsApp. Mesmo binário ffmpeg-static já usado pelo som
// de espera da URA — sem dependência nova.

import ffmpegPath from 'ffmpeg-static';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { logger } from '../logger';

function ffmpegBinario(): string {
  return ffmpegPath || 'ffmpeg';
}

/**
 * Com DEBUG_AUDIO=1 guarda a gravação recebida e a convertida em /tmp, para
 * inspecionar com `ffmpeg -i` quando o áudio não toca no aparelho do cliente.
 * Sem isso a investigação vira adivinhação — o arquivo some depois do envio.
 */
function guardarParaDebug(nome: string, dados: Buffer): void {
  if (process.env.DEBUG_AUDIO !== '1') return;
  try {
    const arquivo = path.join('/tmp', `ura-audio-${Date.now()}-${nome}`);
    fs.writeFileSync(arquivo, dados);
    logger.info('[audio] amostra salva para diagnóstico', { arquivo, bytes: dados.length });
  } catch (err) {
    logger.warn('[audio] não consegui salvar amostra de debug', { err: String(err) });
  }
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
/**
 * Alternativa ao OGG//Opus: AAC em contêiner MP4 (.m4a).
 *
 * O OGG deveria funcionar (é o formato nativo de nota de voz do WhatsApp) mas,
 * neste ambiente, o áudio toca no WhatsApp Web e o player nativo do iPhone
 * recusa com "Este áudio não está mais disponível" — inclusive depois de
 * corrigir mono/taxa e de declarar `codecs=opus`. AAC é decodificado pelo
 * próprio iOS, então funciona onde o Opus falha. O custo: aparece como áudio
 * anexado, sem a forma de onda de mensagem de voz.
 */
export function paraM4aAac(buffer: Buffer): Buffer | null {
  guardarParaDebug('entrada.bin', buffer);
  const resultado = spawnSync(ffmpegBinario(), [
    '-hide_banner', '-loglevel', 'error',
    '-i', 'pipe:0',
    '-vn',
    '-map_metadata', '-1',
    '-ac', '1',
    '-ar', '44100',                 // taxa que o AAC e o iOS tratam bem
    '-c:a', 'aac',
    '-b:a', '64k',
    // MP4 em pipe exige fragmentação: o contêiner normal precisa voltar ao
    // início para gravar o índice (moov), o que não dá para fazer em stream.
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    '-f', 'mp4',
    'pipe:1',
  ], { input: buffer, maxBuffer: 32 * 1024 * 1024 });

  if (resultado.status !== 0 || !resultado.stdout?.length) {
    logger.error('[audio] falha ao converter gravação da atendente para M4A/AAC', {
      status: resultado.status,
      err: resultado.stderr?.toString().slice(0, 400) || resultado.error?.message,
    });
    return null;
  }
  guardarParaDebug('saida.m4a', resultado.stdout);
  logger.info('[audio] gravação da atendente convertida (m4a)', {
    entrada: buffer.length, saida: resultado.stdout.length,
  });
  return resultado.stdout;
}

export function paraOggOpus(buffer: Buffer): Buffer | null {
  guardarParaDebug('entrada.bin', buffer);
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
  guardarParaDebug('saida.ogg', resultado.stdout);
  logger.info('[audio] gravação da atendente convertida', {
    entrada: buffer.length, saida: resultado.stdout.length,
  });
  return resultado.stdout;
}
