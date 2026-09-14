// Monitor de chamadas da URA (Bloco 4).
//
// A URA roda em OUTRA máquina e empurra eventos para cá (POST /api/eventos/ura),
// pela ponte em src/admin/assistant-bridge.ts. Empurrar em vez de puxar: o
// assistente não precisa enxergar a rede da URA, e se ele estiver fora, a URA
// segue atendendo — a ponte é fogo-e-esquece, com timeout curto.
//
// A intenção é DERIVADA das ferramentas que a URA usou na ligação. A URA não
// classifica intenção explicitamente, e inventar uma a partir do áudio aqui
// seria exatamente o tipo de conclusão sem dado que o projeto proíbe.

import { db } from '../store/db';
import { obter } from '../config-dinamica';
import { emitir, horaCurta, duracaoHumana } from '../alertas';
import { publicar } from '../eventos';
import { logger } from '../../logger';

export interface EventoUra {
  tipo: 'inicio' | 'identificado' | 'ferramenta' | 'fim';
  callId: string;
  numero?: string;
  clienteNome?: string;
  contratoId?: number;
  ferramenta?: string;
  ferramentas?: string[];
  at?: string;
}

/** Ferramenta da URA → intenção. Ordem importa: a primeira categoria usada com peso vence. */
const INTENCAO: Array<{ intencao: string; ferramentas: string[] }> = [
  { intencao: 'Suporte técnico', ferramentas: ['verificar_massiva', 'consultar_zabbix', 'consultar_onu', 'reiniciar_onu', 'abrir_chamado', 'agendar_visita_tecnica'] },
  { intencao: 'Financeiro', ferramentas: ['consultar_financeiro', 'gerar_segunda_via', 'desbloqueio_confianca'] },
  { intencao: 'Vendas / nova instalação', ferramentas: ['verificar_viabilidade', 'consultar_planos', 'registrar_interesse'] },
];

export function derivarIntencao(ferramentas: string[]): string | null {
  const usadas = new Set(ferramentas);
  let melhor: { intencao: string; n: number } | null = null;
  for (const c of INTENCAO) {
    const n = c.ferramentas.filter((f) => usadas.has(f)).length;
    if (n && (!melhor || n > melhor.n)) melhor = { intencao: c.intencao, n };
  }
  return melhor?.intencao ?? null;
}

function mascararNumero(n: string | null | undefined): string {
  const d = (n ?? '').replace(/\D/g, '');
  if (d.length < 8) return n || 'desconhecido';
  const local = d.startsWith('55') && d.length > 11 ? d.slice(2) : d;
  // (85) 9XXXX-1234: identifica para a Central sem expor o número inteiro no grupo.
  return `(${local.slice(0, 2)}) ${local.slice(2, 3)}XXXX-${local.slice(-4)}`;
}

interface LinhaChamada {
  call_id: string;
  numero: string | null;
  cliente_nome: string | null;
  contrato_id: number | null;
  intencao: string | null;
  status: string;
  ferramentas: string | null;
  iniciada_em: string;
  encerrada_em: string | null;
  duracao_seg: number | null;
}

function carregar(callId: string): LinhaChamada | undefined {
  return db().prepare(`SELECT * FROM chamada_ura WHERE call_id = ?`).get(callId) as LinhaChamada | undefined;
}

export async function receberEventoUra(e: EventoUra): Promise<{ ok: boolean; motivo?: string }> {
  if (!e?.callId || !e.tipo) return { ok: false, motivo: 'evento sem callId ou tipo' };
  if (!obter<boolean>('monitor.ura.ativo')) return { ok: true, motivo: 'monitor da URA desligado' };

  const d = db();
  const agora = e.at ?? new Date().toISOString();
  const atual = carregar(e.callId);

  if (!atual) {
    d.prepare(
      `INSERT INTO chamada_ura (call_id, numero, cliente_nome, contrato_id, status, ferramentas, iniciada_em, atualizada_em)
       VALUES (?,?,?,?, 'em_andamento', '[]', ?, ?)`,
    ).run(e.callId, e.numero ?? null, e.clienteNome ?? null, e.contratoId ?? null, agora, agora);
  }

  const linha = carregar(e.callId)!;
  let ferramentas: string[] = [];
  try { ferramentas = JSON.parse(linha.ferramentas ?? '[]'); } catch { ferramentas = []; }

  if (e.ferramenta && !ferramentas.includes(e.ferramenta)) ferramentas.push(e.ferramenta);
  for (const f of e.ferramentas ?? []) if (!ferramentas.includes(f)) ferramentas.push(f);

  const transferida = ferramentas.includes('transferir_para_atendente');
  const intencao = derivarIntencao(ferramentas);
  let status = linha.status;
  let encerradaEm = linha.encerrada_em;
  let duracao = linha.duracao_seg;

  if (e.tipo === 'fim') {
    status = transferida ? 'transferida' : 'encerrada';
    encerradaEm = agora;
    duracao = Math.max(0, Math.round((new Date(agora).getTime() - new Date(linha.iniciada_em).getTime()) / 1000));
  }

  d.prepare(
    `UPDATE chamada_ura SET numero = COALESCE(?, numero), cliente_nome = COALESCE(?, cliente_nome),
       contrato_id = COALESCE(?, contrato_id), intencao = ?, status = ?, ferramentas = ?,
       encerrada_em = ?, duracao_seg = ?, atualizada_em = ?
     WHERE call_id = ?`,
  ).run(
    e.numero ?? null, e.clienteNome ?? null, e.contratoId ?? null, intencao, status,
    JSON.stringify(ferramentas), encerradaEm, duracao, agora, e.callId,
  );

  const chamada = carregar(e.callId)!;
  publicar('chamada', { ...chamada, ferramentas });

  // Alerta no momento configurado — um por chamada.
  const momento = obter<string>('monitor.ura.alertar_em');
  const disparar =
    (momento === 'inicio' && e.tipo === 'inicio') ||
    (momento === 'identificacao' && (e.tipo === 'identificado' || (e.tipo === 'fim' && !chamada.cliente_nome))) ||
    (momento === 'fim' && e.tipo === 'fim');

  if (disparar) {
    const linhas = [
      `📞 *${e.tipo === 'fim' ? 'Chamada na URA' : 'Nova chamada recebida'}*`,
      `${horaCurta(chamada.iniciada_em)} — ${chamada.cliente_nome ?? 'cliente não identificado'}`,
      `Número: ${mascararNumero(chamada.numero)}`,
      chamada.contrato_id ? `Contrato SGP: ${chamada.contrato_id}` : null,
      // Intenção só aparece quando há ferramenta que a sustente.
      intencao ? `Intenção: ${intencao}` : (e.tipo === 'fim' ? 'Intenção: não identificada' : null),
      e.tipo === 'fim'
        ? `Status: ${status === 'transferida' ? 'transferida para atendente' : 'encerrada na URA'}${duracao !== null ? ` · ${duracaoHumana(duracao)}` : ''}`
        : 'Status: em andamento',
    ].filter(Boolean);

    await emitir({
      origem: 'ura',
      severidade: 'info',
      titulo: `Chamada ${chamada.cliente_nome ?? mascararNumero(chamada.numero)}`,
      texto: linhas.join('\n'),
      chave: `ura:${e.callId}`,
      dados: { ...chamada, ferramentas },
      evento: true,
    });
  }

  logger.debug('URA: evento recebido', { tipo: e.tipo, callId: e.callId, intencao });
  return { ok: true };
}

export function listarChamadas(limite = 50): Array<LinhaChamada & { ferramentasLista: string[] }> {
  return (db().prepare(`SELECT * FROM chamada_ura ORDER BY iniciada_em DESC LIMIT ?`)
    .all(Math.min(500, limite)) as LinhaChamada[])
    .map((c) => {
      let f: string[] = [];
      try { f = JSON.parse(c.ferramentas ?? '[]'); } catch { f = []; }
      return { ...c, ferramentasLista: f };
    });
}
