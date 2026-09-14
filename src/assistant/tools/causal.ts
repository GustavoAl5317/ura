// Raciocínio causal (Bloco 3 — fecha o Projeto 2).
//
// "Por que a PON 0/1/8 da OLT-3 está fora?" não se responde com uma consulta.
// Responde-se cruzando quatro fontes:
//   Zabbix  → estado da porta, quais ONUs estão nela (pelo SN no nome do item)
//             e a situação de luz de cada uma;
//   espelho → SN → contrato → cliente → CTO;
//   Zabbix  → quando o problema começou;
//   SGP     → quais O.S. já estão abertas para esses contratos.
//
// A ferramenta calcula os FATOS com números ("100% dos clientes da CTO X sem
// luz, 12 de 12"). Não calcula a CONCLUSÃO: isso é do modelo, sob o motor de
// veredito. Deixar o modelo contar ONU de cabeça é pedir número errado.

import { config } from '../../config';
import { sgp, osEstaAberta } from '../../integrations/sgp';
import { zabbix, ZabbixClient } from '../../integrations/zabbix';
import * as zm from '../../integrations/zabbix-metricas';
import type { Onu } from '../../integrations/zabbix-metricas';
import {
  servicosPorSns, servicosPorPon, servicosPorCto, listarCtos, idadeEspelho, statusIndice,
  type ResultadoBusca,
} from '../store/sgp-index';
import { Ferramenta, medir, ferramentas, CtxFerramenta } from './base';
import { Envelope } from '../types';

// ─── Utilitários ────────────────────────────────────────────────────────────

/** "OLT 3", "olt-3", "3" → 3. */
function numeroOlt(texto: string): number | null {
  const m = String(texto).match(/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * "0/1/8" fica como está; "1/8" vira "0/1/8" (frame 0 é o único nas OLTs
 * daqui). "1/1/6" é devolvido como está E como "0/1/6", porque técnico costuma
 * dizer frame 1 querendo dizer slot 1 — quem chama tenta na ordem e registra
 * qual interpretação casou.
 */
function candidatasPorta(texto: string): string[] {
  const partes = String(texto).match(/\d+/g) ?? [];
  if (partes.length === 2) return [`0/${partes[0]}/${partes[1]}`];
  if (partes.length >= 3) {
    const exata = `${partes[0]}/${partes[1]}/${partes[2]}`;
    const semFrame = `0/${partes[1]}/${partes[2]}`;
    return exata === semFrame ? [exata] : [exata, semFrame];
  }
  return [];
}

async function hostDaOlt(n: number): Promise<zm.StatusHost | null> {
  const hs = await zm.statusHosts(`OLT-${n}`);
  // "OLT-3 - 172.16.22.10" e "OLT-3 - 172.16.22.10 - BKP": vale o habilitado.
  return hs.find((h) => h.habilitado && /^OLT-\d+\s+-/i.test(h.nome) && !/BKP/i.test(h.nome))
    ?? hs.find((h) => h.habilitado)
    ?? null;
}

interface EventoPorta {
  nome: string;
  severidade: number;
  iniciadoEm: string;
  resolvidoEm: string | null;
  duracaoSeg: number | null;
  emCurso: boolean;
}

/**
 * Eventos cujo nome contém o termo, restritos a UM host. Restringir importa:
 * "GPON 0/1/8" existe nas três OLTs, e sem hostid a queda da OLT-1 apareceria
 * como histórico da OLT-3.
 */
async function eventosNoHost(hostid: string, termo: string, horas: number): Promise<EventoPorta[]> {
  const desde = Math.floor(Date.now() / 1000) - horas * 3600;
  const evs = await zabbix.api<Array<{ eventid: string; name: string; severity: string; clock: string; r_eventid?: string }>>(
    'event.get',
    {
      output: ['eventid', 'name', 'severity', 'clock', 'r_eventid'],
      source: 0, object: 0, value: 1,
      hostids: [hostid],
      search: { name: termo },
      time_from: desde,
      sortfield: ['clock'], sortorder: 'DESC',
      limit: 200,
    },
  ) ?? [];
  if (!evs.length) return [];

  const recIds = evs.map((e) => e.r_eventid).filter((x): x is string => !!x && x !== '0');
  const recClock = new Map<string, number>();
  if (recIds.length) {
    const recs = await zabbix.api<Array<{ eventid: string; clock: string }>>('event.get', {
      output: ['eventid', 'clock'], eventids: recIds,
    }) ?? [];
    for (const r of recs) recClock.set(r.eventid, parseInt(r.clock, 10));
  }

  return evs.map((e) => {
    const ini = parseInt(e.clock, 10);
    const fim = e.r_eventid && e.r_eventid !== '0' ? recClock.get(e.r_eventid) ?? null : null;
    return {
      nome: e.name,
      severidade: parseInt(e.severity, 10) || 0,
      iniciadoEm: new Date(ini * 1000).toISOString(),
      resolvidoEm: fim ? new Date(fim * 1000).toISOString() : null,
      duracaoSeg: fim ? fim - ini : null,
      emCurso: !fim,
    };
  });
}

/** Junta ONU (Zabbix) com cliente (espelho) pelo SN. */
function cruzarOnuCliente(onus: Onu[], clientes: ResultadoBusca[]) {
  const porSn = new Map<string, ResultadoBusca[]>();
  for (const c of clientes) {
    if (!c.sn) continue;
    const k = c.sn.toUpperCase();
    porSn.set(k, [...(porSn.get(k) ?? []), c]);
  }
  return onus.map((o) => ({ onu: o, clientes: porSn.get(o.sn.toUpperCase()) ?? [] }));
}

/** Agrupa por CTO com contagem de afetados — o fato que separa "CTO caiu" de "clientes isolados". */
function agruparPorCto(linhas: Array<{ cto: string | null; afetado: boolean; semMonitoramento: boolean }>) {
  const m = new Map<string, { total: number; afetados: number; sem_monitoramento: number }>();
  for (const l of linhas) {
    const k = l.cto ?? '(CTO não cadastrada)';
    const a = m.get(k) ?? { total: 0, afetados: 0, sem_monitoramento: 0 };
    a.total++;
    if (l.afetado) a.afetados++;
    if (l.semMonitoramento) a.sem_monitoramento++;
    m.set(k, a);
  }
  return [...m.entries()]
    .map(([cto, v]) => ({
      cto,
      clientes: v.total,
      afetados: v.afetados,
      sem_monitoramento: v.sem_monitoramento,
      pct_afetados: v.total - v.sem_monitoramento > 0
        ? Math.round((v.afetados / (v.total - v.sem_monitoramento)) * 100)
        : null,
    }))
    .sort((a, b) => b.afetados - a.afetados);
}

/** O.S. em aberto entre os contratos informados. Uma varredura, não uma por contrato. */
async function osDosContratos(contratos: number[], dias = 60) {
  if (!contratos.length) return { abertas: [], examinadas: 0, janelaCompleta: true };
  const alvo = new Set(contratos);
  const r = await sgp.ordensServicoAbertas(dias);
  return {
    abertas: r.abertas.filter((o) => alvo.has(o.contrato) && osEstaAberta(o)),
    examinadas: r.examinadas,
    janelaCompleta: r.janelaCompleta,
  };
}

function exigirZabbix(): void {
  if (!config.zabbix.enabled) throw new Error('Zabbix desabilitado na configuração');
}

let cacheTriggersCto: { em: number; nomes: string[] } | null = null;

/**
 * A CTO tem trigger de queda no Zabbix?
 *
 * Sem isto, "nenhuma queda registrada" parece prova de que a CTO não caiu. Não
 * é: CTO sem trigger nunca registra queda, caia ou não. Lista de triggers vai
 * em cache de 10 min — muda com cadastro, não com operação.
 */
async function ctoTemTrigger(ctoNome: string): Promise<{ monitorada: boolean; trigger: string | null }> {
  if (!cacheTriggersCto || Date.now() - cacheTriggersCto.em > 10 * 60_000) {
    const trigs = await zabbix.api<Array<{ description: string }>>('trigger.get', {
      output: ['description'],
      search: { description: 'CTO' },
      limit: 5000,
    }) ?? [];
    cacheTriggersCto = { em: Date.now(), nomes: [...new Set(trigs.map((t) => t.description))] };
  }
  const melhor = cacheTriggersCto.nomes
    .map((n) => ({ n, s: ZabbixClient.semelhanca(ctoNome, n) }))
    .sort((a, b) => b.s - a.s)[0];
  return melhor && melhor.s >= ZabbixClient.LIMIAR_SEMELHANCA
    ? { monitorada: true, trigger: melhor.n }
    : { monitorada: false, trigger: null };
}

/** Acima disto, "quase todas sem luz" — o único padrão que sustenta rompimento geral. */
const LIMIAR_GERAL_PCT = 80;

export interface PadraoLuz {
  padrao:
    | 'porta_down' | 'todas_com_luz' | 'quase_todas_sem_luz'
    | 'concentrado_em_ctos' | 'espalhado' | 'parcial_sem_mapa_de_cto' | 'sem_monitoramento';
  leitura: string;
  /** O que NÃO se pode concluir com estes dados. Vai junto para o modelo não pular etapa. */
  nao_concluir: string | null;
}

/**
 * Classifica o padrão de falta de luz na porta.
 *
 * Existe porque o modelo, deixado sozinho, leu 13 ONUs sem luz em 87 (15%) como
 * "rompimento de fibra antes dos splitters" — a hipótese mais grave, que exige
 * QUASE TODAS sem luz. Limiar é conta, e conta não fica a critério do modelo.
 */
export function lerPadraoLuz(p: {
  statusPorta: string;
  monitoradas: number;
  semLuz: number;
  ctos: Array<{ cto: string; afetados: number; pct_afetados: number | null }> | null;
}): PadraoLuz {
  if (p.statusPorta === 'down') {
    return {
      padrao: 'porta_down',
      leitura: 'Porta GPON DOWN na OLT: falha na porta ou no módulo óptico.',
      nao_concluir: null,
    };
  }
  if (!p.monitoradas) {
    return {
      padrao: 'sem_monitoramento',
      leitura: 'Nenhuma ONU monitorada nesta porta: não há leitura de luz por cliente.',
      nao_concluir: 'Não afirme que os clientes estão online nem offline.',
    };
  }

  const pct = Math.round((p.semLuz / p.monitoradas) * 100);
  if (p.semLuz === 0) {
    return { padrao: 'todas_com_luz', leitura: `Todas as ${p.monitoradas} ONUs com luz.`, nao_concluir: null };
  }
  if (pct >= LIMIAR_GERAL_PCT) {
    return {
      padrao: 'quase_todas_sem_luz',
      leitura: `${p.semLuz} de ${p.monitoradas} ONUs sem luz (${pct}%) com a porta UP: padrão de ` +
        'rompimento de fibra antes dos splitters, ou falha no módulo mesmo com a porta sinalizando up.',
      nao_concluir: null,
    };
  }

  const nao = `Não é padrão de rompimento geral: rompimento antes dos splitters derruba quase ` +
    `todas as ONUs (${LIMIAR_GERAL_PCT}%+), e aqui são ${pct}%.`;

  if (!p.ctos) {
    return {
      padrao: 'parcial_sem_mapa_de_cto',
      leitura: `${p.semLuz} de ${p.monitoradas} ONUs sem luz (${pct}%). Sem a distribuição por CTO, ` +
        'não dá para dizer se está concentrado em alguma CTO ou espalhado em casos individuais.',
      nao_concluir: `${nao} Também não conclua CTO nem caso individual sem o mapa de CTO.`,
    };
  }

  const inteiras = p.ctos.filter((c) => c.afetados >= 2 && c.pct_afetados === 100);
  if (inteiras.length) {
    return {
      padrao: 'concentrado_em_ctos',
      leitura: `${p.semLuz} de ${p.monitoradas} ONUs sem luz (${pct}%), com CTO(s) inteira(s) sem luz: ` +
        `${inteiras.map((c) => `${c.cto} (${c.afetados})`).join(', ')}. Padrão de problema nessa(s) CTO(s) ` +
        'ou no cabo que a(s) alimenta.',
      nao_concluir: nao,
    };
  }
  return {
    padrao: 'espalhado',
    leitura: `${p.semLuz} de ${p.monitoradas} ONUs sem luz (${pct}%), espalhadas sem nenhuma CTO inteira ` +
      'afetada: padrão de casos individuais (ONU desligada, drop, equipamento do cliente).',
    nao_concluir: `${nao} Também não é incidente de CTO.`,
  };
}

// ─── analisar_pon ───────────────────────────────────────────────────────────

const analisarPon: Ferramenta = {
  nome: 'analisar_pon',
  fonte: 'zabbix',
  descricao:
    'Investigação completa de UMA porta PON/GPON: status da porta na OLT, quantas ONUs estão ' +
    'nela e quantas sem luz, quais clientes e CTOs são afetados (com % por CTO), quando o ' +
    'problema começou e quais O.S. já estão abertas para esses clientes. ' +
    'Use para "por que a PON 0/1/8 da OLT 3 está fora?", "quem é afetado na PON X?". ' +
    'Aceita a porta como "0/1/8", "1/8" ou "1/1/8" e diz qual interpretação usou. ' +
    'Devolve FATOS contados, não a conclusão. Leia os sinais assim: porta DOWN = falha na porta ' +
    'ou no módulo; porta UP com quase todas as ONUs sem luz = rompimento de fibra antes dos ' +
    'splitters; sem luz concentrado em algumas CTOs = problema nessas CTOs; poucos casos ' +
    'espalhados = clientes isolados. Se o mapeamento veio do "cadastro_sgp", a lista de ' +
    'clientes é menos confiável (o SGP deixa slot vazio) — diga isso.',
  parametros: {
    type: 'object',
    properties: {
      olt: { type: 'string', description: 'OLT: "OLT-3", "OLT 3" ou "3"' },
      porta: { type: 'string', description: 'Porta GPON: "0/1/8", "1/8" ou "1/1/8"' },
      horas: { type: 'number', description: 'Janela do histórico de eventos (padrão 24, máx 720)' },
    },
    required: ['olt', 'porta'],
  },
  async executar(args, ctx: CtxFerramenta) {
    const n = numeroOlt(String(args.olt ?? ''));
    const candidatas = candidatasPorta(String(args.porta ?? ''));
    const horas = Math.min(720, Math.max(1, Number(args.horas) || 24));
    const envs: Envelope[] = [];

    // 1. Porta e OLT.
    let host: zm.StatusHost | null = null;
    let porta: string | null = null;
    let interpretacao = '';
    let statusPorta = 'desconhecido';

    envs.push(await medir<Record<string, unknown>>(ctx, 'zabbix', 'zabbix.porta_gpon', { olt: args.olt, porta: args.porta }, async () => {
      exigirZabbix();
      if (n === null) throw new Error(`não entendi qual OLT: "${args.olt}"`);
      if (!candidatas.length) throw new Error(`não entendi a porta: "${args.porta}"`);
      host = await hostDaOlt(n);
      if (!host) return null;

      const portas = await zm.portasGpon(host.nome);
      const achada = candidatas.map((c) => portas.find((p) => p.porta === c)).find(Boolean);
      if (!achada) {
        return {
          dados: {
            olt: host.nome,
            porta_pedida: args.porta,
            tentativas: candidatas,
            portas_existentes: portas.map((p) => p.porta),
          },
          vazio: true,
        };
      }
      porta = achada.porta;
      statusPorta = achada.status;
      interpretacao = achada.porta === candidatas[0]
        ? `porta ${achada.porta}`
        : `"${args.porta}" interpretado como ${achada.porta} (sem essa porta exata na OLT)`;

      return {
        dados: {
          olt: host.nome,
          disponibilidade_olt: host.disponibilidade,
          porta: achada.porta,
          interpretacao,
          status_porta: achada.status,
          coleta_status: achada.item.coleta,
        },
      };
    }));

    if (!host || !porta) return envs;
    const h = host as zm.StatusHost;
    const p = porta as string;

    // 2. ONUs da porta, com situação de luz.
    let onus: Onu[] = [];
    envs.push(await medir<Record<string, unknown>>(ctx, 'zabbix', 'zabbix.onus_da_porta', { olt: h.nome, porta: p }, async () => {
      onus = await zm.onusDaPorta(h.nome, p);
      return {
        dados: {
          porta: p,
          onus_monitoradas: onus.length,
          online: onus.filter((o) => o.situacao === 'online').length,
          sem_luz: onus.filter((o) => o.situacao === 'sem_luz').length,
          sem_dado: onus.filter((o) => o.situacao === 'sem_dado').length,
          // Preliminar: sem a distribuição por CTO. A leitura final vem com os clientes.
          padrao_preliminar: lerPadraoLuz({
            statusPorta,
            monitoradas: onus.length,
            semLuz: onus.filter((o) => o.situacao === 'sem_luz').length,
            ctos: null,
          }),
          observacao: onus.length ? null :
            'Nenhuma ONU monitorada nesta porta. Na OLT-1 e OLT-2 o Zabbix não monitora ONU — ' +
            'a situação de luz individual não está disponível.',
        },
        vazio: onus.length === 0,
      };
    }));

    // 3. Clientes e CTOs afetados.
    let contratos: number[] = [];
    envs.push(await medir<Record<string, unknown>>(ctx, 'sgp', 'sgp.clientes_da_porta', { olt: h.nome, porta: p }, async () => {
      if (!statusIndice().disponivel) throw new Error('espelho do SGP ainda não sincronizado');

      if (onus.length) {
        const clientes = servicosPorSns(onus.map((o) => o.sn));
        const cruz = cruzarOnuCliente(onus, clientes);
        const semCadastro = cruz.filter((c) => !c.clientes.length);
        contratos = [...new Set(clientes.map((c) => c.contratoId))];

        const linhas = cruz.flatMap((c) =>
          (c.clientes.length ? c.clientes : [null]).map((cl) => ({
            cto: cl?.ctoNome ?? null,
            afetado: c.onu.situacao === 'sem_luz',
            semMonitoramento: c.onu.situacao === 'sem_dado',
          })),
        );
        const ctos = agruparPorCto(linhas);
        // Só dá para ler a distribuição por CTO se a maioria das ONUs foi
        // identificada no cadastro. Com poucas identificadas, a "CTO inteira sem
        // luz" pode ser só a parte que se conseguiu mapear.
        const mapaConfiavel = onus.length > 0 && (onus.length - semCadastro.length) / onus.length >= 0.7;

        return {
          dados: {
            padrao: lerPadraoLuz({
              statusPorta,
              monitoradas: onus.length,
              semLuz: onus.filter((o) => o.situacao === 'sem_luz').length,
              ctos: mapaConfiavel ? ctos : null,
            }),
            mapa_de_cto_confiavel: mapaConfiavel,
            mapeamento: 'zabbix_sn',
            clientes_identificados: clientes.length,
            onus_sem_cadastro_no_sgp: semCadastro.length,
            ctos,
            ctos_com_todos_afetados: ctos.filter((c) => c.afetados >= 2 && c.pct_afetados === 100).map((c) => c.cto),
            clientes_afetados: cruz
              .filter((c) => c.onu.situacao === 'sem_luz')
              .slice(0, 40)
              .map((c) => ({
                cliente: c.clientes[0]?.nome ?? null,
                contrato: c.clientes[0]?.contratoId ?? null,
                cto: c.clientes[0]?.ctoNome ?? null,
                sn: c.onu.sn,
                motivo: c.onu.motivo,
              })),
            origem_cadastro: idadeEspelho(),
          },
          vazio: clientes.length === 0,
        };
      }

      // Sem ONU no Zabbix: cai para o cadastro do SGP, com a ressalva explícita.
      const partes = p.split('/').map(Number);
      const clientes = servicosPorPon(n!, partes[1], partes[2]);
      contratos = [...new Set(clientes.map((c) => c.contratoId))];
      return {
        dados: {
          mapeamento: 'cadastro_sgp',
          aviso: 'Lista pelo cadastro do SGP, não pela OLT. O SGP deixa o slot vazio em muitas ONUs, ' +
            'então pode incluir clientes de outro slot com a mesma PON. Sem monitoramento por ONU, ' +
            'não há como dizer quais estão sem luz.',
          clientes_no_cadastro: clientes.length,
          ctos: agruparPorCto(clientes.map((c) => ({ cto: c.ctoNome, afetado: false, semMonitoramento: true }))),
          origem_cadastro: idadeEspelho(),
        },
        vazio: clientes.length === 0,
      };
    }));

    // 4. Quando começou.
    envs.push(await medir<Record<string, unknown>>(ctx, 'zabbix', 'zabbix.eventos_porta', { olt: h.nome, porta: p, horas }, async () => {
      // " -" no fim: "GPON 0/1/1" sozinho casaria com 0/1/10 a 0/1/15.
      const evs = await eventosNoHost(h.hostid, `GPON ${p} -`, horas);
      const emCurso = evs.filter((e) => e.emCurso);
      return {
        dados: {
          janela_horas: horas,
          total_eventos: evs.length,
          em_curso: emCurso.length,
          inicio_do_problema_em_curso: emCurso.length
            ? emCurso.map((e) => e.iniciadoEm).sort()[0]
            : null,
          eventos: evs.slice(0, 15),
        },
        vazio: evs.length === 0,
      };
    }));

    // 5. O.S. já abertas para esses clientes.
    envs.push(await medir<Record<string, unknown>>(ctx, 'sgp', 'sgp.os_relacionadas', { contratos: contratos.length }, async () => {
      const r = await osDosContratos(contratos);
      return {
        dados: {
          contratos_verificados: contratos.length,
          os_abertas: r.abertas.length,
          janela_completa: r.janelaCompleta,
          ordens: r.abertas.slice(0, 20).map((o) => ({
            id: o.id, cliente: o.cliente, contrato: o.contrato, status: o.status,
            motivo: o.motivo, aberta_em: o.data_cadastro, responsavel: o.responsavel,
          })),
        },
        vazio: r.abertas.length === 0,
      };
    }));

    return envs;
  },
};

// ─── analisar_cto ───────────────────────────────────────────────────────────

const analisarCto: Ferramenta = {
  nome: 'analisar_cto',
  fonte: 'sgp',
  descricao:
    'Investigação completa de UMA CTO: clientes atendidos, quantos estão sem luz agora (pela OLT), ' +
    'se há incidente aberto no Zabbix para ela e desde quando, histórico de quedas e O.S. abertas ' +
    'dos clientes. Aceita o nome aproximado ("CTO 3 da Rua Araca") e resolve para o cadastrado; ' +
    'se houver mais de uma CTO parecida, devolve as candidatas para você perguntar qual é. ' +
    'Use para "a CTO X caiu?", "quem foi afetado na CTO X?". ' +
    'Clientes de OLT sem monitoramento por ONU aparecem como sem_monitoramento: não conte como online.',
  parametros: {
    type: 'object',
    properties: {
      cto: { type: 'string', description: 'Nome da CTO, exato ou aproximado' },
      horas: { type: 'number', description: 'Janela do histórico de quedas (padrão 24, máx 720)' },
    },
    required: ['cto'],
  },
  async executar(args, ctx: CtxFerramenta) {
    const termo = String(args.cto ?? '').trim();
    const horas = Math.min(720, Math.max(1, Number(args.horas) || 24));
    const envs: Envelope[] = [];

    let ctoNome: string | null = null;
    let clientes: ResultadoBusca[] = [];

    // 1. Resolve a CTO e seus clientes.
    envs.push(await medir<Record<string, unknown>>(ctx, 'sgp', 'sgp.clientes_da_cto', { cto: termo }, async () => {
      if (!statusIndice().disponivel) throw new Error('espelho do SGP ainda não sincronizado');

      const exatos = servicosPorCto(termo);
      if (exatos.length) {
        ctoNome = exatos[0].ctoNome;
        clientes = exatos;
      } else {
        const ranking = listarCtos()
          .map((c) => ({ ...c, semelhanca: ZabbixClient.semelhanca(termo, c.cto) }))
          .filter((c) => c.semelhanca >= ZabbixClient.LIMIAR_SEMELHANCA)
          .sort((a, b) => b.semelhanca - a.semelhanca || b.servicos - a.servicos);

        if (!ranking.length) {
          return { dados: { termo, resolvida: null, candidatas: [] }, vazio: true };
        }
        const empatadas = ranking.filter((r) => r.semelhanca === ranking[0].semelhanca);
        if (empatadas.length > 1) {
          // Ambíguo: escolher sozinho seria afirmar a CTO errada com confiança.
          return {
            dados: { termo, resolvida: null, ambiguo: true, candidatas: empatadas.slice(0, 8).map((r) => r.cto) },
            vazio: true,
          };
        }
        ctoNome = ranking[0].cto;
        clientes = servicosPorCto(ranking[0].cto);
      }

      return {
        dados: {
          termo,
          cto: ctoNome,
          resolvida_por: exatos.length ? 'nome exato' : 'semelhança de nome',
          clientes: clientes.length,
          contratos_ativos: clientes.filter((c) => /ativo/i.test(c.contratoStatus ?? '')).length,
          olts: [...new Set(clientes.map((c) => c.oltNome).filter(Boolean))],
          origem_cadastro: idadeEspelho(),
        },
        vazio: clientes.length === 0,
      };
    }));

    if (!ctoNome || !clientes.length) return envs;
    const nomeCto = ctoNome as string;

    // 2. Luz de cada cliente, direto na OLT.
    envs.push(await medir<Record<string, unknown>>(ctx, 'zabbix', 'zabbix.onus_da_cto', { cto: nomeCto }, async () => {
      exigirZabbix();
      const onus = await zm.onusPorSns(clientes.map((c) => c.sn).filter((x): x is string => !!x));
      const porSn = new Map(onus.map((o) => [o.sn.toUpperCase(), o]));

      const linhas = clientes.map((c) => {
        const o = c.sn ? porSn.get(c.sn.toUpperCase()) : undefined;
        return {
          cliente: c.nome,
          contrato: c.contratoId,
          sn: c.sn,
          situacao: o ? o.situacao : 'sem_monitoramento',
          motivo: o ? o.motivo : (c.sn ? 'ONU não monitorada no Zabbix (OLT sem monitoramento por ONU)' : 'sem SN no cadastro'),
          sinal_rx: o?.sinalRx?.valorFormatado ?? null,
        };
      });
      const monitorados = linhas.filter((l) => l.situacao !== 'sem_monitoramento');
      const semLuz = linhas.filter((l) => l.situacao === 'sem_luz');

      return {
        dados: {
          cto: nomeCto,
          clientes: linhas.length,
          monitorados: monitorados.length,
          sem_monitoramento: linhas.length - monitorados.length,
          // Com ninguém monitorado, online e sem_luz são DESCONHECIDOS, não zero.
          // Devolver 0 aqui fez o modelo concluir "nenhum cliente sem luz" sobre
          // uma CTO da OLT-1, que não tem leitura de ONU nenhuma.
          online: monitorados.length ? linhas.filter((l) => l.situacao === 'online').length : null,
          sem_luz: monitorados.length ? semLuz.length : null,
          pct_sem_luz_entre_monitorados: monitorados.length
            ? Math.round((semLuz.length / monitorados.length) * 100)
            : null,
          nao_concluir: monitorados.length === 0
            ? 'Nenhum cliente desta CTO tem ONU monitorada: NÃO afirme que estão com luz, sem luz, ' +
              'afetados ou não afetados. A situação de luz é desconhecida.'
            : monitorados.length < linhas.length
              ? `Só ${monitorados.length} de ${linhas.length} clientes são monitorados: não generalize para a CTO toda.`
              : null,
          clientes_sem_luz: semLuz.slice(0, 30),
        },
        vazio: monitorados.length === 0,
      };
    }));

    // 3. Incidente e histórico da CTO no Zabbix.
    envs.push(await medir<Record<string, unknown>>(ctx, 'zabbix', 'zabbix.historico_cto', { cto: nomeCto, horas }, async () => {
      exigirZabbix();
      const [quedas, trigger] = await Promise.all([
        zabbix.historicoEventos([nomeCto], horas),
        ctoTemTrigger(nomeCto),
      ]);
      const resolvidas = quedas.filter((q) => q.duracaoSeg !== null);
      return {
        dados: {
          cto_monitorada_no_zabbix: trigger.monitorada,
          trigger: trigger.trigger,
          nao_concluir: !trigger.monitorada && !quedas.length
            ? 'Esta CTO NÃO tem trigger de queda no Zabbix: ausência de queda registrada não prova ' +
              'que ela não caiu. Não afirme que a CTO está operacional com base nisto.'
            : null,
          janela_horas: horas,
          total_quedas: quedas.length,
          em_curso: quedas.filter((q) => q.emCurso).length,
          inicio_da_queda_em_curso: quedas.filter((q) => q.emCurso).map((q) => q.iniciadoEm).sort()[0] ?? null,
          indisponibilidade_total_seg: resolvidas.reduce((a, q) => a + (q.duracaoSeg ?? 0), 0),
          quedas: quedas.slice(0, 15),
        },
        vazio: quedas.length === 0,
      };
    }));

    // 4. O.S. abertas.
    envs.push(await medir<Record<string, unknown>>(ctx, 'sgp', 'sgp.os_relacionadas', { cto: nomeCto }, async () => {
      const r = await osDosContratos([...new Set(clientes.map((c) => c.contratoId))]);
      return {
        dados: {
          os_abertas: r.abertas.length,
          janela_completa: r.janelaCompleta,
          ordens: r.abertas.slice(0, 20).map((o) => ({
            id: o.id, cliente: o.cliente, contrato: o.contrato, status: o.status,
            motivo: o.motivo, aberta_em: o.data_cadastro, responsavel: o.responsavel,
          })),
        },
        vazio: r.abertas.length === 0,
      };
    }));

    return envs;
  },
};

export function registrarFerramentasCausais(): void {
  ferramentas.registrar(analisarPon, analisarCto);
}
