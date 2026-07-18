// Interface mínima para registrar ferramentas — desacopla os handlers de negócio
// (src/tools/handlers.ts) do transporte. Tanto o RealtimeClient (voz) quanto o
// ChatToolRegistry (WhatsApp/chat) satisfazem este contrato.

export type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

export interface ToolRegistrar {
  registerTool(name: string, handler: ToolHandler): void;
}
