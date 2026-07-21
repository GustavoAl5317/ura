// Autenticação do painel: usuários com senha (scrypt), sessões e papéis.
// Persistido em SQLite — as sessões sobrevivem a um restart do serviço.

import crypto from 'crypto';
import http from 'http';
import { config } from '../config';
import { logger } from '../logger';
import { db, limparSessoesExpiradas } from './db';

export type Papel = 'admin' | 'atendente';

export interface Usuario {
  id: string;
  login: string;
  nome: string;
  papel: Papel;
  senhaHash: string;
  ativo: boolean;
  criadoEm: number;
  ultimoAcesso?: number | null;
}

const SESSAO_HORAS = 12;
const COOKIE = 'atendimento_sess';

// ── Senha ──────────────────────────────────────────────────────────────────

function hashSenha(senha: string): string {
  const salt = crypto.randomBytes(16);
  return `${salt.toString('hex')}:${crypto.scryptSync(senha, salt, 64).toString('hex')}`;
}

function conferirSenha(senha: string, armazenado: string): boolean {
  const [saltHex, hashHex] = armazenado.split(':');
  if (!saltHex || !hashHex) return false;
  try {
    const dk = crypto.scryptSync(senha, Buffer.from(saltHex, 'hex'), 64);
    const esperado = Buffer.from(hashHex, 'hex');
    return dk.length === esperado.length && crypto.timingSafeEqual(dk, esperado);
  } catch {
    return false;
  }
}

// ── Mapeamento ─────────────────────────────────────────────────────────────

function linhaParaUsuario(r: Record<string, unknown>): Usuario {
  return {
    id: String(r.id),
    login: String(r.login),
    nome: String(r.nome),
    papel: r.papel === 'admin' ? 'admin' : 'atendente',
    senhaHash: String(r.senha_hash),
    ativo: Number(r.ativo) === 1,
    criadoEm: Number(r.criado_em),
    ultimoAcesso: r.ultimo_acesso == null ? null : Number(r.ultimo_acesso),
  };
}

const publico = (u: Usuario) => ({
  id: u.id, login: u.login, nome: u.nome, papel: u.papel,
  ativo: u.ativo, criadoEm: u.criadoEm, ultimoAcesso: u.ultimoAcesso ?? null,
});

function porId(id: string): Usuario | null {
  const r = db().prepare('SELECT * FROM usuarios WHERE id = ?').get(id);
  return r ? linhaParaUsuario(r) : null;
}

function porLogin(login: string): Usuario | null {
  const r = db().prepare('SELECT * FROM usuarios WHERE login = ?').get(login);
  return r ? linhaParaUsuario(r) : null;
}

// ── Primeiro acesso ────────────────────────────────────────────────────────

/** Garante que exista um administrador para o primeiro login. */
export function initAuth(): void {
  const { n } = db().prepare('SELECT COUNT(*) AS n FROM usuarios').get() as { n: number };
  if (n > 0) return;

  const login = config.chat.adminUser || 'admin';
  const senha = config.chat.adminPass || crypto.randomBytes(6).toString('hex');
  db().prepare(
    `INSERT INTO usuarios (id, login, nome, papel, senha_hash, ativo, criado_em)
     VALUES (?, ?, ?, 'admin', ?, 1, ?)`,
  ).run(crypto.randomUUID(), login, 'Administrador', hashSenha(senha), Date.now());

  logger.info('══════════════════════════════════════════');
  logger.info('  Painel: usuário administrador criado');
  logger.info(`  Login : ${login}`);
  logger.info(config.chat.adminPass
    ? '  Senha : (a definida em CHAT_ADMIN_PASS)'
    : `  Senha : ${senha}   ← anote, só aparece agora`);
  logger.info('══════════════════════════════════════════');
}

// ── Usuários ───────────────────────────────────────────────────────────────

export function listarUsuarios() {
  return db().prepare('SELECT * FROM usuarios ORDER BY nome')
    .all().map((r) => publico(linhaParaUsuario(r)));
}

export function criarUsuario(dados: {
  login: string; nome: string; senha: string; papel?: Papel;
}): { ok: true; usuario: ReturnType<typeof publico> } | { ok: false; erro: string } {
  const login = dados.login?.trim().toLowerCase();
  const nome = dados.nome?.trim();
  const senha = dados.senha ?? '';

  if (!login || login.length < 3) return { ok: false, erro: 'O login precisa de pelo menos 3 caracteres.' };
  if (!nome) return { ok: false, erro: 'Informe o nome da atendente.' };
  if (senha.length < 6) return { ok: false, erro: 'A senha precisa de pelo menos 6 caracteres.' };
  if (porLogin(login)) return { ok: false, erro: 'Já existe alguém com esse login.' };

  const u: Usuario = {
    id: crypto.randomUUID(), login, nome,
    papel: dados.papel === 'admin' ? 'admin' : 'atendente',
    senhaHash: hashSenha(senha), ativo: true, criadoEm: Date.now(),
  };
  db().prepare(
    `INSERT INTO usuarios (id, login, nome, papel, senha_hash, ativo, criado_em)
     VALUES (?, ?, ?, ?, ?, 1, ?)`,
  ).run(u.id, u.login, u.nome, u.papel, u.senhaHash, u.criadoEm);

  logger.info(`[painel] usuário criado: ${login} (${u.papel})`);
  return { ok: true, usuario: publico(u) };
}

export function atualizarUsuario(id: string, dados: {
  nome?: string; senha?: string; papel?: Papel; ativo?: boolean;
}): { ok: true } | { ok: false; erro: string } {
  const u = porId(id);
  if (!u) return { ok: false, erro: 'Usuário não encontrado.' };

  if (dados.senha !== undefined && dados.senha.length < 6) {
    return { ok: false, erro: 'A senha precisa de pelo menos 6 caracteres.' };
  }
  if (dados.ativo === false || dados.papel === 'atendente') {
    // Não pode ficar sem nenhum admin ativo.
    const { n } = db().prepare(
      "SELECT COUNT(*) AS n FROM usuarios WHERE papel = 'admin' AND ativo = 1 AND id <> ?",
    ).get(id) as { n: number };
    if (u.papel === 'admin' && u.ativo && n === 0) {
      return { ok: false, erro: 'Este é o único administrador ativo — promova outro antes.' };
    }
  }

  const nome = dados.nome?.trim() || u.nome;
  const papel = dados.papel ?? u.papel;
  const ativo = typeof dados.ativo === 'boolean' ? dados.ativo : u.ativo;
  const hash = dados.senha ? hashSenha(dados.senha) : u.senhaHash;

  db().prepare(
    'UPDATE usuarios SET nome = ?, papel = ?, senha_hash = ?, ativo = ? WHERE id = ?',
  ).run(nome, papel, hash, ativo ? 1 : 0, id);

  // Troca de senha ou bloqueio derrubam as sessões abertas.
  if (dados.senha || ativo === false) derrubarSessoes(id);
  return { ok: true };
}

export function removerUsuario(id: string): { ok: true } | { ok: false; erro: string } {
  const u = porId(id);
  if (!u) return { ok: false, erro: 'Usuário não encontrado.' };
  const { n } = db().prepare(
    "SELECT COUNT(*) AS n FROM usuarios WHERE papel = 'admin' AND ativo = 1 AND id <> ?",
  ).get(id) as { n: number };
  if (u.papel === 'admin' && n === 0) {
    return { ok: false, erro: 'Este é o único administrador — crie outro antes de remover.' };
  }
  derrubarSessoes(id);
  db().prepare('DELETE FROM usuarios WHERE id = ?').run(id);
  return { ok: true };
}

// ── Sessões ────────────────────────────────────────────────────────────────

export function login(loginTxt: string, senha: string):
  | { ok: true; token: string; usuario: ReturnType<typeof publico> }
  | { ok: false; erro: string } {
  const u = porLogin(String(loginTxt ?? '').trim().toLowerCase());
  // Mesma resposta para login inexistente ou senha errada.
  if (!u || !conferirSenha(String(senha ?? ''), u.senhaHash)) {
    return { ok: false, erro: 'Login ou senha incorretos.' };
  }
  if (!u.ativo) return { ok: false, erro: 'Este acesso está desativado. Fale com o administrador.' };

  const token = crypto.randomBytes(32).toString('hex');
  const agora = Date.now();
  db().prepare('INSERT INTO sessoes (token, user_id, expira_em) VALUES (?, ?, ?)')
    .run(token, u.id, agora + SESSAO_HORAS * 3600_000);
  db().prepare('UPDATE usuarios SET ultimo_acesso = ? WHERE id = ?').run(agora, u.id);

  logger.info(`[painel] login: ${u.login}`);
  return { ok: true, token, usuario: publico({ ...u, ultimoAcesso: agora }) };
}

export function logout(token?: string): void {
  if (token) db().prepare('DELETE FROM sessoes WHERE token = ?').run(token);
}

/** IDs de usuários com sessão válida agora. */
export function usuariosOnline(): Set<string> {
  const rows = db().prepare('SELECT DISTINCT user_id FROM sessoes WHERE expira_em > ?').all(Date.now());
  return new Set(rows.map((r) => String(r.user_id)));
}

/** Derruba todas as sessões de um usuário (bloqueio imediato). */
export function derrubarSessoes(userId: string): number {
  return db().prepare('DELETE FROM sessoes WHERE user_id = ?').run(userId).changes;
}

function lerCookie(req: http.IncomingMessage): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const parte of raw.split(';')) {
    const [k, ...v] = parte.trim().split('=');
    if (k === COOKIE) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

export interface Autenticado { token: string; usuario: Usuario }

export function autenticar(req: http.IncomingMessage): Autenticado | null {
  const token = lerCookie(req);
  if (!token) return null;
  const s = db().prepare('SELECT * FROM sessoes WHERE token = ?').get(token);
  if (!s) return null;
  if (Number(s.expira_em) < Date.now()) {
    db().prepare('DELETE FROM sessoes WHERE token = ?').run(token);
    return null;
  }
  const u = porId(String(s.user_id));
  if (!u || !u.ativo) {
    db().prepare('DELETE FROM sessoes WHERE token = ?').run(token);
    return null;
  }
  return { token, usuario: u };
}

export function cookieSessao(token: string): string {
  return `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSAO_HORAS * 3600}`;
}

export function cookieLimpo(): string {
  return `${COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`;
}

export const usuarioPublico = publico;

setInterval(() => { try { limparSessoesExpiradas(); } catch { /* banco fechado */ } }, 600_000).unref?.();
