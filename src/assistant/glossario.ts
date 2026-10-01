// Vocabulário da casa: como as pessoas falam, e o que isso significa aqui.
//
// O assistente foi escrito por quem sabe o que é CTO, PON e ONU. Quem pergunta,
// muitas vezes, não sabe — e não deveria precisar saber. "A caixinha da esquina
// tá apagada", "o pessoal do 731 tá sem net" e "o aparelho tá piscando
// vermelho" são perguntas perfeitamente claras para um colega, e viravam
// "INCONCLUSIVO" para o modelo.
//
// A tradução mora em banco, não no prompt, por dois motivos:
//   1. cada região tem o seu jeito de falar, e isso muda sem deploy;
//   2. só os termos que aparecem na pergunta entram no prompt, então o
//      vocabulário pode crescer sem encarecer toda consulta.

import { randomUUID } from 'crypto';
import { db, registrarAuditoria } from './store/db';
import { obter } from './config-dinamica';

export interface Termo {
  id: string;
  termo: string;
  /** Outras formas de dizer a mesma coisa, separadas por vírgula. */
  sinonimos: string[];
  significado: string;
  /** O que fazer com isso: qual ferramenta ou dado resolve. */
  dica: string | null;
  ativo: boolean;
  usos: number;
  criado_em: string;
}

interface Linha extends Omit<Termo, 'sinonimos' | 'ativo'> { sinonimos: string | null; ativo: number }

function paraTermo(l: Linha): Termo {
  return {
    ...l,
    sinonimos: (l.sinonimos ?? '').split(',').map((x) => x.trim()).filter(Boolean),
    ativo: l.ativo === 1,
  };
}

export function listar(): Termo[] {
  return (db().prepare(`SELECT * FROM glossario ORDER BY termo`).all() as Linha[]).map(paraTermo);
}

export function porId(id: string): Termo | null {
  const l = db().prepare(`SELECT * FROM glossario WHERE id = ?`).get(id) as Linha | undefined;
  return l ? paraTermo(l) : null;
}

function normalizar(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

export function criar(d: { termo?: string; sinonimos?: unknown; significado?: string; dica?: string; ativo?: boolean }, autor: string): Termo {
  const termo = String(d.termo ?? '').trim();
  if (termo.length < 2) throw new Error('escreva o termo (pelo menos 2 letras)');
  const significado = String(d.significado ?? '').trim();
  if (!significado) throw new Error('escreva o que esse termo significa aqui');
  const sin = Array.isArray(d.sinonimos)
    ? d.sinonimos.map(String).map((x) => x.trim()).filter(Boolean)
    : String(d.sinonimos ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  if (listar().some((t) => normalizar(t.termo) === normalizar(termo))) {
    throw new Error(`"${termo}" já está no vocabulário`);
  }

  const t: Termo = {
    id: randomUUID(), termo, sinonimos: sin, significado,
    dica: String(d.dica ?? '').trim() || null, ativo: d.ativo !== false,
    usos: 0, criado_em: new Date().toISOString(),
  };
  db().prepare(
    `INSERT INTO glossario (id, termo, sinonimos, significado, dica, ativo, usos, criado_em)
     VALUES (?,?,?,?,?,?,0,?)`,
  ).run(t.id, t.termo, t.sinonimos.join(', '), t.significado, t.dica, t.ativo ? 1 : 0, t.criado_em);
  registrarAuditoria(autor, 'glossario.criar', t.termo, undefined, t);
  return t;
}

export function atualizar(id: string, d: Record<string, unknown>, autor: string): Termo {
  const antes = porId(id);
  if (!antes) throw new Error('termo não encontrado');
  const sin = d.sinonimos === undefined ? antes.sinonimos
    : Array.isArray(d.sinonimos) ? d.sinonimos.map(String).map((x) => x.trim()).filter(Boolean)
      : String(d.sinonimos ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  const significado = d.significado !== undefined && String(d.significado).trim()
    ? String(d.significado).trim() : antes.significado;
  db().prepare(
    `UPDATE glossario SET termo = ?, sinonimos = ?, significado = ?, dica = ?, ativo = ? WHERE id = ?`,
  ).run(
    d.termo !== undefined && String(d.termo).trim() ? String(d.termo).trim() : antes.termo,
    sin.join(', '), significado,
    d.dica !== undefined ? (String(d.dica ?? '').trim() || null) : antes.dica,
    d.ativo !== undefined ? (d.ativo !== false ? 1 : 0) : (antes.ativo ? 1 : 0),
    id,
  );
  const depois = porId(id)!;
  registrarAuditoria(autor, 'glossario.editar', depois.termo, antes, depois);
  return depois;
}

export function remover(id: string, autor: string): void {
  const antes = porId(id);
  if (!antes) throw new Error('termo não encontrado');
  db().prepare(`DELETE FROM glossario WHERE id = ?`).run(id);
  registrarAuditoria(autor, 'glossario.remover', antes.termo, antes, undefined);
}

/** Palavra inteira, sem acento e sem diferenciar maiúscula. "caixinha" não casa em "caixinhas"? casa. */
function aparece(texto: string, expressao: string): boolean {
  const alvo = normalizar(expressao).trim();
  if (!alvo) return false;
  const escapado = alvo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escapado}(s|es)?([^a-z0-9]|$)`, 'i').test(normalizar(texto));
}

/** Termos do vocabulário que aparecem nesta pergunta. */
export function termosEncontrados(pergunta: string): Termo[] {
  if (!pergunta.trim()) return [];
  return listar().filter((t) => t.ativo && (aparece(pergunta, t.termo) || t.sinonimos.some((s) => aparece(pergunta, s))));
}

export function marcarUso(ids: string[]): void {
  if (!ids.length) return;
  const agora = new Date().toISOString();
  const st = db().prepare(`UPDATE glossario SET usos = usos + 1, ultimo_uso = ? WHERE id = ?`);
  for (const id of ids) st.run(agora, id);
}

/**
 * Bloco para o prompt, só com os termos que a pergunta usou. Devolve null
 * quando não há nada a traduzir — nenhuma consulta paga por vocabulário que
 * não foi usado.
 */
export function blocoParaPrompt(pergunta: string): { texto: string; ids: string[] } | null {
  if (!obter<boolean>('ia.glossario_ativo')) return null;
  const achados = termosEncontrados(pergunta);
  if (!achados.length) return null;
  const linhas = achados.map((t) => `- "${t.termo}"${t.sinonimos.length ? ` (também: ${t.sinonimos.join(', ')})` : ''}: ${t.significado}${t.dica ? ` → ${t.dica}` : ''}`);
  return {
    ids: achados.map((t) => t.id),
    texto:
      'Como se fala aqui, e o que isso quer dizer. A pessoa usou estes termos; trate-os com este ' +
      'significado e NÃO peça para ela reformular:\n' + linhas.join('\n'),
  };
}

/**
 * Vocabulário inicial. É o jeito como técnico de campo, atendente e cliente
 * falam de verdade — não a nomenclatura do manual. A casa edita no painel.
 */
interface SementeTermo { termo: string; sinonimos: string; significado: string; dica: string }

export const SEMENTE: SementeTermo[] = [
  {
    termo: 'caixinha', sinonimos: 'caixa, caixa da rua, caixa do poste, caixinha da esquina, cx',
    significado: 'A CTO: a caixa de fibra no poste onde os clientes daquela rua são ligados.',
    dica: 'Use as ferramentas de CTO (sinal, clientes ligados, analisar_cto).',
  },
  {
    termo: 'aparelho', sinonimos: 'aparelhinho, modem, roteador, conversor, caixinha de dentro',
    significado: 'O equipamento na casa do cliente (ONU/ONT). "Luz vermelha" ou "apagado" indica fibra ou sinal.',
    dica: 'Veja sinal e status da ONU pela revisão do cliente.',
  },
  {
    termo: 'sem net', sinonimos: 'sem internet, sem conexão, caiu a net, net caiu, sem sinal, tá offline, nao tem net',
    significado: 'Cliente ou região sem conexão. Pode ser queda da CTO, da PON, do POP ou só daquele cliente.',
    dica: 'Comece pelo alvo citado: se for cliente, revisão; se for rua, bairro ou caixa, analise a CTO ou a PON.',
  },
  {
    termo: 'tá lento', sinonimos: 'ta lento, lentidao, lentidão, travando, ruim, oscilando, caindo toda hora',
    significado: 'Queixa de qualidade, não de queda: pode ser sinal óptico ruim, PON cheia ou tráfego.',
    dica: 'Olhe sinal da ONU e da CTO, e tráfego do momento. Oscilação repetida é flap: veja o histórico.',
  },
  {
    termo: 'fibra arrebentou', sinonimos: 'arrebentou, rompeu, cortaram a fibra, fibra cortada, passaram por cima do cabo',
    significado: 'Suspeita de rompimento. Só é rompimento quando quase todas as ONUs do trecho estão sem luz.',
    dica: 'Analise a PON ou a CTO e use a leitura do padrão da própria ferramenta, sem concluir por conta.',
  },
  {
    termo: 'poste', sinonimos: 'poste caiu, bateu no poste, carro bateu no poste',
    significado: 'Acidente que costuma derrubar a caixa inteira daquele trecho.',
    dica: 'Verifique a CTO e as vizinhas do mesmo trecho.',
  },
  {
    termo: 'faltou luz', sinonimos: 'sem energia, acabou a luz, apagão, apagao, queda de energia, energia caiu',
    significado: 'Falta de energia na casa, na caixa ou no POP. Sem energia no POP, cai todo mundo da região.',
    dica: 'Veja alertas de energia no Zabbix e quantos clientes do trecho caíram juntos.',
  },
  {
    termo: 'o pessoal', sinonimos: 'a galera, o povo, os moradores, a rua toda, o bairro',
    significado: 'Um grupo de clientes de uma rua, bairro ou condomínio — não um cliente só.',
    dica: 'Trate como região: procure a CTO ou a PON que atende o lugar citado.',
  },
  {
    termo: 'conta', sinonimos: 'boleto, fatura, pagamento, bloqueado, cortado, suspenso',
    significado: 'Situação financeira ou bloqueio do contrato, não falha técnica.',
    dica: 'Veja a situação do contrato no SGP antes de investigar rede.',
  },
  {
    termo: 'chamado', sinonimos: 'os, o.s., ordem de serviço, visita, técnico foi lá, abriu chamado',
    significado: 'Ordem de serviço no SGP, aberta para instalação, reparo ou retirada.',
    dica: 'Procure as O.S. do cliente ou da região antes de sugerir abrir outra.',
  },
];

/** Semeia o vocabulário na primeira vez. Depois quem manda é o painel. */
export function semear(): number {
  const existe = (db().prepare(`SELECT COUNT(*) n FROM glossario`).get() as { n: number }).n;
  if (existe) return 0;
  const st = db().prepare(
    `INSERT INTO glossario (id, termo, sinonimos, significado, dica, ativo, usos, criado_em)
     VALUES (?,?,?,?,?,1,0,?)`,
  );
  const agora = new Date().toISOString();
  for (const t of SEMENTE) st.run(randomUUID(), t.termo, t.sinonimos, t.significado, t.dica, agora);
  return SEMENTE.length;
}
