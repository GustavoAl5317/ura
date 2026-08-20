// API do painel de atendimento: login/sessão, gestão de usuários, lista de
// conversas, telemetria das consultas da IA e as ações de intervenção.

import http from 'http';
import fs from 'fs';
import path from 'path';
import { config } from '../config';
import { logger } from '../logger';
import type { ChatSessionStore } from './session';
import {
  autenticar, login as fazerLogin, logout as encerrarSessao,
  cookieSessao, cookieLimpo, usuarioPublico,
  listarUsuarios, criarUsuario, atualizarUsuario, removerUsuario,
  usuariosOnline, derrubarSessoes, derrubarTodasSessoes,
  type Papel,
} from './auth';
import {
  auditoriaConversas, auditoriaResumo, conversaDetalheAuditoria,
  conversasRecentesPainel, detalheConversaPainel,
} from './repo';
import { buscarArquivo } from './arquivos';
import { paraOggOpus } from './audio-transcode';

function json(res: http.ServerResponse, status: number, body: unknown, cookie?: string): void {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  };
  if (cookie) headers['Set-Cookie'] = cookie;
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}

function lerCorpo(req: http.IncomingMessage, maxBytes = 200_000): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (d) => {
      body += d;
      if (body.length > maxBytes) req.destroy();
    });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); } catch { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

/** Teto do arquivo já decodificado. O WhatsApp recusa documento acima de 100 MB,
 *  mas 16 MB cobre boleto/contrato/foto e evita segurar memória do processo. */
const MAX_ARQUIVO_BYTES = 16 * 1024 * 1024;

const txt = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Serve o HTML do painel (arquivo estático em panel/chat.html). */
function servirPainel(res: http.ServerResponse): void {
  const file = path.join(process.cwd(), 'panel', 'chat.html');
  if (!fs.existsSync(file)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('panel/chat.html não encontrado');
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}

/**
 * Rotas do painel. Retorna true se a requisição foi atendida aqui.
 *
 *   GET  /                              HTML (a tela de login é do próprio app)
 *   POST /api/login    { login, senha }
 *   POST /api/logout
 *   GET  /api/eu                        usuário da sessão
 *   GET  /api/usuarios                  (admin)
 *   POST /api/usuarios                  (admin) criar
 *   PATCH/DELETE /api/usuarios/:id      (admin) editar / remover
 *   GET  /api/conversas                 lista
 *   GET  /api/conversas/:key            detalhe + dossiê + timeline
 *   POST /api/conversas/:key/intervir | /retomar | /enviar
 */
export async function tratarPainel(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  store: ChatSessionStore,
): Promise<boolean> {
  const p = url.pathname;

  if (req.method === 'GET' && (p === '/' || p === '/painel' || p === '/painel/')) {
    servirPainel(res);
    return true;
  }

  if (!p.startsWith('/api/')) return false;

  // ── Login (única rota pública) ───────────────────────────────────────────
  if (req.method === 'POST' && p === '/api/login') {
    const body = await lerCorpo(req);
    const r = fazerLogin(txt(body.login), txt(body.senha));
    if (!r.ok) {
      json(res, 401, { erro: r.erro });
      return true;
    }
    json(res, 200, { usuario: r.usuario }, cookieSessao(r.token));
    return true;
  }

  // ── Daqui pra baixo exige sessão ─────────────────────────────────────────
  const auth = autenticar(req);
  if (!auth) {
    json(res, 401, { erro: 'nao_autenticado' });
    return true;
  }
  const eu = auth.usuario;

  if (req.method === 'POST' && p === '/api/logout') {
    encerrarSessao(auth.token);
    json(res, 200, { ok: true }, cookieLimpo());
    return true;
  }

  if (req.method === 'GET' && p === '/api/eu') {
    json(res, 200, {
      usuario: usuarioPublico(eu),
      empresa: config.company.name,
      agente: config.company.agentName,
    });
    return true;
  }

  // ── Download de documento/imagem trocado na conversa ─────────────────────
  const mArq = /^\/api\/arquivos\/([^/]+)$/.exec(p);
  if (req.method === 'GET' && mArq) {
    const arq = buscarArquivo(decodeURIComponent(mArq[1]));
    if (!arq) {
      json(res, 404, { erro: 'Arquivo não encontrado.' });
      return true;
    }
    res.writeHead(200, {
      'Content-Type': arq.mimetype,
      'Content-Length': String(arq.tamanho),
      'Content-Disposition': `inline; filename="${arq.nome.replace(/"/g, '')}"`,
      'Cache-Control': 'private, max-age=3600',
    });
    fs.createReadStream(arq.caminho).pipe(res);
    return true;
  }

  // ── Usuários (somente admin) ─────────────────────────────────────────────
  if (p === '/api/usuarios' || p.startsWith('/api/usuarios/')) {
    if (eu.papel !== 'admin') {
      json(res, 403, { erro: 'Só administradores gerenciam usuários.' });
      return true;
    }

    // Visão de supervisão: quem está online e qual conversa cada um segura agora.
    if (req.method === 'GET' && p === '/api/usuarios') {
      const online = usuariosOnline();
      const conversas = store.list();
      json(res, 200, {
        usuarios: listarUsuarios().map((u) => ({
          ...u,
          online: online.has(u.id),
          atendendo: conversas
            .filter((s) => s.modo === 'humano' && s.atendenteId === u.id)
            .map((s) => {
              const r = s.resumo();
              return {
                key: r.key,
                cliente: r.clienteNome || r.pushName || r.numero,
                numero: r.numero,
                instance: r.instance,
                desde: r.lastActivity,
              };
            }),
        })),
        semDono: conversas.filter((s) => s.modo === 'ia' && !s.encerrada).length,
      });
      return true;
    }

    if (req.method === 'POST' && p === '/api/usuarios') {
      const b = await lerCorpo(req);
      const r = criarUsuario({
        login: txt(b.login), nome: txt(b.nome), senha: txt(b.senha),
        papel: b.papel === 'admin' ? 'admin' : 'atendente',
      });
      if (!r.ok) { json(res, 400, { erro: r.erro }); return true; }
      json(res, 201, { usuario: r.usuario });
      return true;
    }

    const mU = /^\/api\/usuarios\/([^/]+)$/.exec(p);
    if (mU) {
      const id = decodeURIComponent(mU[1]);

      // Bloquear/remover alguém não pode deixar conversas presas: devolve à IA.
      const liberarConversas = (motivo: string): number => {
        let n = 0;
        for (const s of store.list()) {
          if (s.modo === 'humano' && s.atendenteId === id) { s.retomar(motivo); n++; }
        }
        return n;
      };

      if (req.method === 'PATCH') {
        const b = await lerCorpo(req);
        const bloqueando = b.ativo === false;
        const r = atualizarUsuario(id, {
          nome: txt(b.nome) || undefined,
          senha: txt(b.senha) || undefined,
          papel: (b.papel === 'admin' || b.papel === 'atendente') ? b.papel as Papel : undefined,
          ativo: typeof b.ativo === 'boolean' ? b.ativo : undefined,
        });
        if (!r.ok) { json(res, 400, { erro: r.erro }); return true; }
        const liberadas = bloqueando ? liberarConversas('O sistema') : 0;
        json(res, 200, { ok: true, conversasLiberadas: liberadas });
        return true;
      }

      if (req.method === 'DELETE') {
        if (id === eu.id) { json(res, 400, { erro: 'Você não pode remover a própria conta.' }); return true; }
        const liberadas = liberarConversas('O sistema');
        const r = removerUsuario(id);
        if (!r.ok) { json(res, 400, { erro: r.erro }); return true; }
        json(res, 200, { ok: true, conversasLiberadas: liberadas });
        return true;
      }
    }

    // Derrubar TODAS as sessões (inclusive de quem chamou) — força login geral.
    if (req.method === 'DELETE' && p === '/api/usuarios/sessoes') {
      const n = derrubarTodasSessoes();
      json(res, 200, { ok: true, sessoesEncerradas: n });
      return true;
    }

    // Derrubar as sessões de alguém sem bloquear a conta (força novo login).
    const mS = /^\/api\/usuarios\/([^/]+)\/sessoes$/.exec(p);
    if (mS && req.method === 'DELETE') {
      const id = decodeURIComponent(mS[1]);
      const n = derrubarSessoes(id);
      json(res, 200, { ok: true, sessoesEncerradas: n });
      return true;
    }

    json(res, 405, { erro: 'metodo_nao_suportado' });
    return true;
  }

  // ── Auditoria ────────────────────────────────────────────────────────────
  if (p.startsWith('/api/auditoria')) {
    if (eu.papel !== 'admin') {
      json(res, 403, { erro: 'Só administradores acessam a auditoria.' });
      return true;
    }

    const num = (v: string | null) => (v && /^\d+$/.test(v) ? Number(v) : undefined);
    const filtro = {
      de: num(url.searchParams.get('de')),
      ate: num(url.searchParams.get('ate')),
      atendenteId: url.searchParams.get('atendente') || undefined,
      busca: url.searchParams.get('busca') || undefined,
      limite: num(url.searchParams.get('limite')),
    };

    if (req.method === 'GET' && p === '/api/auditoria') {
      json(res, 200, {
        resumo: auditoriaResumo(filtro),
        conversas: auditoriaConversas(filtro),
        atendentes: listarUsuarios().map((u) => ({ id: u.id, nome: u.nome })),
      });
      return true;
    }

    const mA = /^\/api\/auditoria\/(.+)$/.exec(p);
    if (req.method === 'GET' && mA) {
      const det = conversaDetalheAuditoria(decodeURIComponent(mA[1]));
      if (!det) { json(res, 404, { erro: 'Conversa não encontrada na auditoria.' }); return true; }
      json(res, 200, det);
      return true;
    }

    json(res, 405, { erro: 'metodo_nao_suportado' });
    return true;
  }

  // ── Conversas ────────────────────────────────────────────────────────────
  if (req.method === 'GET' && p === '/api/conversas') {
    // A sessão viva é a fonte da verdade; o banco completa com as que já
    // saíram da memória mas SEGUEM ATIVAS (só descartadas por idle do processo).
    // Conversa encerrada não aparece aqui — fica só no histórico (Auditoria ou
    // pelo link direto /api/conversas/:key), pra não poluir a tela principal.
    const vivas = store.list().map((s) => s.resumo()).filter((c) => !c.encerrada);
    const chavesVivas = new Set(vivas.map((c) => c.key));
    const doBanco = conversasRecentesPainel(24 * 60 * 60 * 1000)
      .filter((c) => !c.encerrada && !chavesVivas.has(c.key))
      .map((c) => ({ ...c, instance: c.instance ?? config.whatsapp.instance }));

    json(res, 200, {
      agora: Date.now(),
      empresa: config.company.name,
      agente: config.company.agentName,
      conversas: [...vivas, ...doBanco].sort((a, b) => b.lastActivity - a.lastActivity),
    });
    return true;
  }

  // 'enviar-arquivo'/'enviar-audio' vêm antes de 'enviar' na alternância: a
  // regex é gulosa da esquerda e casaria só o prefixo, jogando o resto para
  // dentro da chave.
  const m = /^\/api\/conversas\/(.+?)(?:\/(intervir|retomar|enviar-arquivo|enviar-audio|enviar))?$/.exec(p);
  if (!m) return false;

  const key = decodeURIComponent(m[1]);
  const acao = m[2];
  // Traz de volta do banco a conversa que caiu da memória mas segue na fila,
  // senão o "Assumir" que o painel mostra devolveria 404.
  const session = store.findOuReidratarDaFila(key);

  // Conversa fora da memória (encerrada ou descartada): a leitura ainda tem de
  // funcionar — o histórico está no banco. Só as ações exigem sessão viva.
  if (!session) {
    if (req.method === 'GET' && !acao) {
      const detalhe = detalheConversaPainel(key);
      if (detalhe) {
        json(res, 200, { ...detalhe, somenteLeitura: true });
        return true;
      }
    }
    json(res, 404, {
      erro: acao
        ? 'Esta conversa já foi encerrada. Peça ao cliente para escrever de novo para reabrir o atendimento.'
        : 'Conversa não encontrada.',
    });
    return true;
  }

  if (req.method === 'GET' && !acao) {
    json(res, 200, session.detalhe());
    return true;
  }

  /** Só quem assumiu (ou um admin) pode escrever/devolver. */
  const podeAgir = () =>
    !session.atendenteId || session.atendenteId === eu.id || eu.papel === 'admin';

  if (req.method === 'POST' && acao === 'intervir') {
    // Admin pode tomar a conversa de outra atendente; atendente comum, não.
    if (session.modo === 'humano' && session.atendenteId !== eu.id && eu.papel !== 'admin') {
      json(res, 409, { erro: `${session.atendenteNome} já está atendendo esta conversa.` });
      return true;
    }
    const r = session.intervir({ id: eu.id, nome: eu.nome });
    if (!r.ok) {
      json(res, 409, {
        erro: 'A IA ainda está conduzindo este atendimento — só dá pra assumir depois que ela transferir.',
      });
      return true;
    }
    json(res, 200, { ok: true, modo: session.modo });
    return true;
  }

  if (req.method === 'POST' && acao === 'retomar') {
    if (!podeAgir()) {
      json(res, 409, { erro: `Quem está com esta conversa é ${session.atendenteNome}.` });
      return true;
    }
    session.retomar(eu.nome);
    json(res, 200, { ok: true, modo: session.modo });
    return true;
  }

  if (req.method === 'POST' && acao === 'enviar') {
    if (!podeAgir()) {
      json(res, 409, { erro: `Quem está com esta conversa é ${session.atendenteNome}.` });
      return true;
    }
    const body = await lerCorpo(req);
    const r = await session.enviarComoAtendente(txt(body.texto), eu.nome);
    if (!r.enviado) {
      logger.warn('[painel] falha ao enviar mensagem da atendente', { key, motivo: r.motivo });
      json(res, 400, { ok: false, erro: motivoLegivel(r.motivo) });
      return true;
    }
    json(res, 200, { ok: true });
    return true;
  }

  if (req.method === 'POST' && acao === 'enviar-arquivo') {
    if (!podeAgir()) {
      json(res, 409, { erro: `Quem está com esta conversa é ${session.atendenteNome}.` });
      return true;
    }
    // base64 infla ~33%; a folga cobre o envelope JSON e o nome do arquivo.
    const body = await lerCorpo(req, Math.ceil(MAX_ARQUIVO_BYTES * 1.4));
    const nome = txt(body.nome).trim() || 'arquivo';
    const mimetype = txt(body.mimetype).trim() || 'application/octet-stream';
    const legenda = txt(body.legenda).trim();
    const base64 = txt(body.base64);

    if (!base64) {
      json(res, 400, { ok: false, erro: 'Selecione um arquivo antes de enviar.' });
      return true;
    }

    const buffer = Buffer.from(base64, 'base64');
    if (!buffer.length) {
      json(res, 400, { ok: false, erro: 'Não consegui ler esse arquivo. Tente outro.' });
      return true;
    }
    if (buffer.length > MAX_ARQUIVO_BYTES) {
      json(res, 413, { ok: false, erro: 'Arquivo muito grande. O limite é 16 MB.' });
      return true;
    }

    const r = await session.enviarArquivoComoAtendente({ nome, mimetype, buffer, legenda }, eu.nome);
    if (!r.enviado) {
      logger.warn('[painel] falha ao enviar arquivo', { key, nome, motivo: r.motivo });
      json(res, 400, { ok: false, erro: motivoLegivel(r.motivo) });
      return true;
    }
    logger.info('[painel] arquivo enviado', { key, nome, bytes: buffer.length, por: eu.nome });
    json(res, 200, { ok: true });
    return true;
  }

  if (req.method === 'POST' && acao === 'enviar-audio') {
    if (!podeAgir()) {
      json(res, 409, { erro: `Quem está com esta conversa é ${session.atendenteNome}.` });
      return true;
    }
    const MAX_AUDIO_BYTES = 8 * 1024 * 1024;                   // mensagem de voz não passa disso
    const body = await lerCorpo(req, Math.ceil(MAX_AUDIO_BYTES * 1.4));
    const base64 = txt(body.base64);
    if (!base64) {
      json(res, 400, { ok: false, erro: 'Gravação vazia. Tente de novo.' });
      return true;
    }

    const bruto = Buffer.from(base64, 'base64');
    if (!bruto.length) {
      json(res, 400, { ok: false, erro: 'Não consegui ler essa gravação. Tente de novo.' });
      return true;
    }
    if (bruto.length > MAX_AUDIO_BYTES) {
      json(res, 413, { ok: false, erro: 'Áudio muito longo. Grave uma mensagem mais curta.' });
      return true;
    }

    // O navegador grava em webm/opus (ou mp4/aac no Safari) — WhatsApp só
    // reconhece OGG/Opus como mensagem de voz nativa.
    const ogg = paraOggOpus(bruto);
    if (!ogg) {
      json(res, 500, { ok: false, erro: 'Não consegui converter o áudio. Tente gravar de novo.' });
      return true;
    }

    const r = await session.enviarArquivoComoAtendente(
      { nome: 'audio.ogg', mimetype: 'audio/ogg', buffer: ogg },
      eu.nome,
    );
    if (!r.enviado) {
      logger.warn('[painel] falha ao enviar áudio', { key, motivo: r.motivo });
      json(res, 400, { ok: false, erro: motivoLegivel(r.motivo) });
      return true;
    }
    logger.info('[painel] áudio enviado', { key, bytes: ogg.length, por: eu.nome });
    json(res, 200, { ok: true });
    return true;
  }

  json(res, 405, { erro: 'metodo_nao_suportado' });
  return true;
}

function motivoLegivel(motivo?: string): string {
  switch (motivo) {
    case 'texto_vazio': return 'Escreva uma mensagem antes de enviar.';
    case 'modo_ia': return 'A IA voltou a conduzir. Clique em Interferir para assumir de novo.';
    case 'numero_sem_whatsapp': return 'Este número não tem WhatsApp.';
    case 'nao_configurado': return 'A integração com o WhatsApp não está configurada.';
    case 'arquivo_vazio': return 'Selecione um arquivo antes de enviar.';
    case 'falha_upload': return 'Não consegui subir o arquivo para o WhatsApp. Tente novamente.';
    case 'upload_sem_id': return 'O WhatsApp aceitou o arquivo mas não devolveu o identificador. Tente novamente.';
    case 'fora_da_janela_24h':
      return 'Passaram-se mais de 24h desde a última mensagem do cliente. '
        + 'O WhatsApp só permite retomar com modelo aprovado — peça para o cliente escrever primeiro.';
    default: return 'O WhatsApp não aceitou a mensagem. Tente novamente.';
  }
}
