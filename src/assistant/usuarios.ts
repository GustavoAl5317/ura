// Usuários do painel: login, senha, papel e sessões.
//
// Antes existia UMA chave compartilhada: quem tinha a chave era dono de tudo, e
// a auditoria guardava só o nome que a pessoa digitou na tela. Agora cada
// pessoa tem login próprio, papel e sessões que dá para revogar, e a auditoria
// passa a dizer quem de fato fez.
//
// A chave (ADMIN_API_KEY) continua valendo para integração máquina a máquina
// (scripts, curl, outro serviço), nunca para gente.

import crypto from 'crypto';
import { db, registrarAuditoria } from './store/db';
import { logger } from '../logger';

export type Papel = 'admin' | 'operador' | 'leitura';
export const PAPEIS_PAINEL: Papel[] = ['admin', 'operador', 'leitura'];

export const DESCRICAO_PAPEL: Record<Papel, string> = {
  admin: 'Faz tudo, inclusive configuração, instruções da IA, usuários e permissões.',
  operador: 'Usa o painel e o chat, reconhece alerta. Não mexe em configuração nem em usuários.',
  leitura: 'Só consulta: vê painel, histórico e alertas. Não pergunta à IA nem altera nada.',
};

export interface Usuario {
  id: string;
  login: string;
  nome: string;
  papel: Papel;
  ativo: boolean;
  criado_em: string;
  ultimo_acesso: string | null;
  trocar_senha: boolean;
}

interface LinhaUsuario extends Omit<Usuario, 'ativo' | 'trocar_senha'> { senha_hash: string; ativo: number; trocar_senha: number }

export interface SessaoPainel {
  token: string;
  operador: string;
  usuario_id: string | null;
  papel: Papel;
  ip: string | null;
  dispositivo: string | null;
  criada_em: string;
  ultima_em: string;
}

/** Tentativas erradas seguidas antes de travar o login, e por quanto tempo. */
const MAX_TENTATIVAS = 5;
const BLOQUEIO_MS = 10 * 60_000;
const tentativas = new Map<string, { n: number; ate: number }>();

function semAcento(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** Login normalizado: sem acento, minúsculo, só letra, número, ponto, hífen e sublinhado. */
export function normalizarLogin(v: unknown): string {
  return semAcento(String(v ?? '')).toLowerCase().trim().replace(/[^a-z0-9._-]/g, '');
}

export function hashSenha(senha: string): string {
  const salt = crypto.randomBytes(16);
  return `${salt.toString('hex')}:${crypto.scryptSync(senha, salt, 64).toString('hex')}`;
}

export function conferirSenha(senha: string, armazenado: string): boolean {
  const [saltHex, hashHex] = String(armazenado).split(':');
  if (!saltHex || !hashHex) return false;
  try {
    const calc = crypto.scryptSync(senha, Buffer.from(saltHex, 'hex'), 64);
    const esperado = Buffer.from(hashHex, 'hex');
    return calc.length === esperado.length && crypto.timingSafeEqual(calc, esperado);
  } catch {
    return false;
  }
}

/** Senha fraca é recusada na criação e na troca — o painel abre dado de cliente. */
export function validarSenha(senha: unknown): string {
  const s = String(senha ?? '');
  if (s.length < 10) throw new Error('senha precisa de pelo menos 10 caracteres');
  if (!/[a-zA-Z]/.test(s) || !/\d/.test(s)) throw new Error('senha precisa ter letra e número');
  if (/^(12345|senha|password|aquitelecom|qwerty)/i.test(s)) throw new Error('senha óbvia demais');
  return s;
}

function paraUsuario(l: LinhaUsuario): Usuario {
  return {
    id: l.id, login: l.login, nome: l.nome, papel: l.papel,
    ativo: l.ativo === 1, criado_em: l.criado_em, ultimo_acesso: l.ultimo_acesso,
    trocar_senha: l.trocar_senha === 1,
  };
}

export function listarUsuarios(): Usuario[] {
  return (db().prepare(`SELECT * FROM usuario_painel ORDER BY nome`).all() as LinhaUsuario[]).map(paraUsuario);
}

export function usuarioPorLogin(login: string): LinhaUsuario | undefined {
  return db().prepare(`SELECT * FROM usuario_painel WHERE login = ?`).get(normalizarLogin(login)) as LinhaUsuario | undefined;
}

export function usuarioPorId(id: string): Usuario | null {
  const l = db().prepare(`SELECT * FROM usuario_painel WHERE id = ?`).get(id) as LinhaUsuario | undefined;
  return l ? paraUsuario(l) : null;
}

export function existeAlgumUsuario(): boolean {
  return !!db().prepare(`SELECT 1 FROM usuario_painel WHERE ativo = 1 LIMIT 1`).get();
}

export function criarUsuario(p: {
  login: unknown; nome: unknown; senha: unknown; papel?: unknown; ativo?: boolean; trocarSenha?: boolean;
}, autor: string): Usuario {
  const login = normalizarLogin(p.login);
  if (login.length < 3) throw new Error('login precisa de pelo menos 3 letras ou números');
  const nome = String(p.nome ?? '').trim();
  if (!nome) throw new Error('informe o nome da pessoa');
  const papel = validarPapel(p.papel ?? 'operador');
  const senha = validarSenha(p.senha);
  if (usuarioPorLogin(login)) throw new Error(`já existe usuário com o login ${login}`);

  const u: Usuario = {
    id: crypto.randomUUID(), login, nome, papel,
    ativo: p.ativo !== false, criado_em: new Date().toISOString(), ultimo_acesso: null,
    trocar_senha: p.trocarSenha === true,
  };
  db().prepare(
    `INSERT INTO usuario_painel (id, login, nome, senha_hash, papel, ativo, criado_em, ultimo_acesso, trocar_senha)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(u.id, u.login, u.nome, hashSenha(senha), u.papel, u.ativo ? 1 : 0, u.criado_em, null, u.trocar_senha ? 1 : 0);
  registrarAuditoria(autor, 'usuario.criar', login, undefined, { nome, papel, ativo: u.ativo });
  return u;
}

export function validarPapel(v: unknown): Papel {
  const p = String(v ?? '');
  if (!PAPEIS_PAINEL.includes(p as Papel)) throw new Error(`papel inválido: ${p}`);
  return p as Papel;
}

export function atualizarUsuario(id: string, p: {
  nome?: unknown; papel?: unknown; ativo?: boolean; senha?: unknown; trocarSenha?: boolean;
}, autor: string): Usuario {
  const antes = usuarioPorId(id);
  if (!antes) throw new Error('usuário não encontrado');

  const nome = p.nome !== undefined && String(p.nome).trim() ? String(p.nome).trim() : antes.nome;
  const papel = p.papel !== undefined ? validarPapel(p.papel) : antes.papel;
  const ativo = p.ativo !== undefined ? p.ativo : antes.ativo;

  // Último admin ativo não pode ser rebaixado nem desligado: sobraria ninguém
  // para criar usuário, e a entrada seria só pela chave.
  if (antes.papel === 'admin' && (papel !== 'admin' || !ativo) && contarAdmins() <= 1) {
    throw new Error('este é o último administrador ativo; crie outro antes de mudar este');
  }

  if (p.senha !== undefined) {
    const senha = validarSenha(p.senha);
    db().prepare(`UPDATE usuario_painel SET senha_hash = ?, trocar_senha = ? WHERE id = ?`)
      .run(hashSenha(senha), p.trocarSenha === true ? 1 : 0, id);
    // Trocar senha derruba as sessões: se a senha vazou, a sessão aberta também.
    revogarSessoesDoUsuario(id);
    registrarAuditoria(autor, 'usuario.senha', antes.login, undefined, { por: autor });
  }

  db().prepare(`UPDATE usuario_painel SET nome = ?, papel = ?, ativo = ? WHERE id = ?`)
    .run(nome, papel, ativo ? 1 : 0, id);
  if (!ativo) revogarSessoesDoUsuario(id);

  const depois = usuarioPorId(id)!;
  registrarAuditoria(autor, 'usuario.editar', antes.login, antes, depois);
  return depois;
}

export function removerUsuario(id: string, autor: string): void {
  const u = usuarioPorId(id);
  if (!u) throw new Error('usuário não encontrado');
  if (u.papel === 'admin' && u.ativo && contarAdmins() <= 1) {
    throw new Error('este é o último administrador ativo; crie outro antes de remover');
  }
  revogarSessoesDoUsuario(id);
  db().prepare(`DELETE FROM usuario_painel WHERE id = ?`).run(id);
  registrarAuditoria(autor, 'usuario.remover', u.login, u, undefined);
}

export function contarAdmins(): number {
  return (db().prepare(`SELECT COUNT(*) n FROM usuario_painel WHERE papel = 'admin' AND ativo = 1`).get() as { n: number }).n;
}

// ─── Login ───────────────────────────────────────────────────────────────────

export type ResultadoLogin =
  | { ok: true; usuario: Usuario }
  | { ok: false; motivo: 'credencial' | 'inativo' | 'bloqueado'; esperarSeg?: number };

export function autenticar(loginBruto: unknown, senha: unknown, de = ''): ResultadoLogin {
  const login = normalizarLogin(loginBruto);
  const chave = `${login}|${de}`;
  const t = tentativas.get(chave);
  if (t && t.ate > Date.now()) {
    return { ok: false, motivo: 'bloqueado', esperarSeg: Math.ceil((t.ate - Date.now()) / 1000) };
  }

  const l = usuarioPorLogin(login);
  // Confere a senha mesmo sem usuário: sem isso, o tempo de resposta diz quais logins existem.
  const senhaOk = conferirSenha(String(senha ?? ''), l?.senha_hash ?? `${'0'.repeat(32)}:${'0'.repeat(128)}`);

  if (!l || !senhaOk) {
    const n = (t?.n ?? 0) + 1;
    tentativas.set(chave, { n, ate: n >= MAX_TENTATIVAS ? Date.now() + BLOQUEIO_MS : 0 });
    registrarAuditoria(`painel:${login || '(vazio)'}`, 'login.falha', login || undefined, undefined, { de, tentativa: n });
    logger.warn('Painel: login recusado', { login, de, tentativa: n });
    return { ok: false, motivo: 'credencial' };
  }
  if (l.ativo !== 1) {
    registrarAuditoria(`painel:${login}`, 'login.falha', login, undefined, { de, motivo: 'usuário desativado' });
    return { ok: false, motivo: 'inativo' };
  }

  tentativas.delete(chave);
  db().prepare(`UPDATE usuario_painel SET ultimo_acesso = ? WHERE id = ?`).run(new Date().toISOString(), l.id);
  return { ok: true, usuario: paraUsuario(l) };
}

// ─── Sessões ─────────────────────────────────────────────────────────────────

export function abrirSessao(u: { id: string | null; login: string; papel: Papel }, ctx: { ip?: string; dispositivo?: string }): string {
  const token = crypto.randomUUID();
  const agora = new Date().toISOString();
  db().prepare(
    `INSERT INTO sessao_painel (token, operador, usuario_id, papel, ip, dispositivo, criada_em, ultima_em)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(token, u.login, u.id, u.papel, ctx.ip ?? null, (ctx.dispositivo ?? '').slice(0, 200) || null, agora, agora);
  registrarAuditoria(`painel:${u.login}`, 'login.ok', u.login, undefined, { ip: ctx.ip ?? null, papel: u.papel });
  return token;
}

export function sessaoPorToken(token: string): SessaoPainel | null {
  const s = db().prepare(`SELECT * FROM sessao_painel WHERE token = ?`).get(token) as SessaoPainel | undefined;
  if (!s) return null;
  // Usuário desligado no meio da sessão perde o acesso no próximo clique.
  if (s.usuario_id) {
    const u = usuarioPorId(s.usuario_id);
    if (!u || !u.ativo) { fecharSessao(token); return null; }
    s.papel = u.papel;
  }
  db().prepare(`UPDATE sessao_painel SET ultima_em = ? WHERE token = ?`).run(new Date().toISOString(), token);
  return s;
}

export function fecharSessao(token: string): void {
  db().prepare(`DELETE FROM sessao_painel WHERE token = ?`).run(token);
}

export function sessoesDoUsuario(id: string): SessaoPainel[] {
  return db().prepare(`SELECT * FROM sessao_painel WHERE usuario_id = ? ORDER BY ultima_em DESC`).all(id) as SessaoPainel[];
}

export function listarSessoes(): SessaoPainel[] {
  return db().prepare(`SELECT * FROM sessao_painel ORDER BY ultima_em DESC LIMIT 200`).all() as SessaoPainel[];
}

export function revogarSessoesDoUsuario(id: string): number {
  return db().prepare(`DELETE FROM sessao_painel WHERE usuario_id = ?`).run(id).changes;
}

// ─── Papel ───────────────────────────────────────────────────────────────────

/** Rota que só admin usa: configuração, instruções, usuários, permissões, bots. */
export function rotaDeAdmin(metodo: string, caminho: string): boolean {
  if (metodo === 'GET') return /^\/api\/(usuarios|sessoes|bots)\b/.test(caminho);
  return /^\/api\/(config|prompts|permissoes|equipes|usuarios|sessoes|bots|alertas-destinos|webhooks|sync|retencao)\b/.test(caminho);
}

/** Papel pode fazer esta chamada? A chave de integração não passa por aqui. */
export function papelPermite(papel: Papel, metodo: string, caminho: string): boolean {
  if (papel === 'admin') return true;
  if (rotaDeAdmin(metodo, caminho)) return false;
  if (papel === 'operador') return true;
  // leitura: só GET, e nada de perguntar à IA (custa dinheiro e consulta dado).
  return metodo === 'GET';
}
