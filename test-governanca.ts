// Testes de governança: retenção por tipo, saúde da plataforma (inclusive
// silêncio anormal) e backup conferido.
//
//   npm run test:governanca

import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import type { AddressInfo } from 'net';

for (const k of ['OPENAI_API_KEY', 'SGP_BASE_URL', 'SGP_TOKEN']) {
  process.env[k] ||= 'teste-governanca-sem-uso';
}
process.env.TZ ||= 'America/Fortaleza';
const RAIZ = __dirname;
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'aq-gov-')));

/* eslint-disable @typescript-eslint/no-var-requires */
const { db, fecharDb } = require(path.join(RAIZ, 'src', 'assistant', 'store', 'db')) as typeof import('./src/assistant/store/db');
const gov = require(path.join(RAIZ, 'src', 'assistant', 'governanca')) as typeof import('./src/assistant/governanca');
const alertas = require(path.join(RAIZ, 'src', 'assistant', 'alertas')) as typeof import('./src/assistant/alertas');
const inc = require(path.join(RAIZ, 'src', 'assistant', 'incidentes')) as typeof import('./src/assistant/incidentes');
const hist = require(path.join(RAIZ, 'src', 'assistant', 'historico')) as typeof import('./src/assistant/historico');
const cfg = require(path.join(RAIZ, 'src', 'assistant', 'config-dinamica')) as typeof import('./src/assistant/config-dinamica');
const { evoTecnicos } = require(path.join(RAIZ, 'src', 'assistant', 'channels', 'whatsapp-tecnicos')) as typeof import('./src/assistant/channels/whatsapp-tecnicos');
const { rotasAdmin } = require(path.join(RAIZ, 'src', 'assistant', 'rotas-admin')) as typeof import('./src/assistant/rotas-admin');
const { ErroHttp } = require(path.join(RAIZ, 'src', 'assistant', 'http-util')) as typeof import('./src/assistant/http-util');
/* eslint-enable @typescript-eslint/no-var-requires */

let passou = 0;
let falhou = 0;
function checa(rotulo: string, ok: boolean, detalhe: unknown = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${rotulo}${ok || detalhe === '' ? '' : `\n      ${typeof detalhe === 'string' ? detalhe : JSON.stringify(detalhe).slice(0, 400)}`}`);
  ok ? passou++ : falhou++;
}

let idMsg = 0;
Object.defineProperty(evoTecnicos, 'disponivel', { get: () => true });
(evoTecnicos as any).enviarTextoComId = async () => ({ ok: true, id: `MSG${++idMsg}` });
(evoTecnicos as any).enviarTexto = async () => true;

const servidor = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  rotasAdmin(req, res, url, url.pathname).then((t) => { if (!t) { res.writeHead(404); res.end(); } })
    .catch((err) => {
      res.writeHead(err instanceof ErroHttp ? err.status : 500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    });
});
let BASE = '';
async function api(metodo: string, caminho: string, corpo?: unknown) {
  const r = await fetch(`${BASE}${caminho}`, {
    method: metodo, headers: { 'Content-Type': 'application/json', 'x-operador': 'ana' },
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
  });
  const t = await r.text();
  let j: any = null;
  try { j = JSON.parse(t); } catch { j = t; }
  return { status: r.status, j };
}

const diasAtras = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

async function main(): Promise<void> {
  db();
  await new Promise<void>((r) => servidor.listen(0, '127.0.0.1', r));
  BASE = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;
  cfg.definir('alertas.destino_grupo', '99999@g.us', 'teste');

  // Dado velho e dado novo de cada tipo.
  const conv = 'conv-1';
  db().prepare(`INSERT INTO conversa (id, canal, usuario, nome, criada_em, ultima_em) VALUES (?,?,?,?,?,?)`)
    .run(conv, 'chat', 'ana', 'Ana', diasAtras(400), diasAtras(400));
  db().prepare(`INSERT INTO mensagem (id, conversa_id, papel, formato, conteudo, at) VALUES (?,?,?,?,?,?)`)
    .run('m-velha', conv, 'user', 'texto', 'oi', diasAtras(400));
  db().prepare(`INSERT INTO mensagem (id, conversa_id, papel, formato, conteudo, at) VALUES (?,?,?,?,?,?)`)
    .run('m-nova', conv, 'user', 'texto', 'oi de novo', new Date().toISOString());
  db().prepare(`INSERT INTO consulta (id, conversa_id, usuario, canal, pergunta, resposta, veredito, fontes, duracao_ms, at)
                VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run('c-velha', conv, 'ana', 'chat', 'p', 'r', 'CONFIRMADO', '[]', 10, diasAtras(400));
  db().prepare(`INSERT INTO auditoria (at, ator, acao, alvo, antes, depois) VALUES (?,?,?,?,?,?)`)
    .run(diasAtras(400), 'ana', 'teste.antigo', 'x', null, null);
  db().prepare(`INSERT INTO chamada_ura (call_id, numero, status, iniciada_em, atualizada_em) VALUES (?,?,?,?,?)`)
    .run('ch-velha', '5585900000000', 'encerrada', diasAtras(400), diasAtras(400));

  const aVelho = await alertas.emitir({
    origem: 'zabbix', severidade: 'critico', titulo: 'Antigo', texto: 'Antigo',
    chave: 'zabbix:antigo', dados: { host: 'OLT-V' },
  });
  const incVelho = inc.listar({ limite: 5 })[0];
  inc.mudarEstado(incVelho.id, 'encerrado', 'teste');
  db().prepare(`UPDATE alerta SET criado_em = ? WHERE id = ?`).run(diasAtras(400), aVelho!.id);
  db().prepare(`UPDATE incidente SET aberto_em = ? WHERE id = ?`).run(diasAtras(900), incVelho.id);
  hist.salvarPos(incVelho.id, { o_que_aconteceu: 'x', causa_raiz: 'y', acoes: [] }, 'ana');

  const aNovo = await alertas.emitir({
    origem: 'zabbix', severidade: 'critico', titulo: 'Recente', texto: 'Recente',
    chave: 'zabbix:recente', dados: { host: 'OLT-N' },
  });
  const incAberto = inc.listar({ abertos: true })[0];
  db().prepare(`UPDATE incidente SET aberto_em = ? WHERE id = ?`).run(diasAtras(900), incAberto.id);

  console.log('\n─── Política de retenção ───');
  const politica = gov.politicaRetencao();
  checa('cada tipo de dado tem prazo e explicação', politica.length === 7 && politica.every((x) => x.porque.length > 10));
  checa('evidência vive menos que auditoria',
    politica.find((x) => x.tipo === 'evidencia')!.dias < politica.find((x) => x.tipo === 'auditoria')!.dias);
  checa('a política mostra o que está guardado hoje',
    politica.find((x) => x.tipo === 'consulta')!.linhas >= 1);

  console.log('\n─── Limpeza ───');
  cfg.definir('retencao.ativa', false, 'teste');
  checa('desligada, a retenção não apaga nada', gov.limparAntigos().length === 0);
  cfg.definir('retencao.ativa', true, 'teste');
  const limpeza = gov.limparAntigos();
  const tipos = limpeza.map((l) => l.tipo);
  checa('apaga consulta fora do prazo', tipos.includes('consulta'), tipos);
  checa('apaga mensagem antiga', tipos.includes('conversa'), tipos);
  checa('apaga chamada antiga', tipos.includes('chamada'), tipos);
  checa('apaga incidente encerrado antigo', tipos.includes('incidente'), tipos);
  checa('mensagem nova continua lá',
    !!db().prepare(`SELECT 1 FROM mensagem WHERE id = 'm-nova'`).get());
  checa('incidente ABERTO não é apagado, por mais velho que seja',
    !!inc.porId(incAberto.id), incAberto.numero);
  checa('o pós-incidente vai junto com o incidente apagado',
    !db().prepare(`SELECT 1 FROM pos_incidente WHERE incidente_id = ?`).get(incVelho.id));
  checa('a linha do tempo do incidente apagado também vai',
    !db().prepare(`SELECT 1 FROM incidente_evento WHERE incidente_id = ?`).get(incVelho.id));
  checa('alerta ligado a incidente vivo sobrevive',
    !!db().prepare(`SELECT 1 FROM alerta WHERE id = ?`).get(aNovo!.id));
  checa('auditoria de 400 dias fica (prazo é maior)',
    !!db().prepare(`SELECT 1 FROM auditoria WHERE acao = 'teste.antigo'`).get());
  cfg.definir('retencao.auditoria_dias', 30, 'teste');
  gov.limparAntigos();
  checa('encurtado o prazo, a auditoria antiga sai',
    !db().prepare(`SELECT 1 FROM auditoria WHERE acao = 'teste.antigo'`).get());
  cfg.definir('retencao.consultas_dias', 0, 'teste');
  checa('prazo 0 significa guardar para sempre',
    !gov.limparAntigos().some((l) => l.tipo === 'consulta'));

  console.log('\n─── Saúde e silêncio ───');
  const s = gov.saude();
  checa('confere a integridade do banco', s.sinais.some((x) => x.nome === 'Banco de dados' && x.ok));
  checa('informa tamanho do banco e cópias', s.banco.mb >= 0 && typeof s.banco.backups === 'number');
  checa('sem backup ainda, o sinal de backup não está ok',
    s.sinais.some((x) => x.nome === 'Backup' && !x.ok));
  cfg.definir('saude.silencio_min', 0, 'teste');
  checa('silêncio desligado não gera sinal', !gov.saude().sinais.some((x) => x.nome === 'Movimento'));
  cfg.definir('saude.silencio_min', 60, 'teste');
  const sil = gov.silencio(new Date(Date.now() + 5 * 3600_000));
  checa('sem monitor ligado, silêncio não é anormal', sil.anormal === false, sil);

  console.log('\n─── Backup conferido ───');
  const b = await gov.fazerBackup();
  checa('a cópia é criada', fs.existsSync(b.arquivo));
  checa('a cópia é ABERTA e conferida', b.verificado && b.integridade === 'ok', b);
  checa('a conferência conta o que tem dentro', b.tabelas > 10, b.tabelas);
  checa('a cópia aparece na lista', gov.listarBackups().some((x) => b.arquivo.endsWith(x.arquivo)));
  const conf = gov.conferirBackup(gov.listarBackups()[0].arquivo);
  checa('dá para conferir de novo depois', conf.ok && conf.tabelas > 10);
  checa('conferir cópia inexistente dá erro claro',
    (() => { try { gov.conferirBackup('nao-existe.db'); return false; } catch (e) { return /não encontrada/.test((e as Error).message); } })());
  cfg.definir('backup.copias', 1, 'teste');
  await gov.fazerBackup(new Date(Date.now() + 61_000));
  checa('só o número configurado de cópias fica', gov.listarBackups().length === 1, gov.listarBackups().length);
  checa('com backup recente, o sinal fica ok',
    gov.saude().sinais.some((x) => x.nome === 'Backup' && x.ok));

  console.log('\n─── Quem acessa o quê ───');
  const acessos = gov.regrasDeAcesso();
  checa('a regra de acesso é escrita e tem os papéis', acessos.length >= 5 && acessos.every((a) => a.pode && a.nao_pode));
  checa('o limite do modo público está declarado',
    acessos.some((a) => /não cadastrado/.test(a.quem) && /SGP/.test(a.nao_pode)));

  console.log('\n─── Rotas ───');
  let r = await api('GET', '/api/governanca');
  checa('a rota traz retenção, saúde, cópias e acessos',
    r.status === 200 && r.j.retencao.length === 7 && !!r.j.saude && Array.isArray(r.j.backups) && r.j.acessos.length >= 5);
  r = await api('POST', '/api/governanca/backup');
  checa('faz backup pela rota e diz se conferiu', r.status === 200 && r.j.ok === true && r.j.backup.verificado);
  const arquivo = gov.listarBackups()[0].arquivo;
  r = await api('POST', `/api/governanca/backup/${arquivo}/conferir`);
  checa('confere uma cópia pela rota', r.status === 200 && r.j.conferencia.ok);
  r = await api('POST', '/api/governanca/backup/nao-existe.db/conferir');
  checa('cópia inexistente devolve 404', r.status === 404);
  r = await api('POST', '/api/governanca/limpeza');
  checa('aplica a retenção pela rota', r.status === 200 && Array.isArray(r.j.limpeza));
  checa('a limpeza manual fica na auditoria',
    !!db().prepare(`SELECT 1 FROM auditoria WHERE acao = 'retencao.limpeza'`).get());
  checa('o backup manual também', !!db().prepare(`SELECT 1 FROM auditoria WHERE acao = 'backup.manual'`).get());

  servidor.close();
  fecharDb();
  console.log(`\n${passou} passaram, ${falhou} falharam\n`);
  process.exit(falhou ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
