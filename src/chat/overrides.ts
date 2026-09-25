// Overrides das ferramentas cujo comportamento na voz depende do Asterisk/AMI e
// não se aplica ao chat. São aplicadas DEPOIS de registerTools(), substituindo a
// versão de voz. Toda a lógica de negócio (financeiro, ONU, massiva, faturas...)
// continua vindo dos handlers originais, sem alteração.

import type { CallContext } from '../session/context';
import type { ChatSession } from './session';
import { atribuirAutomaticamente } from './atribuicao';
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

export function registerChatOverrides(
  registry: ChatToolRegistry,
  ctx: CallContext,
  sessao?: ChatSession,
): void {
  // ── Transferência para humano ─────────────────────────────────────────────
  registry.override('transferir_para_atendente', async (args) => {
    // IA cobrindo a espera de uma atendente: a conversa JÁ é dela. Transferir
    // aqui redistribuiria para outra pessoa e tiraria o caso de quem o tem.
    if (sessao?.modo === 'humano') {
      return {
        sucesso: false,
        erro: 'ja_esta_com_atendente',
        mensagem: `Esta conversa já está com ${sessao.atendenteNome ?? 'uma atendente'}. Não transfira: `
          + 'diga ao cliente que ela vai dar continuidade assim que puder, e siga ajudando no que der.',
      };
    }
    const motivo = String(args.motivo ?? '');
    const resumo = String(args.resumo ?? '');
    const setor = String(args.setor ?? 'outro');
    ctx.transferMotivo = motivo;
    ctx.transferSummary = resumo;
    // Vendas vai para a FILA DE ADESÃO, não para a de atendimento: é a fila que
    // o time comercial acompanha. Antes, quem pedia instalação caía no bolo do
    // suporte e só chegava à adesão no fim do fluxo, via registrar_interesse —
    // depois de a IA levantar endereço, viabilidade, planos, nome, celular e
    // e-mail. Quem quer contratar precisa de gente, não de formulário.
    const fila = setor === 'vendas' ? 'adesao' : 'atendimento';
    entrarNaFila(ctx, fila, setor);

    // Entrega a conversa a alguém em vez de deixá-la esperando na fila para
    // alguém puxar. Quem está fechando uma contratação não espera. Se não
    // houver ninguém online, segue na fila com o escalonamento de sempre — e
    // se a pessoa escolhida não responder, a conversa volta para todos.
    const atribuida = sessao ? atribuirAutomaticamente(sessao, setor) : false;
    ctx.log.push(`Transferência (chat): ${motivo} [${setor}] → fila ${fila}`
      + (atribuida ? ' (atribuída automaticamente)' : ''));
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
      : atribuida
        ? 'Seu atendimento foi direcionado para um de nossos atendentes, que continuará com você agora. 🙂'
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
      if (tipo === 'nova_assinatura' && !falhou && sessao?.modo !== 'humano') {
        entrarNaFila(ctx, 'adesao', 'vendas');
        if (sessao) atribuirAutomaticamente(sessao, 'vendas');
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
    // Conversa com atendente só a atendente encerra (botão ✅ no painel).
    if (sessao?.modo === 'humano') {
      return {
        sucesso: false,
        erro: 'conversa_com_atendente',
        mensagem: 'Esta conversa está com uma atendente — não encerre. Só se despeça se o cliente se despedir.',
      };
    }
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
