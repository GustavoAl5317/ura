// Tabela de serviços cobrados. É uma LISTA editável, não um conjunto fixo de
// campos: a empresa cria serviço novo ("troca de roteador", "ponto adicional")
// sem depender de alteração no código.
//
// A instalação NÃO vive aqui: ela tem regra própria (promoção pode isentá-la,
// e a mensagem de viabilidade a cita), e duplicá-la daria dois valores
// divergentes para a mesma coisa.

import crypto from 'crypto';
import { db } from './db';
import { logger } from '../logger';
import { config } from '../config';

export interface Servico {
  id: string;
  nome: string;
  valor: string;
  /** Instrução que a IA deve seguir ao falar deste serviço. Vai para o prompt. */
  observacao: string | null;
  ordem: number;
  ativo: boolean;
}

function linha(r: Record<string, unknown>): Servico {
  return {
    id: String(r.id),
    nome: String(r.nome),
    valor: String(r.valor),
    observacao: r.observacao === null || r.observacao === undefined ? null : String(r.observacao),
    ordem: Number(r.ordem ?? 0),
    ativo: Number(r.ativo) === 1,
  };
}

/**
 * Primeira execução: cria a tabela com os serviços que a empresa já informou.
 * Sem isso o sistema subiria sem saber nenhum preço, e a IA voltaria a dizer que
 * não sabe — pior do que a versão anterior, que tinha os valores fixos.
 *
 * Só semeia quando a tabela está VAZIA: se a empresa apagar um serviço de
 * propósito, ele não pode ressuscitar no próximo restart.
 */
export function semearServicos(): void {
  try {
    const { n } = db().prepare('SELECT COUNT(*) AS n FROM servicos').get() as { n: number };
    if (n > 0) return;

    const iniciais: Array<Omit<Servico, 'id' | 'ativo'>> = [
      {
        nome: 'Mudança de endereço',
        valor: config.company.taxaMudancaEndereco,
        observacao: null,
        ordem: 1,
      },
      {
        nome: 'Visita técnica improdutiva',
        valor: config.company.taxaVisitaImprodutiva,
        observacao:
          'Avise ANTES de agendar qualquer visita, com naturalidade e nunca como ameaça: '
          + 'é cobrada quando o técnico vai até o local e o problema NÃO era da nossa rede '
          + '(equipamento do cliente, tomada desligada, fiação interna). Se o problema for '
          + 'da nossa rede, NÃO há cobrança — diga isso na mesma frase.',
        ordem: 2,
      },
      {
        nome: 'Instalação de repetidor',
        valor: `${config.company.taxaRepetidor} + cabo utilizado`,
        observacao:
          'O valor NÃO é fechado. NUNCA diga um total, nunca estime metragem, nunca diga '
          + '"fica em torno de". Explique que o técnico mede no local e informa o valor exato '
          + 'antes de instalar. Se o cliente insistir num valor fechado, transfira.',
        ordem: 3,
      },
    ];

    const stmt = db().prepare(
      'INSERT INTO servicos (id, nome, valor, observacao, ordem, ativo, criado_em) VALUES (?,?,?,?,?,1,?)',
    );
    for (const s of iniciais) {
      stmt.run(crypto.randomUUID(), s.nome, s.valor, s.observacao, s.ordem, Date.now());
    }
    logger.info('[servicos] tabela inicial criada', { total: iniciais.length });
  } catch (err) {
    logger.warn('[servicos] não consegui semear a tabela', { err: String(err) });
  }
}

export function listarServicos(): Servico[] {
  return (db().prepare('SELECT * FROM servicos ORDER BY ordem, nome').all() as Record<string, unknown>[])
    .map(linha);
}

export function servicosAtivos(): Servico[] {
  return listarServicos().filter((s) => s.ativo);
}

function validar(nome: string, valor: string, observacao: string): string | null {
  if (!nome.trim()) return 'Informe o nome do serviço.';
  if (nome.length > 80) return 'Nome muito longo (máx. 80 caracteres).';
  if (!valor.trim()) return 'Informe o valor (ex.: 50,00 ou "30,00 + cabo").';
  if (valor.length > 60) return 'Valor muito longo (máx. 60 caracteres).';
  if (observacao.length > 600) return 'Observação muito longa (máx. 600 caracteres).';
  return null;
}

export function criarServico(d: { nome: string; valor: string; observacao?: string }):
  { ok: true; servico: Servico } | { ok: false; erro: string } {
  const nome = (d.nome ?? '').trim();
  const valor = (d.valor ?? '').trim();
  const observacao = (d.observacao ?? '').trim();
  const erro = validar(nome, valor, observacao);
  if (erro) return { ok: false, erro };

  if (listarServicos().some((s) => s.nome.toLowerCase() === nome.toLowerCase())) {
    return { ok: false, erro: `Já existe um serviço chamado "${nome}".` };
  }

  const proxima = Math.max(0, ...listarServicos().map((s) => s.ordem)) + 1;
  const servico: Servico = {
    id: crypto.randomUUID(), nome, valor,
    observacao: observacao || null, ordem: proxima, ativo: true,
  };
  db().prepare(
    'INSERT INTO servicos (id, nome, valor, observacao, ordem, ativo, criado_em) VALUES (?,?,?,?,?,1,?)',
  ).run(servico.id, servico.nome, servico.valor, servico.observacao, servico.ordem, Date.now());
  logger.info('[servicos] criado', { nome, valor });
  return { ok: true, servico };
}

export function atualizarServico(
  id: string,
  campos: { nome?: string; valor?: string; observacao?: string; ativo?: boolean },
): { ok: boolean; erro?: string } {
  const atual = listarServicos().find((s) => s.id === id);
  if (!atual) return { ok: false, erro: 'Serviço não encontrado.' };

  const nome = (campos.nome ?? atual.nome).trim();
  const valor = (campos.valor ?? atual.valor).trim();
  const observacao = (campos.observacao ?? atual.observacao ?? '').trim();
  const erro = validar(nome, valor, observacao);
  if (erro) return { ok: false, erro };

  if (listarServicos().some((s) => s.id !== id && s.nome.toLowerCase() === nome.toLowerCase())) {
    return { ok: false, erro: `Já existe um serviço chamado "${nome}".` };
  }

  db().prepare('UPDATE servicos SET nome=?, valor=?, observacao=?, ativo=? WHERE id=?')
    .run(nome, valor, observacao || null, (campos.ativo ?? atual.ativo) ? 1 : 0, id);
  return { ok: true };
}

export function removerServico(id: string): { ok: boolean; erro?: string } {
  const r = db().prepare('DELETE FROM servicos WHERE id = ?').run(id);
  return r.changes > 0 ? { ok: true } : { ok: false, erro: 'Serviço não encontrado.' };
}

/**
 * Bloco para o prompt. `taxaInstalacao` entra como primeira linha por vir de
 * fora (promoção pode isentá-la).
 */
export function blocoServicosParaPrompt(taxaInstalacao: string): string {
  let ativos: Servico[] = [];
  try {
    ativos = servicosAtivos();
  } catch { /* sem banco: sai só a instalação */ }

  const linhas = [`• Instalação: ${taxaInstalacao}`];
  const instrucoes: string[] = [];
  for (const s of ativos) {
    linhas.push(`• ${s.nome}: ${s.valor}`);
    if (s.observacao) instrucoes.push(`${s.nome.toUpperCase()} — ${s.observacao}`);
  }

  const NL = String.fromCharCode(10);
  return [
    '',
    '═══ TABELA DE SERVIÇOS COBRADOS ═════════════════════════════════════',
    'Estes são os ÚNICOS valores de serviço que você pode informar. Nenhum deles é gratuito.',
    ...linhas,
    '',
    'Serviço que NÃO estiver nesta lista: você não sabe o preço. Diga que vai verificar e',
    'transfira. Chutar valor gera cobrança contestada.',
    'Valor que traga "+", "mais" ou "varia" NÃO é fechado: informe a composição e diga que o',
    'técnico confirma o total no local. Nunca some por conta própria.',
    ...(instrucoes.length ? ['', ...instrucoes] : []),
  ].join(NL) + NL;
}
