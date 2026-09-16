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
  grupo: 'ia' | 'audio' | 'limites' | 'alertas' | 'monitor_zabbix' | 'monitor_ura' | 'monitor_sla' | 'resumo' | 'fontes';
  min?: number;
  max?: number;
  opcoes?: readonly string[];
}

const HORA = /^([01]\d|2[0-3]):[0-5]\d$/;

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
    opcoes: ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'],
    descricao: 'Voz da síntese.',
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
    padrao: () => ['rede', 'os', 'ura', 'atendimento', 'assistente'],
    opcoes: ['rede', 'os', 'ura', 'atendimento', 'assistente'],
    descricao: 'O que entra no resumo.',
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
