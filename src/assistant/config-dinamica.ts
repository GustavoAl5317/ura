// Configuração editável em tempo de execução (Bloco 6).
//
// O .env continua sendo a fonte de credenciais e endereços — coisa que muda com
// deploy. O que muda com OPERAÇÃO (limite de SLA, modelo, horário de silêncio,
// quais monitores ligados) mora aqui, em banco, com validação, auditoria e sem
// restart. Cada chave tem tipo e padrão declarados: valor que não passa na
// validação é recusado na escrita, nunca descoberto em runtime.

import { config } from '../config';
import { db, registrarAuditoria } from './store/db';
import { logger } from '../logger';
import { FONTES, FonteId } from './types';

type Tipo = 'numero' | 'inteiro' | 'booleano' | 'texto' | 'hora' | 'lista';

interface Definicao {
  tipo: Tipo;
  padrao: () => unknown;
  descricao: string;
  grupo: 'ia' | 'audio' | 'limites' | 'alertas' | 'monitor_zabbix' | 'monitor_ura' | 'monitor_sla' | 'monitor_netflow' | 'monitor_ctos' | 'resumo' | 'relatorios' | 'fontes' | 'whatsapp';
  min?: number;
  max?: number;
  opcoes?: readonly string[];
}

const HORA = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Fontes que um número NÃO cadastrado pode chegar a consultar no modo "rede".
 * Fixo no código de propósito: SGP (cadastro), URA (telefone de quem ligou) e
 * WhatsApp (conversas do atendimento) são dado pessoal, e nenhuma configuração
 * do painel deve conseguir abri-las para desconhecidos.
 */
export const FONTES_PUBLICAS = ['zabbix', 'netflow', 'questdb'] as const satisfies readonly FonteId[];

export const DEFINICOES = {
  // ── IA ──────────────────────────────────────────────────────────────────
  'ia.modelo': {
    tipo: 'texto', grupo: 'ia', padrao: () => config.assistant.model,
    descricao: 'Modelo de IA que responde às perguntas. Só aparecem os liberados na conta OpenAI da empresa.',
  },
  'ia.temperatura': {
    tipo: 'numero', grupo: 'ia', padrao: () => config.assistant.temperature, min: 0, max: 1,
    descricao: 'Variação das respostas. Mais baixo dá respostas mais consistentes; para operação, fique abaixo de 0,4.',
  },
  'ia.max_tokens': {
    tipo: 'inteiro', grupo: 'ia', padrao: () => config.assistant.maxTokens, min: 200, max: 4000,
    descricao: 'Tamanho máximo da resposta, em tokens (cerca de 3 caracteres cada).',
  },
  'ia.max_rodadas': {
    tipo: 'inteiro', grupo: 'ia', padrao: () => config.assistant.maxToolRounds, min: 1, max: 12,
    descricao: 'Quantas vezes a IA pode voltar às fontes numa mesma pergunta antes de responder.',
  },

  // ── Áudio ───────────────────────────────────────────────────────────────
  'audio.responder_em_audio': {
    tipo: 'booleano', grupo: 'audio', padrao: () => true,
    descricao: 'Pergunta em áudio recebe resposta em áudio. Desligado, responde só texto.',
  },
  'audio.enviar_texto_junto': {
    tipo: 'booleano', grupo: 'audio', padrao: () => true,
    descricao: 'Manda o texto junto com o áudio. Recomendado: SN e protocolo não se copiam de um áudio.',
  },
  'audio.voz': {
    tipo: 'texto', grupo: 'audio', padrao: () => config.assistant.ttsVoice,
    opcoes: ['nova', 'shimmer', 'alloy', 'coral', 'sage', 'marin', 'echo', 'onyx', 'fable', 'ash', 'ballad', 'verse', 'cedar'],
    descricao: 'Voz da síntese. coral, sage, marin, ash, ballad, verse e cedar só existem no gpt-4o-mini-tts; no tts-1 elas viram nova.',
  },
  'audio.modelo': {
    tipo: 'texto', grupo: 'audio', padrao: () => config.tts.openaiSpeechModel || 'gpt-4o-mini-tts',
    opcoes: ['gpt-4o-mini-tts', 'tts-1', 'tts-1-hd'],
    descricao: 'Modelo de voz. O gpt-4o-mini-tts segue o estilo abaixo e soa mais natural; se a conta recusar, cai sozinho para o tts-1.',
  },
  'audio.estilo': {
    tipo: 'texto', grupo: 'audio', padrao: () => '',
    descricao: 'Como a voz deve falar (tom, ritmo, sotaque). Vazio usa o padrão: colega calmo do NOC, português do Brasil, devagar em números. Só vale no gpt-4o-mini-tts.',
  },
  'audio.max_caracteres': {
    tipo: 'inteiro', grupo: 'audio', padrao: () => 1500, min: 200, max: 4000,
    descricao: 'Acima disso o áudio é cortado. Resposta falada longa ninguém escuta até o fim.',
  },

  // ── Limites de automação ────────────────────────────────────────────────
  'limites.consultas_por_hora': {
    tipo: 'inteiro', grupo: 'limites', padrao: () => 60, min: 1, max: 1000,
    descricao: 'Perguntas por hora para cada pessoa. Protege o custo da IA e a carga no SGP e no Zabbix.',
  },

  // ── Alertas ─────────────────────────────────────────────────────────────
  'alertas.destino_grupo': {
    tipo: 'texto', grupo: 'alertas', padrao: () => config.evolutionTecnicos.grupoAlertas,
    descricao: 'Grupo de WhatsApp que recebe os alertas (o identificador termina em @g.us). Vazio: alertas só no painel.',
  },
  'alertas.silencio_inicio': {
    tipo: 'hora', grupo: 'alertas', padrao: () => '',
    descricao: 'Início do silêncio (HH:MM). Alertas críticos furam o silêncio. Vazio = sem silêncio.',
  },
  'alertas.silencio_fim': {
    tipo: 'hora', grupo: 'alertas', padrao: () => '',
    descricao: 'Fim do silêncio (HH:MM).',
  },

  // ── Monitor Zabbix ──────────────────────────────────────────────────────
  'monitor.zabbix.ativo': {
    tipo: 'booleano', grupo: 'monitor_zabbix', padrao: () => config.zabbix.enabled,
    descricao: 'Avisa quando surge incidente novo na rede.',
  },
  'monitor.zabbix.intervalo_seg': {
    tipo: 'inteiro', grupo: 'monitor_zabbix', padrao: () => 60, min: 30, max: 3600,
    descricao: 'De quanto em quanto tempo consulta o Zabbix.',
  },
  'monitor.zabbix.severidade_minima': {
    tipo: 'inteiro', grupo: 'monitor_zabbix', padrao: () => 3, min: 0, max: 5,
    descricao: '0 não classificado · 2 aviso · 3 médio · 4 alto · 5 desastre.',
  },
  'monitor.zabbix.tipos': {
    tipo: 'lista', grupo: 'monitor_zabbix',
    padrao: () => ['cto_off', 'pop_off', 'fibra', 'link', 'pppoe_off', 'energia'],
    opcoes: ['cto_off', 'pop_off', 'fibra', 'link', 'pppoe_off', 'energia', 'poe', 'equipamento_cliente', 'energia_cliente', 'outro'],
    descricao: 'Tipos de incidente que geram alerta.',
  },
  'monitor.zabbix.alertar_resolucao': {
    tipo: 'booleano', grupo: 'monitor_zabbix', padrao: () => true,
    descricao: 'Avisa também quando o incidente é resolvido, com o tempo que durou.',
  },

  // ── Monitor URA ─────────────────────────────────────────────────────────
  'monitor.ura.ativo': {
    tipo: 'booleano', grupo: 'monitor_ura', padrao: () => true,
    descricao: 'Recebe as chamadas da URA e avisa a Central.',
  },
  'monitor.ura.alertar_em': {
    tipo: 'texto', grupo: 'monitor_ura', padrao: () => 'fim',
    opcoes: ['inicio', 'identificacao', 'fim', 'nunca'],
    descricao: 'Quando mandar o aviso: no início (só número), ao identificar o cliente, ou no fim (com intenção e desfecho).',
  },

  // ── Monitor SLA de atendimento ──────────────────────────────────────────
  'monitor.sla.ativo': {
    tipo: 'booleano', grupo: 'monitor_sla', padrao: () => false,
    descricao: 'Avisa quando conversa de atendimento fica sem resposta além do limite.',
  },
  'monitor.sla.fonte': {
    tipo: 'texto', grupo: 'monitor_sla', padrao: () => 'chat',
    opcoes: ['chat', 'evolution'],
    descricao: 'Onde ler as conversas. "chat": sistema de atendimento (número oficial e Evolution). "evolution": direto de uma instância do Evolution.',
  },
  'monitor.sla.minutos': {
    tipo: 'inteiro', grupo: 'monitor_sla', padrao: () => 15, min: 1, max: 1440,
    descricao: 'Tempo de espera que dispara o aviso.',
  },
  'monitor.sla.intervalo_seg': {
    tipo: 'inteiro', grupo: 'monitor_sla', padrao: () => 60, min: 30, max: 900,
    descricao: 'De quanto em quanto tempo verifica as conversas.',
  },
  'monitor.sla.horario_inicio': {
    tipo: 'hora', grupo: 'monitor_sla', padrao: () => '08:00',
    descricao: 'Fora do expediente a espera não conta.',
  },
  'monitor.sla.horario_fim': {
    tipo: 'hora', grupo: 'monitor_sla', padrao: () => '18:00',
    descricao: 'Fim do expediente.',
  },
  'monitor.sla.setor_padrao': {
    tipo: 'texto', grupo: 'monitor_sla', padrao: () => 'Atendimento',
    descricao: 'Setor mostrado quando a conversa não tem etiqueta.',
  },

  // ── Monitor NetFlow ─────────────────────────────────────────────────────
  'monitor.netflow.ativo': {
    tipo: 'booleano', grupo: 'monitor_netflow', padrao: () => config.netflow.enabled,
    descricao: 'Avisa quando a coleta do NetFlow para, quando o tráfego cai de forma brusca e quando há suspeita de ataque.',
  },
  'monitor.netflow.intervalo_seg': {
    tipo: 'inteiro', grupo: 'monitor_netflow', padrao: () => 300, min: 60, max: 3600,
    descricao: 'De quanto em quanto tempo verifica o tráfego.',
  },
  'monitor.netflow.variacao_pct': {
    tipo: 'inteiro', grupo: 'monitor_netflow', padrao: () => 40, min: 5, max: 95,
    descricao: 'Queda de tráfego (em %) em relação ao mesmo horário de ontem que gera alerta. Também é o limiar de "alteração relevante" nas consultas.',
  },
  'monitor.netflow.minimo_mbps': {
    tipo: 'inteiro', grupo: 'monitor_netflow', padrao: () => 100, min: 1, max: 100000,
    descricao: 'Só avalia queda quando o tráfego de referência passa deste valor (madrugada com pouco tráfego não alerta).',
  },
  'monitor.netflow.alertar_ataques': {
    tipo: 'booleano', grupo: 'monitor_netflow', padrao: () => true,
    descricao: 'Avisa suspeitas de ataque de severidade crítica detectadas pelo Flow Guard.',
  },

  // ── Monitor do sinal das CTOs (QuestDB) ─────────────────────────────────
  'monitor.ctos.ativo': {
    tipo: 'booleano', grupo: 'monitor_ctos', padrao: () => config.questdb.enabled,
    descricao: 'Avisa quando o sinal de uma CTO fica pior que o normal dela e quando a coleta para.',
  },
  'monitor.ctos.intervalo_seg': {
    tipo: 'inteiro', grupo: 'monitor_ctos', padrao: () => 600, min: 300, max: 3600,
    descricao: 'De quanto em quanto tempo verifica (segundos). A coleta é a cada 5 minutos.',
  },
  'monitor.ctos.limiar_db': {
    tipo: 'numero', grupo: 'monitor_ctos', padrao: () => 3, min: 1, max: 15,
    descricao: 'Piora mínima, em dB, para avisar. CTO que oscila muito usa 3× a própria oscilação, se for maior.',
  },
  'monitor.ctos.critico_db': {
    tipo: 'numero', grupo: 'monitor_ctos', padrao: () => 6, min: 2, max: 30,
    descricao: 'Piora a partir da qual o aviso é crítico (fura o horário de silêncio).',
  },
  'monitor.ctos.janela_min': {
    tipo: 'inteiro', grupo: 'monitor_ctos', padrao: () => 30, min: 10, max: 240,
    descricao: 'Minutos recentes comparados com o normal. Mais curto avisa antes; mais longo ignora picos isolados.',
  },
  'monitor.ctos.dias_referencia': {
    tipo: 'inteiro', grupo: 'monitor_ctos', padrao: () => 7, min: 1, max: 60,
    descricao: 'Dias anteriores que definem o sinal normal de cada CTO.',
  },
  'monitor.ctos.alertar_coleta': {
    tipo: 'booleano', grupo: 'monitor_ctos', padrao: () => true,
    descricao: 'Avisa quando o QuestDB para de receber leituras das CTOs.',
  },

  // ── Resumo diário ───────────────────────────────────────────────────────
  'resumo.ativo': {
    tipo: 'booleano', grupo: 'resumo', padrao: () => true,
    descricao: 'Manda todo dia no grupo de alertas um resumo das últimas 24 horas.',
  },
  'resumo.hora': {
    tipo: 'hora', grupo: 'resumo', padrao: () => '07:00',
    descricao: 'Horário do envio (HH:MM). O resumo cobre as 24 horas anteriores a ele.',
  },
  'resumo.secoes': {
    tipo: 'lista', grupo: 'resumo',
    padrao: () => ['rede', 'ctos', 'trafego', 'os', 'clientes', 'ura', 'atendimento', 'assistente'],
    opcoes: ['rede', 'ctos', 'trafego', 'os', 'clientes', 'ura', 'atendimento', 'assistente'],
    descricao: 'O que entra no resumo.',
  },

  // ── Relatórios do SGP ───────────────────────────────────────────────────
  'relatorios.motivos_instalacao': {
    tipo: 'lista', grupo: 'relatorios',
    // "ADESÃO" no SGP é categoria: agrupa instalação, retirada e mudança de
    // endereço. Por isso o critério usa o motivo específico, não a categoria.
    padrao: () => ['instalacao de kit', 'reativacao'],
    descricao: 'Trechos do motivo da O.S. que contam como instalação de cliente (sem acento, separados por vírgula). Ex.: "instalacao de kit".',
  },
  'relatorios.motivos_cancelamento': {
    tipo: 'lista', grupo: 'relatorios',
    padrao: () => ['retirada', 'cancel', 'recolh', 'desinstala'],
    descricao: 'Trechos do motivo da O.S. que contam como cancelamento ou retirada de equipamento (ex.: "ADESÃO - Retirada").',
  },

  // ── WhatsApp dos técnicos ───────────────────────────────────────────────
  'whatsapp.acesso': {
    tipo: 'texto', grupo: 'whatsapp', padrao: () => 'cadastrados',
    opcoes: ['cadastrados', 'rede', 'aberto'],
    descricao:
      'Quem pode perguntar pelo WhatsApp. cadastrados = só números da aba Técnicos. ' +
      'rede = qualquer número pergunta sobre a rede (incidentes, links, tráfego), sem dados de cliente; ' +
      'cadastrados continuam com acesso completo. aberto = qualquer número vê tudo, inclusive dados de clientes (não recomendado: LGPD). ' +
      'Número desativado na aba Técnicos continua bloqueado em qualquer modo.',
  },
  'whatsapp.fontes_publicas': {
    tipo: 'lista', grupo: 'whatsapp', padrao: () => ['zabbix', 'netflow', 'questdb'],
    opcoes: FONTES_PUBLICAS,
    descricao: 'No modo "rede", fontes que um número não cadastrado pode consultar. Cadastro de cliente (SGP), URA e atendimento ficam sempre de fora.',
  },
  'whatsapp.limite_publico_hora': {
    tipo: 'inteiro', grupo: 'whatsapp', padrao: () => 10, min: 1, max: 200,
    descricao: 'Perguntas por hora para cada número não cadastrado. Protege o custo da IA contra curiosos e abuso.',
  },

  // ── Fontes ──────────────────────────────────────────────────────────────
  'fontes.habilitadas': {
    tipo: 'lista', grupo: 'fontes', padrao: () => [...FONTES], opcoes: FONTES,
    descricao: 'Fontes que o assistente pode consultar. Desligar uma tira as ferramentas dela para todos.',
  },
} as const satisfies Record<string, Definicao>;

export type ChaveConfig = keyof typeof DEFINICOES;

let cache: Map<string, unknown> | null = null;

function carregar(): Map<string, unknown> {
  if (cache) return cache;
  const m = new Map<string, unknown>();
  const linhas = db().prepare(`SELECT chave, valor FROM configuracao`).all() as Array<{ chave: string; valor: string }>;
  for (const l of linhas) {
    try {
      m.set(l.chave, JSON.parse(l.valor));
    } catch {
      logger.warn(`Config dinâmica: valor ilegível em ${l.chave}, usando padrão`);
    }
  }
  cache = m;
  return m;
}

export function obter<T = unknown>(chave: ChaveConfig): T {
  const m = carregar();
  if (m.has(chave)) return m.get(chave) as T;
  return (DEFINICOES[chave] as Definicao).padrao() as T;
}

/** Valida e converte. Lança com mensagem legível — ela aparece no painel. */
export function validar(chave: string, valor: unknown): unknown {
  const def = (DEFINICOES as Record<string, Definicao>)[chave];
  if (!def) throw new Error(`chave desconhecida: ${chave}`);

  switch (def.tipo) {
    case 'booleano':
      if (typeof valor === 'boolean') return valor;
      if (valor === 'true' || valor === 1) return true;
      if (valor === 'false' || valor === 0) return false;
      throw new Error(`${chave} precisa ser verdadeiro ou falso`);

    case 'numero':
    case 'inteiro': {
      const n = Number(valor);
      if (!Number.isFinite(n)) throw new Error(`${chave} precisa ser número`);
      if (def.tipo === 'inteiro' && !Number.isInteger(n)) throw new Error(`${chave} precisa ser inteiro`);
      if (def.min !== undefined && n < def.min) throw new Error(`${chave} mínimo ${def.min}`);
      if (def.max !== undefined && n > def.max) throw new Error(`${chave} máximo ${def.max}`);
      return n;
    }

    case 'hora': {
      const s = String(valor ?? '').trim();
      if (s === '') return '';
      if (!HORA.test(s)) throw new Error(`${chave} precisa estar no formato HH:MM`);
      return s;
    }

    case 'lista': {
      const arr = Array.isArray(valor) ? valor : String(valor).split(',').map((x) => x.trim()).filter(Boolean);
      if (def.opcoes) {
        const invalidas = arr.filter((x) => !def.opcoes!.includes(String(x)));
        if (invalidas.length) throw new Error(`${chave}: opções inválidas ${invalidas.join(', ')}`);
      }
      return arr.map(String);
    }

    case 'texto': {
      const s = String(valor ?? '').trim();
      if (def.opcoes && s && !def.opcoes.includes(s)) {
        throw new Error(`${chave} precisa ser um de: ${def.opcoes.join(', ')}`);
      }
      return s;
    }
  }
}

export function definir(chave: ChaveConfig, valor: unknown, autor: string): unknown {
  const convertido = validar(chave, valor);
  const anterior = obter(chave);

  db().prepare(
    `INSERT INTO configuracao (chave, valor, atualizado_em, atualizado_por) VALUES (?,?,?,?)
     ON CONFLICT(chave) DO UPDATE SET valor=excluded.valor,
       atualizado_em=excluded.atualizado_em, atualizado_por=excluded.atualizado_por`,
  ).run(chave, JSON.stringify(convertido), new Date().toISOString(), autor);

  cache = null;
  registrarAuditoria(autor, 'config.definir', chave, anterior, convertido);
  logger.info(`Config dinâmica: ${chave} alterada por ${autor}`);
  return convertido;
}

/** Volta ao padrão (apaga a sobrescrita). */
export function restaurar(chave: ChaveConfig, autor: string): void {
  const anterior = obter(chave);
  db().prepare(`DELETE FROM configuracao WHERE chave = ?`).run(chave);
  cache = null;
  registrarAuditoria(autor, 'config.restaurar', chave, anterior, (DEFINICOES[chave] as Definicao).padrao());
}

/** Tudo, com valor atual, padrão e se foi alterado — o que o painel renderiza. */
export function listar(): Array<{
  chave: string; grupo: string; tipo: string; descricao: string;
  valor: unknown; padrao: unknown; alterado: boolean;
  min?: number; max?: number; opcoes?: readonly string[];
}> {
  const m = carregar();
  return Object.entries(DEFINICOES as Record<string, Definicao>).map(([chave, def]) => ({
    chave,
    grupo: def.grupo,
    tipo: def.tipo,
    descricao: def.descricao,
    valor: m.has(chave) ? m.get(chave) : def.padrao(),
    padrao: def.padrao(),
    alterado: m.has(chave),
    min: def.min,
    max: def.max,
    opcoes: def.opcoes,
  }));
}

export function fontesHabilitadas(): FonteId[] {
  return obter<FonteId[]>('fontes.habilitadas');
}

/** "HH:MM" dentro de [inicio, fim), tratando a janela que vira a meia-noite. */
export function dentroDaJanela(inicio: string, fim: string, agora = new Date()): boolean {
  if (!inicio || !fim) return false;
  const local = agora.toLocaleTimeString('pt-BR', {
    hour: '2-digit', minute: '2-digit', hour12: false, timeZone: config.tz,
  });
  if (inicio <= fim) return local >= inicio && local < fim;
  return local >= inicio || local < fim;   // ex.: 22:00 → 07:00
}
