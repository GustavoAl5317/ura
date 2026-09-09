// Canal WhatsApp dos técnicos (instância Evolution própria).
//
// Regra de formato: texto entra → texto sai; áudio entra → áudio sai.
// Áudio sai ACOMPANHADO do texto, de propósito: o técnico não consegue copiar
// um SN de dentro de um áudio, e o rastro de fontes é ilegível falado.

import { randomUUID } from 'crypto';
import { config } from '../../config';
import { logger } from '../../logger';
import { EvolutionClient, MensagemRecebida, soNumero } from '../../integrations/evolution';
import { db } from '../store/db';
import { responder, paraWhatsApp } from '../agent';
import { transcrever, sintetizar } from '../voice';

export const evoTecnicos = new EvolutionClient(
  {
    apiUrl: config.evolutionTecnicos.apiUrl,
    instance: config.evolutionTecnicos.instance,
    apiKey: config.evolutionTecnicos.apiKey,
  },
  'evolution-tecnicos',
);

/** Reaproveita a conversa se a última mensagem foi há menos que isto. */
const JANELA_CONVERSA_MS = 60 * 60_000;

/** IDs já processados — o Evolution reentrega em retry, e responder duas vezes é pior que não responder. */
const jaProcessadas = new Map<string, number>();

function jaVista(id: string): boolean {
  const agora = Date.now();
  for (const [k, t] of jaProcessadas) {
    if (agora - t > 10 * 60_000) jaProcessadas.delete(k);
  }
  if (jaProcessadas.has(id)) return true;
  jaProcessadas.set(id, agora);
  return false;
}

/**
 * Autorização. Sem allowlist configurada NINGUÉM entra — o número do assistente
 * consulta dado cadastral de cliente, e um default aberto aqui seria um
 * vazamento esperando o primeiro desconhecido mandar "oi".
 */
export function autorizado(autorJid: string): boolean {
  const lista = config.evolutionTecnicos.autorizados;
  if (!lista.length) return false;

  const numero = soNumero(autorJid);
  const bate = lista.some((permitido) => {
    const p = soNumero(permitido).replace(/\D/g, '');
    const n = numero.replace(/\D/g, '');
    return p === n || p.endsWith(n) || n.endsWith(p);
  });
  if (!bate) return false;

  // Registro em `permissao` pode desativar alguém sem editar o .env.
  const r = db().prepare(`SELECT ativo FROM permissao WHERE usuario = ?`)
    .get(autorJid) as { ativo: number } | undefined;
  return r ? r.ativo === 1 : true;
}

function obterConversa(usuario: string, nome: string | null): string {
  const d = db();
  const limite = new Date(Date.now() - JANELA_CONVERSA_MS).toISOString();
  const existente = d.prepare(
    `SELECT id FROM conversa WHERE usuario = ? AND canal = 'whatsapp' AND ultima_em > ?
     ORDER BY ultima_em DESC LIMIT 1`,
  ).get(usuario, limite) as { id: string } | undefined;

  const agora = new Date().toISOString();
  if (existente) {
    d.prepare(`UPDATE conversa SET ultima_em = ? WHERE id = ?`).run(agora, existente.id);
    return existente.id;
  }

  const id = randomUUID();
  d.prepare(
    `INSERT INTO conversa (id, canal, usuario, nome, criada_em, ultima_em) VALUES (?,?,?,?,?,?)`,
  ).run(id, 'whatsapp', usuario, nome, agora, agora);
  return id;
}

function gravarMensagem(
  conversaId: string,
  papel: 'user' | 'assistant',
  formato: 'texto' | 'audio',
  conteudo: string,
): void {
  db().prepare(
    `INSERT INTO mensagem (id, conversa_id, papel, formato, conteudo, at) VALUES (?,?,?,?,?,?)`,
  ).run(randomUUID(), conversaId, papel, formato, conteudo, new Date().toISOString());
}

function historico(conversaId: string): Array<{ papel: 'user' | 'assistant'; conteudo: string }> {
  const linhas = db().prepare(
    `SELECT papel, conteudo FROM mensagem WHERE conversa_id = ? ORDER BY at DESC LIMIT ?`,
  ).all(conversaId, config.assistant.historicoMax) as Array<{ papel: 'user' | 'assistant'; conteudo: string }>;
  return linhas.reverse();
}

/** Processa uma mensagem recebida. Nunca lança: erro vira aviso ao técnico. */
export async function processarMensagem(msg: MensagemRecebida): Promise<void> {
  if (jaVista(msg.id)) {
    logger.debug('Assistente: mensagem repetida ignorada', { id: msg.id });
    return;
  }

  // Em grupo, só responde quando mencionado ou com prefixo — senão o assistente
  // vira o chato que comenta toda conversa do time.
  if (msg.ehGrupo) {
    const t = (msg.texto ?? '').toLowerCase();
    const chamado = t.startsWith('!') || t.includes('@assistente') || t.includes('assistente,');
    if (msg.formato === 'texto' && !chamado) return;
    if (msg.formato === 'audio') return;
  }

  if (!autorizado(msg.autorJid)) {
    logger.warn('Assistente: mensagem de número não autorizado', {
      autor: soNumero(msg.autorJid).slice(0, 8) + '…',
    });
    return;   // silêncio: responder confirmaria que o número existe
  }

  if (msg.formato === 'outro') {
    await evoTecnicos.enviarTexto(msg.jid, 'Só consigo ler texto e áudio por aqui.');
    return;
  }

  void evoTecnicos.marcarLida(msg.jid, msg.id);
  const respostaEmAudio = msg.formato === 'audio';
  void evoTecnicos.presenca(msg.jid, respostaEmAudio ? 'recording' : 'composing');

  // ── Entrada ────────────────────────────────────────────────────────────────
  let pergunta = msg.texto ?? '';

  if (respostaEmAudio) {
    const audio = await evoTecnicos.baixarMidia(msg.id);
    if (!audio) {
      await evoTecnicos.enviarTexto(msg.jid, 'Não consegui baixar seu áudio. Manda de novo ou escreve?');
      return;
    }
    const texto = await transcrever(audio);
    if (!texto) {
      await evoTecnicos.enviarTexto(msg.jid, 'Não entendi o áudio. Pode repetir ou escrever?');
      return;
    }
    pergunta = texto;
    logger.info('Assistente: áudio transcrito', {
      autor: soNumero(msg.autorJid).slice(0, 8) + '…',
      seg: msg.duracaoSeg,
      chars: texto.length,
    });
  }

  if (!pergunta.trim()) return;

  // Em grupo, tira o prefixo de chamada antes de mandar ao modelo.
  pergunta = pergunta.replace(/^!\s*/, '').replace(/@assistente\s*/gi, '').trim();

  // ── Resposta ───────────────────────────────────────────────────────────────
  const conversaId = obterConversa(msg.autorJid, msg.nome);
  const hist = historico(conversaId);
  gravarMensagem(conversaId, 'user', msg.formato === 'audio' ? 'audio' : 'texto', pergunta);

  let textoResposta: string;
  try {
    const r = await responder({
      pergunta,
      usuario: msg.autorJid,
      canal: 'whatsapp',
      conversaId,
      historico: hist,
      origemAudio: respostaEmAudio,
    });
    textoResposta = paraWhatsApp(r);
    logger.info('Assistente: respondeu', {
      autor: soNumero(msg.autorJid).slice(0, 8) + '…',
      veredito: r.veredito,
      evidencias: r.evidencias.length,
      ms: r.duracaoMs,
    });
  } catch (err) {
    logger.error('Assistente: falha ao responder', {
      err: err instanceof Error ? err.message : String(err),
    });
    await evoTecnicos.enviarTexto(msg.jid, '🔴 Falhei ao processar a consulta. Tenta de novo em instantes.');
    return;
  }

  gravarMensagem(conversaId, 'assistant', respostaEmAudio ? 'audio' : 'texto', textoResposta);

  // Texto sempre vai — inclusive quando a pergunta veio em áudio.
  await evoTecnicos.enviarTexto(msg.jid, textoResposta);

  if (respostaEmAudio) {
    const ogg = await sintetizar(textoResposta);
    if (ogg) {
      await evoTecnicos.enviarAudio(msg.jid, ogg);
    } else {
      logger.warn('Assistente: sem áudio de resposta, seguiu só o texto');
    }
  }

  void evoTecnicos.presenca(msg.jid, 'paused');
}
