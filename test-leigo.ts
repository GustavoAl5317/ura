// Testes das perguntas de leigo que vieram erradas no WhatsApp em 01/10/2026:
// nome de bairro mal ouvido no áudio, caixa de emenda, endereço da caixa,
// caixa com um cliente só, casos e cancelamentos por bairro, rede da RNP.
//
//   npm run test:leigo

import fs from 'fs';
import os from 'os';
import path from 'path';

for (const k of ['OPENAI_API_KEY', 'SGP_BASE_URL', 'SGP_TOKEN']) {
  process.env[k] ||= 'teste-leigo-sem-uso';
}
process.env.QUESTDB_ENABLED = 'true';
process.env.GEOSITE_ENABLED = 'true';
process.env.GEOSITE_BASE_URL = 'http://127.0.0.1:1/geosite';
process.env.TZ ||= 'America/Fortaleza';
const RAIZ = __dirname;
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'aq-leigo-')));

/* eslint-disable @typescript-eslint/no-var-requires */
const { db, fecharDb } = require(path.join(RAIZ, 'src', 'assistant', 'store', 'db')) as typeof import('./src/assistant/store/db');
const geo = require(path.join(RAIZ, 'src', 'assistant', 'geografia')) as typeof import('./src/assistant/geografia');
const glo = require(path.join(RAIZ, 'src', 'assistant', 'glossario')) as typeof import('./src/assistant/glossario');
const gs = require(path.join(RAIZ, 'src', 'integrations', 'geosite')) as typeof import('./src/integrations/geosite');
const { questdb } = require(path.join(RAIZ, 'src', 'integrations', 'questdb')) as typeof import('./src/integrations/questdb');
const { sgp } = require(path.join(RAIZ, 'src', 'integrations', 'sgp')) as typeof import('./src/integrations/sgp');
const { ferramentas } = require(path.join(RAIZ, 'src', 'assistant', 'tools', 'base')) as typeof import('./src/assistant/tools/base');
const { registrarFerramentasCtos } = require(path.join(RAIZ, 'src', 'assistant', 'tools', 'ctos')) as typeof import('./src/assistant/tools/ctos');
const { registrarFerramentas } = require(path.join(RAIZ, 'src', 'assistant', 'tools', 'consultas')) as typeof import('./src/assistant/tools/consultas');
const { registrarFerramentasRelatorios } = require(path.join(RAIZ, 'src', 'assistant', 'tools', 'relatorios')) as typeof import('./src/assistant/tools/relatorios');
const { registrarFerramentasGeosite } = require(path.join(RAIZ, 'src', 'assistant', 'tools', 'geosite')) as typeof import('./src/assistant/tools/geosite');
const { nomesDoLink } = require(path.join(RAIZ, 'src', 'assistant', 'tools', 'metricas')) as typeof import('./src/assistant/tools/metricas');
/* eslint-enable @typescript-eslint/no-var-requires */

let passou = 0;
let falhou = 0;
function checa(rotulo: string, ok: boolean, detalhe: unknown = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${rotulo}${ok || detalhe === '' ? '' : `\n      ${typeof detalhe === 'string' ? detalhe : JSON.stringify(detalhe).slice(0, 400)}`}`);
  ok ? passou++ : falhou++;
}

const ctx = { proximoId: (() => { let n = 0; return () => `evd_${++n}`; })(), usuario: 'teste', fontesPermitidas: null };

// Bairros de verdade de Fortaleza, para o "pelo som" não escolher errado.
const BAIRROS = [
  'BONSUCESSO', 'BOM FUTURO', 'BOM JARDIM', 'GRANJA PORTUGAL', 'GRANJA LISBOA', 'JOAO XXIII',
  'CONJUNTO CEARA I', 'CONJUNTO CEARA II', 'PARANGABA', 'HENRIQUE JORGE', 'JARDIM GUANABARA',
  'JARDIM CEARENSE', 'VILA PERI', 'SIQUEIRA', 'CANINDEZINHO', 'BARRA DO CEARA', 'MONDUBIM',
  'MARAPONGA', 'CONJUNTO ESPERANCA', 'PRESIDENTE KENNEDY', 'PICI', 'PAN AMERICANO', 'DEMOCRITO ROCHA',
  'JOQUEI CLUBE', 'AUTRAN NUNES', 'DOM LUSTOSA', 'QUINTINO CUNHA', 'GENIBAU', 'ANTONIO BEZERRA',
  'PADRE ANDRADE', 'BELA VISTA', 'COUTO FERNANDES', 'PARQUE SAO JOSE', 'PARQUE DOIS IRMAOS',
  'PASSARE', 'PLANALTO AYRTON SENNA', 'PRAIA DO FUTURO I', 'PRAIA DO FUTURO II', 'VICENTE PINZON',
  'MUCURIPE',
];

type Cto = {
  cto_id: number; nome: string; pon: string | null; lat: number | null; long: number | null;
  sinal: number | null; clientes: number | null; portas: number | null; ocupacao: number | null; em: string;
  idadeMin: number; semLeituraRecente: boolean;
};
const cto = (cto_id: number, nome: string, lat: number, long: number, clientes: number, sinal: number | null = -22): Cto => ({
  cto_id, nome, pon: '1/1/1', lat, long, sinal, clientes, portas: 16, ocupacao: Math.round((clientes / 16) * 100),
  em: '2026-10-01T12:00:00Z', idadeMin: 5, semLeituraRecente: false,
});

const CTOS: Cto[] = [
  cto(1, 'BSC-01', -3.7800, -38.5900, 1),
  cto(2, 'BSC-02', -3.7810, -38.5905, 2),
  cto(3, 'BSC-03', -3.7820, -38.5910, 9),
  cto(4, 'GPT-01', -3.7900, -38.6100, 1),
  cto(5, 'PRG-01', -3.7750, -38.5650, 5),
];

function cliente(id: number, nome: string, bairro: string, ctoId: number, ctoNome: string, rua: string, numero: string): void {
  const agora = new Date().toISOString();
  db().prepare(
    `INSERT INTO sgp_cliente (cliente_id, nome, bairro, cidade, logradouro, numero, atualizado_em) VALUES (?,?,?,?,?,?,?)`,
  ).run(id, nome, bairro, 'Fortaleza', rua, numero, agora);
  db().prepare(`INSERT INTO sgp_contrato (contrato_id, cliente_id, status, atualizado_em) VALUES (?,?,?,?)`).run(id, id, 'Ativo', agora);
  db().prepare(
    `INSERT INTO sgp_servico (servico_id, contrato_id, cto_id, cto_nome, atualizado_em) VALUES (?,?,?,?,?)`,
  ).run(id, id, ctoId, ctoNome, agora);
}

async function main(): Promise<void> {
  db();

  console.log('\n─── Bairro dito por voz ───');
  const r = (t: string) => geo.resolverBairro(t, BAIRROS);
  checa('"Bolsa Fesso" é Bom Sucesso (transcrição do áudio)', r('Bolsa Fesso').bairro === 'BONSUCESSO', r('Bolsa Fesso'));
  checa('e avisa que foi pelo som', r('Bolsa Fesso').como === 'pelo_som', r('Bolsa Fesso').como);
  checa('"bom sucesso" é BONSUCESSO', r('bom sucesso').bairro === 'BONSUCESSO', r('bom sucesso'));
  checa('"Grande Portugal" é Granja Portugal', r('Grande Portugal').bairro === 'GRANJA PORTUGAL', r('Grande Portugal'));
  checa('"Grande Lisboa" é Granja Lisboa', r('Grande Lisboa').bairro === 'GRANJA LISBOA', r('Grande Lisboa'));
  checa('"João 23" é JOAO XXIII', r('João 23').bairro === 'JOAO XXIII', r('João 23'));
  checa('"Conjunto Ceará segunda etapa" é CONJUNTO CEARA II',
    r('Conjunto Ceará segunda etapa').bairro === 'CONJUNTO CEARA II', r('Conjunto Ceará segunda etapa'));
  checa('"conjunto ceara 2ª etapa" também', r('conjunto ceara 2ª etapa').bairro === 'CONJUNTO CEARA II', r('conjunto ceara 2ª etapa'));
  checa('"Bom Futuro" não vira Bom Sucesso', r('Bom Futuro').bairro === 'BOM FUTURO', r('Bom Futuro'));
  checa('"Bom Jardim" fica Bom Jardim', r('Bom Jardim').bairro === 'BOM JARDIM', r('Bom Jardim'));
  checa('"Jardim Guanabara" exato', r('Jardim Guanabara').bairro === 'JARDIM GUANABARA');
  checa('"Henrique Jorge" exato', r('Henrique Jorge').bairro === 'HENRIQUE JORGE');
  checa('"jd guanabara" pela abreviação', r('jd guanabara').bairro === 'JARDIM GUANABARA', r('jd guanabara'));
  checa('bairro que não temos não vira outro', r('Copacabana').bairro === null, r('Copacabana'));
  checa('"Montese" (não está na lista) não vira outro', r('Montese').bairro === null, r('Montese'));
  checa('"Praia do Futuro" com duas partes pergunta qual',
    r('Praia do Futuro').bairro === null && r('Praia do Futuro').candidatos.length === 2, r('Praia do Futuro'));
  checa('chave do som junta ss, ç e c', geo.chaveFalada('Bonsucesso') === geo.chaveFalada('bom sucesso'));
  checa('número romano e algarismo dão a mesma chave', geo.chaveFalada('JOAO XXIII') === geo.chaveFalada('joão 23'));

  console.log('\n─── Rua ───');
  checa('"rua bias mendes" casa com "R BIAS MENDES"', geo.ruaCasa('rua bias mendes', 'R BIAS MENDES'));
  checa('"Rua Bias Mendes" não casa com outra rua', !geo.ruaCasa('Rua Bias Mendes', 'RUA BARAO DE ARACATI'));
  checa('"av osorio de paiva" casa com "AVENIDA OSÓRIO DE PAIVA"', geo.ruaCasa('av osorio de paiva', 'AVENIDA OSÓRIO DE PAIVA'));
  checa('"rua" sozinha não casa com tudo', !geo.ruaCasa('rua', 'RUA X'));

  // Cadastro: BSC-01 tem 1 cliente na Bias Mendes; BSC-02 tem 2 (um na Bias
  // Mendes); BSC-03 tem 3 na Rua Alfa; GPT-01, 1 na Granja Portugal.
  cliente(1, 'Ana', 'BONSUCESSO', 1, 'BSC-01', 'R BIAS MENDES', '100');
  cliente(2, 'Bia', 'BONSUCESSO', 2, 'BSC-02', 'R BIAS MENDES', '240');
  cliente(3, 'Caio', 'BONSUCESSO', 2, 'BSC-02', 'RUA ALFA', '10');
  cliente(4, 'Dora', 'BONSUCESSO', 3, 'BSC-03', 'RUA ALFA', '12');
  cliente(5, 'Edu', 'BONSUCESSO', 3, 'BSC-03', 'RUA ALFA', '30');
  cliente(6, 'Fia', 'BONSUCESSO', 3, 'BSC-03', 'RUA BETA', '5');
  cliente(7, 'Gil', 'GRANJA PORTUGAL', 4, 'GPT-01', 'RUA GAMA', '77');
  cliente(8, 'Hugo', 'PARANGABA', 5, 'PRG-01', 'AV JOAO PESSOA', '5000');

  console.log('\n─── Endereço da caixa ───');
  const e3 = geo.enderecoDaCto({ cto_id: 3, nome: 'BSC-03' });
  checa('a rua é a da maioria dos clientes', e3?.rua === 'RUA ALFA', e3);
  checa('com a faixa de números', e3?.numeros === '12 a 30', e3?.numeros);
  checa('e a conta de quantos moram nela', e3?.clientes_na_rua === 2 && e3?.clientes_total === 3, e3);
  checa('em texto, para a resposta', /RUA ALFA, 12 a 30 - BONSUCESSO \(2 de 3 clientes/.test(geo.enderecoEmTexto(e3) ?? ''), geo.enderecoEmTexto(e3));
  checa('CTO sem cliente não ganha rua inventada', geo.enderecoDaCto({ cto_id: 99, nome: 'NADA' }) === null);

  console.log('\n─── Ferramenta: caixa com um cliente, por bairro e por rua ───');
  (questdb as any).exigirColetaViva = async () => undefined;
  (questdb as any).ctosAtuais = async () => CTOS;
  registrarFerramentasCtos();
  const ocupacao = async (args: Record<string, unknown>) =>
    (await ferramentas.get('ctos_ocupacao')!.executar(args, ctx))[0] as any;

  let o = await ocupacao({ bairro: 'Bolsa Fesso', min_clientes: 1, max_clientes: 1 });
  checa('"caixas com só um cliente no Bolsa Fesso" acha a BSC-01',
    o.ok && o.dados.ctos.length === 1 && o.dados.ctos[0].nome === 'BSC-01', o.dados?.ctos?.map((c: any) => c.nome));
  checa('e diz que entendeu Bom Sucesso', o.dados.lugar?.bairro_interpretado?.entendido === 'BONSUCESSO', o.dados.lugar);
  checa('cada caixa sai com o endereço provável', /R BIAS MENDES/.test(o.dados.ctos[0].endereco_provavel ?? ''), o.dados.ctos[0]);
  o = await ocupacao({ bairro: 'bom sucesso', max_clientes: 2 });
  checa('"quantas têm até dois clientes" acha duas', o.dados.ctos.length === 2, o.dados.ctos.map((c: any) => c.nome));
  o = await ocupacao({ rua: 'Rua Bias Mendes', min_clientes: 1, max_clientes: 1 });
  checa('"caixa com um cliente na Rua Bias Mendes" acha a BSC-01',
    o.ok && o.dados.ctos.length === 1 && o.dados.ctos[0].nome === 'BSC-01', o.dados?.ctos?.map((c: any) => c.nome));
  o = await ocupacao({ rua: 'Rua Bias Mendes' });
  checa('todas as caixas que atendem a rua', o.dados.ctos.length === 2, o.dados.ctos.map((c: any) => c.nome));
  checa('com quantos clientes daquela rua cada uma', o.dados.ctos.every((c: any) => c.clientes_na_rua === 1), o.dados.ctos);
  o = await ocupacao({ rua: 'Rua das Flores Inexistentes' });
  checa('rua que não está no cadastro pede referência, sem dizer que não tem caixa',
    o.vazio && o.dados.rua_encontrada === false && /refer/.test(o.dados.instrucao), o.dados);

  console.log('\n─── Casos (O.S.) por bairro ───');
  (sgp as any).ordensServicoAbertas = async () => ({
    abertas: [
      { id: 1, cliente: 'Ana', contrato: 1, status: 'Aberta', status_id: 0, data_cadastro: '2026-10-01', motivo: 'Sem acesso' },
      { id: 2, cliente: 'Gil', contrato: 7, status: 'Aberta', status_id: 0, data_cadastro: '2026-10-01', motivo: 'Lentidão' },
      { id: 3, cliente: 'Fora', contrato: 999, status: 'Aberta', status_id: 0, data_cadastro: '2026-10-01', motivo: 'Instalação' },
    ],
    examinadas: 3, janelaCompleta: true,
  });
  registrarFerramentas();
  const osAbertas = async (args: Record<string, unknown>) =>
    (await ferramentas.get('os_abertas_na_rede')!.executar(args, ctx))[0] as any;
  let a = await osAbertas({ bairro: 'Grande Portugal' });
  checa('"casos na Grande Portugal" traz a O.S. da Granja Portugal',
    a.ok && a.dados.total_abertas === 1 && a.dados.amostra[0].id === 2, a.dados);
  checa('e diz o bairro entendido', a.dados.bairro_interpretado?.entendido === 'GRANJA PORTUGAL', a.dados.bairro_interpretado);
  checa('conta as O.S. de contrato sem bairro conhecido', a.dados.os_sem_bairro_conhecido === 1, a.dados.os_sem_bairro_conhecido);
  a = await osAbertas({ bairro: 'Parangaba' });
  checa('bairro sem O.S. aberta é "nenhuma", não "não sei"', a.ok && !a.vazio && a.dados.total_abertas === 0 && !!a.dados.nenhuma_no_bairro, a);
  a = await osAbertas({ bairro: 'Copacabana' });
  checa('bairro que não temos pede qual é', a.vazio && a.dados.bairro_encontrado === false, a.dados);

  console.log('\n─── Cancelamentos por bairro, hoje ───');
  const hoje = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Fortaleza' });
  (sgp as any).ordensServicoPorCadastro = async () => ({
    ordens: [
      { id: 10, cliente: 'Ana', contrato: 1, status: 'Encerrada', status_id: 1, data_cadastro: hoje, hora_cadastro: '09:00:00', motivo: 'Cancelamento', tipo: 'Retirada' },
      { id: 11, cliente: 'Gil', contrato: 7, status: 'Aberta', status_id: 0, data_cadastro: hoje, hora_cadastro: '10:00:00', motivo: 'Cancelamento', tipo: 'Retirada' },
    ],
    janelaCompleta: true,
  });
  registrarFerramentasRelatorios();
  const canc = async (args: Record<string, unknown>) => (await ferramentas.get('relatorio_cancelamentos')!.executar(args, ctx)) as any[];
  let c = await canc({ bairro: 'Bolsa Fesso', so_hoje: true });
  checa('"cancelamentos hoje no Bolsa Fesso" conta só o do Bom Sucesso',
    c[0].ok && c[0].dados.os_de_cancelamento_ou_retirada.total === 1, c[0].dados ?? c[0].erro);
  checa('o período é só hoje', c[0].dados.periodo.de === hoje && c[0].dados.periodo.ate === hoje, c[0].dados.periodo);
  checa('e diz o bairro entendido', c[0].dados.bairro_interpretado?.entendido === 'BONSUCESSO');
  c = await canc({ bairro: 'Parangaba', so_hoje: true });
  checa('bairro sem cancelamento hoje é zero, não "não sei"',
    c[0].ok && !c[0].vazio && c[0].dados.os_de_cancelamento_ou_retirada.total === 0, c[0]);
  c = await canc({ bairro: 'Copacabana' });
  checa('bairro que não existe não vira "zero cancelamentos"', !c[0].ok && /não encontrado/.test(c[0].erro ?? ''), c[0]);

  console.log('\n─── Vocabulário ───');
  checa('semente nova entra num banco vazio', glo.semear() === glo.SEMENTE.length);
  const termos = (p: string) => glo.termosEncontrados(p).map((t) => t.termo);
  checa('"caixas de emenda na Parangaba" é caixa de emenda', termos('Quantas caixas de emenda nós temos na Parangaba?').includes('caixa de emenda'), termos('Quantas caixas de emenda nós temos na Parangaba?'));
  checa('e NÃO é a caixinha (CTO)', !termos('Quantas caixas de emenda nós temos na Parangaba?').includes('caixinha'));
  checa('"CLO" é caixa de emenda', termos('caixas de emenda, CLO, né? CLO').includes('caixa de emenda'));
  checa('"a caixa do poste" continua sendo CTO', termos('a caixa do poste parou').includes('caixinha'));
  checa('"rede da RNP" é a RNP, não rede de bairro',
    termos('Como é que tá a rede da RNP?').includes('RNP') && !termos('Como é que tá a rede da RNP?').includes('rede do bairro'),
    termos('Como é que tá a rede da RNP?'));
  checa('"Anetice" é a Etice', termos('A rede da Anetice, rede da RNP.').includes('Etice'), termos('A rede da Anetice, rede da RNP.'));
  checa('"rede do bom sucesso" é rede de bairro', termos('Me conta como está a rede do bom sucesso').includes('rede do bairro'));
  checa('"luz alta" é sinal', termos('Quantas CTOs nós temos com luz alta?').includes('luz da caixa'));
  checa('"faltou luz" continua energia', termos('faltou luz no bairro').includes('faltou luz'));
  checa('"casos no bairro" são O.S.', termos('Quais são os casos que tem no bairro Jardim Guanabara?').includes('casos'));
  checa('"cancelamentos" acha o termo', termos('quantos cancelamentos tiveram hoje?').includes('cancelamento'));
  checa('"Angola Cable Hotel Cables" acha Angola', termos('Ponto de referência em frente ao datacenter da Angola Cable, Hotel Cable').includes('Angola Cables'));

  const rnp = glo.listar().find((t) => t.termo === 'RNP')!;
  const etice = glo.listar().find((t) => t.termo === 'Etice')!;
  glo.remover(etice.id, 'teste');
  db().prepare(`DELETE FROM glossario WHERE id = ?`).run(rnp.id);
  checa('deploy novo traz de volta termo que faltava', glo.semear() === 1 && glo.listar().some((t) => t.termo === 'RNP'));
  checa('mas não ressuscita termo que a casa apagou', !glo.listar().some((t) => t.termo === 'Etice'));

  console.log('\n─── Nomes do link ───');
  checa('"rede da RNP" procura também GigaFOR', nomesDoLink('rede da RNP').includes('gigafor'), nomesDoLink('rede da RNP'));
  checa('"Anetice" procura etice e cinturao', ['etice', 'cinturao'].every((n) => nomesDoLink('Anetice').includes(n)), nomesDoLink('Anetice'));
  checa('"Angola" fica angola', nomesDoLink('Angola').includes('angola'));
  checa('nome desconhecido procura só ele', nomesDoLink('seaborn').length === 1);
  checa('"rnp" não casa dentro de outra palavra', nomesDoLink('turnpike').length === 1, nomesDoLink('turnpike'));

  console.log('\n─── Planta: leitura de registros ───');
  checa('/list com records', gs.extrairRegistros({ total: 2, records: [{ fid: 1 }, { fid: 2 }] }).registros.length === 2);
  checa('o total vem do corpo', gs.extrairRegistros({ total: 150, records: [{ fid: 1 }] }).total === 150);
  checa('array cru também', gs.extrairRegistros([{ fid: 1 }]).registros.length === 1);
  checa('corpo estranho vira vazio, não erro', gs.extrairRegistros({ ok: true }).registros.length === 0);
  checa('/desc vira nomes de coluna', gs.extrairColunas({ columns: [{ name: 'fid' }, { name: 'codigo' }] }).join() === 'fid,codigo');
  checa('coordenada por latitude/longitude', gs.coordenadaDe({ latitude: -3.7, longitude: -38.5 }).latitude === -3.7);
  checa('coordenada por x/y (x é longitude)', gs.coordenadaDe({ x: -38.5, y: -3.7 }).latitude === -3.7);
  checa('coordenada por geometria WKT', gs.coordenadaDe({ geometry: 'POINT (-38.5 -3.7)' }).longitude === -38.5);

  console.log('\n─── Ferramenta: caixas de emenda ───');
  (gs.geosite as any).colunas = async () => ['fid', 'codigo', 'fidTipoCaixaEmenda', 'latitude', 'longitude', 'senha_tecnica'];
  let pedidoLista: any = null;
  (gs.geosite as any).listarTudo = async (_f: string, p: unknown) => {
    pedidoLista = p;
    return {
      total: 3, completo: true,
      registros: [
        { fid: 1, codigo: 'CEO-BSC-1', latitude: -3.7801, longitude: -38.5901 },
        { fid: 2, codigo: 'CEO-BSC-2', latitude: -3.7815, longitude: -38.5907 },
        { fid: 3, codigo: 'CEO-LONGE', latitude: -4.5, longitude: -39.5 },
      ],
    };
  };
  (gs.geosite as any).facilidades = async () => [
    { codigo: 'CEO-PRAIA-2', distancia: 140, x: -38.45, y: -3.74, fidTipoCaixaEmenda: 1 },
    { codigo: 'CTO-PRAIA', distancia: 20, x: -38.45, y: -3.74, fidTipoCaixaEmenda: 2 },
    { codigo: 'CEO-PRAIA-1', distancia: 60, x: -38.45, y: -3.74, fidTipoCaixaEmenda: 1 },
  ];
  registrarFerramentasGeosite();
  const emenda = async (args: Record<string, unknown>) => (await ferramentas.get('caixas_de_emenda')!.executar(args, ctx))[0] as any;
  let ce = await emenda({});
  checa('conta as caixas de emenda da rede', ce.ok && ce.dados.caixas_de_emenda_na_rede === 3, ce.dados ?? ce.erro);
  checa('pede só o tipo caixa de emenda à planta', pedidoLista?.filter === 'fidTipoCaixaEmenda=1', pedidoLista);
  checa('não pede coluna que não serve (nada de senha)', !pedidoLista?.columns.includes('senha_tecnica'), pedidoLista?.columns);
  checa('sempre diz que atenuação não é medida', /OTDR/.test(ce.dados.o_que_nao_temos));
  ce = await emenda({ bairro: 'Bolsa Fesso' });
  checa('"caixas de emenda no Bolsa Fesso" acha as duas do Bom Sucesso', ce.ok && ce.dados.no_bairro === 2, ce.dados);
  checa('o bairro vem da CTO mais próxima, dito', ce.dados.caixas.every((x: any) => /CTO mais próxima/.test(x.bairro_origem)), ce.dados.caixas);
  checa('e o link do mapa', ce.dados.caixas.every((x: any) => /maps\.google/.test(x.mapa)));
  checa('caixa longe de toda CTO fica sem bairro, contada', ce.dados.sem_bairro_identificado === 1, ce.dados.sem_bairro_identificado);
  ce = await emenda({ bairro: 'Copacabana' });
  checa('bairro sem caixa identificada explica e oferece endereço', ce.vazio && /endereço|referência/.test(ce.dados.instrucao), ce.dados);
  ce = await emenda({ endereco: 'Angola Cables, Praia do Futuro, Fortaleza' });
  checa('perto da Angola Cables: só caixas de emenda, da mais perto para a mais longe',
    ce.ok && ce.dados.caixas.map((x: any) => x.codigo).join() === 'CEO-PRAIA-1,CEO-PRAIA-2', ce.dados?.caixas);
  checa('com distância em metros', ce.dados.caixas[0].distancia_m === 60);

  fecharDb();
  console.log(`\n${passou} ok, ${falhou} falha(s)`);
  process.exit(falhou ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
