// Ferramenta de incidentes: o que está aberto, quem assumiu, há quanto tempo.
//
// Fonte "incidentes" é o registro da própria operação, não uma consulta a
// sistema de fora. Ela responde o que dashboard nenhum responde: quem é o dono
// e desde quando.

import {
  ABERTOS, ROTULO_ESTADO, ROTULO_SEVERIDADE, SEVERIDADES_INCIDENTE, alertasDoIncidente,
  duracaoSeg, linhaDoTempo, listar, porId, tempoAteReconhecer, Incidente,
} from '../incidentes';
import { duracaoHumana } from '../alertas';
import { obter } from '../config-dinamica';
import { Ferramenta, medir, ferramentas } from './base';

function resumo(i: Incidente) {
  return {
    numero: i.numero,
    titulo: i.titulo,
    severidade: ROTULO_SEVERIDADE[i.severidade],
    estado: ROTULO_ESTADO[i.estado],
    dono: i.dono,
    equipe: i.equipe,
    equipamento: i.equipamento,
    alvo: i.alvo,
    clientes_afetados: i.clientes_afetados,
    aberto_em: i.aberto_em,
    aberto_ha: duracaoHumana(duracaoSeg(i)),
    tempo_ate_assumir: tempoAteReconhecer(i) === null ? null : duracaoHumana(tempoAteReconhecer(i)!),
    alertas: i.alertas,
    reaberturas: i.reaberturas,
  };
}

const incidentes: Ferramenta = {
  nome: 'incidentes',
  fonte: 'incidentes',
  descricao:
    'Incidentes da operação: quais estão abertos, quais estão SEM DONO, quem assumiu, há quanto ' +
    'tempo, quantos clientes afetados e em que estado (aberto, reconhecido, em atendimento, ' +
    'monitorando normalização, encerrado). Com "numero", traz a linha do tempo e os alertas ligados. ' +
    'Responde "quais incidentes estão abertos?", "tem incidente sem responsável?", "quem está ' +
    'atendendo a OLT 3?", "o que aconteceu no INC-2026-00012?". ' +
    'Incidente é o problema consolidado; o alerta é o fato bruto que o gerou.',
  parametros: {
    type: 'object',
    properties: {
      numero: { type: 'string', description: 'Um incidente específico (ex.: INC-2026-00012)' },
      abertos: { type: 'boolean', description: 'Só os que ainda pedem alguém (padrão: true quando não vier número)' },
      sem_dono: { type: 'boolean', description: 'Só os que ninguém assumiu' },
      severidade: { type: 'string', enum: [...SEVERIDADES_INCIDENTE], description: 'Filtra por severidade' },
      limite: { type: 'number', description: 'Quantos listar (padrão 20, máx 100)' },
    },
    required: [],
  },
  async executar(args, ctx) {
    return [await medir<Record<string, unknown>>(ctx, 'incidentes', 'incidentes.listar', args, async () => {
      if (!obter<boolean>('incidentes.ativo')) {
        throw new Error('o registro de incidentes está desligado no painel: os alertas não estão sendo consolidados');
      }

      const numero = typeof args.numero === 'string' ? args.numero.trim().toUpperCase() : '';
      if (numero) {
        const i = porId(numero);
        if (!i) {
          return { vazio: true, dados: { numero, encontrado: false, instrucao: 'Número não existe. Não invente o estado dele.' } };
        }
        return {
          dados: {
            ...resumo(i),
            linha_do_tempo: linhaDoTempo(i.id).map((l) => ({ em: l.at, o_que: l.texto, quem: l.ator })),
            alertas_ligados: alertasDoIncidente(i.id).map((a) => ({
              alerta: a.titulo, severidade: a.severidade, em: a.criado_em, resolvido_em: a.resolvido_em,
            })),
          },
        };
      }

      const abertos = args.abertos !== false;
      const limite = Math.min(100, Math.max(1, Number(args.limite) || 20));
      let lista = listar({ abertos, severidade: typeof args.severidade === 'string' ? args.severidade : undefined, limite: 500 });
      if (args.sem_dono === true) lista = lista.filter((i) => !i.dono);

      const semDono = lista.filter((i) => !i.dono);
      return {
        vazio: lista.length === 0,
        dados: {
          filtro: { abertos, sem_dono: args.sem_dono === true, severidade: args.severidade ?? null },
          total: lista.length,
          sem_dono: semDono.length,
          por_estado: ABERTOS.map((e) => ({ estado: ROTULO_ESTADO[e], n: lista.filter((i) => i.estado === e).length }))
            .filter((x) => x.n > 0),
          incidentes: lista.slice(0, limite).map(resumo),
          nota: 'Incidente sem dono é incidente que ninguém assumiu — diga isso com o número, para alguém assumir.',
        },
      };
    })];
  },
};

export function registrarFerramentasIncidentes(): void {
  ferramentas.registrar(incidentes);
}
