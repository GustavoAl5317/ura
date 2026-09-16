// Monitor de SLA do atendimento no WhatsApp (Bloco 4).
//
// Lê as conversas de uma instância do Evolution (EVO_ATEND_*) e avisa quando a
// última mensagem é do cliente e ninguém respondeu além do limite configurado.
// Só lê. O aviso vai para o grupo dos técnicos, pela instância deles.
//
// Limite conhecido: número atendido pela API oficial da Meta não passa pelo
// Evolution e fica invisível aqui. E o Evolution não distingue resposta de
// robô de resposta humana — serve para número atendido por pessoas.
//
// NASCE DESLIGADO. Antes de ligar, confira GET /api/monitores/sla/diagnostico —
// ele mostra como as conversas estão sendo entendidas, sem nome nem texto.

import { config } from '../../config';
import { EvolutionClient } from '../../integrations/evolution';
import { db } from '../store/db';
import { obter, dentroDaJanela } from '../config-dinamica';
import { emitir, marcarResolvido, horaCurta } from '../alertas';
import { iniciarMonitor } from './base';

export const evoAtendimento = new EvolutionClient(
  {
    apiUrl: config.evolutionAtendimento.apiUrl,
    instance: config.evolutionAtendimento.instance,
    apiKey: config.evolutionAtendimento.apiKey,
  },
  'evolution-atendimento',
);

/** Conversa parada há mais que isto não é espera, é conversa encerrada sem despedida. */
const JANELA_MAX_HORAS = 12;
/** Teto de alertas por ciclo: acima disso, um resumo — avalanche não é lida. */
const MAX_ALERTAS_CICLO = 15;
/** Teto de consultas de mensagens por ciclo, para conversa sem lastMessage embutido. */
const MAX_BUSCAS_MENSAGEM = 40;

export interface ConversaLida {
  jid: string;
  nome: string | null;
  ultimaMsgId: string | null;
  ultimaDeMim: boolean | null;
  ultimaEm: Date | null;
  setor: string | null;
  origemDaUltima: 'lastMessage' | 'findMessages' | 'nenhuma';
}

type Obj = Record<string, unknown>;

/** messageTimestamp vem em segundos, milissegundos, string ou {low, high} (Long do protobuf). */
function lerTimestamp(v: unknown): Date | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'object' && v && 'low' in (v as Obj)) v = (v as { low: number }).low;
  if (typeof v === 'string' && /\D/.test(v)) {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n > 1e12 ? n : n * 1000);
}

function lerMensagem(m: unknown): { id: string | null; deMim: boolean | null; em: Date | null } {
  const o = (m ?? {}) as Obj;
  const key = (o.key ?? {}) as Obj;
  const deMim = typeof key.fromMe === 'boolean' ? key.fromMe : typeof o.fromMe === 'boolean' ? o.fromMe : null;
  return {
    id: (key.id as string) ?? (o.id as string) ?? null,
    deMim,
    em: lerTimestamp(o.messageTimestamp ?? o.timestamp),
  };
}

export function lerConversa(bruta: unknown): Omit<ConversaLida, 'origemDaUltima'> & { temUltima: boolean } | null {
  const c = (bruta ?? {}) as Obj;
  const jid = (c.remoteJid as string) ?? (c.id as string) ?? (c.jid as string);
  if (!jid || typeof jid !== 'string') return null;
  // Grupo, status e newsletter não são atendimento.
  if (jid.endsWith('@g.us') || jid === 'status@broadcast' || jid.endsWith('@newsletter')) return null;

  const ultima = c.lastMessage ? lerMensagem(c.lastMessage) : null;
  const labels = Array.isArray(c.labels) ? c.labels as Obj[] : [];

  return {
    jid,
    nome: (c.pushName as string) ?? (c.name as string) ?? ((c.lastMessage as Obj)?.pushName as string) ?? null,
    ultimaMsgId: ultima?.id ?? null,
    ultimaDeMim: ultima?.deMim ?? null,
    ultimaEm: ultima?.em ?? lerTimestamp(c.updatedAt),
    setor: (labels[0]?.name as string) ?? (c.label as string) ?? null,
    temUltima: !!ultima && ultima.deMim !== null,
  };
}

async function completarUltima(conv: ReturnType<typeof lerConversa> & object): Promise<ConversaLida> {
  if (conv.temUltima) return { ...conv, origemDaUltima: 'lastMessage' };
  const msgs = await evoAtendimento.ultimasMensagens(conv.jid, 5);
  const lidas = msgs.map(lerMensagem).filter((m) => m.em && m.deMim !== null)
    .sort((a, b) => b.em!.getTime() - a.em!.getTime());
  if (!lidas.length) return { ...conv, origemDaUltima: 'nenhuma' };
  return {
    ...conv,
    ultimaMsgId: lidas[0].id,
    ultimaDeMim: lidas[0].deMim,
    ultimaEm: lidas[0].em,
    origemDaUltima: 'findMessages',
  };
}

/** Lê e interpreta as conversas recentes. Base do ciclo e do diagnóstico. */
async function lerConversasRecentes(): Promise<{ lidas: ConversaLida[]; brutas: number; ignoradas: number }> {
  const brutas = await evoAtendimento.buscarConversas();
  const limite = Date.now() - JANELA_MAX_HORAS * 3600_000;
  const lidas: ConversaLida[] = [];
  let buscas = 0;
  let ignoradas = 0;

  for (const b of brutas) {
    const c = lerConversa(b);
    if (!c) { ignoradas++; continue; }
    // Sem data nenhuma não dá para saber se é recente: conta como ignorada.
    if (c.ultimaEm && c.ultimaEm.getTime() < limite) { ignoradas++; continue; }
    if (!c.temUltima) {
      if (buscas >= MAX_BUSCAS_MENSAGEM) { ignoradas++; continue; }
      buscas++;
    }
    const completa = await completarUltima(c);
    if (!completa.ultimaEm || completa.ultimaEm.getTime() < limite) { ignoradas++; continue; }
    lidas.push(completa);
  }
  return { lidas, brutas: brutas.length, ignoradas };
}

export function iniciarMonitorSla(): () => void {
  return iniciarMonitor({
    nome: 'sla_whatsapp',
    descricao: 'Conversas de atendimento aguardando retorno além do limite',
    ativo: () => obter<boolean>('monitor.sla.ativo') && evoAtendimento.disponivel,
    intervaloSeg: () => obter<number>('monitor.sla.intervalo_seg'),
    ciclo: cicloSla,
  });
}

/** Um ciclo do monitor. Exportado para teste. */
export async function cicloSla(): Promise<{ alertas: number; detalhe: Record<string, unknown> }> {
  const inicio = obter<string>('monitor.sla.horario_inicio');
  const fim = obter<string>('monitor.sla.horario_fim');
  if (inicio && fim && !dentroDaJanela(inicio, fim)) {
    return { alertas: 0, detalhe: { fora_do_expediente: `${inicio}–${fim}` } };
  }

  const limiteMin = obter<number>('monitor.sla.minutos');
  const setorPadrao = obter<string>('monitor.sla.setor_padrao');
  const { lidas, brutas, ignoradas } = await lerConversasRecentes();
  const d = db();
  const agora = new Date();
  let emitidos = 0;
  let aguardando = 0;
  let excedentes = 0;
  let resolvidas = 0;

  const anterior = d.prepare(`SELECT * FROM sla_conversa WHERE jid = ?`);
  const salvar = d.prepare(
    `INSERT INTO sla_conversa (jid, nome, setor, ultima_msg_id, ultima_msg_cliente, aguardando_desde, alertado_msg_id, atualizada_em)
     VALUES (@jid,@nome,@setor,@ultima_msg_id,@ultima_msg_cliente,@aguardando_desde,@alertado_msg_id,@atualizada_em)
     ON CONFLICT(jid) DO UPDATE SET nome=excluded.nome, setor=excluded.setor,
       ultima_msg_id=excluded.ultima_msg_id, ultima_msg_cliente=excluded.ultima_msg_cliente,
       aguardando_desde=excluded.aguardando_desde, alertado_msg_id=excluded.alertado_msg_id,
       atualizada_em=excluded.atualizada_em`,
  );

  for (const c of lidas) {
    const prev = anterior.get(c.jid) as { alertado_msg_id: string | null } | undefined;
    const setor = c.setor ?? setorPadrao;

    if (c.ultimaDeMim) {
      // Respondida: se havia alerta dessa espera, marca resolvido.
      if (prev?.alertado_msg_id && marcarResolvido(`sla:${c.jid}:${prev.alertado_msg_id}`)) resolvidas++;
      salvar.run({
        jid: c.jid, nome: c.nome, setor, ultima_msg_id: c.ultimaMsgId,
        ultima_msg_cliente: null, aguardando_desde: null, alertado_msg_id: null,
        atualizada_em: agora.toISOString(),
      });
      continue;
    }

    aguardando++;
    const esperaMin = Math.floor((agora.getTime() - c.ultimaEm!.getTime()) / 60_000);
    let alertado = prev?.alertado_msg_id ?? null;

    if (esperaMin >= limiteMin && alertado !== c.ultimaMsgId) {
      if (emitidos < MAX_ALERTAS_CICLO) {
        const a = await emitir({
          origem: 'sla',
          severidade: esperaMin >= limiteMin * 3 ? 'critico' : 'aviso',
          titulo: `Aguardando retorno: ${c.nome ?? 'cliente sem nome'}`,
          texto: [
            '⚠️ *Atendimento aguardando retorno*',
            `Cliente: ${c.nome ?? 'sem nome no WhatsApp'}`,
            `Tempo de espera: ${esperaMin} minutos`,
            `Última mensagem: ${horaCurta(c.ultimaEm!)}`,
            `Setor responsável: ${setor}`,
          ].join('\n'),
          chave: `sla:${c.jid}:${c.ultimaMsgId ?? c.ultimaEm!.getTime()}`,
          dados: { jid: c.jid, nome: c.nome, setor, esperaMin, ultimaEm: c.ultimaEm!.toISOString() },
        });
        if (a) emitidos++;
      } else {
        excedentes++;
      }
      alertado = c.ultimaMsgId;
    }

    salvar.run({
      jid: c.jid, nome: c.nome, setor, ultima_msg_id: c.ultimaMsgId,
      ultima_msg_cliente: c.ultimaEm!.toISOString(), aguardando_desde: c.ultimaEm!.toISOString(),
      alertado_msg_id: alertado, atualizada_em: agora.toISOString(),
    });
  }

  // Conversa que estava esperando e sumiu da leitura foi encerrada ou ficou
  // parada além da janela. Sem isto, o alerta dela ficava aberto para sempre e
  // o "aguardando agora" do resumo contava fantasma.
  const vistas = new Set(lidas.map((c) => c.jid));
  const pendentes = d.prepare(
    `SELECT jid, alertado_msg_id FROM sla_conversa WHERE aguardando_desde IS NOT NULL`,
  ).all() as Array<{ jid: string; alertado_msg_id: string | null }>;
  const liberar = d.prepare(
    `UPDATE sla_conversa SET aguardando_desde = NULL, alertado_msg_id = NULL, atualizada_em = ? WHERE jid = ?`,
  );
  let sairamDaFila = 0;
  for (const p of pendentes) {
    if (vistas.has(p.jid)) continue;
    if (p.alertado_msg_id) marcarResolvido(`sla:${p.jid}:${p.alertado_msg_id}`);
    liberar.run(agora.toISOString(), p.jid);
    sairamDaFila++;
  }

  if (excedentes) {
    await emitir({
      origem: 'sla',
      severidade: 'critico',
      titulo: `Mais ${excedentes} conversas aguardando retorno`,
      texto: `⚠️ *Fila de atendimento*\nAlém dos avisos acima, mais ${excedentes} conversas passaram de ${limiteMin} min sem resposta. Veja o painel.`,
      chave: `sla:resumo:${agora.toISOString().slice(0, 16)}`,
    });
    emitidos++;
  }

  return {
    alertas: emitidos,
    detalhe: {
      conversas_lidas: brutas, recentes: lidas.length, ignoradas,
      aguardando, resolvidas, sairam_da_fila: sairamDaFila, limite_min: limiteMin,
    },
  };
}

/**
 * Diagnóstico para validar a leitura antes de ligar o monitor. Mostra como as
 * conversas foram entendidas — nunca nome de cliente nem texto de mensagem.
 */
export async function diagnosticoSla(): Promise<Record<string, unknown>> {
  if (!evoAtendimento.disponivel) {
    return { ok: false, erro: 'instância de atendimento não configurada (EVO_ATEND_* ou WHATSAPP_*)' };
  }
  const brutas = await evoAtendimento.buscarConversas();
  const amostra = brutas.slice(0, 3).map((b) => {
    const o = (b ?? {}) as Obj;
    return {
      campos: Object.keys(o).sort(),
      campos_lastMessage: o.lastMessage ? Object.keys(o.lastMessage as Obj).sort() : null,
      campos_lastMessage_key: (o.lastMessage as Obj)?.key ? Object.keys((o.lastMessage as Obj).key as Obj).sort() : null,
    };
  });
  const { lidas, ignoradas } = await lerConversasRecentes();

  return {
    ok: true,
    instancia: config.evolutionAtendimento.instance,
    conversas_devolvidas: brutas.length,
    estrutura_amostra: amostra,
    recentes_entendidas: lidas.length,
    ignoradas,
    como_foi_lida_a_ultima_mensagem: {
      lastMessage: lidas.filter((l) => l.origemDaUltima === 'lastMessage').length,
      findMessages: lidas.filter((l) => l.origemDaUltima === 'findMessages').length,
      nao_encontrada: lidas.filter((l) => l.origemDaUltima === 'nenhuma').length,
    },
    aguardando_cliente: lidas.filter((l) => l.ultimaDeMim === false).map((l) => ({
      espera_min: l.ultimaEm ? Math.floor((Date.now() - l.ultimaEm.getTime()) / 60_000) : null,
      setor: l.setor,
    })).slice(0, 15),
  };
}
