// Atribuição automática de conversa a uma atendente.
//
// Sem isso a conversa entra na fila e fica esperando alguém PUXAR — quem quer
// fechar uma venda não espera. Aqui ela já cai na mão de uma pessoa, com nome,
// e o painel dela destaca na hora.
//
// Depois de atribuída, a conversa é dela: atendente pode demorar para responder,
// e isso é trabalho normal. Se precisar passar adiante, usa o repasse.

import { logger } from '../logger';
import { usuariosOnline, listarUsuarios } from './auth';
import { atendentesDoSetor } from './configuracoes';
import type { ChatSession, ChatSessionStore } from './session';

let store: ChatSessionStore | null = null;

/** Janela da carga atual de cada atendente, usada no balanceamento. */
const CARGA_JANELA_MS = 24 * 60 * 60_000;

/** O store se registra ao subir — evita passar a referência por todo lado. */
export function registrarStore(s: ChatSessionStore): void {
  store = s;
}

/**
 * Escolhe quem recebe: entre as atendentes ONLINE, a que estiver com menos
 * conversas abertas. Empate resolve pelo nome, para ser previsível — sorteio
 * dificultaria entender por que uma conversa foi parar com alguém.
 *
 * Só conta quem está online: atribuir a quem está deslogado é o mesmo que
 * deixar o cliente esperando, mas escondendo isso do painel.
 */
export function escolherAtendente(setor?: string): { id: string; nome: string } | null {
  if (!store) return null;

  const online = usuariosOnline();

  // Encaminhamento por setor definido no painel: cancelamento vai para quem
  // cuida de retenção, vendas para o comercial, e assim por diante.
  const preferidas = setor ? atendentesDoSetor(setor) : [];

  // SÓ quem tem papel de atendente. A conta de administração fica logada no
  // painel o dia todo sem ninguém atendendo por ela — uma conversa direcionada
  // para lá some da vista de todo mundo. Já aconteceu: uma conversa foi parar
  // na conta "aquitelecom" e o cliente ficou sem resposta.
  const atendentes = listarUsuarios()
    .filter((u) => u.papel === 'atendente' && online.has(u.id) && u.ativo !== false);

  // Só as escolhidas para o setor — mas se NENHUMA delas estiver online, vale
  // qualquer atendente. Segurar o cliente esperando por quem não está é pior
  // do que atender fora do setor ideal.
  const doSetor = preferidas.length
    ? atendentes.filter((u) => preferidas.includes(u.id))
    : [];
  if (preferidas.length && !doSetor.length) {
    logger.info('atribuição: ninguém do setor online, liberando para qualquer atendente', {
      setor, preferidas: preferidas.length,
    });
  }
  const candidatas = doSetor.length ? doSetor : atendentes;

  if (!candidatas.length) {
    // Sem atendente online, a conversa fica na FILA, onde todo mundo vê e o
    // escalonamento cobra. Atribuir a um admin só esconderia a espera.
    const adminsOnline = listarUsuarios().filter((u) => u.papel === 'admin' && online.has(u.id)).length;
    if (adminsOnline) {
      logger.info('atribuição automática: só admin online — mantendo na fila, que todos veem', {
        adminsOnline,
      });
    }
    return null;
  }

  // Carga ATUAL: só conversas com movimento nas últimas 24h. Conversa com
  // atendente não expira mais (pedido do cliente), então contar todas as
  // abertas faria quem esquece de encerrar acumular centenas e nunca mais
  // receber conversa nova — o balanceamento mediria histórico, não trabalho.
  const conversas = store.list();
  const recente = Date.now() - CARGA_JANELA_MS;
  const carga = (id: string): number =>
    conversas.filter((s) => s.modo === 'humano' && s.atendenteId === id && !s.encerrada
      && s.lastActivity >= recente).length;

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
export function atribuirAutomaticamente(sessao: ChatSession, setor?: string): boolean {
  // Já tem dona: nunca redistribuir por cima.
  if (sessao.modo === 'humano' && sessao.atendenteId) return false;
  const alvo = escolherAtendente(setor);
  if (!alvo) {
    logger.info(`[${sessao.ctx.callId}] atribuição automática: ninguém online, mantendo na fila`);
    return false;
  }

  sessao.assumirPorAtribuicao(alvo);
  logger.info(`[${sessao.ctx.callId}] conversa atribuída automaticamente a ${alvo.nome}`);
  return true;
}
