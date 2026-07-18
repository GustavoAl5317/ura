// Converte as definições de ferramenta da URA (formato Realtime) para o formato
// da Chat Completions API. Reaproveita EXATAMENTE as mesmas tools/consultas.

import { TOOL_DEFINITIONS } from '../tools/definitions';
import type { ChatToolFunction } from './openai';

// `ignorar_ruido` só existe por causa de alucinação de microfone (áudio) — não
// faz sentido em chat de texto.
const EXCLUIR_NO_CHAT = new Set(['ignorar_ruido']);

export function buildChatTools(): ChatToolFunction[] {
  return TOOL_DEFINITIONS.filter((t) => !EXCLUIR_NO_CHAT.has(t.name)).map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: (t.parameters as Record<string, unknown>) ?? {
        type: 'object',
        properties: {},
      },
    },
  }));
}
