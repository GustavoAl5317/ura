// Loop do assistente: pergunta → ferramentas → correlação → resposta.
//
// O modelo só enxerga o que as ferramentas devolveram nesta rodada. Ele não tem
// memória de rede, não tem acesso a fonte nenhuma por fora, e o veredito que
// propõe passa por evidence.ts antes de sair. Se ele calar sobre uma fonte que
// caiu, o rodapé denuncia mesmo assim.

import axios, { AxiosError } from 'axios';
import { randomUUID } from 'crypto';
import { config } from '../config';
import { logger } from '../logger';
import { db } from './store/db';
import { ferramentas, CtxFerramenta } from './tools/base';
import { montarSystem } from './prompts';
import { calcularVeredito, formatarResposta, fontesIndisponiveis as decisaoFontes } from './evidence';
import { Envelope, FonteId, Veredito, RespostaAssistente, FONTES as FONTES_CONHECIDAS } from './types';
import { publicar } from './eventos';
import { dispararWebhooks } from './webhooks';
import { obter, fontesHabilitadas } from './config-dinamica';
import { blocoParaPrompt, marcarUso } from './glossario';
import { linhaDeContexto } from './contexto';
import { rotasDaPergunta, completarBairro } from './rota';

const API = 'https://api.openai.com/v1/chat/completions';

/** Teto de bytes de UM resultado de ferramenta enviado ao modelo. */
const MAX_CHARS_RESULTADO = 12_000;
/** Mais que isso da mesma ferramenta numa pergunta é laço, não investigação. */
export const MAX_MESMA_FERRAMENTA = 4;

/** Ferramenta + argumentos em ordem fixa: a mesma consulta dá a mesma assinatura. */
export function assinaturaDaChamada(nome: string, args: Record<string, unknown>): string {
  const ordenar = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(ordenar);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, ordenar((v as Record<string, unknown>)[k])]));
    }
    return typeof v === 'string' ? v.trim().toLowerCase() : v;
  };
  return `${nome}:${JSON.stringify(ordenar(args))}`;
}

interface MsgOpenAi {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

export interface PedidoAssistente {
  pergunta: string;
  usuario: string;
  canal: 'whatsapp' | 'chat';
  conversaId?: string;
  /** Histórico curto para o modelo entender "e o sinal dele?". */
  historico?: Array<{ papel: 'user' | 'assistant'; conteudo: string }>;
  /**
   * A pergunta veio de áudio transcrito. Muda o comportamento: identificador
   * numérico ditado sai errado com facilidade (testado: RX -19.17 virou 19.7,
   * SN RCMG19c050ca virou RCMG1950CA), e um contrato com um dígito trocado casa
   * com OUTRO contrato válido — revisão do cliente errado, com veredito confiante.
   */
  origemAudio?: boolean;
  /**
   * Número não cadastrado no modo "rede": as fontes ficam limitadas a estas e
   * as ferramentas de um cliente específico somem. Ausente = acesso normal.
   */
  publico?: { fontes: FonteId[]; limitePorHora: number };
}

/** Fontes que o usuário pode consultar. null = todas. */
function lerLista(json: string | null): FonteId[] | null {
  if (!json) return null;
  try {
    const lista = JSON.parse(json) as FonteId[];
    return Array.isArray(lista) && lista.length ? lista : null;
  } catch {
    return null;
  }
}

/**
 * Fontes que o usuário pode consultar. null = sem restrição (valem as globais).
 *
 * Regra: equipe é o teto, pessoa pode restringir mais — o acesso é a
 * interseção das duas. Desativado (pessoa ou equipe) = nenhuma fonte. Antes da
 * equipe, desativado devolvia null, que significa TODAS: um usuário
 * desativado tinha acesso irrestrito pelo chat interno.
 */
export function fontesDoUsuario(usuario: string): FonteId[] | null {
  const r = db().prepare(
    `SELECT p.fontes, p.ativo, p.equipe, e.fontes AS equipe_fontes, e.ativo AS equipe_ativa, e.id AS equipe_existe
     FROM permissao p LEFT JOIN equipe e ON e.id = p.equipe
     WHERE p.usuario = ?`,
  ).get(usuario) as {
    fontes: string | null; ativo: number; equipe: string | null;
    equipe_fontes: string | null; equipe_ativa: number | null; equipe_existe: string | null;
  } | undefined;

  if (!r) return null;   // sem registro = sem restrição individual de fonte
  if (!r.ativo) return [];
  // Equipe apagada ou desativada não pode virar "sem teto".
  if (r.equipe && (!r.equipe_existe || !r.equipe_ativa)) return [];

  const pessoa = lerLista(r.fontes);
  const equipe = r.equipe ? lerLista(r.equipe_fontes) : null;
  if (pessoa && equipe) return pessoa.filter((f) => equipe.includes(f));
  return pessoa ?? equipe;
}

/**
 * Encolhe o resultado da ferramenta que vai ao modelo, avisando que encolheu.
 * O envelope completo continua indo para a auditoria — o corte é só de contexto,
 * e o modelo precisa saber que está vendo um recorte para não concluir demais.
 */
function paraModelo(envelopes: Envelope[]): string {
  const enxuto = envelopes.map((e) => ({
    evidencia: e.id,
    fonte: e.fonte,
    consulta: e.consulta,
    consultado_em: e.consultadoEm,
    status: e.ok ? (e.vazio ? 'sem_dados' : 'ok') : 'fonte_indisponivel',
    erro: e.erro,
    dados: e.dados,
  }));

  const json = JSON.stringify(enxuto);
  if (json.length <= MAX_CHARS_RESULTADO) return json;

  // Estourou: corta o `dados` de cada envelope para uma cota igual, guardando
  // o recorte como TEXTO e marcando truncado. Vira texto de propósito — JSON
  // cortado no meio é JSON inválido, e o modelo tentaria completá-lo sozinho.
  const cota = Math.max(500, Math.floor(MAX_CHARS_RESULTADO / Math.max(1, enxuto.length)) - 300);
  const cortado = enxuto.map((e) => {
    const s = JSON.stringify(e.dados ?? null);
    if (s.length <= cota) return e;
    return {
      ...e,
      dados: undefined,
      dados_truncados: s.slice(0, cota),
      _aviso: `resultado truncado (${s.length} → ${cota} chars). Este é um RECORTE: ` +
        'não conclua sobre o conjunto todo a partir dele; peça um filtro mais estreito.',
    };
  });

  return JSON.stringify(cortado).slice(0, MAX_CHARS_RESULTADO + 2_000);
}

/**
 * Separa "HIPÓTESE: ..." do corpo. Fica fora do texto de propósito: hipótese
 * misturada à resposta é lida como fato por quem está em campo com pressa.
 */
function extrairHipotese(texto: string): { hipotese?: string; corpo: string } {
  // Vai até linha em branco, outra seção em negrito ("*Conclusão*:") ou o fim.
  const m = texto.match(/(?:^|\n)\s*\*?HIP[ÓO]TESE\*?:\s*([\s\S]+?)(?=\n\s*\n|\n\s*\*?[A-ZÇÃÕ ]{4,}\*?:|$)/i);
  if (!m) return { corpo: texto };
  return {
    hipotese: m[1].trim(),
    corpo: (texto.slice(0, m.index) + texto.slice((m.index ?? 0) + m[0].length)).trim(),
  };
}

/**
 * A resposta pode ficar sem veredito? Só se não afirma nada sobre a rede.
 * O modelo pede CONVERSA; o código confere, porque "VEREDITO: CONVERSA" seguido
 * de "a rede está normal" seria a alucinação sem selo que o projeto existe
 * para impedir.
 */
export function conversaValida(texto: string, evidencias: Envelope[]): { ok: boolean; motivo?: string } {
  const t = texto.trim();
  if (!t) return { ok: false, motivo: 'resposta vazia' };
  if (t.length > 600) return { ok: false, motivo: 'longa demais para ser só conversa' };
  if (/\bevd_\d+/i.test(t)) return { ok: false, motivo: 'cita evidência' };
  const afirma = /\b(est[aá]|t[aá]|est[aã]o|ficou|ficaram|segue|seguem|continua|continuam|voltou|voltaram|caiu|ca[ií]ram)\s+(tudo\s+|todos?\s+|todas?\s+)?(normal|normais|ok|bem|est[aá]ve(l|is)|fora|offline|online|no ar|ca[ií]d[ao]s?|sem sinal|com problema)\b|\bsem (nenhum |nenhuma )?(problema|incidente|alerta|queda|falha)s?\b|\b(n[aã]o )?(h[aá]|tem|existe)m? (nenhum |nenhuma |um |uma )?(incidente|queda|problema|alerta|falha|rompimento)/i;
  if (afirma.test(t)) return { ok: false, motivo: 'afirma algo sobre a rede' };
  // Verbo de estado sozinho só é afirmação fora de pergunta: "quer saber se a CTO caiu?" pode.
  const afirmativas = t.split(/(?<=[.!?])\s+/).filter((f) => !/\?\s*$/.test(f));
  if (afirmativas.some((f) => /\b(caiu|ca[ií]ram|voltou|voltaram|normalizou|normalizaram|restabeleceu|restabeleceram|rompeu|parou|pararam)\b/i.test(f))) {
    return { ok: false, motivo: 'afirma algo sobre a rede' };
  }
  // Com consulta feita, só vale como pergunta de volta (ex.: qual das CTOs).
  if (evidencias.length && !/\?\s*$/.test(t)) return { ok: false, motivo: 'consultou as fontes e respondeu sem veredito' };
  return { ok: true };
}

const CUMPRIMENTO = /^(oi+|ol[aá]+|opa+|e a[ií]|eae|eai|fala|salve|bom dia|boa tarde|boa noite|tudo (bem|bom|certo)|como vai)$/;
// "ok", "certo", "beleza" ficam de fora: depois de uma pergunta de volta, são resposta a ela.
const AGRADECIMENTO = /^(obrigad[oa]|muito obrigad[oa]|obg|brigad[oa]|valeu|vlw|agrade[cç]o)$/;
const DESPEDIDA = /^(tchau|at[eé] mais|at[eé] logo|flw|falou|at[eé] amanh[aã])$/;

/**
 * Resposta para mensagem que é SÓ cumprimento, agradecimento ou despedida.
 * null = tem pergunta junto ("bom dia, a CTO 5 caiu?") e vai para o modelo.
 */
export function respostaSocial(pergunta: string, agora: Date): string | null {
  const partes = pergunta
    .toLowerCase()
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, ' ')
    .replace(/[!?.,;:~\s]+/g, ' ')
    .trim()
    .replace(/\s+(pessoal|galera|gente|assistente|bot|robo|robô|tudo bem|tudo bom|td bem)$/, '')
    .split(/\s+e\s+|\s*,\s*/)
    .map((x) => x.trim())
    .filter(Boolean);
  if (!partes.length || pergunta.length > 60) return null;
  const junto = partes.join(' ');
  const tipos = [CUMPRIMENTO, AGRADECIMENTO, DESPEDIDA];
  const tipo = tipos.find((re) => re.test(junto)) ?? (partes.every((p) => tipos.some((re) => re.test(p))) ? CUMPRIMENTO : null);
  if (!tipo) return null;

  if (tipo === AGRADECIMENTO) return 'Por nada! Qualquer coisa, é só chamar.';
  if (tipo === DESPEDIDA) return 'Até mais! Qualquer coisa, é só chamar.';
  const hora = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Fortaleza', hour: '2-digit', hour12: false }).format(agora)) % 24;
  const saudacao = hora < 12 ? 'Bom dia' : hora < 18 ? 'Boa tarde' : 'Boa noite';
  return `${saudacao}! Em que posso ajudar? Posso ver incidentes da rede, CTOs, sinal e histórico de clientes, O.S., tráfego e clientes online.`;
}

export function extrairVereditoProposto(texto: string): { veredito: Veredito | 'CONVERSA'; corpo: string } {
  const m = texto.match(/^\s*VEREDITO:\s*(CONFIRMADO|PROVAVEL|PROVÁVEL|INCONCLUSIVO|CONVERSA)\s*\n?/i);
  // "VEREDITO: CRÍTICO": o modelo pôs o nível de saúde no lugar da certeza.
  // Não é declaração válida: sai do texto (senão aparece para o leitor) e
  // conta como sem declaração.
  const invalido = !m && texto.match(/^\s*VEREDITO:[^\n]*\n?/i);
  if (invalido) return { veredito: 'PROVAVEL', corpo: tirarSeloRepetido(texto.slice(invalido[0].length)) };
  if (!m) {
    // O modelo às vezes escreve o selo em vez da linha pedida ("🟢 CONFIRMADO"
    // no lugar de "VEREDITO: CONFIRMADO"). É a mesma declaração: aceita, e tira
    // a linha do texto para não sair selo duplicado e contraditório.
    const primeira = texto.trim().split('\n')[0] ?? '';
    const selo = primeira.match(/(CONFIRMADO|PROV[AÁ]VEL|INCONCLUSIVO|CONVERSA)/i);
    if (selo && tirarSeloRepetido(primeira) === '') {
      const v = selo[1].toUpperCase().replace('PROVÁVEL', 'PROVAVEL') as Veredito | 'CONVERSA';
      return { veredito: v, corpo: tirarSeloRepetido(texto) };
    }
    // Sem declaração explícita não se assume o melhor caso.
    return { veredito: 'PROVAVEL', corpo: tirarSeloRepetido(texto) };
  }
  const bruto = m[1].toUpperCase().replace('PROVÁVEL', 'PROVAVEL') as Veredito | 'CONVERSA';
  return { veredito: bruto, corpo: tirarSeloRepetido(texto.slice(m[0].length)) };
}

/**
 * O modelo às vezes repete o veredito como primeira linha do corpo ("🔴
 * INCONCLUSIVO"), e o canal já mostra o selo: sai duplicado. Tira só linha
 * que é exatamente o selo, no começo — nunca uma frase que cite a palavra.
 */
export function tirarSeloRepetido(corpo: string): string {
  const selo = /^\s*(?:[🔴🟡🟢⚪✅⚠️]\s*)*\**\s*(?:VEREDITO:\s*)?(?:CONFIRMADO|PROV[AÁ]VEL|INCONCLUSIVO|CONVERSA)\s*\**\s*$/iu;
  const linhas = corpo.split('\n');
  while (linhas.length && (selo.test(linhas[0]) || !linhas[0].trim())) linhas.shift();
  return linhas.join('\n').trim();
}

/**
 * Como falar com quem não é técnico. Foi escrito a partir de respostas reais
 * que o dono do ISP achou longas e difíceis: "Eth-Trunk4.1441 sem coleta de
 * estado da porta", "-25 dBm", e um parágrafo de gestão repetindo os números.
 */
export function instrucaoLinguagemSimples(limite: number): string {
  return [
    'Quem perguntou NÃO é técnico. Escreva como quem explica para um vizinho, no WhatsApp.',
    'A PRIMEIRA frase é a resposta, curta: "Sim, está funcionando.", "Hoje ninguém cancelou no Bom Sucesso.", ' +
      '"São 24 caixas; 11 têm só dois clientes."',
    limite > 0
      ? `Depois, no máximo 3 frases curtas ou 5 itens de lista. A resposta inteira cabe em ${limite} caracteres.`
      : 'Depois, no máximo 3 frases curtas ou 5 itens de lista.',
    'Lista grande não vai inteira: mostre as 3 a 5 mais importantes, diga quantas são no total e ofereça o resto ' +
      '("Quer que eu mande todas?").',
    'Palavras: "caixa na rua" (não CTO), "aparelho do cliente" (não ONU), "equipamento central" (não OLT), ' +
      '"sinal da fibra" (não potência óptica), "trecho" (não PON), "ligação com a operadora" (não link ou interface).',
    'NUNCA escreva nome de porta ou interface (Eth-Trunk, XGigabitEthernet, GigabitEthernet), "subinterface", ' +
      '"coleta", "item", "evidência", "série" nem "dBm" sem dizer o que é. Em vez de "-27 dBm", diga "sinal fraco" ' +
      '(e o número entre parênteses só se ajudar). Em vez de "722 Mbps", diga "passando bastante tráfego" ou ' +
      '"cerca de 700 megas".',
    'O que não deu para saber vai numa frase só, no fim, se mudar alguma coisa para quem pergunta.',
    'Não mude os números nem o veredito: muda só o jeito de dizer. Mantenha as citações (evd_N) no fim das frases.',
  ].join(' ');
}

/**
 * Reescreve uma resposta comprida para caber no limite. Só aceita o
 * resultado se ele ficou menor e não perdeu número nem citação: encurtar não
 * pode mudar o que foi provado.
 */
async function encurtar(texto: string, limite: number): Promise<{ texto: string | null; entrada: number; saida: number }> {
  const r = await chamarModelo([
    {
      role: 'system',
      content:
        `Reescreva a resposta abaixo para um leigo, em até ${limite} caracteres. Primeira frase: a resposta direta. ` +
        'Depois, só o que muda a decisão de quem perguntou. Mantenha todos os números que ficarem e as citações ' +
        '(evd_N). Não acrescente nada. Sem título, sem "Leitura para gestão", sem nome de porta ou interface. ' +
        'Não use "confirmado", "não confirmado", "inconclusivo", "provável" nem "hipótese". ' +
        'Devolva só o texto, sem linha de VEREDITO.',
    },
    { role: 'user', content: texto },
  ], []);
  const novo = tirarSeloRepetido((r.msg.content ?? '').replace(/^\s*VEREDITO:[^\n]*\n?/i, '')).trim();
  const citacoes = (t: string) => new Set(t.match(/evd_\d+/gi) ?? []);
  const perdeuCitacao = [...citacoes(texto)].some((c) => !citacoes(novo).has(c)) && citacoes(texto).size > 0 && citacoes(novo).size === 0;
  const valido = novo.length > 0 && novo.length < texto.length && !perdeuCitacao;
  return { texto: valido ? novo : null, entrada: r.entrada ?? 0, saida: r.saida ?? 0 };
}

/** 'auto' deixa o modelo escolher; nome obriga uma ferramenta; 'none' obriga a responder. */
type EscolhaFerramenta = 'auto' | 'none' | { type: 'function'; function: { name: string } };

async function chamarModelo(
  messages: MsgOpenAi[],
  tools: unknown[],
  escolha: EscolhaFerramenta = 'auto',
): Promise<{ msg: MsgOpenAi; entrada?: number; saida?: number }> {
  const res = await axios.post<{
    choices: Array<{ message: MsgOpenAi }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  }>(
    API,
    {
      model: obter<string>('ia.modelo'),
      messages,
      tools: tools.length ? tools : undefined,
      tool_choice: tools.length ? escolha : undefined,
      temperature: obter<number>('ia.temperatura'),
      max_tokens: obter<number>('ia.max_tokens'),
    },
    {
      timeout: 90_000,
      headers: {
        Authorization: `Bearer ${config.openai.apiKey}`,
        'Content-Type': 'application/json',
      },
    },
  );

  return {
    msg: res.data.choices[0].message,
    entrada: res.data.usage?.prompt_tokens,
    saida: res.data.usage?.completion_tokens,
  };
}

export async function responder(pedido: PedidoAssistente): Promise<RespostaAssistente> {
  const t0 = Date.now();
  const evidencias: Envelope[] = [];
  let contadorEvd = 0;

  // Cumprimento puro não passa pelo modelo: o gpt-4.1-mini respondeu "olá"
  // só com "VEREDITO: INCONCLUSIVO" e corpo vazio (17/09/2026).
  const social = respostaSocial(pedido.pergunta, new Date());
  if (social) {
    const r: RespostaAssistente = {
      veredito: 'CONVERSA', texto: social, evidencias: [], fontesIndisponiveis: [], lacunas: [],
      modelo: 'conversa', duracaoMs: Date.now() - t0,
    };
    persistir(pedido, r);
    return r;
  }

  // Fontes efetivas = habilitadas globalmente ∩ permitidas ao usuário.
  const doUsuario = fontesDoUsuario(pedido.usuario);
  const globais = fontesHabilitadas();
  let fontesPermitidas = doUsuario === null ? globais : doUsuario.filter((f) => globais.includes(f));
  const publico = !!pedido.publico;
  if (pedido.publico) {
    const teto = pedido.publico.fontes;
    fontesPermitidas = fontesPermitidas.filter((f) => teto.includes(f));
  }

  const limite = pedido.publico?.limitePorHora ?? obter<number>('limites.consultas_por_hora');
  const naUltimaHora = (db().prepare(
    `SELECT COUNT(*) n FROM consulta WHERE usuario = ? AND at > ?`,
  ).get(pedido.usuario, new Date(Date.now() - 3600_000).toISOString()) as { n: number }).n;
  if (naUltimaHora >= limite) {
    logger.warn('Assistente: limite de consultas por hora atingido', { usuario: pedido.usuario, limite });
    return {
      veredito: 'INCONCLUSIVO',
      texto: `Limite de ${limite} consultas por hora atingido para este usuário. Tente novamente mais tarde.`,
      evidencias: [], fontesIndisponiveis: [],
      lacunas: ['Consulta recusada por limite de uso, antes de acessar qualquer fonte.'],
      modelo: 'limite', duracaoMs: Date.now() - t0,
    };
  }
  const ctx: CtxFerramenta = {
    proximoId: () => `evd_${++contadorEvd}`,
    usuario: pedido.usuario,
    fontesPermitidas,
    publico,
  };

  const tools = ferramentas.comoOpenAiTools(fontesPermitidas, publico);
  const messages: MsgOpenAi[] = [
    { role: 'system', content: montarSystem(config.company.name, new Date(), fontesPermitidas) },
  ];

  // Sem isto, fonte desligada vira silêncio: o modelo não tem a ferramenta e
  // pede ao técnico um dado que não resolveria nada. Ele precisa saber o motivo.
  const bloqueadas = FONTES_CONHECIDAS.filter((f) => !fontesPermitidas.includes(f));
  if (bloqueadas.length) {
    messages.push({
      role: 'system',
      content:
        `Fontes BLOQUEADAS nesta conversa (desabilitadas pela administração ou sem permissão para este ` +
        `usuário): ${bloqueadas.join(', ')}. Se a pergunta depender delas, diga exatamente isso — ` +
        'que a fonte está bloqueada — em vez de pedir outro dado ao técnico.',
    });
  }

  if (publico) {
    messages.push({
      role: 'system',
      content:
        'Quem pergunta NÃO é um técnico cadastrado. Responda só sobre a rede como um todo ' +
        '(incidentes, links, tráfego, clientes online em número). NUNCA informe nome, contrato, ' +
        'login, endereço, telefone, SN ou IP completo de cliente, nem confirme se alguém é cliente. ' +
        'Se pedirem isso, diga que dados de clientes são só para técnicos cadastrados e que o ' +
        'cadastro é feito pela equipe de NOC.',
    });
  }

  if (pedido.origemAudio) {
    messages.push({
      role: 'system',
      content:
        'A resposta desta pergunta vai ser OUVIDA em áudio (o texto vai junto). Escreva como se fala: ' +
        'frases curtas, no máximo 4 ou 5, sem lista longa e sem tabela. Dê primeiro a resposta, depois ' +
        'o detalhe que muda a conduta. Arredonde quando a precisão não importar ("cerca de 2 gigabits"), ' +
        'mas nunca arredonde sinal óptico, contrato ou horário. Datas como "16/09" e horas como "21:33" — ' +
        'a conversão para fala é automática. Não leia rótulo de evidência em voz alta: cite evd_N só entre parênteses no fim da frase.',
    });
    messages.push({
      role: 'system',
      content:
        'ATENÇÃO: esta pergunta veio de ÁUDIO TRANSCRITO, e transcrição erra ' +
        'identificador. Antes de usar SN, CPF, número de contrato, IP ou MAC que ' +
        'tenha vindo desta transcrição, REPITA o valor entendido e peça confirmação ' +
        '— não chame revisao_cliente direto. Um dígito trocado casa com outro ' +
        'contrato válido e você responderia com confiança sobre o cliente errado. ' +
        'Busca por NOME não tem esse risco: pode seguir normalmente.',
    });
  }

  // Vocabulário da casa: só os termos que a pergunta usou.
  const vocab = blocoParaPrompt(pedido.pergunta);
  if (vocab) {
    messages.push({ role: 'system', content: vocab.texto });
    marcarUso(vocab.ids);
  }

  // Assunto inequívoco: a ferramenta certa vai por escrito.
  const rotas = rotasDaPergunta(pedido.pergunta);
  for (const r of rotas) {
    messages.push({ role: 'system', content: r.instrucao });
  }
  // Instrução escrita não bastou: com o assunto inequívoco, a primeira rodada
  // é OBRIGADA a chamar a ferramenta (o modelo ainda escolhe os argumentos).
  const nomesDisponiveis = new Set((tools as Array<{ function?: { name?: string } }>).map((t) => t.function?.name));
  const obrigatoria = rotas.find((r) => nomesDisponiveis.has(r.ferramenta))?.ferramenta ?? null;

  // Registro de linguagem: quem fala simples recebe resposta simples.
  const registro = obter<string>('ia.linguagem');
  // "Como assim dBm?" cita sigla e é pergunta de leigo: quem pede explicação
  // da sigla não fala técnico.
  const pedeExplicacao = /como assim|o que (é|e|seria|significa|quer dizer)|me expli(ca|que)|n[aã]o entendi/i.test(pedido.pergunta);
  const falaTecnico = !pedeExplicacao &&
    /\b(cto|pon|olt|onu|ont|pppoe|sn|rx|tx|vlan|dbm|slot|uplink|backbone)\b/i.test(pedido.pergunta);

  // Leigo, e muitas vezes por áudio transcrito: o nome chega trocado por som
  // parecido. As ferramentas resolvem pelo som; o modelo não pode "corrigir"
  // antes nem pedir para a pessoa reformular.
  if (!falaTecnico || pedido.origemAudio) {
    messages.push({
      role: 'system',
      content:
        'Quem pergunta pode ser leigo e muitas vezes fala por áudio transcrito. Nome de lugar chega trocado por ' +
        'som parecido ("Bolsa Fesso" = Bom Sucesso, "Grande Portugal" = Granja Portugal, "João 23" = João XXIII, ' +
        '"Anetice" = a Etice) e palavra comum também ("vacina/vacinante" no lugar de "caixa/cliente"). ' +
        'Passe nome de bairro, rua ou link para a ferramenta COMO FOI DITO: ela resolve pelo som. Se a ferramenta ' +
        'devolver bairro_interpretado, comece dizendo o que entendeu ("Entendi Bom Sucesso."). Só peça para repetir ' +
        'quando a ferramenta não achar nada parecido, e aí mostre as opções que ela devolveu. ' +
        'Mensagem longa em que a pessoa explica algo ("caixa de emenda é onde emenda uma fibra na outra") é ' +
        'CORREÇÃO do que você entendeu: aceite, diga em uma frase o que entendeu agora e responda a pergunta ' +
        'anterior com esse sentido, sem repetir a resposta errada.',
    });
  }
  const simples = registro === 'simples' || (registro === 'auto' && !falaTecnico);
  const limiteCaracteres = simples ? obter<number>('ia.resposta_max_caracteres') : 0;
  if (simples) {
    messages.push({ role: 'system', content: instrucaoLinguagemSimples(limiteCaracteres) });
  }
  if (pedido.canal === 'whatsapp' && semSelo(simples)) {
    messages.push({
      role: 'system',
      content:
        'Esta resposta sai SEM selo de certeza. No texto, não use as palavras "confirmado", "não confirmado", ' +
        '"inconclusivo", "provável", "hipótese" nem "veredito". Diga o que você viu, com segurança. Se faltou ' +
        'alguma coisa, diga em palavras simples o que não deu para ver ("não consegui ver o sinal da caixa X agora"). ' +
        'Nunca afirme como certo o que as ferramentas não mostraram. A linha VEREDITO do começo continua obrigatória: ' +
        'ela não aparece para quem lê.',
    });
  }

  // Leitura para gestão: depois dos números, o que eles querem dizer.
  const modoLeitura = obter<string>('leitura.modo');
  const perguntaDeEstado = /como (est[aá]|t[aá]|anda|vai|ficou)|sa[uú]de|situa[cç][aã]o|algum problema|tudo (bem|certo|ok)|t[aá] (bom|ruim|bem)|degrad|pontos? de aten[cç][aã]o|est[aá]vel|preocupa/i
    .test(pedido.pergunta);
  if (modoLeitura === 'sempre' || (modoLeitura === 'auto' && (perguntaDeEstado || !falaTecnico))) {
    messages.push({
      role: 'system',
      content:
        (simples
          // Para leigo, o parágrafo "Leitura para gestão" repetia os números
          // que acabaram de ser ditos. Vira uma frase, sem título.
          ? 'Termine com UMA frase que diga o que isso significa e o que fazer, sem título ("Leitura para gestão" ' +
            'não aparece). Ex.: "Está funcionando; só vale olhar a caixa da Rua X." '
          : 'Quem lê pode ser gestor. Depois dos números técnicos, acrescente um parágrafo curto "Leitura para gestão". ') +
        'O nível de saúde vai nessa parte, nunca na linha VEREDITO (que é só CONFIRMADO, PROVAVEL, ' +
        'INCONCLUSIVO ou CONVERSA e diz o quanto a resposta está provada, não como está a rede). ' +
        'o nível (saudável, ponto de atenção, em degradação, crítico ou sem base para avaliar), o motivo, o impacto ' +
        'em clientes, desde quando e o que fazer. Para pergunta sobre COMO ESTÁ um lugar, chame saude_da_rede: o ' +
        'nível vem dela, calculado, e você não muda. Se não chamou saude_da_rede, NÃO declare nível nenhum — ' +
        'descreva o que os números mostram, sem rótulo de saúde. "Sem base" nunca vira "saudável". ' +
        'Urgência depende da IDADE do problema: o que abriu hoje ou nos últimos dias pede ação; o que está aberto ' +
        'há meses sem mudança costuma ser alarme velho — diga que é antigo e recomende revisar se ainda faz ' +
        'sentido, sem chamar de urgente nem de crítico por causa da quantidade.',
    });
  }

  // Fio da conversa: resolve "e agora?", "e a outra?", "e ela?".
  if (obter<boolean>('ia.memoria_conversa')) {
    const fio = linhaDeContexto(pedido.conversaId, { usuario: pedido.usuario });
    if (fio) messages.push({ role: 'system', content: fio });
  }

  for (const h of pedido.historico ?? []) {
    messages.push({ role: h.papel, content: h.conteudo });
  }
  messages.push({ role: 'user', content: pedido.pergunta });

  let textoFinal = '';
  let tokensEntrada = 0;
  let tokensSaida = 0;
  let erroFatal: string | null = null;

  const maxRodadas = obter<number>('ia.max_rodadas');
  // Consulta repetida: mesma ferramenta, mesmos argumentos. O modelo pequeno
  // entra em laço ("Bolsa Fesso" virou seis revisões do mesmo cliente
  // inexistente) e queima o limite sem resposta nenhuma.
  const jaFeitas = new Set<string>();
  const vezesPorFerramenta = new Map<string, number>();
  let insistiuEmConsultar = false;
  for (let rodada = 0; rodada < maxRodadas; rodada++) {
    let resposta;
    try {
      // Primeira rodada: ferramenta obrigatória, se houver. Última: responder
      // com o que tem, em vez de terminar em "não consegui concluir".
      const escolha: EscolhaFerramenta = rodada === 0 && obrigatoria
        ? { type: 'function', function: { name: obrigatoria } }
        : rodada === maxRodadas - 1 && rodada > 0 ? 'none' : 'auto';
      resposta = await chamarModelo(messages, tools, escolha);
    } catch (err) {
      const ax = err as AxiosError;
      erroFatal = `modelo indisponível: ${ax.response?.status ?? ''} ${ax.message}`.trim();
      logger.error('Assistente: chamada ao modelo falhou', {
        status: ax.response?.status,
        body: JSON.stringify(ax.response?.data ?? '').slice(0, 300),
      });
      break;
    }

    tokensEntrada += resposta.entrada ?? 0;
    tokensSaida += resposta.saida ?? 0;
    const msg = resposta.msg;

    if (msg.tool_calls?.length) {
      messages.push({ role: 'assistant', content: msg.content ?? null, tool_calls: msg.tool_calls });

      for (const tc of msg.tool_calls) {
        const f = ferramentas.get(tc.function.name);
        let novos: Envelope[];

        if (!f) {
          novos = [{
            id: ctx.proximoId(),
            fonte: 'sgp',
            consulta: tc.function.name,
            args: {},
            consultadoEm: new Date().toISOString(),
            duracaoMs: 0,
            ok: false,
            vazio: true,
            erro: `ferramenta desconhecida: ${tc.function.name}`,
          }];
        } else if ((fontesPermitidas && !fontesPermitidas.includes(f.fonte)) || (publico && f.dadoPessoal)) {
          novos = [{
            id: ctx.proximoId(),
            fonte: f.fonte,
            consulta: f.nome,
            args: {},
            consultadoEm: new Date().toISOString(),
            duracaoMs: 0,
            ok: false,
            vazio: true,
            erro: publico && f.dadoPessoal
              ? `${f.nome} mostra dados de um cliente e não está disponível para números não cadastrados`
              : `usuário sem permissão para a fonte ${f.fonte}`,
          }];
        } else {
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(tc.function.arguments || '{}');
          } catch {
            args = {};
          }
          const assinatura = assinaturaDaChamada(f.nome, args);
          const vezes = (vezesPorFerramenta.get(f.nome) ?? 0) + 1;
          vezesPorFerramenta.set(f.nome, vezes);
          const repetida = jaFeitas.has(assinatura);
          if (repetida || vezes > MAX_MESMA_FERRAMENTA) {
            // Não executa e não vira evidência: só devolve ao modelo o porquê.
            messages.push({
              role: 'tool',
              tool_call_id: tc.id,
              content: JSON.stringify({
                nao_executada: true,
                motivo: repetida
                  ? 'Esta consulta, com estes mesmos argumentos, já foi feita nesta pergunta. O resultado está acima.'
                  : `${f.nome} já foi chamada ${MAX_MESMA_FERRAMENTA} vezes nesta pergunta.`,
                instrucao:
                  'Não repita. Releia a pergunta: se esta ferramenta não responde, use OUTRA. Se nenhuma responde, ' +
                  'responda com o que já tem e diga o que faltou.',
              }),
            });
            continue;
          }
          jaFeitas.add(assinatura);
          // "Segunda etapa do Conjunto Ceará" não pode virar "Conjunto Ceará".
          if (typeof args.bairro === 'string' && args.bairro.trim()) {
            args = { ...args, bairro: completarBairro(args.bairro, pedido.pergunta) };
          }
          novos = await f.executar(args, ctx);
        }

        evidencias.push(...novos);
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: paraModelo(novos),
        });
      }
      continue;
    }

    textoFinal = msg.content ?? '';

    // Resposta com dado e sem consulta nenhuma. Foi assim que "quais os
    // endereços dessas caixas?" saiu com cinco ruas inventadas: o modelo
    // "lembrou" da resposta anterior. Uma chance de consultar de verdade.
    if (!insistiuEmConsultar && !evidencias.length && rodada + 1 < maxRodadas &&
        extrairVereditoProposto(textoFinal).veredito !== 'CONVERSA') {
      insistiuEmConsultar = true;
      messages.push({ role: 'assistant', content: textoFinal });
      messages.push({
        role: 'system',
        content:
          'Você respondeu sem consultar nenhuma ferramenta. Resposta anterior da conversa não vale como prova ' +
          'agora, e endereço, número ou nome que não veio de ferramenta NESTA pergunta é invenção. Chame a ' +
          'ferramenta que responde e escreva a resposta de novo. Se for só conversa, sem dado, responda com ' +
          'VEREDITO: CONVERSA.',
      });
      textoFinal = '';
      continue;
    }
    break;
  }

  if (erroFatal) {
    // Modelo fora do ar não vira resposta inventada: vira INCONCLUSIVO explícito.
    // E É AUDITADO — a consulta que falhou é a que mais interessa no histórico,
    // porque é a que o técnico vai jurar que "perguntou e não veio nada".
    const falha: RespostaAssistente = {
      veredito: 'INCONCLUSIVO',
      texto: `Não consegui processar a consulta: ${erroFatal}.`,
      evidencias,
      fontesIndisponiveis: decisaoFontes(evidencias),
      lacunas: ['O modelo de linguagem não respondeu. As fontes não chegaram a ser correlacionadas.'],
      modelo: obter<string>('ia.modelo'),
      tokensEntrada,
      tokensSaida,
      duracaoMs: Date.now() - t0,
    };
    persistir(pedido, falha);
    return falha;
  }

  if (!textoFinal.trim()) {
    textoFinal = 'VEREDITO: INCONCLUSIVO\nNão consegui concluir dentro do limite de consultas.';
  }

  const extraido = extrairVereditoProposto(textoFinal);
  const { hipotese, corpo: corpoModelo } = extrairHipotese(extraido.corpo);
  let pedidoDoModelo = extraido.veredito;
  let corpo = corpoModelo;

  // Leigo e resposta comprida: uma reescrita curta, com os mesmos números.
  // O prompt pede o tamanho; o modelo nem sempre obedece, e a queixa da
  // operação foi exatamente "as respostas estão muito longas".
  if (limiteCaracteres > 0 && pedidoDoModelo !== 'CONVERSA' && corpo.length > limiteCaracteres * 1.25) {
    try {
      const curta = await encurtar(corpo, limiteCaracteres);
      tokensEntrada += curta.entrada;
      tokensSaida += curta.saida;
      if (curta.texto) corpo = curta.texto;
    } catch (err) {
      logger.warn('Assistente: não consegui encurtar a resposta', { err: (err as Error).message });
    }
  }

  // Só a linha do veredito, sem texto e sem consulta: o modelo não entendeu o
  // pedido. Mostrar "INCONCLUSIVO" vazio não ajuda ninguém; perguntar, sim.
  if (!corpo.trim() && !evidencias.length) {
    pedidoDoModelo = 'CONVERSA';
    corpo = 'Não entendi bem o que você precisa. Pode me dizer sobre qual cliente, CTO, equipamento ou região é a pergunta?';
  }

  if (pedidoDoModelo === 'CONVERSA') {
    const cv = conversaValida(corpo, evidencias);
    if (cv.ok) {
      const conversa: RespostaAssistente = {
        veredito: 'CONVERSA',
        texto: corpo,
        evidencias,
        fontesIndisponiveis: [],
        lacunas: [],
        modelo: obter<string>('ia.modelo'),
        tokensEntrada,
        tokensSaida,
        duracaoMs: Date.now() - t0,
      };
      persistir(pedido, conversa);
      return conversa;
    }
    logger.info('Assistente: conversa recusada, segue com veredito', { usuario: pedido.usuario, motivo: cv.motivo });
  }
  const proposto: Veredito = pedidoDoModelo === 'CONVERSA' ? 'INCONCLUSIVO' : pedidoDoModelo;
  const decisao = calcularVeredito(proposto, evidencias, corpo);

  const resultado: RespostaAssistente = {
    veredito: decisao.veredito,
    vereditoAjustado: decisao.ajuste,
    texto: corpo,
    evidencias,
    fontesIndisponiveis: decisao.fontesIndisponiveis,
    lacunas: decisao.lacunas,
    // Hipótese só faz sentido sem confirmação. Em CONFIRMADO, a causa já é fato.
    hipotese: decisao.veredito === 'CONFIRMADO' ? undefined : hipotese,
    simples: limiteCaracteres > 0 || undefined,
    modelo: obter<string>('ia.modelo'),
    tokensEntrada,
    tokensSaida,
    duracaoMs: Date.now() - t0,
  };

  if (decisao.ajuste) {
    logger.info('Assistente: veredito rebaixado', {
      usuario: pedido.usuario,
      proposto,
      final: decisao.veredito,
      motivo: decisao.ajuste,
    });
  }

  persistir(pedido, resultado);
  return resultado;
}

function persistir(pedido: PedidoAssistente, r: RespostaAssistente): void {
  try {
    const d = db();
    const consultaId = randomUUID();
    const agora = new Date().toISOString();

    d.transaction(() => {
      d.prepare(
        `INSERT INTO consulta (id, conversa_id, usuario, canal, pergunta, resposta,
           veredito, veredito_ajustado, fontes, fontes_indisponiveis, lacunas,
           modelo, tokens_entrada, tokens_saida, duracao_ms, at, hipotese)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        consultaId,
        pedido.conversaId ?? null,
        pedido.usuario,
        pedido.canal,
        pedido.pergunta,
        r.texto,
        r.veredito,
        r.vereditoAjustado ?? null,
        JSON.stringify([...new Set(r.evidencias.map((e) => e.fonte))]),
        JSON.stringify(r.fontesIndisponiveis),
        JSON.stringify(r.lacunas),
        r.modelo,
        r.tokensEntrada ?? null,
        r.tokensSaida ?? null,
        r.duracaoMs,
        agora,
        r.hipotese ?? null,
      );

      const ins = d.prepare(
        `INSERT INTO evidencia (id, consulta_id, evd, fonte, nome_consulta, args,
           consultado_em, duracao_ms, ok, vazio, dados, erro)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      );
      for (const e of r.evidencias) {
        ins.run(
          randomUUID(), consultaId, e.id, e.fonte, e.consulta,
          JSON.stringify(e.args), e.consultadoEm, e.duracaoMs,
          e.ok ? 1 : 0, e.vazio ? 1 : 0,
          e.dados === undefined ? null : JSON.stringify(e.dados),
          e.erro ?? null,
        );
      }
    })();

    // Painel ao vivo: só o resumo. A pergunta vai, a resposta e os dados das
    // fontes ficam na auditoria, acessíveis por quem abrir a consulta.
    const resumoConsulta = {
      id: consultaId, usuario: pedido.usuario, canal: pedido.canal, pergunta: pedido.pergunta,
      veredito: r.veredito, fontes: [...new Set(r.evidencias.map((e) => e.fonte))],
      duracaoMs: r.duracaoMs, at: agora,
    };
    publicar('consulta', resumoConsulta);
    dispararWebhooks('consulta', resumoConsulta);
  } catch (err) {
    // Falhar a auditoria não pode derrubar a resposta ao técnico, mas tem de gritar.
    logger.error('Assistente: falha ao persistir consulta', {
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * O selo de certeza sai na mensagem? A casa pediu que não ("nunca que ela diga
 * que não está confirmado"): o veredito fica no histórico do painel, e a
 * mensagem diz o que faltou em palavras.
 */
export function semSelo(simples: boolean | undefined): boolean {
  const modo = obter<string>('ia.mostrar_veredito');
  return modo === 'nunca' || (modo === 'so_tecnico' && !!simples);
}

/** Resposta pronta para o WhatsApp: veredito, corpo e rastro. */
export function paraWhatsApp(r: RespostaAssistente): string {
  return formatarResposta({
    semSelo: semSelo(r.simples),
    veredito: r.veredito,
    ajuste: r.vereditoAjustado,
    texto: r.texto,
    evidencias: r.evidencias,
    fontesIndisponiveis: r.fontesIndisponiveis,
    lacunas: r.lacunas,
    hipotese: r.hipotese,
    simples: r.simples,
  });
}
