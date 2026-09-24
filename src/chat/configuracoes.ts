// Configurações que a operação edita pelo painel, sem mexer em código nem no
// .env. Tudo aqui é LIDO DO BANCO COM FALLBACK no config: se a chave nunca foi
// tocada no painel, vale o valor do .env — instalação existente não muda de
// comportamento só por subir esta versão.
//
// Cada campo tem validação própria. O painel é operado por quem não programa, e
// um valor absurdo aqui (prompt vazio, tempo zero, lista de planos em branco)
// derruba o atendimento inteiro — a validação é o que impede isso.

import { db } from './db';
import { config } from '../config';
import { logger } from '../logger';

export type TipoCampo = 'texto' | 'numero' | 'lista_numeros';

export interface CampoConfig {
  chave: string;
  rotulo: string;
  ajuda: string;
  tipo: TipoCampo;
  grupo: 'tempos' | 'planos' | 'prompt';
  /** Valor em vigor quando o painel nunca gravou nada. */
  padrao: () => string;
  min?: number;
  max?: number;
  /** Validação específica; devolve mensagem de erro ou null. */
  valida?: (v: string) => string | null;
}

const naoVazio = (rotulo: string) => (v: string): string | null =>
  v.trim() ? null : `${rotulo} não pode ficar em branco.`;

export const CAMPOS: CampoConfig[] = [
  // ── Tempos de atendimento ────────────────────────────────────────────────
  {
    chave: 'inatividade_ping_min',
    rotulo: 'Perguntar se o cliente ainda está aí',
    ajuda: 'Minutos sem resposta do cliente até a IA perguntar se ele continua na conversa. 0 desliga.',
    tipo: 'numero', grupo: 'tempos', min: 0, max: 240,
    padrao: () => String(config.chat.inatividadePingMin),
  },
  {
    chave: 'inatividade_fechar_min',
    rotulo: 'Encerrar a conversa após o aviso',
    ajuda: 'Minutos depois do aviso acima até encerrar o atendimento e enviar o protocolo.',
    tipo: 'numero', grupo: 'tempos', min: 1, max: 240,
    padrao: () => String(config.chat.inatividadeFecharMin),
  },
  {
    chave: 'sessao_idle_min',
    rotulo: 'Manter a conversa na memória',
    ajuda: 'Minutos que a conversa continua ativa antes de sair da memória. '
      + 'Precisa ser MAIOR que a soma dos dois tempos acima, senão o encerramento nunca acontece.',
    tipo: 'numero', grupo: 'tempos', min: 5, max: 1440,
    padrao: () => String(config.chat.sessionIdleMin),
  },

  // ── Planos oferecidos ────────────────────────────────────────────────────
  {
    chave: 'planos_ids',
    rotulo: 'Planos oferecidos (IDs do SGP)',
    ajuda: 'IDs separados por vírgula, na ordem em que devem ser apresentados. '
      + 'O SGP devolve dezenas de planos antigos e internos; só os daqui são oferecidos ao cliente.',
    tipo: 'lista_numeros', grupo: 'planos',
    padrao: () => config.plans.ids.join(','),
    valida: (v) => {
      const ids = v.split(',').map((x) => x.trim()).filter(Boolean);
      if (!ids.length) return 'Informe pelo menos um plano, senão a IA fica sem nada para oferecer.';
      const ruim = ids.find((x) => !/^\d+$/.test(x));
      if (ruim) return `"${ruim}" não é um ID válido. Use só números, separados por vírgula.`;
      return null;
    },
  },

  // ── Prompt geral ─────────────────────────────────────────────────────────
  {
    chave: 'prompt_extra',
    rotulo: 'Instruções adicionais para a IA',
    ajuda: 'Texto acrescentado ao final das instruções da IA, valendo sobre as regras gerais. '
      + 'Use para ajustar tom, acrescentar orientação ou corrigir algo que ela esteja falando errado. '
      + 'Não apaga as regras existentes — complementa.',
    tipo: 'texto', grupo: 'prompt',
    padrao: () => '',
    valida: (v) => (v.length > 6000 ? 'Máximo de 6000 caracteres.' : null),
  },
];

const porChave = new Map(CAMPOS.map((c) => [c.chave, c]));

/** Valor em vigor: o do painel, ou o padrão herdado do .env. */
export function valor(chave: string): string {
  const campo = porChave.get(chave);
  if (!campo) return '';
  try {
    const row = db().prepare('SELECT valor FROM configuracoes WHERE chave = ?').get(chave) as
      { valor?: string } | undefined;
    if (row?.valor !== undefined) return row.valor;
  } catch (err) {
    // Sem banco (URA de voz) o atendimento segue com o valor do .env.
    logger.debug('configuracoes: leitura falhou, usando padrão', { chave, err: String(err) });
  }
  return campo.padrao();
}

export function valorNumero(chave: string): number {
  const n = Number(valor(chave));
  const campo = porChave.get(chave);
  if (!Number.isFinite(n)) return Number(campo?.padrao() ?? 0);
  return n;
}

export function idsDePlanos(): number[] {
  return valor('planos_ids').split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
}

/** Todos os campos com valor atual e se foi personalizado — para montar o painel. */
export function listarConfiguracoes(): Array<CampoConfig & { valor: string; personalizado: boolean }> {
  let salvos = new Map<string, string>();
  try {
    const rows = db().prepare('SELECT chave, valor FROM configuracoes').all() as
      Array<{ chave: string; valor: string }>;
    salvos = new Map(rows.map((r) => [r.chave, r.valor]));
  } catch { /* sem banco: tudo padrão */ }

  return CAMPOS.map((c) => ({
    ...c,
    valor: salvos.get(c.chave) ?? c.padrao(),
    personalizado: salvos.has(c.chave),
    padraoTexto: c.padrao(),
  })) as Array<CampoConfig & { valor: string; personalizado: boolean }>;
}

export function salvarConfiguracao(
  chave: string,
  bruto: string,
  por?: string,
): { ok: true } | { ok: false; erro: string } {
  const campo = porChave.get(chave);
  if (!campo) return { ok: false, erro: 'Configuração desconhecida.' };

  const v = campo.tipo === 'texto' ? bruto : bruto.trim();

  if (campo.tipo === 'numero') {
    const n = Number(v);
    if (!Number.isFinite(n)) return { ok: false, erro: `${campo.rotulo}: informe um número.` };
    if (campo.min !== undefined && n < campo.min) {
      return { ok: false, erro: `${campo.rotulo}: mínimo ${campo.min}.` };
    }
    if (campo.max !== undefined && n > campo.max) {
      return { ok: false, erro: `${campo.rotulo}: máximo ${campo.max}.` };
    }
  }

  const erro = campo.valida?.(v);
  if (erro) return { ok: false, erro };

  db().prepare(
    `INSERT INTO configuracoes (chave, valor, atualizado, por) VALUES (?, ?, ?, ?)
     ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor,
       atualizado = excluded.atualizado, por = excluded.por`,
  ).run(chave, v, Date.now(), por ?? null);

  logger.info('[config] alterada pelo painel', { chave, por });
  return { ok: true };
}

/** Volta ao valor do .env, apagando a personalização. */
export function restaurarPadrao(chave: string): { ok: boolean; erro?: string } {
  if (!porChave.has(chave)) return { ok: false, erro: 'Configuração desconhecida.' };
  db().prepare('DELETE FROM configuracoes WHERE chave = ?').run(chave);
  return { ok: true };
}

/**
 * Coerência entre os tempos: o encerramento só acontece se a conversa ainda
 * estiver na memória quando o prazo vence. Configurado ao contrário, o cliente
 * nunca recebe protocolo e a conversa some — falha silenciosa, difícil de ligar
 * à configuração que a causou. Por isso o painel avisa.
 */
export function avisoTempos(): string | null {
  const ping = valorNumero('inatividade_ping_min');
  const fechar = valorNumero('inatividade_fechar_min');
  const idle = valorNumero('sessao_idle_min');
  if (ping > 0 && idle <= ping + fechar) {
    return `A conversa sai da memória em ${idle} min, mas o encerramento só ocorreria aos `
      + `${ping + fechar} min (${ping} + ${fechar}). Assim o cliente nunca recebe o protocolo. `
      + `Aumente "Manter a conversa na memória" para mais de ${ping + fechar} minutos.`;
  }
  return null;
}
