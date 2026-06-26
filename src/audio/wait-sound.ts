import fs from 'fs/promises';
import path from 'path';
import { spawnSync } from 'child_process';
import axios from 'axios';
import ffmpegPath from 'ffmpeg-static';
import { config } from '../config';
import { logger } from '../logger';
import { downsample16to8, downsample24to8 } from './resampler';
import { parseWavPcm } from './wav';
import { KEYBOARD_TYPING } from './tone';

let waitSound: Buffer = KEYBOARD_TYPING;

const MP3_EXT = /\.mp3$/i;
const WAV_EXT = /\.wav$/i;

function clamp(n: number): number {
  return n < -32768 ? -32768 : n > 32767 ? 32767 : n;
}

function resampleLinearTo8k(pcm: Buffer, sampleRate: number): Buffer {
  const inSamples = pcm.length >> 1;
  if (inSamples === 0) return Buffer.alloc(0);
  if (sampleRate === 8000) return pcm;

  const outSamples = Math.max(1, Math.floor(inSamples * 8000 / sampleRate));
  const out = Buffer.allocUnsafe(outSamples * 2);

  const read = (idx: number): number => {
    const clamped = idx < 0 ? 0 : idx >= inSamples ? inSamples - 1 : idx;
    return pcm.readInt16LE(clamped * 2);
  };

  for (let i = 0; i < outSamples; i++) {
    const src = (i * sampleRate) / 8000;
    const i0 = Math.floor(src);
    const frac = src - i0;
    const v = read(i0) * (1 - frac) + read(i0 + 1) * frac;
    out.writeInt16LE(clamp(Math.round(v)), i * 2);
  }

  return out;
}

function toPcm8k(pcm: Buffer, sampleRate: number): Buffer {
  if (sampleRate === 8000) return pcm;
  if (sampleRate === 16000) return downsample16to8(pcm);
  if (sampleRate === 24000) return downsample24to8(pcm);
  return resampleLinearTo8k(pcm, sampleRate);
}

function ffmpegBinary(): string {
  return ffmpegPath || 'ffmpeg';
}

function decodeToWav(inputPath: string): Buffer;
function decodeToWav(inputBytes: Buffer, ext: string): Buffer;
function decodeToWav(input: string | Buffer, ext = '.mp3'): Buffer {
  const args = [
    '-nostdin',
    '-loglevel',
    'error',
    '-i',
    typeof input === 'string' ? input : 'pipe:0',
    '-ar',
    '8000',
    '-ac',
    '1',
    '-f',
    'wav',
    'pipe:1',
  ];

  const result = spawnSync(ffmpegBinary(), args, {
    input: typeof input === 'string' ? undefined : input,
    maxBuffer: 15 * 1024 * 1024,
  });

  if (result.error || result.status !== 0) {
    const detail = result.stderr?.toString().trim() || result.error?.message || 'ffmpeg falhou';
    throw new Error(detail);
  }

  return result.stdout;
}

async function loadWavBytes(data: Buffer): Promise<Buffer> {
  const { pcm, sampleRate } = parseWavPcm(data);
  return toPcm8k(pcm, sampleRate);
}

async function loadAudioBytes(data: Buffer, nameHint: string): Promise<Buffer> {
  if (WAV_EXT.test(nameHint)) {
    return loadWavBytes(data);
  }
  if (MP3_EXT.test(nameHint)) {
    const wav = decodeToWav(data, '.mp3');
    return loadWavBytes(wav);
  }
  throw new Error('Formato não suportado — use .wav ou .mp3');
}

async function loadAudioFile(resolvedPath: string): Promise<Buffer> {
  const ext = path.extname(resolvedPath);
  if (WAV_EXT.test(ext)) {
    return loadWavBytes(await fs.readFile(resolvedPath));
  }
  if (MP3_EXT.test(ext)) {
    const wav = decodeToWav(resolvedPath);
    return loadWavBytes(wav);
  }
  throw new Error(`Formato não suportado: ${ext}`);
}

/** Carrega som de espera (arquivo local ou URL). Fallback: teclado sintético. */
export async function initWaitSound(): Promise<void> {
  const filePath = config.audio.waitSoundPath.trim();
  const url = config.audio.waitSoundUrl.trim();

  if (!filePath && !url) {
    waitSound = KEYBOARD_TYPING;
    logger.info('Som de espera: teclado sintético (padrão)');
    return;
  }

  try {
    let pcm8k: Buffer;

    if (url) {
      logger.info('Baixando som de espera', { url });
      const res = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 20_000,
        maxContentLength: 8 * 1024 * 1024,
      });
      const bytes = Buffer.from(res.data as ArrayBuffer);
      const hint = path.extname(new URL(url).pathname) || '.mp3';
      pcm8k = await loadAudioBytes(bytes, hint);
    } else {
      const resolved = path.isAbsolute(filePath)
        ? filePath
        : path.join(process.cwd(), filePath);
      logger.info('Som de espera: carregando arquivo', { path: resolved });
      pcm8k = await loadAudioFile(resolved);
    }

    if (pcm8k.length < 320) {
      throw new Error('Áudio muito curto após conversão');
    }

    waitSound = pcm8k;
    const ms = Math.round(pcm8k.length / 160);
    logger.info(`Som de espera pronto (${ms} ms, loop na consulta)`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('Falha ao carregar som de espera — usando teclado sintético', { err: msg });
    waitSound = KEYBOARD_TYPING;
  }
}

export function getWaitSound(): Buffer {
  return waitSound;
}
