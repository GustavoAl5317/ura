// Monitor das regras: solta o que ficou em espera e limpa janela vencida.
//
// O debounce só faz sentido com alguém para soltar depois. É este ciclo.

import { obter } from '../config-dinamica';
import { soltarEspera } from '../alertas';
import { listar as listarManutencoes } from '../manutencao';
import { listarRegras } from '../regras';
import { iniciarMonitor } from './base';

export async function cicloRegras(): Promise<{ alertas: number; detalhe: Record<string, unknown> }> {
  const r = await soltarEspera();
  const regras = listarRegras();
  return {
    alertas: r.enviados,
    detalhe: {
      soltos: r.enviados,
      descartados_por_normalizar: r.descartados,
      regras_ativas: regras.filter((x) => x.ativo).length,
      regras_que_nunca_bateram: regras.filter((x) => !x.acionada).length,
      manutencoes_vigentes: listarManutencoes({ vigentes: true }).length,
    },
  };
}

export function iniciarMonitorRegras(): () => void {
  return iniciarMonitor({
    nome: 'regras',
    descricao: 'Solta o aviso que estava em espera e acompanha regras e manutenções',
    ativo: () => obter<boolean>('regras.ativo'),
    intervaloSeg: () => obter<number>('regras.intervalo_seg'),
    ciclo: cicloRegras,
  });
}
