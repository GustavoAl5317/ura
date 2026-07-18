// Registry de ferramentas para o canal de chat. Satisfaz o contrato ToolRegistrar,
// então os MESMOS handlers de negócio da URA (src/tools/handlers.ts) são registrados
// aqui sem qualquer alteração. O que muda é só o transporte (texto em vez de voz).

import type { ToolRegistrar, ToolHandler } from '../tools/registrar';
import { logger } from '../logger';

export class ChatToolRegistry implements ToolRegistrar {
  private tools = new Map<string, ToolHandler>();

  registerTool(name: string, handler: ToolHandler): void {
    this.tools.set(name, handler);
  }

  /** Substitui um handler já registrado (usado pelas overrides de chat). */
  override(name: string, handler: ToolHandler): void {
    this.tools.set(name, handler);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  async dispatch(name: string, args: Record<string, unknown>): Promise<unknown> {
    const handler = this.tools.get(name);
    if (!handler) {
      logger.warn(`[chat] Tool desconhecida: ${name}`);
      return { erro: 'tool_desconhecida', mensagem: `Ferramenta '${name}' não existe.` };
    }
    return handler(args);
  }
}
