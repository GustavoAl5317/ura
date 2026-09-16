// Contagens operacionais: clientes online agora, instalações e cancelamentos.
//
// Clientes online vêm das sessões PPPoE do Zabbix (valor vivo), não do
// espelho do SGP (foto noturna). Instalação e cancelamento vêm das O.S. do SGP
// — a API não informa a data em que um contrato mudou de situação — e, para
// cancelamento, também do que o espelho viu mudar entre um sync e outro.

import { config } from '../../config';
import * as zm from '../../integrations/zabbix-metricas';
import type { ItemMetrica } from '../../integrations/zabbix-metricas';
import { sgp, osEstaAberta, SgpOrdemServico } from '../../integrations/sgp';
import { db } from '../store/db';
import { statusIndice, idadeEspelho } from '../store/sgp-index';
import { obter } from '../config-dinamica';
import { diaLocal, instanteSgp, normalizar } from '../datas';
import { Ferramenta, medir, ferramentas } from './base';

// ─── Clientes online ────────────────────────────────────────────────────────

function viva(i: ItemMetrica | undefined): boolean {
  return !!i && i.coleta === 'viva' && i.valorNumerico !== null;
}

const clientesOnline: Ferramenta = {
  nome: 'clientes_online',
  fonte: 'zabbix',
  descricao:
    'Quantos clientes estão online AGORA: sessões PPPoE ativas nos concentradores, lidas do Zabbix, ' +
    'com o total, o detalhe por concentrador, a variação na última hora e a comparação com ontem no ' +
    'mesmo horário. Uma sessão PPPoE = um serviço conectado. Responde "quantos clientes estão online?", ' +
    '"caiu muita gente?". Para a foto do cadastro (contratos ativos, cancelados), use panorama_rede.',
  parametros: { type: 'object', properties: {}, required: [] },
  async executar(_args, ctx) {
    return [await medir<Record<string, unknown>>(ctx, 'zabbix', 'zabbix.clientes_online', {}, async () => {
      if (!config.zabbix.enabled) throw new Error('Zabbix desabilitado na configuração');
      const [totais, porHost] = await Promise.all([
        zm.buscarItens({ chave: config.zabbix.itemSessoesTotal, limite: 5 }),
        zm.buscarItens({ chave: config.zabbix.itemSessoesHost, limite: 50 }),
      ]);
      const concentradores = porHost.filter((i) => i.chave === config.zabbix.itemSessoesHost);
      const total = totais.find((i) => i.chave === config.zabbix.itemSessoesTotal);

      const vivos = concentradores.filter(viva);
      const somaVivos = vivos.reduce((s, i) => s + (i.valorNumerico ?? 0), 0);

      // Total agregado do Zabbix quando está coletando; senão, a soma dos
      // concentradores que responderam — e isso é dito.
      let agora: number;
      let origemTotal: string;
      let serieDe: ItemMetrica | undefined;
      if (total && viva(total)) {
        agora = total.valorNumerico!;
        origemTotal = 'item agregado do Zabbix (soma dos concentradores)';
        serieDe = total;
      } else if (vivos.length) {
        agora = somaVivos;
        origemTotal = `soma de ${vivos.length} concentrador(es) com coleta viva` +
          (total ? ' — o item agregado do Zabbix está sem coleta' : '');
        serieDe = vivos.length === 1 ? vivos[0] : undefined;
      } else {
        throw new Error('nenhum item de sessões PPPoE com coleta viva no Zabbix: não há como contar clientes online agora');
      }

      const semColeta = concentradores.filter((i) => !viva(i));
      const agoraSeg = Math.floor(Date.now() / 1000);
      let ultimaHora: Record<string, unknown> | null = null;
      let ontem: Record<string, unknown> | null = null;
      if (serieDe) {
        const [h, o] = await Promise.all([
          zm.resumoSerie(serieDe, 1),
          zm.valorEm(serieDe, agoraSeg - 86400),
        ]);
        if (h.amostras) {
          ultimaHora = {
            minimo: h.minimo, maximo: h.maximo,
            queda_desde_o_maximo: h.maximo !== null ? Math.round(h.maximo - agora) : null,
            queda_pct: h.maximo ? Math.round(((h.maximo - agora) / h.maximo) * 1000) / 10 : null,
          };
        }
        ontem = o
          ? { valor: o.valor, em: o.em, diferenca: Math.round(agora - o.valor), diferenca_pct: o.valor ? Math.round(((agora - o.valor) / o.valor) * 1000) / 10 : null }
          : { valor: null, observacao: 'sem coleta nesse horário ontem' };
      }

      return {
        dados: {
          online_agora: Math.round(agora),
          origem: origemTotal,
          medido_em: serieDe?.coletadoEm ?? null,
          ultima_hora: ultimaHora,
          ontem_mesmo_horario: ontem,
          por_concentrador: vivos.map((i) => ({ concentrador: i.host, sessoes: i.valorNumerico, medido_em: i.coletadoEm })),
          concentradores_sem_coleta: semColeta.map((i) => ({ concentrador: i.host, coleta: i.coleta })),
          observacao: 'Sessão PPPoE ativa = serviço conectado agora. Cliente com mais de um serviço conta mais de uma vez.',
        },
      };
    })];
  },
};

// ─── Instalações e cancelamentos ────────────────────────────────────────────

function janelaDias(args: Record<string, unknown>, padrao: number) {
  const dias = Math.min(90, Math.max(1, Number(args.dias) || padrao));
  const fim = new Date();
  const inicio = new Date(fim.getTime() - dias * 86_400_000);
  return { dias, inicio, fim };
}

function casa(o: SgpOrdemServico, palavras: string[]): boolean {
  const texto = normalizar(`${o.motivo ?? ''} ${o.tipo ?? ''}`);
  return palavras.some((p) => p && texto.includes(normalizar(p)));
}

function contar<T>(xs: T[], chave: (x: T) => string | undefined, max = 8) {
  const m = new Map<string, number>();
  for (const x of xs) {
    const k = chave(x)?.trim() || '(sem informação)';
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, max).map(([nome, n]) => ({ nome, n }));
}

/** O.S. do SGP cadastradas na janela que casam com as palavras, já separadas. */
async function osDaJanela(inicio: Date, fim: Date, palavras: string[]) {
  const r = await sgp.ordensServicoPorCadastro(diaLocal(inicio), diaLocal(fim), 500, 10);
  const naJanela = r.ordens.filter((o) => {
    const c = instanteSgp(o.data_cadastro, o.hora_cadastro);
    const dia = c.dia;
    return !!dia && dia >= diaLocal(inicio) && dia <= diaLocal(fim);
  });
  const casadas = naJanela.filter((o) => casa(o, palavras));
  const outras = naJanela.filter((o) => !casa(o, palavras));
  return { casadas, outras, examinadas: naJanela.length, completa: r.janelaCompleta };
}

function resumoOs(casadas: SgpOrdemServico[]) {
  const concluidas = casadas.filter((o) => !osEstaAberta(o));
  const tempos = concluidas.map((o) => {
    const a = instanteSgp(o.data_cadastro, o.hora_cadastro).instante;
    const b = instanteSgp(o.data_finalizacao, o.hora_finalizacao).instante;
    return a && b && b >= a ? (b.getTime() - a.getTime()) / 3_600_000 : null;
  }).filter((x): x is number => x !== null);
  const porDia = contar(casadas, (o) => instanteSgp(o.data_cadastro).dia ?? undefined, 90)
    .sort((a, b) => a.nome.localeCompare(b.nome));
  return {
    total: casadas.length,
    concluidas: concluidas.length,
    em_aberto: casadas.length - concluidas.length,
    tempo_medio_conclusao_horas: tempos.length ? Math.round((tempos.reduce((s, x) => s + x, 0) / tempos.length) * 10) / 10 : null,
    por_dia: porDia,
    por_motivo: contar(casadas, (o) => o.motivo),
    por_responsavel: contar(casadas, (o) => o.responsavel),
    por_pop: contar(casadas, (o) => o.pop),
    em_aberto_lista: casadas.filter(osEstaAberta).slice(0, 15).map((o) => ({
      os: o.id, contrato: o.contrato, cliente: o.cliente, motivo: o.motivo, status: o.status,
      aberta_em: o.data_cadastro, agendada_para: o.data_agendamento || null, responsavel: o.responsavel,
    })),
  };
}

const relatorioInstalacoes: Ferramenta = {
  nome: 'relatorio_instalacoes',
  fonte: 'sgp',
  descricao:
    'Relatório de instalações num período (padrão 30 dias, máx 90): O.S. de instalação abertas, concluídas, ' +
    'pendentes, por dia, por técnico e por POP, e tempo médio até concluir. A O.S. é classificada como ' +
    'instalação pelas palavras configuradas no painel (motivo/tipo); o relatório mostra o critério e os ' +
    'motivos que ficaram de fora, para conferência.',
  parametros: {
    type: 'object',
    properties: { dias: { type: 'number', description: 'Período em dias até hoje (padrão 30, máx 90)' } },
    required: [],
  },
  async executar(args, ctx) {
    return [await medir<Record<string, unknown>>(ctx, 'sgp', 'sgp.relatorio_instalacoes', args, async () => {
      const j = janelaDias(args, 30);
      const palavras = obter<string[]>('relatorios.motivos_instalacao');
      const os = await osDaJanela(j.inicio, j.fim, palavras);
      return {
        vazio: os.casadas.length === 0,
        dados: {
          periodo: { de: diaLocal(j.inicio), ate: diaLocal(j.fim), dias: j.dias },
          instalacoes: resumoOs(os.casadas),
          criterio: { palavras, os_examinadas: os.examinadas, motivos_nao_classificados: contar(os.outras, (o) => o.motivo, 6) },
          lista_completa: os.completa,
          ...(os.completa ? {} : { aviso: 'o SGP tinha mais O.S. do que o limite de consulta: os números são parciais (mínimo)' }),
        },
      };
    })];
  },
};

const relatorioCancelamentos: Ferramenta = {
  nome: 'relatorio_cancelamentos',
  fonte: 'sgp',
  descricao:
    'Relatório de cancelamentos num período (padrão 30 dias, máx 90), por duas fontes que se ' +
    'complementam: (1) O.S. de cancelamento/retirada no SGP, com data; (2) contratos que o espelho viu ' +
    'mudar para Cancelado entre um sync e outro (a API do SGP não informa a data do cancelamento, então ' +
    'essa data é a do sync que percebeu). Traz também a foto atual de contratos por situação e motivo.',
  parametros: {
    type: 'object',
    properties: { dias: { type: 'number', description: 'Período em dias até hoje (padrão 30, máx 90)' } },
    required: [],
  },
  async executar(args, ctx) {
    const j = janelaDias(args, 30);
    const palavras = obter<string[]>('relatorios.motivos_cancelamento');

    const porOs = await medir<Record<string, unknown>>(ctx, 'sgp', 'sgp.os_cancelamento', args, async () => {
      const os = await osDaJanela(j.inicio, j.fim, palavras);
      return {
        vazio: os.casadas.length === 0,
        dados: {
          periodo: { de: diaLocal(j.inicio), ate: diaLocal(j.fim), dias: j.dias },
          os_de_cancelamento_ou_retirada: resumoOs(os.casadas),
          criterio: { palavras, os_examinadas: os.examinadas, motivos_nao_classificados: contar(os.outras, (o) => o.motivo, 6) },
          lista_completa: os.completa,
        },
      };
    });

    const porEspelho = await medir<Record<string, unknown>>(ctx, 'sgp', 'sgp.cancelamentos_espelho', args, async () => {
      const st = statusIndice();
      if (!st.disponivel) throw new Error('espelho do SGP ainda não sincronizado');
      const d = db();
      const desdeIso = j.inicio.toISOString();
      const primeiro = (d.prepare(`SELECT MIN(detectado_em) m FROM sgp_contrato_evento`).get() as { m: string | null }).m;
      const eventos = d.prepare(
        `SELECT e.contrato_id, e.de, e.para, e.motivo, e.detectado_em, c.nome
         FROM sgp_contrato_evento e LEFT JOIN sgp_cliente c ON c.cliente_id = e.cliente_id
         WHERE e.detectado_em >= ? AND e.para LIKE 'Cancel%'
         ORDER BY e.detectado_em DESC`,
      ).all(desdeIso) as Array<{ contrato_id: number; de: string | null; para: string; motivo: string | null; detectado_em: string; nome: string | null }>;
      const situacao = d.prepare(
        `SELECT COALESCE(status,'sem_dado') situacao, COALESCE(motivo_status,'—') motivo, COUNT(*) n
         FROM sgp_contrato GROUP BY 1, 2 ORDER BY n DESC`,
      ).all();

      const cobertura = !primeiro
        ? 'o espelho ainda não registrou nenhuma mudança de situação (o registro começa a partir da atualização que criou esta função)'
        : primeiro > desdeIso
          ? `registro de mudanças só existe desde ${primeiro}: o período pedido começa antes, então a contagem por espelho é parcial`
          : 'período coberto pelo registro de mudanças';

      return {
        dados: {
          cancelados_detectados_no_periodo: eventos.length,
          por_motivo: contar(eventos, (e) => e.motivo ?? undefined),
          lista: eventos.slice(0, 20).map((e) => ({ contrato: e.contrato_id, cliente: e.nome, antes: e.de, motivo: e.motivo, detectado_no_sync_de: e.detectado_em })),
          cobertura,
          situacao_atual_dos_contratos: situacao,
          origem: idadeEspelho(),
        },
      };
    });

    return [porOs, porEspelho];
  },
};

export function registrarFerramentasRelatorios(): void {
  ferramentas.registrar(clientesOnline, relatorioInstalacoes, relatorioCancelamentos);
}
