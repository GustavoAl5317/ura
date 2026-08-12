// Transcrição de áudio (mensagens de voz do WhatsApp) via OpenAI.
// Usa fetch + FormData nativos do Node (>=18) — sem dependência nova.

import { config } from '../config';
import { logger } from '../logger';

function extensaoDoMime(mime?: string): { ext: string; tipo: string } {
  const tipo = (mime ?? 'audio/ogg').split(';')[0].trim();
  if (tipo.includes('mpeg') || tipo.includes('mp3')) return { ext: 'mp3', tipo };
  if (tipo.includes('wav')) return { ext: 'wav', tipo };
  if (tipo.includes('mp4') || tipo.includes('m4a') || tipo.includes('aac')) return { ext: 'm4a', tipo };
  if (tipo.includes('webm')) return { ext: 'webm', tipo };
  return { ext: 'ogg', tipo: tipo || 'audio/ogg' };            // WhatsApp manda OGG/Opus
}

/**
 * Contexto dado ao modelo de transcrição. Sem isso ele "arredonda" os números
 * ditados (CEP vira endereço, CPF perde grupo) porque não sabe do que se trata.
 * Whisper e gpt-4o-transcribe usam este texto como viés de vocabulário.
 */
const CONTEXTO_TRANSCRICAO =
  'Atendimento de provedora de internet fibra em Fortaleza, Ceará. '
  + 'O cliente pode ditar CEP, CPF, telefone com DDD, número de protocolo ou endereço, '
  + 'em português do Brasil, agrupado por extenso — por exemplo: '
  + '"sessenta mil, quinhentos e trinta, quatrocentos e trinta", '
  + '"oitocentos e dez, duzentos e vinte, trezentos e trinta, quarenta", '
  + '"oitenta e cinco, nove nove seis um, dois três quatro cinco". '
  + 'Transcreva os números exatamente como foram ditos, sem converter nem arredondar.';

/** Converte o áudio (base64) em texto. Retorna null se falhar. */
export async function transcreverAudio(base64: string, mimetype?: string): Promise<string | null> {
  if (!base64) return null;

  const buffer = Buffer.from(base64, 'base64');
  if (!buffer.length) return null;

  const { ext, tipo } = extensaoDoMime(mimetype);
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: tipo }), `audio.${ext}`);
  form.append('model', config.chat.transcribeModel);
  form.append('language', 'pt');
  form.append('prompt', CONTEXTO_TRANSCRICAO);
  // Sem temperatura o modelo "inventa" quando o áudio está ruim — e número
  // inventado leva o atendimento inteiro para o cadastro errado.
  form.append('temperature', '0');

  try {
    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.openai.apiKey}` },
      body: form,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      logger.error('[chat] transcrição falhou', {
        status: res.status,
        model: config.chat.transcribeModel,
        body: body.slice(0, 300),
      });
      return null;
    }

    const data = (await res.json()) as { text?: string };
    const texto = (data.text ?? '').trim();
    return texto || null;
  } catch (err) {
    logger.error('[chat] erro ao transcrever áudio', {
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
