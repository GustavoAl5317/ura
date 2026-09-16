// Testes do acesso público ao WhatsApp dos técnicos (modo "rede").
// Banco temporário; nenhuma chamada externa.
//
//   npm run test:publico

import fs from 'fs';
import os from 'os';
import path from 'path';

for (const k of ['OPENAI_API_KEY', 'SGP_BASE_URL', 'SGP_TOKEN']) {
  process.env[k] ||= 'teste-publico-sem-uso';
}
process.env.NETFLOW_ENABLED = '1';
process.env.NETFLOW_URL ||= 'http://127.0.0.1:9';
process.env.EVO_TEC_AUTORIZADOS = '5585911112222';

const RAIZ = __dirname;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aq-publico-'));
process.chdir(dir);

/* eslint-disable @typescript-eslint/no-var-requires */
const { db, fecharDb } = require(path.join(RAIZ, 'src', 'assistant', 'store', 'db')) as typeof import('./src/assistant/store/db');
const cfg = require(path.join(RAIZ, 'src', 'assistant', 'config-dinamica')) as typeof import('./src/assistant/config-dinamica');
const canal = require(path.join(RAIZ, 'src', 'assistant', 'channels', 'whatsapp-tecnicos')) as typeof import('./src/assistant/channels/whatsapp-tecnicos');
const base = require(path.join(RAIZ, 'src', 'assistant', 'tools', 'base')) as typeof import('./src/assistant/tools/base');
const { responder } = require(path.join(RAIZ, 'src', 'assistant', 'agent')) as typeof import('./src/assistant/agent');
const t1 = require(path.join(RAIZ, 'src', 'assistant', 'tools', 'consultas')) as typeof import('./src/assistant/tools/consultas');
const t2 = require(path.join(RAIZ, 'src', 'assistant', 'tools', 'metricas')) as typeof import('./src/assistant/tools/metricas');
const t3 = require(path.join(RAIZ, 'src', 'assistant', 'tools', 'causal')) as typeof import('./src/assistant/tools/causal');
const t4 = require(path.join(RAIZ, 'src', 'assistant', 'tools', 'netflow')) as typeof import('./src/assistant/tools/netflow');
const t5 = require(path.join(RAIZ, 'src', 'assistant', 'tools', 'relatorios')) as typeof import('./src/assistant/tools/relatorios');
/* eslint-enable @typescript-eslint/no-var-requires */

let passou = 0;
let falhou = 0;
function checa(rotulo: string, ok: boolean, detalhe: unknown = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${rotulo}${ok || detalhe === '' ? '' : `\n      ${typeof detalhe === 'string' ? detalhe : JSON.stringify(detalhe).slice(0, 500)}`}`);
  ok ? passou++ : falhou++;
}

const DESCONHECIDO = '5585933334444@s.whatsapp.net';
const DO_ENV = '5585911112222@s.whatsapp.net';
const CADASTRADO = '5585955556666@s.whatsapp.net';
const DESATIVADO = '5585977778888@s.whatsapp.net';

async function main() {
  t1.registrarFerramentas();
  t2.registrarFerramentasMetricas();
  t3.registrarFerramentasCausais();
  t4.registrarFerramentasNetflow();
  t5.registrarFerramentasRelatorios();

  const agora = new Date().toISOString();
  db().prepare(`INSERT INTO permissao (usuario, nome, ativo, criado_em) VALUES (?,?,?,?)`).run(CADASTRADO, 'Ana', 1, agora);
  db().prepare(`INSERT INTO permissao (usuario, nome, ativo, criado_em) VALUES (?,?,?,?)`).run(DESATIVADO, 'Beto', 0, agora);

  console.log('\n─── Quem entra em cada modo ───');
  checa('padrão é "cadastrados"', cfg.obter('whatsapp.acesso') === 'cadastrados');
  checa('cadastrados: desconhecido negado', canal.acessoDoNumero(DESCONHECIDO) === 'negado');
  checa('cadastrados: cadastrado completo', canal.acessoDoNumero(CADASTRADO) === 'completo');
  checa('cadastrados: lista do .env completa', canal.acessoDoNumero(DO_ENV) === 'completo');
  checa('cadastrados: desativado negado', canal.acessoDoNumero(DESATIVADO) === 'negado');

  cfg.definir('whatsapp.acesso', 'rede', 'teste');
  checa('rede: desconhecido vira público', canal.acessoDoNumero(DESCONHECIDO) === 'publico');
  checa('rede: cadastrado segue completo', canal.acessoDoNumero(CADASTRADO) === 'completo');
  checa('rede: desativado continua negado (não vira público)', canal.acessoDoNumero(DESATIVADO) === 'negado');
  checa('rede: autorizado() antigo só vale para completo', !canal.autorizado(DESCONHECIDO) && canal.autorizado(CADASTRADO));

  cfg.definir('whatsapp.acesso', 'aberto', 'teste');
  checa('aberto: desconhecido completo', canal.acessoDoNumero(DESCONHECIDO) === 'completo');
  checa('aberto: desativado continua negado', canal.acessoDoNumero(DESATIVADO) === 'negado');

  let erro = '';
  try { cfg.definir('whatsapp.acesso', 'todos', 'teste'); } catch (e) { erro = (e as Error).message; }
  checa('modo inválido recusado', /precisa ser um de/.test(erro), erro);
  cfg.definir('whatsapp.acesso', 'rede', 'teste');

  console.log('\n─── Fontes do acesso público ───');
  checa('padrão: zabbix e netflow', JSON.stringify(canal.fontesPublicas()) === '["zabbix","netflow"]', canal.fontesPublicas());
  erro = '';
  try { cfg.definir('whatsapp.fontes_publicas', ['zabbix', 'sgp'], 'teste'); } catch (e) { erro = (e as Error).message; }
  checa('painel não consegue abrir o SGP ao público', /sgp/.test(erro), erro);
  erro = '';
  try { cfg.definir('whatsapp.fontes_publicas', ['ura'], 'teste'); } catch (e) { erro = (e as Error).message; }
  checa('nem a URA', /ura/.test(erro), erro);
  // Valor gravado à mão no banco (fora da validação) não passa do teto.
  db().prepare(`UPDATE configuracao SET valor = ? WHERE chave = 'whatsapp.acesso'`).run('"rede"');
  db().prepare(`INSERT INTO configuracao (chave, valor, atualizado_em, atualizado_por) VALUES (?,?,?,?)`)
    .run('whatsapp.fontes_publicas', '["zabbix","sgp","whatsapp"]', agora, 'manual');
  cfg.definir('whatsapp.limite_publico_hora', 2, 'teste');   // limpa o cache
  checa('valor adulterado no banco é cortado ao teto', JSON.stringify(canal.fontesPublicas()) === '["zabbix"]', canal.fontesPublicas());
  cfg.restaurar('whatsapp.fontes_publicas', 'teste');
  checa('limite público é configurável', cfg.obter('whatsapp.limite_publico_hora') === 2);

  console.log('\n─── Ferramentas visíveis ───');
  const publicas = base.ferramentas.disponiveis(['zabbix', 'netflow'], true).map((f) => f.nome);
  const internas = base.ferramentas.disponiveis(['zabbix', 'netflow'], false).map((f) => f.nome);
  for (const n of ['zabbix_onu', 'analisar_pon', 'netflow_consumo_clientes', 'netflow_trafego_ip']) {
    checa(`público não vê ${n}`, !publicas.includes(n) && internas.includes(n), publicas);
  }
  for (const n of ['zabbix_problemas', 'zabbix_links', 'netflow_trafego', 'netflow_ataques', 'clientes_online']) {
    checa(`público vê ${n}`, publicas.includes(n), publicas);
  }
  checa('público não vê nada do SGP', !publicas.some((n) => ['localizar_cliente', 'revisao_cliente', 'analisar_cto', 'os_do_cliente'].includes(n)), publicas);
  checa('sem publico, lista com todas as fontes igual à de antes', base.ferramentas.disponiveis(null).length === base.ferramentas.disponiveis(null, false).length);

  console.log('\n─── Trava central em medir() ───');
  let n = 0;
  const ctx = { proximoId: () => `evd_${++n}`, usuario: DESCONHECIDO, fontesPermitidas: ['zabbix'] as any, publico: true };
  let rodou = false;
  const env = await base.medir(ctx, 'sgp', 'sgp.clientes_da_porta', {}, async () => { rodou = true; return { dados: { nome: 'Fulano' } }; });
  checa('consulta ao SGP por dentro de macro é barrada', !rodou && !env.ok && /bloqueada/.test(env.erro ?? ''), env);
  const env2 = await base.medir(ctx, 'zabbix', 'zabbix.x', {}, async () => ({ dados: { ok: 1 } }));
  checa('fonte liberada segue normal', env2.ok, env2);
  const livre = await base.medir({ ...ctx, fontesPermitidas: null, publico: false }, 'sgp', 'sgp.x', {}, async () => ({ dados: { ok: 1 } }));
  checa('sem restrição (null) nada muda', livre.ok, livre);

  console.log('\n─── IP mascarado ───');
  checa('IPv4', base.mascararIp('177.10.20.30') === '177.10.20.x', base.mascararIp('177.10.20.30'));
  checa('IPv6', base.mascararIp('2804:1a2b:3c4d:1::10') === '2804:1a2b:3c4d::x', base.mascararIp('2804:1a2b:3c4d:1::10'));
  checa('lixo', base.mascararIp('abc') === 'x');

  console.log('\n─── Limite por hora do público (sem chamar a IA) ───');
  const ins = db().prepare(
    `INSERT INTO consulta (id, usuario, canal, pergunta, resposta, veredito, at) VALUES (?,?,?,?,?,?,?)`,
  );
  ins.run('c1', DESCONHECIDO, 'whatsapp', 'p', 'r', 'CONFIRMADO', agora);
  ins.run('c2', DESCONHECIDO, 'whatsapp', 'p', 'r', 'CONFIRMADO', agora);
  const r = await responder({
    pergunta: 'tem ataque?', usuario: DESCONHECIDO, canal: 'whatsapp',
    publico: { fontes: ['zabbix', 'netflow'], limitePorHora: 2 },
  });
  checa('público para no limite próprio (2), não no geral (60)', r.modelo === 'limite' && /Limite de 2/.test(r.texto), r);

  fecharDb();
  console.log(`\n${passou} passaram, ${falhou} falharam\n`);
  process.exit(falhou ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
