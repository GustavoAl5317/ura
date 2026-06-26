import { sgp, formatarEndereco } from '../integrations/sgp';
import { geosite } from '../integrations/geosite';
import { whatsapp } from '../integrations/whatsapp';
import { config } from '../config';
import { logger } from '../logger';
import type { CallContext } from '../session/context';
import type { RealtimeClient } from '../realtime/client';
import type { SgpPlano } from '../integrations/sgp';

// Remove planos não-comerciais do SGP (revendedores, dedicados, R$0, enterprise)
const PLANO_LIXO = /dedicad|enterpric|semi[\s_-]?dedicad|provedor|\btelecom\b|brush|gol net|rede br|sigma|tecno link|turbinet|wescley|cybervivo|anali|paulo roberto|supermercado|granja/i;

// Classifica o sinal óptico (RX em dBm) conforme as faixas de qualidade da operação.
// Mais negativo = pior. Usado principalmente no diagnóstico de lentidão.
function classificarSinalOptico(
  rx: number | null,
): { faixa: 'muito_bom' | 'regular' | 'ruim'; descricao: string } | null {
  if (rx === null || !Number.isFinite(rx)) return null;
  if (rx >= -22) return { faixa: 'muito_bom', descricao: 'Sinal óptico muito bom (-17 a -22 dBm)' };
  if (rx >= -24) return { faixa: 'regular', descricao: 'Sinal óptico regular (-23 a -24 dBm)' };
  return { faixa: 'ruim', descricao: 'Sinal óptico ruim (abaixo de -24 dBm)' };
}

/** Celular informado pelo cliente — obrigatório para WhatsApp (não usa fixo da chamada automaticamente). */
function resolverWhatsAppCliente(
  ctx: CallContext,
  informado?: string,
): { numero: string | null; motivo?: string } {
  const tel = (informado ?? ctx.celularWhatsApp)?.trim();
  if (!tel) {
    return { numero: null, motivo: 'celular_nao_informado' };
  }
  if (!whatsapp.isCelularBr(tel)) {
    return { numero: null, motivo: 'celular_invalido' };
  }
  const numero = tel.replace(/\D/g, '');
  ctx.celularWhatsApp = numero;
  return { numero };
}

interface EnvioWhatsappParams {
  celular_whatsapp?: string;
  resumo_atendimento?: string;
  resposta_cliente?: string;
  fatura?: CallContext['faturaWhatsApp'];
}

async function enviarWhatsappAtendimento(
  ctx: CallContext,
  params: EnvioWhatsappParams,
): Promise<{ enviado: boolean; motivo?: string }> {
  if (!ctx.cliente) {
    return { enviado: false, motivo: 'cliente_nao_identificado' };
  }

  const resumo = params.resumo_atendimento?.trim();
  const resposta = params.resposta_cliente?.trim();
  if (!resumo || !resposta) {
    return { enviado: false, motivo: 'resumo_ou_resposta_ausente' };
  }

  const destino = resolverWhatsAppCliente(ctx, params.celular_whatsapp);
  if (!destino.numero) {
    return { enviado: false, motivo: destino.motivo };
  }

  const fatura = params.fatura ?? ctx.faturaWhatsApp;
  const enviado = await whatsapp.enviarResumoAtendimento(destino.numero, {
    clienteNome: ctx.cliente.nome,
    resumoAtendimento: resumo,
    respostaCliente: resposta,
    protocolos: ctx.protocolos.length ? [...ctx.protocolos] : undefined,
    fatura,
  });

  return { enviado, motivo: enviado ? undefined : 'falha_api_whatsapp' };
}

/** Bloqueia ferramentas sensíveis até o titular confirmar identidade (fluxo CPF). */
function bloqueioSemConfirmacao(ctx: CallContext): Record<string, unknown> | null {
  if (ctx.cliente && ctx.clienteIdentificado && !ctx.clienteConfirmado) {
    return {
      erro: 'titular_nao_confirmado',
      nome_contrato: ctx.cliente.nome,
      mensagem:
        'Aguarde o cliente confirmar a identidade antes de consultar ou executar ações. ' +
        'Use confirmar_titular_contrato após a resposta dele.',
    };
  }
  return null;
}

function listarContratos(ctx: CallContext) {
  if (!ctx.cliente) return [];
  return ctx.cliente.contratos.map((ct) => ({
    contrato_id: ct.contrato,
    endereco: formatarEndereco(ct.endereco ?? ctx.cliente!.endereco),
    plano: ct.servicos[0]?.plano?.descricao ?? null,
    status: ct.status,
    motivo_status: ct.motivo_status,
  }));
}

function aplicarSelecaoContrato(ctx: CallContext, contratoId: number): boolean {
  if (!ctx.cliente) return false;
  const ct = ctx.cliente.contratos.find((c) => c.contrato === contratoId);
  if (!ct) return false;

  ctx.cliente.contratoId = contratoId;
  if (ct.endereco) ctx.cliente.endereco = ct.endereco;
  ctx.contratoSelecionado = true;
  ctx.titulos = undefined;
  ctx.onu = undefined;
  return true;
}

function syncContratoSelecionado(ctx: CallContext): void {
  if (!ctx.cliente) return;
  if (ctx.cliente.contratos.length <= 1 && ctx.cliente.contratos[0]) {
    aplicarSelecaoContrato(ctx, ctx.cliente.contratos[0].contrato);
  }
}

/** Bloqueia consultas até o cliente escolher o contrato (quando há mais de um). */
function bloqueioSemContrato(ctx: CallContext): Record<string, unknown> | null {
  if (!ctx.cliente || ctx.cliente.contratos.length <= 1) return null;
  if (ctx.contratoSelecionado && ctx.cliente.contratoId) return null;

  const contratos = listarContratos(ctx);
  return {
    erro: 'contrato_nao_selecionado',
    quantidade_contratos: contratos.length,
    contratos_disponiveis: contratos,
    mensagem:
      'Este cliente tem mais de um contrato. Pergunte QUAL ENDEREÇO ele quer tratar antes de consultar ou executar ações.',
    orientacao:
      'Leia os endereços de forma natural: "Vi que você tem contrato na Rua X e na Rua Y — é sobre qual endereço?" ' +
      'Após a resposta, chame selecionar_contrato(contrato_id) com o ID correspondente.',
  };
}

function bloqueioConsultas(ctx: CallContext): Record<string, unknown> | null {
  return bloqueioSemConfirmacao(ctx) ?? bloqueioSemContrato(ctx);
}

/** cliente_id nas tools = contrato_id do SGP (retornado por buscar_cliente_por_cpf). */
function resolverContratoId(
  ctx: CallContext,
  raw?: unknown,
  toolName?: string,
): { contratoId: number } | { erro: string; mensagem: string } {
  const fromArgs = Number(raw);
  const fromCtx = ctx.cliente?.contratoId;
  const contratoId =
    Number.isFinite(fromArgs) && fromArgs > 0 ? fromArgs : (fromCtx ?? 0);

  if (!contratoId || contratoId <= 0) {
    const multi = (ctx.cliente?.contratos.length ?? 0) > 1;
    return {
      erro: multi ? 'contrato_nao_selecionado' : 'contrato_nao_identificado',
      mensagem: multi
        ? 'Cliente tem mais de um contrato. Pergunte o ENDEREÇO e use selecionar_contrato antes.'
        : 'Contrato não identificado. Busque o cliente por CPF e confirme o titular primeiro.',
    };
  }

  if (raw !== undefined && Number(raw) !== contratoId && toolName) {
    logger.warn(`[${ctx.callId}] ${toolName}: cliente_id=${raw} ignorado — usando contrato ${contratoId}`);
  }

  return { contratoId };
}

function resolverFaturaId(
  ctx: CallContext,
  raw?: unknown,
): number | undefined {
  const fromArgs = Number(raw);
  if (Number.isFinite(fromArgs) && fromArgs > 0) return fromArgs;
  const titulo = ctx.titulos?.[0];
  return titulo?.id ?? titulo?.numeroDocumento ?? undefined;
}

/** Nome curto para fala (primeiro nome ou primeiras palavras). */
function nomeParaConfirmacao(nome: string): { nomeContrato: string; nomeFalado: string } {
  const nomeContrato = nome.trim();
  const partes = nomeContrato.split(/\s+/).filter(Boolean);
  const pareceEmpresa = /ltda|me\b|eireli|s\.?a\.?|cnpj|fttx|conjunto|residencial|comercial/i.test(nomeContrato);
  const nomeFalado = pareceEmpresa || partes.length > 4
    ? nomeContrato
    : partes[0] ?? nomeContrato;
  return { nomeContrato, nomeFalado };
}

/** Extrai só dígitos do CPF informado (com ou sem pontuação). */
function cpfDigitos(raw: string): string {
  return raw.replace(/\D/g, '');
}

function filtrarPlanosComerciais(planos: SgpPlano[]): SgpPlano[] {
  const { ids, precoMin, precoMax, max } = config.plans;
  // 1. Whitelist explícita por .env tem prioridade — preserva a ordem informada
  if (ids.length) {
    const byId = new Map(planos.map((p) => [p.id, p]));
    return ids.map((id) => byId.get(id)).filter((p): p is SgpPlano => !!p);
  }
  // 2. Heurística: descarta lixo, fora da faixa de preço, ordena por preço
  return planos
    .filter((p) => {
      const preco = parseFloat(p.preco);
      return Number.isFinite(preco) && preco >= precoMin && preco <= precoMax && !PLANO_LIXO.test(p.descricao);
    })
    .sort((a, b) => parseFloat(a.preco) - parseFloat(b.preco))
    .slice(0, max);
}

export function registerTools(client: RealtimeClient, ctx: CallContext): void {

  // ── Identificação ─────────────────────────────────────────────────────────

  client.registerTool('buscar_cliente_por_cpf', async (args) => {
    const digitos = cpfDigitos(String(args.cpf ?? ''));
    if (digitos.length !== 11) {
      return {
        encontrado: false,
        erro: 'cpf_invalido',
        digitos_recebidos: digitos.length,
        mensagem:
          digitos.length < 11
            ? `CPF incompleto: ${digitos.length} dígitos (precisa 11). Confira se expandiu todos os grupos — ex.: "800-669-690-00" = 800 + 669 + 690 + 00 = onze dígitos.`
            : `CPF com dígitos a mais (${digitos.length}). Confirme com o cliente e tente de novo.`,
      };
    }

    const cliente = await sgp.buscarPorCpf(digitos);
    if (!cliente) return { encontrado: false, mensagem: 'CPF não encontrado no cadastro.' };

    ctx.cliente = cliente;
    ctx.clienteIdentificado = true;
    ctx.clienteConfirmado = false;
    ctx.contratoSelecionado = cliente.contratos.length === 1;
    if (ctx.contratoSelecionado) syncContratoSelecionado(ctx);

    const contratosLista = listarContratos(ctx);
    const multiplos = contratosLista.length > 1;

    ctx.log.push(
      `Identificado por CPF: ${cliente.nome} (${contratosLista.length} contrato(s)) — aguardando confirmação`,
    );
    logger.info(`[${ctx.callId}] Cliente identificado: ${cliente.nome} (${contratosLista.length} contratos)`);

    const { nomeContrato, nomeFalado } = nomeParaConfirmacao(cliente.nome);

    const orientacaoTitular =
      `PARE aqui — não consulte financeiro nem técnico ainda. ` +
      `Diga: "O nome que consta no contrato é ${nomeContrato}. ` +
      `Confirma que estou falando com ${nomeFalado}?" ` +
      `Se SIM → confirmar_titular_contrato(confirmado:true). ` +
      `Se NÃO → confirmar_titular_contrato(confirmado:false) e verifique se o CPF está correto.`;

    const orientacaoContratos = multiplos
      ? ` Após confirmar o titular, pergunte QUAL ENDEREÇO o cliente quer tratar (leia os endereços) e use selecionar_contrato.`
      : '';

    return {
      encontrado: true,
      titular_confirmado: false,
      multiplos_contratos: multiplos,
      nome: cliente.nome,
      nome_contrato: nomeContrato,
      nome_para_confirmar: nomeFalado,
      cpf: cliente.cpfcnpj,
      contrato_id: cliente.contratoId ?? null,
      contratos_disponiveis: contratosLista,
      telefones_cadastro: cliente.telefones ?? [],
      status_contrato: cliente.contratos[0]?.status,
      motivo_status: cliente.contratos[0]?.motivo_status,
      plano: cliente.contratos[0]?.servicos[0]?.plano?.descricao,
      endereco: formatarEndereco(cliente.endereco),
      orientacao: orientacaoTitular + orientacaoContratos,
    };
  });

  client.registerTool('selecionar_contrato', async (args) => {
    if (!ctx.cliente) {
      return { sucesso: false, mensagem: 'Nenhum cliente identificado. Busque pelo CPF primeiro.' };
    }

    const bloqueio = bloqueioSemConfirmacao(ctx);
    if (bloqueio) return bloqueio;

    const contratoId = Number(args.contrato_id);
    if (!Number.isFinite(contratoId) || contratoId <= 0) {
      return {
        sucesso: false,
        mensagem: 'contrato_id inválido.',
        contratos_disponiveis: listarContratos(ctx),
      };
    }

    if (!aplicarSelecaoContrato(ctx, contratoId)) {
      return {
        sucesso: false,
        mensagem: 'Contrato não encontrado para este cliente.',
        contratos_disponiveis: listarContratos(ctx),
        orientacao: 'Confirme com o cliente qual ENDEREÇO e use o contrato_id correto da lista.',
      };
    }

    const ct = ctx.cliente.contratos.find((c) => c.contrato === contratoId)!;
    ctx.log.push(`Contrato selecionado: ${contratoId} — ${formatarEndereco(ct.endereco)}`);

    return {
      sucesso: true,
      contrato_id: contratoId,
      endereco: formatarEndereco(ct.endereco ?? ctx.cliente.endereco),
      plano: ct.servicos[0]?.plano?.descricao ?? null,
      status: ct.status,
      motivo_status: ct.motivo_status,
      mensagem: 'Contrato selecionado. Pode prosseguir com consultas e atendimento deste endereço.',
    };
  });

  client.registerTool('confirmar_titular_contrato', async (args) => {
    if (!ctx.cliente) {
      return {
        sucesso: false,
        mensagem: 'Nenhum cliente identificado. Busque pelo CPF com buscar_cliente_por_cpf primeiro.',
      };
    }

    const confirmado = args.confirmado === true;
    const nomeContrato = ctx.cliente.nome;

    if (confirmado) {
      ctx.clienteConfirmado = true;
      ctx.log.push(`Titular confirmado: ${nomeContrato}`);

      const multiplos = (ctx.cliente.contratos.length > 1);
      if (multiplos && !ctx.contratoSelecionado) {
        const contratos = listarContratos(ctx);
        return {
          sucesso: true,
          confirmado: true,
          multiplos_contratos: true,
          contratos_disponiveis: contratos,
          mensagem: 'Identidade confirmada.',
          orientacao:
            'Agora pergunte QUAL ENDEREÇO o cliente quer tratar. Leia os endereços da lista: ' +
            '"Vi que você tem mais de um contrato — é sobre qual endereço?" ' +
            'Após a resposta, chame selecionar_contrato(contrato_id). ' +
            'PROIBIDO consultar financeiro, massiva ou ONU antes de selecionar o contrato.',
        };
      }

      syncContratoSelecionado(ctx);
      return {
        sucesso: true,
        confirmado: true,
        contrato_id: ctx.cliente.contratoId,
        endereco: formatarEndereco(ctx.cliente.endereco),
        mensagem: 'Identidade confirmada. Pode prosseguir com consultas e atendimento.',
      };
    }

    ctx.cliente = undefined;
    ctx.clienteIdentificado = false;
    ctx.clienteConfirmado = false;
    ctx.contratoSelecionado = false;
    ctx.titulos = undefined;
    ctx.contratoSelecionado = false;
    ctx.log.push(`Titular NÃO confirmado (cadastro: ${nomeContrato})`);

    return {
      sucesso: true,
      confirmado: false,
      nome_contrato_rejeitado: nomeContrato,
      mensagem: 'Titular não confirmou identidade.',
      orientacao:
        'Pergunte: "O CPF informado está correto?" ' +
        'Se o CPF estiver errado, peça o CPF novamente e busque de novo. ' +
        'Se o CPF estiver certo mas não é o titular, oriente que o titular do contrato precisa ligar ou autorizar.',
    };
  });

  // ── Financeiro ─────────────────────────────────────────────────────────────

  client.registerTool('consultar_financeiro', async (args) => {
    const bloqueio = bloqueioConsultas(ctx);
    if (bloqueio) return bloqueio;

    const contrato = resolverContratoId(ctx, args.cliente_id, 'consultar_financeiro');
    if ('erro' in contrato) return { sucesso: false, ...contrato };
    const contratoId = contrato.contratoId;

    const tits = await sgp.titulos(contratoId, 'abertos');
    ctx.titulos = tits;

    const inadimplente = tits.some((t) => t.status === 'aberto' && t.diasAtraso > 0);
    const valorTotal = tits.reduce((s, t) => s + (t.valorCorrigido ?? t.valor), 0);
    const ct = ctx.cliente?.contratos[0];
    const statusContrato = ct?.status ?? null;
    const motivoStatus = ct?.motivo_status ?? null;
    const contratoSuspenso = /suspens|bloquead|cancelad/i.test(statusContrato ?? '');
    const temFaturasAbertas = tits.length > 0;

    return {
      contrato_id: contratoId,
      inadimplente,
      contrato_suspenso: contratoSuspenso,
      status_contrato: statusContrato,
      motivo_status: motivoStatus,
      bloqueio_financeiro: inadimplente || (contratoSuspenso && /financ/i.test(motivoStatus ?? '')),
      tem_faturas_abertas: temFaturasAbertas,
      total_em_aberto: `R$ ${valorTotal.toFixed(2).replace('.', ',')}`,
      faturas: tits.map((t) => ({
        id: t.id,
        numero_documento: t.numeroDocumento,
        valor: `R$ ${t.valorCorrigido.toFixed(2).replace('.', ',')}`,
        vencimento: t.dataVencimento,
        atraso_dias: t.diasAtraso,
        status: t.status,
        tem_pix: !!t.codigoPix,
        tem_boleto: !!t.codigoBarras || !!t.link,
      })),
      orientacao: temFaturasAbertas
        ? 'Há faturas em aberto — pode oferecer segunda via/PIX com gerar_segunda_via usando faturas[].id.'
        : contratoSuspenso
          ? 'Contrato suspenso/bloqueado MAS sem faturas em aberto no sistema. NÃO ofereça boleto. Explique a situação e avalie desbloqueio_confianca ou oriente contato comercial.'
          : 'Situação financeira regular — sem faturas pendentes.',
    };
  });

  client.registerTool('gerar_segunda_via', async (args) => {
    const bloqueio = bloqueioConsultas(ctx);
    if (bloqueio) return bloqueio;

    const contrato = resolverContratoId(ctx, args.cliente_id, 'gerar_segunda_via');
    if ('erro' in contrato) return { sucesso: false, ...contrato };
    const contratoId = contrato.contratoId;

    let titulos = ctx.titulos;
    if (!titulos?.length) {
      titulos = await sgp.titulos(contratoId, 'abertos');
      ctx.titulos = titulos;
    }

    if (!titulos.length) {
      const ct = ctx.cliente?.contratos[0];
      return {
        sucesso: false,
        mensagem: 'Não há faturas em aberto para gerar segunda via.',
        tem_faturas_abertas: false,
        status_contrato: ct?.status ?? null,
        motivo_status: ct?.motivo_status ?? null,
        orientacao:
          'NÃO diga ao cliente que há boleto ou fatura disponível. ' +
          'O contrato pode estar com redução de velocidade por motivo financeiro, mas o sistema não tem fatura em aberto. ' +
          'Peça desculpas pela confusão se você ofereceu boleto antes. Avalie desbloqueio_confianca ou oriente contato comercial.',
      };
    }

    const faturaId = resolverFaturaId(ctx, args.fatura_id);
    const enviarWpp = args.enviar_whatsapp !== false;

    const r = await sgp.fatura2via(contratoId);
    if (!r || !r.links?.length) {
      return {
        sucesso: false,
        mensagem: 'Não foi possível gerar segunda via no momento. Tente novamente ou oriente o cliente a acessar o portal.',
        tem_faturas_abertas: true,
        contrato_id: contratoId,
      };
    }

    // Pega a fatura específica ou a mais recente
    const linkObj = faturaId
      ? r.links.find((l) => l.fatura === faturaId) ?? r.links[0]
      : r.links[0];

    // Garante que temos os títulos em aberto para localizar um PIX já emitido.
    titulos = ctx.titulos ?? titulos;

    // O modelo pode passar o id do título OU o número da fatura — tenta os dois
    // (id e numeroDocumento) e, como último recurso, casa por valor.
    const tituloMatch =
      titulos.find((t) => t.id === faturaId || t.numeroDocumento === faturaId) ??
      titulos.find((t) => t.id === linkObj.fatura || t.numeroDocumento === linkObj.fatura) ??
      titulos.find((t) => Math.abs((t.valorCorrigido ?? t.valor) - linkObj.valor) < 0.01);

    let pixCola = tituloMatch?.codigoPix ?? '';
    if (!pixCola) {
      pixCola = await sgp.gerarPix(linkObj.fatura, contratoId) ?? '';
    }

    const linkBoleto = linkObj.link;
    const linhaDigitavel = linkObj.linhadigitavel;
    const valorFmt = `R$ ${linkObj.valor.toFixed(2).replace('.', ',')}`;

    ctx.faturaWhatsApp = {
      valor: valorFmt,
      vencimento: linkObj.vencimento,
      pixCopiaCola: pixCola || null,
      linkBoleto: linkBoleto || null,
      linhaDigitavel: linhaDigitavel || null,
    };

    let wppEnviado = false;
    let wppMotivo: string | undefined;

    if (enviarWpp) {
      const resultado = await enviarWhatsappAtendimento(ctx, {
        celular_whatsapp: args.celular_whatsapp ? String(args.celular_whatsapp) : undefined,
        resumo_atendimento: args.resumo_atendimento ? String(args.resumo_atendimento) : undefined,
        resposta_cliente: args.resposta_cliente ? String(args.resposta_cliente) : undefined,
        fatura: ctx.faturaWhatsApp,
      });
      wppEnviado = resultado.enviado;
      wppMotivo = resultado.motivo;
      if (!wppEnviado) {
        logger.warn(`[${ctx.callId}] WhatsApp não enviado`, { motivo: wppMotivo });
      }
    }

    ctx.log.push(`Segunda via gerada (fatura ${linkObj.fatura}, R$${linkObj.valor})`);

    const msgBase = pixCola
      ? 'PIX Copia e Cola e boleto gerados com sucesso.'
      : 'Boleto gerado. PIX indisponível para esta fatura.';

    const msgWhatsapp = wppMotivo === 'celular_nao_informado'
      ? `${msgBase} Pergunte ao cliente qual celular com WhatsApp usar e tente de novo.`
      : wppMotivo === 'resumo_ou_resposta_ausente'
        ? `${msgBase} Inclua resumo_atendimento e resposta_cliente na tool.`
        : wppMotivo === 'falha_api_whatsapp'
          ? `${msgBase} Falha ao enviar WhatsApp — informe o PIX verbalmente ou tente de novo.`
          : msgBase;

    return {
      sucesso: true,
      fatura_id: linkObj.fatura,
      valor: valorFmt,
      vencimento: linkObj.vencimento,
      pix_copia_cola: pixCola || null,
      link_boleto: linkBoleto,
      linha_digitavel: linhaDigitavel,
      whatsapp_enviado: wppEnviado,
      whatsapp_motivo: wppMotivo ?? null,
      mensagem: msgWhatsapp,
    };
  });

  client.registerTool('desbloqueio_confianca', async (args) => {
    const bloqueio = bloqueioConsultas(ctx);
    if (bloqueio) return bloqueio;

    const contrato = resolverContratoId(ctx, args.cliente_id, 'desbloqueio_confianca');
    if ('erro' in contrato) return { sucesso: false, ...contrato };
    const contratoId = contrato.contratoId;
    const r = await sgp.desbloquearConfianca(contratoId);

    if (!r) return { sucesso: false, mensagem: 'Não foi possível realizar o desbloqueio agora.' };

    ctx.log.push(`Desbloqueio confiança: ${r.liberado ? 'sucesso' : 'negado'}`);
    return {
      sucesso: r.liberado,
      protocolo: r.protocolo,
      dias_liberados: r.liberado_dias,
      mensagem: r.liberado
        ? `Desbloqueio realizado por ${r.liberado_dias} dia(s). Protocolo: ${r.protocolo}`
        : 'Desbloqueio não disponível para este contrato no momento.',
    };
  });

  // ── Massiva ────────────────────────────────────────────────────────────────

  client.registerTool('verificar_massiva', async () => {
    const bloqueio = bloqueioConsultas(ctx);
    if (bloqueio) return bloqueio;

    const manutencoes = await sgp.manutencoesAtivas();
    ctx.manutencoesAtivas = manutencoes;

    if (!manutencoes.length) {
      return { tem_massiva: false };
    }

    ctx.massivaAtiva = true;
    const m = manutencoes[0];
    ctx.log.push(`Massiva ativa: ${m.descricao}`);

    return {
      tem_massiva: true,
      descricao: m.descricao,
      mensagem_ura: m.mensagem_ura || m.descricao,
      severidade: m.severidade,
      data_inicio: m.data_inicial,
      data_previsao_fim: m.data_final,
      olts_afetadas: m.olts.map((o) => o.nome),
      ctos_afetadas: m.ctos.map((c) => c.nome),
      total_manutencoes: manutencoes.length,
    };
  });

  // ── ONU ────────────────────────────────────────────────────────────────────

  client.registerTool('consultar_onu', async (args) => {
    const bloqueio = bloqueioConsultas(ctx);
    if (bloqueio) return bloqueio;

    const contrato = resolverContratoId(ctx, args.cliente_id, 'consultar_onu');
    if ('erro' in contrato) return { sucesso: false, ...contrato };
    const contratoId = contrato.contratoId;

    // Usa ONU já carregada no contexto ou busca
    let onu = ctx.onu;
    if (!onu) {
      onu = await sgp.onuDoContrato(contratoId) ?? undefined;
      ctx.onu = onu;
    }

    if (!onu) return { erro: 'Não foi possível localizar a ONU deste contrato.' };

    const rxNum = onu.rx ? parseFloat(onu.rx) : null;
    const sinalOk = rxNum !== null ? rxNum >= -27 && rxNum <= -7 : null;
    const status = onu.conexao?.status ?? 'desconhecido';
    const classificacaoSinal = classificarSinalOptico(rxNum);

    return {
      status,
      serial: onu.serial,
      olt: onu.olt_nome,
      sinal_rx_dbm: onu.rx,
      sinal_tx_dbm: onu.tx,
      ip: onu.conexao?.ip ?? null,
      ultima_conexao: onu.conexao?.data_conexao ?? null,
      ultima_desconexao: onu.conexao?.data_desconexao ?? null,
      sinal_ok: sinalOk,
      classificacao_sinal: classificacaoSinal?.faixa ?? null,
      classificacao_sinal_descricao: classificacaoSinal?.descricao ?? null,
      interpretacao:
        status === 'offline'
          ? 'ONU offline — verifique a luz da ONU ou se houve queda de energia'
          : sinalOk === false
          ? `Sinal fraco (${onu.rx} dBm). O ideal é entre -7 e -27 dBm`
          : 'ONU online com sinal dentro do esperado',
    };
  });

  client.registerTool('reiniciar_onu', async (args) => {
    const bloqueio = bloqueioConsultas(ctx);
    if (bloqueio) return bloqueio;

    const contrato = resolverContratoId(ctx, args.cliente_id, 'reiniciar_onu');
    if ('erro' in contrato) return { sucesso: false, ...contrato };
    const contratoId = contrato.contratoId;

    // Precisa do ID interno da ONU (não o número na OLT)
    let onuId = ctx.onu?.id;
    if (!onuId) {
      const onu = await sgp.onuDoContrato(contratoId);
      onuId = onu?.id;
      if (onu) ctx.onu = onu;
    }

    if (!onuId) {
      return { sucesso: false, mensagem: 'Não foi possível localizar a ONU para reinicialização.' };
    }

    const ok = await sgp.resetarOnu(onuId);
    ctx.log.push(`Reset ONU #${onuId}: ${ok ? 'sucesso' : 'falha'}`);

    return {
      sucesso: ok,
      mensagem: ok
        ? 'ONU reiniciada remotamente. Aguarde de 2 a 3 minutinhos para a reconexão.'
        : 'Não foi possível reiniciar a ONU remotamente agora.',
    };
  });

  // ── Chamado / OS ───────────────────────────────────────────────────────────

  client.registerTool('abrir_chamado', async (args) => {
    const bloqueio = bloqueioConsultas(ctx);
    if (bloqueio) return bloqueio;

    if (!config.features.chamado) {
      return { sucesso: false, erro: 'Abertura de chamado desabilitada.' };
    }

    const contrato = resolverContratoId(ctx, args.cliente_id, 'abrir_chamado');
    if ('erro' in contrato) return { sucesso: false, ...contrato };
    const contratoId = contrato.contratoId;
    const r = await sgp.abrirChamado({
      contratoId,
      ocorrenciaTipo: config.features.chamadoOcorrenciaTipo,
      classificacoes: [config.features.chamadoTipoClassificacoes],
      conteudo: args.descricao ? String(args.descricao) : undefined,
    });

    if (!r) return { sucesso: false, erro: 'Não foi possível abrir o chamado.' };

    if (r.protocolo) ctx.protocolos.push(r.protocolo);
    ctx.log.push(`Chamado aberto: protocolo ${r.protocolo}`);
    const aberto = !!r.protocolo;

    let wppEnviado = false;
    let wppMotivo: string | undefined;
    const enviarWpp = args.enviar_whatsapp === true;

    if (enviarWpp && aberto) {
      const resultado = await enviarWhatsappAtendimento(ctx, {
        celular_whatsapp: args.celular_whatsapp ? String(args.celular_whatsapp) : undefined,
        resumo_atendimento: args.resumo_atendimento ? String(args.resumo_atendimento) : undefined,
        resposta_cliente: args.resposta_cliente ? String(args.resposta_cliente) : undefined,
      });
      wppEnviado = resultado.enviado;
      wppMotivo = resultado.motivo;
    }

    return {
      sucesso: aberto,
      protocolo: r.protocolo,
      whatsapp_enviado: enviarWpp ? wppEnviado : null,
      whatsapp_motivo: wppMotivo ?? null,
      mensagem: aberto
        ? `Chamado registrado. Protocolo: ${r.protocolo}. Informe o protocolo ao cliente agora.`
        : 'Não foi possível abrir o chamado.',
      orientacao: aberto
        ? enviarWpp && wppEnviado
          ? 'Protocolo e resumo enviados por WhatsApp. Confirme com o cliente que recebeu.'
          : 'Fale imediatamente ao cliente: "Abri um chamado pra você, o protocolo é [número]. Nossa equipe técnica vai verificar."'
        : undefined,
    };
  });

  client.registerTool('enviar_resumo_whatsapp', async (args) => {
    const bloqueio = bloqueioConsultas(ctx);
    if (bloqueio) return bloqueio;

    const resultado = await enviarWhatsappAtendimento(ctx, {
      celular_whatsapp: args.celular_whatsapp ? String(args.celular_whatsapp) : undefined,
      resumo_atendimento: args.resumo_atendimento ? String(args.resumo_atendimento) : undefined,
      resposta_cliente: args.resposta_cliente ? String(args.resposta_cliente) : undefined,
    });

    if (resultado.enviado) {
      ctx.log.push('Resumo do atendimento enviado por WhatsApp');
    }

    return {
      sucesso: resultado.enviado,
      whatsapp_enviado: resultado.enviado,
      whatsapp_motivo: resultado.motivo ?? null,
      protocolos_incluidos: ctx.protocolos,
      fatura_incluida: !!ctx.faturaWhatsApp,
      mensagem: resultado.enviado
        ? 'Resumo enviado por WhatsApp com protocolo e fatura (se houver).'
        : resultado.motivo === 'celular_nao_informado'
          ? 'Pergunte ao cliente qual celular com WhatsApp usar.'
          : resultado.motivo === 'resumo_ou_resposta_ausente'
            ? 'Preencha resumo_atendimento e resposta_cliente.'
            : 'Não foi possível enviar o WhatsApp agora.',
    };
  });

  client.registerTool('agendar_visita_tecnica', async (args) => {
    const bloqueio = bloqueioConsultas(ctx);
    if (bloqueio) return bloqueio;

    // Agendamento de visita técnica é feito abrindo chamado com conteúdo específico
    const contrato = resolverContratoId(ctx, args.cliente_id, 'agendar_visita_tecnica');
    if ('erro' in contrato) return { sucesso: false, ...contrato };
    const contratoId = contrato.contratoId;
    const periodo = args.periodo_preferencia === 'TARDE' ? 'tarde' : 'manhã';
    const descricao = `Visita técnica solicitada via URA.\nDescrição: ${args.descricao}\nPeríodo de preferência: ${periodo}`;

    const r = await sgp.abrirChamado({
      contratoId,
      ocorrenciaTipo: config.features.chamadoOcorrenciaTipo,
      classificacoes: [config.features.chamadoTipoClassificacoes],
      conteudo: descricao,
    });

    if (!r) return { sucesso: false, erro: 'Não foi possível agendar a visita.' };

    if (r.protocolo) ctx.protocolos.push(r.protocolo);
    ctx.log.push(`Visita técnica agendada: protocolo ${r.protocolo}`);
    return {
      sucesso: r.status === 1,
      protocolo: r.protocolo,
      mensagem: `Visita técnica registrada para o período da ${periodo}. Protocolo: ${r.protocolo}. Nossa equipe entrará em contato para confirmar o horário.`,
    };
  });

  // ── Viabilidade e Planos ───────────────────────────────────────────────────

  client.registerTool('verificar_viabilidade', async (args) => {
    const logradouro = args.logradouro ? String(args.logradouro).trim() : '';
    const numero = args.numero ? String(args.numero).trim() : '';
    const bairro = args.bairro ? String(args.bairro).trim() : '';
    const cidade = args.cidade ? String(args.cidade).trim() : '';
    const cepDigitos = args.cep ? String(args.cep).replace(/\D/g, '') : '';

    // Viabilidade depende do endereço EXATO (a CTO mais próxima varia rua a rua).
    // Exige CEP válido OU endereço com rua + número + bairro. Nunca consulta só por bairro/cidade.
    const cepValido = cepDigitos.length === 8;
    const enderecoCompleto = !!logradouro && !!numero && !!bairro;
    if (!cepValido && !enderecoCompleto) {
      return {
        tem_cobertura: null,
        erro: 'endereco_incompleto',
        mensagem:
          'Não dá para verificar viabilidade só pelo bairro ou cidade. Peça ao cliente o CEP ou o endereço completo (rua, número e bairro).',
      };
    }

    const endStr = [logradouro, numero, bairro, cidade].filter(Boolean).join(', ');
    const cepStr = args.cep ? String(args.cep) : '';
    ctx.enderecoConsultado = endStr || cepStr;

    // 1. SEMPRE consulta a CTO no GeoSite — é quem conhece as portas disponíveis.
    //    Seleciona a CTO mais próxima que cobre e tem porta livre; se a mais próxima
    //    estiver lotada, usa a próxima mais próxima que cobre.
    if (config.geosite.enabled) {
      const geo = endStr
        ? await geosite.viabilidadePorEndereco(endStr)
        : cepStr
        ? await geosite.viabilidadePorCep(cepStr)
        : { temCobertura: false, caixasProximas: 0 };

      if (geo.temCobertura && geo.caixaSelecionada) {
        const cto = geo.caixaSelecionada;
        const distancia = Math.round(cto.distanciaMetros);
        ctx.log.push(
          `Viabilidade GeoSite: CTO ${cto.tipoCodigo} a ${distancia}m com ${cto.portasDisponiveis} porta(s) livre(s)`,
        );
        return {
          tem_cobertura: true,
          fonte: 'geosite',
          cto_selecionada: cto.tipoCodigo,
          distancia_metros: distancia,
          portas_disponiveis: cto.portasDisponiveis,
          ctos_proximas: geo.caixasProximas,
        };
      }

      // Há CTO(s) cobrindo o endereço, mas todas estão sem porta disponível.
      // A CTO é a autoridade sobre porta física, então não há viabilidade real.
      if ((geo.caixasProximas ?? 0) > 0) {
        ctx.log.push(
          `Viabilidade GeoSite: ${geo.caixasProximas} CTO(s) próxima(s), todas sem porta disponível`,
        );
        return {
          tem_cobertura: false,
          fonte: 'geosite',
          motivo: 'cto_sem_porta',
          ctos_proximas: geo.caixasProximas,
          oferecer_cadastro_interesse: true,
        };
      }
    }

    // 2. Fallback SGP — usado apenas quando o GeoSite não encontrou CTOs próximas,
    //    está desabilitado ou falhou. Ignorado se COVERAGE_USE_GEOSITE_ONLY=true.
    if (!config.geosite.useGeositeOnly) {
      const temCobertura = await sgp.viabilidade({
        cep: cepDigitos || undefined,
        logradouro: logradouro || undefined,
        numero_inicial: numero || undefined,
        numero_final: numero || undefined,
        bairro: bairro || undefined,
        cidade: cidade || undefined,
      });

      if (temCobertura) return { tem_cobertura: true, fonte: 'sgp' };
    }

    return { tem_cobertura: false, oferecer_cadastro_interesse: true };
  });

  client.registerTool('registrar_interesse_cobertura', async (args) => {
    const nome = String(args.nome ?? '').trim();
    const email = args.email ? String(args.email).trim() : null;
    const endereco = String(args.endereco ?? ctx.enderecoConsultado ?? '').trim();
    const plano = args.plano_interesse ? String(args.plano_interesse).trim() : null;
    const horario = args.melhor_horario ? String(args.melhor_horario) : null;
    // Celular informado pelo cliente tem prioridade; se não informar, usa o número da chamada.
    const celularInformado = args.celular ? String(args.celular).replace(/\D/g, '') : '';
    const telefone = celularInformado || ctx.callerNumber || null;

    if (!nome || !endereco) {
      return { sucesso: false, mensagem: 'Nome e endereço são obrigatórios.' };
    }

    const agora = new Date().toLocaleString('pt-BR', { timeZone: config.tz });
    const temCobertura = !!plano && !args.endereco?.toString().includes('sem cobertura');
    const titulo = plano ? `🛒 *Interesse em Contratação*` : `🔔 *Interesse de Cobertura*`;

    const linhas = [
      titulo,
      ``,
      `👤 *Nome:* ${nome}`,
      telefone ? `📱 *Telefone:* ${telefone}` : null,
      email ? `📧 *E-mail:* ${email}` : null,
      `📍 *Endereço:* ${endereco}`,
      plano ? `📦 *Plano de interesse:* ${plano}` : null,
      horario ? `🕐 *Melhor horário:* ${horario}` : null,
      ``,
      `🗓️ _Registrado em ${agora} via URA_`,
    ].filter((l) => l !== null).join('\n');

    let enviado = false;
    if (config.whatsapp.salesGroupId) {
      enviado = await whatsapp.enviarGrupo(config.whatsapp.salesGroupId, linhas);
    }

    ctx.log.push(`Interesse registrado: ${nome} — ${endereco}`);
    logger.info(`[${ctx.callId}] Interesse cobertura registrado: ${nome}`, { endereco, enviado });

    return {
      sucesso: true,
      whatsapp_enviado: enviado,
      mensagem: `Interesse registrado com sucesso para ${nome}.`,
    };
  });

  client.registerTool('consultar_planos', async () => {
    const todos = await sgp.planos();
    const planos = filtrarPlanosComerciais(todos);
    logger.info(`[${ctx.callId}] Planos: ${todos.length} no SGP, ${planos.length} comerciais`);
    return {
      planos: planos.map((p) => ({
        id: p.id,
        nome: p.descricao,
        preco: `R$ ${parseFloat(p.preco).toFixed(2).replace('.', ',')}`,
      })),
    };
  });

  // ── Transferência e Encerramento ──────────────────────────────────────────

  client.registerTool('transferir_para_atendente', async (args) => {
    const motivo = String(args.motivo ?? '');
    const resumo = String(args.resumo ?? '');
    logger.info(`[${ctx.callId}] Transferência solicitada: ${motivo}`);
    ctx.transferMotivo = motivo;
    ctx.transferSummary = resumo;
    ctx.pendingTransfer = true;
    ctx.log.push(`Transferência: ${motivo}`);
    return { sucesso: true };
  });

  client.registerTool('encerrar_atendimento', async (args) => {
    const motivo = String(args.motivo ?? 'concluído');
    logger.info(`[${ctx.callId}] Encerramento: ${motivo}`);
    ctx.pendingHangup = true;
    ctx.log.push(`Encerrado: ${motivo}`);
    return { sucesso: true };
  });
}
