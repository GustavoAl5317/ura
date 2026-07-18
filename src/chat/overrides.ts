// Overrides das ferramentas cujo comportamento na voz depende do Asterisk/AMI e
// não se aplica ao chat. São aplicadas DEPOIS de registerTools(), substituindo a
// versão de voz. Toda a lógica de negócio (financeiro, ONU, massiva, faturas...)
// continua vindo dos handlers originais, sem alteração.

import type { CallContext } from '../session/context';
import { whatsapp } from '../integrations/whatsapp';
import { config } from '../config';
import { logger } from '../logger';
import type { ChatToolRegistry } from './tool-registry';

// Ferramentas que enviam algo "por WhatsApp". No chat, o número do cliente é o
// próprio remetente da conversa — então forçamos o destino e a confirmação, sem
// o cliente precisar ditar/confirmar número.
export const WHATSAPP_TOOLS = new Set([
  'gerar_segunda_via',
  'abrir_chamado',
  'enviar_resumo_whatsapp',
]);

export function registerChatOverrides(registry: ChatToolRegistry, ctx: CallContext): void {
  // ── Transferência para humano ─────────────────────────────────────────────
  registry.override('transferir_para_atendente', async (args) => {
    const motivo = String(args.motivo ?? '');
    const resumo = String(args.resumo ?? '');
    ctx.transferMotivo = motivo;
    ctx.transferSummary = resumo;
    ctx.pendingTransfer = true;
    ctx.log.push(`Transferência (chat): ${motivo}`);
    logger.info(`[${ctx.callId}] Transferência solicitada (chat): ${motivo}`);

    if (config.chat.handoffGroupId) {
      const nome = ctx.cliente?.nome ?? 'Cliente não identificado';
      const numero = ctx.callerNumber || '(desconhecido)';
      const texto = [
        '🔔 *Transferência de atendimento (chat)*',
        '',
        `👤 *Cliente:* ${nome}`,
        `📱 *WhatsApp:* ${numero}`,
        ctx.cliente?.contratoId ? `📋 *Contrato:* ${ctx.cliente.contratoId}` : null,
        `📝 *Motivo:* ${motivo || '-'}`,
        '',
        `💬 *Resumo:* ${resumo || '-'}`,
      ].filter((l) => l !== null).join('\n');
      await whatsapp.enviarGrupo(config.chat.handoffGroupId, texto, ctx.whatsappInstance);
    }

    return {
      sucesso: true,
      mensagem:
        'Transferência registrada. Avise o cliente que um atendente humano vai continuar ' +
        'o atendimento por aqui em breve e finalize sua mensagem com empatia.',
    };
  });

  // ── Encerramento ───────────────────────────────────────────────────────────
  registry.override('encerrar_atendimento', async (args) => {
    if (ctx.pendingTransfer) {
      return {
        sucesso: false,
        erro: 'transferencia_em_andamento',
        mensagem: 'Transferência em andamento — não encerre a conversa.',
      };
    }
    const motivo = String(args.motivo ?? 'concluído');
    ctx.pendingHangup = true;
    ctx.log.push(`Encerrado (chat): ${motivo}`);
    logger.info(`[${ctx.callId}] Encerramento (chat): ${motivo}`);
    return {
      sucesso: true,
      mensagem: 'Envie a mensagem de despedida ao cliente. A conversa será encerrada.',
    };
  });
}

/**
 * No chat já conhecemos o WhatsApp do cliente (é o remetente). Injeta o número e a
 * confirmação nas ferramentas de envio, para o fluxo não travar pedindo/confirmando
 * número — a fatura/protocolo cai na própria conversa.
 */
export function ajustarArgsWhatsapp(
  name: string,
  args: Record<string, unknown>,
  ctx: CallContext,
): Record<string, unknown> {
  if (!WHATSAPP_TOOLS.has(name)) return args;
  const numero = ctx.celularWhatsApp || ctx.callerNumber;
  return {
    ...args,
    celular_whatsapp: numero,
    celular_confirmado: true,
  };
}
