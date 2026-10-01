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
const PREFIXO_SEM_COLETA = 'ctos:sem_coleta:';
const chaveSemColeta = (id: number) => `${PREFIXO_SEM_COLETA}${id}:`;

/**
 * A série inteira é cara (varre a tabela). Para achar CTO que sumiu há mais
 * de 30 dias basta olhar de tempos em tempos, não a cada ciclo.
 */
const INTERVALO_VARREDURA_HISTORICA_MS = 6 * 3600_000;
let ultimaVarreduraHistorica = 0;
export function reiniciarVarreduraHistorica(): void { ultimaVarreduraHistorica = 0; }

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

  // ── 3. CTO que parou de ser coletada ──────────────────────────────────────
  // O aviso de coleta parada só dispara quando TUDO para. Uma CTO que some
  // sozinha passava em silêncio: a 731 ficou 73 dias fora sem ninguém saber,
  // e cada consulta sobre ela respondia "não encontrei".
  if (obter<boolean>('monitor.ctos.alertar_sem_coleta')) {
    const r = await avisarSemColeta(atuais, abertos);
    alertas += r.alertas;
    detalhe.sem_coleta = r.detalhe;
  }
  return { alertas, detalhe };
}

async function avisarSemColeta(
  atuais: CtoAtual[],
  abertos: ReturnType<typeof abertosDaOrigem>,
): Promise<{ alertas: number; detalhe: Record<string, unknown> }> {
  let alertas = 0;
  const limiteMin = obter<number>('monitor.ctos.sem_coleta_min');

  // Quem sumiu há mais de 30 dias não está em `atuais`: busca na série inteira,
  // de vez em quando.
  let universo = atuais;
  if (Date.now() - ultimaVarreduraHistorica >= INTERVALO_VARREDURA_HISTORICA_MS) {
    try {
      const historico = await questdb.ctosEmQualquerEpoca();
      const ids = new Set(atuais.map((c) => c.cto_id));
      universo = [...atuais, ...historico.filter((c) => !ids.has(c.cto_id))];
      ultimaVarreduraHistorica = Date.now();
    } catch {
      // Sem a varredura histórica, segue com a janela recente: melhor parcial que nada.
    }
  }

  const paradas = universo.filter((c) => c.idadeMin > limiteMin);
  const novas = paradas.filter((c) => !abertos.some((a) => a.chave.startsWith(chaveSemColeta(c.cto_id))));

  // Voltou a ser lida: fecha o aviso.
  let voltaram = 0;
  for (const a of abertos.filter((x) => x.chave.startsWith(PREFIXO_SEM_COLETA))) {
    const id = Number(a.chave.slice(PREFIXO_SEM_COLETA.length).split(':')[0]);
    const c = atuais.find((x) => x.cto_id === id);
    if (c && c.idadeMin <= limiteMin && marcarResolvido(a.chave)) {
      voltaram++;
      await emitir({
        origem: 'ctos', severidade: 'info', evento: true,
        titulo: `CTO voltou a ser coletada: ${c.nome}`,
        texto: `✅ *${c.nome} voltou a ser coletada*\nÚltima leitura há ${c.idadeMin} min.`,
        chave: `${a.chave}:resolvido`,
      });
      alertas++;
    }
  }

  const texto = (c: CtoAtual) =>
    `${c.nome}${c.pon ? ` (PON ${c.pon})` : ''}: sem leitura desde ${horaCurta(c.em)} (há ${duracaoHumana(c.idadeMin * 60)})` +
    (c.clientes ? `, ${c.clientes} clientes no cadastro` : '');
  const dados = (c: CtoAtual) => ({
    cto_id: c.cto_id, nome: c.nome, pon: c.pon, ultima_leitura: c.em, idade_min: c.idadeMin, clientes: c.clientes,
  });

  if (novas.length > MAX_ALERTAS_INDIVIDUAIS) {
    for (const c of novas) {
      await emitir({
        origem: 'ctos', severidade: 'aviso', titulo: `Sem coleta: ${c.nome}`,
        texto: `📡 ${texto(c)}`, chave: `${chaveSemColeta(c.cto_id)}${Date.now()}`,
        dados: dados(c), silencioso: true, motivoSemEnvio: 'agrupado na mensagem de várias CTOs sem coleta',
      });
    }
    const ordenadas = [...novas].sort((a, b) => b.idadeMin - a.idadeMin);
    const a = await emitir({
      origem: 'ctos', severidade: 'aviso', evento: true,
      titulo: `${novas.length} CTOs sem coleta`,
      texto: [
        `📡 *${novas.length} CTOs pararam de ser coletadas*`,
        'O resto da coleta está funcionando: o problema é com estas caixas, no coletor ou na OLT.',
        '',
        ...ordenadas.slice(0, 10).map((c) => `• ${texto(c)}`),
        ordenadas.length > 10 ? `… e mais ${ordenadas.length - 10}` : null,
        '',
        'Sem leitura, sinal e ocupação dessas caixas ficam desatualizados nas respostas.',
      ].filter((x) => x !== null).join('\n'),
      chave: `${PREFIXO_SEM_COLETA}grupo:${Date.now()}`,
      dados: { ctos: novas.map(dados) },
    });
    if (a) alertas++;
  } else {
    for (const c of novas) {
      const a = await emitir({
        origem: 'ctos', severidade: 'aviso',
        titulo: `Sem coleta: ${c.nome}`,
        texto: [
          `📡 *CTO parou de ser coletada — ${c.nome}*`,
          texto(c),
          'O resto da coleta está funcionando: verificar esta caixa no coletor ou na OLT.',
          linkMapa(c.lat, c.long),
        ].filter(Boolean).join('\n'),
        chave: `${chaveSemColeta(c.cto_id)}${Date.now()}`,
        dados: dados(c),
      });
      if (a) alertas++;
    }
  }

  return {
    alertas,
    detalhe: { paradas: paradas.length, novas: novas.length, voltaram, limite_min: limiteMin },
  };
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
