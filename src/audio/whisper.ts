import { Readable } from 'stream';
import FormData from 'form-data';
import https from 'https';
import { config } from '../config';
import { logger } from '../logger';

// Acumula áudio 8kHz do cliente e transcreve via Whisper quando o cliente para de falar
// Usado apenas para logging — não afeta o pipeline principal

const SAMPLE_RATE = 8000;
const BYTES_PER_SAMPLE = 2;
// WAV header para envio ao Whisper
function buildWav(pcm: Buffer): Buffer {
  const dataLen = pcm.length;
  const hdr = Buffer.alloc(44);
  hdr.write('RIFF', 0);
  hdr.writeUInt32LE(36 + dataLen, 4);
  hdr.write('WAVE', 8);
  hdr.write('fmt ', 12);
  hdr.writeUInt32LE(16, 16);
  hdr.writeUInt16LE(1, 20);   // PCM
  hdr.writeUInt16LE(1, 22);   // mono
  hdr.writeUInt32LE(SAMPLE_RATE, 24);
  hdr.writeUInt32LE(SAMPLE_RATE * BYTES_PER_SAMPLE, 28);
  hdr.writeUInt16LE(BYTES_PER_SAMPLE, 32);
  hdr.writeUInt16LE(16, 34);
  hdr.write('data', 36);
  hdr.writeUInt32LE(dataLen, 40);
  return Buffer.concat([hdr, pcm]);
}

export async function transcribeWhisper(callId: string, pcm8k: Buffer): Promise<void> {
  if (pcm8k.length < SAMPLE_RATE * BYTES_PER_SAMPLE * 0.3) return; // ignora < 300ms

  const wav = buildWav(pcm8k);
  const form = new FormData();
  form.append('file', Readable.from(wav), { filename: 'audio.wav', contentType: 'audio/wav' });
  form.append('model', 'whisper-1');
  form.append('language', 'pt');

  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.openai.apiKey}`,
    ...form.getHeaders(),
  };

  return new Promise((resolve) => {
    const req = https.request(
      { hostname: 'api.openai.com', path: '/v1/audio/transcriptions', method: 'POST', headers },
      (res) => {
        let body = '';
        res.on('data', (d: Buffer) => { body += d.toString(); });
        res.on('end', () => {
          try {
            const json = JSON.parse(body) as { text?: string };
            const text = json.text?.trim();
            if (text) logger.info(`[${callId}] 👤 Cliente: ${text}`);
          } catch { /* ignora */ }
          resolve();
        });
      },
    );
    req.on('error', () => resolve());
    form.pipe(req);
  });
}
