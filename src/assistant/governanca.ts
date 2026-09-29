// Governança: o que o sistema guarda, por quanto tempo, e como ele avisa que
// está doente.
//
// Três coisas que ninguém pede até precisar:
//   1. RETENÇÃO — dado de cliente não pode ficar para sempre "porque sim".
//      Cada tipo tem prazo próprio: pergunta e evidência guardam dado pessoal
//      e vivem pouco; auditoria vive muito, porque é ela que responde "quem
//      fez".
//   2. SAÚDE — inclusive o silêncio. Monitor ligado que não produz nada há
//      horas costuma ser monitor quebrado, não rede impecável. Só o silêncio
//      não denuncia a si mesmo.
//   3. BACKUP — cópia que ninguém testou não é backup. Aqui a cópia é aberta
//      e conferida logo depois de feita.

import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { db } from './store/db';
import { logger } from '../logger';
import { obter } from './config-dinamica';
import { eventosRecentes, paineisConectados } from './eventos';
import { estadoMonitores } from './monitors/base';

// ─── Retenção ────────────────────────────────────────────────────────────────

export interface RegraRetencao {
  tipo: string;
  rotulo: string;
  porque: string;
  dias: number;
  linhas: number;
  mais_antigo: string | null;
}

interface Alvo {
  tipo: string;
  rotulo: string;
  porque: string;
  chave: 'retencao.consultas_dias' | 'retencao.evidencias_dias' | 'retencao.alertas_dias'
  | 'retencao.incidentes_dias' | 'retencao.chamadas_dias' | 'retencao.auditoria_dias'
  | 'retencao.conversas_dias';
  tabela: string;
  campo: string;
}

const ALVOS: Alvo[] = [
  {
    tipo: 'consulta', rotulo: 'Perguntas respondidas', chave: 'retencao.consultas_dias',
    tabela: 'consulta', campo: 'at',
    porque: 'Guarda o texto da pergunta e a resposta, que podem conter nome, CPF e endereço de cliente.',
  },
  {
    tipo: 'evidencia', rotulo: 'Evidências das respostas', chave: 'retencao.evidencias_dias',
    tabela: 'evidencia', campo: 'consultado_em',
    porque: 'É o dado bruto das fontes, o que mais concentra informação pessoal.',
  },
  {
    tipo: 'conversa', rotulo: 'Conversas do chat e do WhatsApp', chave: 'retencao.conversas_dias',
    tabela: 'mensagem', campo: 'at',
    porque: 'Histórico de diálogo, com o que o técnico e o cliente escreveram.',
  },
  {
    tipo: 'alerta', rotulo: 'Alertas', chave: 'retencao.alertas_dias',
    tabela: 'alerta', campo: 'criado_em',
    porque: 'Fato operacional. Serve para métrica; depois de um tempo, só o incidente importa.',
  },
  {
    tipo: 'incidente', rotulo: 'Incidentes encerrados', chave: 'retencao.incidentes_dias',
    tabela: 'incidente', campo: 'aberto_em',
    porque: 'Base da recorrência e das métricas. Vive mais que o alerta, de propósito.',
  },
  {
    tipo: 'chamada', rotulo: 'Chamadas da URA', chave: 'retencao.chamadas_dias',
    tabela: 'chamada_ura', campo: 'iniciada_em',
    porque: 'Tem telefone de quem ligou: é dado pessoal, mesmo sem nome.',
  },
  {
    tipo: 'auditoria', rotulo: 'Auditoria de alterações', chave: 'retencao.auditoria_dias',
    tabela: 'auditoria', campo: 'at',
    porque: 'Responde "quem mudou o quê". É a última coisa que se apaga.',
  },
];

function contar(a: Alvo): { linhas: number; mais_antigo: string | null } {
  try {
    const r = db().prepare(`SELECT COUNT(*) n, MIN(${a.campo}) antigo FROM ${a.tabela}`).get() as { n: number; antigo: string | null };
    return { linhas: r.n, mais_antigo: r.antigo };
  } catch {
    return { linhas: 0, mais_antigo: null };
  }
}

export function politicaRetencao(): RegraRetencao[] {
  return ALVOS.map((a) => ({
    tipo: a.tipo, rotulo: a.rotulo, porque: a.porque,
    dias: obter<number>(a.chave), ...contar(a),
  }));
}

export interface ResultadoLimpeza { tipo: string; apagados: number; dias: number }

/**
 * Apaga o que passou do prazo. Incidente encerrado leva junto a linha do
 * tempo e a ligação com os alertas; incidente aberto nunca é apagado, por
 * mais velho que seja.
 */
export function limparAntigos(agora = new Date()): ResultadoLimpeza[] {
  if (!obter<boolean>('retencao.ativa')) return [];
  const saida: ResultadoLimpeza[] = [];
  for (const a of ALVOS) {
    const dias = obter<number>(a.chave);
    if (!dias) continue;   // 0 = guardar para sempre
    const limite = new Date(agora.getTime() - dias * 86_400_000).toISOString();
    let apagados = 0;
    try {
      if (a.tipo === 'incidente') {
        const antigos = db().prepare(
          `SELECT id FROM incidente WHERE aberto_em < ? AND encerrado_em IS NOT NULL`,
        ).all(limite) as Array<{ id: string }>;
        const apagar = db().transaction((ids: string[]) => {
          for (const id of ids) {
            db().prepare(`DELETE FROM incidente_evento WHERE incidente_id = ?`).run(id);
            db().prepare(`DELETE FROM incidente_alerta WHERE incidente_id = ?`).run(id);
            db().prepare(`DELETE FROM pos_incidente WHERE incidente_id = ?`).run(id);
            db().prepare(`DELETE FROM incidente WHERE id = ?`).run(id);
          }
        });
        apagar(antigos.map((x) => x.id));
        apagados = antigos.length;
      } else if (a.tipo === 'alerta') {
        // Alerta ligado a incidente vivo fica: ele é a prova do que aconteceu.
        apagados = db().prepare(
          `DELETE FROM alerta WHERE criado_em < ?
             AND id NOT IN (SELECT alerta_id FROM incidente_alerta)`,
        ).run(limite).changes;
        db().prepare(`DELETE FROM alerta_envio WHERE alerta_id NOT IN (SELECT id FROM alerta)`).run();
      } else {
        apagados = db().prepare(`DELETE FROM ${a.tabela} WHERE ${a.campo} < ?`).run(limite).changes;
      }
    } catch (err) {
      logger.error(`Retenção: falha ao limpar ${a.tabela}`, { err: err instanceof Error ? err.message : String(err) });
      continue;
    }
    if (apagados) {
      logger.info(`Retenção: ${apagados} linha(s) de ${a.rotulo.toLowerCase()} apagadas (prazo de ${dias} dias)`);
      saida.push({ tipo: a.tipo, apagados, dias });
    }
  }
  return saida;
}

// ─── Saúde da plataforma ─────────────────────────────────────────────────────

export interface Sinal {
  nome: string;
  ok: boolean;
  detalhe: string;
  /** true = não é falha, é algo para olhar. */
  atencao?: boolean;
}

export interface Saude {
  em: string;
  ok: boolean;
  sinais: Sinal[];
  banco: { arquivo: string; mb: number; backups: number; ultimo_backup: string | null };
  silencio: { minutos_sem_evento: number | null; limite_min: number; anormal: boolean };
}

function tamanhoMb(arquivo: string): number {
  try { return Math.round((fs.statSync(arquivo).size / 1_048_576) * 10) / 10; } catch { return 0; }
}

export function pastaBackup(): string {
  return path.join(process.cwd(), 'data', 'backup');
}

export function listarBackups(): Array<{ arquivo: string; em: string; mb: number }> {
  try {
    return fs.readdirSync(pastaBackup())
      .filter((f) => f.endsWith('.db'))
      .map((f) => {
        const caminho = path.join(pastaBackup(), f);
        return { arquivo: f, em: fs.statSync(caminho).mtime.toISOString(), mb: tamanhoMb(caminho) };
      })
      .sort((a, b) => (a.em < b.em ? 1 : -1));
  } catch {
    return [];
  }
}

/**
 * Silêncio anormal: com monitor ligado, nenhuma consulta, alerta ou chamada
 * por muito tempo é sinal de coleta parada, não de rede perfeita.
 */
export function silencio(agora = new Date()): { minutos_sem_evento: number | null; limite_min: number; anormal: boolean } {
  const limite = obter<number>('saude.silencio_min');
  const ultimos = eventosRecentes(200).filter((e) => e.tipo !== 'monitor' && e.tipo !== 'sistema');
  const ultimo = ultimos.at(-1);
  const minutos = ultimo ? Math.round((agora.getTime() - new Date(ultimo.at).getTime()) / 60_000) : null;
  const monitorAtivo = estadoMonitores().some((m) => m.ativo);
  return {
    minutos_sem_evento: minutos,
    limite_min: limite,
    anormal: !!limite && monitorAtivo && minutos !== null && minutos >= limite,
  };
}

export function saude(agora = new Date()): Saude {
  const sinais: Sinal[] = [];
  const arquivo = path.join(process.cwd(), 'data', 'assistant.db');

  try {
    const r = db().prepare(`PRAGMA quick_check`).get() as Record<string, string>;
    const valor = Object.values(r)[0];
    sinais.push({ nome: 'Banco de dados', ok: valor === 'ok', detalhe: valor === 'ok' ? 'íntegro' : String(valor) });
  } catch (err) {
    sinais.push({ nome: 'Banco de dados', ok: false, detalhe: err instanceof Error ? err.message : String(err) });
  }

  for (const m of estadoMonitores()) {
    if (!m.ativo) continue;
    // Falha registrada depois do último ciclo bom = está falhando agora.
    const falhando = !!m.ultimoErro && (!m.ultimaExecucao || (m.ultimoErroEm ?? '') >= m.ultimaExecucao);
    sinais.push({
      nome: `Monitor ${m.nome}`,
      ok: !falhando,
      atencao: !falhando && !!m.ultimoErro,
      detalhe: falhando ? `falhou: ${m.ultimoErro}`
        : m.ultimaExecucao ? `último ciclo ${m.ultimaExecucao} (${m.falhas} falha(s) no total)`
          : 'ainda não rodou',
    });
  }

  const s = silencio(agora);
  if (s.limite_min) {
    sinais.push({
      nome: 'Movimento',
      ok: !s.anormal,
      atencao: s.anormal,
      detalhe: s.minutos_sem_evento === null ? 'nada registrado desde o último restart'
        : `${s.minutos_sem_evento} min sem nenhum evento (limite: ${s.limite_min} min)`,
    });
  }

  const backups = listarBackups();
  const ultimoBackup = backups[0]?.em ?? null;
  const diasBackup = ultimoBackup ? (agora.getTime() - new Date(ultimoBackup).getTime()) / 86_400_000 : null;
  sinais.push({
    nome: 'Backup',
    ok: diasBackup !== null && diasBackup <= 2,
    atencao: diasBackup !== null && diasBackup > 2,
    detalhe: ultimoBackup ? `último há ${Math.round((diasBackup ?? 0) * 10) / 10} dia(s)` : 'nenhum backup feito ainda',
  });

  sinais.push({
    nome: 'Painel ao vivo', ok: true, detalhe: `${paineisConectados()} painel(is) conectado(s)`,
  });

  return {
    em: agora.toISOString(),
    ok: sinais.every((x) => x.ok || x.atencao),
    sinais,
    banco: {
      arquivo, mb: tamanhoMb(arquivo), backups: backups.length, ultimo_backup: ultimoBackup,
    },
    silencio: s,
  };
}

// ─── Backup ──────────────────────────────────────────────────────────────────

export interface ResultadoBackup {
  arquivo: string;
  mb: number;
  em: string;
  /** Conferido: a cópia foi aberta, checada e contada. */
  verificado: boolean;
  integridade: string;
  tabelas: number;
  incidentes: number;
  apagados: number;
  erro?: string;
}

/**
 * Faz a cópia e CONFERE: abre o arquivo gerado, roda integrity_check e conta
 * o que tem dentro. Cópia que ninguém abriu não é backup, é esperança.
 */
export async function fazerBackup(agora = new Date()): Promise<ResultadoBackup> {
  const pasta = pastaBackup();
  fs.mkdirSync(pasta, { recursive: true });
  const carimbo = agora.toISOString().replace(/[:.]/g, '-').slice(0, 16);
  const arquivo = path.join(pasta, `assistant-${carimbo}.db`);

  await db().backup(arquivo);

  const r: ResultadoBackup = {
    arquivo, mb: tamanhoMb(arquivo), em: agora.toISOString(),
    verificado: false, integridade: 'não conferido', tabelas: 0, incidentes: 0, apagados: 0,
  };

  try {
    const copia = new Database(arquivo, { readonly: true });
    const check = Object.values(copia.prepare(`PRAGMA integrity_check`).get() as Record<string, string>)[0];
    r.integridade = String(check);
    r.tabelas = (copia.prepare(`SELECT COUNT(*) n FROM sqlite_master WHERE type = 'table'`).get() as { n: number }).n;
    try {
      r.incidentes = (copia.prepare(`SELECT COUNT(*) n FROM incidente`).get() as { n: number }).n;
    } catch { r.incidentes = 0; }
    copia.close();
    r.verificado = r.integridade === 'ok' && r.tabelas > 0;
  } catch (err) {
    r.erro = err instanceof Error ? err.message : String(err);
  }

  if (!r.verificado) {
    logger.error('Backup gerado mas NÃO conferido', { arquivo, erro: r.erro ?? r.integridade });
  } else {
    logger.info('Backup conferido', { arquivo, mb: r.mb, tabelas: r.tabelas });
  }

  r.apagados = limparBackupsAntigos();
  return r;
}

/** Mantém só as últimas cópias. Disco cheio já derrubou coleta aqui antes. */
export function limparBackupsAntigos(): number {
  const manter = obter<number>('backup.copias');
  const lista = listarBackups();
  let apagados = 0;
  for (const b of lista.slice(manter)) {
    try { fs.unlinkSync(path.join(pastaBackup(), b.arquivo)); apagados++; } catch { /* segue */ }
  }
  return apagados;
}

/** Confere uma cópia já existente, sem restaurar nada. */
export function conferirBackup(nomeArquivo: string): { ok: boolean; integridade: string; tabelas: number; incidentes: number } {
  const caminho = path.join(pastaBackup(), path.basename(nomeArquivo));
  if (!fs.existsSync(caminho)) throw new Error('cópia não encontrada');
  const copia = new Database(caminho, { readonly: true });
  try {
    const integridade = String(Object.values(copia.prepare(`PRAGMA integrity_check`).get() as Record<string, string>)[0]);
    const tabelas = (copia.prepare(`SELECT COUNT(*) n FROM sqlite_master WHERE type = 'table'`).get() as { n: number }).n;
    let incidentes = 0;
    try { incidentes = (copia.prepare(`SELECT COUNT(*) n FROM incidente`).get() as { n: number }).n; } catch { incidentes = 0; }
    return { ok: integridade === 'ok' && tabelas > 0, integridade, tabelas, incidentes };
  } finally {
    copia.close();
  }
}

/**
 * Quem acessa o quê. Sai daqui para o painel e para o documento de LGPD, em
 * vez de existir só num PDF que ninguém atualiza.
 */
export function regrasDeAcesso(): Array<{ quem: string; pode: string; nao_pode: string }> {
  return [
    {
      quem: 'Administrador do painel',
      pode: 'Tudo: configuração, usuários, regras, prompts, auditoria e todas as fontes.',
      nao_pode: 'Ler senha de ninguém (só trocar) nem ver a chave de bot depois de criada.',
    },
    {
      quem: 'Operador do painel',
      pode: 'Perguntar, assumir incidente, mudar estado, comentar e ver alertas e chamadas.',
      nao_pode: 'Mexer em configuração, usuários, regras, bots e webhooks.',
    },
    {
      quem: 'Leitura',
      pode: 'Ver painel, incidentes, alertas e histórico.',
      nao_pode: 'Perguntar à IA, assumir incidente ou alterar qualquer coisa.',
    },
    {
      quem: 'Técnico cadastrado no WhatsApp',
      pode: 'Perguntar pelas fontes liberadas para ele e para a equipe dele, e assumir incidente.',
      nao_pode: 'Passar do teto de fontes da equipe, mesmo que peça de outro jeito.',
    },
    {
      quem: 'Número não cadastrado (modo "rede")',
      pode: 'Perguntar sobre a rede: incidentes, links e tráfego.',
      nao_pode: 'Chegar a SGP, URA e atendimento. Esse limite é do código, não da configuração.',
    },
    {
      quem: 'Bot de sistema',
      pode: 'Publicar evento com a chave dele.',
      nao_pode: 'Ler qualquer coisa, consultar fonte ou usar o painel.',
    },
  ];
}
