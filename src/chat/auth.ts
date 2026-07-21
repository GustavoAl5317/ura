// Autenticação do painel de atendimento: usuários com senha (scrypt), sessões
// por cookie e papéis (admin / atendente). Sem dependências externas — usa o
// crypto do Node e um arquivo JSON em data/ (fora do git).

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import http from 'http';
import { config } from '../config';
import { logger } from '../logger';

export type Papel = 'admin' | 'atendente';

export interface Usuario {
  id: string;
  login: string;
  nome: string;
  papel: Papel;
  senhaHash: string;   // scrypt: salt:hash (hex)
  ativo: boolean;
  criadoEm: number;
  ultimoAcesso?: number;
}

export interface Sessao {
  token: string;
  userId: string;
  expiraEm: number;
}

const ARQUIVO = path.join(process.cwd(), 'data', 'chat-usuarios.json');
const SESSAO_HORAS = 12;
const COOKIE = 'atendimento_sess';

let usuarios: Usuario[] = [];
const sessoes = new Map<string, Sessao>();

// ── Senha ──────────────────────────────────────────────────────────────────

function hashSenha(senha: string): string {
  const salt = crypto.randomBytes(16);
  const dk = crypto.scryptSync(senha, salt, 64);
  return `${salt.toString('hex')}:${dk.toString('hex')}`;
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

// ── Persistência ───────────────────────────────────────────────────────────

function salvar(): void {
  try {
    fs.mkdirSync(path.dirname(ARQUIVO), { recursive: true });
    fs.writeFileSync(ARQUIVO, JSON.stringify(usuarios, null, 2), 'utf8');
  } catch (err) {
    logger.error('[painel] falha ao salvar usuários', { err: String(err) });
  }
}

function carregar(): void {
  try {
    if (fs.existsSync(ARQUIVO)) {
      usuarios = JSON.parse(fs.readFileSync(ARQUIVO, 'utf8'));
    }
  } catch (err) {
    logger.error('[painel] falha ao ler usuários — começando vazio', { err: String(err) });
    usuarios = [];
  }
}

/** Carrega os usuários e garante que exista um admin para o primeiro acesso. */
export function initAuth(): void {
  carregar();
  if (usuarios.length) return;

  const login = config.chat.adminUser || 'admin';
  const senha = config.chat.adminPass || crypto.randomBytes(6).toString('hex');
  usuarios = [{
    id: crypto.randomUUID(),
    login,
    nome: 'Administrador',
    papel: 'admin',
    senhaHash: hashSenha(senha),
    ativo: true,
    criadoEm: Date.now(),
  }];
  salvar();

  logger.info('══════════════════════════════════════════');
  logger.info('  Painel: usuário administrador criado');
  logger.info(`  Login : ${login}`);
  logger.info(config.chat.adminPass
    ? '  Senha : (a definida em CHAT_ADMIN_PASS)'
    : `  Senha : ${senha}   ← anote, só aparece agora`);
  logger.info('══════════════════════════════════════════');
}

// ── Usuários ───────────────────────────────────────────────────────────────

const publico = (u: Usuario) => ({
  id: u.id, login: u.login, nome: u.nome, papel: u.papel,
  ativo: u.ativo, criadoEm: u.criadoEm, ultimoAcesso: u.ultimoAcesso ?? null,
});

export function listarUsuarios() {
  return usuarios.map(publico);
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
  if (usuarios.some((u) => u.login === login)) return { ok: false, erro: 'Já existe alguém com esse login.' };

  const u: Usuario = {
    id: crypto.randomUUID(),
    login,
    nome,
    papel: dados.papel === 'admin' ? 'admin' : 'atendente',
    senhaHash: hashSenha(senha),
    ativo: true,
    criadoEm: Date.now(),
  };
  usuarios.push(u);
  salvar();
  logger.info(`[painel] usuário criado: ${login} (${u.papel})`);
  return { ok: true, usuario: publico(u) };
}

export function atualizarUsuario(id: string, dados: {
  nome?: string; senha?: string; papel?: Papel; ativo?: boolean;
}): { ok: true } | { ok: false; erro: string } {
  const u = usuarios.find((x) => x.id === id);
  if (!u) return { ok: false, erro: 'Usuário não encontrado.' };

  if (dados.nome?.trim()) u.nome = dados.nome.trim();
  if (dados.papel) u.papel = dados.papel === 'admin' ? 'admin' : 'atendente';
  if (typeof dados.ativo === 'boolean') u.ativo = dados.ativo;
  if (dados.senha) {
    if (dados.senha.length < 6) return { ok: false, erro: 'A senha precisa de pelo menos 6 caracteres.' };
    u.senhaHash = hashSenha(dados.senha);
    // Derruba as sessões abertas desse usuário.
    for (const [t, s] of sessoes) if (s.userId === id) sessoes.delete(t);
  }
  if (u.ativo === false) {
    for (const [t, s] of sessoes) if (s.userId === id) sessoes.delete(t);
  }
  salvar();
  return { ok: true };
}

export function removerUsuario(id: string): { ok: true } | { ok: false; erro: string } {
  const u = usuarios.find((x) => x.id === id);
  if (!u) return { ok: false, erro: 'Usuário não encontrado.' };
  const admins = usuarios.filter((x) => x.papel === 'admin' && x.ativo);
  if (u.papel === 'admin' && admins.length <= 1) {
    return { ok: false, erro: 'Este é o único administrador — crie outro antes de remover.' };
  }
  usuarios = usuarios.filter((x) => x.id !== id);
  for (const [t, s] of sessoes) if (s.userId === id) sessoes.delete(t);
  salvar();
  return { ok: true };
}

// ── Sessões ────────────────────────────────────────────────────────────────

export function login(loginTxt: string, senha: string): { ok: true; token: string; usuario: ReturnType<typeof publico> } | { ok: false; erro: string } {
  const u = usuarios.find((x) => x.login === String(loginTxt ?? '').trim().toLowerCase());
  // Mesma mensagem para login inexistente ou senha errada (não entrega quem existe).
  if (!u || !conferirSenha(String(senha ?? ''), u.senhaHash)) {
    return { ok: false, erro: 'Login ou senha incorretos.' };
  }
  if (!u.ativo) return { ok: false, erro: 'Este acesso está desativado. Fale com o administrador.' };

  const token = crypto.randomBytes(32).toString('hex');
  sessoes.set(token, { token, userId: u.id, expiraEm: Date.now() + SESSAO_HORAS * 3600_000 });
  u.ultimoAcesso = Date.now();
  salvar();
  logger.info(`[painel] login: ${u.login}`);
  return { ok: true, token, usuario: publico(u) };
}

export function logout(token?: string): void {
  if (token) sessoes.delete(token);
}

/** IDs de usuários com sessão válida agora (para o painel mostrar quem está online). */
export function usuariosOnline(): Set<string> {
  const agora = Date.now();
  const ids = new Set<string>();
  for (const s of sessoes.values()) if (s.expiraEm > agora) ids.add(s.userId);
  return ids;
}

/** Derruba todas as sessões de um usuário (bloqueio imediato). */
export function derrubarSessoes(userId: string): number {
  let n = 0;
  for (const [t, s] of sessoes) if (s.userId === userId) { sessoes.delete(t); n++; }
  return n;
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

export interface Autenticado {
  token: string;
  usuario: Usuario;
}

/** Usuário da requisição, ou null se não autenticado / sessão expirada. */
export function autenticar(req: http.IncomingMessage): Autenticado | null {
  const token = lerCookie(req);
  if (!token) return null;
  const s = sessoes.get(token);
  if (!s) return null;
  if (s.expiraEm < Date.now()) { sessoes.delete(token); return null; }
  const u = usuarios.find((x) => x.id === s.userId);
  if (!u || !u.ativo) { sessoes.delete(token); return null; }
  return { token, usuario: u };
}

export function cookieSessao(token: string): string {
  const maxAge = SESSAO_HORAS * 3600;
  return `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}`;
}

export function cookieLimpo(): string {
  return `${COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`;
}

export const usuarioPublico = publico;

// Limpeza periódica de sessões expiradas.
setInterval(() => {
  const agora = Date.now();
  for (const [t, s] of sessoes) if (s.expiraEm < agora) sessoes.delete(t);
}, 600_000).unref?.();
