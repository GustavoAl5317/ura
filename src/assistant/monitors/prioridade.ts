// Aviso de prioridade: a gestão não precisa perguntar onde mandar equipe.
//
// A cada ciclo, a lista Bairro > Rua > Cliente é recalculada. Quando um bairro
// ENTRA na lista (passa a ter cliente em caixa crítica ou em degradação),
// PIORA (de degradação para crítico) ou cresce bastante em clientes, sai uma
// mensagem para quem recebe o resumo, com ruas, clientes e o valor mensal em
// risco. Quando sai da lista, avisa que normalizou.
//
// Duas leituras seguidas confirmam a mudança: sinal de caixa oscila, e um
// aviso que vai e volta em dez minutos ensina a equipe a ignorar o aviso.

import { db } from '../store/db';
import { obter } from '../config-dinamica';
import { emitir } from '../alertas';
import { config } from '../../config';
import { questdb } from '../../integrations/questdb';
import { lerPrioridades, reais, BairroEmRisco } from '../prioridade';
import { iniciarMonitor } from './base';

interface Estado {
  chave: string;
  bairro: string;
  nivel: string;
  clientes: number;
  vistos: number;
  ausente: number;
  avisado_nivel: string | null;
  avisado_clientes: number | null;
}

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const PESO: Record<string, number> = { critico: 3, degradacao: 2 };

function tabela(): void {
  db().exec(`
    CREATE TABLE IF NOT EXISTS prioridade_estado (
      chave            TEXT PRIMARY KEY,
      bairro           TEXT NOT NULL,
      nivel            TEXT NOT NULL,
      clientes         INTEGER NOT NULL,
      vistos           INTEGER NOT NULL DEFAULT 1,
      ausente          INTEGER NOT NULL DEFAULT 0,
      avisado_nivel    TEXT,
      avisado_clientes INTEGER,
      atualizado_em    TEXT NOT NULL
    );
  `);
}

/** Texto do aviso: bairro, situação, dinheiro, ruas. */
export function textoPrioridade(b: BairroEmRisco, total: number, motivoAviso: string): string {
  const icone = b.nivel === 'critico' ? '🔴' : '🟠';
  return [
    `${icone} *Mandar equipe: ${b.bairro}*`,
    `${motivoAviso} · prioridade ${b.prioridade} de ${total}`,
    `Situação: ${b.rotulo.toLowerCase()}${b.motivo ? ` (${b.motivo})` : ''}`,
    `💰 Em risco: ${b.clientes} ${b.clientes === 1 ? 'cliente' : 'clientes'}, ${reais(b.valor_mensal)}/mês em mensalidades` +
      (b.sem_valor ? ` (${b.sem_valor} sem preço no SGP)` : ''),
    '',
    '*Ruas:*',
    ...b.ruas.slice(0, 6).map((r) => `• ${r.rua}: ${r.clientes} ${r.clientes === 1 ? 'cliente' : 'clientes'}, ` +
      `${reais(r.valor_mensal)}/mês (${r.caixas.join(', ')})`),
    b.ruas.length > 6 ? `… e mais ${b.ruas.length - 6} ruas` : null,
  ].filter((x) => x !== null).join('\n');
}

/**
 * Um ciclo. Separado do monitor para ser testável: recebe a lista já
 * calculada e devolve quantos avisos saíram.
 */
export async function cicloPrioridade(p?: Awaited<ReturnType<typeof lerPrioridades>>): Promise<{ alertas: number; detalhe: Record<string, unknown> }> {
  tabela();
  const lista = p ?? await lerPrioridades();
  const confirmacoes = Math.max(1, obter<number>('prioridade.confirmacoes'));
  const aumento = Math.max(1, obter<number>('prioridade.aumento_clientes'));
  const agora = new Date().toISOString();
  const anteriores = new Map((db().prepare(`SELECT * FROM prioridade_estado`).all() as Estado[]).map((e) => [e.chave, e]));
  // Primeira vez: grava o que já existe sem avisar. O resumo das 2 horas já
  // mostra a situação de agora; o aviso é para o que MUDA.
  const semear = anteriores.size === 0 && !db().prepare(`SELECT 1 FROM auditoria WHERE acao = 'prioridade.semeado'`).get();
  let alertas = 0;
  const vistosAgora = new Set<string>();

  for (const b of lista.bairros) {
    const chave = norm(b.bairro) || 'SEMBAIRRO';
    vistosAgora.add(chave);
    const e = anteriores.get(chave);
    const vistos = (e?.vistos ?? 0) + 1;
    let avisadoNivel = e?.avisado_nivel ?? null;
    let avisadoClientes = e?.avisado_clientes ?? null;

    let motivo: string | null = null;
    if (semear) {
      avisadoNivel = b.nivel;
      avisadoClientes = b.clientes;
    } else if (vistos >= confirmacoes) {
      if (!avisadoNivel) motivo = 'Novo bairro com problema';
      else if ((PESO[b.nivel] ?? 0) > (PESO[avisadoNivel] ?? 0)) motivo = 'Piorou';
      else if (avisadoClientes !== null && b.clientes >= avisadoClientes + aumento) motivo = `Mais clientes afetados (antes ${avisadoClientes})`;
    }

    if (motivo) {
      const a = await emitir({
        origem: 'sistema',
        severidade: b.nivel === 'critico' ? 'critico' : 'aviso',
        evento: true,
        titulo: `Mandar equipe: ${b.bairro}`,
        texto: textoPrioridade(b, lista.bairros.length, motivo),
        chave: `prioridade:${chave}:${Date.now()}`,
        dados: { bairro: b.bairro, nivel: b.nivel, clientes: b.clientes, valor_mensal: b.valor_mensal, prioridade: b.prioridade },
      });
      if (a) alertas++;
      avisadoNivel = b.nivel;
      avisadoClientes = b.clientes;
    }

    db().prepare(
      `INSERT INTO prioridade_estado (chave, bairro, nivel, clientes, vistos, ausente, avisado_nivel, avisado_clientes, atualizado_em)
       VALUES (?,?,?,?,?,0,?,?,?)
       ON CONFLICT(chave) DO UPDATE SET bairro = excluded.bairro, nivel = excluded.nivel, clientes = excluded.clientes,
         vistos = excluded.vistos, ausente = 0, avisado_nivel = excluded.avisado_nivel,
         avisado_clientes = excluded.avisado_clientes, atualizado_em = excluded.atualizado_em`,
    ).run(chave, b.bairro, b.nivel, b.clientes, vistos, avisadoNivel, avisadoClientes, agora);
  }

  // Saiu da lista: confirma a ausência e avisa que normalizou (se tinha avisado).
  for (const e of anteriores.values()) {
    if (vistosAgora.has(e.chave)) continue;
    const ausente = e.ausente + 1;
    if (ausente < confirmacoes) {
      db().prepare(`UPDATE prioridade_estado SET ausente = ?, atualizado_em = ? WHERE chave = ?`).run(ausente, agora, e.chave);
      continue;
    }
    if (e.avisado_nivel && !semear) {
      const a = await emitir({
        origem: 'sistema',
        severidade: 'info',
        evento: true,
        titulo: `Normalizou: ${e.bairro}`,
        texto: `✅ *${e.bairro} normalizou*\nNenhum cliente do bairro está mais em caixa crítica ou piorando.`,
        chave: `prioridade:${e.chave}:${Date.now()}:resolvido`,
        dados: { bairro: e.bairro },
      });
      if (a) alertas++;
    }
    db().prepare(`DELETE FROM prioridade_estado WHERE chave = ?`).run(e.chave);
  }

  if (semear) {
    db().prepare(`INSERT INTO auditoria (at, ator, acao, alvo) VALUES (?,?,?,?)`).run(agora, 'sistema', 'prioridade.semeado', `${lista.bairros.length} bairros`);
  }
  return {
    alertas,
    detalhe: {
      bairros_em_risco: lista.bairros.length,
      clientes_em_risco: lista.total.clientes,
      valor_mensal_em_risco: reais(lista.total.valor_mensal),
      semeado: semear || undefined,
    },
  };
}

export function iniciarMonitorPrioridade(): () => void {
  return iniciarMonitor({
    nome: 'prioridade',
    descricao: 'Avisa sozinho quando um bairro passa a precisar de equipe, com ruas, clientes e valor em risco',
    ativo: () => config.questdb.enabled && obter<boolean>('prioridade.avisar'),
    intervaloSeg: () => obter<number>('prioridade.intervalo_min') * 60,
    async ciclo() {
      const f = await questdb.frescor();
      // Com a coleta parada, "nenhum bairro em risco" seria mentira: não mexe no estado.
      if (!f.viva) return { alertas: 0, detalhe: { pulado: 'coleta das caixas parada' } };
      return cicloPrioridade();
    },
  });
}
