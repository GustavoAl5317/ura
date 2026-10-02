// Conversa de 02/10 no WhatsApp que deu errado:
//   "a caixa da rua Araçá" e "caixa 3" não achavam a CTO 3 - R. ARACA;
//   "bairro PCI" não virava Pici;
//   "quais são esses 5 problemas?" respondeu sobre a última caixa, e
//   "temos 5 problemas abertos há mais de 30 dias?" disse que não havia nenhum.
//
//   npm run test:problemas

import fs from 'fs';
import os from 'os';
import path from 'path';

for (const k of ['OPENAI_API_KEY', 'SGP_BASE_URL', 'SGP_TOKEN']) {
  process.env[k] ||= 'teste-problemas-sem-uso';
}
process.env.ZABBIX_ENABLED = 'true';
process.env.ZABBIX_URL ||= 'http://127.0.0.1:1/zabbix';
process.env.QUESTDB_ENABLED = 'true';
process.env.TZ ||= 'America/Fortaleza';
const RAIZ = __dirname;
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'aq-problemas-')));

/* eslint-disable @typescript-eslint/no-var-requires */
const { db, fecharDb } = require(path.join(RAIZ, 'src', 'assistant', 'store', 'db')) as typeof import('./src/assistant/store/db');
const geo = require(path.join(RAIZ, 'src', 'assistant', 'geografia')) as typeof import('./src/assistant/geografia');
const idx = require(path.join(RAIZ, 'src', 'assistant', 'store', 'sgp-index')) as typeof import('./src/assistant/store/sgp-index');
const ctos = require(path.join(RAIZ, 'src', 'assistant', 'tools', 'ctos')) as typeof import('./src/assistant/tools/ctos');
const { zabbix } = require(path.join(RAIZ, 'src', 'integrations', 'zabbix')) as typeof import('./src/integrations/zabbix');
const { ferramentas } = require(path.join(RAIZ, 'src', 'assistant', 'tools', 'base')) as typeof import('./src/assistant/tools/base');
const { registrarFerramentas } = require(path.join(RAIZ, 'src', 'assistant', 'tools', 'consultas')) as typeof import('./src/assistant/tools/consultas');
const { rotasDaPergunta } = require(path.join(RAIZ, 'src', 'assistant', 'rota')) as typeof import('./src/assistant/rota');
/* eslint-enable @typescript-eslint/no-var-requires */

let passou = 0;
let falhou = 0;
function checa(rotulo: string, ok: boolean, detalhe: unknown = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${rotulo}${ok || detalhe === '' ? '' : `\n      ${typeof detalhe === 'string' ? detalhe : JSON.stringify(detalhe).slice(0, 400)}`}`);
  ok ? passou++ : falhou++;
}
const ctx = { proximoId: (() => { let n = 0; return () => `evd_${++n}`; })(), usuario: 'teste', fontesPermitidas: null };

const cto = (cto_id: number, nome: string) => ({
  cto_id, nome, pon: '1', lat: -3.7, long: -38.5, sinal: -20, clientes: 4, portas: 8, ocupacao: 50,
  em: '2026-10-02T12:00:00Z', idadeMin: 5, semLeituraRecente: false,
});

async function main(): Promise<void> {
  db();

  console.log('\n─── Bairro curto ───');
  const bairros = ['PICI', 'PARANGABA', 'BONSUCESSO', 'GENIBAU', 'JOAO XXIII', 'BOM JARDIM'];
  checa('"PCI" é Pici', geo.resolverBairro('PCI', bairros).bairro === 'PICI', geo.resolverBairro('PCI', bairros));
  checa('"Pici" exato continua', geo.resolverBairro('Pici', bairros).bairro === 'PICI');
  checa('nome curto sem parecido não vira bairro', geo.resolverBairro('XYZ', bairros).bairro === null);

  console.log('\n─── Caixa pelo jeito de falar ───');
  const lista = [cto(1, 'CTO 3 - R. ARACA, 194'), cto(2, 'CTO 13 - RUA NOVA, 10'), cto(3, 'CTO 3 - RUA DAS ACACIAS, 50'), cto(4, 'CTO 1 - R. CEL FABRICIANO')];
  const r1 = ctos.resolverCtoAmplo('a caixa da rua Araçá', lista as never);
  checa('"a caixa da rua Araçá" acha a CTO 3 - R. ARACA', r1.cto?.cto_id === 1, r1);
  const r2 = ctos.resolverCtoAmplo('caixa 3 da Araçá', lista as never);
  checa('"caixa 3 da Araçá" também', r2.cto?.cto_id === 1, r2);
  const r3 = ctos.resolverCtoAmplo('caixa 3', lista as never);
  checa('"caixa 3" sozinha pergunta entre as duas CTO 3, sem a 13',
    !r3.cto && r3.candidatas.length === 2 && !r3.candidatas.some((c) => /13/.test(c)), r3);

  const agora = new Date().toISOString();
  for (const [id, nome] of [[1, 'CTO 3 - R. ARACA, 194'], [2, 'CTO 13 - RUA NOVA, 10'], [3, 'CTO 3 - RUA DAS ACACIAS, 50']] as Array<[number, string]>) {
    db().prepare(`INSERT INTO sgp_cliente (cliente_id, nome, atualizado_em) VALUES (?,?,?)`).run(id, `c${id}`, agora);
    db().prepare(`INSERT INTO sgp_contrato (contrato_id, cliente_id, status, atualizado_em) VALUES (?,?,?,?)`).run(id, id, 'Ativo', agora);
    db().prepare(`INSERT INTO sgp_servico (servico_id, contrato_id, cto_nome, atualizado_em) VALUES (?,?,?,?)`).run(id, id, nome, agora);
  }
  checa('no cadastro, "a caixa da rua Araçá" acha a CTO certa', idx.ctosParecidas('a caixa da rua Araçá').join() === 'CTO 3 - R. ARACA, 194', idx.ctosParecidas('a caixa da rua Araçá'));
  checa('no cadastro, "caixa 3" não traz a 13', !idx.ctosParecidas('caixa 3').some((c) => /13/.test(c)), idx.ctosParecidas('caixa 3'));

  console.log('\n─── Problemas por idade ───');
  const dia = 86_400;
  const t = Math.floor(Date.now() / 1000);
  const prob = (id: string, nome: string, diasAtras: number) => ({
    eventid: id, name: nome, severity: '4', clock: String(t - diasAtras * dia), hosts: [{ host: 'h', name: 'NE8K' }],
  });
  const abertos = [
    prob('1', 'CTO 3 - R. ARACA OFF', 40), prob('2', 'CTO 1 - R. CEL FABRICIANO OFF', 90), prob('3', 'BGP peer down', 400),
    prob('4', 'Link ANGOLA down', 0), prob('5', 'CTO 3 - ACACIAS OFF', 0), prob('6', 'Fan fail', 10),
  ];
  (zabbix as any).problemasPorPadroes = async (padroes: string[]) =>
    padroes.length === 1 && !/cto|link|bgp|fan/i.test(padroes[0]) ? [] : abertos;
  registrarFerramentas();
  const problemas = async (args: Record<string, unknown>) => (await ferramentas.get('zabbix_problemas')!.executar(args, ctx))[0] as any;

  let p = await problemas({ idade: 'cronico' });
  checa('"os de mais de 30 dias" lista só os crônicos', p.ok && p.dados.incidentes.length === 3 && p.dados.total === 6, p.dados);
  p = await problemas({ filtro: 'mais de 30 dias' });
  checa('idade escrita no filtro vira idade, não "nenhum"', p.ok && !p.vazio && p.dados.incidentes.length === 3 && p.dados.idade_pedida === 'cronico', p.dados);
  p = await problemas({ filtro: 'novos de hoje' });
  checa('"novos de hoje" no filtro vira idade novo', p.dados.incidentes.length === 2 && p.dados.idade_pedida === 'novo', p.dados);
  p = await problemas({ filtro: 'Xablau' });
  checa('filtro que não casa diz quantos há sem ele', p.vazio && p.dados.sem_esse_filtro?.total_sem_o_filtro === 6 && /NÃO diga que não há problema/.test(p.dados.sem_esse_filtro.instrucao), p.dados);

  console.log('\n─── Rota da pergunta ───');
  const assuntos = (q: string) => rotasDaPergunta(q).map((x) => x.assunto);
  checa('"Temos alguns problema?" vai para a lista', assuntos('Temos alguns problema?').includes('problemas da rede'));
  checa('"Quais são esses 5 problemas?" vai para a lista', assuntos('Quais são esses 5 problemas?').includes('problemas da rede'));
  checa('"Temos 5 problemas abertos a mais de 30 dias?" vai para a lista', assuntos('Temos 5 problemas abertos a mais de 30 dias?').includes('problemas da rede'));
  checa('"problema na caixa da rua Araçá" não vai', !assuntos('Tem algum problema na caixa da rua Araçá?').length);
  checa('"o bairro Bom Sucesso tem problema?" não vai', !assuntos('o bairro Bom Sucesso tem problema?').length);
  checa('"tem problema no link da Angola?" vai para o link', assuntos('tem problema no link da Angola?')[0] === 'link Angola', assuntos('tem problema no link da Angola?'));

  fecharDb();
  console.log(`\n${passou} ok, ${falhou} falha(s)`);
  process.exit(falhou ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
