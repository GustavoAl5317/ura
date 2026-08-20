// Overrides das ferramentas cujo comportamento na voz depende do Asterisk/AMI e
// não se aplica ao chat. São aplicadas DEPOIS de registerTools(), substituindo a
// versão de voz. Toda a lógica de negócio (financeiro, ONU, massiva, faturas...)
// continua vindo dos handlers originais, sem alteração.

import type { CallContext } from '../session/context';
import { whatsapp } from '../integrations/whatsapp';
import { config } from '../config';
import { logger } from '../logger';
import type { ChatToolRegistry } from './tool-registry';
import { estaNoHorarioComercial, descricaoHorarioComercial } from '../utils/horario-comercial';

// Ferramentas que enviam algo "por WhatsApp". No chat, o número do cliente é o
// próprio remetente da conversa — então forçamos o destino e a confirmação, sem
// o cliente precisar ditar/confirmar número.
export const WHATSAPP_TOOLS = new Set([
  'gerar_segunda_via',
  'abrir_chamado',
  'enviar_resumo_whatsapp',
]);

/** Marca a entrada na fila (nível 1) — usado tanto pela transferência quanto pela adesão. */
function entrarNaFila(ctx: CallContext, tipo: 'atendimento' | 'adesao', setor: string): void {
  ctx.pendingTransfer = true;
  ctx.filaTipo = tipo;
  ctx.filaEntradaEm = Date.now();
  ctx.filaNivelEnviado = 1;
  ctx.transferSetor = setor;
}

export function registerChatOverrides(registry: ChatToolRegistry, ctx: CallContext): void {
  // ── Transferência para humano ─────────────────────────────────────────────
  registry.override('transferir_para_atendente', async (args) => {
    const motivo = String(args.motivo ?? '');
    const resumo = String(args.resumo ?? '');
    const setor = String(args.setor ?? 'outro');
    ctx.transferMotivo = motivo;
    ctx.transferSummary = resumo;
    entrarNaFila(ctx, 'atendimento', setor);
    ctx.log.push(`Transferência (chat): ${motivo} [${setor}]`);
    logger.info(`[${ctx.callId}] Transferência solicitada (chat): ${motivo} [${setor}]`);

    const foraDoHorario = !estaNoHorarioComercial();

    if (config.chat.handoffGroupId) {
      const nome = ctx.cliente?.nome ?? 'Cliente não identificado';
      const numero = ctx.callerNumber || '(desconhecido)';
      const texto = [
        `🔔 *Transferência de atendimento (chat)*${foraDoHorario ? ' — fora do expediente' : ''}`,
        '',
        `👤 *Cliente:* ${nome}`,
        `📱 *WhatsApp:* ${numero}`,
        ctx.cliente?.contratoId ? `📋 *Contrato:* ${ctx.cliente.contratoId}` : null,
        `📝 *Setor:* ${setor}`,
        `📝 *Motivo:* ${motivo || '-'}`,
        '',
        `💬 *Resumo:* ${resumo || '-'}`,
      ].filter((l) => l !== null).join('\n');
      await whatsapp.enviarGrupo(config.chat.handoffGroupId, texto, ctx.whatsappInstance);
    }

    // Mensagem de nível 1 (imediata) mandada AQUI, direto — não depende do
    // texto que a IA escrever depois. As mensagens de nível 2/3/4 (fila
    // parada) disparam sozinhas pelo sweep da sessão, sem turno de IA
    // nenhum rolando — por isso a nível 1 também precisa ser garantida aqui.
    const mensagemCliente = foraDoHorario
      ? `No momento não há atendimento humano disponível — nosso horário é ${descricaoHorarioComercial()}. `
        + 'Seu pedido ficou registrado e um atendente continua assim que o expediente reabrir.'
      : 'Seu atendimento foi direcionado para nossa equipe. Um atendente continuará com você em breve.';
    if (ctx.enviarTextoCliente && ctx.callerNumber) {
      await ctx.enviarTextoCliente(ctx.callerNumber, mensagemCliente);
    }

    return {
      sucesso: true,
      fora_do_horario: foraDoHorario,
      mensagem: 'Transferência registrada e o cliente JÁ recebeu automaticamente o aviso de transferência '
        + '(com o horário de atendimento, se for fora do expediente). NÃO repita esse aviso — não é '
        + 'obrigatório escrever mais nada agora; se quiser, feche com uma frase curta e cordial.',
    };
  });

  // ── Registro de interesse: adesão tem prioridade sobre "só registrar" ──────
  const registrarInteresseOriginal = registry.get('registrar_interesse');
  if (registrarInteresseOriginal) {
    registry.override('registrar_interesse', async (args) => {
      const resultado = await registrarInteresseOriginal(args);
      const tipo = String(args.tipo_interesse ?? '');
      const falhou = !!resultado && typeof resultado === 'object'
        && (resultado as Record<string, unknown>).sucesso === false;

      // Intenção clara de contratar não pode ficar só registrada — vira fila
      // própria, com o mesmo tratamento (aviso imediato + escalonamento) que
      // a transferência para humano, pra não perder a venda por ninguém ver.
      if (tipo === 'nova_assinatura' && !falhou) {
        entrarNaFila(ctx, 'adesao', 'vendas');
        ctx.transferMotivo = 'Adesão — nova assinatura';
        ctx.log.push('Cliente encaminhado para a FILA DE ADESÃO (nova assinatura)');
        logger.info(`[${ctx.callId}] Fila de adesão (chat): nova assinatura`);

        if (ctx.enviarTextoCliente && ctx.callerNumber) {
          await ctx.enviarTextoCliente(
            ctx.callerNumber,
            'Perfeito! Vou direcionar seu atendimento para nossa equipe de adesão, que dará '
            + 'continuidade à sua contratação. Aguarde só um momento. 😊',
          );
        }

        return {
          ...(resultado as Record<string, unknown>),
          fila: 'adesao',
          mensagem: 'Interesse registrado E o cliente já foi encaminhado para a FILA DE ADESÃO — ele já '
            + 'recebeu o aviso automaticamente, NÃO repita essa mensagem. Não é obrigatório escrever mais '
            + 'nada agora.',
        };
      }

      return resultado;
    });
  }

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
