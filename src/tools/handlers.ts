import { sgp, formatarEndereco } from '../integrations/sgp';
import { geosite } from '../integrations/geosite';
import { zabbix, type ZabbixEventoTipo } from '../integrations/zabbix';
import { whatsapp } from '../integrations/whatsapp';
import { config } from '../config';
import { logger } from '../logger';
import type { CallContext } from '../session/context';
import type { RealtimeClient } from '../realtime/client';
import type { SgpPlano, SgpTitulo } from '../integrations/sgp';

// Remove planos não-comerciais do SGP (revendedores, dedicados, R$0, enterprise)
const PLANO_LIXO = /dedicad|enterpric|semi[\s_-]?dedicad|provedor|\btelecom\b|brush|gol net|rede br|sigma|tecno link|turbinet|wescley|cybervivo|anali|paulo roberto|supermercado|granja/i;

function pareceConfirmacaoTitular(text?: string): boolean {
  if (!text?.trim()) return false;
  const t = text.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
  if (/\b(see you|bye now|thank you|goodbye|next time|hello|english)\b/i.test(t)) return false;
  if (/\b(nao|não|negativo|errado|nao sou|não sou)\b/i.test(t)) return false;
  // Confia na decisão do modelo LLM para outras palavras ou transcrições com ruído
  // como "시" ou "등" que ocorrem quando o cliente fala "sim" muito rápido.
  return true;
}

function valorPorExtenso(valor: number): string {
  if (valor === 0) return 'zero reais';
  const unidades = ['', 'um', 'dois', 'três', 'quatro', 'cinco', 'seis', 'sete', 'oito', 'nove'];
  const dezenas = ['', 'dez', 'vinte', 'trinta', 'quarenta', 'cinquenta', 'sessenta', 'setenta', 'oitenta', 'noventa'];
  const especiais = ['dez', 'onze', 'doze', 'treze', 'catorze', 'quinze', 'dezesseis', 'dezessete', 'dezoito', 'dezenove'];
  const centenas = ['', 'cento', 'duzentos', 'trezentos', 'quatrocentos', 'quinhentos', 'seiscentos', 'setecentos', 'oitocentos', 'novecentos'];

  function converter(n: number): string {
    if (n === 100) return 'cem';
    let res = '';
    const c = Math.floor(n / 100);
    const d = Math.floor((n % 100) / 10);
    const u = n % 10;
    if (c > 0) res += centenas[c];
    if (d === 1) {
      if (res) res += ' e ';
      res += especiais[u];
    } else {
      if (d > 1) {
        if (res) res += ' e ';
        res += dezenas[d];
      }
      if (u > 0) {
        if (res) res += ' e ';
        res += unidades[u];
      }
    }
    return res;
  }

  const inteiros = Math.floor(valor);
  const centavos = Math.round((valor - inteiros) * 100);

  let strInteiros = '';
  if (inteiros > 0) {
    if (inteiros >= 1000) {
      const m = Math.floor(inteiros / 1000);
      const resto = inteiros % 1000;
      strInteiros += (m === 1 ? 'mil' : converter(m) + ' mil');
      if (resto > 0) {
        strInteiros += ((resto < 100 || resto % 100 === 0) ? ' e ' : ' ') + converter(resto);
      }
    } else {
      strInteiros += converter(inteiros);
    }
    strInteiros += (inteiros === 1 ? ' real' : ' reais');
  }

  let strCentavos = '';
  if (centavos > 0) {
    strCentavos += converter(centavos);
    strCentavos += (centavos === 1 ? ' centavo' : ' centavos');
  }

  if (strInteiros && strCentavos) return `${strInteiros} e ${strCentavos}`;
  if (strInteiros) return strInteiros;
  return strCentavos;
}

function termosInfraDoCliente(ctx: CallContext): string[] {
  const termos: string[] = [];
  const onu = ctx.onu;
  if (onu?.olt_nome) termos.push(onu.olt_nome);
  if (onu?.cto_nome) termos.push(onu.cto_nome);
  if (onu?.caixa) termos.push(onu.caixa);
  if (onu?.serial && onu.serial.length >= 6) termos.push(onu.serial);
  if (onu?.pon != null && onu?.slot != null) {
    termos.push(`${onu.slot}/${onu.pon}`, `PON ${onu.slot}/${onu.pon}`);
  }
  if (ctx.infraTermos?.length) termos.push(...ctx.infraTermos);
  return [...new Set(termos.map((t) => t.trim()).filter((t) => t.length >= 3))];
}

/** Carrega ONU do contrato para mapear OLT/CTO no Zabbix antes da massiva. */
async function carregarOnuParaInfra(ctx: CallContext): Promise<void> {
  if (ctx.onu || !ctx.contratoSelecionado) return;
  const contratoId = ctx.cliente?.contratoId;
  if (!contratoId) return;
  const onu = await sgp.onuDoContrato(contratoId, { fullFttx: true });
  if (onu) ctx.onu = onu;
}

/** Massiva SGP afeta este cliente? Cruza CTOs da manutenção com infra do cliente. */
function massivaSgpAfetaCliente(
  m: { ctos: Array<{ nome: string }>; olts: Array<{ nome: string }> },
  termos: string[],
): boolean {
  if (!termos.length) return false;
  const alvos = [
    ...m.ctos.map((c) => c.nome),
    ...m.olts.map((o) => o.nome),
  ];
  const lower = termos.map((t) => t.toLowerCase());
  return alvos.some((nome) => {
    const n = nome.toLowerCase();
    return lower.some((t) => n.includes(t) || t.includes(n));
  });
}

function orientacaoZabbix(tipo: ZabbixEventoTipo | null, afetaCliente: boolean): string {
  if (!afetaCliente) {
    return 'NÃO informe queda de CTO/POP/fibra neste cliente — o alerta não foi confirmado na infraestrutura dele. Siga diagnóstico financeiro e ONU normalmente.';
  }
  switch (tipo) {
    case 'cto_off':
      return 'Confirmado: alerta de queda na CTO deste cliente. Informe, peça desculpas e diga que a equipe já está atuando. NÃO reinicie ONU nem abra chamado individual.';
    case 'pppoe_off':
      return 'Confirmado: queda de sessões PPPoE na infraestrutura deste cliente (PON/OLT/CTO). Informe instabilidade na rede e que a equipe está atuando. NÃO reinicie ONU.';
    case 'pop_off':
      return 'Confirmado: alerta no POP deste cliente. Informe o cliente; não reinicie equipamento.';
    case 'fibra':
      return 'Confirmado: queda de interface na infraestrutura deste cliente. Informe o problema de rede/fibra.';
    case 'energia':
      return 'Confirmado: alerta de energia/DSE na infraestrutura deste cliente.';
    default:
      return 'Incidente confirmado na infraestrutura deste cliente — informe com clareza.';
  }
}

function mapZabbixParaTool(z: Awaited<ReturnType<typeof zabbix.diagnosticar>>) {
  return {
    tem_incidente: z.afetaCliente,
    afeta_cliente: z.afetaCliente,
    sem_mapeamento_infra: z.semMapeamentoInfra ?? false,
    termos_consultados: z.hostsConsultados,
    tipo_evento: z.tipoPrincipal,
    resumo: z.afetaCliente ? z.resumo : null,
    erro: z.erro ?? null,
    incidentes: z.incidentes.slice(0, 5).map((i) => ({
      tipo: i.tipo,
      nome: i.nome,
      host: i.hostVisivel || i.host,
      desde: i.desde,
    })),
    orientacao: z.semMapeamentoInfra
      ? 'Infraestrutura do cliente ainda não mapeada (OLT/CTO). NÃO cite queda de CTO/POP. Consulte ONU e siga o fluxo técnico.'
      : z.afetaCliente
        ? orientacaoZabbix(z.tipoPrincipal, true)
        : 'Monitoramento sem alerta na infraestrutura deste cliente. Siga diagnóstico financeiro e ONU.',
  };
}

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

function hojeNoFuso(): Date {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: config.tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const y = Number(parts.find((p) => p.type === 'year')!.value);
  const m = Number(parts.find((p) => p.type === 'month')!.value);
  const d = Number(parts.find((p) => p.type === 'day')!.value);
  return new Date(y, m - 1, d);
}

function parseVencimento(dataVencimento: string): Date | null {
  const s = dataVencimento.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) return new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
  const br = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(s);
  if (br) return new Date(Number(br[3]), Number(br[2]) - 1, Number(br[1]));
  return null;
}

/** SGP às vezes retorna diasAtraso=0 com vencimento já passado — usa a data como fallback. */
function diasAtrasoEfetivo(t: SgpTitulo): number {
  if (t.diasAtraso > 0) return t.diasAtraso;
  const venc = parseVencimento(t.dataVencimento);
  if (!venc) return 0;
  const diff = Math.floor((hojeNoFuso().getTime() - venc.getTime()) / 86_400_000);
  return diff > 0 ? diff : 0;
}

function tituloVencido(t: SgpTitulo): boolean {
  return diasAtrasoEfetivo(t) > 0;
}

function separarTitulos(tits: SgpTitulo[]): { vencidas: SgpTitulo[]; aVencer: SgpTitulo[] } {
  const vencidas = tits.filter(tituloVencido);
  const aVencer = tits.filter((t) => !tituloVencido(t));
  return { vencidas, aVencer };
}

function mapFaturaResumo(t: SgpTitulo) {
  const atraso = diasAtrasoEfetivo(t);
  return {
    id: t.id,
    numero_documento: t.numeroDocumento,
    valor: `R$ ${t.valorCorrigido.toFixed(2).replace('.', ',')}`,
    valor_falado: valorPorExtenso(t.valorCorrigido),
    vencimento: t.dataVencimento,
    atraso_dias: atraso,
    atraso_dias_sgp: t.diasAtraso,
    vencida: atraso > 0,
    status: t.status,
    tem_pix: !!t.codigoPix,
    tem_boleto: !!t.codigoBarras || !!t.link,
  };
}

const FALA_SUSPENSAO_FINANCEIRA =
  'Sua internet está suspensa por pendência financeira. Após o pagamento, a conexão costuma voltar em alguns minutos.';

export interface FinanceiroSpeechInput {
  fala_obrigatoria?: string | null;
  total_vencido?: string | null;
  faturas_vencidas?: { valor?: string; valor_falado?: string; vencimento?: string }[];
}

/** Texto completo para TTS quando o modelo fica mudo após consultar_financeiro. */
export function buildFinanceiroSpeech(result: FinanceiroSpeechInput): string | null {
  const parts: string[] = [];
  if (result.fala_obrigatoria?.trim()) parts.push(result.fala_obrigatoria.trim());
  const vencida = result.faturas_vencidas?.[0];
  if (vencida?.valor_falado || vencida?.valor) {
    const val = vencida.valor_falado || vencida.valor;
    parts.push(`A fatura em aberto é de ${val}.`);
    if (vencida.vencimento) {
      const [y, m, d] = vencida.vencimento.split('-');
      if (d && m && y) parts.push(`O vencimento foi dia ${d} de ${m} de ${y}.`);
    }
  } else if (result.total_vencido) {
    parts.push(`O total vencido é de ${result.total_vencido}.`);
  }
  if (parts.length > 0) {
    parts.push('Posso enviar a segunda via ou o PIX por WhatsApp, se quiser.');
  }
  return parts.length ? parts.join(' ') : null;
}

function suspensoPorFinanceiro(contratoSuspenso: boolean, motivoStatus: string | null): boolean {
  return contratoSuspenso && /financ/i.test(motivoStatus ?? '');
}

function contratoDoContexto(ctx: CallContext, contratoId: number) {
  return ctx.cliente?.contratos.find((c) => c.contrato === contratoId) ?? ctx.cliente?.contratos[0];
}

function orientacaoFinanceiro(params: {
  vencidas: SgpTitulo[];
  aVencer: SgpTitulo[];
  contratoSuspenso: boolean;
  bloqueioFinanceiro: boolean;
  servicoSuspensoFinanceiro: boolean;
}): string {
  const { vencidas, aVencer, contratoSuspenso, bloqueioFinanceiro, servicoSuspensoFinanceiro } = params;
  const prefixoSuspensao = servicoSuspensoFinanceiro
    ? 'OBRIGATÓRIO: comece sua fala com fala_obrigatoria (texto exato do campo). '
    : '';

  if (vencidas.length > 0 && (contratoSuspenso || bloqueioFinanceiro)) {
    return (
      prefixoSuspensao +
      `Há ${vencidas.length} fatura(s) VENCIDA(s). Informe valor e vencimento da vencida e ` +
      'ofereça segunda via/PIX (faturas_vencidas[].id). NÃO envie faturas a vencer sem o cliente pedir.'
    );
  }

  if (vencidas.length > 0) {
    return (
      'Há fatura(s) vencida(s). Só ofereça segunda via da vencida se o assunto for pagamento, ' +
      'corte ou suspensão. Não liste nem envie faturas a vencer automaticamente.'
    );
  }

  if (aVencer.length > 0 && contratoSuspenso && bloqueioFinanceiro) {
    return (
      prefixoSuspensao +
      'Há fatura(s) em aberto sem data vencida. Explique a suspensão; se o cliente pedir boleto, ' +
      'liste faturas_a_vencer e use gerar_segunda_via com fatura_id.'
    );
  }

  if (aVencer.length > 0) {
    return (
      'Há fatura(s) a vencer, mas NENHUMA vencida. NÃO ofereça boleto automaticamente. ' +
      'Se o cliente pedir fatura: informe que não há vencida, pergunte qual deseja, ' +
      'liste faturas_a_vencer (valor e vencimento) e use gerar_segunda_via com fatura_id escolhida.'
    );
  }

  if (contratoSuspenso) {
    return (
      prefixoSuspensao +
      'Sem faturas em aberto no sistema. NÃO ofereça boleto. ' +
      'Avalie desbloqueio_confianca ou oriente contato comercial.'
    );
  }

  return 'Situação financeira regular — sem faturas pendentes.';
}

function resolverFaturaIdPriorizandoVencida(
  ctx: CallContext,
  raw?: unknown,
): number | undefined {
  const fromArgs = Number(raw);
  if (Number.isFinite(fromArgs) && fromArgs > 0) return fromArgs;

  const titulos = ctx.titulos ?? [];
  const vencidas = titulos.filter(tituloVencido);
  if (vencidas.length > 0) {
    const maisAtrasada = [...vencidas].sort((a, b) => diasAtrasoEfetivo(b) - diasAtrasoEfetivo(a))[0];
    return maisAtrasada.id ?? maisAtrasada.numeroDocumento;
  }
  return undefined;
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
function bloqueioSemCliente(ctx: CallContext): Record<string, unknown> | null {
  if (ctx.cliente?.contratoId && ctx.clienteConfirmado) return null;
  if (!ctx.cliente || !ctx.clienteIdentificado) {
    return {
      sucesso: false,
      erro: 'cliente_nao_identificado',
      mensagem: 'Cliente ainda não identificado.',
      orientacao:
        'PARE as consultas. Peça o CPF: "Para eu verificar aqui pra você, pode me informar seu CPF?" ' +
        'Depois buscar_cliente_por_cpf → confirmar_titular_contrato → só então verificar_massiva e consultar_financeiro.',
    };
  }
  return null;
}

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
  return bloqueioSemCliente(ctx) ?? bloqueioSemConfirmacao(ctx) ?? bloqueioSemContrato(ctx);
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
  return resolverFaturaIdPriorizandoVencida(ctx);
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

  /** Pré-carrega faturas, massiva e ONU em paralelo — consultas seguintes usam cache. */
  const prefetchConsultas = (contratoId: number) => {
    void Promise.all([
      sgp.titulos(contratoId, 'abertos').then((t) => { ctx.titulos = t; }),
      sgp.manutencoesAtivas().then((m) => { ctx.manutencoesAtivas = m; }),
      sgp.onuDoContrato(contratoId, { fullFttx: true }).then((o) => { if (o) ctx.onu = o; }),
    ]).catch((err) => logger.debug(`[${ctx.callId}] prefetch SGP`, { err: String(err) }));
  };

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
    prefetchConsultas(contratoId);

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
      if (!pareceConfirmacaoTitular(ctx.lastClientSpeech)) {
        return {
          sucesso: false,
          confirmado: false,
          mensagem: 'Confirmação não reconhecida na última fala do cliente.',
          ultima_fala_cliente: ctx.lastClientSpeech ?? null,
          orientacao:
            'Repita: "Confirma que estou falando com [nome]?" e AGUARDE sim ou não em português. ' +
            'PROIBIDO confirmar com transcrição em inglês, ruído ou fala incompreensível.',
        };
      }

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
      if (ctx.cliente.contratoId) prefetchConsultas(ctx.cliente.contratoId);
      ctx.precisaConsultarFinanceiro = true;
      return {
        sucesso: true,
        confirmado: true,
        contrato_id: ctx.cliente.contratoId,
        endereco: formatarEndereco(ctx.cliente.endereco),
        mensagem: 'Identidade confirmada. Pode prosseguir com consultas e atendimento.',
        orientacao:
          'AGORA chame consultar_financeiro (e verificar_massiva se for caso técnico) — ' +
          'no mesmo turno ou no imediato seguinte. PROIBIDO só avisar que vai consultar e parar em silêncio.',
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

    ctx.precisaConsultarFinanceiro = false;
    ctx.consultaFinanceiraFeita = true;

    const contrato = resolverContratoId(ctx, args.cliente_id, 'consultar_financeiro');
    if ('erro' in contrato) return { sucesso: false, ...contrato };
    const contratoId = contrato.contratoId;

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

    return {
      contrato_id: contratoId,
      inadimplente,
      contrato_suspenso: contratoSuspenso,
      status_contrato: statusContrato,
      motivo_status: motivoStatus,
      bloqueio_financeiro: bloqueioFinanceiro,
      servico_suspenso_financeiro: servicoSuspensoFinanceiro,
      fala_obrigatoria: servicoSuspensoFinanceiro ? FALA_SUSPENSAO_FINANCEIRA : null,
      tem_faturas_abertas: temFaturasAbertas,
      tem_faturas_vencidas: temFaturasVencidas,
      total_vencido: temFaturasVencidas
        ? `R$ ${valorTotalVencido.toFixed(2).replace('.', ',')}`
        : null,
      total_vencido_falado: temFaturasVencidas
        ? valorPorExtenso(valorTotalVencido)
        : null,
      total_a_vencer: aVencer.length > 0
        ? `R$ ${valorTotalAVencer.toFixed(2).replace('.', ',')}`
        : null,
      total_a_vencer_falado: aVencer.length > 0
        ? valorPorExtenso(valorTotalAVencer)
        : null,
      faturas_vencidas: vencidas.map(mapFaturaResumo),
      faturas_a_vencer: aVencer.map(mapFaturaResumo),
      faturas: vencidas.map(mapFaturaResumo),
      orientacao: orientacaoFinanceiro({
        vencidas,
        aVencer,
        contratoSuspenso,
        bloqueioFinanceiro,
        servicoSuspensoFinanceiro,
      }),
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

    const { vencidas, aVencer } = separarTitulos(titulos);
    const faturaIdArg = Number(args.fatura_id);
    const faturaIdInformada = Number.isFinite(faturaIdArg) && faturaIdArg > 0 ? faturaIdArg : undefined;
    let faturaId = faturaIdInformada ?? resolverFaturaIdPriorizandoVencida(ctx);

    if (!faturaId) {
      return {
        sucesso: false,
        requer_escolha_cliente: true,
        tem_faturas_vencidas: false,
        faturas_disponiveis: aVencer.map(mapFaturaResumo),
        mensagem: 'Não há fatura vencida em aberto.',
        orientacao:
          'Informe ao cliente que não há fatura vencida. Pergunte qual fatura ele deseja ' +
          '(liste valor e vencimento de faturas_disponiveis) e chame gerar_segunda_via novamente com fatura_id.',
      };
    }

    const tituloAlvo =
      titulos.find((t) => t.id === faturaId || t.numeroDocumento === faturaId) ?? null;

    if (!tituloAlvo) {
      return {
        sucesso: false,
        mensagem: 'Fatura não encontrada entre as faturas em aberto deste contrato.',
        orientacao: 'Use um id de faturas_vencidas[] ou faturas_a_vencer[] retornado por consultar_financeiro.',
      };
    }

    if (!faturaIdInformada && !tituloVencido(tituloAlvo) && vencidas.length === 0) {
      return {
        sucesso: false,
        requer_escolha_cliente: true,
        faturas_disponiveis: aVencer.map(mapFaturaResumo),
        mensagem: 'Não há fatura vencida — é necessário o cliente escolher qual fatura deseja.',
        orientacao:
          'Liste as opções em faturas_disponiveis e chame novamente com fatura_id após a escolha do cliente.',
      };
    }

    faturaId = tituloAlvo.id ?? tituloAlvo.numeroDocumento;
    const enviarWpp = args.enviar_whatsapp !== false;

    const r = await sgp.fatura2via(contratoId, faturaId);
    if (!r || !r.links?.length) {
      return {
        sucesso: false,
        mensagem: 'Não foi possível gerar segunda via no momento. Tente novamente ou oriente o cliente a acessar o portal.',
        tem_faturas_abertas: true,
        contrato_id: contratoId,
      };
    }

    // Pega a fatura solicitada (nunca envia todas de uma vez)
    const linkObj =
      r.links.find((l) => l.fatura === faturaId) ??
      r.links[0];

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
      valor_falado: valorPorExtenso(linkObj.valor),
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

    await carregarOnuParaInfra(ctx);
    const termos = termosInfraDoCliente(ctx);

    let manutencoes = ctx.manutencoesAtivas;
    if (!manutencoes) {
      manutencoes = await sgp.manutencoesAtivas();
      ctx.manutencoesAtivas = manutencoes;
    }

    const zbx = config.zabbix.enabled ? await zabbix.diagnosticar(termos) : null;

    const manutencaoCliente = manutencoes.filter((m) =>
      !m.ctos.length && !m.olts.length ? false : massivaSgpAfetaCliente(m, termos),
    );
    const sgpMassiva = termos.length
      ? manutencaoCliente.length > 0
      : false;
    const manutencaoRegional = !sgpMassiva && manutencoes.length > 0;
    const zabbixIncidente = zbx?.afetaCliente ?? false;

    if (!sgpMassiva && !zabbixIncidente && !manutencaoRegional) {
      return {
        tem_massiva: false,
        ...(zbx ? { zabbix: mapZabbixParaTool(zbx) } : {}),
      };
    }

    if (!sgpMassiva && !zabbixIncidente && manutencaoRegional) {
      return {
        tem_massiva: false,
        manutencao_regional_nao_confirmada: true,
        total_manutencoes_rede: manutencoes.length,
        orientacao:
          'Há manutenção na rede, mas NÃO confirmada para a infraestrutura deste cliente. NÃO diga que a CTO dele caiu. Siga consulta financeira e ONU.',
        ...(zbx ? { zabbix: mapZabbixParaTool(zbx) } : {}),
      };
    }

    ctx.massivaAtiva = true;

    if (sgpMassiva) {
      const m = manutencaoCliente[0];
      ctx.log.push(`Massiva SGP (cliente): ${m.descricao}`);
      return {
        tem_massiva: true,
        afeta_cliente: true,
        fonte: zabbixIncidente ? 'sgp_e_zabbix' : 'sgp',
        descricao: m.descricao,
        mensagem_ura: m.mensagem_ura || m.descricao,
        severidade: m.severidade,
        data_inicio: m.data_inicial,
        data_previsao_fim: m.data_final,
        olts_afetadas: m.olts.map((o) => o.nome),
        ctos_afetadas: m.ctos.map((c) => c.nome),
        termos_infra: termos,
        ...(zbx ? { zabbix: mapZabbixParaTool(zbx) } : {}),
      };
    }

    ctx.log.push(`Incidente Zabbix (cliente): ${zbx!.resumo}`);
    return {
      tem_massiva: true,
      afeta_cliente: true,
      fonte: 'zabbix',
      descricao: zbx!.resumo,
      mensagem_ura: zbx!.resumo,
      termos_infra: termos,
      zabbix: mapZabbixParaTool(zbx!),
      orientacao: orientacaoZabbix(zbx!.tipoPrincipal, true),
    };
  });

  client.registerTool('consultar_zabbix', async () => {
    const bloqueio = bloqueioConsultas(ctx);
    if (bloqueio) return bloqueio;

    if (!config.zabbix.enabled) {
      return { tem_incidente: false, mensagem: 'Monitoramento Zabbix não habilitado.' };
    }

    await carregarOnuParaInfra(ctx);
    const diag = await zabbix.diagnosticar(termosInfraDoCliente(ctx));
    if (diag.afetaCliente) {
      ctx.massivaAtiva = true;
      ctx.log.push(`Zabbix (cliente): ${diag.resumo}`);
    }
    return mapZabbixParaTool(diag);
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
      onu = await sgp.onuDoContrato(contratoId, { fullFttx: true }) ?? undefined;
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
      cto: onu.cto_nome ?? onu.caixa ?? null,
      pon: onu.pon,
      slot: onu.slot,
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
      planos: planos.map((p) => {
        const num = parseFloat(p.preco);
        return {
          id: p.id,
          nome: p.descricao,
          preco: `R$ ${num.toFixed(2).replace('.', ',')}`,
          preco_falado: valorPorExtenso(num),
        };
      }),
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
    if (ctx.pendingTransfer) {
      return {
        sucesso: false,
        erro: 'transferencia_em_andamento',
        mensagem: 'Transferência em andamento — não encerre a chamada.',
      };
    }
    const motivo = String(args.motivo ?? 'concluído');
    logger.info(`[${ctx.callId}] Encerramento: ${motivo}`);
    ctx.pendingHangup = true;
    ctx.log.push(`Encerrado: ${motivo}`);
    return { sucesso: true };
  });
}
