// Atendimento dos clientes: WhatsApp oficial (ura-chat, só leitura) e chamadas da URA.
//
// Os clientes chegam pelo número oficial da Meta e são atendidos pelo ura-chat
// (IA + atendentes). O banco dele é a única fonte que sabe quem mandou
// mensagem, quem foi transferido e quem está esperando. Este processo NUNCA
// escreve nele: abre só para leitura, consulta e fecha.

import fs from 'fs';
import Database from 'better-sqlite3';
import { config } from '../../config';
import { diaLocal, horaLocal, localParaUtc, partesLocais } from '../datas';
import { lerConversasDoChat } from '../monitors/sla-chat';
import { db } from '../store/db';
import { obter } from '../config-dinamica';
import { Ferramenta, medir, ferramentas } from './base';

const TOOL_TRANSFERENCIA = 'transferir_para_atendente';

/** Início do dia local de `d`. */
function inicioDoDia(d: Date): Date {
  const p = partesLocais(d);
  return localParaUtc(+p.year, +p.month, +p.day, 0, 0, 0);
}

/** Janela: "hoje" (padrão), "ontem" ou os últimos N dias contando hoje. */
export function janelaAtendimento(args: Record<string, unknown>, agora = new Date()): { inicio: Date; fim: Date; rotulo: string } {
  const hoje = inicioDoDia(agora);
  const periodo = String(args.periodo ?? 'hoje').toLowerCase();
  if (periodo === 'ontem') {
    const inicio = inicioDoDia(new Date(hoje.getTime() - 12 * 3600_000));
    return { inicio, fim: hoje, rotulo: `ontem (${diaLocal(inicio)})` };
  }
  const dias = Math.min(31, Math.max(1, Number(args.dias) || 1));
  if (dias === 1) return { inicio: hoje, fim: agora, rotulo: `hoje (${diaLocal(agora)}) até ${horaLocal(agora)}` };
  const inicio = inicioDoDia(new Date(hoje.getTime() - (dias - 1) * 86400_000 + 12 * 3600_000));
  return { inicio, fim: agora, rotulo: `últimos ${dias} dias (desde ${diaLocal(inicio)})` };
}

export function resumoAtendimento(arquivo: string, inicio: Date, fim: Date) {
  if (!fs.existsSync(arquivo)) throw new Error(`banco do atendimento não encontrado em ${arquivo} (CHAT_DB_PATH)`);
  const d = new Database(arquivo, { readonly: true, fileMustExist: true });
  try {
    const a = inicio.getTime();
    const b = fim.getTime();
    const um = <T>(sql: string, ...p: unknown[]) => d.prepare(sql).get(...p) as T;
    const varios = <T>(sql: string, ...p: unknown[]) => d.prepare(sql).all(...p) as T[];

    const clientes = um<{ n: number }>(
      `SELECT COUNT(DISTINCT conversa) n FROM eventos WHERE tipo = 'cliente' AND ts >= ? AND ts < ?`, a, b).n;
    const mensagens = um<{ n: number }>(
      `SELECT COUNT(*) n FROM eventos WHERE tipo = 'cliente' AND ts >= ? AND ts < ?`, a, b).n;
    const novas = um<{ n: number }>(
      `SELECT COUNT(*) n FROM conversas WHERE iniciada_em >= ? AND iniciada_em < ?`, a, b).n;
    const transferidas = um<{ n: number }>(
      `SELECT COUNT(DISTINCT conversa) n FROM eventos WHERE tipo = 'tool' AND tool_name = ? AND ts >= ? AND ts < ?`,
      TOOL_TRANSFERENCIA, a, b).n;
    const comAtendente = um<{ n: number }>(
      `SELECT COUNT(DISTINCT conversa) n FROM eventos WHERE tipo = 'atendente' AND ts >= ? AND ts < ?`, a, b).n;
    const soIa = um<{ n: number }>(
      `SELECT COUNT(DISTINCT e.conversa) n FROM eventos e
        WHERE e.tipo = 'cliente' AND e.ts >= ? AND e.ts < ?
          AND NOT EXISTS (SELECT 1 FROM eventos h WHERE h.conversa = e.conversa AND h.tipo = 'atendente' AND h.ts >= ? AND h.ts < ?)`,
      a, b, a, b).n;
    const porAtendente = varios<{ atendente: string | null; conversas: number; mensagens: number }>(
      `SELECT autor atendente, COUNT(DISTINCT conversa) conversas, COUNT(*) mensagens FROM eventos
        WHERE tipo = 'atendente' AND ts >= ? AND ts < ? GROUP BY autor ORDER BY conversas DESC LIMIT 15`, a, b);

    // Pico por hora local: agrupado em JS porque o banco guarda epoch em ms e o fuso é da operação.
    const porHora = new Map<string, number>();
    for (const r of varios<{ ts: number }>(`SELECT ts FROM eventos WHERE tipo = 'cliente' AND ts >= ? AND ts < ?`, a, b)) {
      const h = `${partesLocais(new Date(r.ts)).hour}h`;
      porHora.set(h, (porHora.get(h) ?? 0) + 1);
    }
    const horas = [...porHora.entries()].sort((x, y) => x[0].localeCompare(y[0])).map(([hora, n]) => ({ hora, mensagens: n }));
    const pico = horas.reduce<{ hora: string; mensagens: number } | null>((m, x) => (!m || x.mensagens > m.mensagens ? x : m), null);

    return {
      clientes_que_mandaram_mensagem: clientes,
      mensagens_de_clientes: mensagens,
      conversas_novas: novas,
      resolvidas_so_pela_ia: soIa,
      transferidas_para_atendente: transferidas,
      atendidas_por_atendente: comAtendente,
      por_atendente: porAtendente.map((x) => ({ ...x, atendente: x.atendente || '(sem nome)' })),
      mensagens_por_hora: horas,
      horario_de_pico: pico,
    };
  } finally {
    d.close();
  }
}

const atendimento: Ferramenta = {
  nome: 'atendimento_whatsapp',
  fonte: 'whatsapp',
  descricao:
    'Atendimento dos CLIENTES pelo WhatsApp oficial (ura-chat): quantos clientes mandaram mensagem, ' +
    'quantas mensagens, conversas novas, quantas a IA resolveu sozinha, quantas foram transferidas, ' +
    'quanto cada atendente atendeu, pico por hora e quem está esperando resposta AGORA. ' +
    'Responde "quantos clientes chamaram no chat hoje?", "tem cliente esperando?", "como foi o atendimento ontem?". ' +
    'Não é o WhatsApp dos técnicos (este aqui).',
  parametros: {
    type: 'object',
    properties: {
      periodo: { type: 'string', enum: ['hoje', 'ontem'], description: 'Padrão: hoje' },
      dias: { type: 'number', description: 'Últimos N dias contando hoje (máx 31); ignora periodo' },
    },
    required: [],
  },
  async executar(args, ctx) {
    return [await medir<Record<string, unknown>>(ctx, 'whatsapp', 'whatsapp.atendimento', args, async () => {
      const agora = new Date();
      const j = args.dias ? janelaAtendimento({ dias: args.dias }, agora) : janelaAtendimento(args, agora);
      const r = resumoAtendimento(config.chatAtendimento.dbPath, j.inicio, j.fim);
      const { conversas } = lerConversasDoChat(agora);
      const esperando = conversas
        .filter((c) => c.situacao === 'aguardando_resposta' || c.situacao === 'aguardando_assumir')
        .sort((x, y) => (x.ultimaEm?.getTime() ?? 0) - (y.ultimaEm?.getTime() ?? 0));
      return {
        vazio: r.mensagens_de_clientes === 0 && esperando.length === 0,
        dados: {
          periodo: j.rotulo,
          inicio: j.inicio.toISOString(),
          fim: j.fim.toISOString(),
          ...r,
          esperando_agora: {
            total: esperando.length,
            aguardando_atendente_assumir: esperando.filter((c) => c.situacao === 'aguardando_assumir').length,
            aguardando_resposta_do_atendente: esperando.filter((c) => c.situacao === 'aguardando_resposta').length,
            mais_antigos: esperando.slice(0, 10).map((c) => ({
              cliente: c.nome ?? '(sem nome)',
              situacao: c.situacao === 'aguardando_assumir' ? 'aguardando atendente assumir' : 'aguardando resposta',
              atendente: c.setor,
              desde: c.ultimaEm?.toISOString() ?? null,
              espera_min: c.ultimaEm ? Math.round((agora.getTime() - c.ultimaEm.getTime()) / 60_000) : null,
            })),
          },
          origem: 'banco do ura-chat (atendimento oficial), lido na hora',
        },
      };
    })];
  },
};

// ─── Chamadas da URA ─────────────────────────────────────────────────────────

const SEM_FIM_APOS_MS = 2 * 3600_000;

interface LinhaChamada {
  call_id: string; numero: string | null; cliente_nome: string | null; contrato_id: number | null;
  intencao: string | null; status: string; iniciada_em: string; encerrada_em: string | null; duracao_seg: number | null;
}

export function resumoChamadas(inicio: Date, fim: Date, limite = 15) {
  const d = db();
  const ultima = (d.prepare(`SELECT MAX(iniciada_em) m FROM chamada_ura`).get() as { m: string | null }).m;
  if (!ultima) {
    throw new Error('nenhuma chamada da URA chegou ao assistente até hoje: a ponte da URA não está enviando os eventos');
  }
  const linhas = d.prepare(
    `SELECT call_id, numero, cliente_nome, contrato_id, intencao, status, iniciada_em, encerrada_em, duracao_seg
       FROM chamada_ura WHERE iniciada_em >= ? AND iniciada_em < ? ORDER BY iniciada_em DESC`,
  ).all(inicio.toISOString(), fim.toISOString()) as LinhaChamada[];
  // Ligação não dura horas: "em andamento" antigo é aviso de fim que a URA não entregou.
  const limite2h = Date.now() - SEM_FIM_APOS_MS;
  for (const l of linhas) {
    if (l.status === 'em_andamento' && Date.parse(l.iniciada_em) < limite2h) l.status = 'sem_aviso_de_encerramento';
  }

  const contar = (f: (l: LinhaChamada) => string) => {
    const m = new Map<string, number>();
    for (const l of linhas) m.set(f(l), (m.get(f(l)) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([nome, n]) => ({ nome, n }));
  };
  const duracoes = linhas.map((l) => l.duracao_seg).filter((x): x is number => typeof x === 'number');
  const porNumero = contar((l) => l.numero ?? '(sem número)').filter((x) => x.n > 1 && x.nome !== '(sem número)');
  const porHora = new Map<string, number>();
  for (const l of linhas) {
    const h = `${partesLocais(new Date(l.iniciada_em)).hour}h`;
    porHora.set(h, (porHora.get(h) ?? 0) + 1);
  }
  const pico = [...porHora.entries()].reduce<{ hora: string; chamadas: number } | null>(
    (m, [hora, n]) => (!m || n > m.chamadas ? { hora, chamadas: n } : m), null);

  return {
    chamadas: linhas.length,
    em_andamento: linhas.filter((l) => l.status === 'em_andamento').length,
    sem_aviso_de_encerramento: linhas.filter((l) => l.status === 'sem_aviso_de_encerramento').length,
    encerradas: linhas.filter((l) => l.status === 'encerrada').length,
    transferidas_para_atendente: linhas.filter((l) => l.status === 'transferida').length,
    clientes_identificados: linhas.filter((l) => l.cliente_nome).length,
    nao_identificados: linhas.filter((l) => !l.cliente_nome).length,
    por_intencao: contar((l) => l.intencao ?? 'não identificada'),
    duracao_media_seg: duracoes.length ? Math.round(duracoes.reduce((a, b) => a + b, 0) / duracoes.length) : null,
    numeros_que_ligaram_mais_de_uma_vez: porNumero.slice(0, 10).map((x) => ({ numero: x.nome, chamadas: x.n })),
    horario_de_pico: pico,
    ultimas: linhas.slice(0, limite).map((l) => ({
      inicio: l.iniciada_em, numero: l.numero, cliente: l.cliente_nome, contrato: l.contrato_id,
      intencao: l.intencao ?? 'não identificada', status: l.status, duracao_seg: l.duracao_seg,
    })),
    ultima_chamada_recebida_em: ultima,
  };
}

const chamadasUra: Ferramenta = {
  nome: 'chamadas_ura',
  fonte: 'ura',
  descricao:
    'Ligações recebidas pela URA (atendimento telefônico): quantas chamadas, por intenção (suporte, ' +
    'financeiro...), quantas foram transferidas para atendente, clientes identificados, quem ligou mais ' +
    'de uma vez, pico por hora e as últimas chamadas com número, cliente e status. ' +
    'Responde "quantas ligações hoje?", "quem ligou na URA?", "muita gente ligando por falta de internet?".',
  parametros: {
    type: 'object',
    properties: {
      periodo: { type: 'string', enum: ['hoje', 'ontem'], description: 'Padrão: hoje' },
      dias: { type: 'number', description: 'Últimos N dias contando hoje (máx 31); ignora periodo' },
      horas: { type: 'number', description: 'Últimas N horas (máx 72); ignora periodo e dias' },
      limite: { type: 'number', description: 'Quantas chamadas listar (padrão 15, máx 50)' },
    },
    required: [],
  },
  async executar(args, ctx) {
    return [await medir<Record<string, unknown>>(ctx, 'ura', 'ura.chamadas', args, async () => {
      if (!obter<boolean>('monitor.ura.ativo')) {
        throw new Error('monitor da URA desligado no painel: as chamadas não estão sendo registradas');
      }
      const agora = new Date();
      const horas = Math.min(72, Math.max(0, Number(args.horas) || 0));
      const j = horas
        ? { inicio: new Date(agora.getTime() - horas * 3600_000), fim: agora, rotulo: `últimas ${horas} horas` }
        : janelaAtendimento(args.dias ? { dias: args.dias } : args, agora);
      const r = resumoChamadas(j.inicio, j.fim, Math.min(50, Math.max(1, Number(args.limite) || 15)));
      return {
        vazio: r.chamadas === 0,
        dados: { periodo: j.rotulo, inicio: j.inicio.toISOString(), fim: j.fim.toISOString(), ...r },
      };
    })];
  },
};

export function registrarFerramentasAtendimento(): void {
  ferramentas.registrar(atendimento, chamadasUra);
}
