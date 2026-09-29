// Ferramenta de plantão: de quem é a vez agora, e quem vem depois.
//
// Pergunta que nenhum dashboard responde às 3 da manhã: "quem eu chamo?".
// A resposta sai da escala cadastrada, já com folga, férias e troca aplicadas.

import {
  DIAS_SEMANA, Degrau, PlantaoEquipe, cadeia, equipePorId, listarEscalas, plantaoAgora,
  plantaoDaEquipe, rotuloEscala,
} from '../plantao';
import { obter } from '../config-dinamica';
import { Ferramenta, medir, ferramentas } from './base';

function pessoa(p: { nome: string; numero: string }) {
  return { nome: p.nome, whatsapp: p.numero.replace('@s.whatsapp.net', '').replace('@g.us', ' (grupo)') };
}

function resumo(p: PlantaoEquipe) {
  return {
    equipe: p.equipe.nome,
    regiao: p.equipe.regiao,
    de_plantao_agora: p.plantonistas.map(pessoa),
    descoberta: p.vazio,
    por_que_descoberta: p.motivo_vazio,
    turnos_agora: p.turnos.map((t) => ({ turno: t.turno.nome, de: t.turno.inicio, ate: t.turno.fim })),
    substituicoes: p.substituicoes.map((s) => ({
      saiu: s.de.nome, entrou: s.para?.nome ?? null, motivo: s.motivo, tipo: s.tipo,
    })),
    plantao_extraordinario: p.extras.map(pessoa),
    proximo_turno: p.proximo ? {
      turno: p.proximo.turno.nome,
      comeca: p.proximo.turno.inicio,
      dia_da_semana: DIAS_SEMANA[new Date(`${p.proximo.turno.dia}T00:00:00Z`).getUTCDay()],
      quem: p.proximo.plantonistas.map(pessoa),
    } : null,
    supervisor: p.equipe.supervisor ? pessoa(p.equipe.supervisor) : null,
    substituto_da_equipe: p.equipe.substituto ? pessoa(p.equipe.substituto) : null,
  };
}

function cadeiaSaida(degraus: Degrau[]) {
  return degraus.map((d, i) => ({
    ordem: i + 1, degrau: d.rotulo, quem: d.pessoas.map(pessoa),
    vazio: d.pessoas.length === 0,
  }));
}

const plantao: Ferramenta = {
  nome: 'plantao',
  fonte: 'incidentes',
  descricao:
    'Quem está de plantão agora, por equipe: nome e número de quem está na vez, qual turno, quem ' +
    'assume no próximo turno, quem está substituindo quem (folga, férias, troca) e a cadeia de ' +
    'acionamento (plantonista, substituto, supervisor, segundo nível, gerência). ' +
    'Responde "quem está de plantão?", "quem eu chamo agora?", "quem é o plantonista do NOC hoje à ' +
    'noite?", "quem assume amanhã?". ' +
    'Só sabe o que está cadastrado no painel: folga combinada no corredor e não registrada não aparece. ' +
    'Não sabe se a pessoa vai atender — sabe de quem é a vez.',
  parametros: {
    type: 'object',
    properties: {
      equipe: { type: 'string', description: 'Nome ou identificador da equipe (ex.: noc, campo). Vazio: todas.' },
      cadeia: { type: 'boolean', description: 'Traz também a cadeia de acionamento, degrau a degrau' },
      escalas: { type: 'boolean', description: 'Traz os turnos cadastrados, mesmo os que não estão acontecendo agora' },
    },
    required: [],
  },
  async executar(args, ctx) {
    return [await medir<Record<string, unknown>>(ctx, 'incidentes', 'plantao.agora', args, async () => {
      if (!obter<boolean>('plantao.ativo')) {
        throw new Error('o plantão está desligado no painel: não há escala valendo, os alertas vão para o grupo e para quem marcou o tipo');
      }

      const pedida = typeof args.equipe === 'string' ? args.equipe.trim() : '';
      let equipes: PlantaoEquipe[];
      if (pedida) {
        const alvo = equipePorId(pedida)
          ?? plantaoAgora().map((p) => p.equipe).find((e) => e.nome.toLowerCase() === pedida.toLowerCase())
          ?? plantaoAgora().map((p) => p.equipe).find((e) => e.nome.toLowerCase().includes(pedida.toLowerCase()));
        if (!alvo) {
          return { vazio: true, dados: { equipe_pedida: pedida, encontrada: false, instrucao: 'Essa equipe não existe no painel. Não invente quem está de plantão.' } };
        }
        const p = plantaoDaEquipe(alvo.id);
        equipes = p ? [p] : [];
      } else {
        equipes = plantaoAgora();
      }

      const descobertas = equipes.filter((e) => e.vazio).map((e) => e.equipe.nome);
      return {
        vazio: equipes.length === 0,
        dados: {
          agora: new Date().toISOString(),
          equipes: equipes.map(resumo),
          equipes_descobertas: descobertas,
          cadeia: args.cadeia === true && equipes.length
            ? Object.fromEntries(equipes.map((e) => [e.equipe.nome, cadeiaSaida(cadeia(e.equipe.id))]))
            : undefined,
          escalas: args.escalas === true && equipes.length
            ? Object.fromEntries(equipes.map((e) => [
              e.equipe.nome, listarEscalas(e.equipe.id).map((x) => ({ turno: rotuloEscala(x), tipo: x.tipo, ativo: x.ativo })),
            ]))
            : undefined,
          nota: equipes.length === 0
            ? 'Nenhuma equipe cadastrada no painel: não dá para dizer quem está de plantão.'
            : 'Equipe descoberta é equipe sem ninguém na vez — diga isso com o nome dela.',
        },
      };
    })];
  },
};

export function registrarFerramentasPlantao(): void {
  ferramentas.registrar(plantao);
}
