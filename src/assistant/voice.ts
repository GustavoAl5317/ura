// Voz do assistente no WhatsApp: áudio entra, áudio sai.
//
// Nada aqui reaproveita o pipeline da URA: lá é streaming em 8 kHz pelo
// AudioSocket, com pacing e barge-in. Aqui é arquivo inteiro, sem latência
// de conversa telefônica. Misturar os dois só traria o pior dos dois.

import axios, { AxiosError } from 'axios';
import { config } from '../config';
import { logger } from '../logger';
import { obter } from './config-dinamica';
import { textoParaFala } from './fala';
import type { RespostaAssistente } from './types';

export { textoParaFala };

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
 * A resposta montada para OUVIR. A de tela tem selo de veredito, lista do que
 * falta e rodapé de fontes — lido em voz alta, isso é ruído. Aqui fica o que
 * muda a conduta de quem ouve: se não está confirmado, a hipótese e a fonte
 * que caiu. O detalhe segue na mensagem de texto que vai junto.
 */
export function falaDaResposta(r: Pick<RespostaAssistente, 'veredito' | 'texto' | 'hipotese' | 'fontesIndisponiveis'>): string {
  if (r.veredito === 'CONVERSA') return r.texto;
  const partes: string[] = [];
  if (r.veredito === 'PROVAVEL') partes.push('Ainda não está confirmado.');
  if (r.veredito === 'INCONCLUSIVO') partes.push('Não consegui confirmar.');
  partes.push(r.texto);
  if (r.hipotese) partes.push(`Minha hipótese, sem confirmação: ${r.hipotese}`);
  if (r.fontesIndisponiveis.length) partes.push(`Atenção: não consegui consultar ${r.fontesIndisponiveis.join(' e ')}.`);
  return partes.join('\n');
}

/**
 * Como falar. Só o gpt-4o-mini-tts aceita instruções; o tts-1 ignora o campo.
 * Número, data e hora já chegam por extenso (fala.ts): aqui é só o tom.
 */
export const ESTILO_PADRAO =
  'Fale em português do Brasil, com sotaque neutro, como um colega experiente do NOC conversando ' +
  'com um técnico de campo pelo WhatsApp. Tom calmo, natural e direto, sem soar como locutor nem ' +
  'como robô. Ritmo um pouco mais lento em números, horários e nomes de CTO, para dar para anotar. ' +
  'Pausas curtas entre as frases. Em problema ou alerta, tom sério, sem dramatizar.';

/** Modelo recusado (sem permissão, voz inválida) fica de fora por um tempo. */
const indisponivelAte = new Map<string, number>();

async function falar(modelo: string, entrada: string, formato: 'opus' | 'mp3'): Promise<Buffer> {
  const aceitaInstrucao = !/^tts-1/.test(modelo);
  // tts-1 só conhece as 6 vozes antigas: voz nova nele é 400.
  const antigas = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'];
  const voz = obter<string>('audio.voz');
  const res = await axios.post(
    API_FALA,
    {
      model: modelo,
      voice: aceitaInstrucao || antigas.includes(voz) ? voz : 'nova',
      input: entrada,
      response_format: formato,
      ...(aceitaInstrucao ? { instructions: obter<string>('audio.estilo').trim() || ESTILO_PADRAO } : {}),
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
}

/**
 * Sintetiza a resposta em áudio.
 * @param formato 'opus' para PTT no WhatsApp; 'mp3' para o navegador — Safari
 *                não toca Opus, e o chat interno precisa funcionar em qualquer um.
 */
export async function sintetizar(texto: string, formato: 'opus' | 'mp3' = 'opus'): Promise<Buffer | null> {
  const falado = textoParaFala(texto);
  if (!falado) return null;

  // O TTS aceita textos longos, mas resposta falada longa ninguém ouve até o fim.
  const max = obter<number>('audio.max_caracteres');
  const limitado = falado.length > max
    ? `${falado.slice(0, falado.lastIndexOf(' ', max) > 0 ? falado.lastIndexOf(' ', max) : max)}… o restante está na mensagem de texto.`
    : falado;

  const modelos = [...new Set([obter<string>('audio.modelo'), 'tts-1'])]
    .filter((m) => (indisponivelAte.get(m) ?? 0) < Date.now());
  for (const modelo of modelos) {
    try {
      return await falar(modelo, limitado, formato);
    } catch (err) {
      const ax = err as AxiosError;
      const status = ax.response?.status;
      logger.error('Assistente: síntese de voz falhou', { modelo, status, err: ax.message });
      if (status === 400 || status === 403 || status === 404) {
        indisponivelAte.set(modelo, Date.now() + 3600_000);
        continue;
      }
      return null;
    }
  }
  return null;
}
