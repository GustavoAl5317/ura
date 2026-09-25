// Promoções e campanhas cadastradas pela equipe no painel.
//
// Existem para que condição comercial e mensagem sazonal deixem de depender de
// alterar código: a taxa de instalação muda, campanha de Natal entra e sai, e
// quem sabe disso é o time comercial, não o desenvolvedor.
//
// Cada promoção é presa a uma ETAPA do atendimento e entra no prompt só quando
// aquela etapa acontece — assim a IA não fala de promoção de adesão para quem
// ligou por problema técnico.

import crypto from 'crypto';
import { db } from './db';

/** Momento do atendimento em que a promoção deve aparecer. */
export type EtapaPromocao =
  | 'saudacao'         // primeira mensagem da conversa
  | 'viabilidade'      // ao confirmar que há cobertura no endereço
  | 'planos'           // ao apresentar os planos
  | 'apos_interesse'   // depois de registrar o interesse / entrar na fila de adesão
  | 'sempre';          // qualquer momento (datas comemorativas)

export const ETAPAS: Array<{ valor: EtapaPromocao; rotulo: string }> = [
  { valor: 'saudacao', rotulo: 'Na saudação (início da conversa)' },
  { valor: 'viabilidade', rotulo: 'Ao confirmar cobertura' },
  { valor: 'planos', rotulo: 'Ao apresentar os planos' },
  { valor: 'apos_interesse', rotulo: 'Depois de registrar interesse' },
  { valor: 'sempre', rotulo: 'Sempre (data comemorativa)' },
];

export interface Promocao {
  id: string;
  nome: string;
  etapa: EtapaPromocao;
  mensagem: string;
  /** Substitui a taxa de instalação padrão enquanto a promoção vale. Ex.: "isenta", "0,00". */
  taxaInstalacao: string | null;
  inicio: number | null;
  fim: number | null;
  ativa: boolean;
  criadoEm: number;
  criadoPor: string | null;
}

function daLinha(r: Record<string, unknown>): Promocao {
  return {
    id: String(r.id),
    nome: String(r.nome),
    etapa: String(r.etapa) as EtapaPromocao,
    mensagem: String(r.mensagem),
    taxaInstalacao: r.taxa_instalacao == null ? null : String(r.taxa_instalacao),
    inicio: r.inicio == null ? null : Number(r.inicio),
    fim: r.fim == null ? null : Number(r.fim),
    ativa: Number(r.ativa) === 1,
    criadoEm: Number(r.criado_em),
    criadoPor: r.criado_por == null ? null : String(r.criado_por),
  };
}

export function listarPromocoes(): Promocao[] {
  return db().prepare('SELECT * FROM promocoes ORDER BY ativa DESC, criado_em DESC')
    .all().map(daLinha);
}

/**
 * Promoções valendo AGORA: ativas e dentro da janela de datas.
 *
 * A janela é conferida na leitura, não por um job que desliga a promoção — se o
 * serviço ficar fora do ar na virada da data, a campanha não fica valendo além
 * do prazo por acidente.
 */
export function promocoesAtivas(agora = Date.now()): Promocao[] {
  return listarPromocoes().filter((p) => {
    if (!p.ativa) return false;
    if (p.inicio != null && agora < p.inicio) return false;
    if (p.fim != null && agora > p.fim) return false;
    return true;
  });
}

/**
 * Taxa de instalação valendo agora — a de alguma promoção ativa, ou null para
 * usar a padrão do .env. Com mais de uma promoção mexendo na taxa, vale a mais
 * recente: é a que a equipe acabou de cadastrar.
 */
export function taxaInstalacaoVigente(agora = Date.now()): string | null {
  const comTaxa = promocoesAtivas(agora)
    .filter((p) => p.taxaInstalacao && p.taxaInstalacao.trim())
    .sort((a, b) => b.criadoEm - a.criadoEm);
  return comTaxa[0]?.taxaInstalacao?.trim() ?? null;
}

export function criarPromocao(dados: {
  nome: string;
  etapa: EtapaPromocao;
  mensagem: string;
  taxaInstalacao?: string | null;
  inicio?: number | null;
  fim?: number | null;
  criadoPor?: string;
}): { ok: true; promocao: Promocao } | { ok: false; erro: string } {
  const nome = dados.nome.trim();
  const mensagem = dados.mensagem.trim();
  if (!nome) return { ok: false, erro: 'Dê um nome para identificar a promoção.' };
  if (!mensagem) return { ok: false, erro: 'Escreva a mensagem que a IA deve usar.' };
  if (!ETAPAS.some((e) => e.valor === dados.etapa)) {
    return { ok: false, erro: 'Etapa inválida.' };
  }
  if (dados.inicio != null && dados.fim != null && dados.fim < dados.inicio) {
    return { ok: false, erro: 'A data final não pode ser antes da inicial.' };
  }

  const p: Promocao = {
    id: crypto.randomUUID(),
    nome,
    etapa: dados.etapa,
    mensagem,
    taxaInstalacao: dados.taxaInstalacao?.trim() || null,
    inicio: dados.inicio ?? null,
    fim: dados.fim ?? null,
    ativa: true,
    criadoEm: Date.now(),
    criadoPor: dados.criadoPor ?? null,
  };

  db().prepare(
    `INSERT INTO promocoes (id, nome, etapa, mensagem, taxa_instalacao, inicio, fim, ativa, criado_em, criado_por)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(p.id, p.nome, p.etapa, p.mensagem, p.taxaInstalacao, p.inicio, p.fim, 1, p.criadoEm, p.criadoPor);

  return { ok: true, promocao: p };
}

export function atualizarPromocao(
  id: string,
  campos: { ativa?: boolean; mensagem?: string; taxaInstalacao?: string | null; inicio?: number | null; fim?: number | null },
): { ok: boolean; erro?: string } {
  const atual = db().prepare('SELECT * FROM promocoes WHERE id = ?').get(id);
  if (!atual) return { ok: false, erro: 'Promoção não encontrada.' };

  const p = daLinha(atual);
  const mensagem = campos.mensagem?.trim() ?? p.mensagem;
  if (!mensagem) return { ok: false, erro: 'A mensagem não pode ficar vazia.' };

  const inicio = campos.inicio !== undefined ? campos.inicio : p.inicio;
  const fim = campos.fim !== undefined ? campos.fim : p.fim;
  if (inicio != null && fim != null && fim < inicio) {
    return { ok: false, erro: 'A data final não pode ser antes da inicial.' };
  }

  db().prepare(
    `UPDATE promocoes SET ativa = ?, mensagem = ?, taxa_instalacao = ?, inicio = ?, fim = ? WHERE id = ?`,
  ).run(
    (campos.ativa ?? p.ativa) ? 1 : 0,
    mensagem,
    campos.taxaInstalacao !== undefined ? (campos.taxaInstalacao?.trim() || null) : p.taxaInstalacao,
    inicio, fim, id,
  );
  return { ok: true };
}

export function removerPromocao(id: string): { ok: boolean; erro?: string } {
  const r = db().prepare('DELETE FROM promocoes WHERE id = ?').run(id);
  return r.changes ? { ok: true } : { ok: false, erro: 'Promoção não encontrada.' };
}
