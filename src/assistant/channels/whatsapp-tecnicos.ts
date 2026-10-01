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
import { transcrever, sintetizar, falaDaResposta } from '../voice';
import { obter, FONTES_PUBLICAS } from '../config-dinamica';
import {
  ROTULO_ESTADO, assumir as assumirIncidente, mudarEstado as mudarEstadoIncidente,
  porId as porIdIncidente,
} from '../incidentes';
import { FonteId } from '../types';

export const evoTecnicos = new EvolutionClient(
  {
    apiUrl: config.evolutionTecnicos.apiUrl,
    instance: config.evolutionTecnicos.instance,
    apiKey: config.evolutionTecnicos.apiKey,
  },
  'evolution-tecnicos',
);

/** Reaproveita a conversa se a última mensagem foi há menos que isto (painel: whatsapp.janela_conversa_min). */
function janelaConversaMs(): number {
  return obter<number>('whatsapp.janela_conversa_min') * 60_000;
}

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
/**
 * Dois números são o mesmo? Tolera o nono dígito: o WhatsApp às vezes entrega o
 * JID de celular brasileiro sem o 9 (5585 8888-7777 vs 5585 9 8888-7777).
 */
export function mesmoNumero(a: string, b: string): boolean {
  const x = soNumero(a).replace(/\D/g, '');
  const y = soNumero(b).replace(/\D/g, '');
  if (x.length < 8 || y.length < 8) return false;
  if (x === y || x.endsWith(y) || y.endsWith(x)) return true;
  // Mesmo DDD e mesmos 8 finais: diferença é só o nono dígito.
  const ddd = (n: string) => (n.startsWith('55') && n.length >= 12 ? n.slice(2, 4) : n.slice(0, 2));
  return x.slice(-8) === y.slice(-8) && ddd(x) === ddd(y);
}

/** Registro de permissão do número, se houver. */
export function permissaoDoNumero(autorJid: string): { usuario: string; ativo: number; equipe_ok: number } | undefined {
  // equipe_ok: sem equipe, ou equipe existente e ativa. Equipe bloqueada bloqueia o membro.
  const linhas = db().prepare(
    `SELECT p.usuario, p.ativo,
            CASE WHEN p.equipe IS NULL THEN 1 ELSE COALESCE(e.ativo, 0) END AS equipe_ok
     FROM permissao p LEFT JOIN equipe e ON e.id = p.equipe
     WHERE p.usuario LIKE '%@s.whatsapp.net'`,
  ).all() as Array<{ usuario: string; ativo: number; equipe_ok: number }>;
  return linhas.find((l) => mesmoNumero(l.usuario, autorJid));
}

export function autorizado(autorJid: string): boolean {
  return acessoDoNumero(autorJid) === 'completo';
}

export type Acesso = 'completo' | 'publico' | 'negado';

/**
 * Nível de acesso de um número. Cadastro vence o modo: desativado na aba
 * Técnicos fica bloqueado mesmo com o WhatsApp aberto, senão desativar alguém
 * só o rebaixaria a "público".
 */
export function acessoDoNumero(autorJid: string): Acesso {
  // Cadastro no painel decide quando existe: libera sem editar o .env, e a
  // desativação vence a lista do .env.
  const r = permissaoDoNumero(autorJid);
  if (r) return r.ativo === 1 && r.equipe_ok === 1 ? 'completo' : 'negado';

  const lista = config.evolutionTecnicos.autorizados;
  if (lista.some((permitido) => mesmoNumero(permitido, autorJid))) return 'completo';

  const modo = obter<string>('whatsapp.acesso');
  if (modo === 'aberto') return 'completo';
  if (modo === 'rede') return 'publico';
  return 'negado';
}

/** Teto de fontes do acesso público: o configurado, nunca além das públicas. */
export function fontesPublicas(): FonteId[] {
  const escolhidas = obter<string[]>('whatsapp.fontes_publicas');
  return (FONTES_PUBLICAS as readonly FonteId[]).filter((f) => escolhidas.includes(f));
}

function obterConversa(usuario: string, nome: string | null): string {
  const d = db();
  const limite = new Date(Date.now() - janelaConversaMs()).toISOString();
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

export interface ComandoIncidente { acao: 'assumir' | 'atendendo' | 'encerrar'; numero: string }

/**
 * Comando de incidente escrito no WhatsApp. Só as três ações que o técnico faz
 * em campo, com o número do incidente sempre explícito: sem número, não é
 * comando, é conversa.
 */
export function comandoDeIncidente(texto: string): ComandoIncidente | null {
  const t = texto.trim().toLowerCase().replace(/\s+/g, ' ');
  const m = t.match(/^(assumir|assumo|peguei|atendendo|em atendimento|encerrar|fechar)\s+(?:o\s+)?(?:incidente\s+)?(inc-\d{4}-\d{1,6}|\d{1,6})$/i);
  if (!m) return null;
  const acao = /assumir|assumo|peguei/.test(m[1]) ? 'assumir' : /encerrar|fechar/.test(m[1]) ? 'encerrar' : 'atendendo';
  const bruto = m[2].toUpperCase();
  const numero = bruto.startsWith('INC-') ? bruto.replace(/^INC-(\d{4})-(\d+)$/, (_s, a, n) => `INC-${a}-${String(n).padStart(5, '0')}`) : bruto;
  return { acao, numero };
}

/** Executa o comando e devolve a resposta que vai para o WhatsApp. */
export function executarComandoIncidente(cmd: ComandoIncidente, quem: string): string {
  const inc = porIdIncidente(cmd.numero) ?? porIdIncidente(`INC-${new Date().getFullYear()}-${cmd.numero.padStart(5, '0')}`);
  if (!inc) return `Não achei o incidente ${cmd.numero}. Confira o número no alerta.`;
  try {
    if (cmd.acao === 'assumir') {
      const r = assumirIncidente(inc.id, quem);
      return `✅ *${r.numero}* é seu, ${quem}.\n${r.titulo}\nEstado: ${ROTULO_ESTADO[r.estado]}.`;
    }
    if (cmd.acao === 'atendendo') {
      const r = mudarEstadoIncidente(inc.id, 'atendimento', quem);
      return `🔧 *${r.numero}* em atendimento por ${quem}.`;
    }
    const r = mudarEstadoIncidente(inc.id, 'encerrado', quem, 'encerrado pelo WhatsApp');
    return `🟢 *${r.numero}* encerrado por ${quem}.`;
  } catch (err) {
    return `Não consegui: ${err instanceof Error ? err.message : String(err)}`;
  }
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

  const acesso = acessoDoNumero(msg.autorJid);
  // Grupo segue exigindo cadastro de quem chama: o grupo de alertas não vira
  // porta aberta só porque o modo público está ligado.
  if (acesso === 'negado' || (acesso === 'publico' && msg.ehGrupo)) {
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

  // "assumir INC-2026-00012" fecha o ciclo do alerta sem sair do WhatsApp.
  // Vem antes do modelo de propósito: é comando, não pergunta.
  const cmd = comandoDeIncidente(pergunta);
  if (cmd) {
    const resposta = executarComandoIncidente(cmd, msg.nome || soNumero(msg.autorJid));
    await evoTecnicos.enviarTexto(msg.jid, resposta);
    return;
  }

  // ── Resposta ───────────────────────────────────────────────────────────────
  const conversaId = obterConversa(msg.autorJid, msg.nome);
  const hist = historico(conversaId);
  gravarMensagem(conversaId, 'user', msg.formato === 'audio' ? 'audio' : 'texto', pergunta);

  let textoResposta: string;
  let fala = '';
  try {
    const r = await responder({
      pergunta,
      usuario: msg.autorJid,
      canal: 'whatsapp',
      conversaId,
      historico: hist,
      origemAudio: respostaEmAudio,
      publico: acesso === 'publico'
        ? { fontes: fontesPublicas(), limitePorHora: obter<number>('whatsapp.limite_publico_hora') }
        : undefined,
    });
    textoResposta = paraWhatsApp(r);
    fala = falaDaResposta(r);
    logger.info('Assistente: respondeu', {
      autor: soNumero(msg.autorJid).slice(0, 8) + '…',
      acesso,
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

  const querAudio = respostaEmAudio && obter<boolean>('audio.responder_em_audio');
  const ogg = querAudio ? await sintetizar(fala, 'opus') : null;
  if (querAudio && !ogg) logger.warn('Assistente: sem áudio de resposta, seguiu só o texto');

  gravarMensagem(conversaId, 'assistant', ogg ? 'audio' : 'texto', textoResposta);

  // O texto só deixa de ir se o áudio FOI gerado e o painel mandou não duplicar.
  // Áudio que falhou nunca deixa o técnico sem resposta.
  if (!ogg || obter<boolean>('audio.enviar_texto_junto')) {
    await evoTecnicos.enviarTexto(msg.jid, textoResposta);
  }
  if (ogg) await evoTecnicos.enviarAudio(msg.jid, ogg);

  void evoTecnicos.presenca(msg.jid, 'paused');
}
