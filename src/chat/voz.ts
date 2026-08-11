// Resposta em áudio no chat: só quando o cliente mandou áudio.
//
// Usa o TTS da própria OpenAI, que entrega OGG/Opus direto no
// response_format=opus — exatamente o formato de mensagem de voz do
// WhatsApp, sem passar por ffmpeg.
//
// A voz acompanha a persona: Alex (suporte) é masculino, Ana (vendas) e
// Bruna (financeiro) são femininas.

import axios from 'axios';
import { config } from '../config';
import { logger } from '../logger';

export type Genero = 'feminino' | 'masculino';

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

/**
 * Converte a resposta em áudio de mensagem de voz do WhatsApp.
 * Retorna null quando não deve/não dá para responder em áudio — quem chama
 * cai no texto, que é sempre o caminho seguro.
 */
export async function sintetizarParaWhatsapp(
  texto: string,
  genero: Genero = 'feminino',
): Promise<Buffer | null> {
  const chave = config.openai.apiKey;
  if (!chave) {
    logger.warn('[voz] OPENAI_API_KEY ausente');
    return null;
  }

  const fala = limparParaFala(texto);
  if (!fala) return null;
  if (fala.length > MAX_CHARS_AUDIO) {
    logger.info('[voz] resposta longa demais para áudio, enviando texto', { chars: fala.length });
    return null;
  }

  const voz = genero === 'masculino' ? config.chat.vozMasculina : config.chat.vozFeminina;

  try {
    const res = await axios.post<ArrayBuffer>(
      'https://api.openai.com/v1/audio/speech',
      {
        model: config.chat.ttsModel,
        voice: voz,
        input: fala,
        // opus = OGG/Opus, o formato nativo de mensagem de voz do WhatsApp.
        response_format: 'opus',
        instructions: 'Fale como atendente brasileiro de telecom: natural, '
          + 'cordial e objetivo. Ritmo de conversa, sem tom de locução.',
      },
      {
        headers: { Authorization: `Bearer ${chave}`, 'Content-Type': 'application/json' },
        responseType: 'arraybuffer',
        timeout: 25_000,
      },
    );

    const ogg = Buffer.from(res.data);
    if (!ogg.length) return null;
    logger.info('[voz] áudio gerado', { chars: fala.length, bytes: ogg.length, voz, genero });
    return ogg;
  } catch (err: unknown) {
    const e = err as { response?: { status?: number; data?: unknown }; message?: string };
    logger.error('[voz] falha na síntese', {
      status: e.response?.status,
      modelo: config.chat.ttsModel,
      voz,
      err: e.message,
    });
    return null;
  }
}
