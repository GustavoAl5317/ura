// Ferramentas de NetFlow (Flow Guard API, na flow-vm).
//
// Três regras que valem para todas:
//   · volume sai ESTIMADO (amostrado × fator) e diz o fator usado;
//   · janela que chega até agora exige coleta viva — se o coletor parou, a
//     ferramenta falha e a resposta vira "fonte indisponível", não "sem tráfego";
//   · IP vira cliente só pelo espelho do SGP, e isso é dito como foto do sync.

import { config } from '../../config';
import {
  netflow, estimar, formatarBytes, formatarMbps, mbpsMedio, volumeDaJanela,
  Janela, PontoSerie, TalkerNetflow,
} from '../../integrations/netflow';
import { obter } from '../config-dinamica';
import { nomesDeInterfacePorIndice } from '../../integrations/zabbix-metricas';
import { clientesPorIps, ipsDoContrato, statusIndice } from '../store/sgp-index';
import { Ferramenta, medir, ferramentas } from './base';

const MAX_MINUTOS = 7 * 24 * 60;

/** ASNs mais comuns no tráfego de um provedor. Fora desta lista, só o número. */
const ASN_CONHECIDO: Record<number, string> = {
  15169: 'Google', 36040: 'YouTube (Google)', 396982: 'Google Cloud', 32934: 'Meta (Facebook/Instagram/WhatsApp)',
  2906: 'Netflix', 16509: 'Amazon', 14618: 'Amazon', 8075: 'Microsoft', 20940: 'Akamai', 16625: 'Akamai',
  13335: 'Cloudflare', 54113: 'Fastly', 714: 'Apple', 6185: 'Apple', 46489: 'Twitch', 32590: 'Valve (Steam)',
  60068: 'CDN77', 138699: 'TikTok (ByteDance)', 396986: 'ByteDance', 40027: 'Netflix',
};

function nomeAsn(asn: number | null | undefined): string | null {
  if (!asn) return null;
  return ASN_CONHECIDO[asn] ?? null;
}

/** Janela a partir de "minutos" (padrão) ou de inicio/fim em ISO. */
function janelaDe(args: Record<string, unknown>, padraoMin: number): Janela & { minutos: number } {
  const agora = Math.floor(Date.now() / 1000);
  const fimArg = typeof args.fim === 'string' ? Date.parse(args.fim) : NaN;
  const iniArg = typeof args.inicio === 'string' ? Date.parse(args.inicio) : NaN;
  const fim = Number.isFinite(fimArg) ? Math.min(agora, Math.floor(fimArg / 1000)) : agora;
  let inicio: number;
  if (Number.isFinite(iniArg)) {
    inicio = Math.floor(iniArg / 1000);
  } else {
    const min = Math.min(MAX_MINUTOS, Math.max(1, Number(args.minutos) || padraoMin));
    inicio = fim - min * 60;
  }
  if (inicio >= fim) throw new Error('janela inválida: o início precisa ser antes do fim');
  if (fim - inicio > MAX_MINUTOS * 60) inicio = fim - MAX_MINUTOS * 60;
  return { inicio, fim, minutos: Math.round((fim - inicio) / 60) };
}

function bucketPara(j: Janela): number {
  // ~24 pontos: o bastante para ver o formato, pouco para o modelo se perder.
  const bruto = (j.fim - j.inicio) / 24;
  return Math.max(60, Math.round(bruto / 60) * 60);
}

const iso = (seg: number) => new Date(seg * 1000).toISOString();

function janelaInfo(j: Janela & { minutos: number }) {
  return { inicio: iso(j.inicio), fim: iso(j.fim), minutos: j.minutos };
}

function amostragem() {
  const fator = netflow.fator;
  return {
    fator,
    observacao: fator > 1
      ? `Volumes estimados: o roteador exporta 1 fluxo a cada ${fator}, e os números já foram multiplicados. ` +
        'Servem para comparar e dimensionar; não são medição exata. "fluxos_amostrados" não é multiplicado.'
      : 'Sem fator de amostragem configurado (NETFLOW_FATOR_AMOSTRAGEM=1): se o roteador amostra, os volumes estão subestimados.',
  };
}

function tipoIp(ip: string): string {
  const o = ip.split('.').map(Number);
  if (o.length !== 4 || o.some((x) => !Number.isInteger(x))) return 'ipv6_ou_outro';
  if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return 'cgnat';
  if (o[0] === 10 || (o[0] === 172 && o[1] >= 16 && o[1] <= 31) || (o[0] === 192 && o[1] === 168)) return 'privado';
  return 'publico';
}

/** Ponto de série com volume estimado e Mbps médio no intervalo. */
function ponto(p: PontoSerie, bucketSeg: number) {
  const bytes = estimar(p.total_bytes);
  return {
    inicio: iso(p.bucket),
    mbps_estimado: Math.round(mbpsMedio(bytes, bucketSeg) * 10) / 10,
    ...(p.critical || p.warning ? { alertas: { criticos: p.critical ?? 0, avisos: p.warning ?? 0 } } : {}),
  };
}

function clienteDoIp(ip: string, mapa: ReturnType<typeof clientesPorIps>) {
  const c = mapa.get(ip);
  if (!c) return null;
  return {
    nome: c.nome,
    contrato: c.contrato_id,
    login: c.login,
    plano: c.plano,
    conectado_desde: c.conectado_desde,
  };
}

function notaCliente(mapa: ReturnType<typeof clientesPorIps>): string | null {
  if (!mapa.size) {
    return statusIndice().disponivel
      ? 'Nenhum IP casou com o cadastro do SGP no último sync (IP pode ser de CGNAT reatribuído, de infraestrutura ou de fora da rede).'
      : 'Espelho do SGP indisponível: não foi possível associar IP a cliente.';
  }
  return 'Cliente associado pelo IP de conexão registrado no SGP no último sync. IP dinâmico/CGNAT muda a cada reconexão: ' +
    'confirme com revisao_cliente antes de afirmar que o consumo é desse cliente.';
}

// ─── Tráfego geral ─────────────────────────────────────────────────────────

const trafego: Ferramenta = {
  nome: 'netflow_trafego',
  fonte: 'netflow',
  descricao:
    'Tráfego total da rede pelo NetFlow numa janela: média, pico e série no tempo, em Mbps estimados. ' +
    'Responde "como está o tráfego agora", "teve pico hoje?", "o tráfego caiu?". ' +
    'Os valores são ESTIMADOS por amostragem. Vem de um único roteador exportador — não é o tráfego de ' +
    'cada link (para link, use netflow_links ou zabbix_links). Se a coleta estiver parada, a ferramenta falha em vez de mostrar zero.',
  parametros: {
    type: 'object',
    properties: {
      minutos: { type: 'number', description: 'Janela até agora, em minutos (padrão 60, máx 10080)' },
      inicio: { type: 'string', description: 'Início em ISO 8601, para janela no passado' },
      fim: { type: 'string', description: 'Fim em ISO 8601 (padrão: agora)' },
    },
    required: [],
  },
  async executar(args, ctx) {
    return [await medir<Record<string, unknown>>(ctx, 'netflow', 'netflow.trafego', args, async () => {
      const j = janelaDe(args, 60);
      const frescor = await netflow.exigirColetaViva(j);
      const bucket = bucketPara(j);
      const [r, serie] = await Promise.all([netflow.resumo(j), netflow.serie(j, bucket)]);
      const bytes = estimar(r.total_bytes);
      const pontos = serie.map((p) => ponto(p, bucket));
      const pico = pontos.reduce<(typeof pontos)[number] | null>((m, p) => (!m || p.mbps_estimado > m.mbps_estimado ? p : m), null);
      return {
        vazio: !r.total_flows,
        dados: {
          janela: janelaInfo(j),
          amostragem: amostragem(),
          coleta: frescor ? { viva: true, fluxos_ultimos_min: frescor.fluxosRecentes, janela_min: frescor.janelaMin } : 'janela no passado',
          media: formatarMbps(mbpsMedio(bytes, j.fim - j.inicio)),
          pico_no_intervalo: pico ? { mbps: formatarMbps(pico.mbps_estimado), em: pico.inicio, intervalo_seg: bucket } : null,
          volume_total: formatarBytes(bytes),
          fluxos_amostrados: r.total_flows,
          serie: { intervalo_seg: bucket, pontos },
        },
      };
    })];
  },
};

// ─── Consumo por cliente ───────────────────────────────────────────────────

function talker(t: TalkerNetflow, segundos: number, mapa: ReturnType<typeof clientesPorIps>, totalBytes: number) {
  const bytes = estimar(t.total_bytes);
  return {
    ip: t.ip,
    tipo_ip: tipoIp(t.ip),
    cliente: clienteDoIp(t.ip, mapa),
    volume: formatarBytes(bytes),
    media: formatarMbps(mbpsMedio(bytes, segundos)),
    participacao_pct: totalBytes ? Math.round((bytes / totalBytes) * 1000) / 10 : null,
    fluxos_amostrados: t.flows,
    ...(t.src_as ? { asn_origem: t.src_as, asn_origem_nome: nomeAsn(t.src_as) } : {}),
    ...(t.critical || t.warning ? { alertas_flow_guard: { criticos: t.critical ?? 0, avisos: t.warning ?? 0 } } : {}),
  };
}

const consumoClientes: Ferramenta = {
  nome: 'netflow_consumo_clientes',
  fonte: 'netflow',
  descricao:
    'Quais IPs mais consomem banda numa janela, com o cliente associado pelo cadastro do SGP quando ' +
    'o IP casa. Responde "quem está consumindo mais?", "tem cliente puxando muita banda?". ' +
    'Volumes estimados por amostragem. A associação IP→cliente é do último sync e pode estar ' +
    'desatualizada em IP dinâmico/CGNAT — confirme com revisao_cliente antes de afirmar.',
  parametros: {
    type: 'object',
    properties: {
      minutos: { type: 'number', description: 'Janela até agora, em minutos (padrão 30)' },
      inicio: { type: 'string', description: 'Início em ISO 8601' },
      fim: { type: 'string', description: 'Fim em ISO 8601' },
      limite: { type: 'number', description: 'Quantos IPs (padrão 10, máx 50)' },
    },
    required: [],
  },
  async executar(args, ctx) {
    return [await medir<Record<string, unknown>>(ctx, 'netflow', 'netflow.consumo_clientes', args, async () => {
      const j = janelaDe(args, 30);
      await netflow.exigirColetaViva(j);
      const limite = Math.min(50, Math.max(1, Number(args.limite) || 10));
      const [lista, r] = await Promise.all([netflow.consumoPorCliente(j, limite), netflow.resumo(j)]);
      const mapa = clientesPorIps(lista.map((t) => t.ip));
      const total = estimar(r.total_bytes);
      return {
        vazio: lista.length === 0,
        dados: {
          janela: janelaInfo(j),
          amostragem: amostragem(),
          trafego_total_da_janela: formatarBytes(total),
          consumidores: lista.map((t) => talker(t, j.fim - j.inicio, mapa, total)),
          associacao_cliente: notaCliente(mapa),
        },
      };
    })];
  },
};

// ─── Tráfego de um IP / cliente ────────────────────────────────────────────

const trafegoIp: Ferramenta = {
  nome: 'netflow_trafego_ip',
  fonte: 'netflow',
  descricao:
    'Série de tráfego de um IP específico (Mbps estimados no tempo). Use para "quanto o cliente X ' +
    'está consumindo", "o cliente reclama de lentidão: ele está usando a banda toda?". ' +
    'Prefira passar o IP ATUAL, que vem de revisao_cliente (conexão ao vivo do SGP). Com só o ' +
    'contrato, usa o IP do último sync, que pode ter mudado.',
  parametros: {
    type: 'object',
    properties: {
      ip: { type: 'string', description: 'IP do cliente (preferível: o de revisao_cliente)' },
      contrato_id: { type: 'number', description: 'Contrato, quando não houver IP — usa o IP do último sync' },
      minutos: { type: 'number', description: 'Janela até agora, em minutos (padrão 60)' },
      inicio: { type: 'string', description: 'Início em ISO 8601' },
      fim: { type: 'string', description: 'Fim em ISO 8601' },
    },
    required: [],
  },
  async executar(args, ctx) {
    return [await medir<Record<string, unknown>>(ctx, 'netflow', 'netflow.trafego_ip', args, async () => {
      let ips: Array<{ ip: string; origem: string }> = [];
      if (typeof args.ip === 'string' && args.ip.trim()) {
        ips = [{ ip: args.ip.trim(), origem: 'informado' }];
      } else if (Number(args.contrato_id)) {
        const doSync = ipsDoContrato(Number(args.contrato_id));
        if (!doSync.length) {
          throw new Error(
            `contrato ${args.contrato_id} sem IP de conexão no espelho do SGP (offline no último sync). ` +
            'Use revisao_cliente para pegar o IP atual.',
          );
        }
        ips = doSync.map((x) => ({ ip: x.ip, origem: `espelho do SGP (${x.espelho_em})` }));
      } else {
        throw new Error('informe ip ou contrato_id');
      }

      const j = janelaDe(args, 60);
      await netflow.exigirColetaViva(j);
      const bucket = bucketPara(j);
      const mapa = clientesPorIps(ips.map((x) => x.ip));

      const resultados = await Promise.all(ips.slice(0, 4).map(async (x) => {
        const serie = await netflow.serieDoIp(x.ip, j, bucket);
        const pontos = serie.map((p) => ponto(p, bucket));
        const bytes = serie.reduce((s, p) => s + estimar(p.total_bytes), 0);
        const pico = pontos.reduce<(typeof pontos)[number] | null>((m, p) => (!m || p.mbps_estimado > m.mbps_estimado ? p : m), null);
        return {
          ip: x.ip,
          tipo_ip: tipoIp(x.ip),
          ip_veio_de: x.origem,
          cliente_no_cadastro: clienteDoIp(x.ip, mapa),
          volume: formatarBytes(bytes),
          media: formatarMbps(mbpsMedio(bytes, j.fim - j.inicio)),
          pico_no_intervalo: pico && pico.mbps_estimado > 0 ? { mbps: formatarMbps(pico.mbps_estimado), em: pico.inicio } : null,
          sem_trafego_na_janela: bytes === 0,
          serie: { intervalo_seg: bucket, pontos },
        };
      }));

      return {
        // IP sem fluxo com a coleta VIVA é informação (o IP não trafegou), não vazio.
        dados: {
          janela: janelaInfo(j),
          amostragem: amostragem(),
          ips: resultados,
          observacao: resultados.some((r) => r.sem_trafego_na_janela)
            ? 'IP sem fluxo amostrado na janela com a coleta ativa: ou não trafegou, ou o volume foi baixo demais para ' +
              `aparecer na amostragem de 1:${netflow.fator}, ou o IP não é mais desse cliente.`
            : null,
        },
      };
    })];
  },
};

// ─── Ataques e incidentes ──────────────────────────────────────────────────

const ataques: Ferramenta = {
  nome: 'netflow_ataques',
  fonte: 'netflow',
  descricao:
    'Suspeitas de ataque (DDoS, varredura) e incidentes de tráfego detectados pelo Flow Guard numa janela: ' +
    'IP alvo, cliente associado, quantas origens, protocolos, ASNs de origem e duração. ' +
    'É CLASSIFICAÇÃO AUTOMÁTICA por heurística do Flow Guard, não confirmação: tráfego legítimo ' +
    '(ex.: respostas DNS para um resolvedor) pode aparecer aqui. Apresente como suspeita.',
  parametros: {
    type: 'object',
    properties: {
      minutos: { type: 'number', description: 'Janela até agora, em minutos (padrão 60)' },
      inicio: { type: 'string', description: 'Início em ISO 8601' },
      fim: { type: 'string', description: 'Fim em ISO 8601' },
      limite: { type: 'number', description: 'Quantos alvos (padrão 10, máx 30)' },
    },
    required: [],
  },
  async executar(args, ctx) {
    return [await medir<Record<string, unknown>>(ctx, 'netflow', 'netflow.ataques', args, async () => {
      const j = janelaDe(args, 60);
      await netflow.exigirColetaViva(j);
      const limite = Math.min(30, Math.max(1, Number(args.limite) || 10));
      const [lista, criticos] = await Promise.all([
        netflow.ataques(j, limite),
        netflow.incidentes(j, 5, 'critical'),
      ]);
      const mapa = clientesPorIps([...lista.map((a) => a.victim_ip), ...criticos.map((i) => i.ip)]);
      return {
        vazio: lista.length === 0 && criticos.length === 0,
        dados: {
          janela: janelaInfo(j),
          amostragem: amostragem(),
          natureza: 'classificação automática do Flow Guard — suspeita, não confirmação',
          suspeitas: lista.map((a) => ({
            alvo_ip: a.victim_ip,
            tipo_ip: tipoIp(a.victim_ip),
            cliente: clienteDoIp(a.victim_ip, mapa),
            severidade: a.max_severity,
            inicio: iso(a.first_seen),
            ultimo: iso(a.last_seen),
            duracao_min: Math.round(a.duration_s / 60),
            origens_distintas: a.unique_sources,
            eventos: a.event_count,
            volume: formatarBytes(estimar(a.total_bytes)),
            protocolos: (a.protocols ?? []).map((p) => `${p.proto} (${p.cnt})`),
            asns_de_origem: (a.top_asns ?? []).slice(0, 5).map((x) => ({ asn: x.asn, nome: nomeAsn(x.asn), eventos: x.cnt })),
          })),
          incidentes_criticos: criticos.map((i) => ({
            em: iso(i.tstamp),
            ip: i.ip,
            cliente: clienteDoIp(i.ip, mapa),
            protocolo: i.proto,
            porta_origem: i.src_port,
            porta_destino: i.dst_port,
            pontuacao: i.score,
          })),
          associacao_cliente: notaCliente(mapa),
        },
      };
    })];
  },
};

// ─── Para onde vai o tráfego (ASN) ─────────────────────────────────────────

const topAsn: Ferramenta = {
  nome: 'netflow_top_asn',
  fonte: 'netflow',
  descricao:
    'Para quais redes (ASN) vai ou de onde vem o tráfego: Google, Meta, Netflix, CDNs… com volume ' +
    'estimado e participação. Responde "o que está puxando o tráfego?", "o pico de hoje foi de quê?". ' +
    'Nome do ASN só aparece para os conhecidos; os demais vêm só com o número.',
  parametros: {
    type: 'object',
    properties: {
      minutos: { type: 'number', description: 'Janela até agora, em minutos (padrão 60)' },
      inicio: { type: 'string', description: 'Início em ISO 8601' },
      fim: { type: 'string', description: 'Fim em ISO 8601' },
      limite: { type: 'number', description: 'Quantos ASNs (padrão 10, máx 30)' },
    },
    required: [],
  },
  async executar(args, ctx) {
    return [await medir<Record<string, unknown>>(ctx, 'netflow', 'netflow.top_asn', args, async () => {
      const j = janelaDe(args, 60);
      await netflow.exigirColetaViva(j);
      const limite = Math.min(30, Math.max(1, Number(args.limite) || 10));
      const [lista, r] = await Promise.all([netflow.topAsn(j, limite), netflow.resumo(j)]);
      const total = estimar(r.total_bytes);
      return {
        vazio: lista.length === 0,
        dados: {
          janela: janelaInfo(j),
          amostragem: amostragem(),
          trafego_total_da_janela: formatarBytes(total),
          asns: lista.map((a) => {
            const bytes = estimar(a.total_bytes);
            return {
              asn: a.asn,
              nome: nomeAsn(a.asn),
              volume: formatarBytes(bytes),
              media: formatarMbps(mbpsMedio(bytes, j.fim - j.inicio)),
              participacao_pct: total ? Math.round((bytes / total) * 1000) / 10 : null,
            };
          }),
        },
      };
    })];
  },
};

// ─── Variação em relação ao normal ─────────────────────────────────────────

const variacao: Ferramenta = {
  nome: 'netflow_variacao',
  fonte: 'netflow',
  descricao:
    'Compara o tráfego de agora com o mesmo horário nos dias anteriores (ontem e a mediana dos ' +
    'últimos dias com dado) e mostra quais redes (ASN) mais cresceram ou caíram. Responde "o tráfego ' +
    'está normal?", "caiu em relação a ontem?", "o que mudou?". Dia sem coleta não entra na ' +
    'comparação e é dito — nunca vira "zero de tráfego".',
  parametros: {
    type: 'object',
    properties: {
      minutos: { type: 'number', description: 'Janela até agora a comparar (padrão 60, máx 1440)' },
    },
    required: [],
  },
  async executar(args, ctx) {
    return [await medir<Record<string, unknown>>(ctx, 'netflow', 'netflow.variacao', args, async () => {
      const min = Math.min(1440, Math.max(10, Number(args.minutos) || 60));
      const fim = Math.floor(Date.now() / 1000);
      const atualJ = { inicio: fim - min * 60, fim };
      await netflow.exigirColetaViva(atualJ);
      const desloc = (dias: number) => ({ inicio: atualJ.inicio - dias * 86400, fim: atualJ.fim - dias * 86400 });

      const [atual, ...refs] = await Promise.all([
        volumeDaJanela(atualJ),
        ...[1, 2, 3, 4, 5, 6].map((d) => volumeDaJanela(desloc(d))),
      ]);
      const comDado = refs.map((r, i) => ({ dias: i + 1, ...r })).filter((r) => r.fluxos > 0);
      const pct = (a: number, b: number) => (b > 0 ? Math.round(((a - b) / b) * 1000) / 10 : null);
      const ontem = comDado.find((r) => r.dias === 1) ?? null;
      const ordenados = [...comDado].map((r) => r.mbps).sort((a, b) => a - b);
      const mediana = ordenados.length ? ordenados[Math.floor((ordenados.length - 1) / 2)] : null;
      const limiar = obter<number>('monitor.netflow.variacao_pct');

      // O que mudou: ASN a ASN contra ontem.
      let mudancas: Record<string, unknown> | null = null;
      if (ontem) {
        const [aA, aO] = await Promise.all([netflow.topAsn(atualJ, 20), netflow.topAsn(desloc(1), 20)]);
        const mapa = new Map<number, { agora: number; ontem: number }>();
        for (const x of aA) mapa.set(x.asn, { agora: estimar(x.total_bytes), ontem: 0 });
        for (const x of aO) mapa.set(x.asn, { agora: mapa.get(x.asn)?.agora ?? 0, ontem: estimar(x.total_bytes) });
        const seg = atualJ.fim - atualJ.inicio;
        const lista = [...mapa.entries()].map(([asn, v]) => ({
          asn, nome: nomeAsn(asn),
          agora: formatarMbps(mbpsMedio(v.agora, seg)),
          ontem: formatarMbps(mbpsMedio(v.ontem, seg)),
          diferenca_mbps: Math.round(mbpsMedio(v.agora - v.ontem, seg)),
        }));
        mudancas = {
          observacao: 'Comparação entre os 20 maiores ASNs de cada janela; ASN fora do top 20 conta como zero naquele dia.',
          mais_cresceram: [...lista].sort((a, b) => b.diferenca_mbps - a.diferenca_mbps).slice(0, 5).filter((x) => x.diferenca_mbps > 0),
          mais_cairam: [...lista].sort((a, b) => a.diferenca_mbps - b.diferenca_mbps).slice(0, 5).filter((x) => x.diferenca_mbps < 0),
        };
      }

      const vsOntem = ontem ? pct(atual.mbps, ontem.mbps) : null;
      const vsMediana = mediana !== null ? pct(atual.mbps, mediana) : null;
      const referencia = vsOntem ?? vsMediana;
      return {
        dados: {
          janela: { inicio: iso(atualJ.inicio), fim: iso(atualJ.fim), minutos: min },
          amostragem: amostragem(),
          agora: formatarMbps(atual.mbps),
          ontem_mesmo_horario: ontem ? { media: formatarMbps(ontem.mbps), variacao_pct: vsOntem } : 'sem coleta nesse horário ontem',
          mediana_dos_dias_anteriores: mediana !== null
            ? { media: formatarMbps(mediana), dias_com_dado: comDado.length, variacao_pct: vsMediana }
            : 'nenhum dos 6 dias anteriores tem coleta nesse horário — sem base de comparação',
          dias_sem_coleta: refs.map((r, i) => ({ dias: i + 1, r })).filter((x) => x.r.fluxos === 0).map((x) => x.dias),
          leitura: referencia === null
            ? 'sem base de comparação'
            : Math.abs(referencia) >= limiar
              ? `alteração relevante (${referencia > 0 ? '+' : ''}${referencia}% — limiar configurado: ${limiar}%)`
              : `dentro do normal (variação de ${referencia}% — limiar: ${limiar}%)`,
          mudancas_por_asn: mudancas,
        },
      };
    })];
  },
};

// ─── Tráfego por link (interface do roteador exportador) ──────────────────

function nomesManuais(): Map<number, string> {
  const m = new Map<number, string>();
  for (const par of config.netflow.nomesInterfaces.split(',')) {
    const [k, ...v] = par.split('=');
    const idx = Number(k?.trim());
    if (Number.isInteger(idx) && v.length) m.set(idx, v.join('=').trim());
  }
  return m;
}

const links: Ferramenta = {
  nome: 'netflow_links',
  fonte: 'netflow',
  descricao:
    'Tráfego por LINK (interface do roteador que exporta o NetFlow): quanto entra e sai por cada ' +
    'trânsito/IX/operadora, estimado, e a série de um link específico. Responde "como está o link da ' +
    'Angola?", "quanto está passando pelo IX?", "qual link está mais cheio?". Útil quando o Zabbix não ' +
    'tem o link (o roteador exportador está com SNMP fora). Nome do link vem do cadastro do Zabbix; ' +
    'índice sem nome aparece como ifIndex.',
  parametros: {
    type: 'object',
    properties: {
      minutos: { type: 'number', description: 'Janela até agora, em minutos (padrão 60, máx 1440)' },
      interface: { type: 'string', description: 'Link para detalhar no tempo: ifIndex (ex.: 488) ou parte do nome (ex.: "angola")' },
      inicio: { type: 'string', description: 'Início em ISO 8601' },
      fim: { type: 'string', description: 'Fim em ISO 8601' },
    },
    required: [],
  },
  async executar(args, ctx) {
    return [await medir<Record<string, unknown>>(ctx, 'netflow', 'netflow.links', args, async () => {
      const j = janelaDe({ ...args, minutos: Math.min(1440, Number(args.minutos) || 60) }, 60);
      await netflow.exigirColetaViva(j);
      const pares = await netflow.trafegoPorInterface(j, 300);

      let nomes = new Map<number, { nome: string; capacidadeBps: number | null }>();
      let avisoNomes: string | null = null;
      try {
        nomes = await nomesDeInterfacePorIndice(config.netflow.zabbixHost);
      } catch (err) {
        avisoNomes = `nomes dos links indisponíveis (${err instanceof Error ? err.message : String(err)}); mostrando só o ifIndex`;
      }
      const manuais = nomesManuais();
      const nomeDe = (idx: number) => manuais.get(idx) ?? nomes.get(idx)?.nome ?? null;

      const seg = j.fim - j.inicio;
      const porIf = new Map<number, { entrada: number; saida: number; destinos: Map<number, number> }>();
      const pega = (idx: number) => {
        let x = porIf.get(idx);
        if (!x) { x = { entrada: 0, saida: 0, destinos: new Map() }; porIf.set(idx, x); }
        return x;
      };
      for (const p of pares) {
        const bytes = estimar(p.bytes);
        const ent = Number(p.in_if ?? 0);
        const sai = Number(p.out_if ?? 0);
        const e = pega(ent);
        e.entrada += bytes;
        e.destinos.set(sai, (e.destinos.get(sai) ?? 0) + bytes);
        pega(sai).saida += bytes;
      }
      const totalEntrada = [...porIf.values()].reduce((s, x) => s + x.entrada, 0);

      const lista = [...porIf.entries()]
        .sort((a, b) => Math.max(b[1].entrada, b[1].saida) - Math.max(a[1].entrada, a[1].saida))
        .map(([idx, v]) => {
          const cap = nomes.get(idx)?.capacidadeBps ?? null;
          const picoMedio = Math.max(mbpsMedio(v.entrada, seg), mbpsMedio(v.saida, seg)) * 1_000_000;
          return {
            ifindex: idx,
            link: idx === 0 ? '(fluxo sem interface informada)' : (nomeDe(idx) ?? `ifIndex ${idx} (sem nome no Zabbix)`),
            entrada: formatarMbps(mbpsMedio(v.entrada, seg)),
            saida: formatarMbps(mbpsMedio(v.saida, seg)),
            participacao_na_entrada_pct: totalEntrada ? Math.round((v.entrada / totalEntrada) * 1000) / 10 : null,
            capacidade: cap ? formatarMbps(cap / 1_000_000) : null,
            ocupacao_media_pct: cap ? Math.round((picoMedio / cap) * 1000) / 10 : null,
            para_onde_vai_o_que_entra: [...v.destinos.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
              .map(([d, b]) => ({ link: d === 0 ? '(sem interface)' : (nomeDe(d) ?? `ifIndex ${d}`), media: formatarMbps(mbpsMedio(b, seg)) })),
          };
        });

      // Detalhe no tempo de um link, se pedido.
      let detalhe: Record<string, unknown> | null = null;
      if (typeof args.interface === 'string' && args.interface.trim()) {
        const termo = args.interface.trim();
        const alvo = /^\d+$/.test(termo)
          ? Number(termo)
          : lista.find((l) => normalizarTexto(l.link).includes(normalizarTexto(termo)))?.ifindex;
        if (alvo === undefined) {
          detalhe = { erro: `nenhum link com "${termo}" no tráfego da janela`, links_disponiveis: lista.map((l) => l.link) };
        } else {
          const bucket = bucketPara(j);
          const serie = await netflow.serieDaInterface(alvo, j, bucket);
          const pontos = serie.map((p) => ({
            inicio: iso(p.bucket),
            entrada_mbps: Math.round(mbpsMedio(estimar(p.in_bytes), bucket) * 10) / 10,
            saida_mbps: Math.round(mbpsMedio(estimar(p.out_bytes), bucket) * 10) / 10,
          }));
          const pico = pontos.reduce<(typeof pontos)[number] | null>((m, p) =>
            (!m || Math.max(p.entrada_mbps, p.saida_mbps) > Math.max(m.entrada_mbps, m.saida_mbps) ? p : m), null);
          detalhe = {
            ifindex: alvo,
            link: nomeDe(alvo) ?? `ifIndex ${alvo}`,
            pico: pico ? { em: pico.inicio, entrada: formatarMbps(pico.entrada_mbps), saida: formatarMbps(pico.saida_mbps) } : null,
            intervalo_seg: bucket,
            pontos,
            sem_trafego: pontos.length === 0,
          };
        }
      }

      return {
        vazio: lista.length === 0,
        dados: {
          janela: janelaInfo(j),
          amostragem: amostragem(),
          roteador: config.netflow.zabbixHost,
          observacao: 'Entrada = tráfego que chega pelo link; saída = tráfego que sai por ele. Médias da janela, estimadas.',
          ...(avisoNomes ? { aviso: avisoNomes } : {}),
          links: lista,
          detalhe_do_link: detalhe,
        },
      };
    })];
  },
};

function normalizarTexto(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

export function registrarFerramentasNetflow(): void {
  // Sem configuração, as ferramentas nem aparecem para o modelo: oferecer
  // ferramenta que sempre falha só gera resposta "fonte indisponível" à toa.
  if (!config.netflow.enabled) return;
  ferramentas.registrar(trafego, consumoClientes, trafegoIp, ataques, topAsn, variacao, links);
}
