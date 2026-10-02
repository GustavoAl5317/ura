// Onde mandar equipe primeiro: Bairro > Rua > Cliente, com o valor mensal em
// risco. A montagem é pura: caixas em risco + clientes de cada uma + preços.
//
//   npm run test:prioridade

import fs from 'fs';
import os from 'os';
import path from 'path';

for (const k of ['OPENAI_API_KEY', 'SGP_BASE_URL', 'SGP_TOKEN']) {
  process.env[k] ||= 'teste-prioridade-sem-uso';
}
process.env.QUESTDB_ENABLED = 'true';
process.env.TZ ||= 'America/Fortaleza';
const RAIZ = __dirname;
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'aq-prioridade-')));

/* eslint-disable @typescript-eslint/no-var-requires */
const { db, fecharDb } = require(path.join(RAIZ, 'src', 'assistant', 'store', 'db')) as typeof import('./src/assistant/store/db');
const P = require(path.join(RAIZ, 'src', 'assistant', 'prioridade')) as typeof import('./src/assistant/prioridade');
const R = require(path.join(RAIZ, 'src', 'assistant', 'resumo-diario')) as typeof import('./src/assistant/resumo-diario');
const { rotasDaPergunta } = require(path.join(RAIZ, 'src', 'assistant', 'rota')) as typeof import('./src/assistant/rota');
/* eslint-enable @typescript-eslint/no-var-requires */

let passou = 0;
let falhou = 0;
function checa(rotulo: string, ok: boolean, detalhe: unknown = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${rotulo}${ok || detalhe === '' ? '' : `\n      ${typeof detalhe === 'string' ? detalhe : JSON.stringify(detalhe).slice(0, 500)}`}`);
  ok ? passou++ : falhou++;
}

type Nivel = 'critico' | 'degradacao' | 'atencao' | 'saudavel' | 'sem_base';
const caixa = (cto_id: number, nome: string, nivel: Nivel, motivo = 'sinal caiu') => ({
  cto_id, nome, pon: '1', nivel, rotulo: nivel, motivos: [motivo], o_que_fazer: [], clientes: null,
  sinal_atual_dbm: null, sinal_normal_dbm: null, piora_db: null, ocupacao_pct: null, sem_leitura_recente: false,
  leitura_ha_min: 5, incidentes_abertos: [], quedas_30_dias: 0, desde: null, causas: [],
}) as any;

const cli = (nome: string, contrato: number, rua: string, numero: string, bairro: string, plano: number | null) => ({
  nome, contrato, logradouro: rua, numero, bairro, plano_id: plano, plano_desc: plano ? `Plano ${plano}` : null,
});

async function main(): Promise<void> {
  db();

  console.log('\n─── Preço ───');
  checa('"R$ 79,90" vira 79.9', P.parsePreco('R$ 79,90') === 79.9);
  checa('"99.90" vira 99.9', P.parsePreco('99.90') === 99.9);
  checa('"1.199,90" vira 1199.9', P.parsePreco('1.199,90') === 1199.9);
  checa('vazio ou zero não é preço', P.parsePreco('') === null && P.parsePreco('0,00') === null);
  checa('reais formata com vírgula e milhar', P.reais(1198.8) === 'R$ 1.198,80', P.reais(1198.8));

  console.log('\n─── Montagem ───');
  const precos = new Map([[79, 79.9], [81, 89.9], [83, 119.9]]);
  const caixas = [
    caixa(1, 'CTO 1 - BSC', 'degradacao', 'sinal piorou 3 dB'),
    caixa(2, 'CTO 2 - BSC', 'degradacao'),
    caixa(3, 'CTO 3 - GPT', 'critico', 'caixa sem internet (incidente aberto)'),
    caixa(4, 'CTO 4 - CHEIA', 'atencao', 'caixa lotada'),
  ];
  const clientes: Record<number, ReturnType<typeof cli>[]> = {
    1: [cli('Ana', 1, 'RUA ALFA', '10', 'BONSUCESSO', 83), cli('Bia', 2, 'Rua Alfa', '30', 'Bonsucesso', 81)],
    2: [cli('Caio', 3, 'RUA BETA', '5', 'BONSUCESSO', 79), cli('Dora', 4, 'RUA BETA', '7', 'BONSUCESSO', null)],
    3: [cli('Edu', 5, 'RUA GAMA', '1', 'GRANJA PORTUGAL', 79)],
    4: [cli('Fia', 6, 'RUA DELTA', '2', 'PARANGABA', 83)],
  };
  const b = P.montarPrioridades(caixas, (c) => clientes[c.cto_id] ?? [], precos);
  checa('crítico vem antes, mesmo com menos dinheiro', b[0].bairro === 'GRANJA PORTUGAL' && b[0].prioridade === 1 && b[0].nivel === 'critico', b.map((x) => x.bairro));
  checa('caixa só lotada (atenção) não entra', !b.some((x) => x.bairro === 'PARANGABA'));
  const bsc = b.find((x) => x.bairro === 'BONSUCESSO')!;
  checa('bairro soma os clientes das duas caixas', bsc.clientes === 4 && bsc.caixas === 2, bsc);
  checa('valor mensal é a soma dos planos com preço', bsc.valor_mensal === 289.7, bsc.valor_mensal);
  checa('plano sem preço é contado à parte, não vira zero escondido', bsc.sem_valor === 1, bsc.sem_valor);
  checa('"RUA ALFA" e "Rua Alfa" são a mesma rua', bsc.ruas.filter((r) => /alfa/i.test(r.rua)).length === 1 && bsc.ruas[0].clientes === 2, bsc.ruas);
  checa('ruas em ordem de valor', bsc.ruas[0].valor_mensal >= bsc.ruas[1].valor_mensal, bsc.ruas.map((r) => r.valor_mensal));
  checa('cada rua sabe de qual caixa vêm os clientes', bsc.ruas[0].caixas.join() === 'CTO 1 - BSC');
  checa('clientes da rua em ordem de número', bsc.ruas[0].lista.map((c) => c.numero).join() === '10,30');
  checa('o motivo do bairro é o da caixa', /sinal/.test(bsc.motivo), bsc.motivo);

  console.log('\n─── Cadastro ───');
  const agora = new Date().toISOString();
  const ins = (id: number, nome: string, bairro: string, rua: string, cto: number, status = 'Ativo') => {
    db().prepare(`INSERT INTO sgp_cliente (cliente_id, nome, bairro, logradouro, numero, atualizado_em) VALUES (?,?,?,?,?,?)`).run(id, nome, bairro, rua, String(id), agora);
    db().prepare(`INSERT INTO sgp_contrato (contrato_id, cliente_id, status, atualizado_em) VALUES (?,?,?,?)`).run(id, id, status, agora);
    db().prepare(`INSERT INTO sgp_servico (servico_id, contrato_id, cto_id, cto_nome, plano_id, plano_desc, atualizado_em) VALUES (?,?,?,?,?,?,?)`).run(id, id, cto, `CTO ${cto}`, 79, 'BASIC', agora);
  };
  ins(1, 'Ana', 'BONSUCESSO', 'RUA ALFA', 7);
  ins(2, 'Bia', 'BONSUCESSO', 'RUA ALFA', 7, 'Cancelado');
  ins(3, 'Caio', 'BONSUCESSO', 'RUA BETA', 7);
  db().prepare(`INSERT INTO sgp_servico (servico_id, contrato_id, cto_id, cto_nome, plano_id, atualizado_em) VALUES (?,?,?,?,?,?)`).run(99, 3, 7, 'CTO 7', 79, agora);
  const da7 = P.clientesDaCaixa({ cto_id: 7, nome: 'CTO 7' });
  checa('contrato cancelado não está em risco', !da7.some((c) => c.nome === 'Bia'), da7.map((c) => c.nome));
  checa('dois serviços do mesmo contrato contam uma vez', da7.filter((c) => c.nome === 'Caio').length === 1, da7.map((c) => c.nome));
  checa('acha pelo nome da caixa quando o id não bate', P.clientesDaCaixa({ cto_id: 999, nome: 'cto 7' }).length === 2);

  console.log('\n─── Bairro pedido ───');
  const f = P.filtrarBairro(b, 'Bolsa Fesso');
  checa('"Bolsa Fesso" acha o Bonsucesso na lista de risco', f.bairros.length === 1 && f.bairros[0].bairro === 'BONSUCESSO' && !!f.entendido, f);
  checa('a prioridade original é mantida no filtro', f.bairros[0].prioridade === 2);

  console.log('\n─── Resumo ───');
  const texto = R.formatarResumo({
    inicio: '2026-10-02T15:00:00Z', fim: '2026-10-02T17:00:00Z',
    secoes: {
      prioridades: {
        disponivel: true,
        total: { bairros: 4, clientes: 20, valor_mensal: 1998 },
        bairros: [
          { prioridade: 1, bairro: 'GRANJA PORTUGAL', rotulo: 'Crítico', clientes: 1, valor_mensal: 79.9, ruas: ['RUA GAMA (1)'] },
          { prioridade: 2, bairro: 'BONSUCESSO', rotulo: 'Em degradação', clientes: 4, valor_mensal: 289.7, ruas: ['RUA ALFA (2)', 'RUA BETA (2)'] },
        ],
        aviso_valor: '1 cliente(s) com plano sem preço no SGP: o valor está por baixo',
      },
    },
  });
  checa('resumo tem "Onde mandar equipe primeiro"', /\*Onde mandar equipe primeiro\*/.test(texto), texto);
  checa('com bairro, clientes, valor e ruas', /1\. \*GRANJA PORTUGAL\* \(crítico\): 1 cliente, R\$ 79,90\/mês em risco · RUA GAMA \(1\)/.test(texto), texto);
  checa('e o total quando há mais bairros', /No total: 4 bairros, 20 clientes, R\$ 1\.998,00\/mês em risco/.test(texto), texto);
  checa('avisa quando o valor está por baixo', /plano sem preço/.test(texto));
  const vazio = R.formatarResumo({ inicio: '2026-10-02T15:00:00Z', fim: '2026-10-02T17:00:00Z', secoes: { prioridades: { disponivel: true, total: { bairros: 0, clientes: 0, valor_mensal: 0 }, bairros: [], aviso_valor: null } } });
  checa('sem risco, diz que não há onde priorizar', /nenhum bairro para priorizar/.test(vazio), vazio);

  console.log('\n─── Rota ───');
  const assuntos = (q: string) => rotasDaPergunta(q).map((x) => x.assunto);
  checa('"onde mando a equipe hoje?" vai para a prioridade', assuntos('onde mando a equipe hoje?')[0] === 'prioridade de manutenção', assuntos('onde mando a equipe hoje?'));
  checa('"quanto dinheiro está em risco?" vai para a prioridade', assuntos('quanto dinheiro está em risco?')[0] === 'prioridade de manutenção');
  checa('"quais bairros precisam de técnico primeiro? prioridade" vai', assuntos('qual a prioridade dos bairros?')[0] === 'prioridade de manutenção');
  checa('"o link da Angola caiu?" não vai', !assuntos('o link da Angola caiu?').includes('prioridade de manutenção'));

  fecharDb();
  console.log(`\n${passou} ok, ${falhou} falha(s)`);
  process.exit(falhou ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
