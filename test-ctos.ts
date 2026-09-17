// Testes da série das CTOs (QuestDB): leitura do sinal, ferramentas, monitor e
// resumo. Sobe um QuestDB falso que responde às consultas pelo formato delas.
//
//   npm run test:ctos

import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import type { AddressInfo } from 'net';

for (const k of ['OPENAI_API_KEY', 'SGP_BASE_URL', 'SGP_TOKEN']) {
  process.env[k] ||= 'teste-ctos-sem-uso';
}
process.env.QUESTDB_ENABLED = '1';
process.env.QUESTDB_TABELA_SINAIS = 'ctos';

// ── QuestDB falso ────────────────────────────────────────────────────────────
interface Cto { id: number; nome: string; pon: string; base: number | null; desvio: number; nBase: number; rec: number | null; clientes: number; portas: number }
const estado = {
  ultimaMin: 3,
  ctos: [] as Cto[],
  queries: [] as string[],
};
function reset(): void {
  estado.ultimaMin = 3;
  estado.ctos = [
    { id: 1, nome: 'CTO 1 - R. ARACA, 10', pon: '5', base: -20, desvio: 0.05, nBase: 2000, rec: -24, clientes: 8, portas: 8 },
    { id: 2, nome: 'CTO 2 - R. ARACA, 20', pon: '5', base: -18, desvio: 0.1, nBase: 2000, rec: -25, clientes: 4, portas: 8 },
    { id: 3, nome: 'CTO 3 R. NOVA', pon: '7', base: -21, desvio: 0.02, nBase: 2000, rec: -21.2, clientes: 16, portas: 16 },
    { id: 4, nome: 'CTO 4 R. SEM LUZ', pon: '7', base: null, desvio: 0, nBase: 0, rec: null, clientes: 2, portas: 8 },
    { id: 5, nome: 'CTO 5 R. OSCILA', pon: '8', base: -22, desvio: 1.5, nBase: 2000, rec: -26, clientes: 7, portas: 8 },
    { id: 6, nome: 'CTO 6 R. NOVA', pon: '9', base: -28, desvio: 0, nBase: 5, rec: -28, clientes: 1, portas: 8 },
  ];
}
reset();

function resposta(q: string): { columns: Array<{ name: string }>; dataset: unknown[][] } {
  const cols = (...n: string[]) => n.map((name) => ({ name }));
  const filtro = q.match(/cto_id = (\d+)/);
  const alvo = filtro ? estado.ctos.filter((c) => c.id === Number(filtro[1])) : estado.ctos;
  const agora = Date.now();
  if (q.includes('max(created_at)')) {
    return { columns: cols('ultima'), dataset: [[estado.ultimaMin === null ? null : new Date(agora - estado.ultimaMin * 60_000).toISOString()]] };
  }
  if (q.includes('LATEST ON')) {
    return {
      columns: cols('cto_id', 'nome', 'pon', 'lat', 'long', 'sinal_medio', 'clientes_ativos', 'total_portas', 'ocupacao_percentual', 'created_at'),
      dataset: estado.ctos.map((c) => [c.id, c.nome, c.pon, -3.7, -38.5, c.rec, c.clientes, c.portas, (c.clientes / c.portas) * 100, new Date(agora - 60_000).toISOString()]),
    };
  }
  if (q.includes('SAMPLE BY')) {
    const c = alvo[0];
    const pts: unknown[][] = [];
    for (let i = 0; i < 24; i++) {
      const v = c && c.base !== null && c.rec !== null ? (i < 18 ? c.base : c.rec) : null;
      pts.push([new Date(agora - (24 - i) * 3600_000).toISOString(), v, v === null ? null : v - 0.3, v]);
    }
    return { columns: cols('created_at', 'media', 'mn', 'mx'), dataset: pts };
  }
  if (q.includes('stddev_samp')) {
    return {
      columns: cols('cto_id', 'media', 'desvio', 'mn', 'mx', 'n'),
      dataset: alvo.map((c) => [c.id, c.base, c.base === null ? null : c.desvio, c.base, c.base, c.nBase]),
    };
  }
  if (q.includes('count(sinal_medio) n')) {
    return { columns: cols('cto_id', 'media', 'n'), dataset: alvo.map((c) => [c.id, c.rec, c.rec === null ? 0 : 6]) };
  }
  throw new Error(`consulta inesperada: ${q}`);
}

const servidor = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const q = url.searchParams.get('query') ?? '';
  estado.queries.push(q);
  try {
    const r = resposta(q);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ query: q, ...r, count: r.dataset.length }));
  } catch (err) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: (err as Error).message }));
  }
});

let passou = 0;
let falhou = 0;
function checa(rotulo: string, ok: boolean, detalhe: unknown = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${rotulo}${ok || detalhe === '' ? '' : `\n      ${typeof detalhe === 'string' ? detalhe : JSON.stringify(detalhe).slice(0, 600)}`}`);
  ok ? passou++ : falhou++;
}

async function main() {
  await new Promise<void>((r) => servidor.listen(0, '127.0.0.1', r));
  process.env.QUESTDB_URL = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;

  const RAIZ = __dirname;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aq-ctos-'));
  process.chdir(dir);
  /* eslint-disable @typescript-eslint/no-var-requires */
  const { db, fecharDb } = require(path.join(RAIZ, 'src', 'assistant', 'store', 'db')) as typeof import('./src/assistant/store/db');
  const q = require(path.join(RAIZ, 'src', 'integrations', 'questdb')) as typeof import('./src/integrations/questdb');
  const t = require(path.join(RAIZ, 'src', 'assistant', 'tools', 'ctos')) as typeof import('./src/assistant/tools/ctos');
  const base = require(path.join(RAIZ, 'src', 'assistant', 'tools', 'base')) as typeof import('./src/assistant/tools/base');
  const mon = require(path.join(RAIZ, 'src', 'assistant', 'monitors', 'ctos')) as typeof import('./src/assistant/monitors/ctos');
  const cfg = require(path.join(RAIZ, 'src', 'assistant', 'config-dinamica')) as typeof import('./src/assistant/config-dinamica');
  const resumo = require(path.join(RAIZ, 'src', 'assistant', 'resumo-diario')) as typeof import('./src/assistant/resumo-diario');
  /* eslint-enable @typescript-eslint/no-var-requires */
  db();
  t.registrarFerramentasCtos();

  let n = 0;
  const ctx = { proximoId: () => `evd_${++n}`, usuario: 'teste', fontesPermitidas: null };
  const rodar = async (nome: string, args: Record<string, unknown>) => {
    q.questdb.limparCache();
    const f = base.ferramentas.get(nome);
    if (!f) throw new Error(`ferramenta ${nome} não registrada`);
    const [e] = await f.executar(args, ctx);
    return e as any;
  };

  console.log('\n─── Leitura do sinal ───');
  const B = (media: number | null, desvio = 0.1, amostras = 500) => ({ cto_id: 1, media, desvio, min: media, max: media, amostras });
  const R = (media: number | null, amostras = 6) => ({ cto_id: 1, media, amostras });
  checa('piorou 4 dB com limiar 3', q.avaliarSinal(R(-24), B(-20), 3).situacao === 'piorou' && q.avaliarSinal(R(-24), B(-20), 3).variacao_db === 4);
  checa('2 dB é estável', q.avaliarSinal(R(-22), B(-20), 3).situacao === 'estavel');
  checa('melhorou', q.avaliarSinal(R(-16), B(-20), 3).situacao === 'melhorou');
  const osc = q.avaliarSinal(R(-26), B(-22, 1.5), 3);
  checa('CTO que oscila usa 3 desvios (4,5 dB): 4 dB não alerta', osc.situacao === 'estavel' && osc.limiar_db === 4.5, osc);
  checa('sem leitura recente = sem_leitura, não 0', q.avaliarSinal(R(null, 0), B(-20), 3).situacao === 'sem_leitura');
  checa('pouca referência = sem_referencia', q.avaliarSinal(R(-30), B(-20, 0, 5), 3).situacao === 'sem_referencia');
  checa('referência nula = sem_referencia', q.avaliarSinal(R(-30), B(null), 3).situacao === 'sem_referencia');

  const serie = [-20, -20, -20, -24, -24, -24].map((m, i) => ({ em: `t${i}`, media: m, min: m, max: m }));
  checa('piorou desde o primeiro ponto do trecho ruim', t.inicioDaPiora(serie, -20, 3) === 't3');
  checa('último ponto normal = sem "desde"', t.inicioDaPiora([...serie, { em: 't6', media: -20, min: -20, max: -20 }], -20, 3) === null);
  checa('pontos sem leitura no fim são ignorados', t.inicioDaPiora([...serie, { em: 't6', media: null, min: null, max: null }], -20, 3) === 't3');

  console.log('\n─── Resolver nome da CTO ───');
  const lista = await q.questdb.ctosAtuais();
  checa('por id', t.resolverCto('3', lista).cto?.cto_id === 3);
  checa('nome exato ignorando caixa e acento', t.resolverCto('cto 3 r. nova', lista).por === 'nome exato');
  checa('aproximado com número decide', t.resolverCto('CTO 5 oscila', lista).cto?.cto_id === 5);
  const amb = t.resolverCto('R. NOVA', lista);
  checa('sem número e dois nomes iguais = pergunta qual', amb.cto === null && amb.candidatas.length === 2, amb);
  checa('número diferente não casa', t.resolverCto('CTO 9 R. NOVA', lista).cto === null);

  console.log('\n─── cto_sinal ───');
  let e = await rodar('cto_sinal', { cto: 'CTO 1 araca' });
  checa('resolve e avalia como piorou', e.ok && e.dados.avaliacao.situacao === 'piorou' && e.dados.avaliacao.variacao_db === 4, e.dados?.avaliacao ?? e.erro);
  checa('diz desde quando (ponto 18 de 24)', typeof e.dados.avaliacao.piorou_desde === 'string', e.dados.avaliacao);
  checa('traz portas livres e mapa', e.dados.atual.portas_livres === 0 && /maps\.google/.test(e.dados.atual.mapa), e.dados.atual);
  checa('horário convertido para -03:00', /-03:00$/.test(e.dados.atual.leitura_em), e.dados.atual.leitura_em);
  e = await rodar('cto_sinal', { cto: 'R. NOVA' });
  checa('ambígua devolve candidatas', e.ok && e.vazio && e.dados.ambiguo && e.dados.candidatas.length === 2, e.dados);
  estado.queries = [];
  e = await rodar('cto_sinal', { cto: "x'; DROP TABLE ctos; --" });
  checa('nome do usuário nunca vai para o SQL', !estado.queries.some((x) => /DROP|x'/.test(x)), estado.queries);
  checa('nome inexistente = vazio com instrução', e.ok && e.vazio && e.dados.resolvida === null, e.dados);
  e = await rodar('cto_sinal', { cto: '4' });
  checa('CTO sem leitura = sem_leitura', e.dados.avaliacao.situacao === 'sem_leitura' && e.dados.atual.sinal_medio_dbm === null, e.dados.avaliacao);

  console.log('\n─── ctos_sinal_piorando ───');
  e = await rodar('ctos_sinal_piorando', {});
  const nomes = e.dados.pioraram.map((x: any) => x.cto_id);
  checa('lista só as que pioraram, pior primeiro', JSON.stringify(nomes) === '[2,1]', e.dados.pioraram);
  checa('conta por situação', e.dados.por_situacao.piorou === 2 && e.dados.por_situacao.estavel === 2 && e.dados.por_situacao.sem_leitura === 1 && e.dados.por_situacao.sem_referencia === 1, e.dados.por_situacao);
  checa('PON com várias CTOs piorando aparece', e.dados.pons_com_varias_ctos_piorando[0]?.pon === '5' && e.dados.pons_com_varias_ctos_piorando[0].ctos_na_pon === 2, e.dados.pons_com_varias_ctos_piorando);
  checa('sinal ruim absoluto inclui a sem referência', e.dados.sinal_ruim_absoluto.ctos.some((x: any) => x.cto_id === 6), e.dados.sinal_ruim_absoluto);
  checa('sem leitura listada pelo nome', e.dados.sem_leitura.includes('CTO 4 R. SEM LUZ'));

  console.log('\n─── ctos_ocupacao ───');
  e = await rodar('ctos_ocupacao', {});
  checa('totais da rede', e.dados.rede.portas === 56 && e.dados.rede.ocupadas === 38 && e.dados.rede.livres === 18 && e.dados.rede.lotadas === 2, e.dados.rede);
  checa('mais cheias primeiro', e.dados.ctos[0].ocupacao_pct === 100, e.dados.ctos[0]);
  e = await rodar('ctos_ocupacao', { ordem: 'mais_livres', limite: 1 });
  checa('mais livres primeiro (CTO 6: 7 livres)', e.dados.ctos[0].cto_id === 6 && e.dados.ctos.length === 1, e.dados.ctos);
  e = await rodar('ctos_ocupacao', { pon: '7' });
  checa('filtro por PON', e.dados.encontradas === 2);
  e = await rodar('ctos_ocupacao', { busca: 'araça' });
  checa('busca ignora acento', e.dados.encontradas === 2, e.dados.encontradas);

  console.log('\n─── Coleta parada ───');
  estado.ultimaMin = 45;
  e = await rodar('ctos_sinal_piorando', {});
  checa('coleta parada = fonte indisponível, não lista vazia', !e.ok && /parada/.test(e.erro), e);
  estado.ultimaMin = 3;

  console.log('\n─── Monitor ───');
  const abertos = () => db().prepare(`SELECT chave, severidade, envio_erro FROM alerta WHERE origem = 'ctos' AND resolvido_em IS NULL`).all() as any[];
  let c = await mon.cicloCtos();
  let ab = abertos();
  checa('ciclo 1: dois avisos individuais', c.alertas === 2 && ab.length === 2, { c, ab });
  checa('7 dB = crítico, 4 dB = aviso', ab.find((a) => a.chave.startsWith('ctos:sinal:2:'))?.severidade === 'critico' && ab.find((a) => a.chave.startsWith('ctos:sinal:1:'))?.severidade === 'aviso', ab);
  c = await mon.cicloCtos();
  checa('ciclo 2: não repete', c.alertas === 0 && abertos().length === 2, c);

  estado.ctos[0].rec = -20.5;   // piora 0,5 < metade do limiar → normalizou
  estado.ctos[1].rec = -19.9;   // piora 1,9 ≥ 1,5 → continua aberto (histerese)
  c = await mon.cicloCtos();
  ab = abertos();
  checa('CTO 1 normalizou: fecha e avisa', c.alertas === 1 && !ab.some((a) => a.chave.startsWith('ctos:sinal:1:')), { c, ab });
  checa('CTO 2 perto do limiar continua aberta (histerese)', ab.some((a) => a.chave.startsWith('ctos:sinal:2:')));
  const normal = db().prepare(`SELECT texto FROM alerta WHERE titulo LIKE 'Sinal normalizado%'`).get() as any;
  checa('mensagem de normalizado com o tempo degradado', /Ficou degradado por/.test(normal?.texto ?? ''), normal);

  // Muitas de uma vez: vira uma mensagem só.
  estado.ctos[0].rec = -26;
  estado.ctos[2].rec = -27;
  estado.ctos[4].rec = -30;
  estado.ctos.push(
    { id: 7, nome: 'CTO 7 R. ARACA, 30', pon: '5', base: -19, desvio: 0.1, nBase: 2000, rec: -23, clientes: 3, portas: 8 },
    { id: 8, nome: 'CTO 8 R. ARACA, 40', pon: '5', base: -19, desvio: 0.1, nBase: 2000, rec: -23, clientes: 3, portas: 8 },
  );
  c = await mon.cicloCtos();
  ab = abertos();
  const grupo = db().prepare(`SELECT texto, envio_erro FROM alerta WHERE chave LIKE 'ctos:sinal:grupo:%'`).get() as any;
  checa('5 novas: uma mensagem agrupada', c.alertas === 1 && !!grupo, { c, grupo });
  checa('agrupada fala da PON com várias CTOs', /PON 5 \(3\)/.test(grupo?.texto ?? '') && /tronco/.test(grupo?.texto ?? ''), grupo?.texto);
  checa('cada CTO ganha registro aberto sem envio próprio', ab.filter((a) => /agrupado/.test(a.envio_erro ?? '')).length === 5, ab);
  checa('a mensagem agrupada não fica "em aberto"', !ab.some((a) => a.chave.startsWith('ctos:sinal:grupo:')));

  // Coleta parada no monitor.
  estado.ultimaMin = 60;
  c = await mon.cicloCtos();
  checa('coleta parada gera aviso', c.alertas === 1 && abertos().some((a) => a.chave.startsWith('ctos:coleta_parada:')), c);
  c = await mon.cicloCtos();
  checa('e não repete', c.alertas === 0);
  checa('com coleta parada não mexe nos avisos de sinal', abertos().filter((a) => a.chave.startsWith('ctos:sinal:')).length === 6);
  estado.ultimaMin = 2;
  c = await mon.cicloCtos();
  checa('coleta voltou: fecha e avisa', !abertos().some((a) => a.chave.startsWith('ctos:coleta_parada:')) && c.alertas >= 1, c);

  cfg.definir('monitor.ctos.alertar_coleta', false, 'teste');
  estado.ultimaMin = 60;
  c = await mon.cicloCtos();
  checa('aviso de coleta desligável', c.alertas === 0 && !abertos().some((a) => a.chave.startsWith('ctos:coleta_parada:')), c);
  estado.ultimaMin = 2;

  console.log('\n─── Resumo diário ───');
  const fim = new Date();
  const r = await resumo.coletarCtos(new Date(fim.getTime() - 86400_000), new Date(fim.getTime() + 1000));
  checa('seção disponível com as que pioraram (CTO 2 voltou para dentro do limiar)', r.disponivel && (r as any).piorando.length === 5, r);
  checa('conta avisos de piora das 24h (sem grupo nem normalizados)', r.disponivel && (r as any).alertas24h === 7, r);
  const texto = resumo.formatarResumo({ inicio: fim.toISOString(), fim: fim.toISOString(), secoes: { ctos: r } });
  checa('texto tem a seção de CTOs', /\*CTOs \(sinal e ocupação\)\*/.test(texto) && /portas livres/.test(texto), texto);
  estado.ultimaMin = 90;
  const parado = await resumo.coletarCtos(new Date(fim.getTime() - 86400_000), fim);
  checa('coleta parada = seção indisponível com motivo', !parado.disponivel && /parada/.test((parado as any).motivo), parado);

  servidor.close();
  fecharDb();
  console.log(`\n${passou} passaram, ${falhou} falharam\n`);
  process.exit(falhou ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
