// Monitor proativo do NetFlow.
//
// Três avisos, cada um com um motivo para existir:
//   · coleta parada — de 28/07 a 16/09/2026 a coleta ficou parada e ninguém
//     soube. Crítico, e resolve sozinho quando os fluxos voltam;
//   · queda brusca — tráfego abaixo do mesmo horário de ontem além do limiar
//     (sem ontem, compara com a hora anterior e diz isso). Queda de tráfego
//     costuma ser o primeiro sinal de problema no link ou no concentrador;
//   · suspeita de ataque crítica — heurística do Flow Guard, avisada como
//     suspeita, uma vez por alvo por hora.

import { config } from '../../config';
import { netflow, volumeDaJanela, formatarMbps, formatarBytes, estimar } from '../../integrations/netflow';
import { obter } from '../config-dinamica';
import { emitir, marcarResolvido, abertosDaOrigem, horaCurta, duracaoHumana } from '../alertas';
import { clientesPorIps } from '../store/sgp-index';
import { iniciarMonitor } from './base';

const CHAVE_PARADA = 'netflow:coleta_parada';
const CHAVE_QUEDA = 'netflow:queda';

function horaUtc(d = new Date()): string {
  return d.toISOString().slice(0, 13);
}

/** Um ciclo do monitor. Exportado para teste. */
export async function cicloNetflow(): Promise<{ alertas: number; detalhe: Record<string, unknown> }> {
  let alertas = 0;
  const detalhe: Record<string, unknown> = {};
  const abertos = abertosDaOrigem('netflow');
  const aberto = (prefixo: string) => abertos.find((a) => a.chave.startsWith(prefixo) && !a.chave.endsWith(':resolvido'));

  // ── 1. Coleta ─────────────────────────────────────────────────────────────
  netflow.limparCache();
  const f = await netflow.frescor();
  detalhe.coleta = f.viva
    ? `viva (${f.fluxosRecentes} fluxos amostrados em ${f.janelaMin} min)`
    : `PARADA há mais de ${f.janelaMin} min`;
  const parada = aberto(`${CHAVE_PARADA}:`);
  if (!f.viva) {
    if (!parada) {
      const a = await emitir({
        origem: 'netflow',
        severidade: 'critico',
        titulo: 'NetFlow sem dados',
        texto: [
          '🛑 *NetFlow sem dados*',
          `Nenhum fluxo recebido nos últimos ${f.janelaMin} min.`,
          'Consultas de tráfego vão responder "sem dado" até a coleta voltar.',
          'Verificar: coletor e API na flow-vm, túnel da 005-MANAGER, exportação no roteador.',
        ].join('\n'),
        chave: `${CHAVE_PARADA}:${Date.now()}`,
        dados: { desde: new Date().toISOString() },
      });
      if (a) alertas++;
    }
    // Sem fluxo não há o que comparar: as outras checagens ficam para o próximo ciclo.
    return { alertas, detalhe };
  }
  if (parada && marcarResolvido(parada.chave)) {
    const desde = (parada.dados as { desde?: string } | null)?.desde;
    const dur = desde ? Math.round((Date.now() - new Date(desde).getTime()) / 1000) : null;
    await emitir({
      origem: 'netflow',
      severidade: 'info',
      evento: true,
      titulo: 'NetFlow voltou',
      texto: ['✅ *NetFlow voltou a receber fluxos*', dur !== null ? `Ficou sem dados por ${duracaoHumana(dur)}` : null]
        .filter(Boolean).join('\n'),
      chave: `${parada.chave}:resolvido`,
    });
    alertas++;
  }

  // ── 2. Queda brusca ───────────────────────────────────────────────────────
  const fim = Math.floor(Date.now() / 1000);
  const janela = { inicio: fim - 15 * 60, fim };
  const [agora, ontem] = await Promise.all([
    volumeDaJanela(janela),
    volumeDaJanela({ inicio: janela.inicio - 86400, fim: janela.fim - 86400 }),
  ]);
  let ref = ontem;
  let refNome = 'mesmo horário de ontem';
  if (ontem.fluxos === 0) {
    ref = await volumeDaJanela({ inicio: janela.inicio - 3600, fim: janela.fim - 3600 });
    refNome = 'uma hora atrás (sem dado de ontem neste horário)';
  }
  const limiar = obter<number>('monitor.netflow.variacao_pct');
  const minimo = obter<number>('monitor.netflow.minimo_mbps');
  const quedaPct = ref.fluxos > 0 && ref.mbps > 0
    ? Math.round(((ref.mbps - agora.mbps) / ref.mbps) * 1000) / 10
    : null;
  detalhe.trafego = {
    agora: formatarMbps(agora.mbps),
    referencia: ref.fluxos ? formatarMbps(ref.mbps) : null,
    referencia_de: refNome,
    queda_pct: quedaPct,
  };

  const queda = aberto(`${CHAVE_QUEDA}:`);
  const emQueda = quedaPct !== null && ref.mbps >= minimo && quedaPct >= limiar;
  if (emQueda && !queda) {
    const a = await emitir({
      origem: 'netflow',
      severidade: quedaPct! >= Math.min(90, limiar + 30) ? 'critico' : 'aviso',
      titulo: `Tráfego caiu ${quedaPct}%`,
      texto: [
        '📉 *Queda brusca de tráfego (NetFlow)*',
        `Agora: ${formatarMbps(agora.mbps)} (últimos 15 min, estimado)`,
        `Referência: ${formatarMbps(ref.mbps)} — ${refNome}`,
        `Queda: ${quedaPct}% · desde ${horaCurta(new Date())}`,
        'Conferir links e concentradores no Zabbix.',
      ].join('\n'),
      // Única por ocorrência: "não repetir" é o alerta ABERTO. Chave por hora
      // escondia uma segunda queda na mesma hora depois da primeira resolver.
      chave: `${CHAVE_QUEDA}:${Date.now()}`,
      dados: { quedaPct, agoraMbps: agora.mbps, refMbps: ref.mbps, referencia: refNome, desde: new Date().toISOString() },
    });
    if (a) alertas++;
  } else if (!emQueda && queda && marcarResolvido(queda.chave)) {
    await emitir({
      origem: 'netflow',
      severidade: 'info',
      evento: true,
      titulo: 'Tráfego normalizado',
      texto: `✅ *Tráfego normalizado*\nAgora: ${formatarMbps(agora.mbps)} (referência ${ref.fluxos ? formatarMbps(ref.mbps) : '—'})`,
      chave: `${queda.chave}:resolvido`,
    });
    alertas++;
  }

  // ── 3. Suspeitas de ataque ────────────────────────────────────────────────
  if (obter<boolean>('monitor.netflow.alertar_ataques')) {
    const lista = (await netflow.ataques({ inicio: fim - 15 * 60, fim }, 10))
      .filter((x) => String(x.max_severity).toLowerCase() === 'critical');
    const mapa = clientesPorIps(lista.map((x) => x.victim_ip));
    detalhe.suspeitas_criticas = lista.length;
    for (const x of lista) {
      const c = mapa.get(x.victim_ip);
      const a = await emitir({
        origem: 'netflow',
        severidade: 'critico',
        evento: true,
        titulo: `Suspeita de ataque: ${x.victim_ip}`,
        texto: [
          '🛡️ *Suspeita de ataque (Flow Guard)*',
          `Alvo: ${x.victim_ip}${c ? ` — ${c.nome} (contrato ${c.contrato_id}, pelo cadastro)` : ''}`,
          `Origens distintas: ${x.unique_sources} · eventos: ${x.event_count}`,
          `Protocolos: ${(x.protocols ?? []).map((p) => p.proto).join(', ') || '—'}`,
          `Volume estimado: ${formatarBytes(estimar(x.total_bytes))} em ${Math.max(1, Math.round(x.duration_s / 60))} min`,
          'Classificação automática: confirmar antes de agir.',
        ].join('\n'),
        chave: `netflow:ataque:${x.victim_ip}:${horaUtc()}`,
        dados: { alvo: x.victim_ip, origens: x.unique_sources, eventos: x.event_count },
      });
      if (a) alertas++;
    }
  }

  return { alertas, detalhe };
}

export function iniciarMonitorNetflow(): () => void {
  return iniciarMonitor({
    nome: 'netflow',
    descricao: 'Coleta, queda brusca de tráfego e suspeitas de ataque',
    ativo: () => config.netflow.enabled && netflow.disponivel && obter<boolean>('monitor.netflow.ativo'),
    intervaloSeg: () => obter<number>('monitor.netflow.intervalo_seg'),
    ciclo: cicloNetflow,
  });
}
