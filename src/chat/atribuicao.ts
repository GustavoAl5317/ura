// Atribuição automática de conversa a uma atendente.
//
// Sem isso a conversa entra na fila e fica esperando alguém PUXAR — quem quer
// fechar uma venda não espera. Aqui ela já cai na mão de uma pessoa, com nome,
// e o painel dela destaca na hora.
//
// A conversa nunca fica presa em quem não respondeu: se a pessoa escolhida não
// falar nada dentro do prazo, a conversa volta para a fila e qualquer atendente
// pode assumir (ver verificarFilaAtendimento).

import { logger } from '../logger';
import { usuariosOnline, listarUsuarios } from './auth';
import type { ChatSession, ChatSessionStore } from './session';

let store: ChatSessionStore | null = null;

/** O store se registra ao subir — evita passar a referência por todo lado. */
export function registrarStore(s: ChatSessionStore): void {
  store = s;
}

/** Minutos sem a atendente responder até a conversa voltar para a fila. */
export const MIN_ATE_DEVOLVER = 2;

/**
 * Escolhe quem recebe: entre as atendentes ONLINE, a que estiver com menos
 * conversas abertas. Empate resolve pelo nome, para ser previsível — sorteio
 * dificultaria entender por que uma conversa foi parar com alguém.
 *
 * Só conta quem está online: atribuir a quem está deslogado é o mesmo que
 * deixar o cliente esperando, mas escondendo isso do painel.
 */
export function escolherAtendente(): { id: string; nome: string } | null {
  if (!store) return null;

  const online = usuariosOnline();
  const candidatas = listarUsuarios().filter((u) => online.has(u.id) && u.ativo !== false);
  if (!candidatas.length) return null;

  const conversas = store.list();
  const carga = (id: string): number =>
    conversas.filter((s) => s.modo === 'humano' && s.atendenteId === id && !s.encerrada).length;

  const ordenadas = [...candidatas].sort(
    (a, b) => carga(a.id) - carga(b.id) || a.nome.localeCompare(b.nome),
  );
  const escolhida = ordenadas[0];
  return { id: escolhida.id, nome: escolhida.nome };
}

/**
 * Atribui a conversa a uma atendente disponível. Devolve false quando não há
 * ninguém online — aí a conversa segue na fila, com o escalonamento de sempre.
 */
export function atribuirAutomaticamente(sessao: ChatSession): boolean {
  const alvo = escolherAtendente();
  if (!alvo) {
    logger.info(`[${sessao.ctx.callId}] atribuição automática: ninguém online, mantendo na fila`);
    return false;
  }

  sessao.assumirPorAtribuicao(alvo);
  logger.info(`[${sessao.ctx.callId}] conversa atribuída automaticamente a ${alvo.nome}`);
  return true;
}
