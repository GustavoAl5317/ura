// Testes do login por pessoa: senha, papel, sessão, bloqueio e rotas do painel.
// Banco temporário; nada de rede.
//
//   npm run test:usuarios

import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import type { AddressInfo } from 'net';

for (const k of ['OPENAI_API_KEY', 'SGP_BASE_URL', 'SGP_TOKEN']) {
  process.env[k] ||= 'teste-usuarios-sem-uso';
}
const RAIZ = __dirname;
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'aq-usuarios-')));

/* eslint-disable @typescript-eslint/no-var-requires */
const { db, fecharDb } = require(path.join(RAIZ, 'src', 'assistant', 'store', 'db')) as typeof import('./src/assistant/store/db');
const u = require(path.join(RAIZ, 'src', 'assistant', 'usuarios')) as typeof import('./src/assistant/usuarios');
const { rotasAdmin } = require(path.join(RAIZ, 'src', 'assistant', 'rotas-admin')) as typeof import('./src/assistant/rotas-admin');
const { ErroHttp } = require(path.join(RAIZ, 'src', 'assistant', 'http-util')) as typeof import('./src/assistant/http-util');
/* eslint-enable @typescript-eslint/no-var-requires */

let passou = 0;
let falhou = 0;
function checa(rotulo: string, ok: boolean, detalhe: unknown = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${rotulo}${ok || detalhe === '' ? '' : `\n      ${typeof detalhe === 'string' ? detalhe : JSON.stringify(detalhe).slice(0, 500)}`}`);
  ok ? passou++ : falhou++;
}

const servidor = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  rotasAdmin(req, res, url, url.pathname).then((tratou) => {
    if (!tratou) { res.writeHead(404); res.end(); }
  }).catch((err) => {
    res.writeHead(err instanceof ErroHttp ? err.status : 500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  });
});
let BASE = '';
async function api(metodo: string, caminho: string, corpo?: unknown) {
  const r = await fetch(`${BASE}${caminho}`, {
    method: metodo,
    headers: { 'Content-Type': 'application/json', 'x-operador': 'chefe' },
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
  });
  const t = await r.text();
  let j: any = null;
  try { j = JSON.parse(t); } catch { j = t; }
  return { status: r.status, j };
}

const SENHA = 'Aquitel2026x';

async function main() {
  await new Promise<void>((r) => servidor.listen(0, '127.0.0.1', r));
  BASE = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;
  db();

  console.log('\n─── Senha ───');
  const h = u.hashSenha(SENHA);
  checa('confere a senha certa', u.conferirSenha(SENHA, h));
  checa('recusa a errada', !u.conferirSenha('outra-coisa-9', h));
  checa('hash nunca repete (salt)', u.hashSenha(SENHA) !== h);
  checa('hash não guarda a senha em claro', !h.includes(SENHA));
  for (const ruim of ['curta1', 'senhasemnumero', '1234567890', 'senha123456']) {
    let erro = '';
    try { u.validarSenha(ruim); } catch (e) { erro = (e as Error).message; }
    checa(`recusa senha fraca "${ruim}"`, !!erro, erro);
  }
  checa('aceita senha boa', u.validarSenha(SENHA) === SENHA);
  checa('login vira minúsculo sem acento', u.normalizarLogin(' João.Silva ') === 'joao.silva');

  console.log('\n─── Criar e listar ───');
  checa('ninguém cadastrado no começo', !u.existeAlgumUsuario());
  const ana = u.criarUsuario({ login: 'ana', nome: 'Ana NOC', senha: SENHA, papel: 'admin' }, 'painel:instalacao');
  checa('cria admin', ana.papel === 'admin' && ana.ativo && u.existeAlgumUsuario());
  let erro = '';
  try { u.criarUsuario({ login: 'ANA', nome: 'Outra', senha: SENHA }, 'x'); } catch (e) { erro = (e as Error).message; }
  checa('login repetido recusado (mesmo em maiúscula)', /já existe/.test(erro), erro);
  erro = '';
  try { u.criarUsuario({ login: 'jo', nome: 'Jo', senha: SENHA }, 'x'); } catch (e) { erro = (e as Error).message; }
  checa('login curto recusado', /pelo menos 3/.test(erro), erro);
  erro = '';
  try { u.criarUsuario({ login: 'beto', nome: 'Beto', senha: SENHA, papel: 'chefe' }, 'x'); } catch (e) { erro = (e as Error).message; }
  checa('papel inventado recusado', /papel inválido/.test(erro), erro);
  const beto = u.criarUsuario({ login: 'beto', nome: 'Beto Campo', senha: SENHA, papel: 'operador', trocarSenha: true }, 'painel:ana');
  const ze = u.criarUsuario({ login: 'zeca', nome: 'Zé Olho', senha: SENHA, papel: 'leitura' }, 'painel:ana');
  checa('lista em ordem de nome', u.listarUsuarios().map((x) => x.login).join(',') === 'ana,beto,zeca', u.listarUsuarios().map((x) => x.login));

  console.log('\n─── Entrar ───');
  let r = u.autenticar('ANA', SENHA, '1.2.3.4');
  checa('entra com login em maiúscula', r.ok && r.usuario.login === 'ana');
  checa('marca último acesso', !!u.usuarioPorId(ana.id)!.ultimo_acesso);
  r = u.autenticar('ana', 'errada123456', '1.2.3.4');
  checa('senha errada não entra', !r.ok && r.motivo === 'credencial');
  r = u.autenticar('ninguem', SENHA, '1.2.3.4');
  checa('usuário inexistente devolve o mesmo motivo (não entrega quem existe)', !r.ok && r.motivo === 'credencial');
  u.atualizarUsuario(ze.id, { ativo: false }, 'painel:ana');
  r = u.autenticar('zeca', SENHA, '1.2.3.4');
  checa('desativado não entra', !r.ok && r.motivo === 'inativo');
  u.atualizarUsuario(ze.id, { ativo: true }, 'painel:ana');

  console.log('\n─── Bloqueio por tentativa ───');
  for (let i = 0; i < 5; i++) u.autenticar('beto', 'errada123456', '9.9.9.9');
  r = u.autenticar('beto', SENHA, '9.9.9.9');
  checa('trava depois de 5 erros, mesmo com a senha certa', !r.ok && r.motivo === 'bloqueado' && (r.esperarSeg ?? 0) > 0, r);
  r = u.autenticar('beto', SENHA, '5.5.5.5');
  checa('trava é por origem: outro IP entra', r.ok, r);

  console.log('\n─── Sessão ───');
  const tok = u.abrirSessao({ id: beto.id, login: beto.login, papel: 'operador' }, { ip: '1.2.3.4', dispositivo: 'Firefox' });
  let s = u.sessaoPorToken(tok);
  checa('sessão guarda IP, dispositivo e papel', s?.papel === 'operador' && s?.ip === '1.2.3.4' && s?.dispositivo === 'Firefox', s);
  u.atualizarUsuario(beto.id, { papel: 'leitura' }, 'painel:ana');
  const tok2 = u.abrirSessao({ id: beto.id, login: beto.login, papel: 'leitura' }, {});
  u.atualizarUsuario(beto.id, { papel: 'operador' }, 'painel:ana');
  checa('papel da sessão acompanha o cadastro', u.sessaoPorToken(tok2)?.papel === 'operador');
  u.atualizarUsuario(beto.id, { ativo: false }, 'painel:ana');
  checa('desativar derruba a sessão na hora', u.sessaoPorToken(tok2) === null);
  u.atualizarUsuario(beto.id, { ativo: true }, 'painel:ana');
  const tok3 = u.abrirSessao({ id: beto.id, login: beto.login, papel: 'operador' }, {});
  u.atualizarUsuario(beto.id, { senha: 'OutraSenha2026' }, 'painel:ana');
  checa('trocar senha derruba as sessões', u.sessaoPorToken(tok3) === null);
  checa('a senha nova vale', u.autenticar('beto', 'OutraSenha2026', 'x').ok);
  const tok4 = u.abrirSessao({ id: ana.id, login: 'ana', papel: 'admin' }, {});
  u.fecharSessao(tok4);
  checa('sair encerra a sessão', u.sessaoPorToken(tok4) === null);
  checa('sessão sem usuário (entrada pela chave) funciona', !!u.sessaoPorToken(u.abrirSessao({ id: null, login: 'instalador', papel: 'admin' }, {})));

  console.log('\n─── Último administrador ───');
  erro = '';
  try { u.atualizarUsuario(ana.id, { papel: 'operador' }, 'painel:ana'); } catch (e) { erro = (e as Error).message; }
  checa('não rebaixa o último admin', /último administrador/.test(erro), erro);
  erro = '';
  try { u.removerUsuario(ana.id, 'painel:ana'); } catch (e) { erro = (e as Error).message; }
  checa('não remove o último admin', /último administrador/.test(erro), erro);
  const dois = u.criarUsuario({ login: 'chefe2', nome: 'Chefe Dois', senha: SENHA, papel: 'admin' }, 'painel:ana');
  u.atualizarUsuario(ana.id, { papel: 'operador' }, 'painel:ana');
  checa('com dois admins, dá para rebaixar', u.usuarioPorId(ana.id)!.papel === 'operador');
  u.atualizarUsuario(ana.id, { papel: 'admin' }, 'painel:ana');

  console.log('\n─── Papel manda no que pode ───');
  const casos: Array<[u.Papel, string, string, boolean]> = [
    ['admin', 'PUT', '/api/config/ia.modelo', true],
    ['admin', 'DELETE', '/api/usuarios/x', true],
    ['operador', 'GET', '/api/alertas', true],
    ['operador', 'POST', '/api/perguntar', true],
    ['operador', 'POST', '/api/alertas/123/reconhecer', true],
    ['operador', 'PUT', '/api/config/ia.modelo', false],
    ['operador', 'POST', '/api/usuarios', false],
    ['operador', 'GET', '/api/usuarios', false],
    ['operador', 'POST', '/api/prompts/principal', false],
    ['operador', 'PUT', '/api/alertas-destinos/1', false],
    ['leitura', 'GET', '/api/alertas', true],
    ['leitura', 'GET', '/api/consultas', true],
    ['leitura', 'POST', '/api/perguntar', false],
    ['leitura', 'POST', '/api/alertas/123/reconhecer', false],
    ['leitura', 'PUT', '/api/config/ia.modelo', false],
  ];
  for (const [papel, metodo, rota, esperado] of casos) {
    checa(`${papel} ${metodo} ${rota} = ${esperado ? 'pode' : 'não pode'}`, u.papelPermite(papel, metodo, rota) === esperado);
  }

  console.log('\n─── Rotas do painel ───');
  r = await api('GET', '/api/usuarios');
  checa('lista usuários com papéis explicados', r.status === 200 && r.j.usuarios.length === 4 && r.j.papeis.length === 3, r.j?.papeis);
  r = await api('POST', '/api/usuarios', { login: 'novo', nome: 'Novo', senha: SENHA, papel: 'operador' });
  checa('cria pela API', r.status === 201 && r.j.usuario.login === 'novo', r.j);
  const idNovo = r.j.usuario.id;
  r = await api('POST', '/api/usuarios', { login: 'fraco', nome: 'Fraco', senha: '123' });
  checa('senha fraca recusada pela API', r.status === 400 && /senha/.test(r.j.error), r.j);
  r = await api('PUT', `/api/usuarios/${idNovo}`, { nome: 'Novo Nome' });
  checa('edita pela API', r.status === 200 && r.j.usuario.nome === 'Novo Nome');
  const tokNovo = u.abrirSessao({ id: idNovo, login: 'novo', papel: 'operador' }, { ip: '7.7.7.7' });
  r = await api('GET', `/api/usuarios/${idNovo}/sessoes`);
  checa('lista sessões do usuário sem devolver o token', r.status === 200 && r.j.sessoes.length === 1 && !JSON.stringify(r.j.sessoes[0]).includes('token'), r.j);
  r = await api('DELETE', `/api/usuarios/${idNovo}/sessoes`);
  checa('derruba as sessões dele', r.j.revogadas === 1 && u.sessaoPorToken(tokNovo) === null);
  r = await api('DELETE', `/api/usuarios/${idNovo}`);
  checa('remove pela API', r.status === 200 && !u.usuarioPorId(idNovo));
  r = await api('PUT', '/api/usuarios/00000000-0000-0000-0000-000000000000', { nome: 'x' });
  checa('inexistente = 404', r.status === 404, r);

  const tokSess = u.abrirSessao({ id: dois.id, login: 'chefe2', papel: 'admin' }, { ip: '8.8.8.8', dispositivo: 'Chrome' });
  r = await api('GET', '/api/sessoes');
  checa('lista sessões abertas', r.status === 200 && r.j.sessoes.some((x: any) => x.ip === '8.8.8.8'), r.j?.sessoes?.length);
  r = await api('DELETE', `/api/sessoes/${tokSess}`);
  checa('admin encerra sessão de outro', r.status === 200 && u.sessaoPorToken(tokSess) === null);

  console.log('\n─── Auditoria ───');
  const aud = db().prepare(`SELECT acao, ator, alvo FROM auditoria ORDER BY id`).all() as Array<{ acao: string; ator: string; alvo: string }>;
  for (const acao of ['usuario.criar', 'usuario.editar', 'usuario.senha', 'usuario.remover', 'login.ok', 'login.falha', 'usuario.revogar_sessoes', 'sessao.revogar']) {
    checa(`registra ${acao}`, aud.some((a) => a.acao === acao), aud.map((a) => a.acao).slice(0, 20));
  }
  const falha = aud.find((a) => a.acao === 'login.falha');
  checa('falha de login diz qual login tentou', falha?.alvo === 'ana' || falha?.alvo === 'beto' || falha?.alvo === 'ninguem', falha);
  checa('nenhuma senha na auditoria', !JSON.stringify(db().prepare(`SELECT * FROM auditoria`).all()).includes(SENHA));

  servidor.close();
  fecharDb();
  console.log(`\n${passou} passaram, ${falhou} falharam\n`);
  process.exit(falhou ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
