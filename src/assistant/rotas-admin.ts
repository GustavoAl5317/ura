// Rotas da camada administrativa (Bloco 6): configuração, permissões, modelos
// e auditoria. Toda escrita grava quem fez e o valor anterior.

import axios from 'axios';
import { config } from '../config';
import { Rota, json, lerJson, ator, ErroHttp } from './http-util';
import { db, registrarAuditoria } from './store/db';
import { listar, definir, restaurar, obter, DEFINICOES, ChaveConfig } from './config-dinamica';
import { sintetizar } from './voice';
import { paraJid } from '../integrations/evolution';
import { FONTES, FonteId } from './types';
import {
  TIPOS_ALERTA, SEVERIDADES, listarDestinos, destinoPorId, validarTipos, validarSeveridade,
} from './destinos-alerta';
import { evoTecnicos } from './channels/whatsapp-tecnicos';
import { atualizarBot, criarBot, listarBots, removerBot, trocarChave } from './bots';
import {
  EVENTOS_WEBHOOK, atualizarWebhook, criarWebhook, listarWebhooks, removerWebhook, testarWebhook,
} from './webhooks';
import {
  DESCRICAO_PAPEL, PAPEIS_PAINEL, SessaoPainel, atualizarUsuario, criarUsuario, fecharSessao,
  listarSessoes, listarUsuarios, removerUsuario, revogarSessoesDoUsuario, sessoesDoUsuario,
} from './usuarios';
import {
  DIAS_SEMANA, ROTULO_EXCECAO, TIPOS_ESCALA, TIPOS_EXCECAO, atualizarEquipe as atualizarEquipePlantao,
  atualizarEscala, criarEscala, criarExcecao, equipes as equipesPlantao, listarEscalas, listarExcecoes,
  pessoas as pessoasPlantao, removerEscala, removerExcecao,
} from './plantao';
import {
  ROTULO_MARCO, listarRegras as listarRegrasSla, salvarRegra as salvarRegraSla,
} from './sla-incidente';
import {
  ROTULO_ACAO, ROTULO_CAMPO, ROTULO_OPERADOR, TIPOS_PARA_REGRA, atualizarRegra, criarRegra,
  listarRegras, removerRegra,
} from './regras';
import {
  ROTULO_ALVO, ROTULO_EFEITO, criar as criarManutencao, encerrar as encerrarManutencao,
  listar as listarManutencoes, remover as removerManutencao,
} from './manutencao';
import {
  conferirBackup, fazerBackup, limparAntigos, listarBackups, politicaRetencao, regrasDeAcesso, saude,
} from './governanca';
import {
  atualizar as atualizarTermo, criar as criarTermo, listar as listarGlossario,
  remover as removerTermo, termosEncontrados,
} from './glossario';

/** Sessão para o painel: sem o token, que é credencial viva. */
function sessaoSaida(s: SessaoPainel) {
  return {
    id: s.token, operador: s.operador, papel: s.papel, ip: s.ip,
    dispositivo: s.dispositivo, criada_em: s.criada_em, ultima_em: s.ultima_em,
  };
}

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

/**
 * Número conferido no WhatsApp: recusa quem não tem conta e troca pelo JID que
 * o WhatsApp usa. Se a verificação não responder, segue com o digitado.
 */
async function numeroConferido(v: unknown): Promise<string> {
  const jid = numeroDeAlerta(v);
  if (jid.endsWith('@g.us')) return jid;
  const r = await evoTecnicos.verificarNumero(jid);
  if (r && !r.existe) throw new ErroHttp(400, `o número ${jid.split('@')[0]} não tem WhatsApp — confira DDD e dígitos`);
  return r?.jid ?? jid;
}

/** Celular com DDD (vira JID) ou id de grupo (…@g.us). */
function numeroDeAlerta(v: unknown): string {
  const bruto = String(v ?? '').trim();
  if (/@g\.us$/.test(bruto)) return bruto;
  const digitos = bruto.replace(/\D/g, '');
  if (digitos.length < 10 || digitos.length > 13) throw new ErroHttp(400, 'número inválido: use DDD + número, ex.: 85999999999');
  return paraJid(digitos);
}

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

  // ── Bots (sistemas internos) ──────────────────────────────────────────────
  if (req.method === 'GET' && p === '/api/bots') {
    json(res, 200, { bots: listarBots() });
    return true;
  }

  if (req.method === 'POST' && p === '/api/bots') {
    const b = await lerJson<{ nome?: string; descricao?: string }>(req);
    try {
      const { bot, chave } = criarBot({ nome: b.nome, descricao: b.descricao }, ator(req));
      // A chave vai UMA vez. Depois só resta trocar.
      json(res, 201, { ok: true, bot, chave, aviso: 'guarde a chave agora: ela não aparece de novo' });
    } catch (e) {
      throw new ErroHttp(/já existe/.test((e as Error).message) ? 409 : 400, (e as Error).message);
    }
    return true;
  }

  const mBot = p.match(/^\/api\/bots\/([a-z0-9-]{1,40})(\/chave)?$/);
  if (mBot) {
    const slug = mBot[1];
    try {
      if (mBot[2] && req.method === 'POST') {
        json(res, 200, { ok: true, chave: trocarChave(slug, ator(req)), aviso: 'a chave anterior parou de valer agora' });
        return true;
      }
      if (!mBot[2] && req.method === 'PUT') {
        const b = await lerJson<{ ativo?: boolean; descricao?: string }>(req);
        json(res, 200, { ok: true, bot: atualizarBot(slug, { ativo: b.ativo, descricao: b.descricao }, ator(req)) });
        return true;
      }
      if (!mBot[2] && req.method === 'DELETE') {
        removerBot(slug, ator(req));
        json(res, 200, { ok: true });
        return true;
      }
    } catch (e) {
      throw new ErroHttp(/não encontrado/.test((e as Error).message) ? 404 : 400, (e as Error).message);
    }
  }

  // ── Webhooks de saída ─────────────────────────────────────────────────────
  if (req.method === 'GET' && p === '/api/webhooks') {
    json(res, 200, { webhooks: listarWebhooks(), eventos: EVENTOS_WEBHOOK });
    return true;
  }

  if (req.method === 'POST' && p === '/api/webhooks') {
    const b = await lerJson<Record<string, unknown>>(req);
    try {
      const { webhook, segredo } = criarWebhook({ nome: b.nome, url: b.url, eventos: b.eventos }, ator(req));
      json(res, 201, { ok: true, webhook, segredo, aviso: 'guarde o segredo agora: ele confere a assinatura e não aparece de novo' });
    } catch (e) {
      throw new ErroHttp(400, (e as Error).message);
    }
    return true;
  }

  const mWeb = p.match(/^\/api\/webhooks\/([0-9a-f-]{36})(\/teste)?$/i);
  if (mWeb) {
    const id = mWeb[1];
    try {
      if (mWeb[2] && req.method === 'POST') {
        json(res, 200, await testarWebhook(id, ator(req)));
        return true;
      }
      if (!mWeb[2] && req.method === 'PUT') {
        const b = await lerJson<Record<string, unknown>>(req);
        json(res, 200, {
          ok: true,
          webhook: atualizarWebhook(id, {
            nome: b.nome, url: b.url, eventos: b.eventos,
            ativo: b.ativo === undefined ? undefined : b.ativo !== false,
          }, ator(req)),
        });
        return true;
      }
      if (!mWeb[2] && req.method === 'DELETE') {
        removerWebhook(id, ator(req));
        json(res, 200, { ok: true });
        return true;
      }
    } catch (e) {
      throw new ErroHttp(/não encontrado/.test((e as Error).message) ? 404 : 400, (e as Error).message);
    }
  }

  // ── Usuários do painel ────────────────────────────────────────────────────
  if (req.method === 'GET' && p === '/api/usuarios') {
    json(res, 200, {
      usuarios: listarUsuarios().map((u) => ({ ...u, sessoes: sessoesDoUsuario(u.id).length })),
      papeis: PAPEIS_PAINEL.map((id) => ({ id, descricao: DESCRICAO_PAPEL[id] })),
    });
    return true;
  }

  if (req.method === 'POST' && p === '/api/usuarios') {
    const b = await lerJson<Record<string, unknown>>(req);
    try {
      const u = criarUsuario({
        login: b.login, nome: b.nome, senha: b.senha, papel: b.papel,
        ativo: b.ativo !== false, trocarSenha: b.trocarSenha === true,
      }, ator(req));
      json(res, 201, { ok: true, usuario: u });
    } catch (e) {
      throw new ErroHttp(400, (e as Error).message);
    }
    return true;
  }

  const mUsu = p.match(/^\/api\/usuarios\/([0-9a-f-]{36})(\/sessoes)?$/i);
  if (mUsu) {
    const id = mUsu[1];
    if (mUsu[2]) {
      if (req.method === 'GET') {
        json(res, 200, { sessoes: sessoesDoUsuario(id).map(sessaoSaida) });
        return true;
      }
      if (req.method === 'DELETE') {
        const n = revogarSessoesDoUsuario(id);
        registrarAuditoria(ator(req), 'usuario.revogar_sessoes', id, undefined, { sessoes: n });
        json(res, 200, { ok: true, revogadas: n });
        return true;
      }
    }
    if (req.method === 'PUT') {
      const b = await lerJson<Record<string, unknown>>(req);
      try {
        json(res, 200, {
          ok: true,
          usuario: atualizarUsuario(id, {
            nome: b.nome, papel: b.papel,
            ativo: b.ativo === undefined ? undefined : b.ativo !== false,
            senha: b.senha, trocarSenha: b.trocarSenha === true,
          }, ator(req)),
        });
      } catch (e) {
        throw new ErroHttp(/não encontrado/.test((e as Error).message) ? 404 : 400, (e as Error).message);
      }
      return true;
    }
    if (req.method === 'DELETE') {
      try {
        removerUsuario(id, ator(req));
        json(res, 200, { ok: true });
      } catch (e) {
        throw new ErroHttp(/não encontrado/.test((e as Error).message) ? 404 : 400, (e as Error).message);
      }
      return true;
    }
  }

  if (req.method === 'GET' && p === '/api/sessoes') {
    json(res, 200, { sessoes: listarSessoes().map(sessaoSaida) });
    return true;
  }

  const mSess = p.match(/^\/api\/sessoes\/([0-9a-f-]{36})$/i);
  if (mSess && req.method === 'DELETE') {
    fecharSessao(mSess[1]);
    registrarAuditoria(ator(req), 'sessao.revogar', mSess[1]);
    json(res, 200, { ok: true });
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
  // ── Destinos de alerta ────────────────────────────────────────────────────
  if (req.method === 'GET' && p === '/api/alertas-destinos') {
    json(res, 200, { destinos: listarDestinos(), tipos: TIPOS_ALERTA, severidades: SEVERIDADES });
    return true;
  }

  if (req.method === 'POST' && p === '/api/alertas-destinos') {
    const b = await lerJson<{ nome?: string; numero?: string; tipos?: unknown; severidade_minima?: unknown; ativo?: boolean }>(req);
    const nome = String(b.nome ?? '').trim();
    if (!nome) throw new ErroHttp(400, 'informe o nome de quem recebe');
    const numero = await numeroConferido(b.numero);
    let tipos, sev;
    try { tipos = validarTipos(b.tipos); sev = validarSeveridade(b.severidade_minima); } catch (e) { throw new ErroHttp(400, (e as Error).message); }
    if (db().prepare(`SELECT 1 FROM alerta_destino WHERE numero = ?`).get(numero)) throw new ErroHttp(409, 'esse número já recebe alertas; edite o cadastro existente');
    const r = db().prepare(
      `INSERT INTO alerta_destino (nome, numero, tipos, severidade_minima, ativo, criado_em) VALUES (?,?,?,?,?,?)`,
    ).run(nome, numero, JSON.stringify(tipos), sev, b.ativo === false ? 0 : 1, new Date().toISOString());
    const novo = destinoPorId(Number(r.lastInsertRowid));
    registrarAuditoria(ator(req), 'alerta_destino.criar', numero, undefined, novo);
    json(res, 201, { ok: true, destino: novo });
    return true;
  }

  const mDest = p.match(/^\/api\/alertas-destinos\/(\d+)(\/teste)?$/);
  if (mDest) {
    const id = Number(mDest[1]);
    const antes = destinoPorId(id);
    if (!antes) throw new ErroHttp(404, 'destino não encontrado');

    if (mDest[2] && req.method === 'POST') {
      if (!evoTecnicos.disponivel) throw new ErroHttp(409, 'WhatsApp do assistente não configurado');
      // Cadastro antigo pode ter o JID errado (nono dígito): o teste é a hora de corrigir.
      const conferido = await numeroConferido(antes.numero);
      if (conferido !== antes.numero) {
        db().prepare(`UPDATE alerta_destino SET numero = ? WHERE id = ?`).run(conferido, id);
        registrarAuditoria(ator(req), 'alerta_destino.corrigir_numero', conferido, { numero: antes.numero }, { numero: conferido });
        antes.numero = conferido;
      }
      const ok = await evoTecnicos.enviarTexto(antes.numero,
        `✅ *Teste de alerta*\nOlá, ${antes.nome}! Você vai receber por aqui: ${antes.tipos.map((t) => TIPOS_ALERTA[t]).join(', ')}.`);
      // Áudio junto: quem recebe confere na hora que também ouve, e não só no
      // primeiro alerta crítico de verdade.
      let audio = false;
      if (ok && obter<string>('alertas.audio') !== 'nunca') {
        const voz = await sintetizar(
          `Olá, ${antes.nome}. Este é um teste do assistente. Quando chegar um problema importante, você recebe ` +
          'a mensagem de texto e um áudio como este.', 'opus').catch(() => null);
        audio = !!voz && await evoTecnicos.enviarAudio(antes.numero, voz);
      }
      registrarAuditoria(ator(req), 'alerta_destino.teste', antes.numero, undefined, { ok, audio });
      if (!ok) throw new ErroHttp(502, 'o WhatsApp não aceitou o envio — confira o número e se o assistente está conectado');
      json(res, 200, { ok: true, audio });
      return true;
    }

    if (!mDest[2] && req.method === 'DELETE') {
      db().prepare(`DELETE FROM alerta_destino WHERE id = ?`).run(id);
      registrarAuditoria(ator(req), 'alerta_destino.remover', antes.numero, antes, undefined);
      json(res, 200, { ok: true });
      return true;
    }

    if (!mDest[2] && req.method === 'PUT') {
      const b = await lerJson<{ nome?: string; numero?: string; tipos?: unknown; severidade_minima?: unknown; ativo?: boolean }>(req);
      let tipos = antes.tipos, sev = antes.severidade_minima;
      try {
        if (b.tipos !== undefined) tipos = validarTipos(b.tipos);
        if (b.severidade_minima !== undefined) sev = validarSeveridade(b.severidade_minima);
      } catch (e) { throw new ErroHttp(400, (e as Error).message); }
      const numero = b.numero !== undefined ? await numeroConferido(b.numero) : antes.numero;
      if (numero !== antes.numero && db().prepare(`SELECT 1 FROM alerta_destino WHERE numero = ?`).get(numero)) {
        throw new ErroHttp(409, 'esse número já recebe alertas');
      }
      db().prepare(`UPDATE alerta_destino SET nome = ?, numero = ?, tipos = ?, severidade_minima = ?, ativo = ? WHERE id = ?`).run(
        b.nome !== undefined && String(b.nome).trim() ? String(b.nome).trim() : antes.nome,
        numero, JSON.stringify(tipos), sev,
        b.ativo !== undefined ? (b.ativo ? 1 : 0) : (antes.ativo ? 1 : 0), id,
      );
      const depois = destinoPorId(id);
      registrarAuditoria(ator(req), 'alerta_destino.editar', numero, antes, depois);
      json(res, 200, { ok: true, destino: depois });
      return true;
    }
  }

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

  // ── Plantão: equipes, escalas e ausências ─────────────────────────────────
  if (req.method === 'GET' && p === '/api/plantao/cadastro') {
    json(res, 200, {
      equipes: equipesPlantao(),
      pessoas: pessoasPlantao(),
      escalas: listarEscalas(),
      excecoes: listarExcecoes({ desde: new Date(Date.now() - 30 * 86_400_000).toISOString() }),
      tipos_alerta: TIPOS_ALERTA,
      severidades: SEVERIDADES,
      dias: DIAS_SEMANA,
      tipos_escala: TIPOS_ESCALA,
      tipos_excecao: TIPOS_EXCECAO,
      rotulo_excecao: ROTULO_EXCECAO,
    });
    return true;
  }

  const mEqPl = p.match(/^\/api\/plantao\/equipes\/([^/]+)$/);
  if (req.method === 'PUT' && mEqPl) {
    const b = await lerJson<Record<string, unknown>>(req);
    try {
      json(res, 200, { ok: true, equipe: atualizarEquipePlantao(decodeURIComponent(mEqPl[1]), b, ator(req)) });
    } catch (e) {
      throw new ErroHttp(/não encontrada/.test((e as Error).message) ? 404 : 400, (e as Error).message);
    }
    return true;
  }

  if (req.method === 'POST' && p === '/api/plantao/escalas') {
    const b = await lerJson<Record<string, unknown>>(req);
    try {
      json(res, 201, { ok: true, escala: criarEscala(b, ator(req)) });
    } catch (e) {
      throw new ErroHttp(400, (e as Error).message);
    }
    return true;
  }

  const mEsc = p.match(/^\/api\/plantao\/escalas\/([0-9a-f-]{36})$/);
  if (mEsc && (req.method === 'PUT' || req.method === 'DELETE')) {
    try {
      if (req.method === 'DELETE') {
        removerEscala(mEsc[1], ator(req));
        json(res, 200, { ok: true });
      } else {
        const b = await lerJson<Record<string, unknown>>(req);
        json(res, 200, { ok: true, escala: atualizarEscala(mEsc[1], b, ator(req)) });
      }
    } catch (e) {
      throw new ErroHttp(/não encontrada/.test((e as Error).message) ? 404 : 400, (e as Error).message);
    }
    return true;
  }

  if (req.method === 'POST' && p === '/api/plantao/excecoes') {
    const b = await lerJson<Record<string, unknown>>(req);
    try {
      json(res, 201, { ok: true, excecao: criarExcecao(b, ator(req)) });
    } catch (e) {
      throw new ErroHttp(400, (e as Error).message);
    }
    return true;
  }

  const mExc = p.match(/^\/api\/plantao\/excecoes\/([0-9a-f-]{36})$/);
  if (req.method === 'DELETE' && mExc) {
    try {
      removerExcecao(mExc[1], ator(req));
      json(res, 200, { ok: true });
    } catch (e) {
      throw new ErroHttp(/não encontrado/.test((e as Error).message) ? 404 : 400, (e as Error).message);
    }
    return true;
  }

  // ── SLA do incidente ──────────────────────────────────────────────────────
  if (req.method === 'GET' && p === '/api/sla') {
    json(res, 200, { regras: listarRegrasSla(), marcos: ROTULO_MARCO });
    return true;
  }

  const mSla = p.match(/^\/api\/sla\/([a-z]+)$/);
  if (req.method === 'PUT' && mSla) {
    const b = await lerJson<Record<string, unknown>>(req);
    try {
      json(res, 200, { ok: true, regra: salvarRegraSla(mSla[1], b, ator(req)) });
    } catch (e) {
      throw new ErroHttp(400, (e as Error).message);
    }
    return true;
  }

  // ── Regras e janelas de manutenção ────────────────────────────────────────
  if (req.method === 'GET' && p === '/api/regras') {
    json(res, 200, {
      regras: listarRegras(),
      campos: ROTULO_CAMPO,
      operadores: ROTULO_OPERADOR,
      acoes: ROTULO_ACAO,
      tipos: TIPOS_PARA_REGRA,
      manutencoes: listarManutencoes({ desde: new Date(Date.now() - 30 * 86_400_000).toISOString() }),
      efeitos: ROTULO_EFEITO,
      alvos: ROTULO_ALVO,
    });
    return true;
  }

  if (req.method === 'POST' && p === '/api/regras') {
    const b = await lerJson<Record<string, unknown>>(req);
    try {
      json(res, 201, { ok: true, regra: criarRegra(b, ator(req)) });
    } catch (e) {
      throw new ErroHttp(400, (e as Error).message);
    }
    return true;
  }

  const mRegra = p.match(/^\/api\/regras\/([0-9a-f-]{36})$/);
  if (mRegra && (req.method === 'PUT' || req.method === 'DELETE')) {
    try {
      if (req.method === 'DELETE') {
        removerRegra(mRegra[1], ator(req));
        json(res, 200, { ok: true });
      } else {
        const b = await lerJson<Record<string, unknown>>(req);
        json(res, 200, { ok: true, regra: atualizarRegra(mRegra[1], b, ator(req)) });
      }
    } catch (e) {
      throw new ErroHttp(/não encontrada/.test((e as Error).message) ? 404 : 400, (e as Error).message);
    }
    return true;
  }

  if (req.method === 'POST' && p === '/api/manutencoes') {
    const b = await lerJson<Record<string, unknown>>(req);
    try {
      json(res, 201, { ok: true, manutencao: criarManutencao(b, ator(req)) });
    } catch (e) {
      throw new ErroHttp(400, (e as Error).message);
    }
    return true;
  }

  const mMan = p.match(/^\/api\/manutencoes\/([0-9a-f-]{36})(\/encerrar)?$/);
  if (mMan && (req.method === 'DELETE' || req.method === 'POST')) {
    try {
      if (req.method === 'POST' && mMan[2]) {
        json(res, 200, { ok: true, manutencao: encerrarManutencao(mMan[1], ator(req)) });
      } else if (req.method === 'DELETE') {
        removerManutencao(mMan[1], ator(req));
        json(res, 200, { ok: true });
      } else {
        throw new ErroHttp(404, 'rota não encontrada');
      }
    } catch (e) {
      if (e instanceof ErroHttp) throw e;
      throw new ErroHttp(/não encontrada/.test((e as Error).message) ? 404 : 400, (e as Error).message);
    }
    return true;
  }

  // ── Governança: retenção, saúde, backup e regras de acesso ────────────────
  if (req.method === 'GET' && p === '/api/governanca') {
    json(res, 200, {
      retencao: politicaRetencao(),
      saude: saude(),
      backups: listarBackups(),
      acessos: regrasDeAcesso(),
    });
    return true;
  }

  if (req.method === 'POST' && p === '/api/governanca/limpeza') {
    const r = limparAntigos();
    registrarAuditoria(ator(req), 'retencao.limpeza', 'manual', undefined, r);
    json(res, 200, { ok: true, limpeza: r });
    return true;
  }

  if (req.method === 'POST' && p === '/api/governanca/backup') {
    const r = await fazerBackup();
    registrarAuditoria(ator(req), 'backup.manual', r.arquivo, undefined, { verificado: r.verificado, mb: r.mb });
    json(res, r.verificado ? 200 : 500, { ok: r.verificado, backup: r });
    return true;
  }

  const mConf = p.match(/^\/api\/governanca\/backup\/([A-Za-z0-9._-]+)\/conferir$/);
  if (req.method === 'POST' && mConf) {
    try {
      json(res, 200, { ok: true, conferencia: conferirBackup(mConf[1]) });
    } catch (e) {
      throw new ErroHttp(/não encontrada/.test((e as Error).message) ? 404 : 400, (e as Error).message);
    }
    return true;
  }

  // ── Vocabulário da casa ───────────────────────────────────────────────────
  if (req.method === 'GET' && p === '/api/glossario') {
    json(res, 200, { termos: listarGlossario() });
    return true;
  }

  if (req.method === 'POST' && p === '/api/glossario') {
    const b = await lerJson<Record<string, unknown>>(req);
    try {
      json(res, 201, { ok: true, termo: criarTermo(b, ator(req)) });
    } catch (e) {
      throw new ErroHttp(/já está/.test((e as Error).message) ? 409 : 400, (e as Error).message);
    }
    return true;
  }

  const mTermo = p.match(/^\/api\/glossario\/([0-9a-f-]{36})$/);
  if (mTermo && (req.method === 'PUT' || req.method === 'DELETE')) {
    try {
      if (req.method === 'DELETE') {
        removerTermo(mTermo[1], ator(req));
        json(res, 200, { ok: true });
      } else {
        const b = await lerJson<Record<string, unknown>>(req);
        json(res, 200, { ok: true, termo: atualizarTermo(mTermo[1], b, ator(req)) });
      }
    } catch (e) {
      throw new ErroHttp(/não encontrado/.test((e as Error).message) ? 404 : 400, (e as Error).message);
    }
    return true;
  }

  // Teste seco: que termos esta frase ativa, sem gastar chamada de modelo.
  if (req.method === 'POST' && p === '/api/glossario/testar') {
    const b = await lerJson<{ texto?: string }>(req);
    const achados = termosEncontrados(String(b.texto ?? ''));
    json(res, 200, { achados: achados.map((t) => ({ termo: t.termo, significado: t.significado, dica: t.dica })) });
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
