// Rotas da camada administrativa (Bloco 6): configuração, permissões, modelos
// e auditoria. Toda escrita grava quem fez e o valor anterior.

import axios from 'axios';
import { config } from '../config';
import { Rota, json, lerJson, ator, ErroHttp } from './http-util';
import { db, registrarAuditoria } from './store/db';
import { listar, definir, restaurar, DEFINICOES, ChaveConfig } from './config-dinamica';
import { paraJid } from '../integrations/evolution';
import { FONTES, FonteId } from './types';

// ─── Modelos liberados no projeto OpenAI ────────────────────────────────────

let cacheModelos: { em: number; ids: string[] } | null = null;

/**
 * Modelos que o projeto OpenAI realmente libera. Existe porque a allowlist da
 * casa é restrita (gpt-4o e whisper-1 dão 403): trocar o modelo pelo painel
 * para um fora da lista derrubaria TODAS as respostas até alguém perceber.
 */
async function modelosLiberados(): Promise<string[] | null> {
  if (cacheModelos && Date.now() - cacheModelos.em < 60 * 60_000) return cacheModelos.ids;
  try {
    const r = await axios.get<{ data: Array<{ id: string }> }>('https://api.openai.com/v1/models', {
      timeout: 15_000,
      headers: { Authorization: `Bearer ${config.openai.apiKey}` },
    });
    cacheModelos = { em: Date.now(), ids: r.data.data.map((m) => m.id).sort() };
    return cacheModelos.ids;
  } catch {
    return null;
  }
}

/** Serve para chat com ferramentas: exclui áudio, imagem, realtime, transcrição e TTS. */
function ehModeloDeChat(id: string): boolean {
  return /^(gpt|o\d)/.test(id) && !/realtime|audio|image|transcribe|tts|whisper|embedding|translate/i.test(id);
}

// ─── Permissões ─────────────────────────────────────────────────────────────

interface LinhaPermissao {
  usuario: string;
  nome: string | null;
  papel: string;
  fontes: string | null;
  equipe: string | null;
  ativo: number;
  criado_em: string;
}

interface LinhaEquipe {
  id: string;
  nome: string;
  fontes: string | null;
  ativo: number;
  criado_em: string;
}

function equipeSaida(l: LinhaEquipe, membros = 0) {
  let fontes: FonteId[] | null = null;
  try { fontes = l.fontes ? JSON.parse(l.fontes) : null; } catch { fontes = null; }
  return { ...l, ativo: l.ativo === 1, fontes, membros };
}

/** "Suporte N2" → "suporte-n2". */
function slug(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
}

function validarEquipe(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  const id = String(v);
  if (!db().prepare(`SELECT 1 FROM equipe WHERE id = ?`).get(id)) throw new ErroHttp(400, `equipe inexistente: ${id}`);
  return id;
}

const PAPEIS = ['tecnico', 'noc', 'supervisor', 'admin'];

/** Número de WhatsApp vira JID; login de painel fica como veio. */
function normalizarUsuario(u: string): string {
  const s = String(u ?? '').trim();
  if (!s) throw new ErroHttp(400, 'usuário vazio');
  if (s.includes('@') || /^painel:/.test(s)) return s;
  const digitos = s.replace(/\D/g, '');
  if (digitos.length >= 10) return paraJid(digitos);
  throw new ErroHttp(400, 'usuário precisa ser um celular com DDD ou um login "painel:nome"');
}

function validarFontes(v: unknown): FonteId[] | null {
  if (v === null || v === undefined) return null;
  if (!Array.isArray(v)) throw new ErroHttp(400, 'fontes precisa ser uma lista (ou null para todas)');
  const invalidas = v.filter((f) => !FONTES.includes(f as FonteId));
  if (invalidas.length) throw new ErroHttp(400, `fontes inválidas: ${invalidas.join(', ')}`);
  return v as FonteId[];
}

function paraSaida(l: LinhaPermissao) {
  let fontes: FonteId[] | null = null;
  try { fontes = l.fontes ? JSON.parse(l.fontes) : null; } catch { fontes = null; }
  return { ...l, ativo: l.ativo === 1, fontes };
}

// ─── Rotas ──────────────────────────────────────────────────────────────────

export const rotasAdmin: Rota = async (req, res, url, p) => {
  // ── Configuração dinâmica ─────────────────────────────────────────────────
  if (req.method === 'GET' && p === '/api/config') {
    json(res, 200, { itens: listar() });
    return true;
  }

  const mCfg = p.match(/^\/api\/config\/([a-z0-9_.]+)$/);
  if (mCfg && (req.method === 'PUT' || req.method === 'DELETE')) {
    const chave = mCfg[1];
    if (!(chave in DEFINICOES)) throw new ErroHttp(404, `configuração desconhecida: ${chave}`);

    if (req.method === 'DELETE') {
      restaurar(chave as ChaveConfig, ator(req));
      json(res, 200, { ok: true, restaurado: true });
      return true;
    }

    const corpo = await lerJson<{ valor?: unknown }>(req);
    let aviso: string | null = null;

    if (chave === 'ia.modelo') {
      const ids = await modelosLiberados();
      const pedido = String(corpo.valor ?? '').trim();
      if (ids && !ids.includes(pedido)) {
        throw new ErroHttp(400,
          `o modelo "${pedido}" não está liberado no projeto OpenAI. Liberados para chat: ` +
          ids.filter(ehModeloDeChat).join(', '));
      }
      if (!ids) aviso = 'não consegui confirmar na OpenAI se o modelo está liberado — salvo mesmo assim';
    }

    try {
      const valor = definir(chave as ChaveConfig, corpo.valor, ator(req));
      json(res, 200, { ok: true, valor, aviso });
    } catch (err) {
      throw new ErroHttp(400, err instanceof Error ? err.message : String(err));
    }
    return true;
  }

  if (req.method === 'GET' && p === '/api/modelos') {
    const ids = await modelosLiberados();
    json(res, ids ? 200 : 502, ids
      ? { chat: ids.filter(ehModeloDeChat), todos: ids }
      : { error: 'não consegui consultar os modelos na OpenAI' });
    return true;
  }

  // ── Permissões ────────────────────────────────────────────────────────────
  if (req.method === 'GET' && p === '/api/permissoes') {
    const linhas = db().prepare(`SELECT * FROM permissao ORDER BY ativo DESC, nome`).all() as LinhaPermissao[];
    json(res, 200, {
      permissoes: linhas.map(paraSaida),
      // O .env continua valendo para quem não tem cadastro: o painel precisa mostrar.
      autorizados_pelo_env: config.evolutionTecnicos.autorizados,
      papeis: PAPEIS,
      fontes: FONTES,
      equipes: (db().prepare(`SELECT * FROM equipe ORDER BY nome`).all() as LinhaEquipe[]).map((e) => equipeSaida(e)),
    });
    return true;
  }

  // ── Equipes ───────────────────────────────────────────────────────────────
  if (req.method === 'GET' && p === '/api/equipes') {
    const linhas = db().prepare(
      `SELECT e.*, (SELECT COUNT(*) FROM permissao p WHERE p.equipe = e.id) membros FROM equipe e ORDER BY e.nome`,
    ).all() as Array<LinhaEquipe & { membros: number }>;
    json(res, 200, { equipes: linhas.map((l) => equipeSaida(l, l.membros)), fontes: FONTES });
    return true;
  }

  if (req.method === 'POST' && p === '/api/equipes') {
    const b = await lerJson<{ nome?: string; fontes?: unknown; ativo?: boolean }>(req);
    const nome = String(b.nome ?? '').trim();
    if (!nome) throw new ErroHttp(400, 'nome da equipe vazio');
    const id = slug(nome);
    if (!id) throw new ErroHttp(400, 'nome da equipe precisa ter letras ou números');
    if (db().prepare(`SELECT 1 FROM equipe WHERE id = ?`).get(id)) throw new ErroHttp(409, 'já existe equipe com esse nome');
    const fontes = validarFontes(b.fontes);
    db().prepare(`INSERT INTO equipe (id, nome, fontes, ativo, criado_em) VALUES (?,?,?,?,?)`)
      .run(id, nome, fontes ? JSON.stringify(fontes) : null, b.ativo === false ? 0 : 1, new Date().toISOString());
    registrarAuditoria(ator(req), 'equipe.criar', id, undefined, { nome, fontes, ativo: b.ativo !== false });
    json(res, 201, { ok: true, id });
    return true;
  }

  const mEq = p.match(/^\/api\/equipes\/([^/]+)$/);
  if (mEq && (req.method === 'PUT' || req.method === 'DELETE')) {
    const id = decodeURIComponent(mEq[1]);
    const antes = db().prepare(`SELECT * FROM equipe WHERE id = ?`).get(id) as LinhaEquipe | undefined;
    if (!antes) throw new ErroHttp(404, 'equipe não encontrada');

    if (req.method === 'DELETE') {
      const membros = (db().prepare(`SELECT COUNT(*) n FROM permissao WHERE equipe = ?`).get(id) as { n: number }).n;
      if (membros) throw new ErroHttp(409, `a equipe tem ${membros} membro(s); mova-os antes de remover`);
      db().prepare(`DELETE FROM equipe WHERE id = ?`).run(id);
      registrarAuditoria(ator(req), 'equipe.remover', id, equipeSaida(antes), undefined);
      json(res, 200, { ok: true });
      return true;
    }

    const b = await lerJson<{ nome?: string; fontes?: unknown; ativo?: boolean }>(req);
    const fontes = b.fontes !== undefined ? validarFontes(b.fontes) : undefined;
    db().prepare(`UPDATE equipe SET nome = ?, fontes = ?, ativo = ? WHERE id = ?`).run(
      b.nome !== undefined && b.nome.trim() ? b.nome.trim() : antes.nome,
      fontes !== undefined ? (fontes ? JSON.stringify(fontes) : null) : antes.fontes,
      b.ativo !== undefined ? (b.ativo ? 1 : 0) : antes.ativo,
      id,
    );
    const depois = db().prepare(`SELECT * FROM equipe WHERE id = ?`).get(id) as LinhaEquipe;
    registrarAuditoria(ator(req), 'equipe.editar', id, equipeSaida(antes), equipeSaida(depois));
    json(res, 200, { ok: true, equipe: equipeSaida(depois) });
    return true;
  }

  if (req.method === 'POST' && p === '/api/permissoes') {
    const b = await lerJson<{ usuario?: string; nome?: string; papel?: string; fontes?: unknown; equipe?: unknown; ativo?: boolean }>(req);
    const usuario = normalizarUsuario(b.usuario ?? '');
    const equipe = validarEquipe(b.equipe);
    const papel = b.papel ?? 'tecnico';
    if (!PAPEIS.includes(papel)) throw new ErroHttp(400, `papel inválido; use ${PAPEIS.join(', ')}`);
    const fontes = validarFontes(b.fontes);

    const existe = db().prepare(`SELECT 1 FROM permissao WHERE usuario = ?`).get(usuario);
    if (existe) throw new ErroHttp(409, 'usuário já cadastrado; edite em vez de criar');

    db().prepare(
      `INSERT INTO permissao (usuario, nome, papel, fontes, equipe, ativo, criado_em) VALUES (?,?,?,?,?,?,?)`,
    ).run(usuario, b.nome?.trim() || null, papel, fontes ? JSON.stringify(fontes) : null, equipe,
      b.ativo === false ? 0 : 1, new Date().toISOString());
    registrarAuditoria(ator(req), 'permissao.criar', usuario, undefined, { nome: b.nome, papel, fontes, equipe, ativo: b.ativo !== false });

    json(res, 201, { ok: true, usuario });
    return true;
  }

  const mPerm = p.match(/^\/api\/permissoes\/(.+)$/);
  if (mPerm && (req.method === 'PUT' || req.method === 'DELETE')) {
    const usuario = decodeURIComponent(mPerm[1]);
    const antes = db().prepare(`SELECT * FROM permissao WHERE usuario = ?`).get(usuario) as LinhaPermissao | undefined;
    if (!antes) throw new ErroHttp(404, 'usuário não cadastrado');

    if (req.method === 'DELETE') {
      db().prepare(`DELETE FROM permissao WHERE usuario = ?`).run(usuario);
      registrarAuditoria(ator(req), 'permissao.remover', usuario, paraSaida(antes), undefined);
      json(res, 200, { ok: true });
      return true;
    }

    const b = await lerJson<{ nome?: string; papel?: string; fontes?: unknown; equipe?: unknown; ativo?: boolean }>(req);
    const equipe = b.equipe !== undefined ? validarEquipe(b.equipe) : undefined;
    if (b.papel !== undefined && !PAPEIS.includes(b.papel)) throw new ErroHttp(400, `papel inválido; use ${PAPEIS.join(', ')}`);
    const fontes = b.fontes !== undefined ? validarFontes(b.fontes) : undefined;

    db().prepare(
      `UPDATE permissao SET nome = ?, papel = ?, fontes = ?, equipe = ?, ativo = ? WHERE usuario = ?`,
    ).run(
      b.nome !== undefined ? (b.nome.trim() || null) : antes.nome,
      b.papel ?? antes.papel,
      fontes !== undefined ? (fontes ? JSON.stringify(fontes) : null) : antes.fontes,
      equipe !== undefined ? equipe : antes.equipe,
      b.ativo !== undefined ? (b.ativo ? 1 : 0) : antes.ativo,
      usuario,
    );
    const depois = db().prepare(`SELECT * FROM permissao WHERE usuario = ?`).get(usuario) as LinhaPermissao;
    registrarAuditoria(ator(req), 'permissao.editar', usuario, paraSaida(antes), paraSaida(depois));
    json(res, 200, { ok: true, permissao: paraSaida(depois) });
    return true;
  }

  // ── Auditoria com filtros ─────────────────────────────────────────────────
  if (req.method === 'GET' && p === '/api/auditoria/busca') {
    const cond: string[] = [];
    const params: unknown[] = [];
    const acao = url.searchParams.get('acao');
    const quem = url.searchParams.get('ator');
    const alvo = url.searchParams.get('alvo');
    if (acao) { cond.push('acao LIKE ?'); params.push(`${acao}%`); }
    if (quem) { cond.push('ator LIKE ?'); params.push(`%${quem}%`); }
    if (alvo) { cond.push('alvo LIKE ?'); params.push(`%${alvo}%`); }
    const limite = Math.min(500, Number(url.searchParams.get('limite')) || 100);
    const linhas = db().prepare(
      `SELECT * FROM auditoria ${cond.length ? `WHERE ${cond.join(' AND ')}` : ''} ORDER BY at DESC LIMIT ?`,
    ).all(...params, limite);
    json(res, 200, { registros: linhas });
    return true;
  }

  return false;
};
