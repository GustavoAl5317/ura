// Métricas do Zabbix: disponibilidade, itens, histórico e tráfego (Bloco 2).
//
// A regra central deste arquivo: ZERO NÃO É AUSÊNCIA. Um item com lastvalue 0
// pode ser "tráfego zero agora" ou "nunca coletou" — no Zabbix de produção há
// 247 itens de tráfego sem coleta nenhuma, todos exibindo 0. Todo valor sai
// daqui acompanhado de `coleta`: viva, atrasada ou inexistente. Quem responde
// "o link está parado" em cima de coleta inexistente está inventando.
//
// Outras armadilhas deste Zabbix, verificadas:
// - Itens de VELOCIDADE (capacidade da porta) também usam unidade bps. Somar
//   com tráfego faz uma porta de 80 Gbps parecer transportar 80 Gbps.
// - As portas GPON da OLT-3 têm macro não resolvida no NOME
//   ("Tráfego de Entrada na Interface $1 -"); a porta real só está na CHAVE
//   (ifHCInOctets[GPON 0/0/0]).
// - Tráfego por ONU só existe na OLT-3 (3.682 itens). OLT-1 e OLT-2: nenhum.

import { zabbix } from './zabbix';

export type EstadoColeta = 'viva' | 'atrasada' | 'sem_coleta';

export interface ItemMetrica {
  itemid: string;
  hostid: string;
  host: string;
  nome: string;
  chave: string;
  unidade: string;
  valor: string | null;
  valorNumerico: number | null;
  valorFormatado: string | null;
  coleta: EstadoColeta;
  coletadoEm: string | null;
  idadeSeg: number | null;
  valueType: number;
}

interface ItemBruto {
  itemid: string;
  hostid: string;
  name: string;
  key_: string;
  units: string;
  lastvalue: string;
  lastclock: string;
  delay: string;
  value_type: string;
  hosts?: Array<{ hostid: string; name: string }>;
}

const SAIDA_ITEM = ['itemid', 'hostid', 'name', 'key_', 'units', 'lastvalue', 'lastclock', 'delay', 'value_type'];

/** "1m", "300", "5m;50/1-5,09:00-18:00", "{$DELAY}" → segundos (padrão 5 min). */
function delaySeg(delay: string): number {
  const base = (delay || '').split(';')[0].trim();
  const m = base.match(/^(\d+)([smhdw]?)$/);
  if (!m) return 300;
  const n = parseInt(m[1], 10);
  const mult: Record<string, number> = { '': 1, s: 1, m: 60, h: 3600, d: 86400, w: 604800 };
  return n * (mult[m[2]] ?? 1) || 300;
}

export function formatarValor(v: number, unidade: string): string {
  const u = unidade || '';
  if (u === 'bps' || u === 'Bps' || u === 'B') {
    const base = u === 'B' ? 1024 : 1000;
    const nomes = u === 'B' ? ['B', 'KB', 'MB', 'GB', 'TB'] : [u, `K${u}`, `M${u}`, `G${u}`, `T${u}`];
    let x = Math.abs(v);
    let i = 0;
    while (x >= base && i < nomes.length - 1) { x /= base; i++; }
    return `${(Math.sign(v) * x).toFixed(i ? 2 : 0)} ${nomes[i]}`;
  }
  if (u === '%') return `${v.toFixed(1)}%`;
  if (u === 's') return v < 1 ? `${(v * 1000).toFixed(1)} ms` : `${v.toFixed(2)} s`;
  if (u === 'uptime' || u === 'unixtime') return String(v);
  return `${Number.isInteger(v) ? v : v.toFixed(2)}${u ? ` ${u}` : ''}`;
}

function paraMetrica(i: ItemBruto): ItemMetrica {
  const agora = Date.now() / 1000;
  const lc = parseInt(i.lastclock || '0', 10);
  const idade = lc ? Math.round(agora - lc) : null;
  const limite = Math.max(3 * delaySeg(i.delay), 600);

  let coleta: EstadoColeta = 'sem_coleta';
  if (lc) coleta = idade! <= limite ? 'viva' : 'atrasada';

  const n = coleta === 'sem_coleta' ? null : parseFloat(i.lastvalue);
  const numerico = n !== null && Number.isFinite(n) ? n : null;

  return {
    itemid: i.itemid,
    hostid: i.hostid,
    host: i.hosts?.[0]?.name ?? '',
    nome: i.name,
    chave: i.key_,
    unidade: i.units || '',
    // Sem coleta NÃO devolve o lastvalue: o "0" dali é enchimento, não medição.
    valor: coleta === 'sem_coleta' ? null : i.lastvalue,
    valorNumerico: numerico,
    valorFormatado: numerico === null ? null : formatarValor(numerico, i.units),
    coleta,
    coletadoEm: lc ? new Date(lc * 1000).toISOString() : null,
    idadeSeg: idade,
    valueType: parseInt(i.value_type, 10),
  };
}

// ─── Hosts e disponibilidade ────────────────────────────────────────────────

export type Disponibilidade = 'disponivel' | 'indisponivel' | 'desconhecida';

export interface StatusHost {
  hostid: string;
  nome: string;
  habilitado: boolean;
  emManutencao: boolean;
  disponibilidade: Disponibilidade;
  erroInterface: string | null;
  problemasAbertos: number;
  piorSeveridade: number | null;
}

export async function statusHosts(filtroNome?: string): Promise<StatusHost[]> {
  const params: Record<string, unknown> = {
    output: ['hostid', 'name', 'status', 'maintenance_status'],
    selectInterfaces: ['type', 'available', 'error'],
  };
  if (filtroNome) params.search = { name: filtroNome };

  const hosts = await zabbix.api<Array<{
    hostid: string; name: string; status: string; maintenance_status: string;
    interfaces?: Array<{ type: string; available: string; error: string }>;
  }>>('host.get', params) ?? [];

  if (!hosts.length) return [];

  const problemas = await zabbix.api<Array<{ objectid: string; severity: string }>>('problem.get', {
    output: ['objectid', 'severity'],
    hostids: hosts.map((h) => h.hostid),
    suppressed: false,
  }) ?? [];

  // problem.get não devolve host; resolve pelo trigger.
  const porHost = new Map<string, { n: number; pior: number }>();
  if (problemas.length) {
    const trigs = await zabbix.api<Array<{ triggerid: string; hosts?: Array<{ hostid: string }> }>>('trigger.get', {
      output: ['triggerid'],
      triggerids: [...new Set(problemas.map((p) => p.objectid))],
      selectHosts: ['hostid'],
    }) ?? [];
    const hostDoTrigger = new Map(trigs.map((t) => [t.triggerid, t.hosts?.[0]?.hostid]));
    for (const p of problemas) {
      const hid = hostDoTrigger.get(p.objectid);
      if (!hid) continue;
      const atual = porHost.get(hid) ?? { n: 0, pior: 0 };
      atual.n++;
      atual.pior = Math.max(atual.pior, parseInt(p.severity, 10) || 0);
      porHost.set(hid, atual);
    }
  }

  return hosts.map((h) => {
    const ifs = h.interfaces ?? [];
    // available: 0 desconhecido, 1 disponível, 2 indisponível. Qualquer
    // interface indisponível torna o host indisponível — é a que falhou.
    let disponibilidade: Disponibilidade = 'desconhecida';
    if (ifs.some((i) => i.available === '2')) disponibilidade = 'indisponivel';
    else if (ifs.some((i) => i.available === '1')) disponibilidade = 'disponivel';

    const p = porHost.get(h.hostid);
    return {
      hostid: h.hostid,
      nome: h.name,
      habilitado: h.status === '0',
      emManutencao: h.maintenance_status === '1',
      disponibilidade,
      erroInterface: ifs.find((i) => i.error)?.error || null,
      problemasAbertos: p?.n ?? 0,
      piorSeveridade: p ? p.pior : null,
    };
  });
}

// ─── Itens ──────────────────────────────────────────────────────────────────

export async function buscarItens(opts: {
  host?: string;
  nome?: string;
  chave?: string;
  unidade?: string;
  limite?: number;
}): Promise<ItemMetrica[]> {
  const params: Record<string, unknown> = {
    output: SAIDA_ITEM,
    selectHosts: ['hostid', 'name'],
    limit: Math.min(opts.limite ?? 50, 5000),
    sortfield: 'name',
  };
  const search: Record<string, string> = {};
  if (opts.nome) search.name = opts.nome;
  if (opts.chave) search.key_ = opts.chave;
  if (Object.keys(search).length) params.search = search;
  if (opts.unidade) params.filter = { units: opts.unidade };

  if (opts.host) {
    const hs = await zabbix.api<Array<{ hostid: string }>>('host.get', {
      output: ['hostid'],
      search: { name: opts.host },
    }) ?? [];
    if (!hs.length) return [];
    params.hostids = hs.map((h) => h.hostid);
  }

  const itens = await zabbix.api<ItemBruto[]>('item.get', params) ?? [];
  return itens.map(paraMetrica);
}

export interface ResumoSerie {
  itemid: string;
  janelaHoras: number;
  origem: 'historico' | 'tendencia';
  amostras: number;
  minimo: number | null;
  maximo: number | null;
  media: number | null;
  primeiro: number | null;
  ultimo: number | null;
  /** Variação % entre o primeiro e o último quarto da janela. */
  tendenciaPct: number | null;
  inicio: string | null;
  fim: string | null;
}

/**
 * Resume a série em números, não em pontos. Mandar mil amostras ao modelo
 * estoura contexto e ele passa a "ler" o gráfico de cabeça. Até 48 h usa
 * history.get (resolução nativa); acima, trend.get (agregado horário).
 */
export async function resumoSerie(item: Pick<ItemMetrica, 'itemid' | 'valueType'>, horas: number): Promise<ResumoSerie> {
  const desde = Math.floor(Date.now() / 1000) - horas * 3600;
  const numerico = item.valueType === 0 || item.valueType === 3;
  const vazio: ResumoSerie = {
    itemid: item.itemid, janelaHoras: horas, origem: 'historico', amostras: 0,
    minimo: null, maximo: null, media: null, primeiro: null, ultimo: null,
    tendenciaPct: null, inicio: null, fim: null,
  };
  if (!numerico) return vazio;

  let pontos: Array<{ t: number; min: number; max: number; avg: number }> = [];
  let origem: ResumoSerie['origem'] = 'historico';

  if (horas <= 48) {
    const h = await zabbix.api<Array<{ clock: string; value: string }>>('history.get', {
      output: ['clock', 'value'],
      history: item.valueType,
      itemids: [item.itemid],
      time_from: desde,
      sortfield: 'clock',
      sortorder: 'ASC',
      limit: 20000,
    }) ?? [];
    pontos = h.map((p) => {
      const v = parseFloat(p.value);
      return { t: parseInt(p.clock, 10), min: v, max: v, avg: v };
    }).filter((p) => Number.isFinite(p.avg));
  } else {
    origem = 'tendencia';
    const t = await zabbix.api<Array<{ clock: string; value_min: string; value_avg: string; value_max: string }>>('trend.get', {
      output: ['clock', 'value_min', 'value_avg', 'value_max'],
      itemids: [item.itemid],
      time_from: desde,
      limit: 20000,
    }) ?? [];
    pontos = t.map((p) => ({
      t: parseInt(p.clock, 10),
      min: parseFloat(p.value_min),
      max: parseFloat(p.value_max),
      avg: parseFloat(p.value_avg),
    })).filter((p) => Number.isFinite(p.avg)).sort((a, b) => a.t - b.t);
  }

  if (!pontos.length) return { ...vazio, origem };

  const quarto = Math.max(1, Math.floor(pontos.length / 4));
  const mediaDe = (xs: typeof pontos) => xs.reduce((a, p) => a + p.avg, 0) / xs.length;
  const ini = mediaDe(pontos.slice(0, quarto));
  const fim = mediaDe(pontos.slice(-quarto));

  return {
    itemid: item.itemid,
    janelaHoras: horas,
    origem,
    amostras: pontos.length,
    minimo: Math.min(...pontos.map((p) => p.min)),
    maximo: Math.max(...pontos.map((p) => p.max)),
    media: mediaDe(pontos),
    primeiro: pontos[0].avg,
    ultimo: pontos[pontos.length - 1].avg,
    tendenciaPct: ini ? ((fim - ini) / Math.abs(ini)) * 100 : null,
    inicio: new Date(pontos[0].t * 1000).toISOString(),
    fim: new Date(pontos[pontos.length - 1].t * 1000).toISOString(),
  };
}

// ─── Tráfego por interface ──────────────────────────────────────────────────

export type Sentido = 'entrada' | 'saida' | 'velocidade';

export interface Interface {
  host: string;
  hostid: string;
  interface: string;
  entrada: ItemMetrica | null;
  saida: ItemMetrica | null;
  velocidade: ItemMetrica | null;
  /** Maior sentido ÷ capacidade. Null se faltar capacidade ou coleta viva. */
  utilizacaoPct: number | null;
}

/** Classifica o item pelo nome. null = não é tráfego (erro, pacote, óptico, status). */
export function sentidoDoItem(nome: string): Sentido | null {
  if (/erro|pacote|packet|m[oó]dulo [oó]ptico|status|temperatura|corrente|descart|discard/i.test(nome)) return null;
  if (/velocidade|speed/i.test(nome)) return 'velocidade';
  if (/entrada|banda rx|\brx\b|incoming|received|in bound|inbound/i.test(nome)) return 'entrada';
  if (/sa[ií]da|banda tx|\btx\b|outgoing|sent|outbound/i.test(nome)) return 'saida';
  return null;
}

/**
 * Identidade da interface. Prefere a CHAVE quando ela traz a porta entre
 * colchetes — nas portas GPON da OLT-3 o nome tem "$1" não resolvido e só a
 * chave diz qual é a porta. Chave com vírgula (itens de ONU) não serve.
 */
export function interfaceDoItem(nome: string, chave: string): string {
  const colchete = chave.match(/\[([^\]]+)\]/)?.[1];
  if (colchete && !colchete.includes(',')) return colchete.trim();
  const m = nome.match(/interface\s+(.+?)(?:\s+-\s|:\s|\s*$)/i);
  return (m?.[1] ?? nome).trim();
}

export async function interfaces(opts: { host?: string; limite?: number } = {}): Promise<Interface[]> {
  const itens = await buscarItens({ host: opts.host, unidade: 'bps', limite: 10000 });

  const mapa = new Map<string, Interface>();
  for (const it of itens) {
    if (/ONU GPON/i.test(it.nome)) continue;   // ONU tem ferramenta própria
    const sentido = sentidoDoItem(it.nome);
    if (!sentido) continue;
    const nomeIf = interfaceDoItem(it.nome, it.chave);
    const k = `${it.hostid}|${nomeIf.toLowerCase()}`;
    const atual = mapa.get(k) ?? {
      host: it.host, hostid: it.hostid, interface: nomeIf,
      entrada: null, saida: null, velocidade: null, utilizacaoPct: null,
    };
    atual[sentido] = it;
    mapa.set(k, atual);
  }

  const lista = [...mapa.values()].filter((i) => i.entrada || i.saida);
  for (const i of lista) {
    const cap = i.velocidade?.coleta === 'viva' ? i.velocidade.valorNumerico : null;
    const vivos = [i.entrada, i.saida]
      .filter((x): x is ItemMetrica => !!x && x.coleta === 'viva' && x.valorNumerico !== null)
      .map((x) => x.valorNumerico!);
    i.utilizacaoPct = cap && cap > 0 && vivos.length ? (Math.max(...vivos) / cap) * 100 : null;
  }
  return lista;
}

/** Maior tráfego vivo da interface (entrada ou saída). -1 quando não há coleta viva. */
export function picoVivo(i: Interface): number {
  const vivos = [i.entrada, i.saida]
    .filter((x): x is ItemMetrica => !!x && x.coleta === 'viva' && x.valorNumerico !== null)
    .map((x) => x.valorNumerico!);
  return vivos.length ? Math.max(...vivos) : -1;
}

// ─── ONU ────────────────────────────────────────────────────────────────────
//
// Na OLT-3 cada ONU tem 4 itens (918 ONUs em produção):
//   Tráfego de Entrada na ONU GPON 0/1/3 - ZTEGC4B2B676 - 1019 - pauloe   (download, bps)
//   Tráfego de Saída    ...                                                (upload, bps)
//   Potência Recebida   ...                                                (RX, dBm)
//   Potência Transmitida ...                                               (TX, dBm)
// Alguns SN chegam corrompidos no nome ("ZNTS,S )") e há ONU sem descrição
// ("ONT_NO_DESCRIPTION") — o parser aceita os dois e marca, em vez de descartar.

export type MetricaOnu = 'download' | 'upload' | 'sinal_rx' | 'sinal_tx';

export interface NomeOnu {
  portaGpon: string | null;
  sn: string | null;
  snValido: boolean;
  login: string | null;
  metrica: MetricaOnu | null;
}

// 12 caracteres alfanuméricos. Cobre o formato fabricante+hex (FHTT0001147A) e
// o serial numérico de alguns modelos (200935026009). Os corrompidos têm vírgula
// ou espaço ("ZNTS,S )") e caem fora.
const SN_VALIDO = /^[A-Za-z0-9]{12}$/;

export function lerNomeOnu(nome: string): NomeOnu {
  const m = nome.match(/^(.*?)\s+na ONU GPON\s+(\d+\/\d+\/\d+)\s+-\s+(.+?)\s+-\s+(?:\d+\s+-\s+)?(.+?)\s*$/i);
  if (!m) return { portaGpon: null, sn: null, snValido: false, login: null, metrica: null };

  const prefixo = m[1];
  let metrica: MetricaOnu | null = null;
  if (/tr[aá]fego de entrada/i.test(prefixo)) metrica = 'download';
  else if (/tr[aá]fego de sa[ií]da/i.test(prefixo)) metrica = 'upload';
  else if (/pot[eê]ncia recebida/i.test(prefixo)) metrica = 'sinal_rx';
  else if (/pot[eê]ncia transmitida/i.test(prefixo)) metrica = 'sinal_tx';

  const sn = m[3].trim();
  const login = m[4].trim();
  return {
    portaGpon: m[2],
    sn,
    snValido: SN_VALIDO.test(sn),
    login: /^ONT_NO_DESCRIPTION$/i.test(login) ? null : login,
    metrica,
  };
}

export interface Onu {
  host: string;
  portaGpon: string;
  sn: string;
  snValido: boolean;
  login: string | null;
  download: ItemMetrica | null;
  upload: ItemMetrica | null;
  sinalRx: ItemMetrica | null;
  sinalTx: ItemMetrica | null;
  /** Leitura derivada, com o motivo — nunca um booleano sem explicação. */
  situacao: 'online' | 'sem_luz' | 'sem_dado';
  motivo: string;
}

/**
 * Sem luz: RX sem coleta viva, abaixo de -35 dBm, ou valor absurdo (a OLT
 * devolve sentinelas enormes para ONU desconectada). "sem_dado" é quando nem
 * o item de RX existe — aí não dá para afirmar nada.
 */
function situacaoOnu(o: Pick<Onu, 'sinalRx' | 'download'>): { situacao: Onu['situacao']; motivo: string } {
  const rx = o.sinalRx;
  if (!rx) return { situacao: 'sem_dado', motivo: 'ONU sem item de potência recebida no Zabbix' };
  if (rx.coleta === 'sem_coleta') return { situacao: 'sem_luz', motivo: 'potência recebida nunca coletada' };
  if (rx.coleta === 'atrasada') return { situacao: 'sem_luz', motivo: `potência recebida sem atualização há ${Math.round((rx.idadeSeg ?? 0) / 60)} min` };
  const v = rx.valorNumerico;
  if (v === null || Math.abs(v) > 100) return { situacao: 'sem_luz', motivo: `leitura inválida de potência (${rx.valor})` };
  if (v <= -35) return { situacao: 'sem_luz', motivo: `potência recebida ${v} dBm (sem luz)` };
  return { situacao: 'online', motivo: `potência recebida ${v} dBm` };
}

function agruparOnus(itens: ItemMetrica[]): Onu[] {
  const mapa = new Map<string, Onu>();
  for (const it of itens) {
    const n = lerNomeOnu(it.nome);
    if (!n.portaGpon || !n.sn || !n.metrica) continue;
    const k = `${it.hostid}|${n.portaGpon}|${n.sn}`;
    const o = mapa.get(k) ?? {
      host: it.host, portaGpon: n.portaGpon, sn: n.sn, snValido: n.snValido, login: n.login,
      download: null, upload: null, sinalRx: null, sinalTx: null,
      situacao: 'sem_dado' as const, motivo: '',
    };
    if (n.metrica === 'download') o.download = it;
    if (n.metrica === 'upload') o.upload = it;
    if (n.metrica === 'sinal_rx') o.sinalRx = it;
    if (n.metrica === 'sinal_tx') o.sinalTx = it;
    if (!o.login && n.login) o.login = n.login;
    mapa.set(k, o);
  }
  return [...mapa.values()].map((o) => ({ ...o, ...situacaoOnu(o) }));
}

/** ONU por SN ou login. Só existe para ONUs da OLT-3 — OLT-1 e OLT-2 não têm esses itens. */
export async function onuPorTermo(termo: string): Promise<Onu[]> {
  const t = termo.trim();
  if (t.length < 3) return [];
  const itens = await buscarItens({ nome: t, limite: 40 });
  const alvo = t.toLowerCase();
  return agruparOnus(itens.filter((i) => /na ONU GPON/i.test(i.nome)))
    .filter((o) => o.sn.toLowerCase() === alvo || o.login?.toLowerCase() === alvo);
}

/** Todas as ONUs monitoradas numa porta GPON de um host. */
export async function onusDaPorta(host: string, porta: string): Promise<Onu[]> {
  const itens = await buscarItens({ host, nome: `na ONU GPON ${porta} -`, limite: 1000 });
  return agruparOnus(itens).filter((o) => o.portaGpon === porta);
}

// ─── Portas GPON e totais da OLT ───────────────────────────────────────────

export interface PortaGpon {
  host: string;
  porta: string;
  /** ifOperStatus: 1 up, 2 down, 7 lowerLayerDown. */
  status: 'up' | 'down' | 'desconhecido';
  item: ItemMetrica;
}

export async function portasGpon(host: string): Promise<PortaGpon[]> {
  const itens = await buscarItens({ host, chave: 'ifOperStatus[GPON', limite: 500 });
  return itens.map((item) => {
    const porta = item.chave.match(/GPON\s+(\d+\/\d+\/\d+)/i)?.[1] ?? item.chave;
    let status: PortaGpon['status'] = 'desconhecido';
    if (item.coleta === 'viva') {
      if (item.valorNumerico === 1) status = 'up';
      else if (item.valorNumerico === 2 || item.valorNumerico === 7) status = 'down';
    }
    return { host: item.host, porta, status, item };
  });
}

export interface TotaisOlt {
  host: string;
  itens: Record<string, ItemMetrica>;
}

/** "Total de ONUs Online/Offline/Autorizadas/Sinal Bom..." — contagem viva da OLT. */
export async function totaisOlt(host: string): Promise<TotaisOlt | null> {
  const itens = await buscarItens({ host, nome: 'Total de ONUs', limite: 50 });
  if (!itens.length) return null;
  return {
    host: itens[0].host,
    itens: Object.fromEntries(itens.map((i) => [i.nome, i])),
  };
}
