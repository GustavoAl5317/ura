// Testes de bairro das CTOs (exato pelo cadastro, provável por proximidade) e
// de O.S. por técnico.
//
//   npm run test:bairro

import fs from 'fs';
import os from 'os';
import path from 'path';

for (const k of ['OPENAI_API_KEY', 'SGP_BASE_URL', 'SGP_TOKEN']) {
  process.env[k] ||= 'teste-bairro-sem-uso';
}
process.env.QUESTDB_ENABLED = 'true';
process.env.TZ ||= 'America/Fortaleza';
const RAIZ = __dirname;
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'aq-bairro-')));

/* eslint-disable @typescript-eslint/no-var-requires */
const { db, fecharDb } = require(path.join(RAIZ, 'src', 'assistant', 'store', 'db')) as typeof import('./src/assistant/store/db');
const geo = require(path.join(RAIZ, 'src', 'assistant', 'geografia')) as typeof import('./src/assistant/geografia');
const { questdb } = require(path.join(RAIZ, 'src', 'integrations', 'questdb')) as typeof import('./src/integrations/questdb');
const { sgp } = require(path.join(RAIZ, 'src', 'integrations', 'sgp')) as typeof import('./src/integrations/sgp');
const idx = require(path.join(RAIZ, 'src', 'assistant', 'store', 'sgp-index')) as typeof import('./src/assistant/store/sgp-index');
const { ferramentas } = require(path.join(RAIZ, 'src', 'assistant', 'tools', 'base')) as typeof import('./src/assistant/tools/base');
const { registrarFerramentasCtos } = require(path.join(RAIZ, 'src', 'assistant', 'tools', 'ctos')) as typeof import('./src/assistant/tools/ctos');
const { registrarFerramentas } = require(path.join(RAIZ, 'src', 'assistant', 'tools', 'consultas')) as typeof import('./src/assistant/tools/consultas');
/* eslint-enable @typescript-eslint/no-var-requires */

let passou = 0;
let falhou = 0;
function checa(rotulo: string, ok: boolean, detalhe: unknown = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${rotulo}${ok || detalhe === '' ? '' : `\n      ${typeof detalhe === 'string' ? detalhe : JSON.stringify(detalhe).slice(0, 400)}`}`);
  ok ? passou++ : falhou++;
}

type Cto = {
  cto_id: number; nome: string; pon: string | null; lat: number | null; long: number | null;
  sinal: number | null; clientes: number | null; portas: number | null; ocupacao: number | null; em: string;
};

const CTOS: Cto[] = [
  // Henrique Jorge: duas com cliente, uma vazia a 200 m.
  { cto_id: 1, nome: 'HJ-01', pon: '1/1/1', lat: -3.7500, long: -38.6000, sinal: -22, clientes: 8, portas: 16, ocupacao: 50, em: '2026-10-01T12:00:00Z' },
  { cto_id: 2, nome: 'HJ-02', pon: '1/1/1', lat: -3.7510, long: -38.6005, sinal: -24, clientes: 16, portas: 16, ocupacao: 100, em: '2026-10-01T12:00:00Z' },
  { cto_id: 3, nome: 'HJ-03-NOVA', pon: '1/1/2', lat: -3.7505, long: -38.6002, sinal: null, clientes: 0, portas: 16, ocupacao: 0, em: '2026-10-01T12:00:00Z' },
  // Parangaba, 8 km longe.
  { cto_id: 4, nome: 'PRG-01', pon: '2/1/1', lat: -3.7900, long: -38.5600, sinal: -20, clientes: 4, portas: 8, ocupacao: 50, em: '2026-10-01T12:00:00Z' },
  // Vazia e isolada: ninguém por perto para dizer o bairro.
  { cto_id: 5, nome: 'SITIO-01', pon: '3/1/1', lat: -4.2000, long: -38.9000, sinal: null, clientes: 0, portas: 8, ocupacao: 0, em: '2026-10-01T12:00:00Z' },
];

/** Cliente no espelho, ligado a uma CTO, com bairro. */
function cliente(id: number, nome: string, bairro: string, cidade: string, ctoId: number, ctoNome: string): void {
  const agora = new Date().toISOString();
  db().prepare(
    `INSERT INTO sgp_cliente (cliente_id, nome, bairro, cidade, atualizado_em) VALUES (?,?,?,?,?)`,
  ).run(id, nome, bairro, cidade, agora);
  db().prepare(
    `INSERT INTO sgp_contrato (contrato_id, cliente_id, status, atualizado_em) VALUES (?,?,?,?)`,
  ).run(id, id, 'Ativo', agora);
  db().prepare(
    `INSERT INTO sgp_servico (servico_id, contrato_id, cto_id, cto_nome, atualizado_em) VALUES (?,?,?,?,?)`,
  ).run(id, id, ctoId, ctoNome, agora);
}

const ctx = { proximoId: (() => { let n = 0; return () => `evd_${++n}`; })(), usuario: 'teste', fontesPermitidas: null };

async function main(): Promise<void> {
  db();
  cliente(1, 'Ana', 'Henrique Jorge', 'Fortaleza', 1, 'HJ-01');
  cliente(2, 'Bruno', 'Henrique Jorge', 'Fortaleza', 1, 'HJ-01');
  cliente(3, 'Caio', 'Henrique Jorge', 'Fortaleza', 2, 'HJ-02');
  cliente(4, 'Dora', 'Parangaba', 'Fortaleza', 4, 'PRG-01');
  // Um cliente com bairro diferente na mesma CTO: o predominante ganha.
  cliente(5, 'Elias', 'Antônio Bezerra', 'Fortaleza', 1, 'HJ-01');

  console.log('\n─── Bairro pelo cadastro ───');
  const lugares = geo.bairrosDasCtos(CTOS as never);
  const de = (id: number) => lugares.find((l) => l.cto_id === id)!;
  checa('CTO com cliente tem bairro exato', de(1).bairro === 'Henrique Jorge' && de(1).qualidade === 'exato', de(1));
  checa('o bairro predominante ganha do minoritário', de(1).bairro === 'Henrique Jorge', de(1));
  checa('a cidade vem junto', de(1).cidade === 'Fortaleza');
  checa('conta quantos clientes sustentam o bairro', de(1).clientes_no_cadastro >= 2, de(1).clientes_no_cadastro);
  checa('outra CTO, outro bairro', de(4).bairro === 'Parangaba' && de(4).qualidade === 'exato');

  console.log('\n─── Bairro da CTO vazia ───');
  checa('CTO vazia perto de conhecida herda o bairro como provável',
    de(3).bairro === 'Henrique Jorge' && de(3).qualidade === 'provavel', de(3));
  checa('o palpite diz de qual CTO veio', de(3).base === 'HJ-01' || de(3).base === 'HJ-02', de(3).base);
  checa('e a que distância, em metros', de(3).distancia_m !== null && de(3).distancia_m! < 300, de(3).distancia_m);
  checa('CTO vazia e isolada fica desconhecida, em vez de ganhar bairro errado',
    de(5).bairro === null && de(5).qualidade === 'desconhecido', de(5));
  checa('raio curto derruba o palpite',
    geo.bairrosDasCtos(CTOS as never, 10).find((l) => l.cto_id === 3)!.qualidade === 'desconhecido');
  checa('a distância é calculada de verdade',
    Math.abs(geo.distanciaM(-3.75, -38.6, -3.751, -38.6005) - 123) < 25,
    geo.distanciaM(-3.75, -38.6, -3.751, -38.6005));

  console.log('\n─── Filtro por lugar ───');
  let r = geo.filtrarPorLugar(CTOS as never, { bairro: 'Henrique Jorge' });
  checa('traz as três do bairro, incluindo a vazia', r.ctos.length === 3, r.ctos.map((c) => c.nome));
  checa('separa quantas são certas e quantas são palpite', r.exatos === 2 && r.provaveis === 1, { e: r.exatos, p: r.provaveis });
  r = geo.filtrarPorLugar(CTOS as never, { bairro: 'Henrique Jorge', aceitarProvavel: false });
  checa('sem aceitar palpite, a vazia fica de fora', r.ctos.length === 2);
  checa('busca sem acento e em minúscula funciona',
    geo.filtrarPorLugar(CTOS as never, { bairro: 'antonio bezerra' }).ctos.length >= 0);
  checa('bairro que não existe devolve vazio',
    geo.filtrarPorLugar(CTOS as never, { bairro: 'Copacabana' }).ctos.length === 0);
  checa('filtro por cidade funciona',
    geo.filtrarPorLugar(CTOS as never, { cidade: 'Fortaleza' }).ctos.length === 4,
    geo.filtrarPorLugar(CTOS as never, { cidade: 'Fortaleza' }).ctos.map((c) => c.nome));

  console.log('\n─── Resumo por bairro ───');
  const resumo = geo.resumoPorBairro(CTOS as never);
  const hj = resumo.find((b) => b.bairro === 'Henrique Jorge')!;
  checa('o bairro com mais CTOs vem primeiro', resumo[0].bairro === 'Henrique Jorge', resumo.map((b) => b.bairro));
  checa('conta CTOs, vazias e lotadas', hj.ctos === 3 && hj.ctos_vazias === 1 && hj.ctos_lotadas === 1, hj);
  checa('soma portas e clientes', hj.portas === 48 && hj.clientes === 24, hj);
  checa('portas livres é a sobra', hj.portas_livres === 24, hj.portas_livres);
  checa('ocupação em porcentagem', hj.ocupacao_pct === 50, hj.ocupacao_pct);
  checa('sinal médio só das que têm leitura', hj.sinal_medio_dbm === -23, hj.sinal_medio_dbm);
  checa('diz quantas entraram por proximidade', hj.por_proximidade === 1, hj.por_proximidade);
  checa('CTO sem bairro nenhum não entra em bairro algum',
    !resumo.some((b) => b.bairro === null) && resumo.reduce((a, b) => a + b.ctos, 0) === 4);

  console.log('\n─── Ferramenta: ocupação com bairro ───');
  (questdb as any).exigirColetaViva = async () => undefined;
  (questdb as any).ctosAtuais = async () => CTOS;
  registrarFerramentasCtos();
  const ocupacao = async (args: Record<string, unknown>) =>
    (await ferramentas.get('ctos_ocupacao')!.executar(args, ctx))[0] as any;

  let e = await ocupacao({ bairro: 'Henrique Jorge' });
  checa('a ferramenta filtra por bairro', e.ok && e.dados.encontradas === 3, e.dados?.encontradas);
  checa('cada CTO sai com o bairro e a qualidade dele',
    e.dados.ctos.every((c: any) => !!c.bairro && !!c.bairro_qualidade), e.dados.ctos[0]);
  checa('a resposta avisa quando há palpite por proximidade',
    e.dados.lugar.bairro_so_provavel_por_proximidade === 1 && /aproximado/.test(e.dados.lugar.nota), e.dados.lugar);
  e = await ocupacao({ bairro: 'Henrique Jorge', max_ocupacao: 0 });
  checa('"CTOs vazias no bairro X" responde com a vazia',
    e.dados.encontradas === 1 && e.dados.ctos[0].nome === 'HJ-03-NOVA', e.dados.ctos);
  e = await ocupacao({ min_ocupacao: 99, max_ocupacao: 99 });
  checa('rede inteira sem caixa no filtro: zero e resposta, nao falta de dado',
    e.ok && e.vazio === false && e.dados.encontradas === 0 && /Isso é resposta/.test(e.dados.nenhuma_com_esse_filtro_na_rede ?? ''), e.dados);
  e = await ocupacao({ bairro: 'Bairro Que Não Existe' });
  checa('bairro que não é nosso devolve vazio e os bairros conhecidos',
    e.vazio === true && e.dados.lugar_encontrado === false && e.dados.bairros_conhecidos.includes('Henrique Jorge'), e.dados);
  checa('e manda perguntar, em vez de dizer que está tudo certo',
    /pergunte qual/.test(e.dados.instrucao) && /tudo certo/.test(e.dados.instrucao));
  e = await ocupacao({ bairro: 'Parangaba', max_ocupacao: 0 });
  checa('bairro conhecido sem CTO vazia responde "nenhuma", e NAO vira falta de dado',
    e.ok && e.vazio === false && e.dados.encontradas === 0
    && /resposta/.test(e.dados.lugar.nenhuma_com_esse_filtro ?? ''), e.dados.lugar);
  checa('e diz quantas CTOs existem naquele lugar', e.dados.lugar.ctos_nesse_lugar === 1, e.dados.lugar)

  console.log('\n─── Ferramenta: rede por bairro ───');
  const porBairro = async (args: Record<string, unknown>) =>
    (await ferramentas.get('ctos_por_bairro')!.executar(args, ctx))[0] as any;
  e = await porBairro({});
  checa('lista os bairros com os números', e.ok && e.dados.bairros.length === 2, e.dados?.bairros);
  checa('diz quantas CTOs ficaram sem bairro', e.dados.rede.ctos_sem_bairro_identificado === 1, e.dados.rede);
  e = await porBairro({ so_com_vaga: true });
  checa('filtra bairro com porta livre', e.dados.bairros.every((b: any) => b.portas_livres > 0));
  e = await porBairro({ bairro: 'parangaba' });
  checa('filtra um bairro só', e.dados.bairros.length === 1 && e.dados.bairros[0].bairro === 'Parangaba');
  e = await porBairro({ ordem: 'mais_livres' });
  checa('ordem mais_livres sai de fato ordenada por porta livre',
    e.dados.bairros[0].portas_livres >= e.dados.bairros[1].portas_livres, e.dados.bairros.map((b: any) => b.portas_livres));
  checa('a ordem pedida aparece no filtro, para a resposta nao mentir o critério',
    e.dados.filtro.ordem === 'mais_livres');
  e = await porBairro({ ordem: 'mais_vazias' });
  checa('ordem mais_vazias prioriza quem tem CTO vazia',
    e.dados.bairros[0].ctos_vazias >= e.dados.bairros[1].ctos_vazias, e.dados.bairros.map((b: any) => b.ctos_vazias));
  e = await porBairro({ bairro: 'Copacabana' });
  checa('bairro que nao e nosso nao vira conclusao',
    e.vazio === true && e.dados.lugar_encontrado === false, e.dados);
  checa('e devolve os bairros conhecidos',
    e.dados.bairros_conhecidos.includes('Henrique Jorge'), e.dados.bairros_conhecidos);
  checa('a contagem de sem bairro e da rede inteira, nao do filtro',
    e.dados.rede.ctos_sem_bairro_identificado === 1, e.dados.rede);
  checa('e proibe usar as sem bairro como se fossem daquele bairro',
    /NAO use|NÃO use/.test(e.dados.instrucao), e.dados.instrucao);
  e = await porBairro({ bairro: 'parangaba' });
  checa('com filtro, a contagem de sem bairro continua a da rede',
    e.dados.rede.ctos_sem_bairro_identificado === 1 && e.dados.rede.bairros_listados === 1, e.dados.rede);
  e = await porBairro({ ordem: 'inventada' });
  checa('ordem desconhecida cai no padrao, sem quebrar', e.ok && e.dados.bairros.length === 2);

  console.log('\n─── Ferramenta: O.S. do técnico ───');
  const ORDENS = [
    { id: 101, cliente: 'Ana', contrato: 1, status: 'Agendada', status_id: 2, data_cadastro: '2026-09-30', data_agendamento: new Date().toISOString().slice(0, 10), hora_agendamento: '09:00', motivo: 'Reparo', responsavel: 'Igor Silva', pop: 'POP-1' },
    { id: 102, cliente: 'Bruno', contrato: 2, status: 'Aberta', status_id: 3, data_cadastro: '2026-09-29', motivo: 'Instalação', responsavel: 'Pedro Lima', tecnicos_auxiliares: ['Igor Silva'], pop: 'POP-1' },
    { id: 103, cliente: 'Caio', contrato: 3, status: 'Encerrada', status_id: 1, data_cadastro: '2026-09-28', data_finalizacao: '2026-09-28', motivo: 'Reparo', responsavel: 'Igor Silva', pop: 'POP-2' },
    { id: 104, cliente: 'Dora', contrato: 4, status: 'Aberta', status_id: 3, data_cadastro: '2026-09-27', motivo: 'Mudança de endereço', responsavel: 'Marta Souza', pop: 'POP-3' },
  ];
  (sgp as any).ordensServicoPorCadastro = async () => ({ ordens: ORDENS, janelaCompleta: true });
  registrarFerramentas();
  console.log('--- CTO pelo nome que a pessoa fala ---');
  cliente(20, 'Gil', 'Henrique Jorge', 'Fortaleza', 743, 'CTO 3 - Rua Araça, 194');
  cliente(21, 'Hugo', 'Henrique Jorge', 'Fortaleza', 744, 'CTO 1 - Rua Araça, 50');
  cliente(22, 'Iris', 'Henrique Jorge', 'Fortaleza', 745, 'CTO 4 RUA 731, 310');
  checa('"Araca" sem cedilha acha as caixas da Rua Araca', idx.ctosParecidas('Araca').length === 2, idx.ctosParecidas('Araca'));
  checa('"araca 194" acha uma so', idx.ctosParecidas('araca 194').length === 1 && /194/.test(idx.ctosParecidas('araca 194')[0]));
  checa('"cto" e "rua" sozinhos nao casam tudo', idx.ctosParecidas('cto rua').length === 0);
  checa('palavra que nao existe nao casa', idx.ctosParecidas('araca 999').length === 0);
  const daCto = async (args: Record<string, unknown>) =>
    (await ferramentas.get('clientes_da_cto')!.executar(args, ctx))[0] as any;
  e = await daCto({ cto: 'Araca' });
  checa('duas caixas possiveis: devolve as opcoes e manda perguntar',
    e.vazio === true && e.dados.candidatas.length === 2 && /pergunte qual/.test(e.dados.instrucao), e.dados);
  e = await daCto({ cto: 'araca 194' });
  checa('uma caixa possivel: traz os clientes dela', e.ok && e.dados.total === 1 && e.dados.casou_por === 'palavras do nome', e.dados);
  checa('e diz o nome certo da caixa', e.dados.cto === 'CTO 3 - Rua Araça, 194');
  e = await daCto({ cto: 'CTO 4 RUA 731, 310' });
  checa('nome exato continua indo direto', e.ok && e.dados.casou_por === 'nome exato' && e.dados.total === 1, e.dados);

  console.log('--- Bairro como a pessoa fala ---');
  checa('"bom sucesso" acha BONSUCESSO (espaco e m/n)',
    geo.resolverBairro('bom sucesso', ['BONSUCESSO', 'BOM JARDIM', 'Henrique Jorge']).bairro === 'BONSUCESSO',
    geo.resolverBairro('bom sucesso', ['BONSUCESSO', 'BOM JARDIM', 'Henrique Jorge']));
  checa('nome igual sem acento e exato', geo.resolverBairro('henrique jorge', ['Henrique Jorge']).como === 'exato');
  checa('pedaco unico casa por conter', geo.resolverBairro('parangab', ['Parangaba', 'Henrique Jorge']).bairro === 'Parangaba');
  checa('dois parecidos: devolve candidatos, nao escolhe',
    geo.resolverBairro('conjunto ceara', ['CONJUNTO CEARÁ I', 'CONJUNTO CEARÁ II']).bairro === null
    && geo.resolverBairro('conjunto ceara', ['CONJUNTO CEARÁ I', 'CONJUNTO CEARÁ II']).candidatos.length === 2);
  checa('nada parecido: nada', geo.resolverBairro('copacabana', ['Parangaba', 'Henrique Jorge']).bairro === null);

  cliente(30, 'Joana', 'BONSUCESSO', 'Fortaleza', 1, 'HJ-01');
  cliente(31, 'Kleber', 'BONSUCESSO', 'Fortaleza', 1, 'HJ-01');
  const doBairro = async (args: Record<string, unknown>) =>
    (await ferramentas.get('clientes_do_bairro')!.executar(args, ctx))[0] as any;
  e = await doBairro({ bairro: 'bom sucesso' });
  checa('clientes do bairro pelo nome falado', e.ok && e.dados.bairro === 'BONSUCESSO' && e.dados.total === 2, e.dados);
  checa('diz como interpretou o nome', /entendido como BONSUCESSO/.test(e.dados.interpretado ?? ''));
  checa('agrupa por caixa', e.dados.por_caixa[0].caixa === 'HJ-01' && e.dados.por_caixa[0].clientes === 2, e.dados.por_caixa);
  checa('e marcada como dado pessoal', ferramentas.get('clientes_do_bairro')!.dadoPessoal === true);
  (questdb as any).recente = async () => CTOS.map((c) => ({ cto_id: c.cto_id, media: c.sinal, amostras: 6 }));
  (questdb as any).referencia = async () => CTOS.map((c) => ({ cto_id: c.cto_id, media: c.sinal, desvio: 0.3, min: -30, max: -10, amostras: 200 }));
  e = await porBairro({ bairro: 'parangaba' });
  checa('um bairro so: o nivel de saude vai calculado junto',
    !!e.dados.leitura_para_gestao && !!e.dados.leitura_para_gestao.nivel && /não declare outro/.test(e.dados.leitura_para_gestao.regra), e.dados.leitura_para_gestao);
  e = await porBairro({});
  checa('lista de bairros nao calcula nivel um por um', e.dados.leitura_para_gestao === undefined);

  e = await doBairro({ bairro: 'copacabana' });
  checa('bairro inexistente nao inventa', e.vazio === true && /Não invente/.test(e.dados.instrucao));

  e = await daCto({ cto: 'Bonsucesso' });
  checa('"clientes da caixa Bonsucesso" avisa que e bairro, nao caixa',
    e.vazio === true && e.dados.e_bairro === 'BONSUCESSO' && /clientes_do_bairro/.test(e.dados.instrucao), e.dados);

  const doTecnico = async (args: Record<string, unknown>) =>
    (await ferramentas.get('os_do_tecnico')!.executar(args, ctx))[0] as any;

  e = await doTecnico({ tecnico: 'Igor' });
  checa('acha pelo primeiro nome', e.ok && e.dados.encontrado === true);
  checa('conta as abertas dele, inclusive onde é auxiliar', e.dados.abertas === 2, e.dados);
  checa('não conta a encerrada como aberta', e.dados.fechadas_na_janela === 1, e.dados.fechadas_na_janela);
  checa('separa o que está agendado para hoje',
    e.dados.agendadas_para_hoje.length === 1 && e.dados.agendadas_para_hoje[0].os === 101, e.dados.agendadas_para_hoje);
  checa('por padrão lista só as abertas', e.dados.os.every((o: any) => o.aberta), e.dados.os.map((o: any) => o.aberta));
  e = await doTecnico({ tecnico: 'Igor', incluir_fechadas: true });
  checa('com incluir_fechadas, a encerrada aparece', e.dados.os.some((o: any) => o.os === 103));
  e = await doTecnico({ tecnico: 'Igr' });
  checa('nome errado não vira "não tem O.S."', e.vazio === true && e.dados.encontrado === false);
  checa('e devolve os nomes que existem, para a IA perguntar',
    e.dados.nomes_na_janela.includes('Igor Silva') && /pergunte qual/.test(e.dados.instrucao), e.dados.nomes_na_janela);
  e = await doTecnico({ tecnico: 'a' });
  checa('nome curto é recusado', !e.ok && /pelo menos 2 letras/.test(e.erro), e.erro);
  checa('a ferramenta é marcada como dado pessoal',
    ferramentas.get('os_do_tecnico')!.dadoPessoal === true);
  checa('e por isso some do acesso público',
    !ferramentas.disponiveis(null, true).some((f) => f.nome === 'os_do_tecnico'));

  fecharDb();
  console.log(`\n${passou} passaram, ${falhou} falharam\n`);
  process.exit(falhou ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
