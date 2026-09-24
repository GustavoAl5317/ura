// Converte as definições de ferramenta da URA (formato Realtime) para o formato
// da Chat Completions API. Reaproveita EXATAMENTE as mesmas tools/consultas.

import { TOOL_DEFINITIONS } from '../tools/definitions';
import type { ChatToolFunction } from './openai';

// `ignorar_ruido` só existe por causa de alucinação de microfone (áudio) — não
// faz sentido em chat de texto.
const EXCLUIR_NO_CHAT = new Set(['ignorar_ruido']);

/**
 * Campos que a URA de VOZ exige e o chat não deve exigir.
 *
 * Na voz é preciso perguntar em qual WhatsApp mandar — a ligação pode vir de um
 * fixo. No chat a conversa JÁ é o WhatsApp do cliente. Mantê-los como
 * obrigatórios fazia a IA pedir o celular mesmo com o prompt proibindo: o schema
 * fala mais alto. Um cliente de (85) 8806-6590 digitou o próprio número, a
 * validação recusou por ter 10 dígitos, e ela respondeu que não conseguia
 * enviar o boleto.
 *
 * Os campos continuam existindo (aceitos quando o cliente pede outro número) —
 * só deixam de ser obrigatórios.
 */
const NAO_OBRIGATORIOS_NO_CHAT: Record<string, string[]> = {
  gerar_segunda_via: ['celular_whatsapp'],
  enviar_resumo_whatsapp: ['celular_whatsapp'],
};

function ajustarParaChat(nome: string, parameters: unknown): Record<string, unknown> {
  const p = (parameters as Record<string, unknown>) ?? { type: 'object', properties: {} };
  const remover = NAO_OBRIGATORIOS_NO_CHAT[nome];
  if (!remover || !Array.isArray(p.required)) return p;
  return { ...p, required: (p.required as string[]).filter((r) => !remover.includes(r)) };
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
