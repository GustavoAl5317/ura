// Testes de permissão por equipe: regra de acesso e rotas de administração.
// Sobe as rotas reais num servidor HTTP local, com banco temporário.
//
//   npm run test:equipes

import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import type { AddressInfo } from 'net';

for (const k of ['OPENAI_API_KEY', 'SGP_BASE_URL', 'SGP_TOKEN']) {
  process.env[k] ||= 'teste-equipes-sem-uso';
}

const RAIZ = __dirname;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aq-equipes-'));
process.chdir(dir);

/* eslint-disable @typescript-eslint/no-var-requires */
const { db, fecharDb } = require(path.join(RAIZ, 'src', 'assistant', 'store', 'db')) as typeof import('./src/assistant/store/db');
const { fontesDoUsuario } = require(path.join(RAIZ, 'src', 'assistant', 'agent')) as typeof import('./src/assistant/agent');
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
    const status = err instanceof ErroHttp ? err.status : 500;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  });
});

let BASE = '';
async function api(metodo: string, caminho: string, corpo?: unknown) {
  const r = await fetch(`${BASE}${caminho}`, {
    method: metodo,
    headers: { 'Content-Type': 'application/json', 'x-operador': 'teste' },
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
  });
  const t = await r.text();
  let j: any = null;
  try { j = JSON.parse(t); } catch { j = t; }
  return { status: r.status, j };
}

async function main() {
  await new Promise<void>((r) => servidor.listen(0, '127.0.0.1', r));
  BASE = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;

  console.log('\n─── Rotas de equipe ───');
  let r = await api('POST', '/api/equipes', { nome: 'Campo Técnico', fontes: ['sgp', 'zabbix'] });
  checa('cria equipe com id legível', r.status === 201 && r.j.id === 'campo-tecnico', r);
  r = await api('POST', '/api/equipes', { nome: 'campo tecnico' });
  checa('nome repetido (mesmo id) é recusado', r.status === 409, r);
  r = await api('POST', '/api/equipes', { nome: 'NOC' });
  checa('equipe sem fontes = todas', r.status === 201);
  r = await api('POST', '/api/equipes', { nome: 'X', fontes: ['sgp', 'inexistente'] });
  checa('fonte inválida recusada', r.status === 400 && /inexistente/.test(r.j.error), r);
  r = await api('POST', '/api/equipes', { nome: '   ' });
  checa('nome vazio recusado', r.status === 400);

  console.log('\n─── Membros ───');
  r = await api('POST', '/api/permissoes', { usuario: '85999990001', nome: 'Ana', equipe: 'campo-tecnico' });
  checa('cadastra técnico já na equipe', r.status === 201, r);
  r = await api('POST', '/api/permissoes', { usuario: '85999990002', nome: 'Bia', equipe: 'nao-existe' });
  checa('equipe inexistente recusada no cadastro', r.status === 400, r);
  await api('POST', '/api/permissoes', { usuario: '85999990003', nome: 'Caio', equipe: 'campo-tecnico', fontes: ['sgp', 'netflow'] });
  await api('POST', '/api/permissoes', { usuario: '85999990004', nome: 'Duda', fontes: ['netflow'] });
  await api('POST', '/api/permissoes', { usuario: '85999990005', nome: 'Edu', equipe: 'noc' });

  const ana = '5585999990001@s.whatsapp.net';
  const caio = '5585999990003@s.whatsapp.net';
  const duda = '5585999990004@s.whatsapp.net';
  const edu = '5585999990005@s.whatsapp.net';
  const s = (x: unknown) => JSON.stringify(x);

  console.log('\n─── Regra de acesso ───');
  checa('membro sem restrição própria herda o teto da equipe', s(fontesDoUsuario(ana)) === s(['sgp', 'zabbix']), fontesDoUsuario(ana));
  checa('pessoa mais restrita que a equipe: interseção (netflow fica de fora)', s(fontesDoUsuario(caio)) === s(['sgp']), fontesDoUsuario(caio));
  checa('sem equipe: vale a restrição da pessoa', s(fontesDoUsuario(duda)) === s(['netflow']));
  checa('equipe sem restrição e pessoa sem restrição: todas (null)', fontesDoUsuario(edu) === null);
  checa('quem não tem cadastro: sem restrição individual (null)', fontesDoUsuario('5585000000000@s.whatsapp.net') === null);

  /* eslint-disable-next-line @typescript-eslint/no-var-requires */
  const { autorizado } = require(path.join(RAIZ, 'src', 'assistant', 'channels', 'whatsapp-tecnicos')) as typeof import('./src/assistant/channels/whatsapp-tecnicos');
  checa('membro de equipe ativa pode falar pelo WhatsApp (inclusive sem o nono dígito)', autorizado(ana) && autorizado('558599990001@s.whatsapp.net'));

  r = await api('PUT', '/api/equipes/campo-tecnico', { ativo: false });
  checa('bloqueia a equipe', r.status === 200 && r.j.equipe.ativo === false);
  checa('equipe bloqueada: membros sem nenhuma fonte', s(fontesDoUsuario(ana)) === '[]' && s(fontesDoUsuario(caio)) === '[]');
  checa('equipe bloqueada: membro não é atendido no WhatsApp', !autorizado(ana));
  checa('quem é de outra equipe continua atendido', autorizado(edu));
  await api('PUT', '/api/equipes/campo-tecnico', { ativo: true });
  checa('equipe liberada: acesso volta', s(fontesDoUsuario(ana)) === s(['sgp', 'zabbix']) && autorizado(ana));

  db().prepare(`UPDATE permissao SET equipe = 'apagada-na-mao' WHERE usuario = ?`).run(ana);
  checa('equipe que sumiu do banco não vira "sem teto"', s(fontesDoUsuario(ana)) === '[]');
  await api('PUT', `/api/permissoes/${encodeURIComponent(ana)}`, { equipe: 'campo-tecnico' });

  r = await api('PUT', `/api/permissoes/${encodeURIComponent(ana)}`, { ativo: false });
  checa('pessoa bloqueada continua sem fonte mesmo com equipe ativa', s(fontesDoUsuario(ana)) === '[]');
  await api('PUT', `/api/permissoes/${encodeURIComponent(ana)}`, { ativo: true });

  r = await api('PUT', `/api/permissoes/${encodeURIComponent(ana)}`, { equipe: null });
  checa('tirar da equipe: volta a não ter teto', r.status === 200 && fontesDoUsuario(ana) === null, fontesDoUsuario(ana));
  r = await api('PUT', `/api/permissoes/${encodeURIComponent(ana)}`, { nome: 'Ana Maria' });
  checa('editar outro campo não mexe na equipe', r.j.permissao.equipe === null && r.j.permissao.nome === 'Ana Maria', r.j);

  console.log('\n─── Remoção e listagem ───');
  r = await api('DELETE', '/api/equipes/campo-tecnico');
  checa('equipe com membros não pode ser removida', r.status === 409 && /1 membro/.test(r.j.error), r);
  r = await api('GET', '/api/equipes');
  const campo = r.j.equipes.find((e: any) => e.id === 'campo-tecnico');
  checa('listagem mostra quantos membros', campo?.membros === 1 && Array.isArray(campo.fontes), campo);
  r = await api('GET', '/api/permissoes');
  checa('tela de técnicos recebe a lista de equipes', Array.isArray(r.j.equipes) && r.j.equipes.length === 2);
  await api('PUT', `/api/permissoes/${encodeURIComponent(caio)}`, { equipe: 'noc' });
  r = await api('DELETE', '/api/equipes/campo-tecnico');
  checa('sem membros: remove', r.status === 200);
  r = await api('PUT', '/api/equipes/campo-tecnico', { ativo: true });
  checa('editar equipe removida: 404', r.status === 404);

  console.log('\n─── Auditoria ───');
  const aud = db().prepare(`SELECT acao, alvo, ator FROM auditoria WHERE acao LIKE 'equipe.%' ORDER BY id`).all() as Array<{ acao: string; alvo: string; ator: string }>;
  checa('criar, editar e remover equipe ficam registrados com quem fez',
    ['equipe.criar', 'equipe.editar', 'equipe.remover'].every((a) => aud.some((x) => x.acao === a)) && aud.every((x) => x.ator === 'painel:teste'), aud);
  const permAud = db().prepare(`SELECT depois FROM auditoria WHERE acao = 'permissao.criar' AND alvo = ?`).get(caio) as { depois: string };
  checa('cadastro de técnico registra a equipe', /"equipe":"campo-tecnico"/.test(permAud.depois), permAud);

  servidor.close();
  fecharDb();
  console.log(`\n${passou} passaram, ${falhou} falharam\n`);
  process.exit(falhou ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
