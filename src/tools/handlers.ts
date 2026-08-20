import { sgp, formatarEndereco, ocorrenciaEncerrada, semGerenciadorCpe } from '../integrations/sgp';
import { geosite } from '../integrations/geosite';
import { zabbix, type ZabbixEventoTipo } from '../integrations/zabbix';
import { whatsapp } from '../integrations/whatsapp';
import { resolveCelularInformado, resolveCepInformado, resolveCpfInformado } from '../utils/spokenNumbers';
import { looksLikeEnderecoFalado, tryRecoverFromCepConfusion } from '../utils/address';
import { config } from '../config';
import { logger } from '../logger';
import type { CallContext } from '../session/context';
import type { ToolRegistrar } from './registrar';
import type { SgpPlano, SgpTitulo } from '../integrations/sgp';

// Remove planos não-comerciais do SGP (revendedores, dedicados, R$0, enterprise)
const PLANO_LIXO = /dedicad|enterpric|semi[\s_-]?dedicad|provedor|\btelecom\b|brush|gol net|rede br|sigma|tecno link|turbinet|wescley|cybervivo|anali|paulo roberto|supermercado|granja/i;

function limparNomePlano(nome: string | null | undefined): string | null {
  if (!nome) return null;
  return nome
    .replace(/\b(basic|premium|gold|plus|master|fidelizado|s\/?fid\w*|promocional|promo|residencial|resid\w*|fibra)\b/gi, '')
    .replace(/plano\s*(de)?/gi, '')
    .replace(/[\s-]{2,}/g, ' ')
    .trim()
    .replace(/^-|-$/g, '')
    .trim();
}

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
  
  try {
    const onu = await sgp.onuDoContrato(contratoId, { fullFttx: true });
    if (onu) {
      ctx.onu = onu;
      
      // FALLBACK GEOSITE: Se o técnico não preencheu a CTO no SGP, tentamos adivinhar por proximidade
      if (!onu.cto_nome && !onu.caixa && config.geosite.enabled) {
        let viabilidade;
        const end = ctx.cliente?.endereco;
        if (end?.latitude && end?.longitude) {
          viabilidade = await geosite.viabilidadePorCoordenadas(
            parseFloat(end.latitude),
            parseFloat(end.longitude)
          );
        } else {
          const endStr = formatarEndereco(end);
          if (endStr) {
            viabilidade = await geosite.viabilidadePorEndereco(endStr);
          }
        }
        
        if (viabilidade?.caixasCobrindo?.length) {
          ctx.infraTermos = ctx.infraTermos || [];
          for (const cx of viabilidade.caixasCobrindo) {
            if (cx.tipoCodigo) ctx.infraTermos.push(cx.tipoCodigo);
          }
          logger.info(`Fallback Geosite acionado para contrato ${contratoId}: adicionadas ${viabilidade.caixasCobrindo.length} CTO(s) próximas.`);
        }
      }
    }
  } catch (err: any) {
    logger.warn('Falha ao carregar ONU pré-diagnóstico técnico', {
      contratoId,
      err: err.message,
    });
  }
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
    valor: valorPorExtenso(t.valorCorrigido),
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
export interface MassivaSpeechInput {
  tem_massiva?: boolean;
  afeta_cliente?: boolean;
  mensagem_ura?: string;
  descricao?: string;
  data_previsao_fim?: string;
  manutencao_regional_nao_confirmada?: boolean;
}

function formatarDataFalada(iso: string): string | null {
  const [y, mStr, d] = iso.split(/[T\s]/)[0]?.split('-') ?? [];
  if (!d || !mStr || !y) return null;
  const m = parseInt(mStr, 10);
  const meses = ['', 'janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
  const nomeMes = meses[m] || mStr;
  return `${d} de ${nomeMes}`;
}

/** Texto para TTS quando o modelo fica mudo após verificar_massiva. */
export function buildMassivaSpeech(result: MassivaSpeechInput): string | null {
  if (result.manutencao_regional_nao_confirmada) {
    return 'Não confirmei falha na rede do seu endereço. Vou seguir com as outras verificações.';
  }
  if (result.tem_massiva && result.afeta_cliente) {
    const msg = result.mensagem_ura?.trim() || result.descricao?.trim();
    let speech = msg
      ? `Identifiquei um problema na rede na sua região. ${msg}`
      : 'Há um problema na rede que pode estar afetando sua conexão. Nossa equipe já está trabalhando nisso.';
    const prev = result.data_previsao_fim ? formatarDataFalada(result.data_previsao_fim) : null;
    if (prev) speech += ` A previsão de normalização é até ${prev}.`;
    speech += ' Peço desculpas pelo transtorno.';
    return speech;
  }
  if (result.tem_massiva === false) {
    return 'Verifiquei a rede aqui e não encontrei nenhum problema geral na sua região.';
  }
  return null;
}

export function buildFinanceiroSpeech(result: FinanceiroSpeechInput): string | null {
  const parts: string[] = [];
  if (result.fala_obrigatoria?.trim()) parts.push(result.fala_obrigatoria.trim());
  const vencida = result.faturas_vencidas?.[0];
  if (vencida?.valor_falado || vencida?.valor) {
    const val = vencida.valor_falado || vencida.valor;
    parts.push(`A fatura em aberto é de ${val}.`);
    if (vencida.vencimento) {
      const [y, mStr, d] = vencida.vencimento.split('-');
      if (d && mStr && y) {
        const m = parseInt(mStr, 10);
        const meses = ['', 'janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
        const nomeMes = meses[m] || mStr;
        parts.push(`O vencimento foi dia ${d} de ${nomeMes}.`);
      }
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
    
  let orientacao = 'Situação financeira regular — sem faturas pendentes.';

  if (vencidas.length > 0 && (contratoSuspenso || bloqueioFinanceiro)) {
    orientacao = prefixoSuspensao +
      `Há ${vencidas.length} fatura(s) VENCIDA(s). Informe valor e vencimento da vencida e ` +
      'ofereça segunda via/PIX (faturas_vencidas[].id). NÃO envie faturas a vencer sem o cliente pedir.';
  } else if (vencidas.length > 0) {
    orientacao = `Há ${vencidas.length} fatura(s) vencida(s). Só ofereça segunda via da vencida se o assunto for pagamento, ` +
      'corte ou suspensão. Não liste nem envie faturas a vencer automaticamente.';
  } else if (aVencer.length > 0 && contratoSuspenso && bloqueioFinanceiro) {
    orientacao = prefixoSuspensao +
      'Há fatura(s) em aberto sem data vencida. Explique a suspensão; se o cliente pedir boleto, ' +
      'liste faturas_a_vencer e use gerar_segunda_via com fatura_id.';
  } else if (aVencer.length > 0) {
    orientacao = 'Há fatura(s) a vencer, mas NENHUMA vencida. NÃO ofereça boleto automaticamente. ' +
      'Se o cliente pedir fatura: informe que não há vencida, pergunte qual deseja, ' +
      'liste faturas_a_vencer (valor e vencimento) e use gerar_segunda_via com fatura_id escolhida.';
  } else if (contratoSuspenso) {
    orientacao = prefixoSuspensao +
      'Sem faturas em aberto no sistema. NÃO ofereça boleto. ' +
      'Avalie desbloqueio_confianca ou oriente contato comercial.';
  }

  return orientacao + ' ATENÇÃO: Consulta financeira concluída. AGORA VOCÊ DEVE FALAR com o cliente (gere a sua resposta em texto para voz). Se ele já relatou problema de internet, DÊ o aviso financeiro e adicione a frase: "Vou dar uma olhada na rede para ver se tem algum alerta na sua região". Em seguida conclua sua fala normalmente.';
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

function faltandoEnderecoViabilidade(logradouro: string, numero: string, bairro: string): string {
  const partes: string[] = [];
  if (!logradouro) partes.push('rua/logradouro');
  if (!numero) partes.push('número do imóvel');
  if (!bairro) partes.push('bairro');
  return partes.join(', ');
}

function formatarCelularFalado(numero: string): string {
  const d = numero.replace(/\D/g, '');
  const local = d.startsWith('55') ? d.slice(2) : d;
  if (local.length !== 11) return numero;
  return `DDD ${local.slice(0, 2)}, ${local.slice(2, 7)} ${local.slice(7)}`;
}

/** Sem acento, sem pontuação, minúsculo — para comparar endereço digitado. */
function normalizarEndereco(s: string): string {
  return s
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[.,\-/]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Acha o contrato pelo endereço que o cliente escreveu.
 *
 * O número da casa é o desempate: no Conjunto Ceará várias avenidas se repetem
 * e só o número distingue os contratos de um mesmo cliente.
 */
function casarContratoPorEndereco(
  ctx: CallContext,
  texto: string,
): { contratoId?: number; ambiguo?: boolean; candidatos?: Array<{ contrato_id: number; endereco: string | null }> } {
  const contratos = ctx.cliente?.contratos ?? [];
  if (!contratos.length) return {};

  const alvo = normalizarEndereco(texto);
  const numerosAlvo = alvo.match(/\d{1,6}/g) ?? [];
  const palavras = alvo.split(' ').filter((p) => p.length >= 4 && !/^\d+$/.test(p));

  const todos = contratos.map((ct) => {
    const end = formatarEndereco(ct.endereco ?? ctx.cliente?.endereco) ?? '';
    return { contratoId: ct.contrato, endereco: end || null, norm: normalizarEndereco(end) };
  });

  // O número da casa FILTRA, não pontua: no Conjunto Ceará a mesma avenida
  // aparece em vários contratos e só o número distingue. Pontuar por palavra
  // empataria "ALBUQUERQUE LIMA 894" com "ALBUQUERQUE LIMA 28".
  let candidatos = todos;
  if (numerosAlvo.length) {
    const comNumero = todos.filter((c) =>
      numerosAlvo.some((n) => c.norm.split(' ').includes(n)),
    );
    if (comNumero.length) candidatos = comNumero;
  }

  if (candidatos.length === 1) return { contratoId: candidatos[0].contratoId };

  const pontuados = candidatos
    .map((c) => ({ ...c, score: palavras.filter((p) => c.norm.includes(p)).length }))
    .sort((a, b) => b.score - a.score);

  const melhor = pontuados[0];
  if (!melhor || melhor.score < 1) return {};

  const empatados = pontuados.filter((p) => p.score === melhor.score);
  // Uma palavra basta quando ela isola um único contrato ("rua londrina").
  // Com empate, nem duas bastam ("avenida a" serve a metade da lista).
  if (empatados.length === 1) return { contratoId: melhor.contratoId };

  if (melhor.score < 2) return {};

  if (empatados.length > 1) {
    return {
      ambiguo: true,
      candidatos: empatados.map((p) => ({ contrato_id: p.contratoId, endereco: p.endereco })),
    };
  }
  return { contratoId: melhor.contratoId };
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

  // No chat o número É o remetente da conversa: ele provou ter WhatsApp ao
  // escrever. Validar formato aqui rejeita wa_id legítimo — o Brasil tem
  // números antigos sem o nono dígito (55 + DDD + 8) — e faz a IA pedir ao
  // cliente um número que ela já tem na mão.
  if (ctx.canal === 'chat' && ctx.celularWhatsApp && !informado) {
    const d = ctx.celularWhatsApp.replace(/\D/g, '');
    if (d.length >= 10) return { numero: d };
  }

  const resolvido = resolveCelularInformado(tel, ctx.lastClientSpeech);
  if (!resolvido.numero) {
    return { numero: null, motivo: 'celular_invalido' };
  }
  if (!whatsapp.isCelularBr(resolvido.numero)) {
    return { numero: null, motivo: 'celular_invalido' };
  }

  if (resolvido.fonte === 'corrigido' || resolvido.fonte === 'fala') {
    logger.info(`[${ctx.callId}] Celular WhatsApp corrigido pela transcrição`, {
      informado: tel.replace(/\D/g, ''),
      usado: resolvido.numero,
      fonte: resolvido.fonte,
      cliente_falou: ctx.lastClientSpeech,
    });
  }

  if (ctx.celularWhatsApp !== resolvido.numero) {
    ctx.celularWhatsApp = resolvido.numero;
    ctx.celularWhatsAppConfirmado = false;
  }
  return { numero: resolvido.numero };
}

interface EnvioWhatsappParams {
  celular_whatsapp?: string;
  celular_confirmado?: boolean;
  resumo_atendimento?: string;
  resposta_cliente?: string;
  fatura?: CallContext['faturaWhatsApp'];
}

async function enviarWhatsappAtendimento(
  ctx: CallContext,
  params: EnvioWhatsappParams,
): Promise<{ enviado: boolean; motivo?: string; orientacao?: string }> {
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

  if (params.celular_confirmado === true) {
    ctx.celularWhatsAppConfirmado = true;
  }
  if (!ctx.celularWhatsAppConfirmado) {
    return {
      enviado: false,
      motivo: 'celular_nao_confirmado',
      orientacao:
        `O número ${formatarCelularFalado(destino.numero)} ainda não foi confirmado. ` +
        'Repita o número dígito a dígito e pergunte se está correto. ' +
        'Só envie após o cliente confirmar (sim/certo) ou use celular_confirmado=true.',
    };
  }

  const fatura = params.fatura ?? ctx.faturaWhatsApp;
  const dadosMsg = {
    clienteNome: ctx.cliente.nome,
    resumoAtendimento: resumo,
    respostaCliente: resposta,
    protocolos: ctx.protocolos.length ? [...ctx.protocolos] : undefined,
    fatura,
  };

  // Canal com transporte próprio (Cloud API): monta o texto e envia por ele.
  // Caso contrário, usa a Evolution (voz e chat via Evolution).
  const resultado = ctx.enviarTextoCliente
    ? await ctx.enviarTextoCliente(destino.numero, whatsapp.montarMensagemAtendimento(dadosMsg))
    : await whatsapp.enviarResumoAtendimento(destino.numero, dadosMsg, ctx.whatsappInstance);

  return {
    enviado: resultado.enviado,
    motivo: resultado.motivo ?? (resultado.enviado ? undefined : 'falha_api_whatsapp'),
  };
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
    plano: limparNomePlano(ct.servicos[0]?.plano?.descricao),
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

/**
 * Rompimento/massiva confirmada para ESTE cliente: chamado individual não pode
 * ser aberto. Numa queda de CTO/OLT o time técnico recebe dezenas de chamados
 * do mesmo evento, o que atrasa justamente o reparo que resolveria todos.
 *
 * Trava no código, não só no prompt: a regra já existia em texto e mesmo assim
 * a IA abriu chamado em produção. Quando a instrução é "nunca faça X", uma
 * checagem antes do efeito colateral vale mais que uma frase no prompt.
 */
function bloqueioPorMassiva(ctx: CallContext): Record<string, unknown> | null {
  if (!ctx.massivaAtiva) return null;
  return {
    sucesso: false,
    erro: 'massiva_ativa',
    mensagem:
      'Há uma falha massiva/rompimento confirmado afetando este cliente — NÃO abra chamado '
      + 'individual. O reparo já está em andamento pela equipe de campo. Informe o cliente sobre '
      + 'a ocorrência, peça desculpas pelo transtorno e passe a previsão de normalização, se houver.',
  };
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

export function registerTools(client: ToolRegistrar, ctx: CallContext): void {

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
    const informado = String(args.cpf ?? '');
    const resolvido = resolveCpfInformado(informado, ctx.lastClientSpeech);
    const digitos = resolvido.cpf ?? cpfDigitos(informado);

    if (resolvido.fonte === 'corrigido') {
      logger.info(`[${ctx.callId}] CPF corrigido pela fala do cliente`, {
        informado: cpfDigitos(informado),
        corrigido: digitos,
      });
    }
    // Segundo CPF na mesma conversa: pode ser cliente com mais de um cadastro,
    // mas pode ser digitação errada ou terceiro pedindo dado alheio. Confirma
    // antes de trocar — trocar em silêncio mistura os atendimentos.
    const cpfAtual = ctx.cliente ? cpfDigitos(ctx.cliente.cpfcnpj) : '';
    if (
      cpfAtual
      && digitos.length === 11
      && digitos !== cpfAtual
      && args.confirmar_troca !== true
    ) {
      return {
        encontrado: false,
        erro: 'troca_de_cadastro_nao_confirmada',
        cliente_atual: ctx.cliente?.nome ?? null,
        mensagem:
          `Você já está atendendo ${ctx.cliente?.nome ?? 'este cliente'} nesta conversa e agora `
          + 'veio um CPF diferente. PERGUNTE ao cliente se ele quer falar sobre OUTRO cadastro '
          + '(outra casa, outro titular) ou se apenas digitou errado. Só depois do "sim" dele, '
          + 'chame de novo com confirmar_troca=true. NÃO troque de cadastro por conta própria.',
      };
    }

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
    if (!cliente) return { encontrado: false, mensagem: 'CPF não encontrado no cadastro.', orientacao: 'O CPF não foi localizado. Pode ser um cliente novo ou o CPF foi digitado incorretamente. Pergunte se o CPF está correto ou se ele é um cliente novo interessado em contratar internet.' };

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
      plano: limparNomePlano(cliente.contratos[0]?.servicos[0]?.plano?.descricao),
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

    let contratoId = Number(args.contrato_id);

    // O cliente responde com o ENDEREÇO, não com o id interno. Sem casar aqui,
    // o modelo fica tentando adivinhar o contrato_id e estoura as rodadas.
    if ((!Number.isFinite(contratoId) || contratoId <= 0) && args.endereco) {
      const achado = casarContratoPorEndereco(ctx, String(args.endereco));
      if (achado.ambiguo) {
        return {
          sucesso: false,
          erro: 'endereco_ambiguo',
          candidatos: achado.candidatos,
          mensagem: 'Mais de um contrato bate com esse endereço. Mostre os candidatos '
            + 'ao cliente e peça para ele confirmar qual é.',
        };
      }
      if (achado.contratoId) contratoId = achado.contratoId;
    }

    if (!Number.isFinite(contratoId) || contratoId <= 0) {
      return {
        sucesso: false,
        mensagem: 'Não identifiquei o contrato. Informe contrato_id OU o endereco dito pelo cliente.',
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
      plano: limparNomePlano(ct.servicos[0]?.plano?.descricao),
      status: ct.status,
      motivo_status: ct.motivo_status,
      mensagem: 'Contrato selecionado.',
      orientacao: 'Consulta de contrato finalizada. O sistema acionará a ferramenta consultar_financeiro automaticamente a seguir, aguarde o resultado.',
    };
  });

  client.registerTool('confirmar_titular_contrato', async (args) => {
    if (!ctx.cliente) {
      return {
        sucesso: false,
        mensagem: 'Nenhum cliente identificado. Busque pelo CPF com buscar_cliente_por_cpf primeiro.',
      };
    }

    // Aguarda até 1.5s pela transcrição caso esteja nula devido a atraso na API (race condition)
    if (!ctx.lastClientSpeech) {
      for (let i = 0; i < 15; i++) {
        await new Promise((r) => setTimeout(r, 100));
        if (ctx.lastClientSpeech) break;
      }
    }

    const confirmado = args.confirmado === true;
    const nomeContrato = ctx.cliente.nome;

    if (confirmado) {
      // Como a transcrição de texto falha com áudios altos ou estourados, 
      // confiamos na compreensão multimodal de áudio da IA.
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

      // Cliente que abriu dizendo "sem internet" não deveria esperar mais uma
      // rodada de ferramenta só pra saber se a rede dele caiu. O prefetch já
      // disparou massiva/ONU acima; damos um instante para responderem e, se
      // vier a tempo, o diagnóstico sai junto da confirmação.
      let redeAgora: Record<string, unknown> | undefined;
      if (ctx.relatouProblemaTecnico) {
        await Promise.race([
          Promise.all([
            sgp.manutencoesAtivas().then((m) => { ctx.manutencoesAtivas = m; }).catch(() => undefined),
            ctx.cliente.contratoId
              ? sgp.onuDoContrato(ctx.cliente.contratoId, { fullFttx: true })
                  .then((o) => { if (o) ctx.onu = o; }).catch(() => undefined)
              : Promise.resolve(),
          ]),
          new Promise((r) => setTimeout(r, 2500)),
        ]);
        const statusOnu = ctx.onu?.conexao?.status;
        if (statusOnu) redeAgora = { status_onu: statusOnu, sinal_rx: ctx.onu?.rx ?? null };
      }

      return {
        sucesso: true,
        confirmado: true,
        contrato_id: ctx.cliente.contratoId,
        endereco: formatarEndereco(ctx.cliente.endereco),
        ...(redeAgora ? { rede: redeAgora } : {}),
        mensagem: 'Identidade confirmada. Pode prosseguir com consultas e atendimento.',
        orientacao: 'Identidade confirmada. O sistema acionará a ferramenta consultar_financeiro automaticamente a seguir, aguarde o resultado.',
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
    
    ctx.financeiroBloqueado = bloqueioFinanceiro;

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
        ? valorPorExtenso(valorTotalVencido)
        : null,
      total_vencido_falado: temFaturasVencidas
        ? valorPorExtenso(valorTotalVencido)
        : null,
      total_a_vencer: aVencer.length > 0
        ? valorPorExtenso(valorTotalAVencer)
        : null,
      total_a_vencer_falado: aVencer.length > 0
        ? valorPorExtenso(valorTotalAVencer)
        : null,
      faturas_vencidas: vencidas.slice(0, 5).map(mapFaturaResumo),
      faturas_a_vencer: aVencer.slice(0, 3).map(mapFaturaResumo),
      faturas: vencidas.slice(0, 5).map(mapFaturaResumo),
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
    const valorFmt = valorPorExtenso(linkObj.valor);
    const temPix = !!pixCola;
    const temBoleto = !!linkBoleto;
    const temLinha = !!linhaDigitavel;
    const temPagamento = temPix || temBoleto || temLinha;

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
        celular_confirmado: args.celular_confirmado === true,
        resumo_atendimento: args.resumo_atendimento ? String(args.resumo_atendimento) : undefined,
        resposta_cliente: args.resposta_cliente ? String(args.resposta_cliente) : undefined,
        fatura: ctx.faturaWhatsApp,
      });
      wppEnviado = resultado.enviado;
      wppMotivo = resultado.motivo;
      if (wppEnviado) {
        logger.info(`[${ctx.callId}] WhatsApp fatura`, {
          temPix,
          temBoleto,
          temLinha,
          fatura_id: linkObj.fatura,
        });
      } else {
        logger.warn(`[${ctx.callId}] WhatsApp não enviado`, { motivo: wppMotivo, temPix, temBoleto, temLinha });
      }
    }

    ctx.log.push(`Segunda via gerada (fatura ${linkObj.fatura}, R$${linkObj.valor})`);

    const msgBase = temPix
      ? temBoleto || temLinha
        ? 'PIX e boleto gerados com sucesso.'
        : 'PIX gerado com sucesso.'
      : temBoleto || temLinha
        ? 'Boleto gerado. PIX indisponível para esta fatura.'
        : 'Fatura localizada, mas o sistema não retornou PIX nem boleto.';

    const msgWhatsapp = wppMotivo === 'celular_nao_informado'
      ? `${msgBase} Pergunte ao cliente qual celular com WhatsApp usar e tente de novo.`
      : wppMotivo === 'celular_nao_confirmado'
        ? `${msgBase} Repita o número dígito a dígito, confirme com o cliente e só então envie. NÃO leia PIX, linha digitável ou link em voz alta.`
        : wppMotivo === 'celular_invalido'
        ? `${msgBase} O número informado não é celular válido. Peça o DDD e os 9 dígitos, confirmando um a um.`
        : wppMotivo === 'numero_sem_whatsapp'
          ? `${msgBase} O número informado não tem WhatsApp. Confirme o celular dígito a dígito com o cliente e tente de novo. NÃO leia PIX, linha digitável ou link em voz alta.`
          : wppMotivo === 'resumo_ou_resposta_ausente'
            ? `${msgBase} Inclua resumo_atendimento e resposta_cliente na tool.`
            : wppMotivo === 'falha_api_whatsapp' || wppMotivo === 'falha_api' || wppMotivo === 'erro_rede' || wppMotivo === 'nao_configurado'
              ? `${msgBase} Não foi possível enviar o WhatsApp agora. Peça outro número ou oriente pagar pelo app do banco. NÃO leia PIX, linha digitável ou link em voz alta.`
              : wppEnviado
                ? temPagamento
                  ? `${msgBase} Enviei no WhatsApp. Confirme se o cliente recebeu. NUNCA leia PIX, linha digitável ou link em voz alta.`
                  : `${msgBase} Enviei só o resumo no WhatsApp (sem PIX/boleto). Oriente o cliente a pagar pelo app do banco ou peça outro número. NÃO leia códigos em voz alta.`
                : `${msgBase} NUNCA leia PIX, linha digitável ou link em voz alta — só por WhatsApp.`;

    return {
      sucesso: true,
      fatura_id: linkObj.fatura,
      valor: valorFmt,
      valor_falado: valorPorExtenso(linkObj.valor),
      vencimento: linkObj.vencimento,
      pix_copia_cola: null,
      link_boleto: null,
      linha_digitavel: null,
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
    ctx.consultaMassivaFeita = true;
    
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
    let status = onu.conexao?.status ?? 'desconhecido';
    const classificacaoSinal = classificarSinalOptico(rxNum);

    // Este SGP não devolve `conexao` junto da ONU, então o status sairia sempre
    // "desconhecido". O RADIUS sabe: consulta a sessão e resolve aqui, em vez de
    // depender de a IA lembrar de fazer a segunda chamada.
    let fonteStatus = 'onu';
    if (status === 'desconhecido') {
      const servico = await servicoDoContrato(contratoId);
      if (servico?.login) {
        const sessao = await sgp.statusPppoe(servico.login).catch(() => null);
        if (sessao) {
          const online = sessao.online === true || sessao.online === 1 || sessao.online === '1';
          status = online ? 'online' : 'offline';
          fonteStatus = 'radius';
        }
      }
    }

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
      // Sinal óptico bom prova que chega LUZ na ONU — não prova que o cliente
      // está conectado. Sem status de conexão não dá para afirmar "está online":
      // dizer isso manda o cliente reiniciar roteador à toa e mascara a queda.
      conexao_confirmada: status === 'online' || status === 'offline',
      fonte_status: fonteStatus,
      interpretacao:
        status === 'offline'
          ? (sinalOk
            ? 'Cliente DESCONECTADO, mas o sinal óptico está bom — chega luz na ONU e mesmo '
              + 'assim não há sessão ativa. Aponta equipamento, cabo de rede ou configuração, '
              + 'NÃO rompimento de fibra. PRÓXIMO PASSO: fale com o cliente. Conte o que você '
              + 'viu, pergunte se as luzes do equipamento estão acesas e peça para ele tirar da '
              + 'tomada por 30 segundos. AGUARDE a resposta dele antes de qualquer outra ação. '
              + 'NÃO abra chamado agora.'
            : 'ONU offline e sem sinal óptico. PRÓXIMO PASSO: fale com o cliente — pergunte se '
              + 'houve queda de energia, se o cabo da fibra está conectado e se alguma luz do '
              + 'equipamento está acesa. AGUARDE a resposta antes de abrir chamado.')
          : sinalOk === false
          ? `Sinal fraco (${onu.rx} dBm). O ideal é entre -7 e -27 dBm`
          : status === 'online'
          ? 'ONU online com sinal dentro do esperado'
          : 'NÃO foi possível confirmar se a ONU está conectada — o SGP não '
            + 'retornou o status da conexão. O sinal óptico está dentro do esperado, '
            + 'mas isso só indica que chega luz no equipamento, NÃO que o cliente '
            + 'está navegando. NÃO diga ao cliente que está tudo bem. Confirme com '
            + 'consultar_pppoe antes de concluir qualquer coisa.',
    };
  });

  /** Primeiro serviço de internet do contrato — id e login PPPoE. */
  async function servicoDoContrato(contratoId: number): Promise<{ id?: number; login?: string } | null> {
    const dados = await sgp.dadosDoContrato(contratoId);
    const ct = dados?.contratos.find((c) => c.contrato === contratoId) ?? dados?.contratos[0];
    const s = ct?.servicos?.[0];
    return s ? { id: s.id, login: s.login } : null;
  }

  // Sessão RADIUS: prova se o cliente está autenticado na rede agora.
  client.registerTool('consultar_pppoe', async (args) => {
    const bloqueio = bloqueioConsultas(ctx);
    if (bloqueio) return bloqueio;

    const contrato = resolverContratoId(ctx, args.cliente_id, 'consultar_pppoe');
    if ('erro' in contrato) return { sucesso: false, ...contrato };

    const servico = await servicoDoContrato(contrato.contratoId);
    if (!servico?.login) {
      return { erro: 'Não localizei o login de conexão deste contrato.' };
    }

    // O radacct pode estourar o tempo; nesse caso não dá para afirmar nada
    // sobre a autenticação — dizer "não autenticado" seria diagnóstico errado.
    let sessao;
    try {
      sessao = await sgp.statusPppoe(servico.login);
    } catch {
      return {
        login: servico.login,
        autenticado: null,
        indisponivel: true,
        interpretacao: 'A consulta ao RADIUS demorou demais e foi abortada. '
          + 'NÃO conclua nada sobre a autenticação — use consultar_onu para o diagnóstico.',
      };
    }

    if (!sessao) {
      return {
        login: servico.login,
        autenticado: false,
        interpretacao: 'Sem sessão ativa no RADIUS — o cliente NÃO está autenticado na rede.',
      };
    }

    const online = sessao.online === true || sessao.online === 1 || sessao.online === '1';
    return {
      login: servico.login,
      autenticado: online,
      ip: sessao.ip ?? null,
      plano: sessao.plano ?? null,
      conectado_desde: sessao.acctstarttime ?? null,
      desconectado_em: online ? null : sessao.acctstoptime ?? null,
      // pppoe_senha vem no retorno do SGP e é deliberadamente omitida.
      interpretacao: online
        ? 'Autenticado na rede. Se o cliente reclama de lentidão, o problema é depois do PPPoE (Wi-Fi ou capacidade).'
        : 'Não autenticado. Verifique ONU, cabo ou bloqueio financeiro.',
    };
  });

  // Speedtest no roteador do cliente — mede o que chega no CPE, não no celular dele.
  client.registerTool('testar_velocidade', async (args) => {
    const bloqueio = bloqueioConsultas(ctx);
    if (bloqueio) return bloqueio;

    const contrato = resolverContratoId(ctx, args.cliente_id, 'testar_velocidade');
    if ('erro' in contrato) return { sucesso: false, ...contrato };

    const servico = await servicoDoContrato(contrato.contratoId);
    if (!servico?.id) return { erro: 'Não localizei o serviço deste contrato.' };

    const r = await sgp.speedtestCpe(servico.id).catch(() => null);
    const ok = r?.success === true || r?.status === 1;
    ctx.log.push(`Speedtest contrato ${contrato.contratoId}: ${ok ? 'disparado' : 'falha'}`);

    return {
      sucesso: ok,
      resultado: r ?? null,
      mensagem: ok
        ? 'Teste de velocidade disparado no roteador. O resultado aparece no SGP em instantes.'
        : 'Não consegui rodar o teste remoto. O roteador pode não suportar TR-069 ou estar offline.',
    };
  });

  // Canal do Wi-Fi — útil quando há muita interferência de vizinhos (2.4 GHz).
  client.registerTool('alterar_canal_wifi', async (args) => {
    const bloqueio = bloqueioConsultas(ctx);
    if (bloqueio) return bloqueio;

    const contrato = resolverContratoId(ctx, args.cliente_id, 'alterar_canal_wifi');
    if ('erro' in contrato) return { sucesso: false, ...contrato };

    const canal = Number(args.canal);
    if (!Number.isInteger(canal) || canal < 1) {
      return { sucesso: false, mensagem: 'Informe um número de canal válido.' };
    }

    const servico = await servicoDoContrato(contrato.contratoId);
    if (!servico?.id) return { erro: 'Não localizei o serviço deste contrato.' };

    // O índice do rádio ("1-1") é obrigatório na chave do update e só vem da listagem.
    const radios = await sgp.listarWifi(servico.id).catch(() => []);
    const radio = radios.find((r) => r.index) ?? radios[0];
    if (!radio?.index) {
      return { sucesso: false, mensagem: 'Não consegui identificar o rádio Wi-Fi deste roteador.' };
    }

    const ok = await sgp.alterarCanalWifi(servico.id, radio.index, canal).catch(() => false);
    ctx.log.push(`Canal Wi-Fi contrato ${contrato.contratoId} → ${canal}: ${ok ? 'ok' : 'falha'}`);

    return {
      sucesso: ok,
      canal_anterior: radio.channel ?? null,
      canal_novo: ok ? canal : null,
      mensagem: ok
        ? `Canal alterado para ${canal}. A rede pode oscilar por alguns segundos.`
        : 'Não consegui alterar o canal agora.',
    };
  });

  // Agenda dos técnicos num intervalo — para propor data de visita com base real.
  client.registerTool('consultar_agenda_tecnica', async (args) => {
    const bloqueio = bloqueioConsultas(ctx);
    if (bloqueio) return bloqueio;

    const inicio = typeof args.data_inicial === 'string' ? args.data_inicial.trim() : '';
    const fim = typeof args.data_final === 'string' ? args.data_final.trim() : '';
    if (!inicio || !fim) {
      return { erro: 'Informe data_inicial e data_final no formato AAAA-MM-DD.' };
    }

    const os = await sgp.agendaTecnica(inicio, fim).catch(() => []);
    const porDia: Record<string, number> = {};
    for (const o of os) {
      const dia = String(o.os_data_agendamento ?? '').slice(0, 10);
      if (dia) porDia[dia] = (porDia[dia] ?? 0) + 1;
    }

    return {
      periodo: { de: inicio, ate: fim },
      total_agendadas: os.length,
      por_dia: porDia,
      interpretacao: os.length
        ? 'Use a distribuição por dia para sugerir a data com menos visitas marcadas.'
        : 'Nenhuma visita agendada nesse período — agenda livre.',
    };
  });

  // Troca de plano: muda velocidade E valor da mensalidade. Exige confirmação.
  client.registerTool('alterar_plano', async (args) => {
    const bloqueio = bloqueioConsultas(ctx);
    if (bloqueio) return bloqueio;

    const contrato = resolverContratoId(ctx, args.cliente_id, 'alterar_plano');
    if ('erro' in contrato) return { sucesso: false, ...contrato };

    const planoId = Number(args.plano_id);
    if (!Number.isInteger(planoId) || planoId <= 0) {
      return { sucesso: false, mensagem: 'Informe o plano_id obtido em consultar_planos.' };
    }
    if (args.confirmado !== true) {
      return {
        sucesso: false,
        mensagem: 'Confirme o novo plano e o novo valor com o cliente e chame de novo com confirmado=true.',
      };
    }

    const servico = await servicoDoContrato(contrato.contratoId);
    if (!servico?.id) return { erro: 'Não localizei o serviço deste contrato.' };

    const r = await sgp.alterarPlanoServico(servico.id, planoId).catch(() => null);
    const ok = !!r && r.status !== 0;
    ctx.log.push(`Alterar plano contrato ${contrato.contratoId} → plano ${planoId}: ${ok ? 'ok' : 'falha'}`);

    // Deixa rastro no cadastro: troca de plano mexe em cobrança.
    const clienteId = ctx.cliente?.clienteId;
    if (ok && clienteId) {
      await sgp.adicionarAnotacao({
        clienteId,
        contratoId: contrato.contratoId,
        anotacao: `Plano alterado para o ID ${planoId} via atendimento automatizado.`,
      }).catch(() => undefined);
    }

    return {
      sucesso: ok,
      mensagem: ok
        ? 'Plano alterado. A nova velocidade vale após a próxima renovação da conexão, '
          + 'e o valor muda na próxima fatura.'
        : r?.msg ?? 'Não consegui alterar o plano. Encaminhe para um atendente.',
    };
  });

  // Faturas de acordo de pagamento — cliente que negociou tem parcelas fixas
  // e cobra por elas, não pela fatura normal do mês.
  client.registerTool('consultar_acordo', async (args) => {
    const bloqueio = bloqueioConsultas(ctx);
    if (bloqueio) return bloqueio;

    const contrato = resolverContratoId(ctx, args.cliente_id, 'consultar_acordo');
    if ('erro' in contrato) return { sucesso: false, ...contrato };

    // Janela larga: acordo antigo continua com parcelas correndo hoje.
    const hoje = new Date();
    const desde = new Date(hoje.getTime() - 3 * 365 * 864e5).toISOString().slice(0, 10);
    const ate = new Date(hoje.getTime() + 2 * 365 * 864e5).toISOString().slice(0, 10);

    const titulos = await sgp.titulosDeAcordo(contrato.contratoId, desde, ate).catch(() => []);
    if (!titulos.length) {
      return {
        tem_acordo: false,
        mensagem: 'Não há faturas de acordo de pagamento neste contrato. '
          + 'Se o cliente afirma ter acordo, pode ser em OUTRO contrato dele — confirme o endereço — '
          + 'ou acordo feito fora do sistema. Nesse caso, transfira para o financeiro.',
      };
    }

    const abertas = titulos.filter((t) => String(t.status).toLowerCase().includes('aberto'));
    const proxima = abertas[0];

    return {
      tem_acordo: true,
      total_parcelas: titulos.length,
      parcelas_em_aberto: abertas.length,
      proxima_parcela: proxima
        ? {
            fatura_id: proxima.id,
            valor: valorPorExtenso(proxima.valorCorrigido ?? proxima.valor),
            vencimento: proxima.dataVencimento ?? null,
            tem_pix: !!proxima.codigoPix,
            tem_boleto: !!(proxima.link || proxima.link_cobranca),
          }
        : null,
      parcelas: abertas.slice(0, 6).map((t) => ({
        fatura_id: t.id,
        valor: valorPorExtenso(t.valorCorrigido ?? t.valor),
        vencimento: t.dataVencimento ?? null,
        dias_atraso: t.diasAtraso ?? 0,
      })),
      orientacao: 'Estas são as parcelas do ACORDO. Para enviar uma delas, use '
        + 'gerar_segunda_via com o fatura_id escolhido. NÃO ofereça a fatura mensal comum '
        + 'a quem tem acordo em aberto — o valor negociado é este.',
    };
  });

  // Histórico de atendimentos: ocorrências + ordens de serviço do contrato.
  client.registerTool('consultar_historico_chamados', async (args) => {
    const bloqueio = bloqueioConsultas(ctx);
    if (bloqueio) return bloqueio;

    const contrato = resolverContratoId(ctx, args.cliente_id, 'consultar_historico_chamados');
    if ('erro' in contrato) return { sucesso: false, ...contrato };
    const contratoId = contrato.contratoId;

    const [ocorrencias, ordens] = await Promise.all([
      sgp.listarOcorrencias(contratoId, 8).catch(() => []),
      sgp.listarOrdensServico(contratoId, 8).catch(() => []),
    ]);

    // Neste SGP o protocolo é `numero` e o encerramento vem de status_id, não de data.
    const protocoloDe = (o: { numero?: string; protocolo?: string; id?: number }) =>
      o.numero ?? o.protocolo ?? (o.id != null ? String(o.id) : null);

    const abertas = ocorrencias.filter((o) => !ocorrenciaEncerrada(o));
    const agendadas = [...ordens, ...ocorrencias]
      .filter((o) => o.data_agendamento && !ocorrenciaEncerrada(o));

    return {
      total_chamados: ocorrencias.length,
      chamados_abertos: abertas.length,
      chamados: ocorrencias.slice(0, 5).map((o) => ({
        protocolo: protocoloDe(o),
        tipo: o.tipo ?? null,
        status: o.status ?? null,
        aberto_em: o.data_cadastro ?? null,
        encerrado: ocorrenciaEncerrada(o),
      })),
      visitas_agendadas: agendadas.map((o) => ({
        protocolo: protocoloDe(o),
        agendada_para: o.data_agendamento,
        motivo: (o as { motivo?: string }).motivo ?? null,
        tecnico: (o as { tecnico?: string }).tecnico ?? null,
      })),
      interpretacao: agendadas.length
        ? 'Já existe visita técnica agendada — informe a data ao cliente e NÃO abra chamado novo para o mesmo problema.'
        : abertas.length
        ? 'Já existe chamado em aberto — informe o protocolo e NÃO abra outro para o mesmo problema.'
        : 'Sem chamados em aberto.',
    };
  });

  // Wi-Fi via Gerenciador CPE (TR-069). Ação que ALTERA o equipamento do cliente.
  client.registerTool('alterar_wifi', async (args) => {
    const bloqueio = bloqueioConsultas(ctx);
    if (bloqueio) return bloqueio;

    const contrato = resolverContratoId(ctx, args.cliente_id, 'alterar_wifi');
    if ('erro' in contrato) return { sucesso: false, ...contrato };
    const contratoId = contrato.contratoId;

    const senha = typeof args.nova_senha === 'string' ? args.nova_senha.trim() : '';
    const ssid = typeof args.novo_nome === 'string' ? args.novo_nome.trim() : '';
    if (!senha && !ssid) {
      return { sucesso: false, mensagem: 'Informe a nova senha e/ou o novo nome da rede.' };
    }
    // WPA2 exige 8 caracteres; senha curta é rejeitada pelo roteador sem erro claro.
    if (senha && senha.length < 8) {
      return { sucesso: false, mensagem: 'A senha do Wi-Fi precisa ter pelo menos 8 caracteres.' };
    }

    const dados = await sgp.dadosDoContrato(contratoId);
    const ct = dados?.contratos.find((c) => c.contrato === contratoId) ?? dados?.contratos[0];
    const servicoId = ct?.servicos?.[0]?.id;
    if (!servicoId) {
      return { sucesso: false, mensagem: 'Não localizei o serviço de internet deste contrato.' };
    }

    // Aplica nos dois rádios: o cliente espera uma senha só para a casa inteira.
    const r = await sgp.alterarCpe({
      contratoId,
      servicoId,
      ...(ssid ? { ssid, ssid5g: `${ssid}_5G` } : {}),
      ...(senha ? { senha, senha5g: senha } : {}),
    });

    const ok = r?.success === true || r?.status === 1;
    ctx.log.push(`Alterar Wi-Fi contrato ${contratoId}: ${ok ? 'sucesso' : 'falha'}`);

    if (!ok && semGerenciadorCpe(r)) {
      return {
        sucesso: false,
        sem_gerenciador_cpe: true,
        mensagem: 'O roteador deste cliente não é gerenciado remotamente. '
          + 'NÃO tente de novo: oriente o cliente a trocar pelo painel do próprio roteador '
          + '(navegador em 192.168.0.1 ou 192.168.1.1) ou ofereça transferir para um atendente.',
      };
    }

    return {
      sucesso: ok,
      mensagem: ok
        ? 'Wi-Fi alterado. Os aparelhos vão desconectar e precisam ser reconectados com os novos dados. '
          + 'A mudança pode levar até 2 minutos para chegar no roteador.'
        : r?.msg ?? 'Não consegui alterar o Wi-Fi agora. O roteador pode estar offline.',
      ...(ok && ssid ? { novo_nome: ssid } : {}),
    };
  });

  // Reboot do roteador via TR-069 — diferente de reiniciar_onu (fibra).
  client.registerTool('reiniciar_roteador', async (args) => {
    const bloqueio = bloqueioConsultas(ctx);
    if (bloqueio) return bloqueio;

    const contrato = resolverContratoId(ctx, args.cliente_id, 'reiniciar_roteador');
    if ('erro' in contrato) return { sucesso: false, ...contrato };
    const contratoId = contrato.contratoId;

    const dados = await sgp.dadosDoContrato(contratoId);
    const ct = dados?.contratos.find((c) => c.contrato === contratoId) ?? dados?.contratos[0];
    const servicoId = ct?.servicos?.[0]?.id;
    if (!servicoId) {
      return { sucesso: false, mensagem: 'Não localizei o serviço de internet deste contrato.' };
    }

    // Confirma se há TR-069 neste contrato: sem isso o reboot nunca funciona.
    const cpe = await sgp.consultarCpe(contratoId, servicoId).catch(() => null);
    if (semGerenciadorCpe(cpe)) {
      return {
        sucesso: false,
        sem_gerenciador_cpe: true,
        mensagem: 'O roteador deste cliente não é gerenciado remotamente. '
          + 'Peça a ele para tirar o roteador da tomada, esperar 30 segundos e ligar de novo.',
      };
    }

    const ok = await sgp.reiniciarCpe(servicoId).catch(() => false);
    ctx.log.push(`Reiniciar roteador contrato ${contratoId}: ${ok ? 'sucesso' : 'falha'}`);

    return {
      sucesso: ok,
      mensagem: ok
        ? 'Roteador reiniciando. Aguarde de 2 a 3 minutinhos para voltar.'
        : 'Não consegui reiniciar o roteador remotamente. '
          + 'Peça ao cliente para tirar da tomada, esperar 30 segundos e ligar de novo.',
    };
  });

  // Status do contrato, endereço e serviços vinculados (login PPPoE + ONU).
  // Os dados já vinham da API do SGP; faltava expor.
  client.registerTool('consultar_contrato', async (args) => {
    const bloqueio = bloqueioConsultas(ctx);
    if (bloqueio) return bloqueio;

    const contrato = resolverContratoId(ctx, args.cliente_id, 'consultar_contrato');
    if ('erro' in contrato) return { sucesso: false, ...contrato };
    const contratoId = contrato.contratoId;

    const dados = await sgp.dadosDoContrato(contratoId);
    if (!dados) return { erro: 'Não foi possível consultar os dados deste contrato.' };

    const ct = dados.contratos.find((c) => c.contrato === contratoId) ?? dados.contratos[0];
    if (!ct) return { erro: 'Contrato não encontrado no cadastro.' };

    const end = ct.endereco ?? dados.endereco;
    const enderecoTexto = end
      ? [
          `${end.logradouro}, ${end.numero}`,
          end.complemento,
          end.bairro,
          `${end.cidade}/${end.uf}`,
          end.cep,
        ].filter(Boolean).join(' — ')
      : null;

    const servicos = (ct.servicos ?? []).map((s) => {
      const rx = s.onu?.rx ? parseFloat(s.onu.rx) : null;
      return {
        tipo: s.tipo,
        plano: s.plano?.descricao ?? null,
        login_pppoe: s.login ?? null,          // s.senha existe e é omitida de propósito
        mac: s.mac ?? null,
        ip: s.onu?.conexao?.ip ?? s.ip ?? null,
        // Wi-Fi vem do cadastro do serviço, mesmo sem Gerenciador de CPE.
        wifi_nome: s.wifi_ssid ?? null,
        wifi_canal: s.wifi_channel ?? null,
        wifi_nome_5g: s.wifi_ssid_5 ?? null,
        wifi_canal_5g: s.wifi_channel_5 ?? null,
        equipamento_serial: s.onu?.serial ?? null,
        equipamento_status: s.onu?.conexao?.status ?? null,
        conectado_desde: s.onu?.conexao?.data_conexao ?? null,
        sinal_rx_dbm: s.onu?.rx ?? null,
        sinal_ok: rx !== null ? rx >= -27 && rx <= -7 : null,
        cto: s.onu?.cto_nome ?? s.onu?.caixa ?? null,
        tem_dados_de_fibra: !!s.onu,
      };
    });

    const algumOnline = servicos.some((s) => s.equipamento_status === 'online');

    return {
      contrato_id: contratoId,
      status: ct.status,
      motivo_status: ct.motivo_status || null,
      data_cadastro: ct.dataCadastro,
      endereco: enderecoTexto,
      total_servicos: servicos.length,
      servicos,
      interpretacao: servicos.length === 0
        ? 'Contrato sem serviço vinculado — verifique com a equipe interna.'
        : algumOnline
        ? 'Contrato ativo com equipamento conectado.'
        : 'Nenhum equipamento conectado no momento — investigue queda de energia, massiva ou problema no equipamento.',
    };
  });

  client.registerTool('reiniciar_onu', async (args) => {
    // Reiniciar ONU durante rompimento não resolve nada (a fibra está cortada)
    // e só faz o cliente perder tempo achando que uma ação útil foi tomada.
    const bloqueio = bloqueioConsultas(ctx) ?? bloqueioPorMassiva(ctx);
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
    const bloqueio = bloqueioConsultas(ctx) ?? bloqueioPorMassiva(ctx);
    if (bloqueio) return bloqueio;

    if (!config.features.chamado) {
      return { sucesso: false, erro: 'Abertura de chamado desabilitada.' };
    }

    const contrato = resolverContratoId(ctx, args.cliente_id, 'abrir_chamado');
    if ('erro' in contrato) return { sucesso: false, ...contrato };
    const contratoId = contrato.contratoId;

    // Trava anti-duplicata: a regra existe no prompt, mas o modelo pula. Como
    // chamado repetido gera visita técnica duplicada, a checagem fica aqui.
    if (args.confirmar_duplicado !== true) {
      const abertas = (await sgp.listarOcorrencias(contratoId, 10).catch(() => []))
        .filter((o) => !ocorrenciaEncerrada(o));
      if (abertas.length) {
        const p = abertas[0];
        return {
          sucesso: false,
          erro: 'ja_existe_chamado_aberto',
          protocolo_existente: p.numero ?? p.protocolo ?? String(p.id ?? ''),
          aberto_em: p.data_cadastro ?? null,
          total_abertos: abertas.length,
          mensagem:
            'JÁ EXISTE chamado aberto para este contrato. NÃO abra outro para o mesmo '
            + 'problema: informe ao cliente o protocolo acima e a data, e diga que a equipe '
            + 'já está com o caso. Só chame de novo com confirmar_duplicado=true se o cliente '
            + 'relatar um problema CLARAMENTE DIFERENTE do que já está registrado.',
        };
      }
    }

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
        celular_confirmado: args.celular_confirmado === true,
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
          : enviarWpp && wppMotivo === 'celular_nao_confirmado'
            ? 'Confirme o número de WhatsApp com o cliente antes de enviar. Informe o protocolo em voz alta.'
            : 'Fale imediatamente ao cliente: "Abri um chamado pra você, o protocolo é [número]. Nossa equipe técnica vai verificar."'
        : undefined,
    };
  });

  client.registerTool('enviar_resumo_whatsapp', async (args) => {
    const bloqueio = bloqueioConsultas(ctx);
    if (bloqueio) return bloqueio;

    const resultado = await enviarWhatsappAtendimento(ctx, {
      celular_whatsapp: args.celular_whatsapp ? String(args.celular_whatsapp) : undefined,
      celular_confirmado: args.celular_confirmado === true,
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
        ? 'Resumo enviado por WhatsApp. Confirme com o cliente que recebeu.'
        : resultado.motivo === 'celular_nao_confirmado'
          ? 'Confirme o número de WhatsApp com o cliente antes de enviar.'
          : resultado.motivo === 'celular_nao_informado'
            ? 'Pergunte ao cliente qual celular com WhatsApp usar.'
            : resultado.motivo === 'resumo_ou_resposta_ausente'
              ? 'Preencha resumo_atendimento e resposta_cliente.'
              : 'Não foi possível enviar o WhatsApp agora.',
    };
  });

  client.registerTool('agendar_visita_tecnica', async (args) => {
    const bloqueio = bloqueioConsultas(ctx) ?? bloqueioPorMassiva(ctx);
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
    let logradouro = args.logradouro ? String(args.logradouro).trim() : '';
    let numero = args.numero ? String(args.numero).trim() : '';
    const bairro = args.bairro ? String(args.bairro).trim() : '';
    const cidade = args.cidade ? String(args.cidade).trim() : '';
    let cepDigitos = args.cep ? String(args.cep).replace(/\D/g, '') : '';

    // O cliente dita o CEP por extenso ("sessenta mil quinhentos e trinta,
    // quatrocentos e trinta") e o modelo erra a conversão — principalmente o
    // "mil". A fala dele é a fonte da verdade; endereço falado fica de fora
    // porque "Rua 830 casa 71" tem tratamento próprio logo abaixo.
    if (ctx.lastClientSpeech && !looksLikeEnderecoFalado(ctx.lastClientSpeech)) {
      const doCliente = resolveCepInformado(cepDigitos, ctx.lastClientSpeech);
      if (doCliente.cep && doCliente.cep !== cepDigitos) {
        logger.info(`[${ctx.callId}] CEP ajustado pela fala do cliente`, {
          informado: cepDigitos || '(vazio)',
          usado: doCliente.cep,
          fonte: doCliente.fonte,
          cliente_falou: ctx.lastClientSpeech,
        });
        cepDigitos = doCliente.cep;
      }
    }

    // Viabilidade depende do endereço EXATO (a CTO mais próxima varia rua a rua).
    // Exige CEP válido OU endereço com rua + número + bairro. Nunca consulta só por bairro/cidade.
    let cepValido = cepDigitos.length === 8;
    let enderecoCompleto = !!logradouro && !!numero && !!bairro;

    if (!cepValido && !enderecoCompleto && args.cep) {
      const recovered = tryRecoverFromCepConfusion(String(args.cep), ctx.lastClientSpeech);
      if (recovered) {
        logradouro = logradouro || recovered.logradouro;
        numero = numero || recovered.numero;
        cepDigitos = '';
        cepValido = false;
        enderecoCompleto = !!logradouro && !!numero && !!bairro;
        logger.info(`[${ctx.callId}] Endereço recuperado (CEP confundido com rua/casa)`, {
          informado: String(args.cep),
          logradouro,
          numero,
          cliente_falou: ctx.lastClientSpeech,
        });
      }
    }

    if (!cepValido && !enderecoCompleto) {
      if (args.cep && !cepValido && looksLikeEnderecoFalado(ctx.lastClientSpeech ?? String(args.cep))) {
        return {
          tem_cobertura: null,
          erro: 'cep_confundido_com_endereco',
          mensagem:
            'O cliente falou ENDEREÇO (ex.: "Rua 830 casa 71"), não CEP. No Ceará há ruas com nome numérico — isso NÃO é CEP. ' +
            'Use logradouro (ex.: "Rua 830"), numero (ex.: "71") e pergunte o bairro. Deixe o campo cep vazio.',
        };
      }
      return {
        tem_cobertura: null,
        erro: 'endereco_incompleto',
        mensagem:
          `Endereço incompleto — falta: ${faltandoEnderecoViabilidade(logradouro, numero, bairro)}. ` +
          'Pergunte especificamente o que falta (especialmente o bairro). Não diga que não tem viabilidade ainda!',
      };
    }

    if (args.cep && !cepValido && !logradouro) {
      return {
        tem_cobertura: null,
        erro: 'cep_invalido',
        mensagem:
          'O CEP que você entendeu é inválido (tem que ter exatamente 8 dígitos). Peça educadamente para o cliente repetir o CEP pausadamente porque não ficou claro.',
      };
    }

    let cepStr = cepValido ? cepDigitos : '';
    const cidadeBusca = args.cidade ? String(args.cidade) : 'Fortaleza';
    // Só existe "endereço" quando há logradouro. Sem ele a lista virava apenas
    // "Fortaleza" — e o GeoSite era consultado pelo centro da cidade, jogando
    // fora o CEP que o cliente informou.
    const endStr = logradouro
      ? [logradouro, numero, bairro, cidadeBusca].filter(Boolean).join(', ')
      : '';

    // Fallback: ViaCEP para descobrir o CEP pela rua e cidade (se não fornecido)
    if (!cepStr && logradouro && cidadeBusca) {
      try {
        const ax = require('axios');
        // Usa estado padrao do config
        const uf = config.defaultUf || 'CE';
        const url = `https://viacep.com.br/ws/${uf}/${encodeURIComponent(cidadeBusca)}/${encodeURIComponent(logradouro)}/json/`;
        const resp = await ax.get(url, { timeout: 3500 });
        if (Array.isArray(resp.data) && resp.data.length > 0) {
          let match = resp.data[0];
          if (bairro) {
            const mBairro = resp.data.find((d: any) => d.bairro && d.bairro.toLowerCase().includes(bairro.toLowerCase()));
            if (mBairro) match = mBairro;
          }
          cepStr = match.cep.replace(/\D/g, '');
          ctx.log.push(`ViaCEP fallback descobriu o CEP: ${cepStr} (${match.logradouro})`);
        }
      } catch (err: any) {
        ctx.log.push(`ViaCEP fallback falhou: ${err.message || ''}`);
      }
    }

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
        const limite = config.geosite.distanciaMaximaAutomaticaM;

        // Acima do limite, mesmo com porta livre a distância real de rota pode
        // variar bastante (a linha reta do GeoSite não é a rota do cabo) —
        // confirmar cobertura sozinha aqui vira promessa que pode não se sustentar.
        if (distancia > limite) {
          ctx.log.push(
            `Viabilidade GeoSite: CTO ${cto.tipoCodigo} a ${distancia}m (acima do limite de ${limite}m) — requer validação humana`,
          );
          return {
            tem_cobertura: null,
            fonte: 'geosite',
            motivo: 'distancia_acima_do_limite_automatico',
            oferecer_cadastro_interesse: true,
            mensagem:
              'Há CTO na região, mas a distância está acima do que o sistema confirma automaticamente. '
              + 'NÃO diga que TEM nem que NÃO TEM cobertura — diga que o endereço será validado com '
              + 'precisão pelo atendimento humano. Colete nome e celular com DDD e registre com '
              + 'registrar_interesse.',
          };
        }

        ctx.log.push(
          `Viabilidade GeoSite: CTO ${cto.tipoCodigo} a ${distancia}m com ${cto.portasDisponiveis} porta(s) livre(s)`,
        );
        // CTO, distância e portas ficam só no log/auditoria: são dados de planta.
        // Não voltam para o modelo, para não vazarem na resposta ao cliente.
        return {
          tem_cobertura: true,
          fonte: 'geosite',
        };
      }

      // Consulta falhou: NÃO é o mesmo que "não tem cobertura". Recusar venda
      // por indisponibilidade do GeoSite é pior do que pedir uma confirmação.
      if (geo.erro) {
        ctx.log.push(`Viabilidade GeoSite INDISPONÍVEL para "${endStr || cepStr}"`);
        return {
          tem_cobertura: null,
          erro: 'consulta_indisponivel',
          mensagem:
            'A consulta de cobertura falhou — NÃO diga que não temos cobertura, isso não foi verificado. '
            + 'Peça desculpas pela instabilidade, colete nome e celular com DDD, registre com '
            + 'registrar_interesse e diga que a equipe comercial confirma a disponibilidade em seguida.',
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
          oferecer_cadastro_interesse: true,
          mensagem:
            'Sem porta disponível na região. NÃO explique isso ao cliente — não fale em '
            + 'CTO, caixa, porta ou distância. Diga apenas que ainda não temos cobertura '
            + 'disponível no endereço e ofereça registrar o interesse.',
        };
      }
    }

    // 2. Fallback SGP — usado apenas quando o GeoSite não encontrou CTOs próximas,
    //    está desabilitado ou falhou. Ignorado se COVERAGE_USE_GEOSITE_ONLY=true.
    if (!config.geosite.useGeositeOnly) {
      const temCobertura = await sgp.viabilidade({
        cep: cepStr || cepDigitos || undefined,
        logradouro: logradouro || undefined,
        numero_inicial: numero || undefined,
        numero_final: numero || undefined,
        bairro: bairro || undefined,
        cidade: cidadeBusca || undefined,
      });

      if (temCobertura) return { tem_cobertura: true, fonte: 'sgp' };
      return { tem_cobertura: false, fonte: 'sgp', oferecer_cadastro_interesse: true };
    }

    // Chegar aqui com o GeoSite desligado significa que NENHUMA fonte foi
    // consultada: o SGP está bloqueado por useGeositeOnly. Responder "sem
    // cobertura" seria inventar — recusaria todo prospect, em qualquer endereço.
    if (!config.geosite.enabled) {
      logger.error('Viabilidade sem fonte: GEOSITE_ENABLED=0 com COVERAGE_USE_GEOSITE_ONLY=1', {
        endereco: endStr || cepStr,
      });
      return {
        tem_cobertura: null,
        erro: 'sem_fonte_de_cobertura',
        mensagem:
          'Não foi possível verificar a cobertura — NÃO afirme que não temos. '
          + 'Colete nome e celular com DDD, registre com registrar_interesse e diga que '
          + 'a equipe comercial confirma a disponibilidade em seguida.',
      };
    }

    return { tem_cobertura: false, fonte: 'geosite', oferecer_cadastro_interesse: true };
  });

  client.registerTool('registrar_interesse', async (args) => {
    const tipoInteresse = args.tipo_interesse ? String(args.tipo_interesse) : '';
    const nomeArg = String(args.nome ?? '').trim();
    const nome = nomeArg || (tipoInteresse === 'mudanca_endereco' ? ctx.cliente?.nome?.trim() : '') || '';
    const email = args.email ? String(args.email).trim() : null;
    const enderecoNovo = String(args.endereco ?? ctx.enderecoConsultado ?? '').trim();
    const plano = args.plano_interesse ? String(args.plano_interesse).trim() : null;
    const horario = args.melhor_horario ? String(args.melhor_horario) : null;

    const celularResolvido = args.celular
      ? resolveCelularInformado(String(args.celular), ctx.lastClientSpeech)
      : null;
    const telefone =
      celularResolvido?.numero ||
      ctx.celularWhatsApp ||
      (args.celular ? String(args.celular).replace(/\D/g, '') : '') ||
      ctx.callerNumber ||
      null;

    if (!nome || !enderecoNovo) {
      return {
        sucesso: false,
        mensagem:
          tipoInteresse === 'mudanca_endereco'
            ? 'Identifique o cliente por CPF, consulte financeiro e viabilidade no novo endereço. Celular com DDD é obrigatório.'
            : 'Nome e endereço são obrigatórios.',
      };
    }

    if ((tipoInteresse === 'nova_assinatura' || tipoInteresse === 'mudanca_endereco') && !telefone) {
      return {
        sucesso: false,
        mensagem: 'Celular com DDD é obrigatório. Pergunte ao cliente e confirme dígito a dígito.',
      };
    }

    const agora = new Date().toLocaleString('pt-BR', { timeZone: config.tz });
    const temCobertura = !!plano && !args.endereco?.toString().includes('sem cobertura');
    const contratoId = ctx.cliente?.contratoId;
    const enderecoAtual = ctx.cliente ? formatarEndereco(ctx.cliente.endereco) : null;

    let titulo = `🔔 *Interesse de Cobertura*`;
    if (tipoInteresse === 'nova_assinatura') titulo = `🛒 *Interesse em Contratação*`;
    else if (tipoInteresse === 'mudanca_endereco') titulo = `🏠 *Mudança de Endereço*`;
    else if (plano) titulo = `🛒 *Interesse em Contratação*`;

    const linhas = [
      titulo,
      ``,
      `👤 *Nome:* ${nome}`,
      tipoInteresse === 'mudanca_endereco' && contratoId
        ? `📋 *Contrato:* ${contratoId}`
        : null,
      telefone ? `📱 *Telefone:* ${telefone}` : null,
      email ? `📧 *E-mail:* ${email}` : null,
      tipoInteresse === 'mudanca_endereco' && enderecoAtual
        ? `🏠 *Endereço atual:* ${enderecoAtual}`
        : null,
      tipoInteresse === 'mudanca_endereco'
        ? `📍 *Novo endereço:* ${enderecoNovo}`
        : `📍 *Endereço:* ${enderecoNovo}`,
      plano ? `📦 *Plano de interesse:* ${plano}` : null,
      horario ? `🕐 *Melhor horário:* ${horario}` : null,
      ``,
      `🗓️ _Registrado em ${agora} via URA_`,
    ].filter((l) => l !== null).join('\n');

    let enviado = false;
    if (config.whatsapp.salesGroupId) {
      const resultado = await whatsapp.enviarGrupo(config.whatsapp.salesGroupId, linhas, ctx.whatsappInstance);
      enviado = resultado.enviado;
    }

    ctx.log.push(`Interesse registrado: ${nome} — ${enderecoNovo}`);
    logger.info(`[${ctx.callId}] Interesse registrado: ${nome}`, {
      tipo: tipoInteresse,
      endereco: enderecoNovo,
      contratoId,
      enviado,
    });

    return {
      sucesso: true,
      whatsapp_enviado: enviado,
      mensagem:
        tipoInteresse === 'mudanca_endereco'
          ? `Solicitação de mudança registrada para ${nome}${contratoId ? ` (contrato ${contratoId})` : ''}. A equipe entrará em contato.`
          : `Interesse registrado com sucesso para ${nome}.`,
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
          nome: p.descricao
            .replace(/MB/gi, ' Mega')
            .replace(/GB/gi, ' Giga')
            .replace(/\s*-\s*(BASIC|PLUS|PREMIUM|ULTRA)/gi, '')
            .trim(),
          preco: valorPorExtenso(num),
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
  client.registerTool('ignorar_ruido', async () => {
    logger.debug(`[${ctx.callId}] AI escolheu ignorar ruído em inglês/incompreensível.`);
    return { ignorado: true };
  });
}


