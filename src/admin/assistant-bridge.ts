// Ponte URA → assistente de observabilidade.
//
// Roda DENTRO do processo da URA, que atende ligação em tempo real. Por isso as
// regras são duras:
//   - sem ASSISTANT_EVENTS_URL, não faz nada: a URA fica exatamente como antes;
//   - todo envio é fogo-e-esquece, com timeout de 3 s e erro engolido;
//   - nada aqui é aguardado no caminho da chamada;
//   - se o assistente estiver fora, a ligação não percebe.
//
// O que se manda é o mínimo para a Central: número, cliente identificado,
// ferramentas usadas (de onde se deriva a intenção) e o desfecho. Nada da
// conversa — nem transcrição, nem resposta da IA.

import axios from 'axios';
import { config } from '../config';
import { logger } from '../logger';
import { sessionRegistry } from './registry';

const TIMEOUT_MS = 3_000;
/** Ferramentas que não indicam intenção — só identificam o cliente. */
const SO_IDENTIFICACAO = new Set(['buscar_cliente_por_cpf', 'confirmar_titular_contrato', 'selecionar_contrato', 'ignorar_ruido']);

let falhasSeguidas = 0;

function enviar(evento: Record<string, unknown>): void {
  const base = config.ponteAssistente.url.replace(/\/+$/, '');
  void axios.post(`${base}/api/eventos/ura`, evento, {
    timeout: TIMEOUT_MS,
    headers: { 'x-admin-key': config.ponteAssistente.chave, 'Content-Type': 'application/json' },
  }).then(() => {
    if (falhasSeguidas >= 3) logger.info('Ponte assistente: voltou a entregar eventos');
    falhasSeguidas = 0;
  }).catch((err: unknown) => {
    falhasSeguidas++;
    // Loga na 1ª falha e depois a cada 20: assistente fora não pode encher o log da URA.
    if (falhasSeguidas === 1 || falhasSeguidas % 20 === 0) {
      logger.warn('Ponte assistente: evento não entregue', {
        falhasSeguidas,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  });
}

export function iniciarPonteAssistente(): void {
  if (!config.ponteAssistente.url) {
    logger.info('Ponte assistente: desligada (ASSISTANT_EVENTS_URL vazio)');
    return;
  }

  const ferramentasPorChamada = new Map<string, Set<string>>();
  const identificadas = new Set<string>();

  sessionRegistry.ouvir((ev) => {
    const callId = ev.tipo === 'evento' ? ev.evento.callId : ev.sessao.callId;

    switch (ev.tipo) {
      case 'inicio':
        ferramentasPorChamada.set(callId, new Set());
        enviar({ tipo: 'inicio', callId, numero: ev.sessao.callerNumber, at: ev.sessao.startedAt });
        return;

      case 'evento': {
        if (ev.evento.type !== 'tool_start') return;
        const nome = typeof ev.evento.data?.tool === 'string' ? ev.evento.data.tool : null;
        if (!nome || SO_IDENTIFICACAO.has(nome)) return;
        ferramentasPorChamada.get(callId)?.add(nome);
        return;
      }

      case 'meta':
        // Uma vez só, quando o nome aparece pela primeira vez.
        if (!ev.patch.clienteNome || identificadas.has(callId)) return;
        identificadas.add(callId);
        enviar({
          tipo: 'identificado', callId,
          clienteNome: ev.sessao.clienteNome, contratoId: ev.sessao.contratoId,
          ferramentas: [...(ferramentasPorChamada.get(callId) ?? [])],
        });
        return;

      case 'fim':
        enviar({
          tipo: 'fim', callId,
          numero: ev.sessao.callerNumber,
          clienteNome: ev.sessao.clienteNome, contratoId: ev.sessao.contratoId,
          ferramentas: [...(ferramentasPorChamada.get(callId) ?? [])],
          at: new Date().toISOString(),
        });
        ferramentasPorChamada.delete(callId);
        identificadas.delete(callId);
        return;
    }
  });

  logger.info(`Ponte assistente: enviando eventos de chamada para ${config.ponteAssistente.url}`);
}
