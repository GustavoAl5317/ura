// Central de alertas proativos (Bloco 4).
//
// Três garantias:
//   1. o mesmo fato não gera dois alertas (chave de deduplicação única no banco,
//      que sobrevive a restart — reiniciar o processo não reenvia tudo);
//   2. alerta que não pôde ser enviado continua registrado e visível no painel,
//      com o motivo (sem destino, silêncio, falha no WhatsApp);
//   3. crítico fura o horário de silêncio. Aviso e informativo, não.

import { randomUUID } from 'crypto';
import { logger } from '../logger';
import { db } from './store/db';
import { obter, dentroDaJanela } from './config-dinamica';
import { publicar } from './eventos';
import { evoTecnicos } from './channels/whatsapp-tecnicos';

export type Origem = 'zabbix' | 'ura' | 'sla' | 'sistema';
export type Severidade = 'info' | 'aviso' | 'critico';

export interface Alerta {
  id: string;
  origem: Origem;
  severidade: Severidade;
  titulo: string;
  texto: string;
  dados: unknown;
  chave: string;
  criado_em: string;
  enviado_em: string | null;
  envio_erro: string | null;
  reconhecido_em: string | null;
  reconhecido_por: string | null;
  resolvido_em: string | null;
}

interface Linha extends Omit<Alerta, 'dados'> { dados: string | null }

function paraAlerta(l: Linha): Alerta {
  let dados: unknown = null;
  try { dados = l.dados ? JSON.parse(l.dados) : null; } catch { dados = l.dados; }
  return { ...l, dados };
}

export function jaExiste(chave: string): boolean {
  return !!db().prepare(`SELECT 1 FROM alerta WHERE chave = ?`).get(chave);
}

export function porChave(chave: string): Alerta | null {
  const l = db().prepare(`SELECT * FROM alerta WHERE chave = ?`).get(chave) as Linha | undefined;
  return l ? paraAlerta(l) : null;
}

/**
 * Registra e despacha. Devolve null quando a chave já existe — o chamador não
 * precisa checar antes, e duas execuções concorrentes do monitor não duplicam.
 */
export async function emitir(p: {
  origem: Origem;
  severidade: Severidade;
  titulo: string;
  texto: string;
  chave: string;
  dados?: unknown;
  /** Grava sem enviar. Usado para semear problemas antigos no primeiro boot. */
  silencioso?: boolean;
  /**
   * É um acontecimento (chamada recebida, incidente resolvido), não um problema
   * em aberto: nasce resolvido. Sem isto, cada chamada da URA ficaria para sempre
   * em "alertas sem resolução", afogando os problemas de verdade.
   */
  evento?: boolean;
}): Promise<Alerta | null> {
  const alerta: Alerta = {
    id: randomUUID(),
    origem: p.origem,
    severidade: p.severidade,
    titulo: p.titulo,
    texto: p.texto,
    dados: p.dados ?? null,
    chave: p.chave,
    criado_em: new Date().toISOString(),
    enviado_em: null,
    envio_erro: null,
    reconhecido_em: null,
    reconhecido_por: null,
    resolvido_em: null,
  };
  if (p.evento) alerta.resolvido_em = alerta.criado_em;

  const r = db().prepare(
    `INSERT OR IGNORE INTO alerta (id, origem, severidade, titulo, texto, dados, chave, criado_em, envio_erro, resolvido_em)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    alerta.id, alerta.origem, alerta.severidade, alerta.titulo, alerta.texto,
    alerta.dados === null ? null : JSON.stringify(alerta.dados), alerta.chave, alerta.criado_em,
    p.silencioso ? 'semeado sem envio (já existia quando o monitor iniciou)' : null,
    alerta.resolvido_em,
  );
  if (!r.changes) return null;   // chave repetida: fato já alertado

  if (p.silencioso) {
    alerta.envio_erro = 'semeado sem envio (já existia quando o monitor iniciou)';
    return alerta;
  }

  publicar('alerta', alerta);
  await despachar(alerta);
  return alerta;
}

async function despachar(a: Alerta): Promise<void> {
  const destino = obter<string>('alertas.destino_grupo');
  const motivoNaoEnvio = (m: string) => {
    db().prepare(`UPDATE alerta SET envio_erro = ? WHERE id = ?`).run(m, a.id);
    a.envio_erro = m;
  };

  if (!destino) return motivoNaoEnvio('sem grupo de destino configurado (alertas.destino_grupo)');

  const inicio = obter<string>('alertas.silencio_inicio');
  const fim = obter<string>('alertas.silencio_fim');
  if (a.severidade !== 'critico' && dentroDaJanela(inicio, fim)) {
    return motivoNaoEnvio(`horário de silêncio (${inicio}–${fim}); só crítico é enviado`);
  }

  if (!evoTecnicos.disponivel) {
    return motivoNaoEnvio('instância Evolution dos técnicos não configurada');
  }

  const ok = await evoTecnicos.enviarTexto(destino, a.texto);
  if (!ok) return motivoNaoEnvio('falha ao enviar pelo WhatsApp (ver log do Evolution)');

  const agora = new Date().toISOString();
  db().prepare(`UPDATE alerta SET enviado_em = ?, envio_erro = NULL WHERE id = ?`).run(agora, a.id);
  a.enviado_em = agora;
  logger.info(`Alerta enviado: ${a.titulo}`);
}

export function marcarResolvido(chave: string): Alerta | null {
  const agora = new Date().toISOString();
  const r = db().prepare(
    `UPDATE alerta SET resolvido_em = ? WHERE chave = ? AND resolvido_em IS NULL`,
  ).run(agora, chave);
  if (!r.changes) return null;
  const a = porChave(chave);
  if (a) publicar('alerta', a);
  return a;
}

export function reconhecer(id: string, usuario: string): boolean {
  const r = db().prepare(
    `UPDATE alerta SET reconhecido_em = ?, reconhecido_por = ? WHERE id = ? AND reconhecido_em IS NULL`,
  ).run(new Date().toISOString(), usuario, id);
  return r.changes > 0;
}

export function listar(opts: { limite?: number; origem?: string; abertos?: boolean } = {}): Alerta[] {
  const cond: string[] = [];
  const params: unknown[] = [];
  if (opts.origem) { cond.push('origem = ?'); params.push(opts.origem); }
  if (opts.abertos) cond.push('resolvido_em IS NULL');
  const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
  const linhas = db().prepare(
    `SELECT * FROM alerta ${where} ORDER BY criado_em DESC LIMIT ?`,
  ).all(...params, Math.min(500, opts.limite ?? 100)) as Linha[];
  return linhas.map(paraAlerta);
}

/** Alertas de uma origem ainda não resolvidos — o monitor usa para detectar resolução. */
export function abertosDaOrigem(origem: Origem): Alerta[] {
  return (db().prepare(
    `SELECT * FROM alerta WHERE origem = ? AND resolvido_em IS NULL`,
  ).all(origem) as Linha[]).map(paraAlerta);
}

export function horaCurta(iso: string | Date): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Fortaleza' });
}

export function duracaoHumana(seg: number): string {
  if (seg < 60) return `${seg}s`;
  const min = Math.round(seg / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h}h${String(min % 60).padStart(2, '0')}`;
  // Incidente esquecido aberto há meses virava "9373h44" — ninguém lê isso de relance.
  const dias = Math.floor(h / 24);
  return h % 24 ? `${dias} dias e ${h % 24}h` : `${dias} dias`;
}
