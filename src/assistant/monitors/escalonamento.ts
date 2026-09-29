// Monitor do escalonamento: confere os prazos e sobe quem ninguém pegou.
//
// É o relógio que faltava. Sem ele, "o alerta foi enviado" e "alguém está
// resolvendo" continuam sendo a mesma coisa no painel.

import { obter } from '../config-dinamica';
import { escalarPendentes } from '../alertas';
import { listar } from '../incidentes';
import { situacao } from '../sla-incidente';
import { iniciarMonitor } from './base';

export async function cicloEscalonamento(): Promise<{ alertas: number; detalhe: Record<string, unknown> }> {
  const subiram = await escalarPendentes();
  const abertos = listar({ abertos: true, limite: 500 });
  const comSla = abertos.map((i) => ({ i, s: situacao(i) }));
  return {
    alertas: subiram,
    detalhe: {
      abertos: abertos.length,
      sem_reconhecer: abertos.filter((i) => !i.dono).length,
      sla_estourado: comSla.filter((x) => x.s.violados.length).length,
      escalonados_agora: subiram,
      no_degrau: abertos.filter((i) => i.degrau > 0).length,
    },
  };
}

export function iniciarMonitorEscalonamento(): () => void {
  return iniciarMonitor({
    nome: 'escalonamento',
    descricao: 'Sobe o incidente que estourou o prazo sem ninguém assumir',
    ativo: () => obter<boolean>('escalonamento.ativo'),
    intervaloSeg: () => obter<number>('escalonamento.intervalo_seg'),
    ciclo: cicloEscalonamento,
  });
}
