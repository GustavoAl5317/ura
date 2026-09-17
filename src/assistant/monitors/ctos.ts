// Monitor do sinal das CTOs (QuestDB).
//
// Dois avisos:
//   · coleta parada — sem linha nova além do limite. Sem isto, as consultas de
//     sinal responderiam com o retrato de horas atrás;
//   · sinal piorando — média recente pior que a média dos dias anteriores além
//     do limiar da CTO. Um alerta aberto por CTO; fecha quando volta para
//     menos da METADE do limiar (histerese: sem isso, a CTO que oscila em
//     cima do limiar abre e fecha alerta a cada ciclo).
//
// Muitas CTOs piorando no mesmo ciclo viram UMA mensagem agrupada por PON:
// vinte mensagens seguidas no grupo escondem o que importa, que é o tronco.

import { config } from '../../config';
import { questdb, avaliarSinal, linkMapa, Avaliacao, CtoAtual } from '../../integrations/questdb';
import { obter } from '../config-dinamica';
import { emitir, marcarResolvido, abertosDaOrigem, duracaoHumana, horaCurta } from '../alertas';
import { iniciarMonitor } from './base';

const CHAVE_PARADA = 'ctos:coleta_parada';
const PREFIXO_SINAL = 'ctos:sinal:';

/** Acima disto, os novos do ciclo saem numa mensagem só. */
export const MAX_ALERTAS_INDIVIDUAIS = 3;

const chaveSinal = (id: number) => `${PREFIXO_SINAL}${id}:`;

function linhaCto(c: CtoAtual, av: Avaliacao): string {
  return `${c.nome}${c.pon ? ` (PON ${c.pon})` : ''}: ${av.atual} dBm, ${av.variacao_db} dB pior que o normal (${av.referencia} dBm)`;
}

export async function cicloCtos(): Promise<{ alertas: number; detalhe: Record<string, unknown> }> {
  let alertas = 0;
  const detalhe: Record<string, unknown> = {};
  const abertos = abertosDaOrigem('ctos').filter((a) => !a.chave.endsWith(':resolvido'));

  // ── 1. Coleta ─────────────────────────────────────────────────────────────
  questdb.limparCache();
  const f = await questdb.frescor();
  detalhe.coleta = f.viva ? `viva (última leitura há ${f.idadeMin} min)` : `PARADA (última: ${f.ultima ?? 'nenhuma em 3 dias'})`;
  const parada = abertos.find((a) => a.chave.startsWith(`${CHAVE_PARADA}:`));
  if (!f.viva) {
    if (!parada && obter<boolean>('monitor.ctos.alertar_coleta')) {
      const a = await emitir({
        origem: 'ctos',
        severidade: 'aviso',
        titulo: 'Coleta das CTOs parada',
        texto: [
          '🛑 *Coleta de sinal das CTOs parada*',
          f.ultima ? `Última leitura: ${horaCurta(f.ultima)} (há ${f.idadeMin} min)` : 'Nenhuma leitura nos últimos 3 dias.',
          'Consultas de sinal e ocupação vão responder "sem dado" até voltar.',
          'Verificar o coletor que grava no QuestDB (10.169.0.52).',
        ].join('\n'),
        chave: `${CHAVE_PARADA}:${Date.now()}`,
        dados: { desde: new Date().toISOString(), ultima: f.ultima },
      });
      if (a) alertas++;
    }
    return { alertas, detalhe };
  }
  if (parada && marcarResolvido(parada.chave)) {
    const desde = (parada.dados as { desde?: string } | null)?.desde;
    const dur = desde ? Math.round((Date.now() - new Date(desde).getTime()) / 1000) : null;
    await emitir({
      origem: 'ctos',
      severidade: 'info',
      evento: true,
      titulo: 'Coleta das CTOs voltou',
      texto: ['✅ *Coleta de sinal das CTOs voltou*', dur !== null ? `Ficou parada por ${duracaoHumana(dur)}` : null].filter(Boolean).join('\n'),
      chave: `${parada.chave}:resolvido`,
    });
    alertas++;
  }

  // ── 2. Sinal ──────────────────────────────────────────────────────────────
  const minutos = obter<number>('monitor.ctos.janela_min');
  const dias = obter<number>('monitor.ctos.dias_referencia');
  const limiarDb = obter<number>('monitor.ctos.limiar_db');
  const critico = obter<number>('monitor.ctos.critico_db');
  const [atuais, recentes, bases] = await Promise.all([
    questdb.ctosAtuais(), questdb.recente(minutos), questdb.referencia(dias, minutos),
  ]);
  const rec = new Map(recentes.map((x) => [x.cto_id, x]));
  const bas = new Map(bases.map((x) => [x.cto_id, x]));

  const novos: Array<{ c: CtoAtual; av: Avaliacao }> = [];
  let resolvidos = 0;
  let piorando = 0;
  for (const c of atuais) {
    const av = avaliarSinal(rec.get(c.cto_id), bas.get(c.cto_id), limiarDb);
    const aberto = abertos.find((a) => a.chave.startsWith(chaveSinal(c.cto_id)));
    if (av.situacao === 'piorou') {
      piorando++;
      if (!aberto) novos.push({ c, av });
      continue;
    }
    // Sem leitura ou sem referência não fecha: não dá para dizer que normalizou.
    const normalizou = av.situacao !== 'sem_leitura' && av.situacao !== 'sem_referencia'
      && (av.variacao_db ?? 0) < av.limiar_db / 2;
    if (aberto && normalizou && marcarResolvido(aberto.chave)) {
      resolvidos++;
      const desde = (aberto.dados as { desde?: string } | null)?.desde;
      const dur = desde ? Math.round((Date.now() - new Date(desde).getTime()) / 1000) : null;
      await emitir({
        origem: 'ctos',
        severidade: 'info',
        evento: true,
        titulo: `Sinal normalizado: ${c.nome}`,
        texto: [
          `✅ *Sinal normalizado — ${c.nome}*`,
          `Agora: ${av.atual} dBm (normal ${av.referencia} dBm)`,
          dur !== null ? `Ficou degradado por ${duracaoHumana(dur)}` : null,
        ].filter(Boolean).join('\n'),
        chave: `${aberto.chave}:resolvido`,
      });
      alertas++;
    }
  }

  const agora = new Date().toISOString();
  const sev = (av: Avaliacao) => ((av.variacao_db ?? 0) >= critico ? 'critico' : 'aviso') as 'critico' | 'aviso';
  const dadosDe = (c: CtoAtual, av: Avaliacao) => ({
    cto_id: c.cto_id, nome: c.nome, pon: c.pon, desde: agora,
    atual: av.atual, referencia: av.referencia, piora_db: av.variacao_db, limiar_db: av.limiar_db,
  });

  if (novos.length > MAX_ALERTAS_INDIVIDUAIS) {
    // Cada CTO ainda ganha seu registro aberto (para fechar depois), sem envio;
    // o grupo recebe uma mensagem só.
    for (const { c, av } of novos) {
      await emitir({
        origem: 'ctos', severidade: sev(av), titulo: `Sinal pior: ${c.nome}`,
        texto: `📉 ${linhaCto(c, av)}`, chave: `${chaveSinal(c.cto_id)}${Date.now()}`,
        dados: dadosDe(c, av), silencioso: true, motivoSemEnvio: 'agrupado na mensagem de várias CTOs',
      });
    }
    const porPon = new Map<string, number>();
    for (const { c } of novos) porPon.set(c.pon ?? '?', (porPon.get(c.pon ?? '?') ?? 0) + 1);
    const pons = [...porPon.entries()].sort((a, b) => b[1] - a[1]);
    const ordenados = [...novos].sort((a, b) => (b.av.variacao_db ?? 0) - (a.av.variacao_db ?? 0));
    const a = await emitir({
      origem: 'ctos',
      severidade: ordenados.some((x) => sev(x.av) === 'critico') ? 'critico' : 'aviso',
      evento: true,
      titulo: `${novos.length} CTOs com sinal pior`,
      texto: [
        `📉 *${novos.length} CTOs com sinal pior que o normal*`,
        `Por PON: ${pons.map(([p, n]) => `PON ${p} (${n})`).join(' · ')}`,
        pons[0][1] >= 2 ? 'Várias CTOs da mesma PON: suspeitar do tronco/PON antes das CTOs.' : null,
        '',
        ...ordenados.slice(0, 10).map((x) => `• ${linhaCto(x.c, x.av)}`),
        ordenados.length > 10 ? `… e mais ${ordenados.length - 10}` : null,
      ].filter((x) => x !== null).join('\n'),
      chave: `${PREFIXO_SINAL}grupo:${Date.now()}`,
      dados: { ctos: novos.map((x) => dadosDe(x.c, x.av)) },
    });
    if (a) alertas++;
  } else {
    for (const { c, av } of novos) {
      const mapa = linkMapa(c.lat, c.long);
      const a = await emitir({
        origem: 'ctos',
        severidade: sev(av),
        titulo: `Sinal pior: ${c.nome}`,
        texto: [
          `📉 *Sinal piorando — ${c.nome}*`,
          `Agora: ${av.atual} dBm (média dos últimos ${minutos} min)`,
          `Normal: ${av.referencia} dBm (últimos ${dias} dias) · piora de ${av.variacao_db} dB`,
          [c.pon ? `PON ${c.pon}` : null, c.clientes !== null ? `${c.clientes} clientes` : null].filter(Boolean).join(' · ') || null,
          mapa,
          'Possíveis causas: fibra dobrada/rompendo, conector, splitter. Conferir antes que caia.',
        ].filter(Boolean).join('\n'),
        chave: `${chaveSinal(c.cto_id)}${Date.now()}`,
        dados: dadosDe(c, av),
      });
      if (a) alertas++;
    }
  }

  detalhe.sinal = { ctos: atuais.length, piorando, novos: novos.length, normalizados: resolvidos };
  return { alertas, detalhe };
}

export function iniciarMonitorCtos(): () => void {
  return iniciarMonitor({
    nome: 'ctos',
    descricao: 'Sinal das CTOs (QuestDB): piora contra os dias anteriores e coleta parada',
    ativo: () => config.questdb.enabled && questdb.disponivel && obter<boolean>('monitor.ctos.ativo'),
    intervaloSeg: () => obter<number>('monitor.ctos.intervalo_seg'),
    ciclo: cicloCtos,
  });
}
