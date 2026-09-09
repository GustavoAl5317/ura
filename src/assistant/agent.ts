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
import { Envelope, FonteId, Veredito, RespostaAssistente } from './types';

const API = 'https://api.openai.com/v1/chat/completions';

/** Teto de bytes de UM resultado de ferramenta enviado ao modelo. */
const MAX_CHARS_RESULTADO = 12_000;

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
}

/** Fontes que o usuário pode consultar. null = todas. */
export function fontesDoUsuario(usuario: string): FonteId[] | null {
  const r = db().prepare(
    `SELECT fontes, ativo FROM permissao WHERE usuario = ?`,
  ).get(usuario) as { fontes: string | null; ativo: number } | undefined;

  if (!r || !r.ativo) return null;   // sem registro = sem restrição de fonte
  if (!r.fontes) return null;
  try {
    const lista = JSON.parse(r.fontes) as FonteId[];
    return Array.isArray(lista) && lista.length ? lista : null;
  } catch {
    return null;
  }
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

function extrairVereditoProposto(texto: string): { veredito: Veredito; corpo: string } {
  const m = texto.match(/^\s*VEREDITO:\s*(CONFIRMADO|PROVAVEL|PROVÁVEL|INCONCLUSIVO)\s*\n?/i);
  if (!m) {
    // Sem declaração explícita não se assume o melhor caso.
    return { veredito: 'PROVAVEL', corpo: texto.trim() };
  }
  const bruto = m[1].toUpperCase().replace('PROVÁVEL', 'PROVAVEL') as Veredito;
  return { veredito: bruto, corpo: texto.slice(m[0].length).trim() };
}

async function chamarModelo(
  messages: MsgOpenAi[],
  tools: unknown[],
): Promise<{ msg: MsgOpenAi; entrada?: number; saida?: number }> {
  const res = await axios.post<{
    choices: Array<{ message: MsgOpenAi }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  }>(
    API,
    {
      model: config.assistant.model,
      messages,
      tools: tools.length ? tools : undefined,
      tool_choice: tools.length ? 'auto' : undefined,
      temperature: config.assistant.temperature,
      max_tokens: config.assistant.maxTokens,
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

  const fontesPermitidas = fontesDoUsuario(pedido.usuario);
  const ctx: CtxFerramenta = {
    proximoId: () => `evd_${++contadorEvd}`,
    usuario: pedido.usuario,
    fontesPermitidas,
  };

  const tools = ferramentas.comoOpenAiTools(fontesPermitidas);
  const messages: MsgOpenAi[] = [
    { role: 'system', content: montarSystem(config.company.name, new Date()) },
  ];

  if (pedido.origemAudio) {
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

  for (const h of pedido.historico ?? []) {
    messages.push({ role: h.papel, content: h.conteudo });
  }
  messages.push({ role: 'user', content: pedido.pergunta });

  let textoFinal = '';
  let tokensEntrada = 0;
  let tokensSaida = 0;
  let erroFatal: string | null = null;

  for (let rodada = 0; rodada < config.assistant.maxToolRounds; rodada++) {
    let resposta;
    try {
      resposta = await chamarModelo(messages, tools);
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
        } else if (fontesPermitidas && !fontesPermitidas.includes(f.fonte)) {
          novos = [{
            id: ctx.proximoId(),
            fonte: f.fonte,
            consulta: f.nome,
            args: {},
            consultadoEm: new Date().toISOString(),
            duracaoMs: 0,
            ok: false,
            vazio: true,
            erro: `usuário sem permissão para a fonte ${f.fonte}`,
          }];
        } else {
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(tc.function.arguments || '{}');
          } catch {
            args = {};
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
      modelo: config.assistant.model,
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

  const { veredito: proposto, corpo } = extrairVereditoProposto(textoFinal);
  const decisao = calcularVeredito(proposto, evidencias, corpo);

  const resultado: RespostaAssistente = {
    veredito: decisao.veredito,
    vereditoAjustado: decisao.ajuste,
    texto: corpo,
    evidencias,
    fontesIndisponiveis: decisao.fontesIndisponiveis,
    lacunas: decisao.lacunas,
    modelo: config.assistant.model,
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
           modelo, tokens_entrada, tokens_saida, duracao_ms, at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
  } catch (err) {
    // Falhar a auditoria não pode derrubar a resposta ao técnico, mas tem de gritar.
    logger.error('Assistente: falha ao persistir consulta', {
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Resposta pronta para o WhatsApp: veredito, corpo e rastro. */
export function paraWhatsApp(r: RespostaAssistente): string {
  return formatarResposta({
    veredito: r.veredito,
    ajuste: r.vereditoAjustado,
    texto: r.texto,
    evidencias: r.evidencias,
    fontesIndisponiveis: r.fontesIndisponiveis,
    lacunas: r.lacunas,
  });
}
