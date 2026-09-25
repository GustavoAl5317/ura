// Converte as definições de ferramenta da URA (formato Realtime) para o formato
// da Chat Completions API. Reaproveita EXATAMENTE as mesmas tools/consultas.

import { TOOL_DEFINITIONS } from '../tools/definitions';
import type { ChatToolFunction } from './openai';

// `ignorar_ruido` só existe por causa de alucinação de microfone (áudio) — não
// faz sentido em chat de texto.
const EXCLUIR_NO_CHAT = new Set(['ignorar_ruido']);

/**
 * Campos que existem para a URA de VOZ e NÃO devem existir no chat.
 *
 * Na ligação é preciso perguntar em qual WhatsApp mandar — a chamada pode vir de
 * um fixo. No chat a conversa JÁ é o WhatsApp do cliente, e é o único número
 * comprovadamente válido: ele acabou de escrever dele.
 *
 * Removidos das PROPERTIES, não só de `required`: enquanto o campo aparecer no
 * schema o modelo tenta preenchê-lo e vai perguntar ao cliente, por mais que o
 * prompt proíba. Foi o que aconteceu com um cliente de (85) 8806-6590 — ele
 * digitou o próprio número, a validação recusou por ter 10 dígitos e a IA
 * respondeu que não conseguia enviar o boleto.
 *
 * Cliente que peça envio em OUTRO número vira caso de atendente humana, que
 * consegue confirmar a entrega. A IA não consegue.
 */
const CAMPOS_SO_DA_VOZ: Record<string, string[]> = {
  gerar_segunda_via: ['celular_whatsapp', 'celular_confirmado'],
  enviar_resumo_whatsapp: ['celular_whatsapp', 'celular_confirmado'],
};

function ajustarParaChat(nome: string, parameters: unknown): Record<string, unknown> {
  const p = (parameters as Record<string, unknown>) ?? { type: 'object', properties: {} };
  const remover = CAMPOS_SO_DA_VOZ[nome];
  if (!remover) return p;

  const props = { ...(p.properties as Record<string, unknown> ?? {}) };
  for (const campo of remover) delete props[campo];

  const required = Array.isArray(p.required)
    ? (p.required as string[]).filter((r) => !remover.includes(r))
    : p.required;

  return { ...p, properties: props, required };
}

export function buildChatTools(): ChatToolFunction[] {
  return TOOL_DEFINITIONS.filter((t) => !EXCLUIR_NO_CHAT.has(t.name)).map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: ajustarParaChat(t.name, t.parameters),
    },
  }));
}
