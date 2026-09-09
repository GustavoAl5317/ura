// Entrypoint do assistente de observabilidade (npm run assistant).
//
// Processo SEPARADO da URA de propósito: a URA faz pacing de áudio em tempo
// real e uma consulta de 8 s aqui dentro viraria engasgo em ligação. Os dois
// compartilham src/integrations e src/config, e nada mais.

import 'dotenv/config';
import http from 'http';
import { config } from '../config';
import { logger } from '../logger';
import { db } from './store/db';
import { semearPrompts, listarChaves, listarVersoes, promptAtivo, salvarPrompt, ativarVersao } from './prompts';
import { agendarSync, sincronizar, statusIndice } from './store/sgp-index';
import { registrarFerramentas } from './tools/consultas';
import { ferramentas } from './tools/base';
import { parseWebhook } from '../integrations/evolution';
import { evoTecnicos, processarMensagem } from './channels/whatsapp-tecnicos';
import { responder } from './agent';

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

function autorizadoApi(req: http.IncomingMessage, url: URL): boolean {
  const chave = config.admin.apiKey;
  if (!chave) return true;
  return (
    req.headers.authorization === `Bearer ${chave}` ||
    req.headers['x-admin-key'] === chave ||
    url.searchParams.get('key') === chave
  );
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

  if (req.method === 'GET' && p === '/health') {
    return json(res, 200, {
      ok: true,
      espelho: statusIndice(),
      evolution: config.evolutionTecnicos.instance || null,
    });
  }

  if (!p.startsWith('/api/')) {
    res.writeHead(404);
    res.end();
    return;
  }

  if (!autorizadoApi(req, url)) return json(res, 401, { error: 'unauthorized' });

  // ── Painel operacional ─────────────────────────────────────────────────────
  if (req.method === 'GET' && p === '/api/status') {
    const evo = await evoTecnicos.estadoConexao();
    const d = db();
    const consultas24h = (d.prepare(
      `SELECT COUNT(*) n FROM consulta WHERE at > datetime('now','-1 day')`,
    ).get() as { n: number }).n;
    const porVeredito = d.prepare(
      `SELECT veredito, COUNT(*) n FROM consulta WHERE at > datetime('now','-7 day')
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
    void sincronizar({ maxPaginas });   // ~25 min completo: não segura o request
    return json(res, 202, {
      ok: true,
      aviso: maxPaginas
        ? `sync PARCIAL iniciado (${maxPaginas} página(s)) — o espelho ficará incompleto`
        : 'sync completo iniciado em segundo plano (~25 min)',
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

    const r = await responder({
      pergunta: b.pergunta,
      usuario: b.usuario ?? 'painel',
      canal: 'chat',
      conversaId: b.conversaId,
      historico: b.historico,
    });
    return json(res, 200, r);
  }

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

  if (!evo.autorizados.length) {
    logger.warn(
      'EVO_TEC_AUTORIZADOS vazio — o assistente vai IGNORAR toda mensagem. ' +
      'Isso é proposital: sem allowlist, qualquer número consultaria dado de cliente.',
    );
  }

  agendarSync();

  const server = http.createServer((req, res) => {
    rotear(req, res).catch((err) => {
      logger.error('Assistente: erro na rota', {
        url: req.url,
        err: err instanceof Error ? err.message : String(err),
      });
      if (!res.headersSent) json(res, 500, { error: 'erro_interno' });
    });
  });

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

  server.listen(config.assistant.port, '0.0.0.0', () => {
    logger.info(`Assistente escutando na porta ${config.assistant.port}`);
    logger.info(`  webhook: POST http://<host>:${config.assistant.port}/webhook/evolution`);
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
