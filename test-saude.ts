// Testes da leitura gerencial: cada caixa comparada com o normal dela, o lugar
// consolidado sem herdar o pior caso às cegas, e "sem base" nunca virando
// "saudável".
//
//   npm run test:saude

import fs from 'fs';
import os from 'os';
import path from 'path';

for (const k of ['OPENAI_API_KEY', 'SGP_BASE_URL', 'SGP_TOKEN']) {
  process.env[k] ||= 'teste-saude-sem-uso';
}
process.env.QUESTDB_ENABLED = 'true';
process.env.TZ ||= 'America/Fortaleza';
const RAIZ = __dirname;
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'aq-saude-')));

/* eslint-disable @typescript-eslint/no-var-requires */
const { db, fecharDb } = require(path.join(RAIZ, 'src', 'assistant', 'store', 'db')) as typeof import('./src/assistant/store/db');
const sr = require(path.join(RAIZ, 'src', 'assistant', 'saude-rede')) as typeof import('./src/assistant/saude-rede');
const { questdb, avaliarSinal } = require(path.join(RAIZ, 'src', 'integrations', 'questdb')) as typeof import('./src/integrations/questdb');
const resumo = require(path.join(RAIZ, 'src', 'assistant', 'resumo-diario')) as typeof import('./src/assistant/resumo-diario');
const { ferramentas } = require(path.join(RAIZ, 'src', 'assistant', 'tools', 'base')) as typeof import('./src/assistant/tools/base');
const { registrarFerramentasSaude } = require(path.join(RAIZ, 'src', 'assistant', 'tools', 'saude')) as typeof import('./src/assistant/tools/saude');
/* eslint-enable @typescript-eslint/no-var-requires */

let passou = 0;
let falhou = 0;
function checa(rotulo: string, ok: boolean, detalhe: unknown = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${rotulo}${ok || detalhe === '' ? '' : `\n      ${typeof detalhe === 'string' ? detalhe : JSON.stringify(detalhe).slice(0, 500)}`}`);
  ok ? passou++ : falhou++;
}

const L = { limiarDb: 3, criticoDb: 6, ocupacaoAtencaoPct: 90, quedasRecorrentes: 3 };

function cto(p: Partial<Record<string, unknown>> & { cto_id: number; nome: string }): any {
  return {
    pon: '1/1/1', lat: -3.75, long: -38.6, sinal: -20, clientes: 8, portas: 16, ocupacao: 50,
    em: new Date().toISOString(), idadeMin: 3, semLeituraRecente: false, ...p,
  };
}

/** Avaliação pela régua real do monitor: atual contra a referência da caixa. */
function aval(atual: number | null, ref: number | null, amostrasRef = 100) {
  return avaliarSinal(
    atual === null ? undefined : { cto_id: 1, media: atual, amostras: 6 },
    ref === null ? undefined : { cto_id: 1, media: ref, desvio: 0.3, min: ref - 1, max: ref + 1, amostras: amostrasRef },
    3,
  );
}

const classifica = (p: { c?: any; a?: any; inc?: any[]; quedas?: number }) => sr.classificarCto({
  cto: p.c ?? cto({ cto_id: 1, nome: 'CX-1' }),
  avaliacao: p.a ?? aval(-20, -20),
  incidentes: p.inc ?? [],
  quedas30: p.quedas ?? 0,
  limiares: L,
});

async function main(): Promise<void> {
  db();

  console.log('\n─── Uma caixa ───');
  let s = classifica({});
  checa('sinal igual ao normal dela, nada aberto: saudável', s.nivel === 'saudavel' && s.motivos.length === 0, s);

  s = classifica({ a: aval(-24, -20) });
  checa('4 dB pior que o normal dela: em degradação', s.nivel === 'degradacao', s.motivos);
  checa('o motivo diz quanto piorou, em linguagem de gestor', /4 dB pior que o normal desta caixa/.test(s.motivos[0]), s.motivos);
  checa('e diz o que fazer', s.o_que_fazer.some((f) => /vistoriar/.test(f)), s.o_que_fazer);

  s = classifica({ a: aval(-27.5, -20) });
  checa('piora de 7,5 dB é crítica', s.nivel === 'critico' && /queda forte/.test(s.motivos[0]), s.motivos);

  s = classifica({ a: aval(-21.8, -20) });
  checa('piora pequena, abaixo do limiar, vira só atenção', s.nivel === 'atencao' && /começando a piorar/.test(s.motivos[0]), s);

  s = classifica({ c: cto({ cto_id: 2, nome: 'CX-LONGE' }), a: aval(-26, -26) });
  checa('caixa longe da OLT, fraca mas estável, NÃO é degradação', s.nivel === 'saudavel', s);

  s = classifica({ a: aval(-28, -28) });
  checa('abaixo do aceitável mesmo estável: degradação', s.nivel === 'degradacao' && /muito fraco/.test(s.motivos[0]), s.motivos);

  s = classifica({ a: aval(null, -20) });
  checa('sem leitura e nada mais: sem base, nunca saudável', s.nivel === 'sem_base', s);
  s = classifica({ a: aval(-20, -20, 5) });
  checa('referência curta demais: sem base', s.nivel === 'sem_base', s);

  s = classifica({ inc: [{ numero: 'INC-2026-00001', severidade: 'critico', aberto_em: '2026-10-01T10:00:00Z', dono: null }] });
  checa('incidente crítico aberto: crítico', s.nivel === 'critico');
  checa('sem dono, a ação é fazer alguém assumir', s.o_que_fazer.some((f) => /sem dono/.test(f)), s.o_que_fazer);
  checa('desde quando = abertura do incidente', s.desde === '2026-10-01T10:00:00Z');

  s = classifica({ inc: [{ numero: 'INC-2026-00002', severidade: 'advertencia', aberto_em: '2026-10-01T10:00:00Z', dono: 'Ana' }] });
  checa('incidente leve aberto: atenção', s.nivel === 'atencao', s);

  s = classifica({ quedas: 4 });
  checa('4 quedas em 30 dias: problema que volta', s.nivel === 'degradacao' && /o problema volta/.test(s.motivos[0]), s.motivos);
  s = classifica({ quedas: 1 });
  checa('1 queda em 30 dias: atenção', s.nivel === 'atencao');

  s = classifica({ c: cto({ cto_id: 3, nome: 'CX-CHEIA', ocupacao: 100 }) });
  checa('caixa lotada: atenção, com ação de ampliar', s.nivel === 'atencao' && s.o_que_fazer.some((f) => /ampliação/.test(f)), s);
  s = classifica({ c: cto({ cto_id: 4, nome: 'CX-QUASE', ocupacao: 93 }) });
  checa('93% ocupada: atenção', s.nivel === 'atencao' && /93% ocupada/.test(s.motivos[0]), s.motivos);

  s = classifica({ c: cto({ cto_id: 5, nome: 'CX-CEGA', semLeituraRecente: true, idadeMin: 4000 }), a: aval(null, -20) });
  checa('sem leitura recente é ponto cego, não saudável', s.nivel === 'atencao' && /ponto cego/.test(s.motivos[0]), s);

  s = classifica({ a: aval(-28, -20), quedas: 1, c: cto({ cto_id: 6, nome: 'CX-TUDO', ocupacao: 100 }) });
  checa('vários problemas: vale o pior', s.nivel === 'critico', s.nivel);
  checa('e os motivos saem do mais grave para o mais leve', /queda forte/.test(s.motivos[0]), s.motivos);

  console.log('\n─── Um lugar ───');
  const regua = { janela_min: 30, dias_referencia: 7, limiar_db: 3, critico_db: 6, degradacao_pct: 10 };
  const opts = { degradacaoPct: 10, clientesParaDegradacao: 50, regua };
  const saudavel = (id: number, clientes = 8) => classifica({ c: cto({ cto_id: id, nome: `CX-${id}`, clientes }) });
  const ruim = (id: number, clientes = 8) => classifica({ c: cto({ cto_id: id, nome: `CX-${id}`, clientes }), a: aval(-24, -20) });

  let l = sr.consolidar('Bairro A', Array.from({ length: 20 }, (_, i) => saudavel(i + 1)), opts);
  checa('tudo normal: lugar saudável', l.nivel === 'saudavel', l.resumo);
  checa('o resumo diz que foi avaliado, não só "ok"', /dentro do normal/.test(l.resumo), l.resumo);
  checa('nenhum cliente em risco', l.impacto.clientes_em_risco === 0);

  l = sr.consolidar('Bairro B', [...Array.from({ length: 19 }, (_, i) => saudavel(i + 1)), ruim(99)], opts);
  checa('1 caixa ruim em 20 (5%): o lugar fica em ATENÇÃO, não em degradação', l.nivel === 'atencao', l.resumo);
  checa('e a caixa ruim aparece nos pontos de atenção', l.pontos_de_atencao[0].nome === 'CX-99');

  l = sr.consolidar('Bairro C', [...Array.from({ length: 8 }, (_, i) => saudavel(i + 1)), ruim(98), ruim(99)], opts);
  checa('2 em 10 (20%): o lugar está em degradação', l.nivel === 'degradacao', l.resumo);
  checa('impacto conta os clientes das caixas com problema', l.impacto.clientes_em_risco === 16, l.impacto);

  l = sr.consolidar('Bairro D', [...Array.from({ length: 30 }, (_, i) => saudavel(i + 1)), ruim(99, 60)], opts);
  checa('uma caixa só, mas com 60 clientes em risco: degradação', l.nivel === 'degradacao', l.impacto);

  l = sr.consolidar('Bairro E', [...Array.from({ length: 30 }, (_, i) => saudavel(i + 1)),
    classifica({ c: cto({ cto_id: 77, nome: 'CX-77' }), a: aval(-28, -20) })], opts);
  checa('uma caixa crítica: o lugar é crítico (cliente parado não espera proporção)', l.nivel === 'critico');

  l = sr.consolidar('Bairro F', [classifica({ a: aval(null, null) }), classifica({ a: aval(null, null) })], opts);
  checa('nada medido: o lugar fica sem base, nunca saudável', l.nivel === 'sem_base' && /sem base/.test(l.resumo), l.resumo);

  console.log('--- O que o gestor le ---');
  const fraca = (id: number) => classifica({ c: cto({ cto_id: id, nome: `CX-F${id}`, clientes: 1 }), a: aval(-27.5, -27.5) });
  const cheia = (id: number) => classifica({ c: cto({ cto_id: id, nome: `CX-L${id}`, ocupacao: 100 }) });
  const quase = (id: number) => classifica({ c: cto({ cto_id: id, nome: `CX-Q${id}`, ocupacao: 95 }) });
  l = sr.consolidar('Rede', [fraca(1), fraca(2), fraca(3), ...Array.from({ length: 30 }, (_, i) => saudavel(100 + i))], opts);
  checa('sinal fraco e estavel e dito como FRACO, nao como piorando',
    /sinal da fibra muito fraco/.test(l.motivo) && !/pior que o normal/.test(l.motivo), l.motivo);
  l = sr.consolidar('Rede', [cheia(1), cheia(2), quase(3), ...Array.from({ length: 10 }, (_, i) => saudavel(100 + i))], opts);
  checa('lotacao aparece como CAPACIDADE, separada de saude',
    /capacidade: 2 caixas lotadas e 1 quase lotada/.test(l.motivo) && !/sinal e estabilidade/.test(l.motivo), l.motivo);
  checa('lotada e quase lotada geram UMA acao de ampliacao, nao duas',
    l.o_que_fazer.filter((f) => /ampliação/.test(f)).length === 1, l.o_que_fazer);
  l = sr.consolidar('Rede', [classifica({ c: cto({ cto_id: 9, nome: 'CX-CEGA', semLeituraRecente: true, idadeMin: 5000 }), a: aval(null, -20) }), saudavel(1)], opts);
  checa('sem leitura aparece como MONITORAMENTO', /monitoramento: 1 caixa sem leitura recente/.test(l.motivo), l.motivo);
  l = sr.consolidar('Bairro pequeno', [fraca(1), saudavel(2), saudavel(3)], opts);
  checa('uma caixa fraca com 1 cliente num bairro pequeno: atencao, nao degradacao', l.nivel === 'atencao', l.resumo);
  l = sr.consolidar('Bairro pequeno', [fraca(1), fraca(2), saudavel(3)], opts);
  checa('duas caixas com problema no mesmo bairro pequeno: degradacao', l.nivel === 'degradacao', l.resumo);

  l = sr.consolidar('Bairro G', [ruim(1)], opts);
  checa('sem incidente, o "desde quando" admite que não sabe o início',
    l.desde === null && /início exato não é conhecido/.test(l.desde_explicacao), l.desde_explicacao);

  console.log('\n─── Incidente ligado à caixa ───');
  const c7 = cto({ cto_id: 7, nome: 'CTO - ARACA 07', pon: '1/2/3' });
  checa('liga pela PON', sr.incidenteDaCto(c7, { correlacao: 'pon:1/2/3', alvo: null, titulo: 'x' }));
  checa('liga pelo nome no alvo', sr.incidenteDaCto(c7, { correlacao: 'host:olt', alvo: 'CTO - ARACA 07', titulo: 'x' }));
  checa('não liga incidente de outra PON', !sr.incidenteDaCto(c7, { correlacao: 'pon:9/9/9', alvo: null, titulo: 'Queda PON 9' }));

  console.log('\n─── Rede de verdade (série dublada) ───');
  const CTOS = [
    cto({ cto_id: 1, nome: 'HJ-01', pon: '1/1/1', clientes: 10 }),
    cto({ cto_id: 2, nome: 'HJ-02', pon: '1/1/1', clientes: 12 }),
    cto({ cto_id: 3, nome: 'PRG-01', pon: '2/1/1', clientes: 6, lat: -3.79, long: -38.56 }),
  ];
  (questdb as any).ctosAtuais = async () => CTOS;
  (questdb as any).exigirColetaViva = async () => undefined;
  (questdb as any).recente = async () => [
    { cto_id: 1, media: -20, amostras: 6 }, { cto_id: 2, media: -25, amostras: 6 }, { cto_id: 3, media: -19, amostras: 6 },
  ];
  (questdb as any).referencia = async () => [1, 2, 3].map((id) => ({ cto_id: id, media: -20, desvio: 0.3, min: -21, max: -19, amostras: 200 }));
  const agora = new Date().toISOString();
  const cliente = (id: number, bairro: string, ctoId: number, ctoNome: string) => {
    db().prepare(`INSERT INTO sgp_cliente (cliente_id, nome, bairro, cidade, atualizado_em) VALUES (?,?,?,?,?)`).run(id, `C${id}`, bairro, 'Fortaleza', agora);
    db().prepare(`INSERT INTO sgp_contrato (contrato_id, cliente_id, status, atualizado_em) VALUES (?,?,?,?)`).run(id, id, 'Ativo', agora);
    db().prepare(`INSERT INTO sgp_servico (servico_id, contrato_id, cto_id, cto_nome, atualizado_em) VALUES (?,?,?,?,?)`).run(id, id, ctoId, ctoNome, agora);
  };
  cliente(1, 'Henrique Jorge', 1, 'HJ-01');
  cliente(2, 'Henrique Jorge', 2, 'HJ-02');
  cliente(3, 'Parangaba', 3, 'PRG-01');

  const rede = await sr.lerSaude({});
  checa('a rede inteira é avaliada', rede.lugar_encontrado && rede.leitura.impacto.caixas === 3);
  checa('a caixa com 5 dB de piora puxa a rede para baixo', rede.leitura.pontos_de_atencao[0]?.nome === 'HJ-02', rede.leitura.pontos_de_atencao);
  const hj = await sr.lerSaude({ bairro: 'henrique jorge' });
  checa('recorte por bairro funciona sem acento', hj.lugar_encontrado && hj.leitura.impacto.caixas === 2, hj.leitura.impacto);
  checa('uma caixa só com problema, mesmo sendo metade do bairro: atenção, não degradação', hj.leitura.nivel === 'atencao', hj.leitura.resumo);
  const prg = await sr.lerSaude({ bairro: 'Parangaba' });
  checa('bairro sem problema: saudável', prg.leitura.nivel === 'saudavel', prg.leitura.resumo);
  const nenhum = await sr.lerSaude({ bairro: 'Copacabana' });
  checa('lugar que não é nosso: não encontrado', nenhum.lugar_encontrado === false);

  const bairros = await sr.lerSaudePorBairro();
  checa('por bairro, o pior vem primeiro', bairros[0].alvo === 'Henrique Jorge' && bairros[0].nivel === 'atencao', bairros.map((b) => [b.alvo, b.nivel]));

  console.log('\n─── Ferramenta ───');
  registrarFerramentasSaude();
  const ctx = { proximoId: (() => { let n = 0; return () => `evd_${++n}`; })(), usuario: 'teste', fontesPermitidas: null };
  const rodar = async (args: Record<string, unknown>) => (await ferramentas.get('saude_da_rede')!.executar(args, ctx))[0] as any;
  let e = await rodar({ bairro: 'Henrique Jorge' });
  checa('devolve a leitura para gestão pronta', e.ok && e.dados.leitura_para_gestao.rotulo === 'Ponto de atenção', e.dados?.leitura_para_gestao);
  checa('com motivo, impacto e ação', !!e.dados.leitura_para_gestao.motivo && e.dados.leitura_para_gestao.impacto.clientes_em_risco > 0 && e.dados.leitura_para_gestao.o_que_fazer.length > 0);
  checa('e os números técnicos das caixas que puxam para baixo',
    e.dados.pontos_de_atencao[0].piora_db === 5 && e.dados.pontos_de_atencao[0].sinal_atual_dbm === -25, e.dados.pontos_de_atencao[0]);
  checa('explica a régua usada', /próprio normal/.test(e.dados.regua.como_le));
  checa('manda mostrar números antes da leitura', /Primeiro os números/.test(e.dados.como_responder));
  e = await rodar({ bairro: 'Copacabana' });
  checa('lugar que não é nosso não vira "saudável"', e.vazio === true && /NÃO diga que está saudável/.test(e.dados.instrucao));
  e = await rodar({ por_bairro: true });
  checa('por bairro devolve o ranking', e.ok && e.dados.bairros[0].bairro === 'Henrique Jorge');

  console.log('\n─── Resumo diário ───');
  const sec = await resumo.coletarSaude();
  checa('a seção de saúde é montada', sec.disponivel === true, sec);
  if (sec.disponivel) {
    checa('traz o veredito da rede', !!sec.rede.rotulo);
    checa('e onde olhar', sec.piores_bairros[0]?.bairro === 'Henrique Jorge', sec.piores_bairros);
  }
  const texto = resumo.formatarResumo({ inicio: new Date(Date.now() - 86_400_000).toISOString(), fim: new Date().toISOString(), secoes: { saude: sec } });
  checa('o texto abre com "Como está a rede"', /\*Como está a rede\*/.test(texto), texto);
  checa('e diz onde olhar', /Onde olhar: Henrique Jorge/.test(texto), texto);
  (questdb as any).ctosAtuais = async () => { throw new Error('QuestDB fora'); };
  const fora = await resumo.coletarSaude();
  checa('série fora vira "indisponível", não derruba o resumo', fora.disponivel === false && /QuestDB fora/.test((fora as any).motivo), fora);

  fecharDb();
  console.log(`\n${passou} passaram, ${falhou} falharam\n`);
  process.exit(falhou ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
