// Testes das ferramentas da planta da rede (GeoSite): viabilidade de
// instalação e conferência de uma CTO contra o cadastro.
//
//   npm run test:geosite

import fs from 'fs';
import os from 'os';
import path from 'path';

for (const k of ['OPENAI_API_KEY', 'SGP_BASE_URL', 'SGP_TOKEN']) {
  process.env[k] ||= 'teste-geosite-sem-uso';
}
process.env.GEOSITE_ENABLED = 'true';
process.env.GEOSITE_BASE_URL = 'http://127.0.0.1:1/geosite';
process.env.GEOSITE_RAIO_METROS = '600';
process.env.QUESTDB_ENABLED = 'true';
process.env.TZ ||= 'America/Fortaleza';
const RAIZ = __dirname;
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'aq-geosite-')));

/* eslint-disable @typescript-eslint/no-var-requires */
const { db, fecharDb } = require(path.join(RAIZ, 'src', 'assistant', 'store', 'db')) as typeof import('./src/assistant/store/db');
const geo = require(path.join(RAIZ, 'src', 'integrations', 'geosite')) as typeof import('./src/integrations/geosite');
const { geosite } = geo;
const { questdb } = require(path.join(RAIZ, 'src', 'integrations', 'questdb')) as typeof import('./src/integrations/questdb');
const { ferramentas } = require(path.join(RAIZ, 'src', 'assistant', 'tools', 'base')) as typeof import('./src/assistant/tools/base');
const { registrarFerramentasGeosite } = require(path.join(RAIZ, 'src', 'assistant', 'tools', 'geosite')) as typeof import('./src/assistant/tools/geosite');
/* eslint-enable @typescript-eslint/no-var-requires */

let passou = 0;
let falhou = 0;
function checa(rotulo: string, ok: boolean, detalhe: unknown = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${rotulo}${ok || detalhe === '' ? '' : `\n      ${typeof detalhe === 'string' ? detalhe : JSON.stringify(detalhe).slice(0, 400)}`}`);
  ok ? passou++ : falhou++;
}

// ── Dublê do GeoSite ─────────────────────────────────────────────────────────
const caixa = (nome: string, dist: number, livres: number, splitter = 0) =>
  ({ tipoCodigo: nome, distanciaMetros: dist, portasDisponiveis: livres, portasSplitterDisponiveis: splitter, fid: 1 });

let resposta: any = { temCobertura: false, caixasProximas: 0 };
let cabo = false;
const chamadas: Array<{ metodo: string; arg: unknown }> = [];
(geosite as any).viabilidadePorEndereco = async (e: string) => { chamadas.push({ metodo: 'endereco', arg: e }); return resposta; };
(geosite as any).viabilidadePorCep = async (c: string) => { chamadas.push({ metodo: 'cep', arg: c }); return resposta; };
(geosite as any).viabilidadePorCoordenadas = async (la: number, lo: number) => { chamadas.push({ metodo: 'coord', arg: [la, lo] }); return resposta; };
(geosite as any).existeLanceCabo = async () => cabo;

// ── Dublê do QuestDB ─────────────────────────────────────────────────────────
const CTOS = [
  { cto_id: 7, nome: 'ARACA-07', pon: '1/1/1', lat: -3.75, long: -38.6, sinal: -22, clientes: 10, portas: 16, ocupacao: 62.5, em: '2026-10-01T12:00:00Z' },
  { cto_id: 8, nome: 'SEM-COORD', pon: '1/1/2', lat: null, long: null, sinal: -21, clientes: 2, portas: 8, ocupacao: 25, em: '2026-10-01T12:00:00Z' },
  { cto_id: 9, nome: 'ARACA-09', pon: '1/1/3', lat: -3.76, long: -38.61, sinal: -20, clientes: 4, portas: 8, ocupacao: 50, em: '2026-10-01T12:00:00Z' },
  { cto_id: 10, nome: 'CTO - CYBER VIVO, 148', pon: '1/1/4', lat: -3.76439, long: -38.59606, sinal: -23, clientes: 1, portas: 8, ocupacao: 12.5, em: '2026-10-01T12:00:00Z' },
  { cto_id: 11, nome: 'CTO - CYBER NET, 20', pon: '1/1/5', lat: -3.77, long: -38.6, sinal: -23, clientes: 2, portas: 8, ocupacao: 25, em: '2026-10-01T12:00:00Z' },
];
(questdb as any).ctosAtuais = async () => CTOS;
(questdb as any).exigirColetaViva = async () => undefined;

const ctx = { proximoId: (() => { let n = 0; return () => `evd_${++n}`; })(), usuario: 'teste', fontesPermitidas: null };

async function main(): Promise<void> {
  db();
  registrarFerramentasGeosite();
  const via = async (args: Record<string, unknown>) =>
    (await ferramentas.get('viabilidade_instalacao')!.executar(args, ctx))[0] as any;
  const conf = async (args: Record<string, unknown>) =>
    (await ferramentas.get('conferir_caixa_na_planta')!.executar(args, ctx))[0] as any;

  console.log('--- Resposta crua da planta ---');
  // Resposta real da API, copiada de produção: objeto com "caixas", e
  // qtdDisponivel no lugar de qtdTotalDisponivel.
  const crua = {
    success: 'true',
    caixas: [{
      tipoCodigo: 'CTO: CTO - CYBER VIVO, 148', fid: 1824732, distancia: 0,
      geometryCaixaEmenda: 'POINT (-38.59606 -3.76439)',
      qtdDisponivel: 1, qtdOcupada: 0, fidTipoCaixaEmenda: 2, capacidade: 1, qtdClientes: 1,
      qtdSplitter: 1, qtdPortasSplitter: 8, qtdPortasSplitterOcup: 1,
    }],
  };
  checa('resposta em objeto com "caixas" e lida', geo.extrairCaixas(crua).length === 1);
  checa('array cru tambem continua valendo', geo.extrairCaixas([{ tipoCodigo: 'x' }]).length === 1);
  checa('resposta estranha nao quebra', geo.extrairCaixas({ erro: 1 }).length === 0 && geo.extrairCaixas(null).length === 0);
  const c0 = geo.paraCaixa(geo.extrairCaixas(crua)[0]);
  checa('porta livre sai de qtdDisponivel', c0.portasDisponiveis === 1, c0);
  checa('prefixo "CTO:" sai do nome', c0.tipoCodigo === 'CTO - CYBER VIVO, 148', c0.tipoCodigo);
  checa('porta livre do splitter e calculada quando nao vem pronta', c0.portasSplitterDisponiveis === 7, c0);
  checa('capacidade do splitter vem junto', c0.capacidadeSplitter === 8);
  checa('clientes da planta vem junto', c0.clientes === 1);
  checa('coordenada oficial sai do WKT, na ordem certa',
    c0.latitude === -3.76439 && c0.longitude === -38.59606, c0);
  checa('sem geometria, fica sem coordenada',
    geo.paraCaixa({ tipoCodigo: 'y', distancia: 10 } as never).latitude === undefined);
  checa('porta livre sem nenhum campo conhecido e zero, nao NaN',
    geo.paraCaixa({ tipoCodigo: 'y', distancia: 10 } as never).portasDisponiveis === 0);

  console.log('\n─── Registro das ferramentas ───');
  checa('as duas ferramentas existem', !!ferramentas.get('viabilidade_instalacao') && !!ferramentas.get('conferir_caixa_na_planta'));
  checa('a fonte delas é a planta da rede', ferramentas.get('viabilidade_instalacao')!.fonte === 'geosite');
  checa('não aparecem para quem só tem outras fontes',
    !ferramentas.disponiveis(['sgp', 'zabbix'], false).some((f) => f.fonte === 'geosite'));

  console.log('\n─── Viabilidade por endereço ───');
  let e = await via({});
  checa('sem endereço, CEP ou coordenada, recusa', !e.ok && /informe endereço/.test(e.erro), e.erro);

  resposta = { temCobertura: false, caixasProximas: 0 };
  e = await via({ endereco: 'Rua Nenhuma, 1' });
  checa('sem caixa no raio devolve vazio', e.ok && e.vazio === true && e.dados.tem_cobertura === false);
  checa('e diz o raio usado', e.dados.raio_consultado_m === 600, e.dados.raio_consultado_m);
  checa('e proíbe concluir que o endereço é inatendível',
    /NÃO prova/.test(e.dados.instrucao), e.dados.instrucao);

  resposta = {
    temCobertura: true, caixasProximas: 3, totalDisponiveis: 9, distanciaMinMetros: 80,
    portasSplitterDisponiveis: 4,
    caixaSelecionada: caixa('CX-02', 80, 5, 2),
    caixasCobrindo: [caixa('CX-01', 40, 0), caixa('CX-02', 80, 5, 2), caixa('CX-03', 300, 4, 2)],
  };
  e = await via({ endereco: 'Rua Araçá, 123' });
  checa('com cobertura, indica a caixa e a distância',
    e.ok && e.dados.tem_cobertura === true && e.dados.caixa_indicada.caixa === 'CX-02' && e.dados.caixa_indicada.distancia_m === 80, e.dados.caixa_indicada);
  checa('a caixa indicada é a mais próxima COM porta livre, não a mais próxima',
    e.dados.caixa_indicada.caixa !== 'CX-01' && e.dados.outras_caixas_no_raio[0].caixa === 'CX-01');
  checa('soma as portas livres do raio', e.dados.portas_livres_no_raio === 9, e.dados.portas_livres_no_raio);
  checa('por endereço não consulta cabo', e.dados.existe_cabo_proximo === null);
  checa('a nota avisa que é planta, não cadastro', /planta da rede/.test(e.dados.nota));
  checa('o endereço vai inteiro para a planta',
    chamadas.at(-1)!.metodo === 'endereco' && chamadas.at(-1)!.arg === 'Rua Araçá, 123');

  e = await via({ cep: '60.000-000' });
  checa('CEP vai só com os números', chamadas.at(-1)!.metodo === 'cep' && chamadas.at(-1)!.arg === '60000000', chamadas.at(-1));

  resposta = {
    temCobertura: false, caixasProximas: 2, totalDisponiveis: 0,
    caixasCobrindo: [caixa('CX-01', 40, 0), caixa('CX-04', 120, 0)],
  };
  e = await via({ endereco: 'Rua Cheia, 9' });
  checa('todas lotadas não é "sem rede"',
    e.ok && e.vazio !== true && e.dados.caixas_no_raio === 2 && /falta de porta, não falta de rede/.test(e.dados.nota), e.dados.nota);
  checa('e não indica caixa nenhuma', e.dados.caixa_indicada === null);

  cabo = true;
  resposta = { temCobertura: false, caixasProximas: 0 };
  e = await via({ latitude: -3.75, longitude: -38.6 });
  checa('por coordenada, consulta cabo óptico perto', e.dados.existe_cabo_proximo === true);
  checa('e usa a busca por coordenada', chamadas.at(-1)!.metodo === 'existe' || chamadas.some((c) => c.metodo === 'coord'));
  cabo = false;

  console.log('\n─── Conferir caixa contra o cadastro ───');
  e = await conf({ cto: '' });
  checa('sem CTO, recusa', !e.ok && /qual CTO/.test(e.erro), e.erro);
  e = await conf({ cto: 'CTO-QUE-NAO-EXISTE' });
  checa('nome que não casa não vira conclusão', e.vazio === true && e.dados.encontrada === false);
  checa('e manda pedir o nome como está no sistema', /não invente|Não invente/.test(e.dados.instrucao), e.dados.instrucao);
  e = await conf({ cto: 'SEM-COORD' });
  checa('CTO sem coordenada não é localizável na planta',
    e.vazio === true && e.dados.sem_coordenada === true, e.dados);

  // Planta e cadastro concordam: 16 portas, 10 clientes, 6 livres.
  resposta = { temCobertura: true, caixasProximas: 1, caixasCobrindo: [caixa('CX-ARACA-07', 5, 6, 3)] };
  e = await conf({ cto: 'ARACA-07' });
  checa('acha a caixa no ponto da CTO', e.ok && e.dados.planta.caixa === 'CX-ARACA-07' && e.dados.planta.distancia_m === 5);
  checa('mostra os dois lados', e.dados.cadastro.portas_livres === 6 && e.dados.planta.portas_livres === 6);
  checa('quando batem, diz que concordam', e.dados.comparacao.concordam === true && e.dados.comparacao.diferenca_de_portas_livres === 0);
  checa('traz o link do mapa', typeof e.dados.mapa === 'string' && e.dados.mapa.length > 0);

  // Planta com MENOS porta livre: risco de viagem perdida.
  resposta = { temCobertura: true, caixasProximas: 1, caixasCobrindo: [caixa('CX-ARACA-07', 5, 1, 0)] };
  e = await conf({ cto: 'ARACA-07' });
  checa('planta com menos porta aponta o risco',
    e.dados.comparacao.diferenca_de_portas_livres === -5 && /caixa sem vaga/.test(e.dados.comparacao.leitura), e.dados.comparacao);

  // Planta com MAIS porta livre: cadastro atrasado.
  resposta = { temCobertura: true, caixasProximas: 1, caixasCobrindo: [caixa('CX-ARACA-07', 5, 9, 0)] };
  e = await conf({ cto: 'ARACA-07' });
  checa('planta com mais porta sugere cadastro atrasado',
    e.dados.comparacao.diferenca_de_portas_livres === 3 && /cadastro atrasado/.test(e.dados.comparacao.leitura), e.dados.comparacao);

  // Nada na planta dentro do raio.
  resposta = { temCobertura: true, caixasProximas: 1, caixasCobrindo: [caixa('CX-LONGE', 900, 4)] };
  e = await conf({ cto: 'ARACA-07', raio_m: 120 });
  checa('caixa fora do raio não é tratada como a mesma', e.dados.planta === null);
  checa('e as duas explicações possíveis são ditas, sem escolher uma',
    /coordenada errada/.test(e.dados.comparacao.leitura) && /não lançada/.test(e.dados.comparacao.leitura), e.dados.comparacao.leitura);

  resposta = { temCobertura: true, caixasProximas: 3, caixasCobrindo: [caixa('CX-ARACA-07', 5, 6), caixa('CX-VIZINHA', 60, 2), caixa('CX-OUTRA', 110, 0)] };
  e = await conf({ cto: 'ARACA-07' });
  checa('lista as vizinhas do mesmo trecho', e.dados.vizinhas_no_raio.length === 2 && e.dados.vizinhas_no_raio[0].caixa === 'CX-VIZINHA', e.dados.vizinhas_no_raio);
  checa('a CTO do ponto não entra como vizinha',
    !e.dados.vizinhas_no_raio.some((x: any) => x.caixa === 'CX-ARACA-07'));

  console.log('--- Nome como a pessoa fala ---');
  resposta = { temCobertura: true, caixasProximas: 1, caixasCobrindo: [caixa('CX-CYBER', 2, 7, 7)] };
  e = await conf({ cto: 'CYBER VIVO 148' });
  checa('nome sem prefixo e sem pontuacao acha a CTO',
    e.ok && e.dados.cto === 'CTO - CYBER VIVO, 148', { cto: e.dados.cto, por: e.dados.casou_por });
  e = await conf({ cto: 'cyber vivo, 148' });
  checa('com virgula e minuscula tambem acha', e.ok && e.dados.cto === 'CTO - CYBER VIVO, 148');
  e = await conf({ cto: 'cyber' });
  checa('termo ambiguo devolve as candidatas, em vez de escolher',
    e.vazio === true && e.dados.candidatas.length === 2, e.dados.candidatas);
  checa('e manda perguntar qual e', /pergunte qual/.test(e.dados.instrucao), e.dados.instrucao);
  e = await conf({ cto: 'cyber 999' });
  checa('palavra que nao existe no nome nao casa nada', e.vazio === true && e.dados.encontrada === false);

  fecharDb();
  console.log(`\n${passou} passaram, ${falhou} falharam\n`);
  process.exit(falhou ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
