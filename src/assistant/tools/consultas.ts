// Ferramentas de consulta do assistente.
//
// Cada descrição diz também o que a ferramenta NÃO sabe. Isso não é zelo
// estilístico: é o que impede o modelo de usar a ferramenta errada e depois
// preencher a lacuna de cabeça.

import { config } from '../../config';
import { sgp } from '../../integrations/sgp';
import { zabbix, ZabbixClient } from '../../integrations/zabbix';
import { db } from '../store/db';
import { buscar, statusIndice, servicosPorCto, idadeEspelho } from '../store/sgp-index';
import { Ferramenta, medir, ferramentas } from './base';
import { Envelope } from '../types';

// ─── SGP: identificar o cliente ──────────────────────────────────────────────

const localizarCliente: Ferramenta = {
  nome: 'localizar_cliente',
  fonte: 'sgp',
  descricao:
    'Localiza clientes no espelho local do SGP a partir de um termo livre: SN da ONU, nome, ' +
    'CPF/CNPJ, login PPPoE, MAC, IP ou número do contrato. Devolve candidatos com contrato_id, ' +
    'que é o que as outras ferramentas exigem. ATENÇÃO: os campos rx/tx e conexão aqui são do ' +
    'último sync noturno, NÃO são valor vivo — para sinal e status atuais use revisao_cliente. ' +
    'Quando casouPor for "texto", pode haver homônimo: confirme com o operador antes de afirmar ' +
    'qualquer coisa sobre o cliente. Lista vazia significa que não existe no espelho — não invente.',
  parametros: {
    type: 'object',
    properties: {
      termo: { type: 'string', description: 'SN, nome, CPF, login, MAC, IP ou contrato' },
      limite: { type: 'number', description: 'Máximo de candidatos (padrão 8)' },
    },
    required: ['termo'],
  },
  async executar(args, ctx) {
    const termo = String(args.termo ?? '').trim();
    const limite = Math.min(20, Number(args.limite) || 8);

    return [
      await medir(ctx, 'sgp', 'sgp.localizar_cliente', { termo, limite }, async () => {
        const st = statusIndice();
        if (!st.disponivel) {
          throw new Error('espelho do SGP ainda não sincronizado — busca por nome/SN indisponível');
        }
        const achados = buscar(termo, limite);
        return {
          dados: {
            termo,
            candidatos: achados,
            origem: idadeEspelho(),
          },
          vazio: achados.length === 0,
        };
      }),
    ];
  },
};

// ─── Macro: revisão completa do cliente ──────────────────────────────────────

const revisaoCliente: Ferramenta = {
  nome: 'revisao_cliente',
  fonte: 'sgp',
  descricao:
    'Revisão completa de UM contrato, cruzando SGP e Zabbix AO VIVO: ONU (SN, RX/TX atuais), ' +
    'status de conexão e última autenticação, CTO/OLT/PON, incidentes que afetam a infraestrutura ' +
    'dele, histórico de quedas com quantidade e duração, e manutenções programadas. ' +
    'Exige contrato_id — obtenha antes com localizar_cliente. Cada fonte responde separadamente: ' +
    'se uma falhar, as outras ainda valem, e a que falhou aparece como indisponível.',
  parametros: {
    type: 'object',
    properties: {
      contrato_id: { type: 'number', description: 'ID do contrato no SGP' },
      horas_historico: { type: 'number', description: 'Janela do histórico de quedas em horas (padrão 24)' },
    },
    required: ['contrato_id'],
  },
  async executar(args, ctx) {
    const contratoId = Number(args.contrato_id);
    const horas = Math.min(720, Number(args.horas_historico) || 24);
    const envelopes: Envelope[] = [];

    // 1. Cadastro do espelho — identidade, CTO, OLT. Barato e local.
    const cadastro = buscar(String(contratoId), 5).filter((r) => r.contratoId === contratoId);
    envelopes.push(
      await medir(ctx, 'sgp', 'sgp.cadastro_espelho', { contrato_id: contratoId }, async () => ({
        dados: { contrato: cadastro[0] ?? null, origem: idadeEspelho() },
        vazio: cadastro.length === 0,
      })),
    );

    // 2. ONU ao vivo — este é o RX/TX que pode ser afirmado como "agora".
    envelopes.push(
      await medir(ctx, 'sgp', 'sgp.onu_ao_vivo', { contrato_id: contratoId }, async () => {
        const onu = await sgp.onuDoContrato(contratoId, { fullFttx: true });
        if (!onu) return null;
        return {
          dados: {
            sn: onu.serial,
            rx_dbm: onu.rx,
            tx_dbm: onu.tx,
            olt: onu.olt_nome,
            slot: onu.slot,
            pon: onu.pon,
            cto: onu.cto_nome ?? onu.caixa ?? null,
            conexao: onu.conexao,
            medido_em: new Date().toISOString(),
          },
        };
      }),
    );

    // Termos de infraestrutura para correlacionar no Zabbix.
    const alvo = cadastro[0];
    const termos = [alvo?.ctoNome, alvo?.oltNome, alvo?.login, alvo?.sn]
      .filter((t): t is string => !!t);

    if (config.zabbix.enabled && termos.length) {
      // 3. Incidentes abertos que afetam a infra deste cliente.
      envelopes.push(
        await medir(ctx, 'zabbix', 'zabbix.diagnostico_cliente', { termos }, async () => {
          const d = await zabbix.diagnosticar(termos);
          if (d.erro) throw new Error(d.erro);
          return { dados: d, vazio: !d.temIncidente };
        }),
      );

      // 4. Histórico de quedas — quantidade e duração, não impressão.
      envelopes.push(
        await medir(ctx, 'zabbix', 'zabbix.historico_quedas', { termos, horas }, async () => {
          const quedas = await zabbix.historicoEventos(termos, horas);
          const resolvidas = quedas.filter((q) => q.duracaoSeg !== null);
          const somaSeg = resolvidas.reduce((a, q) => a + (q.duracaoSeg ?? 0), 0);
          return {
            dados: {
              janela_horas: horas,
              total_quedas: quedas.length,
              em_curso: quedas.filter((q) => q.emCurso).length,
              indisponibilidade_total_seg: somaSeg,
              duracao_media_seg: resolvidas.length ? Math.round(somaSeg / resolvidas.length) : null,
              quedas,
            },
            vazio: quedas.length === 0,
          };
        }),
      );
    } else if (termos.length === 0) {
      envelopes.push(
        await medir(ctx, 'zabbix', 'zabbix.diagnostico_cliente', { contrato_id: contratoId }, async () => {
          throw new Error(
            'sem CTO/OLT/login no espelho para este contrato — não há como correlacionar no Zabbix',
          );
        }),
      );
    }

    // 5. Manutenção programada que possa explicar o problema.
    envelopes.push(
      await medir(ctx, 'sgp', 'sgp.manutencoes_ativas', {}, async () => {
        const ms = await sgp.manutencoesAtivas();
        return { dados: ms, vazio: !ms.length };
      }),
    );

    return envelopes;
  },
};

// ─── Zabbix ──────────────────────────────────────────────────────────────────

const zabbixProblemas: Ferramenta = {
  nome: 'zabbix_problemas',
  fonte: 'zabbix',
  descricao:
    'Incidentes ABERTOS AGORA no Zabbix (CTO off, queda de PPPoE, POP, interface, energia). ' +
    'Não traz histórico: para "quantas vezes caiu" use zabbix_historico_quedas. ' +
    'Sem filtro, usa os padrões de trigger configurados para a operação.',
  parametros: {
    type: 'object',
    properties: {
      filtro: {
        type: 'string',
        description: 'Texto no nome do trigger, ex.: "CTO", "PPPoE", "POP". Opcional.',
      },
      host: { type: 'string', description: 'Restringe a um host/equipamento. Opcional.' },
    },
    required: [],
  },
  async executar(args, ctx) {
    const filtro = args.filtro ? String(args.filtro) : null;
    const host = args.host ? String(args.host) : null;

    return [
      await medir(ctx, 'zabbix', 'zabbix.problemas', { filtro, host }, async () => {
        if (!config.zabbix.enabled) throw new Error('Zabbix desabilitado na configuração');
        const padroes = filtro ? [filtro] : config.zabbix.searchPatterns;
        const brutos = await zabbix.problemasPorPadroes(padroes, host ? [host] : undefined);
        const incidentes = brutos.map((p) => {
          const h = p.hosts?.[0];
          return {
            eventid: p.eventid,
            nome: p.name,
            severidade: parseInt(p.severity, 10) || 0,
            host: h?.host ?? '',
            hostVisivel: h?.name ?? '',
            tipo: ZabbixClient.classificar(p.name, h?.name ?? ''),
            desde: new Date(parseInt(p.clock, 10) * 1000).toISOString(),
          };
        });
        return { dados: { total: incidentes.length, incidentes }, vazio: incidentes.length === 0 };
      }),
    ];
  },
};

const zabbixHistorico: Ferramenta = {
  nome: 'zabbix_historico_quedas',
  fonte: 'zabbix',
  descricao:
    'Histórico de quedas de um host/CTO/OLT numa janela de horas, com quantidade, duração de ' +
    'cada uma e tempo total de indisponibilidade. Queda ainda em curso vem com duração nula — ' +
    'nunca some duração de evento em curso como se estivesse fechado. ' +
    'CRÍTICO: se vier total_quedas 0 COM o campo "sugestoes" preenchido, o nome usado na busca ' +
    'não existe no Zabbix — NÃO responda "não houve queda". Diga que não encontrou esse nome, ' +
    'mostre as sugestões e pergunte qual é. Só afirme ausência de queda quando "sugestoes" ' +
    'vier vazio, e mesmo assim diga que é ausência de registro para o termo consultado.',
  parametros: {
    type: 'object',
    properties: {
      alvo: { type: 'string', description: 'Nome do host, CTO ou OLT no Zabbix' },
      horas: { type: 'number', description: 'Janela em horas (padrão 24, máx 720)' },
    },
    required: ['alvo'],
  },
  async executar(args, ctx) {
    const alvo = String(args.alvo ?? '').trim();
    const horas = Math.min(720, Number(args.horas) || 24);

    return [
      // Genérico explícito: os dois caminhos (com quedas e sem) devolvem formatos
      // diferentes de `dados`, e a inferência trava no primeiro que enxerga.
      await medir<Record<string, unknown>>(ctx, 'zabbix', 'zabbix.historico_quedas', { alvo, horas }, async () => {
        if (!config.zabbix.enabled) throw new Error('Zabbix desabilitado na configuração');
        const quedas = await zabbix.historicoEventos([alvo], horas);

        // Zero quedas é ambíguo: pode ser rede saudável ou nome errado. Só dá
        // para afirmar ausência depois de conferir que o nome sequer existe.
        if (!quedas.length) {
          const sugestoes = await zabbix.nomesSemelhantes(alvo, horas);
          return {
            dados: {
              alvo,
              janela_horas: horas,
              total_quedas: 0,
              sugestoes,
              interpretacao: sugestoes.length
                ? 'NENHUM alerta com esse nome foi encontrado, mas existem nomes parecidos. ' +
                  'Isso indica nome errado na busca, NÃO ausência de queda. Pergunte qual é o certo.'
                : 'Nenhum alerta com esse nome nem parecido na janela. Ausência de REGISTRO ' +
                  'para o termo consultado — diga isso, e não "a rede está boa".',
            },
            vazio: true,
          };
        }

        const resolvidas = quedas.filter((q) => q.duracaoSeg !== null);
        const somaSeg = resolvidas.reduce((a, q) => a + (q.duracaoSeg ?? 0), 0);
        return {
          dados: {
            alvo,
            janela_horas: horas,
            total_quedas: quedas.length,
            em_curso: quedas.filter((q) => q.emCurso).length,
            indisponibilidade_total_seg: somaSeg,
            quedas,
          },
        };
      }),
    ];
  },
};

// ─── Panorama a partir do espelho ────────────────────────────────────────────

const panoramaRede: Ferramenta = {
  nome: 'panorama_rede',
  fonte: 'sgp',
  descricao:
    'Contagem de clientes por status de conexão e de contratos por situação, a partir do espelho ' +
    'local. IMPORTANTE: é a foto do último sync, não é tempo real — sempre informe a idade do dado ' +
    'ao responder. Para o estado AGORA de um cliente específico, use revisao_cliente.',
  parametros: { type: 'object', properties: {}, required: [] },
  async executar(_args, ctx) {
    return [
      await medir(ctx, 'sgp', 'sgp.panorama_espelho', {}, async () => {
        const st = statusIndice();
        if (!st.disponivel) throw new Error('espelho do SGP ainda não sincronizado');

        const d = db();
        const conexao = d.prepare(
          `SELECT COALESCE(conexao_status,'sem_dado') st, COUNT(*) n
           FROM sgp_servico GROUP BY 1 ORDER BY n DESC`,
        ).all() as Array<{ st: string; n: number }>;
        const contratos = d.prepare(
          `SELECT COALESCE(status,'sem_dado') st, COUNT(*) n
           FROM sgp_contrato GROUP BY 1 ORDER BY n DESC`,
        ).all() as Array<{ st: string; n: number }>;

        return {
          dados: {
            por_conexao: conexao,
            por_situacao_contrato: contratos,
            total_clientes: st.clientes,
            total_servicos: st.servicos,
            servicos_com_onu: st.comSn,
            origem: idadeEspelho(),
            ultimo_sync: st.ultimoSync,
          },
        };
      }),
    ];
  },
};

const ctosSinalRuim: Ferramenta = {
  nome: 'ctos_sinal_ruim',
  fonte: 'sgp',
  descricao:
    'CTOs com clientes em sinal óptico ruim, do espelho local. RX abaixo do limite (padrão -25 dBm) ' +
    'indica atenuação. Foto do último sync, não é tempo real — diga isso ao responder. ' +
    'Para confirmar uma CTO específica agora, faça revisao_cliente de um cliente dela.',
  parametros: {
    type: 'object',
    properties: {
      limite_dbm: { type: 'number', description: 'RX abaixo disso conta como ruim (padrão -25)' },
      minimo_clientes: { type: 'number', description: 'Só CTOs com pelo menos N afetados (padrão 1)' },
    },
    required: [],
  },
  async executar(args, ctx) {
    const limiteDbm = Number(args.limite_dbm ?? -25);
    const minClientes = Math.max(1, Number(args.minimo_clientes) || 1);

    return [
      await medir(ctx, 'sgp', 'sgp.ctos_sinal_ruim', { limiteDbm, minClientes }, async () => {
        const st = statusIndice();
        if (!st.disponivel) throw new Error('espelho do SGP ainda não sincronizado');

        const linhas = db().prepare(
          `SELECT cto_nome, olt_nome,
                  COUNT(*) total,
                  SUM(CASE WHEN rx < ? THEN 1 ELSE 0 END) ruins,
                  ROUND(MIN(rx), 2) pior_rx, ROUND(AVG(rx), 2) media_rx
           FROM sgp_servico
           WHERE cto_nome IS NOT NULL AND rx IS NOT NULL
           GROUP BY cto_nome, olt_nome
           HAVING ruins >= ?
           ORDER BY ruins DESC, pior_rx ASC
           LIMIT 50`,
        ).all(limiteDbm, minClientes) as Array<Record<string, unknown>>;

        return {
          dados: { limite_dbm: limiteDbm, ctos: linhas, origem: idadeEspelho() },
          vazio: linhas.length === 0,
        };
      }),
    ];
  },
};

const clientesDaCto: Ferramenta = {
  nome: 'clientes_da_cto',
  fonte: 'sgp',
  descricao:
    'Lista os clientes atendidos por uma CTO, com sinal do último sync. Use para dimensionar ' +
    'quantos são afetados por um incidente naquela CTO.',
  parametros: {
    type: 'object',
    properties: { cto: { type: 'string', description: 'Nome exato da CTO, ex.: "CTO 4 RUA 731, 310"' } },
    required: ['cto'],
  },
  async executar(args, ctx) {
    const cto = String(args.cto ?? '').trim();
    return [
      await medir(ctx, 'sgp', 'sgp.clientes_da_cto', { cto }, async () => {
        const lista = servicosPorCto(cto);
        return {
          dados: { cto, total: lista.length, clientes: lista, origem: idadeEspelho() },
          vazio: lista.length === 0,
        };
      }),
    ];
  },
};

const manutencoes: Ferramenta = {
  nome: 'manutencoes_programadas',
  fonte: 'sgp',
  descricao:
    'Manutenções e massivas ativas cadastradas no SGP. Consulte antes de concluir que um problema ' +
    'é isolado do cliente — pode ser janela programada.',
  parametros: { type: 'object', properties: {}, required: [] },
  async executar(_args, ctx) {
    return [
      await medir(ctx, 'sgp', 'sgp.manutencoes_ativas', {}, async () => {
        const ms = await sgp.manutencoesAtivas();
        return { dados: { total: ms.length, manutencoes: ms }, vazio: !ms.length };
      }),
    ];
  },
};

export function registrarFerramentas(): void {
  ferramentas.registrar(
    localizarCliente,
    revisaoCliente,
    zabbixProblemas,
    zabbixHistorico,
    panoramaRede,
    ctosSinalRuim,
    clientesDaCto,
    manutencoes,
  );
}
