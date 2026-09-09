// Voz do assistente no WhatsApp: áudio entra, áudio sai.
//
// Nada aqui reaproveita o pipeline da URA: lá é streaming em 8 kHz pelo
// AudioSocket, com pacing e barge-in. Aqui é arquivo inteiro, sem latência
// de conversa telefônica. Misturar os dois só traria o pior dos dois.

import axios, { AxiosError } from 'axios';
import { config } from '../config';
import { logger } from '../logger';

const API_TRANSCRICAO = 'https://api.openai.com/v1/audio/transcriptions';
const API_FALA = 'https://api.openai.com/v1/audio/speech';

/** Áudio maior que isso quase certamente é engano ou mensagem encaminhada. */
const MAX_AUDIO_BYTES = 20 * 1024 * 1024;

/** Transcreve o áudio recebido. null = não deu, e quem chama precisa avisar. */
export async function transcrever(audio: Buffer, nomeArquivo = 'audio.ogg'): Promise<string | null> {
  if (!audio.length) return null;
  if (audio.length > MAX_AUDIO_BYTES) {
    logger.warn('Assistente: áudio grande demais para transcrever', { bytes: audio.length });
    return null;
  }

  try {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(audio)]), nomeArquivo);
    form.append('model', config.assistant.sttModel);
    form.append('language', 'pt');
    // Vocabulário da casa: sem isso o Whisper escreve "OLT" como "old",
    // "CTO" como "seto" e transforma SN em qualquer coisa.
    form.append(
      'prompt',
      'Termos técnicos de provedor de internet: OLT, ONU, ONT, CTO, PON, PPPoE, RADIUS, ' +
      'SGP, Zabbix, NetFlow, dBm, fibra, splitter, POP, massiva, sinal, RX, TX, SN, serial.',
    );

    const res = await axios.post<{ text?: string }>(API_TRANSCRICAO, form, {
      timeout: 90_000,
      headers: { Authorization: `Bearer ${config.openai.apiKey}` },
    });

    const texto = res.data?.text?.trim();
    return texto || null;
  } catch (err) {
    const ax = err as AxiosError;
    logger.error('Assistente: transcrição falhou', {
      status: ax.response?.status,
      body: JSON.stringify(ax.response?.data ?? '').slice(0, 300),
      err: ax.message,
    });
    return null;
  }
}

/**
 * Prepara o texto para ser FALADO. A resposta de tela usa marcação de WhatsApp
 * e rótulos de evidência que, lidos em voz alta, viram ruído.
 */
export function textoParaFala(texto: string): string {
  return texto
    // Rodapé de fontes: não se lê "evd_1 sgp sgp.onu_ao_vivo 14:32" em voz alta.
    .replace(/_Fontes:_[\s\S]*$/m, '')
    .replace(/\bevd_\d+\b/gi, '')
    .replace(/\*/g, '')
    .replace(/^_|_$/gm, '')
    .replace(/•/g, ',')
    // O emoji e a palavra do veredito vêm juntos ("🟢 *CONFIRMADO*"); trocar só
    // o emoji produzia "Confirmado: CONFIRMADO". Consome os dois de uma vez.
    .replace(/🟢\s*CONFIRMADO/gi, 'Confirmado.')
    .replace(/🟡\s*PROV[ÁA]VEL/gi, 'Provável.')
    .replace(/🔴\s*INCONCLUSIVO/gi, 'Inconclusivo.')
    .replace(/🟢/g, 'Confirmado.')
    .replace(/🟡/g, 'Provável.')
    .replace(/🔴/g, 'Inconclusivo.')
    .replace(/⚠️/g, 'Atenção:')
    // Sinal óptico é sempre negativo, e o TTS engole o "-": quem ouve "19,17"
    // no lugar de "-19,17" lê um sinal saudável como se fosse outro número.
    .replace(/(^|[\s(])-(\d+)[.,](\d+)/g, '$1menos $2 vírgula $3')
    .replace(/(^|[\s(])-(\d+)\b/g, '$1menos $2')
    // Decimal falado: "2.09" vira "dois vírgula zero nove", não "dois ponto nove".
    .replace(/(\d)\.(\d)/g, '$1 vírgula $2')
    .replace(/dBm/g, 'dê bê ême')
    // Sobra de pontuação depois das remoções.
    .replace(/\(\s*,?\s*\)/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Sintetiza em OGG/Opus, que é o formato que o WhatsApp aceita como PTT. */
export async function sintetizar(texto: string): Promise<Buffer | null> {
  const falado = textoParaFala(texto);
  if (!falado) return null;

  // O TTS aceita textos longos, mas resposta falada de 3 minutos ninguém ouve.
  const limitado = falado.length > 3_000 ? `${falado.slice(0, 3_000)}… resumo interrompido.` : falado;

  try {
    const res = await axios.post(
      API_FALA,
      {
        model: 'tts-1',
        voice: config.assistant.ttsVoice,
        input: limitado,
        response_format: 'opus',
      },
      {
        timeout: 90_000,
        responseType: 'arraybuffer',
        headers: {
          Authorization: `Bearer ${config.openai.apiKey}`,
          'Content-Type': 'application/json',
        },
      },
    );
    return Buffer.from(res.data as ArrayBuffer);
  } catch (err) {
    const ax = err as AxiosError;
    logger.error('Assistente: síntese de voz falhou', {
      status: ax.response?.status,
      err: ax.message,
    });
    return null;
  }
}
