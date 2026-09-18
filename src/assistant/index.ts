// Entrypoint do assistente de observabilidade (npm run assistant).
//
// Processo SEPARADO da URA de propósito: a URA faz pacing de áudio em tempo
// real e uma consulta de 8 s aqui dentro viraria engasgo em ligação. Os dois
// compartilham src/integrations e src/config, e nada mais.

import 'dotenv/config';
import { randomUUID } from 'crypto';
import http from 'http';
import https from 'https';
import fs from 'fs';
import { config } from '../config';
import { logger } from '../logger';
import { db } from './store/db';
import { semearPrompts, listarChaves, listarVersoes, promptAtivo, salvarPrompt, ativarVersao } from './prompts';
import { agendarSync, sincronizar, statusIndice } from './store/sgp-index';
import { registrarFerramentas } from './tools/consultas';
import { registrarFerramentasMetricas } from './tools/metricas';
import { registrarFerramentasCausais } from './tools/causal';
import { registrarFerramentasNetflow } from './tools/netflow';
import { registrarFerramentasCtos } from './tools/ctos';
import { registrarFerramentasAtendimento } from './tools/atendimento';
import { obter } from './config-dinamica';
import { registrarFerramentasRelatorios } from './tools/relatorios';
import { ferramentas } from './tools/base';
import { parseWebhook } from '../integrations/evolution';
import { evoTecnicos, processarMensagem } from './channels/whatsapp-tecnicos';
import { responder } from './agent';
import { rotasOperacao } from './rotas-operacao';
import { rotasAdmin } from './rotas-admin';
import { rotasPainel, rotasChatAudio } from './rotas-painel';
import { ator } from './http-util';
import { ErroHttp } from './http-util';
import { iniciarMonitorZabbix } from './monitors/zabbix';
import { iniciarMonitorSla } from './monitors/sla';
import { iniciarMonitorResumo } from './resumo-diario';
import { iniciarMonitorNetflow } from './monitors/netflow';
import { iniciarMonitorCtos } from './monitors/ctos';

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function lerCorpo(req: http.IncomingMessage, maxBytes = 8 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let corpo = '';
    let bytes = 0;
    req.on('data', (c: Buffer) => {
      bytes += c.length;
      if (bytes > maxBytes) {
        reject(new Error('corpo grande demais'));
        req.destroy();
        return;
      }
      corpo += c;
    });
    req.on('end', () => resolve(corpo));
    req.on('error', reject);
  });
}

function parseCookies(req: http.IncomingMessage): Record<string, string> {
  const c: Record<string, string> = {};
  for (const par of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = par.split('=');
    if (k?.trim()) c[k.trim()] = decodeURIComponent(v.join('=').trim());
  }
  return c;
}

function sessaoDoCookie(req: http.IncomingMessage): { token: string; operador: string } | null {
  const token = parseCookies(req).aq_sessao;
  if (!token) return null;
  const row = db().prepare(`SELECT token, operador FROM sessao_painel WHERE token = ?`).get(token) as { token: string; operador: string } | undefined;
  if (!row) return null;
  // Atualiza última atividade
  db().prepare(`UPDATE sessao_painel SET ultima_em = ? WHERE token = ?`).run(new Date().toISOString(), token);
  return row;
}

function atorComSessao(req: http.IncomingMessage): string {
  const sess = sessaoDoCookie(req);
  if (sess) return `painel:${sess.operador}`;
  return ator(req);
}

function autorizadoApi(req: http.IncomingMessage, url: URL): boolean {
  const chave = config.admin.apiKey;
  if (!chave) return true;
  if (
    req.headers.authorization === `Bearer ${chave}` ||
    req.headers['x-admin-key'] === chave ||
    url.searchParams.get('key') === chave
  ) return true;
  // Cookie de sessão do painel
  return !!sessaoDoCookie(req);
}

/**
 * Quem pode chamar uma rota /api. A URA tem chave própria (URA_EVENTS_KEY),
 * que só entrega eventos de chamada: se a VM da URA vazar, ninguém lê
 * consulta, cliente ou configuração com ela.
 */
export function acessoApi(req: http.IncomingMessage, url: URL, p: string): 200 | 401 | 403 {
  const chaveUra = config.assistant.chaveEventosUra;
  const ehEventoUra = req.method === 'POST' && p === '/api/eventos/ura';
  const comChaveUra = !!chaveUra && req.headers['x-admin-key'] === chaveUra;
  if (comChaveUra && chaveUra !== config.admin.apiKey) return ehEventoUra ? 200 : 403;
  return autorizadoApi(req, url) ? 200 : 401;
}

/** O webhook é público na rede — valida por segredo próprio, não pela chave do painel. */
function webhookValido(req: http.IncomingMessage, url: URL): boolean {
  const segredo = config.assistant.webhookSecret;
  if (!segredo) return true;
  return (
    req.headers['x-webhook-secret'] === segredo ||
    url.searchParams.get('secret') === segredo
  );
}

async function rotear(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const p = url.pathname;

  // ── Webhook da Evolution ───────────────────────────────────────────────────
  if (req.method === 'POST' && (p === '/webhook/evolution' || p === '/webhook')) {
    if (!webhookValido(req, url)) return json(res, 401, { error: 'segredo_invalido' });

    // Responde 200 na hora: a Evolution reentrega o que demora, e reentrega
    // vira resposta duplicada. O processamento segue fora do ciclo do request.
    json(res, 200, { ok: true });

    try {
      const msg = parseWebhook(JSON.parse(await lerCorpo(req)));
      if (msg) void processarMensagem(msg).catch((err) => {
        logger.error('Assistente: erro ao processar mensagem', {
          err: err instanceof Error ? err.message : String(err),
        });
      });
    } catch (err) {
      logger.warn('Assistente: webhook inválido', { err: String(err) });
    }
    return;
  }

  // /health é SEM autenticação (é o que monitor e supervisor consultam), então
  // não pode dizer nada além de "estou vivo". A versão anterior devolvia o
  // tamanho da base de clientes, quantos têm ONU e o nome da instância
  // interna — e a porta estava alcançável da internet. O detalhe mora em
  // /api/health, que exige a chave.
  if (req.method === 'GET' && p === '/health') {
    return json(res, 200, { ok: true, espelhoPronto: statusIndice().disponivel });
  }

  // Página do painel: estática e sem chave (a chave é pedida na tela).
  if (await rotasPainel(req, res, url, p)) return;

  if (!p.startsWith('/api/')) {
    res.writeHead(404);
    res.end();
    return;
  }

  // ── Sessão do painel (cookie) ────────────────────────────────────────────
  if (req.method === 'POST' && p === '/api/sessao') {
    const b = JSON.parse(await lerCorpo(req)) as { chave?: string; operador?: string };
    const chave = config.admin.apiKey;
    if (chave && b.chave !== chave) return json(res, 401, { error: 'chave_invalida' });
    const operador = (b.operador ?? '').trim().slice(0, 60);
    if (!operador) return json(res, 400, { error: 'operador_obrigatorio' });
    const token = randomUUID();
    const agora = new Date().toISOString();
    db().prepare(`INSERT INTO sessao_painel (token, operador, criada_em, ultima_em) VALUES (?,?,?,?)`).run(token, operador, agora, agora);
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Set-Cookie': `aq_sessao=${token}; HttpOnly; Path=/; SameSite=Strict; Max-Age=31536000`,
    });
    res.end(JSON.stringify({ ok: true, operador }));
    return;
  }

  if (req.method === 'GET' && p === '/api/sessao') {
    const sess = sessaoDoCookie(req);
    if (!sess) return json(res, 401, { error: 'sem_sessao' });
    return json(res, 200, { operador: sess.operador });
  }

  if (req.method === 'DELETE' && p === '/api/sessao') {
    const token = parseCookies(req).aq_sessao;
    if (token) db().prepare(`DELETE FROM sessao_painel WHERE token = ?`).run(token);
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Set-Cookie': 'aq_sessao=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0',
    });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  const acesso = acessoApi(req, url, p);
  if (acesso === 403) return json(res, 403, { error: 'chave da URA só envia eventos de chamada' });
  if (acesso === 401) return json(res, 401, { error: 'unauthorized' });

  // Health detalhado — o que o /health público mostrava antes, agora atrás da chave.
  if (req.method === 'GET' && p === '/api/health') {
    return json(res, 200, {
      ok: true,
      espelho: statusIndice(),
      evolution: config.evolutionTecnicos.instance || null,
      uptimeSec: Math.round(process.uptime()),
    });
  }

  // ── Painel operacional ─────────────────────────────────────────────────────
  if (req.method === 'GET' && p === '/api/status') {
    const evo = await evoTecnicos.estadoConexao();
    const d = db();
    const consultas24h = (d.prepare(
      // `at` é ISO 8601 (com T e Z); datetime('now') tem espaço, e a comparação de
      // texto contava até um dia a mais. strftime no mesmo formato compara certo.
      `SELECT COUNT(*) n FROM consulta WHERE at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day')`,
    ).get() as { n: number }).n;
    const porVeredito = d.prepare(
      `SELECT veredito, COUNT(*) n FROM consulta WHERE at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 day')
       GROUP BY veredito`,
    ).all() as Array<{ veredito: string; n: number }>;

    return json(res, 200, {
      uptimeSec: Math.round(process.uptime()),
      modelo: config.assistant.model,
      espelho: statusIndice(),
      integracoes: {
        sgp: !!config.sgp.baseUrl,
        zabbix: config.zabbix.enabled,
        evolution: evo,
        questdb: config.questdb.enabled,
        netflow: config.netflow.enabled,
      },
      ferramentas: ferramentas.disponiveis(null).map((f) => ({ nome: f.nome, fonte: f.fonte })),
      consultas24h,
      porVeredito,
    });
  }

  // ── Histórico e auditoria ──────────────────────────────────────────────────
  if (req.method === 'GET' && p === '/api/consultas') {
    const limite = Math.min(200, parseInt(url.searchParams.get('limite') ?? '50', 10) || 50);
    const linhas = db().prepare(
      `SELECT id, usuario, canal, pergunta, veredito, veredito_ajustado, fontes,
              modelo, duracao_ms, at
       FROM consulta ORDER BY at DESC LIMIT ?`,
    ).all(limite);
    return json(res, 200, { consultas: linhas });
  }

  const mConsulta = p.match(/^\/api\/consultas\/([^/]+)$/);
  if (req.method === 'GET' && mConsulta) {
    const d = db();
    const c = d.prepare(`SELECT * FROM consulta WHERE id = ?`).get(mConsulta[1]);
    if (!c) return json(res, 404, { error: 'not_found' });
    const evs = d.prepare(
      `SELECT evd, fonte, nome_consulta, args, consultado_em, duracao_ms, ok, vazio, dados, erro
       FROM evidencia WHERE consulta_id = ? ORDER BY evd`,
    ).all(mConsulta[1]);
    return json(res, 200, { consulta: c, evidencias: evs });
  }

  if (req.method === 'GET' && p === '/api/auditoria') {
    const limite = Math.min(200, parseInt(url.searchParams.get('limite') ?? '50', 10) || 50);
    return json(res, 200, {
      registros: db().prepare(`SELECT * FROM auditoria ORDER BY at DESC LIMIT ?`).all(limite),
    });
  }

  // ── Conversas do painel (histórico estilo WhatsApp) ────────────────────────
  if (req.method === 'GET' && p === '/api/conversas') {
    const usuario = atorComSessao(req);
    const limite = Math.min(100, parseInt(url.searchParams.get('limite') ?? '50', 10) || 50);
    const linhas = db().prepare(
      `SELECT c.id, c.canal, c.usuario, c.nome, c.criada_em, c.ultima_em,
              (SELECT conteudo FROM mensagem WHERE conversa_id = c.id AND papel = 'user' ORDER BY at ASC LIMIT 1) AS primeira_pergunta,
              (SELECT COUNT(*) FROM mensagem WHERE conversa_id = c.id) AS total_msgs
       FROM conversa c
       WHERE c.usuario = ? AND c.canal = 'chat'
       ORDER BY c.ultima_em DESC LIMIT ?`,
    ).all(usuario, limite);
    return json(res, 200, { conversas: linhas });
  }

  if (req.method === 'POST' && p === '/api/conversas') {
    const usuario = atorComSessao(req);
    const id = randomUUID();
    const agora = new Date().toISOString();
    db().prepare(
      `INSERT INTO conversa (id, canal, usuario, nome, criada_em, ultima_em) VALUES (?,?,?,?,?,?)`,
    ).run(id, 'chat', usuario, null, agora, agora);
    return json(res, 200, { id });
  }

  const mConversaMsgs = p.match(/^\/api\/conversas\/([^/]+)\/mensagens$/);
  if (req.method === 'GET' && mConversaMsgs) {
    const linhas = db().prepare(
      `SELECT id, papel, formato, conteudo, at FROM mensagem WHERE conversa_id = ? ORDER BY at ASC`,
    ).all(mConversaMsgs[1]);
    return json(res, 200, { mensagens: linhas });
  }

  // ── Prompts versionados ────────────────────────────────────────────────────
  if (req.method === 'GET' && p === '/api/prompts') {
    return json(res, 200, { chaves: listarChaves() });
  }

  const mPrompt = p.match(/^\/api\/prompts\/([^/]+)$/);
  if (req.method === 'GET' && mPrompt) {
    return json(res, 200, {
      chave: mPrompt[1],
      ativo: promptAtivo(mPrompt[1]),
      versoes: listarVersoes(mPrompt[1]),
    });
  }
  if (req.method === 'POST' && mPrompt) {
    const b = JSON.parse(await lerCorpo(req)) as { conteudo?: string; autor?: string; nota?: string };
    if (!b.conteudo?.trim()) return json(res, 400, { error: 'conteudo_vazio' });
    const salvo = salvarPrompt(mPrompt[1], b.conteudo, b.autor ?? 'painel', b.nota);
    return json(res, 200, { ok: true, prompt: salvo });
  }

  const mAtivar = p.match(/^\/api\/prompts\/([^/]+)\/ativar\/(\d+)$/);
  if (req.method === 'POST' && mAtivar) {
    const b = JSON.parse((await lerCorpo(req)) || '{}') as { autor?: string };
    const ok = ativarVersao(mAtivar[1], parseInt(mAtivar[2], 10), b.autor ?? 'painel');
    return json(res, ok ? 200 : 404, { ok });
  }

  // ── Espelho do SGP ─────────────────────────────────────────────────────────
  if (req.method === 'GET' && p === '/api/espelho') {
    return json(res, 200, statusIndice());
  }
  if (req.method === 'POST' && p === '/api/espelho/sync') {
    if (statusIndice().sincronizando) return json(res, 409, { error: 'sync_em_andamento' });
    // ?paginas=N limita a carga no SGP (validação / retomada). Sem isso, base toda.
    const maxPaginas = parseInt(url.searchParams.get('paginas') ?? '', 10) || undefined;
    const retomar = url.searchParams.get('retomar') === '1';
    void sincronizar({ maxPaginas, retomar });   // ~20 min completo: não segura o request
    return json(res, 202, {
      ok: true,
      aviso: maxPaginas
        ? `sync PARCIAL iniciado (${maxPaginas} página(s)) — o espelho ficará incompleto`
        : retomar
          ? 'sync retomado do ponto onde o último falhou'
          : 'sync completo iniciado em segundo plano (~20 min)',
    });
  }

  // ── Chat interno: mesma inteligência, outro canal ──────────────────────────
  if (req.method === 'POST' && p === '/api/chat') {
    const b = JSON.parse(await lerCorpo(req)) as {
      pergunta?: string;
      usuario?: string;
      conversaId?: string;
      historico?: Array<{ papel: 'user' | 'assistant'; conteudo: string }>;
    };
    if (!b.pergunta?.trim()) return json(res, 400, { error: 'pergunta_vazia' });

    const usuario = b.usuario ?? atorComSessao(req);
    const agora = new Date().toISOString();
    const d = db();

    // Criar ou reutilizar conversa
    let conversaId = b.conversaId;
    if (conversaId) {
      // Verifica se a conversa existe
      const existe = d.prepare(`SELECT id FROM conversa WHERE id = ?`).get(conversaId);
      if (!existe) conversaId = undefined;
    }
    if (!conversaId) {
      conversaId = randomUUID();
      d.prepare(
        `INSERT INTO conversa (id, canal, usuario, nome, criada_em, ultima_em) VALUES (?,?,?,?,?,?)`,
      ).run(conversaId, 'chat', usuario, null, agora, agora);
    }

    // Carregar histórico do banco se não veio no request
    let hist = b.historico;
    if (!hist || !hist.length) {
      hist = d.prepare(
        `SELECT papel, conteudo FROM mensagem WHERE conversa_id = ? ORDER BY at DESC LIMIT 24`,
      ).all(conversaId) as Array<{ papel: 'user' | 'assistant'; conteudo: string }>;
      hist.reverse();
    }

    const r = await responder({
      pergunta: b.pergunta,
      usuario,
      canal: 'chat',
      conversaId,
      historico: hist.slice(-12),
    });

    // Persistir mensagens no banco
    d.prepare(
      `INSERT INTO mensagem (id, conversa_id, papel, formato, conteudo, at) VALUES (?,?,?,?,?,?)`,
    ).run(randomUUID(), conversaId, 'user', 'texto', b.pergunta, agora);
    d.prepare(
      `INSERT INTO mensagem (id, conversa_id, papel, formato, conteudo, at) VALUES (?,?,?,?,?,?)`,
    ).run(randomUUID(), conversaId, 'assistant', 'texto', r.texto, new Date().toISOString());
    d.prepare(`UPDATE conversa SET ultima_em = ? WHERE id = ?`).run(new Date().toISOString(), conversaId);

    return json(res, 200, { ...r, conversaId });
  }

  if (await rotasChatAudio(req, res, url, p)) return;
  if (await rotasOperacao(req, res, url, p)) return;
  if (await rotasAdmin(req, res, url, p)) return;

  res.writeHead(404);
  res.end();
}

async function main(): Promise<void> {
  if (!config.assistant.enabled) {
    logger.warn('Assistente desabilitado (ASSISTANT_ENABLED=0). Nada a fazer.');
    return;
  }

  db();
  semearPrompts();
  registrarFerramentas();
  registrarFerramentasMetricas();
  registrarFerramentasCausais();
  registrarFerramentasNetflow();
  registrarFerramentasRelatorios();
  registrarFerramentasCtos();
  registrarFerramentasAtendimento();

  const st = statusIndice();
  const evo = config.evolutionTecnicos;

  logger.info('══════════════════════════════════════════');
  logger.info(`  Assistente de Observabilidade — ${config.company.name}`);
  logger.info(`  Modelo   : ${config.assistant.model} (temp ${config.assistant.temperature})`);
  logger.info(`  Fontes   : SGP${config.zabbix.enabled ? ' · Zabbix' : ''}` +
    `${config.questdb.enabled ? ' · QuestDB' : ''}${config.netflow.enabled ? ' · NetFlow' : ''}`);
  logger.info(`  Espelho  : ${st.clientes} clientes, ${st.comSn} com ONU` +
    `${st.ultimoSync ? ` (sync há ${st.idadeHoras}h)` : ' (nunca sincronizado)'}`);
  logger.info(`  WhatsApp : ${evo.instance || 'NÃO CONFIGURADO'} · ${evo.autorizados.length} autorizado(s)`);
  logger.info(`  Ferramentas: ${ferramentas.disponiveis(null).length}`);
  logger.info('══════════════════════════════════════════');

  const modoWhats = obter<string>('whatsapp.acesso');
  logger.info(`  Quem pergunta no WhatsApp: ${modoWhats} (painel → Configuração → WhatsApp)`);
  if (modoWhats === 'cadastrados' && !evo.autorizados.length) {
    logger.warn(
      'Modo "cadastrados" e EVO_TEC_AUTORIZADOS vazio: só respondem os números da aba Técnicos do painel.',
    );
  }

  agendarSync();
  iniciarMonitorZabbix();
  iniciarMonitorSla();
  iniciarMonitorResumo();
  iniciarMonitorNetflow();
  iniciarMonitorCtos();

  const atender = (req: http.IncomingMessage, res: http.ServerResponse) => {
    rotear(req, res).catch((err) => {
      // Erro de validação vira 4xx com mensagem legível para o painel; o resto é 500.
      if (err instanceof ErroHttp) {
        if (!res.headersSent) json(res, err.status, { error: err.message });
        return;
      }
      logger.error('Assistente: erro na rota', {
        url: req.url,
        err: err instanceof Error ? err.message : String(err),
      });
      if (!res.headersSent) json(res, 500, { error: 'erro_interno' });
    });
  };
  const server = http.createServer(atender);

  // Sem isto, um bind que falha vira "uncaught exception" e o processo fica
  // VIVO sem servir nada — o supervisor não reinicia porque ninguém morreu.
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      logger.error(`Assistente: porta ${config.assistant.port} já em uso — outra instância está rodando?`);
    } else {
      logger.error('Assistente: erro no servidor HTTP', { err: err.message });
    }
    process.exit(1);
  });

  server.listen(config.assistant.port, config.assistant.host, () => {
    logger.info(`Assistente escutando em ${config.assistant.host}:${config.assistant.port}`);
    // O firewall é aplicado pelo systemd (scripts/firewall-assistente.sh), que lê
    // a mesma variável do .env. Com ela definida, o aviso seria alarme falso.
    const firewall = (process.env.ASSISTANT_FIREWALL_LIBERAR ?? '').trim();
    if (config.assistant.host === '0.0.0.0' && firewall && firewall !== 'desligado') {
      logger.info(`  porta filtrada pelo firewall: só ${firewall}`);
    } else if (config.assistant.host === '0.0.0.0') {
      logger.warn(
        'ASSISTANT_HOST=0.0.0.0 escuta em todas as interfaces, inclusive IP público. ' +
        'Se o único cliente é o Evolution local, use 172.17.0.1 ou bloqueie a porta no firewall.',
      );
    }
    logger.info(`  webhook: POST http://<host>:${config.assistant.port}/webhook/evolution`);
  });

  iniciarHttps(atender);
}

/**
 * HTTPS opcional, só para o painel poder usar o microfone. Falha aqui NÃO
 * derruba o assistente: o HTTP (webhook, URA, painel sem voz) segue no ar.
 */
function iniciarHttps(atender: http.RequestListener): void {
  const porta = config.assistant.httpsPort;
  if (!porta) return;
  let credenciais: { key: Buffer; cert: Buffer };
  try {
    credenciais = { key: fs.readFileSync(config.assistant.httpsKey), cert: fs.readFileSync(config.assistant.httpsCert) };
  } catch (err) {
    logger.error(`Assistente: HTTPS na porta ${porta} não iniciou — certificado ilegível`, {
      cert: config.assistant.httpsCert, key: config.assistant.httpsKey,
      err: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  const seguro = https.createServer(credenciais, atender);
  seguro.on('error', (err: NodeJS.ErrnoException) => {
    logger.error(`Assistente: HTTPS na porta ${porta} falhou`, { err: err.message });
  });
  seguro.listen(porta, config.assistant.host, () => {
    logger.info(`Assistente escutando em HTTPS ${config.assistant.host}:${porta} (painel com microfone)`);
  });
}

process.on('uncaughtException', (err) => {
  logger.error('Assistente: uncaught exception', { err: err.message, stack: err.stack });
});
process.on('unhandledRejection', (reason) => {
  logger.error('Assistente: unhandled rejection', {
    reason: reason instanceof Error ? reason.message : String(reason),
  });
});

main().catch((err) => {
  logger.error('Assistente: falha ao iniciar', {
    err: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
