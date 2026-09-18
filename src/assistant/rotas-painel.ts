// Painel web e chat interno com voz (Bloco 5).
//
// A página é estática e não exige chave para carregar — a chave é pedida na
// tela e toda chamada à API a envia. Servimos um arquivo fixo, nunca um caminho
// vindo da URL, para não abrir leitura arbitrária de arquivo.

import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { Rota, json, lerBytes, ator, ErroHttp } from './http-util';
import { responder, paraWhatsApp } from './agent';
import { transcrever, sintetizar, falaDaResposta } from './voice';
import { obter } from './config-dinamica';
import { logger } from '../logger';
import { db } from './store/db';

const PAGINA = path.join(process.cwd(), 'painel-assistente', 'index.html');

/** Extensão que a OpenAI usa para reconhecer o formato do áudio enviado. */
function extensaoDoAudio(tipo: string): string {
  if (/webm/i.test(tipo)) return 'webm';
  if (/ogg|opus/i.test(tipo)) return 'ogg';
  if (/mp4|m4a|aac/i.test(tipo)) return 'm4a';
  if (/mpeg|mp3/i.test(tipo)) return 'mp3';
  if (/wav/i.test(tipo)) return 'wav';
  return 'webm';
}

export const rotasPainel: Rota = async (req, res, url, p) => {
  if (req.method === 'GET' && (p === '/' || p === '/painel' || p === '/painel/')) {
    if (!fs.existsSync(PAGINA)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('painel-assistente/index.html não encontrado — o processo precisa rodar da raiz do repositório');
      return true;
    }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache',
      // A página não carrega nada de fora: tudo inline. Isso fecha a porta para
      // script injetado por dado de cliente (nome no SGP, nome de alerta).
      'Content-Security-Policy':
        "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' data:; media-src 'self' blob: data:; connect-src 'self'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    fs.createReadStream(PAGINA).pipe(res);
    return true;
  }

  return false;
};

/** Rota autenticada: chat por áudio (texto → texto, áudio → áudio). */
export const rotasChatAudio: Rota = async (req, res, url, p) => {
  if (req.method !== 'POST' || p !== '/api/chat/audio') return false;

  const tipo = String(req.headers['content-type'] ?? '');
  const audio = await lerBytes(req, 25 * 1024 * 1024);
  if (!audio.length) throw new ErroHttp(400, 'áudio vazio');

  const pergunta = await transcrever(audio, `pergunta.${extensaoDoAudio(tipo)}`);
  if (!pergunta) {
    json(res, 422, { error: 'não consegui entender o áudio — tente de novo ou escreva' });
    return true;
  }

  let historico: Array<{ papel: 'user' | 'assistant'; conteudo: string }> = [];
  const h = url.searchParams.get('historico');
  if (h) {
    try { historico = JSON.parse(h); } catch { historico = []; }
  }

  const usuario = ator(req);
  const r = await responder({
    pergunta, usuario, canal: 'chat', historico: historico.slice(-12), origemAudio: true,
  });

  const conversaIdParam = url.searchParams.get('conversaId');
  const d = db();
  const agora = new Date().toISOString();

  // Criar ou reutilizar conversa
  let conversaId = conversaIdParam ?? undefined;
  if (conversaId) {
    // Verifica se a conversa existe
    const existe = d.prepare(`SELECT id FROM conversa WHERE id = ?`).get(conversaId);
    if (!existe) conversaId = undefined;
  }
  if (!conversaId) {
    conversaId = randomUUID();
    d.prepare(
      `INSERT INTO conversa (id, canal, usuario, nome, criada_em, ultima_em) VALUES (?,?,?,?,?,?)`,
    ).run(conversaId, 'chat', usuario, null, agora, agora);
  }

  // Persistir mensagens no banco
  d.prepare(
    `INSERT INTO mensagem (id, conversa_id, papel, formato, conteudo, at) VALUES (?,?,?,?,?,?)`,
  ).run(randomUUID(), conversaId, 'user', 'texto', pergunta, agora);
  d.prepare(
    `INSERT INTO mensagem (id, conversa_id, papel, formato, conteudo, at) VALUES (?,?,?,?,?,?)`,
  ).run(randomUUID(), conversaId, 'assistant', 'texto', r.texto, new Date().toISOString());
  d.prepare(`UPDATE conversa SET ultima_em = ? WHERE id = ?`).run(new Date().toISOString(), conversaId);

  // mp3, não opus: Safari não toca Opus e o chat precisa funcionar em qualquer navegador.
  const querAudio = obter<boolean>('audio.responder_em_audio');
  const mp3 = querAudio ? await sintetizar(falaDaResposta(r), 'mp3') : null;
  if (querAudio && !mp3) logger.warn('Painel: síntese falhou, resposta vai só em texto');

  json(res, 200, {
    transcricao: pergunta,
    resposta: r,
    audio: mp3 ? `data:audio/mpeg;base64,${mp3.toString('base64')}` : null,
    conversaId,
  });
  return true;
};
