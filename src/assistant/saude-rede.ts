// Leitura gerencial da rede: de número técnico para "como está".
//
// O gestor não pergunta "qual o RX médio da CTO 7". Pergunta "como está a rede
// no Henrique Jorge?" — e a resposta útil tem quatro partes: um veredito
// (saudável, ponto de atenção, em degradação, crítico), o motivo, o impacto em
// clientes e o que fazer. Os números continuam aparecendo; isto é o que vem
// DEPOIS deles.
//
// O nível é CALCULADO aqui, não escrito pelo modelo. Mesma tese do resto do
// assistente: o modelo redige, o código decide. Um "está saudável" inventado
// sobre uma região que ninguém mediu é o pior erro possível para um gestor,
// porque ele para de olhar.
//
// A régua de sinal é a MESMA do monitor de CTOs (avaliarSinal): cada caixa é
// comparada com o normal dela mesma, não com um número fixo. Caixa longe da
// OLT sempre teve sinal mais fraco e não está "pior" por isso.

import { db } from './store/db';
import { obter } from './config-dinamica';
import {
  questdb, avaliarSinal, CtoAtual, SINAL_RUIM_DBM, Avaliacao, BaseSinal, RecenteSinal,
} from '../integrations/questdb';
import { ABERTOS, Incidente, ROTULO_SEVERIDADE, SEVERIDADES_INCIDENTE, listar as listarIncidentes } from './incidentes';
import { bairrosDasCtos, filtrarPorLugar } from './geografia';

export const NIVEIS = ['saudavel', 'atencao', 'degradacao', 'critico', 'sem_base'] as const;
export type Nivel = (typeof NIVEIS)[number];

export const ROTULO_NIVEL: Record<Nivel, string> = {
  saudavel: 'Saudável',
  atencao: 'Ponto de atenção',
  degradacao: 'Em degradação',
  critico: 'Crítico',
  sem_base: 'Sem base para avaliar',
};

/** Ordem de gravidade. "Sem base" não é melhor nem pior: é desconhecido. */
const PESO: Record<Nivel, number> = { sem_base: -1, saudavel: 0, atencao: 1, degradacao: 2, critico: 3 };

/**
 * Do que se trata o motivo. Separa SAÚDE (sinal, queda) de CAPACIDADE
 * (lotação) e de MONITORAMENTO (sem leitura): para o gestor, "40 pontos de
 * atenção" sem dizer que 32 são caixa cheia soa como rede quebrada.
 */
export type Causa =
  | 'incidente_grave' | 'incidente' | 'piora_forte' | 'piora' | 'inicio_piora' | 'sinal_fraco'
  | 'recorrencia' | 'queda_recente' | 'lotada' | 'quase_lotada' | 'sem_leitura';

export interface Motivo {
  nivel: Nivel;
  causa: Causa;
  texto: string;
  fazer: string;
}

export interface SaudeCto {
  cto_id: number;
  nome: string;
  pon: string | null;
  nivel: Nivel;
  rotulo: string;
  motivos: string[];
  o_que_fazer: string[];
  clientes: number | null;
  sinal_atual_dbm: number | null;
  sinal_normal_dbm: number | null;
  piora_db: number | null;
  ocupacao_pct: number | null;
  sem_leitura_recente: boolean;
  leitura_ha_min: number;
  incidentes_abertos: string[];
  quedas_30_dias: number;
  /** Quando o problema mais antigo ainda aberto começou. */
  desde: string | null;
  causas: Causa[];
}

export interface Limiares {
  limiarDb: number;
  criticoDb: number;
  ocupacaoAtencaoPct: number;
  quedasRecorrentes: number;
}

export interface IncidenteResumo {
  numero: string;
  severidade: string;
  aberto_em: string;
  dono: string | null;
}

/** Lotada e quase lotada pedem a mesma coisa: uma ação só, não duas parecidas. */
const FAZER_AMPLIAR = 'planejar ampliação das caixas cheias ou caixa nova no trecho, antes de faltar porta para venda';

/**
 * Classifica UMA caixa. Função pura: recebe tudo pronto e devolve nível,
 * motivos e ação. É aqui que mora a regra, e é ela que os testes travam.
 */
export function classificarCto(e: {
  cto: CtoAtual;
  avaliacao: Avaliacao;
  incidentes: IncidenteResumo[];
  quedas30: number;
  limiares: Limiares;
}): SaudeCto {
  const { cto: c, avaliacao: a, limiares: L } = e;
  const motivos: Motivo[] = [];
  const graves = e.incidentes.filter((i) => SEVERIDADES_INCIDENTE.indexOf(i.severidade as never) >= SEVERIDADES_INCIDENTE.indexOf('critico'));

  // Incidente aberto pesa mais que qualquer medição: alguém já viu o problema.
  for (const i of graves) {
    motivos.push({
      nivel: 'critico',
      causa: 'incidente_grave',
      texto: `incidente ${i.numero} aberto (${ROTULO_SEVERIDADE[i.severidade as keyof typeof ROTULO_SEVERIDADE] ?? i.severidade})`,
      fazer: i.dono ? `acompanhar o atendimento do ${i.numero} (com ${i.dono})` : `garantir que alguém assuma o ${i.numero}: está sem dono`,
    });
  }
  for (const i of e.incidentes.filter((x) => !graves.includes(x))) {
    motivos.push({
      nivel: 'atencao',
      causa: 'incidente',
      texto: `incidente ${i.numero} aberto`,
      fazer: i.dono ? `acompanhar o ${i.numero}` : `garantir que alguém assuma o ${i.numero}`,
    });
  }

  // Sinal comparado com o normal DESTA caixa.
  const piora = a.situacao === 'piorou' || (a.variacao_db !== null && a.variacao_db > 0) ? a.variacao_db : null;
  if (a.situacao === 'piorou' && piora !== null && piora >= Math.max(L.criticoDb, a.limiar_db)) {
    motivos.push({
      nivel: 'critico',
      causa: 'piora_forte',
      texto: `sinal da fibra ${fmt(piora)} dB pior que o normal desta caixa: queda forte`,
      fazer: 'vistoriar a caixa e o trecho de fibra agora: piora desse tamanho costuma virar queda',
    });
  } else if (a.situacao === 'piorou' && piora !== null) {
    motivos.push({
      nivel: 'degradacao',
      causa: 'piora',
      texto: `sinal da fibra ${fmt(piora)} dB pior que o normal desta caixa`,
      fazer: 'vistoriar conector, emenda e dobra de fibra no trecho antes que vire queda',
    });
  } else if (piora !== null && piora >= a.limiar_db / 2) {
    motivos.push({
      nivel: 'atencao',
      causa: 'inicio_piora',
      texto: `sinal começando a piorar (${fmt(piora)} dB abaixo do normal)`,
      fazer: 'acompanhar nas próximas horas; se continuar caindo, vistoriar',
    });
  }

  if (a.atual !== null && a.atual <= SINAL_RUIM_DBM) {
    motivos.push({
      nivel: 'degradacao',
      causa: 'sinal_fraco',
      texto: `sinal da fibra muito fraco (${fmt(a.atual)} dBm), abaixo do aceitável mesmo para esta caixa`,
      fazer: 'medir o trecho: sinal assim deixa cliente lento ou caindo',
    });
  }

  if (e.quedas30 >= L.quedasRecorrentes) {
    motivos.push({
      nivel: 'degradacao',
      causa: 'recorrencia',
      texto: `caiu ${e.quedas30} vezes nos últimos 30 dias: o problema volta`,
      fazer: 'tratar a causa de fundo: queda repetida no mesmo lugar é defeito físico não resolvido',
    });
  } else if (e.quedas30 > 0) {
    motivos.push({
      nivel: 'atencao',
      causa: 'queda_recente',
      texto: `${e.quedas30 === 1 ? 'teve 1 queda' : `teve ${e.quedas30} quedas`} nos últimos 30 dias`,
      fazer: 'conferir se a causa da última queda foi registrada',
    });
  }

  if (c.ocupacao !== null && c.ocupacao >= 100) {
    motivos.push({
      nivel: 'atencao',
      causa: 'lotada',
      texto: 'caixa lotada: não cabe cliente novo',
      fazer: FAZER_AMPLIAR,
    });
  } else if (c.ocupacao !== null && c.ocupacao >= L.ocupacaoAtencaoPct) {
    motivos.push({
      nivel: 'atencao',
      causa: 'quase_lotada',
      texto: `caixa ${fmt(c.ocupacao)}% ocupada: pouco espaço para cliente novo`,
      fazer: FAZER_AMPLIAR,
    });
  }

  if (c.semLeituraRecente) {
    motivos.push({
      nivel: 'atencao',
      causa: 'sem_leitura',
      texto: `sem leitura há ${tempo(c.idadeMin)}: não dá para afirmar como está (ponto cego)`,
      fazer: 'conferir por que o monitoramento parou de ler esta caixa',
    });
  }

  let nivel: Nivel;
  if (motivos.length) {
    nivel = motivos.reduce<Nivel>((pior, m) => (PESO[m.nivel] > PESO[pior] ? m.nivel : pior), 'saudavel');
  } else {
    // Nada de errado só vale como "saudável" quando houve como medir.
    nivel = a.situacao === 'estavel' || a.situacao === 'melhorou' ? 'saudavel' : 'sem_base';
  }

  const ordenados = [...motivos].sort((x, y) => PESO[y.nivel] - PESO[x.nivel]);
  const desde = e.incidentes.map((i) => i.aberto_em).sort()[0] ?? null;

  return {
    cto_id: c.cto_id,
    nome: c.nome,
    pon: c.pon,
    nivel,
    rotulo: ROTULO_NIVEL[nivel],
    motivos: ordenados.map((m) => m.texto),
    o_que_fazer: [...new Set(ordenados.map((m) => m.fazer))],
    clientes: c.clientes,
    sinal_atual_dbm: a.atual,
    sinal_normal_dbm: a.referencia,
    piora_db: piora === null ? null : Math.round(piora * 100) / 100,
    ocupacao_pct: c.ocupacao,
    sem_leitura_recente: c.semLeituraRecente,
    leitura_ha_min: c.idadeMin,
    incidentes_abertos: e.incidentes.map((i) => i.numero),
    quedas_30_dias: e.quedas30,
    desde,
    causas: [...new Set(ordenados.map((m) => m.causa))],
  };
}

export interface LeituraGerencial {
  alvo: string;
  nivel: Nivel;
  rotulo: string;
  /** A frase que o gestor lê primeiro. */
  resumo: string;
  motivo: string;
  impacto: {
    caixas: number;
    caixas_avaliadas: number;
    caixas_sem_base: number;
    clientes: number;
    clientes_em_risco: number;
    clientes_com_atencao: number;
  };
  desde: string | null;
  desde_explicacao: string;
  o_que_fazer: string[];
  contagem: Record<Nivel, number>;
  pontos_de_atencao: SaudeCto[];
  regua: { janela_min: number; dias_referencia: number; limiar_db: number; critico_db: number; degradacao_pct: number };
}

const fmt = (x: number) => (Math.round(x * 10) / 10).toString().replace('.', ',');

function tempo(min: number): string {
  if (min < 120) return `${min} min`;
  if (min < 2880) return `${Math.round(min / 60)} h`;
  return `${Math.round(min / 1440)} dias`;
}

const plural = (n: number, um: string, varios: string) => `${n} ${n === 1 ? um : varios}`;

/**
 * Junta as caixas de um lugar numa leitura só. A região não herda o pior
 * caso de UMA caixa sem critério: uma caixa em degradação num bairro de 40 é
 * ponto de atenção do bairro; 10% delas, ou clientes demais em risco, é
 * degradação do bairro. Crítico de uma caixa é crítico do lugar, porque
 * crítico já é cliente parado.
 */
export function consolidar(alvo: string, caixas: SaudeCto[], opts: {
  degradacaoPct: number; clientesParaDegradacao: number; regua: LeituraGerencial['regua'];
}): LeituraGerencial {
  const contagem = Object.fromEntries(NIVEIS.map((n) => [n, 0])) as Record<Nivel, number>;
  for (const c of caixas) contagem[c.nivel]++;

  const avaliadas = caixas.length - contagem.sem_base;
  const soma = (l: SaudeCto[]) => l.reduce((a, c) => a + (c.clientes ?? 0), 0);
  const emRisco = caixas.filter((c) => c.nivel === 'degradacao' || c.nivel === 'critico');
  const comAtencao = caixas.filter((c) => c.nivel === 'atencao');
  const clientesEmRisco = soma(emRisco);
  const proporcao = avaliadas ? ((contagem.degradacao + contagem.critico) / avaliadas) * 100 : 0;

  // Proporção só pesa com pelo menos duas caixas com problema: num bairro de
  // cinco caixas, UMA caixa fraca com um cliente não é "bairro em degradação".
  const comProblema = contagem.degradacao + contagem.critico;
  let nivel: Nivel;
  if (!avaliadas && !caixas.some((c) => c.nivel !== 'sem_base')) nivel = 'sem_base';
  else if (contagem.critico) nivel = 'critico';
  else if ((proporcao >= opts.degradacaoPct && comProblema >= 2) || clientesEmRisco >= opts.clientesParaDegradacao) nivel = 'degradacao';
  else if (contagem.degradacao || contagem.atencao) nivel = 'atencao';
  else nivel = 'saudavel';

  // Motivo por CAUSA, separando saúde de capacidade e de monitoramento. Contar
  // "pontos de atenção" no atacado mistura caixa cheia (boa notícia comercial,
  // problema de planejamento) com sinal caindo (problema técnico).
  const com = (...cs: Causa[]) => caixas.filter((c) => c.causas.some((x) => cs.includes(x))).length;
  const saude: string[] = [];
  const n = {
    critica: contagem.critico,
    piora: com('piora', 'piora_forte'),
    fraco: com('sinal_fraco'),
    volta: com('recorrencia'),
    incidente: com('incidente', 'incidente_grave'),
    comecando: com('inicio_piora'),
    queda: com('queda_recente'),
    lotadas: com('lotada'),
    quase: com('quase_lotada'),
    cegas: com('sem_leitura'),
  };
  if (n.critica) saude.push(plural(n.critica, 'caixa em situação crítica', 'caixas em situação crítica'));
  if (n.piora) saude.push(`${plural(n.piora, 'caixa', 'caixas')} com sinal pior que o normal delas`);
  if (n.fraco) saude.push(`${plural(n.fraco, 'caixa', 'caixas')} com sinal da fibra muito fraco`);
  if (n.volta) saude.push(`${plural(n.volta, 'caixa', 'caixas')} que caem repetidamente`);
  if (n.incidente) saude.push(`${plural(n.incidente, 'caixa', 'caixas')} com incidente aberto`);
  if (n.comecando) saude.push(`${plural(n.comecando, 'caixa', 'caixas')} com sinal começando a piorar`);
  if (n.queda && !n.volta) saude.push(`${plural(n.queda, 'caixa', 'caixas')} com queda nos últimos 30 dias`);

  const partes: string[] = [];
  if (saude.length) partes.push(`sinal e estabilidade: ${saude.join(', ')}`);
  if (n.lotadas || n.quase) {
    partes.push(`capacidade: ${[
      n.lotadas ? plural(n.lotadas, 'caixa lotada', 'caixas lotadas') : null,
      n.quase ? plural(n.quase, 'quase lotada', 'quase lotadas') : null,
    ].filter(Boolean).join(' e ')}`);
  }
  if (n.cegas) partes.push(`monitoramento: ${plural(n.cegas, 'caixa', 'caixas')} sem leitura recente`);

  const motivo = partes.length
    ? `${partes.join('; ')} (de ${plural(caixas.length, 'caixa', 'caixas')})`
    : avaliadas
      ? `todas as ${plural(avaliadas, 'caixa avaliada', 'caixas avaliadas')} dentro do normal delas`
      : 'nenhuma caixa com leitura e histórico suficientes para comparar';

  const ordem = [...caixas]
    .filter((c) => c.nivel !== 'saudavel' && c.nivel !== 'sem_base')
    .sort((a, b) => PESO[b.nivel] - PESO[a.nivel] || (b.clientes ?? 0) - (a.clientes ?? 0));

  const desde = ordem.map((c) => c.desde).filter((x): x is string => !!x).sort()[0] ?? null;
  const fazer = [...new Set(ordem.flatMap((c) => c.o_que_fazer))].slice(0, 5);

  const impactoTexto = clientesEmRisco
    ? `${plural(clientesEmRisco, 'cliente', 'clientes')} em caixas com problema`
    : comAtencao.length ? `${plural(soma(comAtencao), 'cliente', 'clientes')} em caixas com ponto de atenção, nenhum em risco agora`
      : 'nenhum cliente em risco';

  return {
    alvo,
    nivel,
    rotulo: ROTULO_NIVEL[nivel],
    resumo: nivel === 'sem_base'
      ? `${alvo}: sem base para avaliar. ${motivo}.`
      : `${alvo}: ${ROTULO_NIVEL[nivel].toLowerCase()}. ${capitalizar(motivo)}. ${capitalizar(impactoTexto)}.`,
    motivo,
    impacto: {
      caixas: caixas.length,
      caixas_avaliadas: avaliadas,
      caixas_sem_base: contagem.sem_base,
      clientes: soma(caixas),
      clientes_em_risco: clientesEmRisco,
      clientes_com_atencao: soma(comAtencao),
    },
    desde,
    desde_explicacao: desde
      ? 'abertura do incidente mais antigo ainda aberto neste lugar'
      : `piora de sinal medida nos últimos ${opts.regua.janela_min} min contra os ${opts.regua.dias_referencia} dias anteriores; o início exato não é conhecido`,
    o_que_fazer: fazer,
    contagem,
    pontos_de_atencao: ordem.slice(0, 8),
    regua: opts.regua,
  };
}

const capitalizar = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

// ─── Coleta ──────────────────────────────────────────────────────────────────

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Incidente ligado à caixa: pela PON, pela própria CTO ou pelo nome no alvo. */
export function incidenteDaCto(c: CtoAtual, i: Pick<Incidente, 'correlacao' | 'alvo' | 'titulo'>): boolean {
  if (c.pon && i.correlacao === `pon:${c.pon}`) return true;
  if (i.correlacao === `cto:${c.cto_id}` || norm(i.correlacao) === norm(`cto:${c.nome}`)) return true;
  const nome = norm(c.nome);
  return nome.length >= 4 && (norm(i.alvo ?? '').includes(nome) || norm(i.titulo).includes(nome));
}

export interface FiltroSaude { bairro?: string; cidade?: string; pon?: string; cto?: string }

export interface Base {
  todas: CtoAtual[];
  caixas: Map<number, SaudeCto>;
  opts: { degradacaoPct: number; clientesParaDegradacao: number; regua: LeituraGerencial['regua'] };
}

/**
 * Classifica a rede inteira uma vez. Lugar, PON e bairro são recortes do
 * resultado — a saúde de uma caixa não depende de quem está perguntando por ela.
 */
export async function classificarRede(): Promise<Base> {
  const janela = obter<number>('monitor.ctos.janela_min');
  const dias = obter<number>('monitor.ctos.dias_referencia');
  const limiares: Limiares = {
    limiarDb: obter<number>('monitor.ctos.limiar_db'),
    criticoDb: obter<number>('monitor.ctos.critico_db'),
    ocupacaoAtencaoPct: obter<number>('leitura.ocupacao_atencao_pct'),
    quedasRecorrentes: obter<number>('leitura.quedas_recorrentes'),
  };

  const [todas, recentes, bases] = await Promise.all([
    questdb.ctosAtuais(), questdb.recente(janela), questdb.referencia(dias, janela),
  ]);
  const rec = new Map(recentes.map((x: RecenteSinal) => [x.cto_id, x]));
  const ref = new Map(bases.map((x: BaseSinal) => [x.cto_id, x]));

  const abertos = listarIncidentes({ abertos: true, limite: 500 }).filter((i) => ABERTOS.includes(i.estado));
  const desde30 = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const ultimos30 = db().prepare(
    `SELECT correlacao, alvo, titulo FROM incidente WHERE aberto_em >= ?`,
  ).all(desde30) as Array<Pick<Incidente, 'correlacao' | 'alvo' | 'titulo'>>;

  const caixas = new Map<number, SaudeCto>();
  for (const c of todas) {
    caixas.set(c.cto_id, classificarCto({
      cto: c,
      avaliacao: avaliarSinal(rec.get(c.cto_id), ref.get(c.cto_id), limiares.limiarDb),
      incidentes: abertos.filter((i) => incidenteDaCto(c, i)).map((i) => ({
        numero: i.numero, severidade: i.severidade, aberto_em: i.aberto_em, dono: i.dono,
      })),
      quedas30: ultimos30.filter((i) => incidenteDaCto(c, i)).length,
      limiares,
    }));
  }

  const degradacaoPct = obter<number>('leitura.degradacao_pct');
  return {
    todas,
    caixas,
    opts: {
      degradacaoPct,
      clientesParaDegradacao: obter<number>('incidentes.clientes_para_maior'),
      regua: { janela_min: janela, dias_referencia: dias, limiar_db: limiares.limiarDb, critico_db: limiares.criticoDb, degradacao_pct: degradacaoPct },
    },
  };
}

export async function lerSaude(f: FiltroSaude = {}): Promise<{
  leitura: LeituraGerencial; filtro: FiltroSaude; lugar_encontrado: boolean;
  entendido: { pedido: string; entendido: string; como: string } | null;
}> {
  const base = await classificarRede();
  let escopo = base.todas;
  let alvo = 'Rede inteira';
  let entendido: { pedido: string; entendido: string; como: string } | null = null;
  if (f.bairro || f.cidade) {
    const r = filtrarPorLugar(base.todas, { bairro: f.bairro, cidade: f.cidade }, base.todas);
    escopo = r.ctos;
    entendido = r.entendido;
    alvo = [entendido?.entendido ?? f.bairro, f.cidade].filter(Boolean).join(', ');
  }
  if (f.pon) {
    escopo = escopo.filter((c) => c.pon === f.pon);
    alvo = `PON ${f.pon}`;
  }
  if (f.cto) {
    const t = norm(f.cto).replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter((p) => p.length >= 2 && p !== 'cto');
    escopo = escopo.filter((c) => t.length > 0 && t.every((p) => norm(c.nome).includes(p)));
    alvo = escopo.length === 1 ? escopo[0].nome : `CTO "${f.cto}"`;
  }
  const leitura = consolidar(alvo, escopo.map((c) => base.caixas.get(c.cto_id)!), base.opts);
  return { leitura, filtro: f, lugar_encontrado: escopo.length > 0, entendido };
}

/**
 * Um veredito por bairro, piores primeiro. É o "onde estão os problemas" do
 * gestor, numa consulta só.
 */
export async function lerSaudePorBairro(): Promise<LeituraGerencial[]> {
  const base = await classificarRede();
  const grupos = new Map<string, CtoAtual[]>();
  for (const l of bairrosDasCtos(base.todas)) {
    if (!l.bairro) continue;
    const c = base.todas.find((x) => x.cto_id === l.cto_id)!;
    const lista = grupos.get(l.bairro) ?? [];
    lista.push(c);
    grupos.set(l.bairro, lista);
  }
  return [...grupos.entries()]
    .map(([bairro, ctos]) => consolidar(bairro, ctos.map((c) => base.caixas.get(c.cto_id)!), base.opts))
    .sort((a, b) => PESO[b.nivel] - PESO[a.nivel] || b.impacto.clientes_em_risco - a.impacto.clientes_em_risco);
}
