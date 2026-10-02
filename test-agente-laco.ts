// Travas do laço do agente, com o modelo simulado:
//   - a mesma consulta com os mesmos argumentos não roda duas vezes;
//   - a mesma ferramenta não roda mais que MAX_MESMA_FERRAMENTA vezes;
//   - resposta com dado e sem consulta nenhuma ganha uma chance de consultar;
//   - assunto inequívoco (link, cancelamento) leva a ferramenta por escrito.
//
//   npm run test:agente-laco

import fs from 'fs';
import os from 'os';
import path from 'path';

for (const k of ['OPENAI_API_KEY', 'SGP_BASE_URL', 'SGP_TOKEN']) {
  process.env[k] ||= 'teste-laco-sem-uso';
}
process.env.TZ ||= 'America/Fortaleza';
const RAIZ = __dirname;
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'aq-laco-')));

/* eslint-disable @typescript-eslint/no-var-requires */
const axios = require('axios');
const { db, fecharDb } = require(path.join(RAIZ, 'src', 'assistant', 'store', 'db')) as typeof import('./src/assistant/store/db');
const agente = require(path.join(RAIZ, 'src', 'assistant', 'agent')) as typeof import('./src/assistant/agent');
const { ferramentas } = require(path.join(RAIZ, 'src', 'assistant', 'tools', 'base')) as typeof import('./src/assistant/tools/base');
const { rotasDaPergunta } = require(path.join(RAIZ, 'src', 'assistant', 'rota')) as typeof import('./src/assistant/rota');
/* eslint-enable @typescript-eslint/no-var-requires */

let passou = 0;
let falhou = 0;
function checa(rotulo: string, ok: boolean, detalhe: unknown = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${rotulo}${ok || detalhe === '' ? '' : `\n      ${typeof detalhe === 'string' ? detalhe : JSON.stringify(detalhe).slice(0, 400)}`}`);
  ok ? passou++ : falhou++;
}

// Ferramenta de mentira: conta quantas vezes rodou de verdade.
let execucoes = 0;
ferramentas.registrar({
  nome: 'falsa', fonte: 'sgp', descricao: 'teste', parametros: { type: 'object', properties: {} },
  async executar(args) {
    execucoes++;
    return [{
      id: `evd_${execucoes}`, fonte: 'sgp', consulta: 'falsa', args, consultadoEm: new Date().toISOString(),
      duracaoMs: 1, ok: true, vazio: false, dados: { rua: 'RUA ALFA' },
    }];
  },
});

// O "modelo": cada chamada devolve a próxima resposta do roteiro.
let roteiro: Array<Record<string, unknown>> = [];
let pedidos: Array<{ messages: Array<{ role: string; content: string | null }>; tool_choice?: unknown }> = [];
axios.post = async (_url: string, corpo: { messages: Array<{ role: string; content: string | null }>; tool_choice?: unknown }) => {
  pedidos.push({ messages: JSON.parse(JSON.stringify(corpo.messages)), tool_choice: corpo.tool_choice });
  const msg = roteiro.shift() ?? { role: 'assistant', content: 'VEREDITO: INCONCLUSIVO\nfim do roteiro' };
  return { data: { choices: [{ message: msg }], usage: { prompt_tokens: 1, completion_tokens: 1 } } };
};
const chamada = (id: string, args: Record<string, unknown>) => ({
  role: 'assistant', content: null,
  tool_calls: [{ id, type: 'function', function: { name: 'falsa', arguments: JSON.stringify(args) } }],
});
const texto = (t: string) => ({ role: 'assistant', content: t });

async function main(): Promise<void> {
  db();

  console.log('\n─── Assinatura da chamada ───');
  checa('mesma consulta em outra ordem e caixa é a mesma',
    agente.assinaturaDaChamada('x', { b: 'Bolsa Fesso', a: 1 }) === agente.assinaturaDaChamada('x', { a: 1, b: ' bolsa fesso' }));
  checa('argumento diferente é outra consulta',
    agente.assinaturaDaChamada('x', { b: 'A' }) !== agente.assinaturaDaChamada('x', { b: 'B' }));

  console.log('\n─── Consulta repetida ───');
  execucoes = 0; pedidos = [];
  roteiro = [
    chamada('c1', { termo: 'Bolsa Fesso' }),
    chamada('c2', { termo: 'Bolsa Fesso' }),
    chamada('c3', { termo: 'bolsa fesso' }),
    texto('VEREDITO: INCONCLUSIVO\nNão achei.'),
  ];
  let r = await agente.responder({ pergunta: 'quem é o cliente Bolsa Fesso?', usuario: 'teste-laco', canal: 'chat' });
  checa('a mesma consulta roda uma vez só', execucoes === 1, execucoes);
  const avisos = pedidos.flatMap((p) => p.messages).filter((m) => m.role === 'tool' && /nao_executada/.test(m.content ?? ''));
  checa('o modelo é avisado de que repetiu', avisos.length >= 2 && /já foi feita/.test(avisos[0].content ?? ''), avisos.length);
  checa('a resposta sai mesmo assim', /Não achei/.test(r.texto), r.texto);

  console.log('\n─── Mesma ferramenta demais ───');
  execucoes = 0; pedidos = [];
  roteiro = [1, 2, 3, 4, 5, 6].map((n) => chamada(`d${n}`, { termo: `cliente ${n}` }));
  roteiro.push(texto('VEREDITO: PROVAVEL\nVi vários.'));
  r = await agente.responder({ pergunta: 'revise os clientes um a seis', usuario: 'teste-laco', canal: 'chat' });
  checa(`no máximo ${agente.MAX_MESMA_FERRAMENTA} execuções da mesma ferramenta`, execucoes === agente.MAX_MESMA_FERRAMENTA, execucoes);

  console.log('\n─── Resposta sem consulta ───');
  execucoes = 0; pedidos = [];
  roteiro = [
    texto('VEREDITO: CONFIRMADO\nAs caixas ficam na Rua João XXIII, 45 e na Rua 731, 10.'),
    chamada('e1', {}),
    texto('VEREDITO: CONFIRMADO\nA caixa fica na RUA ALFA (evd_1).'),
  ];
  r = await agente.responder({ pergunta: 'quais os endereços dessas caixas?', usuario: 'teste-laco', canal: 'chat' });
  checa('resposta inventada não sai: o modelo é mandado consultar', execucoes === 1, execucoes);
  checa('o pedido diz que endereço sem ferramenta é invenção',
    pedidos[1]?.messages.some((m) => m.role === 'system' && /sem consultar nenhuma ferramenta/.test(m.content ?? '')));
  checa('a resposta final é a que veio da consulta', /RUA ALFA/.test(r.texto) && !/731/.test(r.texto), r.texto);

  execucoes = 0; pedidos = [];
  roteiro = [texto('VEREDITO: CONVERSA\nPonto de atenção é uma caixa que merece olhar antes de virar problema.')];
  r = await agente.responder({ pergunta: 'o que é ponto de atenção? me explica', usuario: 'teste-laco', canal: 'chat' });
  checa('explicação (conversa) não é forçada a consultar', pedidos.length === 1 && r.veredito === 'CONVERSA', { n: pedidos.length, v: r.veredito });

  console.log('\n─── Rota por assunto ───');
  const assuntos = (p: string) => rotasDaPergunta(p).map((x) => x.assunto);
  checa('"rede da RNP" vai para o link', assuntos('Como encontra-se a rede da RNP?').includes('link RNP'));
  checa('"rede da Etis" (áudio) vai para o link Etice', assuntos('Como é que está a rede da ETIS?').includes('link Etice'), assuntos('Como é que está a rede da ETIS?'));
  checa('"Anetice" vai para o link Etice', assuntos('A rede da Anetice').includes('link Etice'));
  checa('"AT&T" vai para o link', assuntos('Poderia me informar sobre a rede da AT&T?').includes('link AT&T'));
  checa('caixa de emenda perto da Angola NÃO vira link', !assuntos('Onde fica a caixa de emenda da Angola Cables?').some((a) => a.startsWith('link')));
  checa('cancelamento vai para o relatório', assuntos('no bairro Bolsa Fesso, quantos cancelamentos tiveram hoje?').includes('cancelamentos'));
  checa('pergunta comum não ganha rota', assuntos('como está o sinal da caixa 731?').length === 0);
  checa('"retirnp" não casa RNP', !assuntos('retirnp').length);

  execucoes = 0; pedidos = [];
  roteiro = [texto('VEREDITO: CONVERSA\nok')];
  await agente.responder({ pergunta: 'Como encontra-se a rede da RNP?', usuario: 'teste-laco', canal: 'chat' });
  checa('a instrução do link chega ao modelo',
    pedidos[0].messages.some((m) => m.role === 'system' && /zabbix_link com link="RNP"/.test(m.content ?? '')));

  console.log('\n─── Ferramenta obrigatória e última rodada ───');
  let argsCancel: Record<string, unknown> | null = null;
  ferramentas.registrar({
    nome: 'relatorio_cancelamentos', fonte: 'sgp', descricao: 'teste', parametros: { type: 'object', properties: {} },
    async executar(args) {
      argsCancel = args;
      return [{ id: 'evd_c', fonte: 'sgp', consulta: 'relatorio_cancelamentos', args, consultadoEm: new Date().toISOString(), duracaoMs: 1, ok: true, vazio: false, dados: { total: 0 } }];
    },
  });
  pedidos = [];
  roteiro = [
    { role: 'assistant', content: null, tool_calls: [{ id: 'k1', type: 'function', function: { name: 'relatorio_cancelamentos', arguments: JSON.stringify({ bairro: 'Bolsa Fesso', so_hoje: true }) } }] },
    texto('VEREDITO: CONFIRMADO\nNenhum cancelamento hoje no Bom Sucesso (evd_c).'),
  ];
  r = await agente.responder({ pergunta: 'no bairro Bolsa Fesso, quantos cancelamentos tiveram hoje?', usuario: 'teste-laco', canal: 'chat' });
  checa('cancelamento: a 1ª rodada é obrigada a chamar o relatório',
    JSON.stringify(pedidos[0].tool_choice) === JSON.stringify({ type: 'function', function: { name: 'relatorio_cancelamentos' } }), pedidos[0].tool_choice);
  checa('a 2ª rodada volta a ser livre', pedidos[1]?.tool_choice === 'auto', pedidos[1]?.tool_choice);

  pedidos = [];
  roteiro = Array.from({ length: 30 }, (_, n) => chamada(`z${n}`, { termo: `x${n}` }));
  r = await agente.responder({ pergunta: 'procure em todo lugar', usuario: 'teste-laco', canal: 'chat' });
  checa('a última rodada é obrigada a responder (sem ferramenta)', pedidos[pedidos.length - 1].tool_choice === 'none', pedidos.map((x) => x.tool_choice));

  console.log('\n─── Etapa do bairro ───');
  argsCancel = null;
  roteiro = [
    { role: 'assistant', content: null, tool_calls: [{ id: 'k2', type: 'function', function: { name: 'relatorio_cancelamentos', arguments: JSON.stringify({ bairro: 'Conjunto Ceará' }) } }] },
    texto('VEREDITO: CONFIRMADO\nok (evd_c)'),
  ];
  await agente.responder({ pergunta: 'quantos cancelamentos na segunda etapa do Conjunto Ceará?', usuario: 'teste-laco', canal: 'chat' });
  checa('o bairro chega à ferramenta com a etapa que a pessoa disse', /segunda etapa/i.test(String((argsCancel as any)?.bairro)), argsCancel);

  console.log('\n─── Veredito inválido ───');
  const v = agente.extrairVereditoProposto('VEREDITO: CRÍTICO\nEntendi BONSUCESSO.');
  checa('"VEREDITO: CRÍTICO" não é declaração e sai do texto', v.veredito === 'PROVAVEL' && !/CR[IÍ]TICO/.test(v.corpo) && /BONSUCESSO/.test(v.corpo), v);

  console.log('\n─── Resposta curta para leigo ───');
  const longa = 'VEREDITO: CONFIRMADO\n' + 'A rede do Bom Sucesso tem 24 caixas, e a interface Eth-Trunk4.1441 está sem coleta de estado da porta. '.repeat(10) + '(evd_1)';
  pedidos = [];
  roteiro = [chamada('l1', {}), texto(longa), texto('Está funcionando: são 24 caixas, nenhuma parada (evd_1).')];
  r = await agente.responder({ pergunta: 'como está a rede lá do bom sucesso?', usuario: 'teste-laco', canal: 'whatsapp' });
  checa('resposta longa para leigo é reescrita curta', r.texto === 'Está funcionando: são 24 caixas, nenhuma parada (evd_1).', r.texto.slice(0, 120));
  checa('a reescrita é chamada sem ferramenta nenhuma', pedidos[2] && pedidos[2].tool_choice === undefined, pedidos[2]?.tool_choice);
  checa('o pedido de linguagem simples proíbe nome de porta',
    pedidos[0].messages.some((m) => m.role === 'system' && /NUNCA escreva nome de porta/.test(m.content ?? '')));
  checa('e a resposta sai marcada como simples', r.simples === true);

  pedidos = [];
  roteiro = [chamada('l2', { x: 1 }), texto(longa), texto('Está tudo bem.')];
  r = await agente.responder({ pergunta: 'como está a rede lá do bom sucesso agora?', usuario: 'teste-laco', canal: 'whatsapp' });
  checa('reescrita que perde a citação é descartada (fica a original)', /Eth-Trunk/.test(r.texto) && r.texto.includes('(evd_1)'), r.texto.slice(0, 80));

  pedidos = [];
  roteiro = [chamada('l3', { y: 1 }), texto(longa)];
  r = await agente.responder({ pergunta: 'qual o rx da onu e o estado da pon 3 da olt 1?', usuario: 'teste-laco', canal: 'chat' });
  checa('pergunta técnica não é encurtada', pedidos.length === 2 && r.texto.length > 600 && !r.simples, { n: pedidos.length, len: r.texto.length });

  const { formatarResposta } = require(path.join(RAIZ, 'src', 'assistant', 'evidence')) as typeof import('./src/assistant/evidence');
  const ev = [{ id: 'evd_1', fonte: 'sgp', consulta: 'sgp.cadastro_espelho', args: {}, consultadoEm: new Date().toISOString(), duracaoMs: 1, ok: true, vazio: false, dados: {} }] as any;
  const leigo = formatarResposta({ veredito: 'PROVAVEL', texto: 'Está funcionando.', evidencias: ev, fontesIndisponiveis: [], lacunas: ['a', 'b', 'c'], simples: true, ajuste: 'nota técnica' });
  checa('rodapé de leigo: uma linha de fonte, sem "evd_1 · sgp ·"', /Consultei: cadastro \(SGP\)/.test(leigo) && !/evd_1 ·/.test(leigo), leigo);
  checa('rodapé de leigo: só a primeira lacuna, sem nota técnica', /Falta para confirmar: a/.test(leigo) && !/• b/.test(leigo) && !/nota técnica/.test(leigo), leigo);
  for (const v of ['PROVAVEL', 'INCONCLUSIVO'] as const) {
    const msg = formatarResposta({ veredito: v, texto: 'Não consegui ver o sinal da caixa 5 agora.', evidencias: ev, fontesIndisponiveis: ['zabbix'], lacunas: ['falta X'], hipotese: 'rompimento', semSelo: true, ajuste: 'rebaixado' });
    checa(`sem selo (${v}): nada de selo, "confirm", "hipótese" nem lacuna técnica`,
      !/confirm|inconclusiv|prov[aá]vel|hip[oó]tese|falta X|rebaixado/i.test(msg) && msg.startsWith('Não consegui ver'), msg);
    checa(`sem selo (${v}): mantém causa possível, fonte fora e fonte usada`,
      /Pode ser: rompimento/.test(msg) && /Não consegui consultar: monitoramento/.test(msg) && /Consultei: cadastro/.test(msg), msg);
  }
  checa('o padrão é nunca mostrar o selo', agente.semSelo(false) && agente.semSelo(true));
  pedidos = [];
  roteiro = [texto('VEREDITO: CONVERSA\nok')];
  await agente.responder({ pergunta: 'como está a rede?', usuario: 'teste-laco', canal: 'whatsapp' });
  checa('no WhatsApp o modelo é avisado para não falar em confirmado',
    pedidos[0].messages.some((m) => m.role === 'system' && /SEM selo de certeza/.test(m.content ?? '')));
  const tecnico = formatarResposta({ veredito: 'PROVAVEL', texto: 'ok', evidencias: ev, fontesIndisponiveis: [], lacunas: ['a', 'b'] });
  checa('rodapé técnico continua completo', /evd_1 · sgp · sgp.cadastro_espelho/.test(tecnico) && /• b/.test(tecnico), tecnico);

  fecharDb();
  console.log(`\n${passou} ok, ${falhou} falha(s)`);
  process.exit(falhou ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
