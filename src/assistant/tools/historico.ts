// Ferramenta de histórico: o que vive acontecendo, não o que está acontecendo.
//
// Existe porque a pergunta que muda decisão é a repetida: "essa PON já caiu
// quantas vezes esse mês?". Sem isso, todo incidente parece o primeiro.

import { duracaoHumana } from '../alertas';
import { ROTULO_ESTADO, ROTULO_SEVERIDADE } from '../incidentes';
import { buscar, metricas, posDoIncidente, recorrencia } from '../historico';
import { obter } from '../config-dinamica';
import { Ferramenta, medir, ferramentas } from './base';

const historico: Ferramenta = {
  nome: 'historico_incidentes',
  fonte: 'incidentes',
  descricao:
    'Histórico de incidentes já encerrados e em aberto, por PON, CTO, equipamento, região, equipe ' +
    'e período. Traz também o que mais repete e as médias da operação: MTTD (do primeiro alerta até ' +
    'o incidente existir), MTTA (até alguém assumir), MTTR (até normalizar), violação de SLA, taxa de ' +
    'reconhecimento, de reabertura e de falso positivo. ' +
    'Responde "quantas vezes a PON 3 caiu nos últimos 30 dias?", "qual equipamento mais quebra?", ' +
    '"quanto tempo a equipe leva para assumir?", "essa CTO é recorrente?". ' +
    'Não sabe a causa de nada: causa só existe quando alguém escreveu o pós-incidente.',
  parametros: {
    type: 'object',
    properties: {
      pon: { type: 'string', description: 'Número da PON (ex.: 3)' },
      cto: { type: 'string', description: 'Nome ou trecho do nome da CTO' },
      equipamento: { type: 'string', description: 'Nome do equipamento ou OLT' },
      regiao: { type: 'string', description: 'Cidade, bairro ou região' },
      equipe: { type: 'string', description: 'Identificador da equipe' },
      severidade: { type: 'string', description: 'Severidade do incidente' },
      dias: { type: 'number', description: 'Janela em dias (padrão 30, máx 365)' },
      recorrencia: { type: 'boolean', description: 'Traz o ranking do que mais repete' },
      limite: { type: 'number', description: 'Quantos incidentes listar (padrão 20)' },
    },
    required: [],
  },
  async executar(args, ctx) {
    return [await medir<Record<string, unknown>>(ctx, 'incidentes', 'incidentes.historico', args, async () => {
      if (!obter<boolean>('incidentes.ativo')) {
        throw new Error('o registro de incidentes está desligado no painel: não há histórico sendo formado');
      }
      const dias = Math.min(365, Math.max(1, Number(args.dias) || 30));
      const filtro = {
        pon: typeof args.pon === 'string' ? args.pon : undefined,
        cto: typeof args.cto === 'string' ? args.cto : undefined,
        equipamento: typeof args.equipamento === 'string' ? args.equipamento : undefined,
        regiao: typeof args.regiao === 'string' ? args.regiao : undefined,
        equipe: typeof args.equipe === 'string' ? args.equipe : undefined,
        severidade: typeof args.severidade === 'string' ? args.severidade : undefined,
        dias,
      };
      const lista = buscar({ ...filtro, limite: 500 });
      const m = metricas(filtro);
      const limite = Math.min(100, Math.max(1, Number(args.limite) || 20));

      return {
        vazio: lista.length === 0,
        dados: {
          janela_dias: dias,
          filtro,
          total: lista.length,
          medias: {
            mttd: m.mttd_seg === null ? null : duracaoHumana(m.mttd_seg),
            mtta: m.mtta_seg === null ? null : duracaoHumana(m.mtta_seg),
            mttr: m.mttr_seg === null ? null : duracaoHumana(m.mttr_seg),
            o_que_significam: 'MTTD: do primeiro alerta até o incidente existir (mede o pipeline, não o instante real da falha). MTTA: até alguém assumir. MTTR: até normalizar.',
          },
          taxas: {
            reconhecimento_pct: m.taxa_reconhecimento,
            violacao_sla_pct: m.taxa_violacao_sla,
            reabertura_pct: m.taxa_reabertura,
            falso_positivo_pct: m.taxa_falso_positivo,
          },
          por_severidade: m.por_severidade,
          incidentes: lista.slice(0, limite).map((i) => ({
            numero: i.numero,
            titulo: i.titulo,
            severidade: ROTULO_SEVERIDADE[i.severidade],
            estado: ROTULO_ESTADO[i.estado],
            alvo: i.alvo,
            equipamento: i.equipamento,
            clientes_afetados: i.clientes_afetados,
            aberto_em: i.aberto_em,
            encerrado_em: i.encerrado_em,
            dono: i.dono,
            reaberturas: i.reaberturas,
            causa_raiz: posDoIncidente(i.id)?.causa_raiz ?? null,
          })),
          mais_repetem: args.recorrencia === false ? undefined : recorrencia({ ...filtro, limite: 10 }).map((r) => ({
            alvo: r.rotulo,
            vezes: r.incidentes,
            tempo_total: duracaoHumana(r.tempo_total_seg),
            reaberturas: r.reaberturas,
            ultima_vez: r.ultima_vez,
          })),
          nota: 'Causa raiz só aparece quando alguém escreveu o pós-incidente. Sem ela, não afirme por que aconteceu.',
        },
      };
    })];
  },
};

export function registrarFerramentasHistorico(): void {
  ferramentas.registrar(historico);
}
