// Resumo diário (Bloco 9).
//
// Todo dia, no horário configurado, manda no grupo de alertas o que aconteceu
// nas 24 horas anteriores: incidentes da rede, O.S., chamadas da URA,
// atendimento e uso do assistente.
//
// SEM IA de propósito. É um relatório de contagem, e contagem se faz com SQL:
// um modelo resumindo números é a forma mais barata de errar um número. Cada
// seção vem do registro local (alertas, chamadas, consultas) ou do SGP ao vivo.
//
// "Zero não é ausência": seção cuja fonte não pôde ser lida, ou cujo monitor
// está desligado, diz isso por escrito. "0 incidentes" só aparece quando o
// monitor estava ligado e de fato não registrou nada.

import { config } from '../config';
import { db, registrarAuditoria } from './store/db';
import { obter } from './config-dinamica';
import { emitir, jaExiste, duracaoHumana, Alerta } from './alertas';
import { estadoMonitores, iniciarMonitor } from './monitors/base';
import { ROTULO_TIPO } from './monitors/zabbix';
import { sgp, osEstaAberta, SgpOrdemServico } from '../integrations/sgp';
import type { ZabbixEventoTipo } from '../integrations/zabbix';
import { diaLocal, horaLocal, rotuloData, instanteSgp } from './datas';
import { netflow, formatarMbps, mbpsMedio, estimar } from '../integrations/netflow';
import { lerSessoesOnline, casaMotivo } from './tools/relatorios';

export const SECOES = ['rede', 'trafego', 'os', 'clientes', 'ura', 'atendimento', 'assistente'] as const;
export type Secao = (typeof SECOES)[number];

/** Se o serviço estava fora no horário, ainda manda até este tanto depois. Mais que isso, o resumo "de hoje cedo" já perdeu o sentido. */
const ATRASO_MAX_MIN = 180;

type Indisponivel = { disponivel: false; motivo: string };

export interface ResumoRede {
  disponivel: true;
  novos: number;
  resolvidos: number;
  abertosAgora: number;
  porTipo: Array<{ tipo: string; n: number }>;
  maisLongoResolvido: { nome: string; duracaoSeg: number } | null;
  abertoHaMaisTempo: { nome: string; duracaoSeg: number } | null;
  aviso: string | null;
}

export interface ResumoOs {
  disponivel: true;
  cadastradas: number;
  jaFinalizadas: number;
  semHorario: number;
  principaisMotivos: Array<{ motivo: string; n: number }>;
  listaCompleta: boolean;
  emAbertoNaRede: { total: number; completa: boolean } | null;
}

export interface ResumoUra {
  disponivel: true;
  chamadas: number;
  transferidas: number;
  emAndamento: number;
  naoIdentificados: number;
  porIntencao: Array<{ intencao: string; n: number }>;
  duracaoMediaSeg: number | null;
  ultimaChamadaEm: string | null;
}

export interface ResumoAtendimento {
  disponivel: true;
  limiteMin: number;
  conversasAcimaDoLimite: number;
  avisosDeFila: number;
  aguardandoAgora: number;
  esperaMaisLongaAgoraMin: number | null;
}

export interface ResumoAssistente {
  disponivel: true;
  consultas: number;
  pessoas: number;
  porVeredito: Record<string, number>;
  porCanal: Record<string, number>;
}

export interface ResumoTrafego {
  disponivel: true;
  mediaMbps: number;
  pico: { mbps: number; em: string } | null;
  principaisAsns: Array<{ nome: string; pct: number }>;
  suspeitasCriticas: number;
  coletaAgora: boolean;
}

export interface ResumoClientes {
  disponivel: true;
  online: { agora: number; ontem: number | null } | { erro: string };
  instalacoesConcluidas: number | null;
  retiradas: number | null;
  contratosCancelados: number;
  sgpErro: string | null;
  sinalRuim: { abaixo27: number; abaixo30: number; ctos: Array<{ cto: string; n: number }>; espelhoEm: string | null };
  reincidentes: Array<{ cliente: string; contrato: number; os: number }> | null;
}

export interface Resumo {
  inicio: string;
  fim: string;
  secoes: Partial<{
    rede: ResumoRede | Indisponivel;
    trafego: ResumoTrafego | Indisponivel;
    os: ResumoOs | Indisponivel;
    clientes: ResumoClientes | Indisponivel;
    ura: ResumoUra | Indisponivel;
    atendimento: ResumoAtendimento | Indisponivel;
    assistente: ResumoAssistente | Indisponivel;
  }>;
  texto: string;
}

// ─── Tempo local ──────────────────────────────────────────────────────────────

export { diaLocal, horaLocal };

/**
 * Quando a O.S. foi cadastrada. Sem hora, devolve só o dia — quem chama decide
 * o que fazer com isso.
 */
export function cadastroDaOs(o: Pick<SgpOrdemServico, 'data_cadastro' | 'hora_cadastro'>): { instante: Date | null; dia: string | null } {
  return instanteSgp(o.data_cadastro, o.hora_cadastro);
}

function minutosDoDia(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function ranking<T>(itens: T[], chave: (x: T) => string, max: number): Array<{ k: string; n: number }> {
  const m = new Map<string, number>();
  for (const i of itens) {
    const k = chave(i);
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m.entries()].map(([k, n]) => ({ k, n })).sort((a, b) => b.n - a.n || a.k.localeCompare(b.k)).slice(0, max);
}

function erroTexto(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ─── Coleta por seção ────────────────────────────────────────────────────────

interface LinhaAlerta extends Omit<Alerta, 'dados'> { dados: string | null }

function lerDados<T>(l: LinhaAlerta): T | null {
  try { return l.dados ? JSON.parse(l.dados) as T : null; } catch { return null; }
}

export function coletarRede(inicio: Date, fim: Date): ResumoRede | Indisponivel {
  if (!config.zabbix.enabled || !obter<boolean>('monitor.zabbix.ativo')) {
    return { disponivel: false, motivo: 'monitor de incidentes desligado — nada foi registrado' };
  }
  const ini = inicio.toISOString();
  const fi = fim.toISOString();

  // Incidentes (não os avisos de resolução) que tocam a janela: começaram nela,
  // resolveram nela ou continuam abertos.
  const linhas = db().prepare(
    `SELECT * FROM alerta
     WHERE origem = 'zabbix' AND chave NOT LIKE '%:resolvido'
       AND (resolvido_em IS NULL OR resolvido_em >= ? OR criado_em >= ?)`,
  ).all(ini, ini) as LinhaAlerta[];

  type D = { nome?: string; tipo?: string; inicio?: string };
  const itens = linhas.map((l) => {
    const d = lerDados<D>(l) ?? {};
    return { l, nome: d.nome ?? l.titulo, tipo: d.tipo ?? 'outro', inicio: d.inicio ?? l.criado_em };
  });

  const novos = itens.filter((i) => i.inicio >= ini && i.inicio < fi);
  const resolvidos = itens.filter((i) => i.l.resolvido_em && i.l.resolvido_em >= ini && i.l.resolvido_em < fi);
  const abertos = itens.filter((i) => !i.l.resolvido_em);

  const dur = (de: string, ate: string) => Math.max(0, Math.round((new Date(ate).getTime() - new Date(de).getTime()) / 1000));
  const maisLongo = resolvidos
    .map((i) => ({ nome: i.nome, duracaoSeg: dur(i.inicio, i.l.resolvido_em!) }))
    .sort((a, b) => b.duracaoSeg - a.duracaoSeg)[0] ?? null;
  const abertoAntigo = abertos
    .map((i) => ({ nome: i.nome, duracaoSeg: dur(i.inicio, fi) }))
    .sort((a, b) => b.duracaoSeg - a.duracaoSeg)[0] ?? null;

  const mon = estadoMonitores().find((m) => m.nome === 'zabbix');
  return {
    disponivel: true,
    novos: novos.length,
    resolvidos: resolvidos.length,
    abertosAgora: abertos.length,
    porTipo: ranking(novos, (i) => ROTULO_TIPO[i.tipo as ZabbixEventoTipo] ?? i.tipo, 4).map((r) => ({ tipo: r.k, n: r.n })),
    maisLongoResolvido: maisLongo,
    abertoHaMaisTempo: abertoAntigo,
    // Monitor com erro agora = pode ter perdido incidentes. Os números valem, mas com ressalva.
    aviso: mon?.ultimoErro ? `a última leitura do Zabbix falhou (${mon.ultimoErro}); pode faltar incidente` : null,
  };
}

export async function coletarOs(inicio: Date, fim: Date): Promise<ResumoOs | Indisponivel> {
  let r: { ordens: SgpOrdemServico[]; janelaCompleta: boolean };
  try {
    r = await sgp.ordensServicoPorCadastro(diaLocal(inicio), diaLocal(fim));
  } catch (err) {
    return { disponivel: false, motivo: `SGP não respondeu (${erroTexto(err)})` };
  }

  let semHorario = 0;
  const diaIni = diaLocal(inicio);
  const diaFim = diaLocal(fim);
  const naJanela = r.ordens.filter((o) => {
    const c = cadastroDaOs(o);
    if (c.instante) return c.instante >= inicio && c.instante < fim;
    // Sem hora não dá para recortar as 24 h exatas: entra se o dia cai na
    // janela, e o texto avisa quantas foram contadas assim.
    if (c.dia && c.dia >= diaIni && c.dia <= diaFim) { semHorario++; return true; }
    return false;
  });

  let emAberto: ResumoOs['emAbertoNaRede'] = null;
  try {
    const a = await sgp.ordensServicoAbertas(90);
    emAberto = { total: a.abertas.length, completa: a.janelaCompleta };
  } catch {
    emAberto = null;   // a primeira parte vale sozinha; o texto omite a linha
  }

  return {
    disponivel: true,
    cadastradas: naJanela.length,
    jaFinalizadas: naJanela.filter((o) => !osEstaAberta(o)).length,
    semHorario,
    principaisMotivos: ranking(naJanela, (o) => o.motivo?.trim() || 'sem motivo informado', 3).map((x) => ({ motivo: x.k, n: x.n })),
    listaCompleta: r.janelaCompleta,
    emAbertoNaRede: emAberto,
  };
}

export function coletarUra(inicio: Date, fim: Date): ResumoUra | Indisponivel {
  if (!obter<boolean>('monitor.ura.ativo')) {
    return { disponivel: false, motivo: 'monitor da URA desligado — chamadas não foram registradas' };
  }
  const d = db();
  const ultima = (d.prepare(`SELECT MAX(iniciada_em) m FROM chamada_ura`).get() as { m: string | null }).m;
  if (!ultima) {
    return { disponivel: false, motivo: 'nenhuma chamada da URA chegou ao assistente até hoje — a ponte da URA não está instalada ou não alcança este servidor' };
  }

  const linhas = d.prepare(
    `SELECT status, intencao, cliente_nome, duracao_seg FROM chamada_ura WHERE iniciada_em >= ? AND iniciada_em < ?`,
  ).all(inicio.toISOString(), fim.toISOString()) as Array<{ status: string; intencao: string | null; cliente_nome: string | null; duracao_seg: number | null }>;

  const duracoes = linhas.map((l) => l.duracao_seg).filter((x): x is number => typeof x === 'number');
  return {
    disponivel: true,
    chamadas: linhas.length,
    transferidas: linhas.filter((l) => l.status === 'transferida').length,
    emAndamento: linhas.filter((l) => l.status === 'em_andamento').length,
    naoIdentificados: linhas.filter((l) => !l.cliente_nome).length,
    porIntencao: ranking(linhas, (l) => l.intencao ?? 'não identificada', 4).map((x) => ({ intencao: x.k, n: x.n })),
    duracaoMediaSeg: duracoes.length ? Math.round(duracoes.reduce((a, b) => a + b, 0) / duracoes.length) : null,
    ultimaChamadaEm: ultima,
  };
}

export function coletarAtendimento(inicio: Date, fim: Date): ResumoAtendimento | Indisponivel {
  if (!obter<boolean>('monitor.sla.ativo')) {
    return { disponivel: false, motivo: 'monitor de atendimento desligado' };
  }
  const d = db();
  const alertas = d.prepare(
    `SELECT * FROM alerta WHERE origem = 'sla' AND criado_em >= ? AND criado_em < ?`,
  ).all(inicio.toISOString(), fim.toISOString()) as LinhaAlerta[];

  const jids = new Set<string>();
  let avisosDeFila = 0;
  for (const a of alertas) {
    const dd = lerDados<{ jid?: string }>(a);
    if (dd?.jid) jids.add(dd.jid);
    else if (a.chave.startsWith('sla:resumo:')) avisosDeFila++;
  }

  const aguardando = d.prepare(
    `SELECT aguardando_desde FROM sla_conversa WHERE aguardando_desde IS NOT NULL`,
  ).all() as Array<{ aguardando_desde: string }>;
  const maisAntiga = aguardando.map((x) => x.aguardando_desde).sort()[0];

  return {
    disponivel: true,
    limiteMin: obter<number>('monitor.sla.minutos'),
    conversasAcimaDoLimite: jids.size,
    avisosDeFila,
    aguardandoAgora: aguardando.length,
    esperaMaisLongaAgoraMin: maisAntiga ? Math.max(0, Math.floor((fim.getTime() - new Date(maisAntiga).getTime()) / 60_000)) : null,
  };
}

export function coletarAssistente(inicio: Date, fim: Date): ResumoAssistente {
  const linhas = db().prepare(
    `SELECT usuario, canal, veredito FROM consulta WHERE at >= ? AND at < ?`,
  ).all(inicio.toISOString(), fim.toISOString()) as Array<{ usuario: string; canal: string; veredito: string }>;

  const porVeredito: Record<string, number> = {};
  const porCanal: Record<string, number> = {};
  for (const l of linhas) {
    porVeredito[l.veredito] = (porVeredito[l.veredito] ?? 0) + 1;
    porCanal[l.canal] = (porCanal[l.canal] ?? 0) + 1;
  }
  return {
    disponivel: true,
    consultas: linhas.length,
    pessoas: new Set(linhas.map((l) => l.usuario)).size,
    porVeredito,
    porCanal,
  };
}

const NOME_ASN_CURTO: Record<number, string> = {
  36040: 'YouTube', 15169: 'Google', 32934: 'Meta', 2906: 'Netflix', 40027: 'Netflix',
  20940: 'Akamai', 16509: 'Amazon', 13335: 'Cloudflare', 138699: 'TikTok', 396986: 'ByteDance',
};

export async function coletarTrafego(inicio: Date, fim: Date): Promise<ResumoTrafego | Indisponivel> {
  if (!netflow.disponivel) return { disponivel: false, motivo: 'NetFlow não configurado' };
  const j = { inicio: Math.floor(inicio.getTime() / 1000), fim: Math.floor(fim.getTime() / 1000) };
  try {
    const [r, serie, asns, ataques, frescor] = await Promise.all([
      netflow.resumo(j),
      netflow.serie(j, 300),
      netflow.topAsn(j, 4),
      netflow.ataques(j, 30),
      netflow.frescor(),
    ]);
    if (!r.total_flows) return { disponivel: false, motivo: 'NetFlow sem nenhum fluxo no período (coleta parada)' };
    const bytes = estimar(r.total_bytes);
    const pico = serie.reduce<{ mbps: number; em: string } | null>((m, p) => {
      const mbps = mbpsMedio(estimar(p.total_bytes), 300);
      return !m || mbps > m.mbps ? { mbps, em: new Date(p.bucket * 1000).toISOString() } : m;
    }, null);
    return {
      disponivel: true,
      mediaMbps: mbpsMedio(bytes, j.fim - j.inicio),
      pico,
      principaisAsns: asns.slice(0, 3).map((x) => ({
        nome: NOME_ASN_CURTO[x.asn] ?? `AS${x.asn}`,
        pct: bytes ? Math.round((estimar(x.total_bytes) / bytes) * 100) : 0,
      })),
      suspeitasCriticas: ataques.filter((x) => String(x.max_severity).toLowerCase() === 'critical').length,
      coletaAgora: frescor.viva,
    };
  } catch (err) {
    return { disponivel: false, motivo: `NetFlow não respondeu (${erroTexto(err)})` };
  }
}

export async function coletarClientes(inicio: Date, fim: Date): Promise<ResumoClientes | Indisponivel> {
  const d = db();
  let online: ResumoClientes['online'];
  try {
    const s = await lerSessoesOnline();
    const o = s.ontem_mesmo_horario as { valor?: number | null } | null;
    online = { agora: s.online_agora, ontem: o?.valor ?? null };
  } catch (err) {
    online = { erro: erroTexto(err) };
  }

  // O.S. dos últimos 30 dias: instalação/retirada nas 24 h e reincidência de suporte.
  let instalacoesConcluidas: number | null = null;
  let retiradas: number | null = null;
  let reincidentes: ResumoClientes['reincidentes'] = null;
  let sgpErro: string | null = null;
  try {
    const r = await sgp.ordensServicoPorCadastro(diaLocal(new Date(fim.getTime() - 30 * 86_400_000)), diaLocal(fim), 500, 10);
    const inst = obter<string[]>('relatorios.motivos_instalacao');
    const canc = obter<string[]>('relatorios.motivos_cancelamento');
    const naJanela = (data: unknown, hora: unknown) => {
      const x = instanteSgp(data, hora);
      if (x.instante) return x.instante >= inicio && x.instante < fim;
      return !!x.dia && x.dia >= diaLocal(inicio) && x.dia <= diaLocal(fim);
    };
    instalacoesConcluidas = r.ordens.filter((o) =>
      casaMotivo(o, inst) && !osEstaAberta(o) && naJanela(o.data_finalizacao, o.hora_finalizacao)).length;
    retiradas = r.ordens.filter((o) => casaMotivo(o, canc) && naJanela(o.data_cadastro, o.hora_cadastro)).length;
    // Reincidência: O.S. que não são instalação nem retirada (suporte, troca, config.).
    const porContrato = new Map<number, { cliente: string; n: number }>();
    for (const o of r.ordens) {
      if (casaMotivo(o, inst) || casaMotivo(o, canc) || !o.contrato) continue;
      const atual = porContrato.get(o.contrato) ?? { cliente: o.cliente, n: 0 };
      atual.n++;
      porContrato.set(o.contrato, atual);
    }
    reincidentes = [...porContrato.entries()].filter(([, v]) => v.n >= 2)
      .sort((x, y) => y[1].n - x[1].n).slice(0, 5)
      .map(([contrato, v]) => ({ cliente: v.cliente, contrato, os: v.n }));
  } catch (err) {
    sgpErro = `SGP não respondeu (${erroTexto(err)})`;
  }

  const contratosCancelados = (d.prepare(
    `SELECT COUNT(*) n FROM sgp_contrato_evento WHERE para LIKE 'Cancel%' AND detectado_em >= ? AND detectado_em < ?`,
  ).get(inicio.toISOString(), fim.toISOString()) as { n: number }).n;
  const sinal = d.prepare(
    `SELECT SUM(rx < -27) a27, SUM(rx < -30) a30, MAX(atualizado_em) em FROM sgp_servico WHERE rx IS NOT NULL`,
  ).get() as { a27: number | null; a30: number | null; em: string | null };
  const ctos = d.prepare(
    `SELECT cto_nome cto, COUNT(*) n FROM sgp_servico WHERE rx < -27 AND cto_nome IS NOT NULL
     GROUP BY cto_nome ORDER BY n DESC LIMIT 3`,
  ).all() as Array<{ cto: string; n: number }>;

  return {
    disponivel: true,
    online,
    instalacoesConcluidas,
    retiradas,
    contratosCancelados,
    sgpErro,
    sinalRuim: { abaixo27: sinal.a27 ?? 0, abaixo30: sinal.a30 ?? 0, ctos, espelhoEm: sinal.em },
    reincidentes,
  };
}

// ─── Texto ────────────────────────────────────────────────────────────────────

const plural = (n: number, um: string, varios: string) => `${n.toLocaleString('pt-BR')} ${n === 1 ? um : varios}`;
const naoDisponivel = (s: Indisponivel) => `• _${s.motivo.charAt(0).toUpperCase()}${s.motivo.slice(1)}._`;

export function formatarResumo(r: Omit<Resumo, 'texto'>): string {
  const inicio = new Date(r.inicio);
  const fim = new Date(r.fim);
  const partes: string[] = [`📋 *Resumo das últimas 24 horas*`, `${rotuloData(inicio)} → ${rotuloData(fim)}`];

  const { rede, trafego, os, clientes, ura, atendimento, assistente } = r.secoes;

  if (rede) {
    const l = ['', '*Rede (Zabbix)*'];
    if (!rede.disponivel) l.push(naoDisponivel(rede));
    else {
      l.push(`• ${plural(rede.novos, 'incidente novo', 'incidentes novos')} · ${plural(rede.resolvidos, 'resolvido', 'resolvidos')} · ${plural(rede.abertosAgora, 'aberto', 'abertos')} agora`);
      if (rede.porTipo.length) l.push(`• ${rede.porTipo.map((t) => `${t.tipo} ${t.n}`).join(' · ')}`);
      if (rede.maisLongoResolvido) l.push(`• Mais longo resolvido: ${rede.maisLongoResolvido.nome} (${duracaoHumana(rede.maisLongoResolvido.duracaoSeg)})`);
      if (rede.abertoHaMaisTempo) l.push(`• Aberto há mais tempo: ${rede.abertoHaMaisTempo.nome} (${duracaoHumana(rede.abertoHaMaisTempo.duracaoSeg)})`);
      if (rede.aviso) l.push(`• ⚠️ _Atenção: ${rede.aviso}._`);
    }
    partes.push(...l);
  }

  if (trafego) {
    const l = ['', '*Tráfego (NetFlow, estimado)*'];
    if (!trafego.disponivel) l.push(naoDisponivel(trafego));
    else {
      const pico = trafego.pico ? ` · pico ${formatarMbps(trafego.pico.mbps)} às ${horaLocal(new Date(trafego.pico.em))}` : '';
      l.push(`• Média ${formatarMbps(trafego.mediaMbps)}${pico}`);
      if (trafego.principaisAsns.length) l.push(`• ${trafego.principaisAsns.map((x) => `${x.nome} ${x.pct}%`).join(' · ')}`);
      if (trafego.suspeitasCriticas) {
        l.push(`• ⚠️ ${plural(trafego.suspeitasCriticas, 'suspeita crítica', 'suspeitas críticas')} de ataque (Flow Guard)`);
      }
      if (!trafego.coletaAgora) l.push('• ⚠️ _Coleta do NetFlow parada agora._');
    }
    partes.push(...l);
  }

  if (os) {
    const l = ['', '*Ordens de serviço (SGP)*'];
    if (!os.disponivel) l.push(naoDisponivel(os));
    else {
      const parcial = os.listaCompleta ? '' : ' (lista cortada pelo limite de consulta — o número real é maior)';
      l.push(`• ${plural(os.cadastradas, 'aberta', 'abertas')} no período${parcial}, ${plural(os.jaFinalizadas, 'já finalizada', 'já finalizadas')}`);
      if (os.principaisMotivos.length) l.push(`• ${os.principaisMotivos.map((m) => `${m.motivo} ${m.n}`).join(' · ')}`);
      if (os.semHorario) l.push(`• _${plural(os.semHorario, 'O.S. veio', 'O.S. vieram')} sem horário e ${os.semHorario === 1 ? 'foi contada' : 'foram contadas'} pelo dia._`);
      if (os.emAbertoNaRede) {
        l.push(`• Em aberto na operação: ${os.emAbertoNaRede.total.toLocaleString('pt-BR')}${os.emAbertoNaRede.completa ? '' : ' ou mais'} (cadastradas nos últimos 90 dias)`);
      }
    }
    partes.push(...l);
  }

  if (clientes) {
    const l = ['', '*Clientes*'];
    if (!clientes.disponivel) l.push(naoDisponivel(clientes));
    else {
      const on = clientes.online;
      if ('erro' in on) {
        l.push(`• _Online agora: sem dado (${on.erro})._`);
      } else {
        const ontem = on.ontem !== null ? ` (ontem neste horário: ${on.ontem.toLocaleString('pt-BR')})` : '';
        l.push(`• Online agora: ${on.agora.toLocaleString('pt-BR')}${ontem}`);
      }
      if (clientes.sgpErro) {
        l.push(`• _Instalações e retiradas: ${clientes.sgpErro}._`);
      } else {
        l.push(`• ${plural(clientes.instalacoesConcluidas ?? 0, 'instalação concluída', 'instalações concluídas')} · ${plural(clientes.retiradas ?? 0, 'O.S. de retirada', 'O.S. de retirada')}`);
      }
      if (clientes.contratosCancelados) {
        l.push(`• ${plural(clientes.contratosCancelados, 'contrato passou', 'contratos passaram')} a Cancelado no cadastro`);
      }
      const s = clientes.sinalRuim;
      if (s.abaixo27) {
        const ctos = s.ctos.length ? ` — ${s.ctos.map((c) => `${c.cto} (${c.n})`).join(', ')}` : '';
        l.push(`• Sinal ruim no cadastro: ${s.abaixo27} abaixo de -27 dBm (${s.abaixo30} abaixo de -30)${ctos}`);
      }
      if (clientes.reincidentes?.length) {
        l.push(`• Reincidência (2+ O.S. em 30 dias): ${clientes.reincidentes.map((c) => `${c.cliente} (${c.os})`).join(', ')}`);
      }
    }
    partes.push(...l);
  }

  if (ura) {
    const l = ['', '*URA*'];
    if (!ura.disponivel) l.push(naoDisponivel(ura));
    else if (!ura.chamadas) {
      l.push(`• Nenhuma chamada no período. Última recebida: ${rotuloData(new Date(ura.ultimaChamadaEm!))}`);
    } else {
      const media = ura.duracaoMediaSeg !== null ? ` · duração média ${duracaoHumana(ura.duracaoMediaSeg)}` : '';
      l.push(`• ${plural(ura.chamadas, 'chamada', 'chamadas')} · ${plural(ura.transferidas, 'transferida', 'transferidas')} para atendente${media}`);
      l.push(`• ${ura.porIntencao.map((i) => `${i.intencao} ${i.n}`).join(' · ')}`);
      if (ura.naoIdentificados) l.push(`• ${plural(ura.naoIdentificados, 'cliente não identificado', 'clientes não identificados')}`);
      if (ura.emAndamento) l.push(`• _${plural(ura.emAndamento, 'chamada sem', 'chamadas sem')} registro de fim_`);
    }
    partes.push(...l);
  }

  if (atendimento) {
    const l = ['', '*Atendimento WhatsApp*'];
    if (!atendimento.disponivel) l.push(naoDisponivel(atendimento));
    else {
      l.push(`• ${plural(atendimento.conversasAcimaDoLimite, 'conversa passou', 'conversas passaram')} de ${atendimento.limiteMin} min sem resposta`);
      if (atendimento.avisosDeFila) l.push(`• ${plural(atendimento.avisosDeFila, 'aviso', 'avisos')} de fila cheia (conversas agrupadas, não contadas acima)`);
      l.push(atendimento.aguardandoAgora
        ? `• Aguardando resposta agora: ${atendimento.aguardandoAgora} (a mais antiga há ${atendimento.esperaMaisLongaAgoraMin} min)`
        : '• Nenhuma conversa aguardando resposta agora');
    }
    partes.push(...l);
  }

  if (assistente) {
    const l = ['', '*Assistente*'];
    if (!assistente.disponivel) l.push(naoDisponivel(assistente));
    else if (!assistente.consultas) l.push('• Nenhuma consulta no período');
    else {
      const v = assistente.porVeredito;
      const vereditos = [
        v.CONFIRMADO ? plural(v.CONFIRMADO, 'confirmada', 'confirmadas') : null,
        v.PROVAVEL ? plural(v.PROVAVEL, 'provável', 'prováveis') : null,
        v.INCONCLUSIVO ? plural(v.INCONCLUSIVO, 'inconclusiva', 'inconclusivas') : null,
      ].filter(Boolean).join(' · ');
      l.push(`• ${plural(assistente.consultas, 'consulta', 'consultas')} de ${plural(assistente.pessoas, 'pessoa', 'pessoas')}`);
      if (vereditos) l.push(`• ${vereditos}`);
    }
    partes.push(...l);
  }

  return partes.join('\n');
}

// ─── Montagem e envio ────────────────────────────────────────────────────────

export async function montarResumo(fim = new Date(), secoes: readonly string[] = obter<string[]>('resumo.secoes')): Promise<Resumo> {
  const inicio = new Date(fim.getTime() - 24 * 3600_000);
  const quer = new Set(secoes);
  const base: Omit<Resumo, 'texto'> = { inicio: inicio.toISOString(), fim: fim.toISOString(), secoes: {} };

  // Seções locais não podem derrubar o resumo inteiro: erro vira "indisponível" na seção.
  const seguro = <T>(f: () => T): T | Indisponivel => {
    try { return f(); } catch (err) { return { disponivel: false, motivo: `erro ao ler o registro local (${erroTexto(err)})` }; }
  };

  if (quer.has('rede')) base.secoes.rede = seguro(() => coletarRede(inicio, fim));
  if (quer.has('trafego')) base.secoes.trafego = await coletarTrafego(inicio, fim);
  if (quer.has('os')) base.secoes.os = await coletarOs(inicio, fim);
  if (quer.has('clientes')) {
    base.secoes.clientes = await coletarClientes(inicio, fim)
      .catch((err): Indisponivel => ({ disponivel: false, motivo: `erro ao montar a seção (${erroTexto(err)})` }));
  }
  if (quer.has('ura')) base.secoes.ura = seguro(() => coletarUra(inicio, fim));
  if (quer.has('atendimento')) base.secoes.atendimento = seguro(() => coletarAtendimento(inicio, fim));
  if (quer.has('assistente')) base.secoes.assistente = seguro(() => coletarAssistente(inicio, fim));

  return { ...base, texto: formatarResumo(base) };
}

export async function enviarResumo(p: { chave: string; fim?: Date }): Promise<Alerta | null> {
  const r = await montarResumo(p.fim);
  return emitir({
    origem: 'sistema',
    severidade: 'info',
    titulo: 'Resumo das últimas 24 horas',
    texto: r.texto,
    chave: p.chave,
    dados: { inicio: r.inicio, fim: r.fim, secoes: r.secoes },
    evento: true,
  });
}

/** Envio pedido no painel. Chave própria: não conta como o resumo do dia, que continua saindo no horário. */
export async function enviarResumoManual(autor: string): Promise<Alerta | null> {
  const agora = new Date();
  registrarAuditoria(autor, 'resumo.enviar', 'resumo diário');
  return enviarResumo({ chave: `resumo:manual:${agora.toISOString()}`, fim: agora });
}

/**
 * Decide se é hora de mandar o resumo do dia. Separado do monitor para ser
 * testável sem esperar o relógio.
 */
export function situacaoDoDia(agora: Date, hora: string): { enviar: boolean; chave: string; motivo: string } {
  const chave = `resumo:${diaLocal(agora)}`;
  if (!hora) return { enviar: false, chave, motivo: 'sem horário configurado' };
  const passados = minutosDoDia(horaLocal(agora)) - minutosDoDia(hora);
  if (passados < 0) return { enviar: false, chave, motivo: `agendado para ${hora}` };
  if (jaExiste(chave)) return { enviar: false, chave, motivo: `resumo de hoje já registrado; próximo amanhã às ${hora}` };
  if (passados > ATRASO_MAX_MIN) {
    return { enviar: false, chave, motivo: `o horário de hoje (${hora}) passou há mais de ${ATRASO_MAX_MIN / 60} h sem envio; próximo amanhã às ${hora}` };
  }
  return { enviar: true, chave, motivo: passados ? `atrasado ${passados} min (não rodou no horário)` : 'no horário' };
}

export function iniciarMonitorResumo(): () => void {
  return iniciarMonitor({
    nome: 'resumo_diario',
    descricao: 'Resumo das últimas 24 horas no grupo de alertas',
    ativo: () => obter<boolean>('resumo.ativo'),
    // Acorda a cada minuto só para comparar o relógio; o trabalho sai uma vez por dia.
    intervaloSeg: () => 60,
    async ciclo() {
      const agora = new Date();
      const s = situacaoDoDia(agora, obter<string>('resumo.hora'));
      if (!s.enviar) return { alertas: 0, detalhe: { situacao: s.motivo } };

      const a = await enviarResumo({ chave: s.chave, fim: agora });
      return {
        alertas: a ? 1 : 0,
        detalhe: {
          situacao: a ? `resumo de hoje gerado (${s.motivo})` : 'resumo de hoje já registrado',
          envio: a ? (a.enviado_em ? 'enviado ao grupo' : `não enviado: ${a.envio_erro}`) : null,
        },
      };
    },
  });
}
