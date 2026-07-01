const fs = require("fs");
let code = fs.readFileSync("src/tools/handlers.ts", "utf8");

const helperCode = `
async function obterDadosFinanceirosEZabbix(ctx: CallContext, contratoId: number) {
  ctx.precisaConsultarFinanceiro = false;
  ctx.consultaFinanceiraFeita = true;

  let tits = ctx.titulos;
  if (!tits) {
    tits = await sgp.titulos(contratoId, 'abertos');
    ctx.titulos = tits;
  }

  const { vencidas, aVencer } = separarTitulos(tits);
  const inadimplente = vencidas.length > 0;
  const valorTotalVencido = vencidas.reduce((s, t) => s + (t.valorCorrigido ?? t.valor), 0);
  const valorTotalAVencer = aVencer.reduce((s, t) => s + (t.valorCorrigido ?? t.valor), 0);
  const ct = contratoDoContexto(ctx, contratoId);
  const statusContrato = ct?.status ?? null;
  const motivoStatus = ct?.motivo_status ?? null;
  const contratoSuspenso = /suspens|bloquead|cancelad/i.test(statusContrato ?? '');
  const servicoSuspensoFinanceiro = suspensoPorFinanceiro(contratoSuspenso, motivoStatus);
  const bloqueioFinanceiro = inadimplente || servicoSuspensoFinanceiro;
  const temFaturasAbertas = tits.length > 0;
  const temFaturasVencidas = vencidas.length > 0;

  await carregarOnuParaInfra(ctx);
  const z = await zabbix.diagnosticar(termosInfraDoCliente(ctx));
  const zabbixResult = mapZabbixParaTool(z);

  const orient = orientacaoFinanceiro({
    vencidas,
    aVencer,
    contratoSuspenso,
    bloqueioFinanceiro,
    servicoSuspensoFinanceiro,
  });

  return {
    inadimplente,
    contrato_suspenso: contratoSuspenso,
    status_contrato: statusContrato,
    motivo_status: motivoStatus,
    bloqueio_financeiro: bloqueioFinanceiro,
    servico_suspenso_financeiro: servicoSuspensoFinanceiro,
    fala_obrigatoria: servicoSuspensoFinanceiro ? FALA_SUSPENSAO_FINANCEIRA : null,
    tem_faturas_abertas: temFaturasAbertas,
    tem_faturas_vencidas: temFaturasVencidas,
    total_vencido: temFaturasVencidas ? \`R$ \${valorTotalVencido.toFixed(2).replace('.', ',')}\` : null,
    total_vencido_falado: temFaturasVencidas ? valorPorExtenso(valorTotalVencido) : null,
    total_a_vencer: aVencer.length > 0 ? \`R$ \${valorTotalAVencer.toFixed(2).replace('.', ',')}\` : null,
    total_a_vencer_falado: aVencer.length > 0 ? valorPorExtenso(valorTotalAVencer) : null,
    faturas_vencidas: vencidas.slice(0, 5).map(mapFaturaResumo),
    faturas_a_vencer: aVencer.slice(0, 3).map(mapFaturaResumo),
    diagnostico_rede: zabbixResult,
    orientacao: orient + (zabbixResult.tem_incidente ? \` IMPORTANTE: Há uma falha na rede detectada (\${zabbixResult.orientacao}). Comunique a situação financeira e IMEDIATAMENTE informe o cliente sobre o incidente de rede.\` : ' ATENÇÃO: AGORA VOCÊ DEVE FALAR com o cliente.'),
  };
}
`;

code = code.replace("function orientacaoFinanceiro", helperCode + "\nfunction orientacaoFinanceiro");

const selContratoOldRegex = /    return \{\s*sucesso: true,\s*contrato_id: contratoId,\s*endereco: formatarEndereco\(ct\.endereco \?\? ctx\.cliente\.endereco\),\s*plano: ct\.servicos\[0\]\?\.plano\?\.descricao \?\? null,\s*status: ct\.status,\s*motivo_status: ct\.motivo_status,\s*mensagem: 'Contrato selecionado\.',\s*orientacao: 'Consulta de contrato finalizada\. O sistema acionará a ferramenta consultar_financeiro automaticamente a seguir, aguarde o resultado\.',\s*\};\s*\n/m;
const selContratoNew = `    const finZabbix = await obterDadosFinanceirosEZabbix(ctx, contratoId);
    return {
      sucesso: true,
      contrato_id: contratoId,
      endereco: formatarEndereco(ct.endereco ?? ctx.cliente.endereco),
      plano: ct.servicos[0]?.plano?.descricao ?? null,
      status: ct.status,
      motivo_status: ct.motivo_status,
      mensagem: 'Contrato selecionado.',
      ...finZabbix,
      orientacao: 'Contrato selecionado. ' + finZabbix.orientacao,
    };
`;
code = code.replace(selContratoOldRegex, selContratoNew);

const confOldRegex = /      return \{\s*sucesso: true,\s*confirmado: true,\s*contrato_id: ctx\.cliente\.contratoId,\s*endereco: formatarEndereco\(ctx\.cliente\.endereco\),\s*mensagem: 'Identidade confirmada\.',\s*orientacao: 'Agora pergunte QUAL ENDEREÇO o cliente quer tratar\. Leia os endereços da lista:(?:.*?)',\s*\};\s*\n    \}/m;

const confOldRegexSingle = /      return \{\s*sucesso: true,\s*confirmado: true,\s*contrato_id: ctx\.cliente\.contratoId,\s*endereco: formatarEndereco\(ctx\.cliente\.endereco\),\s*mensagem: 'Identidade confirmada\.',\s*orientacao: 'Identidade confirmada\. O sistema acionará a ferramenta consultar_financeiro automaticamente a seguir, aguarde o resultado\.',\s*\};\s*\n    \}/m;


const confNewSingle = `      const finZabbix = await obterDadosFinanceirosEZabbix(ctx, ctx.cliente.contratoId);
      return {
        sucesso: true,
        confirmado: true,
        contrato_id: ctx.cliente.contratoId,
        endereco: formatarEndereco(ctx.cliente.endereco),
        mensagem: 'Identidade confirmada.',
        ...finZabbix,
        orientacao: 'Identidade confirmada. ' + finZabbix.orientacao,
      };
    }`;
code = code.replace(confOldRegexSingle, confNewSingle);

const finToolRegex = /  client\.registerTool\('consultar_financeiro', async \(args\) => \{[\s\S]*?    \}\);\n/m;
const finToolNew = `  client.registerTool('consultar_financeiro', async (args) => {
    const contrato = resolverContratoId(ctx, args.cliente_id, 'consultar_financeiro');
    if ('erro' in contrato) return { sucesso: false, ...contrato };
    return await obterDadosFinanceirosEZabbix(ctx, contrato.contratoId);
  });\n`;
code = code.replace(finToolRegex, finToolNew);

fs.writeFileSync("src/tools/handlers.ts", code);
console.log("Refactoring complete");
