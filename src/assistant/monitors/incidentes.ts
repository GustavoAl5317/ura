// Monitor dos incidentes: encerra o que já normalizou e ficou estável.
//
// O encerramento não acontece no momento em que o alerta some. O incidente
// fica em observação pelo tempo configurado, porque PON que volta e cai de
// novo em dois minutos é o mesmo problema, não dois.

import { obter } from '../config-dinamica';
import { encerrarEstaveis, listar, duracaoSeg, ROTULO_SEVERIDADE } from '../incidentes';
import { emitir, duracaoHumana } from '../alertas';
import { iniciarMonitor } from './base';

export async function cicloIncidentes(): Promise<{ alertas: number; detalhe: Record<string, unknown> }> {
  let alertas = 0;
  const fechados = encerrarEstaveis();
  for (const inc of fechados) {
    const a = await emitir({
      origem: 'sistema',
      severidade: 'info',
      evento: true,
      titulo: `Encerrado: ${inc.numero}`,
      texto: [
        `🟢 *${inc.numero} encerrado*`,
        inc.titulo,
        `Duração: ${duracaoHumana(duracaoSeg(inc))}`,
        inc.dono ? `Atendeu: ${inc.dono}` : 'Ninguém assumiu este incidente.',
        inc.reaberturas ? `Reabriu ${inc.reaberturas}x antes de estabilizar.` : null,
      ].filter(Boolean).join('\n'),
      chave: `incidente:${inc.id}:encerrado`,
      dados: { incidente: inc.numero, duracaoSeg: duracaoSeg(inc), dono: inc.dono },
    });
    if (a) alertas++;
  }

  const abertos = listar({ abertos: true, limite: 500 });
  return {
    alertas,
    detalhe: {
      abertos: abertos.length,
      sem_dono: abertos.filter((i) => !i.dono).length,
      em_observacao: abertos.filter((i) => i.estado === 'monitorando').length,
      encerrados_agora: fechados.length,
      pior: abertos.length
        ? ROTULO_SEVERIDADE[abertos.slice().sort((a, b) => (a.severidade < b.severidade ? 1 : -1))[0].severidade]
        : null,
    },
  };
}

export function iniciarMonitorIncidentes(): () => void {
  return iniciarMonitor({
    nome: 'incidentes',
    descricao: 'Encerra incidente que normalizou e ficou estável',
    ativo: () => obter<boolean>('incidentes.ativo'),
    intervaloSeg: () => obter<number>('incidentes.intervalo_seg'),
    ciclo: cicloIncidentes,
  });
}
