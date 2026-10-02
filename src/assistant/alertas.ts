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
import { paineisConectados, publicar } from './eventos';
import { dispararWebhooks } from './webhooks';
import { evoTecnicos } from './channels/whatsapp-tecnicos';
import { marcarReconhecido, registrarEnvio } from './destinos-alerta';
import { alertaResolvido, correlacionar } from './incidentes';
import { avisoDePlantao } from './plantao';
import { Decisao, decidir, esperaVencida, limparEspera, registrarDecisao } from './regras';
import { Alvo, alvosDoAlerta, marcarEscalada, paraEscalar } from './roteamento';
import { comExplicacao, falaDoAlerta } from './em-palavras-simples';
import { sintetizar } from './voice';

export type Origem = 'zabbix' | 'ura' | 'sla' | 'netflow' | 'ctos' | 'bot' | 'sistema';
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
  /** Motivo registrado no lugar do "semeado" quando silencioso (ex.: agrupado em outra mensagem). */
  motivoSemEnvio?: string;
  /**
   * É um acontecimento (chamada recebida, incidente resolvido), não um problema
   * em aberto: nasce resolvido. Sem isto, cada chamada da URA ficaria para sempre
   * em "alertas sem resolução", afogando os problemas de verdade.
   */
  evento?: boolean;
  /**
   * Áudio (ogg/opus) mandado logo depois do texto, para cada destino. Hoje só
   * o resumo usa: o texto completo vai, e o áudio curto conta o principal.
   */
  audio?: Buffer | null;
}): Promise<Alerta | null> {
  const alerta: Alerta = {
    id: randomUUID(),
    origem: p.origem,
    severidade: p.severidade,
    titulo: p.titulo,
    // Linha "em palavras simples" no fim: o aviso técnico fica, e quem não
    // sabe nada de rede entende o que aconteceu.
    texto: obter<boolean>('alertas.explicar_simples')
      ? comExplicacao(p.texto, { origem: p.origem, chave: p.chave, dados: p.dados })
      : p.texto,
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
  let motivoSilencio = p.motivoSemEnvio ?? 'semeado sem envio (já existia quando o monitor iniciou)';

  // Regras e janela de manutenção decidem ANTES de gravar: severidade nova,
  // só painel, espera, ou nem registrar. O motivo sempre fica visível.
  let decisao: Decisao | null = null;
  let silencioso = p.silencioso === true;
  if (!p.silencioso && !p.evento) {
    try {
      decisao = decidir(alerta);
      alerta.severidade = decisao.severidade;
      if (!decisao.registrar) {
        logger.info('Alerta suprimido antes de registrar', { chave: alerta.chave, motivo: decisao.motivo });
        return null;
      }
      if (!decisao.avisar) {
        silencioso = true;
        motivoSilencio = decisao.motivo ?? 'não enviado por regra do painel';
      }
    } catch (err) {
      logger.error('Alerta: falha ao aplicar regras', { err: err instanceof Error ? err.message : String(err) });
    }
  }

  const r = db().prepare(
    `INSERT OR IGNORE INTO alerta (id, origem, severidade, titulo, texto, dados, chave, criado_em, envio_erro, resolvido_em)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    alerta.id, alerta.origem, alerta.severidade, alerta.titulo, alerta.texto,
    alerta.dados === null ? null : JSON.stringify(alerta.dados), alerta.chave, alerta.criado_em,
    silencioso ? motivoSilencio : null,
    alerta.resolvido_em,
  );
  if (!r.changes) return null;   // chave repetida: fato já alertado
  if (decisao) registrarDecisao(alerta, decisao);

  if (silencioso) {
    alerta.envio_erro = motivoSilencio;
    publicar('alerta', alerta);
    return alerta;
  }

  // O incidente nasce ANTES do despacho: a mensagem já sai com o número, e
  // quem recebe consegue responder "assumir INC-...".
  let incidente: { numero: string; severidade: string; equipe: string | null } | null = null;
  try {
    incidente = correlacionar(alerta, { evento: p.evento });
  } catch (err) {
    logger.error('Alerta: falha ao correlacionar incidente', { err: err instanceof Error ? err.message : String(err) });
  }
  if (incidente) {
    // Quem está de plantão vai junto: quem lê o alerta sabe de quem é a vez sem
    // abrir o painel, e equipe descoberta aparece em vez de sumir.
    const plantao = obter<boolean>('plantao.avisar_no_alerta') ? avisoDePlantao(incidente.equipe) : null;
    const rodape = [`_${incidente.numero} · responda "assumir ${incidente.numero}" para assumir_`]
      .concat(plantao ? [`_${plantao}_`] : []).join('\n');
    alerta.texto = `${alerta.texto}\n\n${rodape}`;
    db().prepare(`UPDATE alerta SET texto = ? WHERE id = ?`).run(alerta.texto, alerta.id);
  }

  publicar('alerta', alerta);
  dispararWebhooks('alerta', alerta);

  // Debounce: o aviso espera. Quem solta é o monitor de regras, e só se o
  // problema ainda estiver de pé.
  if (decisao?.esperar_ate) {
    db().prepare(`UPDATE alerta SET aguardando_ate = ?, envio_erro = ? WHERE id = ?`)
      .run(decisao.esperar_ate, decisao.motivo, alerta.id);
    alerta.envio_erro = decisao.motivo;
    return alerta;
  }

  await despachar(alerta, decisao?.prioritario === true, p.audio ?? null);
  return alerta;
}

/**
 * Solta os avisos que estavam em espera. O que normalizou sozinho não vira
 * mensagem: fica no painel com o motivo.
 */
export async function soltarEspera(quando = new Date()): Promise<{ enviados: number; descartados: number }> {
  let enviados = 0;
  let descartados = 0;
  for (const item of esperaVencida(quando)) {
    const a = porId(item.id);
    if (!a) continue;
    if (item.resolvido) {
      limparEspera(a.id, 'normalizou sozinho durante a espera: não foi avisado');
      descartados++;
      continue;
    }
    db().prepare(`UPDATE alerta SET aguardando_ate = NULL, envio_erro = NULL WHERE id = ?`).run(a.id);
    await despachar(a);
    enviados++;
  }
  return { enviados, descartados };
}

export function porId(id: string): Alerta | null {
  const l = db().prepare(`SELECT * FROM alerta WHERE id = ?`).get(id) as Linha | undefined;
  return l ? paraAlerta(l) : null;
}

async function despachar(a: Alerta, prioritario = false, audio: Buffer | null = null): Promise<void> {
  const motivoNaoEnvio = (m: string) => {
    db().prepare(`UPDATE alerta SET envio_erro = ? WHERE id = ?`).run(m, a.id);
    a.envio_erro = m;
  };

  // Quem recebe depende da gravidade: o roteamento decide grupo, pessoas e plantão.
  const alvos: Alvo[] = alvosDoAlerta(a);
  if (!alvos.length) {
    return motivoNaoEnvio('ninguém recebe este tipo de alerta (sem grupo, sem pessoa cadastrada e sem plantão para ele)');
  }

  const inicio = obter<string>('alertas.silencio_inicio');
  const fim = obter<string>('alertas.silencio_fim');
  if (!prioritario && a.severidade !== 'critico' && dentroDaJanela(inicio, fim)) {
    return motivoNaoEnvio(`horário de silêncio (${inicio}–${fim}); só crítico é enviado`);
  }

  if (!evoTecnicos.disponivel) {
    contingencia(a, 'a instância do WhatsApp não está configurada');
    return motivoNaoEnvio('instância Evolution dos técnicos não configurada');
  }

  const falhas: string[] = [];
  const receberam: Alvo[] = [];
  for (const alvo of alvos) {
    const r = await evoTecnicos.enviarTextoComId(alvo.jid, a.texto);
    registrarEnvio(a.id, alvo.rotulo, r.ok, r.ok ? null : 'falha no WhatsApp (ver log do Evolution)',
      { mensagemId: r.id, motivo: alvo.origem });
    if (r.ok) receberam.push(alvo);
    else falhas.push(alvo.rotulo);
  }

  // Áudio DEPOIS de todos os textos: gerar a voz leva segundos, e o texto de
  // um alerta crítico não pode esperar por ela. Só para quem recebeu o texto;
  // falha no áudio não é falha do alerta.
  if (receberam.length) {
    let voz = audio;
    if (!voz && deveFalar(a)) {
      voz = await sintetizar(falaDoAlerta(a), 'opus').catch(() => null);
      if (!voz) logger.warn('Alerta: sem áudio, foi só o texto', { chave: a.chave });
    }
    if (voz) {
      for (const alvo of receberam) {
        const foi = await evoTecnicos.enviarAudio(alvo.jid, voz);
        if (!foi) logger.warn('Alerta: áudio não foi entregue', { para: alvo.rotulo, chave: a.chave });
      }
    }
  }
  if (falhas.length === alvos.length) {
    contingencia(a, 'o WhatsApp recusou todos os envios');
    return motivoNaoEnvio(`falha ao enviar pelo WhatsApp para ${falhas.join(', ')} (ver log do Evolution)`);
  }

  const agora = new Date().toISOString();
  const parcial = falhas.length ? `não chegou para: ${falhas.join(', ')}` : null;
  db().prepare(`UPDATE alerta SET enviado_em = ?, envio_erro = ? WHERE id = ?`).run(agora, parcial, a.id);
  a.enviado_em = agora;
  a.envio_erro = parcial;
  logger.info(`Alerta enviado: ${a.titulo}`, { para: alvos.length, falhas: falhas.length });
}

/** O aviso vai também em áudio? Painel: alertas.audio (nunca, criticos, todos). */
export function deveFalar(a: Pick<Alerta, 'severidade' | 'chave' | 'origem'>): boolean {
  if (a.chave.startsWith('resumo:') || a.origem === 'bot') return false;   // resumo traz o próprio áudio
  const modo = obter<string>('alertas.audio');
  if (modo === 'todos') return true;
  if (modo === 'criticos') return a.severidade === 'critico' && !a.chave.endsWith(':resolvido');
  return false;
}

/**
 * WhatsApp fora: o alerta não pode simplesmente sumir. Vai para o painel como
 * contingência, e o painel avisa com som e notificação do navegador. Sem
 * painel aberto também, isso é registrado como alerta sem canal nenhum — que
 * é a única informação honesta nessa situação.
 */
function contingencia(a: Alerta, motivo: string): void {
  if (!obter<boolean>('canais.contingencia')) return;
  const paineis = paineisConectados();
  publicar('contingencia', {
    alerta: { id: a.id, titulo: a.titulo, texto: a.texto, severidade: a.severidade, chave: a.chave },
    motivo, paineis,
  });
  if (paineis > 0) {
    logger.warn('Alerta em contingência: entregue pelo painel', { chave: a.chave, motivo, paineis });
  } else {
    logger.error('Alerta sem canal: WhatsApp fora e nenhum painel aberto', { chave: a.chave, motivo });
  }
}

export function marcarResolvido(chave: string): Alerta | null {
  const agora = new Date().toISOString();
  const r = db().prepare(
    `UPDATE alerta SET resolvido_em = ? WHERE chave = ? AND resolvido_em IS NULL`,
  ).run(agora, chave);
  if (!r.changes) return null;
  const a = porChave(chave);
  if (a) {
    publicar('alerta', a);
    dispararWebhooks('alerta.resolvido', a);
    // Resolver o último alerta não encerra o incidente: ele entra em observação.
    try { alertaResolvido(a); } catch (err) {
      logger.error('Alerta: falha ao normalizar incidente', { err: err instanceof Error ? err.message : String(err) });
    }
  }
  return a;
}

export function reconhecer(id: string, usuario: string): boolean {
  const r = db().prepare(
    `UPDATE alerta SET reconhecido_em = ?, reconhecido_por = ? WHERE id = ? AND reconhecido_em IS NULL`,
  ).run(new Date().toISOString(), usuario, id);
  if (r.changes) marcarReconhecido(id);
  return r.changes > 0;
}

/**
 * Sobe um degrau nos incidentes que estouraram o prazo sem ninguém assumir.
 * Mora aqui porque quem sabe mandar mensagem é este módulo; quem decide a
 * subida é o roteamento.
 */
export async function escalarPendentes(quando = new Date()): Promise<number> {
  let subiram = 0;
  for (const e of paraEscalar(quando)) {
    marcarEscalada(e, quando);
    subiram++;
    if (!e.degrau.pessoas.length) {
      logger.error('Escalonamento sem ninguém para acionar', { numero: e.incidente.numero, degrau: e.degrau.rotulo });
      continue;
    }
    if (!evoTecnicos.disponivel) continue;
    const alerta = db().prepare(
      `SELECT alerta_id FROM incidente_alerta WHERE incidente_id = ? ORDER BY rowid DESC LIMIT 1`,
    ).get(e.incidente.id) as { alerta_id: string } | undefined;
    const receberam: string[] = [];
    for (const p of e.degrau.pessoas) {
      const r = await evoTecnicos.enviarTextoComId(p.numero, e.texto);
      if (r.ok) receberam.push(p.numero);
      if (alerta) {
        registrarEnvio(alerta.alerta_id, `${p.nome} (${e.degrau.rotulo})`, r.ok,
          r.ok ? null : 'falha no WhatsApp (ver log do Evolution)',
          { mensagemId: r.id, motivo: 'escalonamento' });
      }
    }
    // Escalonamento é o aviso que mais precisa ser ouvido: ninguém assumiu.
    if (receberam.length && obter<string>('alertas.audio') !== 'nunca') {
      const original = alerta ? porId(alerta.alerta_id) : null;
      const fala = `Atenção. Ninguém assumiu ainda o problema ${e.incidente.numero}, e o prazo passou. ` +
        (original ? `${falaDoAlerta(original).replace(/^(Atenção|Aviso)\.\s*/, '')}` : 'Os detalhes estão na mensagem de texto.');
      const voz = await sintetizar(fala, 'opus').catch(() => null);
      if (voz) for (const numero of receberam) await evoTecnicos.enviarAudio(numero, voz);
    }
  }
  return subiram;
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
