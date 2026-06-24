import { sgp } from '../integrations/sgp';
import { geosite } from '../integrations/geosite';
import { whatsapp } from '../integrations/whatsapp';
import { config } from '../config';
import { logger } from '../logger';
import type { CallContext } from '../session/context';
import type { RealtimeClient } from '../realtime/client';

export function registerTools(client: RealtimeClient, ctx: CallContext): void {

  // ── Identificação ─────────────────────────────────────────────────────────

  client.registerTool('buscar_cliente_por_cpf', async (args) => {
    const cpf = String(args.cpf ?? '');
    const cliente = await sgp.buscarPorCpf(cpf);
    if (!cliente) return { encontrado: false, mensagem: 'CPF não encontrado no cadastro.' };

    ctx.cliente = cliente;
    ctx.clienteIdentificado = true;
    ctx.log.push(`Identificado por CPF: ${cliente.nome} (contrato ${cliente.contratoId})`);
    logger.info(`[${ctx.callId}] Cliente identificado: ${cliente.nome}`);

    return {
      encontrado: true,
      nome: cliente.nome,
      cpf: cliente.cpfcnpj,
      contrato_id: cliente.contratoId,
      status_contrato: cliente.contratos[0]?.status,
      motivo_status: cliente.contratos[0]?.motivo_status,
      plano: cliente.contratos[0]?.servicos[0]?.plano?.descricao,
      endereco: cliente.endereco
        ? `${cliente.endereco.logradouro}, ${cliente.endereco.numero} — ${cliente.endereco.bairro}, ${cliente.endereco.cidade}/${cliente.endereco.uf}`
        : null,
    };
  });

  // ── Financeiro ─────────────────────────────────────────────────────────────

  client.registerTool('consultar_financeiro', async (args) => {
    const contratoId = Number(args.cliente_id); // mantemos "cliente_id" por compatibilidade com a tool definition

    const tits = await sgp.titulos(contratoId, 'abertos');
    ctx.titulos = tits;

    const inadimplente = tits.some((t) => t.status === 'aberto' && t.diasAtraso > 0);
    const valorTotal = tits.reduce((s, t) => s + (t.valorCorrigido ?? t.valor), 0);

    return {
      inadimplente,
      total_em_aberto: `R$ ${valorTotal.toFixed(2).replace('.', ',')}`,
      faturas: tits.map((t) => ({
        id: t.id,
        valor: `R$ ${t.valorCorrigido.toFixed(2).replace('.', ',')}`,
        vencimento: t.dataVencimento,
        atraso_dias: t.diasAtraso,
        status: t.status,
        tem_pix: !!t.codigoPix,
        tem_boleto: !!t.codigoBarras || !!t.link,
      })),
    };
  });

  client.registerTool('gerar_segunda_via', async (args) => {
    const contratoId = Number(args.cliente_id);
    const faturaId = args.fatura_id ? Number(args.fatura_id) : undefined;
    const enviarWpp = args.enviar_whatsapp !== false;

    const r = await sgp.fatura2via(contratoId);
    if (!r || !r.links?.length) {
      return { sucesso: false, mensagem: 'Não há faturas em aberto ou não foi possível gerar segunda via.' };
    }

    // Pega a fatura específica ou a mais recente
    const linkObj = faturaId
      ? r.links.find((l) => l.fatura === faturaId) ?? r.links[0]
      : r.links[0];

    // Tenta gerar PIX da fatura selecionada
    let pixCola = ctx.titulos?.find((t) => t.id === linkObj.fatura)?.codigoPix ?? '';
    if (!pixCola) {
      pixCola = await sgp.gerarPix(linkObj.fatura, contratoId) ?? '';
    }

    const linkBoleto = linkObj.link;
    const linhaDigitavel = linkObj.linhadigitavel;

    // Envia via WhatsApp se solicitado
    let wppEnviado = false;
    if (enviarWpp && ctx.callerNumber && ctx.cliente) {
      const valorStr = linkObj.valor.toFixed(2).replace('.', ',');
      wppEnviado = await whatsapp.enviarBoleto(ctx.callerNumber, {
        clienteNome: ctx.cliente.nome,
        valor: linkObj.valor,
        vencimento: linkObj.vencimento,
        linkBoleto,
        codigoBarras: linhaDigitavel,
        pixCopiaCola: pixCola || undefined,
      });
    }

    ctx.log.push(`Segunda via gerada (fatura ${linkObj.fatura}, R$${linkObj.valor})`);

    return {
      sucesso: true,
      fatura_id: linkObj.fatura,
      valor: `R$ ${linkObj.valor.toFixed(2).replace('.', ',')}`,
      vencimento: linkObj.vencimento,
      pix_copia_cola: pixCola || null,
      link_boleto: linkBoleto,
      linha_digitavel: linhaDigitavel,
      whatsapp_enviado: wppEnviado,
      mensagem: pixCola
        ? 'PIX Copia e Cola e boleto gerados com sucesso.'
        : 'Boleto gerado. PIX indisponível para esta fatura.',
    };
  });

  client.registerTool('desbloqueio_confianca', async (args) => {
    const contratoId = Number(args.cliente_id);
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
    const contratoId = Number(args.cliente_id);

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
      interpretacao:
        status === 'offline'
          ? 'ONU offline — verifique a luz da ONU ou se houve queda de energia'
          : sinalOk === false
          ? `Sinal fraco (${onu.rx} dBm). O ideal é entre -7 e -27 dBm`
          : 'ONU online com sinal dentro do esperado',
    };
  });

  client.registerTool('reiniciar_onu', async (args) => {
    const contratoId = Number(args.cliente_id);

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
    if (!config.features.chamado) {
      return { sucesso: false, erro: 'Abertura de chamado desabilitada.' };
    }

    const contratoId = Number(args.cliente_id);
    const r = await sgp.abrirChamado({
      contratoId,
      ocorrenciaTipo: config.features.chamadoOcorrenciaTipo,
      classificacoes: [config.features.chamadoTipoClassificacoes],
      conteudo: args.descricao ? String(args.descricao) : undefined,
    });

    if (!r) return { sucesso: false, erro: 'Não foi possível abrir o chamado.' };

    ctx.log.push(`Chamado aberto: protocolo ${r.protocolo}`);
    return {
      sucesso: r.status === 1,
      protocolo: r.protocolo,
      mensagem: `Chamado registrado. Protocolo: ${r.protocolo}`,
    };
  });

  client.registerTool('agendar_visita_tecnica', async (args) => {
    // Agendamento de visita técnica é feito abrindo chamado com conteúdo específico
    const contratoId = Number(args.cliente_id);
    const periodo = args.periodo_preferencia === 'TARDE' ? 'tarde' : 'manhã';
    const descricao = `Visita técnica solicitada via URA.\nDescrição: ${args.descricao}\nPeríodo de preferência: ${periodo}`;

    const r = await sgp.abrirChamado({
      contratoId,
      ocorrenciaTipo: config.features.chamadoOcorrenciaTipo,
      classificacoes: [config.features.chamadoTipoClassificacoes],
      conteudo: descricao,
    });

    if (!r) return { sucesso: false, erro: 'Não foi possível agendar a visita.' };

    ctx.log.push(`Visita técnica agendada: protocolo ${r.protocolo}`);
    return {
      sucesso: r.status === 1,
      protocolo: r.protocolo,
      mensagem: `Visita técnica registrada para o período da ${periodo}. Protocolo: ${r.protocolo}. Nossa equipe entrará em contato para confirmar o horário.`,
    };
  });

  // ── Viabilidade e Planos ───────────────────────────────────────────────────

  client.registerTool('verificar_viabilidade', async (args) => {
    const temCobertura = await sgp.viabilidade({
      cep: args.cep as string | undefined,
      logradouro: args.logradouro as string | undefined,
      numero_inicial: args.numero as string | undefined,
      numero_final: args.numero as string | undefined,
      bairro: args.bairro as string | undefined,
      cidade: args.cidade as string | undefined,
    });

    if (temCobertura) return { tem_cobertura: true, fonte: 'sgp' };

    // Fallback GeoSite com detalhes de CTOs
    if (config.geosite.enabled) {
      const endStr = [args.logradouro, args.numero, args.bairro, args.cidade]
        .filter(Boolean).join(', ') || String(args.cep ?? '');
      const geo = endStr
        ? await geosite.viabilidadePorEndereco(endStr)
        : args.cep
        ? await geosite.viabilidadePorCep(String(args.cep))
        : { temCobertura: false };

      if (geo.temCobertura) {
        return {
          tem_cobertura: true,
          fonte: 'geosite',
          ctos_proximas: geo.caixasProximas,
          distancia_min_metros: geo.distanciaMinMetros,
          portas_disponiveis: geo.totalDisponiveis,
        };
      }
    }

    // Salva endereço no contexto para uso no registrar_interesse_cobertura
    ctx.enderecoConsultado = [
      args.logradouro, args.numero, args.bairro, args.cidade,
    ].filter(Boolean).join(', ') || String(args.cep ?? '');

    return { tem_cobertura: false, oferecer_cadastro_interesse: true };
  });

  client.registerTool('registrar_interesse_cobertura', async (args) => {
    const nome = String(args.nome ?? '').trim();
    const email = args.email ? String(args.email).trim() : null;
    const endereco = String(args.endereco ?? ctx.enderecoConsultado ?? '').trim();
    const plano = args.plano_interesse ? String(args.plano_interesse).trim() : null;
    const horario = args.melhor_horario ? String(args.melhor_horario) : null;
    const telefone = ctx.callerNumber || null;

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
    const planos = await sgp.planos();
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
