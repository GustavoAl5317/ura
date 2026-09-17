// Ferramentas de métricas do Zabbix (Bloco 2).
//
// Tudo aqui devolve valores já formatados e com o estado da coleta ao lado.
// O modelo nunca recebe um "0" solto: recebe "sem coleta", "atrasada há 40 min"
// ou "viva". É o que impede "o link está parado" em cima de item quebrado.

import { config } from '../../config';
import * as zm from '../../integrations/zabbix-metricas';
import type { ItemMetrica, Interface, Onu } from '../../integrations/zabbix-metricas';
import { zabbix } from '../../integrations/zabbix';
import { Ferramenta, medir, ferramentas } from './base';

function exigirZabbix(): void {
  if (!config.zabbix.enabled) throw new Error('Zabbix desabilitado na configuração');
}

/** Projeção compacta de um item: o que o modelo precisa, sem ruído. */
function item(i: ItemMetrica | null): Record<string, unknown> | null {
  if (!i) return null;
  return {
    valor: i.valorFormatado,
    coleta: i.coleta,
    ...(i.coleta !== 'viva' && i.idadeSeg !== null ? { atualizado_ha_min: Math.round(i.idadeSeg / 60) } : {}),
  };
}

function iface(i: Interface): Record<string, unknown> {
  return {
    equipamento: i.host,
    interface: i.interface,
    entrada: item(i.entrada),
    saida: item(i.saida),
    capacidade: i.velocidade?.coleta === 'viva' ? i.velocidade.valorFormatado : null,
    utilizacao_pct: i.utilizacaoPct === null ? null : Math.round(i.utilizacaoPct * 10) / 10,
  };
}

function onu(o: Onu): Record<string, unknown> {
  return {
    equipamento: o.host,
    porta_gpon: o.portaGpon,
    sn: o.sn,
    sn_legivel: o.snValido,
    login: o.login,
    situacao: o.situacao,
    motivo: o.motivo,
    sinal_rx: item(o.sinalRx),
    sinal_tx: item(o.sinalTx),
    download: item(o.download),
    upload: item(o.upload),
  };
}

// ─── Equipamentos ───────────────────────────────────────────────────────────

const equipamentos: Ferramenta = {
  nome: 'zabbix_equipamentos',
  fonte: 'zabbix',
  descricao:
    'Disponibilidade dos equipamentos no Zabbix (se o SNMP/agente responde), se estão em ' +
    'manutenção e quantos problemas abertos cada um tem. Responde "esse equipamento está de pé?", ' +
    '"alguma OLT fora?". Filtre pelo nome (ex.: "OLT", "BGP", "CORE", "OLT-3"). ' +
    'Indisponível significa que o Zabbix NÃO CONSEGUE LER o equipamento — pode ser queda real ou ' +
    'só a coleta; não afirme que o equipamento caiu sem outra evidência (ping, tráfego, clientes).',
  parametros: {
    type: 'object',
    properties: {
      filtro: { type: 'string', description: 'Trecho do nome do equipamento. Vazio = todos.' },
    },
    required: [],
  },
  async executar(args, ctx) {
    const filtro = args.filtro ? String(args.filtro).trim() : undefined;
    return [
      await medir(ctx, 'zabbix', 'zabbix.equipamentos', { filtro }, async () => {
        exigirZabbix();
        const hs = await zm.statusHosts(filtro);
        const ativos = hs.filter((h) => h.habilitado);
        return {
          dados: {
            filtro: filtro ?? null,
            total: hs.length,
            desabilitados_no_zabbix: hs.length - ativos.length,
            disponiveis: ativos.filter((h) => h.disponibilidade === 'disponivel').length,
            indisponiveis: ativos.filter((h) => h.disponibilidade === 'indisponivel').map((h) => ({
              nome: h.nome, erro: h.erroInterface, problemas: h.problemasAbertos,
            })),
            disponibilidade_desconhecida: ativos.filter((h) => h.disponibilidade === 'desconhecida').length,
            em_manutencao: ativos.filter((h) => h.emManutencao).map((h) => h.nome),
            com_problemas: ativos
              .filter((h) => h.problemasAbertos > 0)
              .sort((a, b) => (b.piorSeveridade ?? 0) - (a.piorSeveridade ?? 0))
              .slice(0, 25)
              .map((h) => ({ nome: h.nome, problemas: h.problemasAbertos, pior_severidade: h.piorSeveridade })),
          },
          vazio: hs.length === 0,
        };
      }),
    ];
  },
};

// ─── Links ──────────────────────────────────────────────────────────────────

const links: Ferramenta = {
  nome: 'zabbix_links',
  fonte: 'zabbix',
  descricao:
    'Ranking do tráfego atual das interfaces, ordenado pelo maior volume, com capacidade da porta e ' +
    'UTILIZAÇÃO %. Responde "quais links mais carregados?", "tem link saturado?". Para UM link pelo nome (Angola, ETICE...), use zabbix_link. ' +
    'Os links de borda (saída para a internet) estão nos roteadores com "BGP" no nome ' +
    '(NE20-BGP-01, NE8K-AQUI-FOR-BGP) — use equipamento="BGP" para o link principal. ' +
    'Interface com coleta "sem_coleta" ou "atrasada" NÃO tem tráfego zero: tem leitura ausente. ' +
    'Utilização nula significa que a capacidade da porta não está cadastrada, não que está ociosa.',
  parametros: {
    type: 'object',
    properties: {
      equipamento: { type: 'string', description: 'Trecho do nome (ex.: "BGP", "CORE-01"). Vazio = rede toda.' },
      interface: { type: 'string', description: 'Filtra por trecho do nome da interface (ex.: "Eth-Trunk0").' },
      top: { type: 'number', description: 'Quantas interfaces devolver (padrão 10, máx 40).' },
    },
    required: [],
  },
  async executar(args, ctx) {
    const equipamento = args.equipamento ? String(args.equipamento).trim() : undefined;
    const filtroIf = args.interface ? String(args.interface).trim().toLowerCase() : undefined;
    const top = Math.min(40, Math.max(1, Number(args.top) || 10));

    return [
      await medir(ctx, 'zabbix', 'zabbix.links', { equipamento, interface: filtroIf, top }, async () => {
        exigirZabbix();
        let lista = await zm.interfaces({ host: equipamento });
        if (filtroIf) lista = lista.filter((i) => i.interface.toLowerCase().includes(filtroIf));

        const vivas = lista.filter((i) => zm.picoVivo(i) >= 0);
        const semLeitura = lista.filter((i) => zm.picoVivo(i) < 0);
        const ordenadas = [...vivas].sort((a, b) => zm.picoVivo(b) - zm.picoVivo(a));

        return {
          dados: {
            equipamento: equipamento ?? '(todos)',
            interfaces_encontradas: lista.length,
            com_leitura_viva: vivas.length,
            sem_leitura_viva: semLeitura.length,
            saturadas_acima_80pct: vivas
              .filter((i) => (i.utilizacaoPct ?? 0) >= 80)
              .map(iface),
            maiores: ordenadas.slice(0, top).map(iface),
          },
          vazio: lista.length === 0,
        };
      }),
    ];
  },
};

// ─── Um link específico ─────────────────────────────────────────────────────

/** ifOperStatus (IF-MIB): 1 up, 2 down, 3 testing, 4 unknown, 5 dormant, 6 notPresent, 7 lowerLayerDown. */
const OPER_STATUS: Record<number, string> = {
  1: 'up', 2: 'down', 3: 'testing', 4: 'desconhecido', 5: 'dormant', 6: 'ausente', 7: 'down (camada inferior)',
};
const ESTADO_FORA = /\b(down|offline|fora|inativ\w*|queda|rompimento|sem\s*link)\b/i;

/** Interface citada num nome de item ou trigger: "Interface XGigabitEthernet0/0/5 - OPER_ANGOLA ..." → "XGigabitEthernet0/0/5". */
export function portaDoTexto(texto: string): string | null {
  return texto.match(/\binterface\s+([A-Za-z-]*\d+(?:\/\d+)*(?:\.\d+)?)/i)?.[1] ?? null;
}

export function situacaoDoLink(p: {
  problemas: Array<{ nome: string }>;
  operStatus: number | null;
  trafegoVivo: boolean;
}): { situacao: 'fora' | 'com_problema' | 'no_ar' | 'desconhecida'; motivo: string } {
  const queda = p.problemas.find((x) => ESTADO_FORA.test(x.nome));
  if (queda) return { situacao: 'fora', motivo: `alerta aberto no Zabbix: "${queda.nome}"` };
  if (p.operStatus !== null && [2, 7].includes(p.operStatus)) {
    return { situacao: 'fora', motivo: `porta com estado operacional ${OPER_STATUS[p.operStatus]}` };
  }
  if (p.problemas.length) return { situacao: 'com_problema', motivo: `alerta aberto no Zabbix: "${p.problemas[0].nome}"` };
  if (p.operStatus === 1) return { situacao: 'no_ar', motivo: 'porta up e nenhum alerta aberto' };
  if (p.trafegoVivo) return { situacao: 'no_ar', motivo: 'tráfego sendo coletado e nenhum alerta aberto' };
  return { situacao: 'desconhecida', motivo: 'sem alerta aberto, mas sem estado da porta nem tráfego coletado' };
}

const link: Ferramenta = {
  nome: 'zabbix_link',
  fonte: 'zabbix',
  descricao:
    'Valida UM link pelo nome (operadora, trânsito, PTT ou interface): "como está o link da Angola?", ' +
    '"o link da ETICE caiu?", "valida o IX-CE". Cruza os ALERTAS ABERTOS no Zabbix com esse nome ' +
    '(ex.: "Interface XGigabitEthernet0/0/5 - OPER_ANGOLA down"), o estado operacional da porta ' +
    '(up/down) e o tráfego atual, e devolve a situação: fora, com_problema, no_ar ou desconhecida, ' +
    'com desde quando. Use SEMPRE esta para pergunta sobre um link específico; zabbix_links é para ranking de tráfego.',
  parametros: {
    type: 'object',
    properties: {
      link: { type: 'string', description: 'Nome do link como se fala: "angola", "etice", "seaborn", "IX-CE" ou a interface' },
    },
    required: ['link'],
  },
  async executar(args, ctx) {
    const termo = String(args.link ?? '').trim();
    return [
      await medir(ctx, 'zabbix', 'zabbix.link', { link: termo }, async () => {
        exigirZabbix();
        if (termo.length < 2) throw new Error('informe o nome do link');

        const [problemas, itens] = await Promise.all([
          zabbix.problemasPorPadroes([termo]),
          zm.buscarItens({ nome: termo, limite: 300 }),
        ]);

        // Agrupa o que achou por equipamento + porta.
        type Grupo = { host: string; porta: string; nomes: Set<string>; oper: ItemMetrica | null; trafego: ItemMetrica[]; problemas: typeof problemas };
        const grupos = new Map<string, Grupo>();
        const grupo = (host: string, porta: string) => {
          const k = `${host}|${porta}`.toLowerCase();
          if (!grupos.has(k)) grupos.set(k, { host, porta, nomes: new Set(), oper: null, trafego: [], problemas: [] });
          return grupos.get(k)!;
        };
        for (const it of itens) {
          const porta = portaDoTexto(it.nome) ?? zm.interfaceDoItem(it.nome, it.chave);
          const g = grupo(it.host, porta);
          g.nomes.add(it.nome.replace(/:\s.*$/, ''));
          if (/oper(ational)?\s*status|status\s*operacional|ifOperStatus/i.test(`${it.nome} ${it.chave}`)) g.oper = it;
          else if (it.unidade === 'bps' && zm.sentidoDoItem(it.nome) && zm.sentidoDoItem(it.nome) !== 'velocidade') g.trafego.push(it);
        }
        const soltos: typeof problemas = [];
        for (const p of problemas) {
          const host = p.hosts?.[0]?.name ?? '';
          const porta = portaDoTexto(p.name);
          const alvo = [...grupos.values()].find((g) => (!host || g.host === host) && porta && g.porta.toLowerCase() === porta.toLowerCase());
          if (alvo) alvo.problemas.push(p);
          else if (porta && host) grupo(host, porta).problemas.push(p);
          else soltos.push(p);
        }

        const agora = Date.now();
        const problema = (p: (typeof problemas)[number]) => ({
          alerta: p.name,
          equipamento: p.hosts?.[0]?.name ?? null,
          severidade: Number(p.severity),
          desde: new Date(Number(p.clock) * 1000).toISOString(),
          ha_min: Math.round((agora - Number(p.clock) * 1000) / 60_000),
        });

        const links = [...grupos.values()].map((g) => {
          const operStatus = g.oper?.coleta === 'viva' ? g.oper.valorNumerico : null;
          const vivos = g.trafego.filter((t) => t.coleta === 'viva' && t.valorNumerico !== null);
          const s = situacaoDoLink({
            problemas: g.problemas.map((p) => ({ nome: p.name })),
            operStatus,
            trafegoVivo: vivos.length > 0,
          });
          return {
            equipamento: g.host,
            interface: g.porta,
            descricao: [...g.nomes][0] ?? null,
            situacao: s.situacao,
            motivo: s.motivo,
            estado_da_porta: operStatus === null
              ? (g.oper ? `sem coleta (${g.oper.coleta})` : 'item de estado não encontrado')
              : OPER_STATUS[operStatus] ?? String(operStatus),
            trafego: g.trafego.map((t) => ({ item: t.nome.replace(/^.*?:\s*/, ''), ...item(t) })),
            alertas_abertos: g.problemas.map(problema),
          };
        }).sort((a, b) => ['fora', 'com_problema', 'desconhecida', 'no_ar'].indexOf(a.situacao)
          - ['fora', 'com_problema', 'desconhecida', 'no_ar'].indexOf(b.situacao));

        const nadaAchado = !links.length && !soltos.length;
        let sugestoes: string[] = [];
        if (nadaAchado) {
          // Ajuda a perguntar de volta: nomes de porta dos roteadores de borda.
          const borda = await zm.buscarItens({ host: 'BGP', unidade: 'bps', limite: 2000 }).catch(() => []);
          sugestoes = [...new Set(borda.map((i) => i.nome.replace(/:\s.*$/, '').replace(/^interface\s+/i, '')))]
            // Só porta com descrição ("... - OPER_ANGOLA", "...(IX-CE)"): nome cru de porta não ajuda a perguntar.
            .filter((n) => /\s-\s\S|\(\S/.test(n))
            .slice(0, 40);
        }

        return {
          vazio: nadaAchado,
          dados: {
            link: termo,
            situacao_geral: links[0]?.situacao ?? (soltos.length ? 'com_problema' : 'nao_encontrado'),
            links,
            outros_alertas_com_o_nome: soltos.map(problema),
            ...(nadaAchado ? {
              nao_encontrado: `Nenhum alerta aberto, item ou interface no Zabbix com "${termo}" no nome. ` +
                'Pode ser outro nome no cadastro: pergunte ao técnico ou ofereça as portas abaixo. Não afirme que o link está no ar.',
              portas_dos_roteadores_de_borda: sugestoes,
            } : {}),
          },
        };
      }),
    ];
  },
};

// ─── Métricas genéricas ─────────────────────────────────────────────────────

const metricas: Ferramenta = {
  nome: 'zabbix_metricas',
  fonte: 'zabbix',
  descricao:
    'Busca itens de um equipamento pelo nome (CPU, memória, temperatura, ping, fan, erros) e ' +
    'devolve o valor atual com o estado da coleta. Com horas, resume a série (mínimo, máximo, ' +
    'média, tendência %) dos primeiros itens — nunca os pontos crus. ' +
    'Use para "a OLT está sobrecarregada?", "temperatura do chassi", "perda de ping no CORE".',
  parametros: {
    type: 'object',
    properties: {
      equipamento: { type: 'string', description: 'Trecho do nome do equipamento (obrigatório)' },
      busca: { type: 'string', description: 'Trecho do nome do item: "CPU", "Memória", "Temperatura", "PING"' },
      horas: { type: 'number', description: 'Se informado, resume a série nesta janela (máx 720)' },
    },
    required: ['equipamento', 'busca'],
  },
  async executar(args, ctx) {
    const equipamento = String(args.equipamento ?? '').trim();
    const busca = String(args.busca ?? '').trim();
    const horas = args.horas ? Math.min(720, Math.max(1, Number(args.horas))) : null;

    return [
      await medir(ctx, 'zabbix', 'zabbix.metricas', { equipamento, busca, horas }, async () => {
        exigirZabbix();
        const itens = await zm.buscarItens({ host: equipamento, nome: busca, limite: 60 });
        const series = horas
          ? await Promise.all(itens.filter((i) => i.coleta !== 'sem_coleta').slice(0, 5).map(async (i) => ({
              item: i.nome, equipamento: i.host, ...(await zm.resumoSerie(i, horas)),
            })))
          : [];

        return {
          dados: {
            equipamento,
            busca,
            itens: itens.slice(0, 40).map((i) => ({
              equipamento: i.host, nome: i.nome, ...item(i),
            })),
            sem_coleta: itens.filter((i) => i.coleta === 'sem_coleta').length,
            series: series.map((s) => ({
              item: s.item,
              equipamento: s.equipamento,
              janela_horas: s.janelaHoras,
              amostras: s.amostras,
              minimo: s.minimo,
              maximo: s.maximo,
              media: s.media === null ? null : Math.round(s.media * 100) / 100,
              tendencia_pct: s.tendenciaPct === null ? null : Math.round(s.tendenciaPct * 10) / 10,
            })),
          },
          vazio: itens.length === 0,
        };
      }),
    ];
  },
};

// ─── ONU ────────────────────────────────────────────────────────────────────

const onuZabbix: Ferramenta = {
  nome: 'zabbix_onu',
  fonte: 'zabbix',
  dadoPessoal: true,
  descricao:
    'Sinal óptico (potência RX/TX) e tráfego (download/upload) AO VIVO de uma ONU, pelo SN ou ' +
    'login PPPoE, lidos direto da OLT pelo Zabbix — independente do SGP. Com horas, mostra a ' +
    'estabilidade do sinal e do tráfego na janela. ' +
    'LIMITE: só existe para clientes da OLT-3. Para OLT-1 e OLT-2 o Zabbix não monitora ONU; ' +
    'lista vazia nesses casos é falta de monitoramento, não ONU desligada — use revisao_cliente.',
  parametros: {
    type: 'object',
    properties: {
      termo: { type: 'string', description: 'SN da ONU ou login PPPoE' },
      horas: { type: 'number', description: 'Janela para resumir sinal e tráfego (máx 168)' },
    },
    required: ['termo'],
  },
  async executar(args, ctx) {
    const termo = String(args.termo ?? '').trim();
    const horas = args.horas ? Math.min(168, Math.max(1, Number(args.horas))) : null;

    return [
      await medir(ctx, 'zabbix', 'zabbix.onu', { termo, horas }, async () => {
        exigirZabbix();
        const onus = await zm.onuPorTermo(termo);
        const detalhes = await Promise.all(onus.map(async (o) => {
          const base = onu(o);
          if (!horas) return base;
          const rx = o.sinalRx && o.sinalRx.coleta !== 'sem_coleta' ? await zm.resumoSerie(o.sinalRx, horas) : null;
          const dl = o.download && o.download.coleta !== 'sem_coleta' ? await zm.resumoSerie(o.download, horas) : null;
          return {
            ...base,
            janela_horas: horas,
            sinal_rx_na_janela: rx && rx.amostras ? {
              minimo_dbm: rx.minimo, maximo_dbm: rx.maximo,
              variacao_db: rx.maximo !== null && rx.minimo !== null ? Math.round((rx.maximo - rx.minimo) * 100) / 100 : null,
              amostras: rx.amostras,
            } : null,
            download_na_janela: dl && dl.amostras ? {
              media: dl.media === null ? null : zm.formatarValor(dl.media, 'bps'),
              pico: dl.maximo === null ? null : zm.formatarValor(dl.maximo, 'bps'),
              amostras: dl.amostras,
            } : null,
          };
        }));

        return {
          dados: {
            termo,
            encontradas: onus.length,
            onus: detalhes,
            observacao: onus.length ? null :
              'Nenhuma ONU com esse SN/login no Zabbix. Só a OLT-3 tem ONUs monitoradas; ' +
              'se o cliente é de outra OLT, isto é falta de monitoramento, não ONU fora.',
          },
          vazio: onus.length === 0,
        };
      }),
    ];
  },
};

// ─── OLT ────────────────────────────────────────────────────────────────────

const olt: Ferramenta = {
  nome: 'zabbix_olt',
  fonte: 'zabbix',
  descricao:
    'Visão de uma OLT: status de cada porta GPON (up/down), disponibilidade e os totais de ONUs ' +
    'online/offline e sinal bom/degradado/péssimo quando o Zabbix coleta. ' +
    'ATENÇÃO: os totais da OLT-3 existem mas estão SEM COLETA em produção — não os leia como zero.',
  parametros: {
    type: 'object',
    properties: {
      olt: { type: 'string', description: 'Nome da OLT: "OLT-1", "OLT-2", "OLT-3"' },
    },
    required: ['olt'],
  },
  async executar(args, ctx) {
    const nomeOlt = String(args.olt ?? '').trim();
    return [
      await medir(ctx, 'zabbix', 'zabbix.olt', { olt: nomeOlt }, async () => {
        exigirZabbix();
        const [hosts, portas, totais] = await Promise.all([
          zm.statusHosts(nomeOlt),
          zm.portasGpon(nomeOlt),
          zm.totaisOlt(nomeOlt),
        ]);
        const principal = hosts.find((h) => h.habilitado);
        return {
          dados: {
            olt: principal?.nome ?? nomeOlt,
            disponibilidade: principal?.disponibilidade ?? null,
            problemas_abertos: principal?.problemasAbertos ?? null,
            portas_gpon: {
              total: portas.length,
              up: portas.filter((p) => p.status === 'up').length,
              down: portas.filter((p) => p.status === 'down').map((p) => p.porta),
              sem_leitura: portas.filter((p) => p.status === 'desconhecido').map((p) => p.porta),
            },
            totais_onu: totais
              ? Object.fromEntries(Object.entries(totais.itens).map(([k, v]) => [k, item(v)]))
              : null,
          },
          vazio: !principal && portas.length === 0,
        };
      }),
    ];
  },
};

export function registrarFerramentasMetricas(): void {
  ferramentas.registrar(equipamentos, links, link, metricas, onuZabbix, olt);
}
