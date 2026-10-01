// Testes de conversa com quem não é técnico: vocabulário da casa, memória do
// fio ("e agora?") e registro de linguagem.
//
//   npm run test:conversa

import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { randomUUID } from 'crypto';
import type { AddressInfo } from 'net';

for (const k of ['OPENAI_API_KEY', 'SGP_BASE_URL', 'SGP_TOKEN']) {
  process.env[k] ||= 'teste-conversa-sem-uso';
}
process.env.TZ ||= 'America/Fortaleza';
const RAIZ = __dirname;
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'aq-conversa-')));

/* eslint-disable @typescript-eslint/no-var-requires */
const { db, fecharDb } = require(path.join(RAIZ, 'src', 'assistant', 'store', 'db')) as typeof import('./src/assistant/store/db');
const glo = require(path.join(RAIZ, 'src', 'assistant', 'glossario')) as typeof import('./src/assistant/glossario');
const ctx = require(path.join(RAIZ, 'src', 'assistant', 'contexto')) as typeof import('./src/assistant/contexto');
const cfg = require(path.join(RAIZ, 'src', 'assistant', 'config-dinamica')) as typeof import('./src/assistant/config-dinamica');
const { rotasAdmin } = require(path.join(RAIZ, 'src', 'assistant', 'rotas-admin')) as typeof import('./src/assistant/rotas-admin');
const { ErroHttp } = require(path.join(RAIZ, 'src', 'assistant', 'http-util')) as typeof import('./src/assistant/http-util');
/* eslint-enable @typescript-eslint/no-var-requires */

let passou = 0;
let falhou = 0;
function checa(rotulo: string, ok: boolean, detalhe: unknown = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${rotulo}${ok || detalhe === '' ? '' : `\n      ${typeof detalhe === 'string' ? detalhe : JSON.stringify(detalhe).slice(0, 400)}`}`);
  ok ? passou++ : falhou++;
}
function erroDe(fn: () => unknown): string {
  try { fn(); return ''; } catch (e) { return (e as Error).message; }
}

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

/** Grava uma consulta já respondida, com a evidência que mostra o alvo. */
function consultaFeita(p: {
  conversaId: string; usuario: string; pergunta: string; ferramenta: string;
  args: Record<string, unknown>; minutosAtras?: number;
}): string {
  const id = randomUUID();
  const at = new Date(Date.now() - (p.minutosAtras ?? 1) * 60_000).toISOString();
  db().prepare(
    `INSERT INTO consulta (id, conversa_id, usuario, canal, pergunta, resposta, veredito, fontes, duracao_ms, at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(id, p.conversaId, p.usuario, 'whatsapp', p.pergunta, 'resposta', 'CONFIRMADO', '["zabbix"]', 100, at);
  db().prepare(
    `INSERT INTO evidencia (id, consulta_id, evd, fonte, nome_consulta, args, consultado_em, duracao_ms, ok, vazio, dados)
     VALUES (?,?,?,?,?,?,?,?,1,0,?)`,
  ).run(randomUUID(), id, 'evd_1', 'zabbix', p.ferramenta, JSON.stringify(p.args), at, 50, '{}');
  return id;
}

function conversa(usuario: string, minutosAtras = 1): string {
  const id = randomUUID();
  const at = new Date(Date.now() - minutosAtras * 60_000).toISOString();
  db().prepare(`INSERT INTO conversa (id, canal, usuario, nome, criada_em, ultima_em) VALUES (?,?,?,?,?,?)`)
    .run(id, 'whatsapp', usuario, 'Zé', at, at);
  return id;
}

async function main(): Promise<void> {
  db();
  await new Promise<void>((r) => servidor.listen(0, '127.0.0.1', r));
  BASE = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;

  console.log('\n─── Vocabulário da casa ───');
  checa('o vocabulário já nasce semeado', glo.semear() === glo.SEMENTE.length && glo.listar().length === glo.SEMENTE.length);
  checa('semear duas vezes não duplica', glo.semear() === 0 && glo.listar().length === glo.SEMENTE.length);
  checa('"caixinha" está no vocabulário', glo.listar().some((t) => t.termo === 'caixinha'));

  checa('reconhece o termo na frase do leigo',
    glo.termosEncontrados('a caixinha da esquina tá apagada').some((t) => t.termo === 'caixinha'));
  checa('reconhece pelo sinônimo',
    glo.termosEncontrados('a caixa do poste parou').some((t) => t.termo === 'caixinha'));
  checa('reconhece no plural',
    glo.termosEncontrados('as caixinhas da rua caíram').some((t) => t.termo === 'caixinha'));
  checa('reconhece sem acento e em maiúscula',
    glo.termosEncontrados('O PESSOAL do 731 esta SEM NET').length >= 2);
  checa('não casa pedaço de palavra',
    !glo.termosEncontrados('encaixou o conector').some((t) => t.termo === 'caixinha'),
    glo.termosEncontrados('encaixou o conector').map((t) => t.termo));
  checa('frase técnica não ativa termo nenhum',
    glo.termosEncontrados('qual o rx da onu do contrato 4512?').length === 0,
    glo.termosEncontrados('qual o rx da onu do contrato 4512?').map((t) => t.termo));

  const bloco = glo.blocoParaPrompt('o aparelho do cliente tá piscando vermelho');
  checa('o bloco do prompt sai com significado e dica',
    !!bloco && /aparelho/.test(bloco.texto) && /ONU/.test(bloco.texto), bloco?.texto.slice(0, 120));
  checa('o bloco manda NÃO pedir para reformular', !!bloco && /não peça|NÃO peça/i.test(bloco.texto));
  checa('frase sem termo conhecido não gera bloco', glo.blocoParaPrompt('qual o rx dessa onu?') === null);
  cfg.definir('ia.glossario_ativo', false, 'teste');
  checa('desligado no painel, não entra bloco nenhum', glo.blocoParaPrompt('a caixinha caiu') === null);
  cfg.definir('ia.glossario_ativo', true, 'teste');

  glo.marcarUso(bloco!.ids);
  checa('uso do termo é contado', glo.listar().find((t) => t.termo === 'aparelho')!.usos === 1);

  console.log('\n─── Cadastro do vocabulário ───');
  checa('termo sem significado é recusado',
    /o que esse termo significa/.test(erroDe(() => glo.criar({ termo: 'gato' }, 'ana'))));
  checa('termo curto é recusado',
    /pelo menos 2 letras/.test(erroDe(() => glo.criar({ termo: 'x', significado: 'algo' }, 'ana'))));
  checa('termo repetido é recusado',
    /já está no vocabulário/.test(erroDe(() => glo.criar({ termo: 'Caixinha', significado: 'outra coisa' }, 'ana'))));
  const novo = glo.criar({ termo: 'gatilho', sinonimos: 'gato, gato na rede', significado: 'Ligação clandestina na rede.', dica: 'Veja tráfego e clientes online.' }, 'ana');
  checa('termo novo é reconhecido na hora',
    glo.termosEncontrados('acho que tem gato na rede aqui').some((t) => t.id === novo.id));
  glo.atualizar(novo.id, { ativo: false }, 'ana');
  checa('termo desligado para de ser reconhecido',
    !glo.termosEncontrados('tem gato na rede').some((t) => t.id === novo.id));
  glo.remover(novo.id, 'ana');
  checa('termo removido sai da lista', !glo.porId(novo.id));

  console.log('\n─── Memória do fio da conversa ───');
  const c1 = conversa('5585900000001@s.whatsapp.net');
  consultaFeita({
    conversaId: c1, usuario: '5585900000001@s.whatsapp.net',
    pergunta: 'a caixinha da Araçá caiu?', ferramenta: 'analisar_cto', args: { cto: 'ARACA-03' },
  });
  const fio = ctx.fioDaConversa(c1);
  checa('o fio sabe qual foi o alvo', fio.alvo === 'CTO ARACA-03', fio);
  checa('o fio sabe que ferramenta foi usada', fio.ferramentas.includes('analisar_cto'));
  checa('o fio sabe há quanto tempo', fio.minutos !== null && fio.minutos <= 2);

  const linha = ctx.linhaDeContexto(c1);
  checa('a linha de contexto cita o alvo', !!linha && /ARACA-03/.test(linha), linha);
  checa('a linha manda consultar DE NOVO', !!linha && /DE NOVO/.test(linha));
  checa('a linha proíbe afirmar estado com base nela', !!linha && /nunca para afirmar/i.test(linha));
  checa('conversa sem consulta não gera contexto', ctx.linhaDeContexto(conversa('5585900000009@s.whatsapp.net')) === null);
  checa('contexto velho demais é descartado',
    ctx.linhaDeContexto(c1, { maxMinutos: 0 }) === null);

  // Conversa nova da mesma pessoa: a janela fechou, o assunto continua.
  const c2 = conversa('5585900000001@s.whatsapp.net');
  checa('conversa nova herda o assunto da pessoa',
    (() => { const l = ctx.linhaDeContexto(c2, { usuario: '5585900000001@s.whatsapp.net' }); return !!l && /ARACA-03/.test(l) && /mesma pessoa/.test(l); })(),
    ctx.linhaDeContexto(c2, { usuario: '5585900000001@s.whatsapp.net' }));
  checa('sem usuário informado, conversa nova não herda nada',
    ctx.linhaDeContexto(c2) === null);
  checa('assunto de OUTRA pessoa não vaza',
    ctx.linhaDeContexto(conversa('5585900000002@s.whatsapp.net'), { usuario: '5585900000002@s.whatsapp.net' }) === null);

  consultaFeita({
    conversaId: c2, usuario: '5585900000001@s.whatsapp.net',
    pergunta: 'e a PON 3?', ferramenta: 'analisar_pon', args: { pon: 3, olt: 'OLT-3' },
  });
  checa('o fio acompanha o assunto mais recente', ctx.fioDaConversa(c2).alvo === 'PON 3', ctx.fioDaConversa(c2));

  console.log('\n─── Janela de conversa do WhatsApp ───');
  checa('a janela vem configurável, em horas úteis de operação',
    cfg.obter<number>('whatsapp.janela_conversa_min') === 240);
  cfg.definir('whatsapp.janela_conversa_min', 30, 'teste');
  checa('dá para encurtar pelo painel', cfg.obter<number>('whatsapp.janela_conversa_min') === 30);
  checa('valor fora da faixa é recusado',
    (() => { try { cfg.definir('whatsapp.janela_conversa_min', 2, 'teste'); return false; } catch { return true; } })());
  cfg.definir('whatsapp.janela_conversa_min', 240, 'teste');

  console.log('\n─── Registro de linguagem ───');
  checa('o padrão é espelhar quem perguntou', cfg.obter<string>('ia.linguagem') === 'auto');
  checa('só aceita os modos previstos',
    (() => { try { cfg.definir('ia.linguagem', 'poetica', 'teste'); return false; } catch { return true; } })());
  cfg.definir('ia.linguagem', 'simples', 'teste');
  checa('modo simples fica salvo', cfg.obter<string>('ia.linguagem') === 'simples');
  cfg.definir('ia.linguagem', 'auto', 'teste');

  console.log('\n─── Rotas ───');
  let r = await api('GET', '/api/glossario');
  checa('painel lê o vocabulário', r.status === 200 && r.j.termos.length >= 10);
  r = await api('POST', '/api/glossario', { termo: 'pelo painel', significado: 'termo de teste' });
  checa('cria termo pela rota', r.status === 201 && !!r.j.termo.id);
  const id = r.j.termo.id;
  r = await api('POST', '/api/glossario', { termo: 'pelo painel', significado: 'outro' });
  checa('termo repetido devolve 409', r.status === 409, r.j);
  r = await api('PUT', `/api/glossario/${id}`, { significado: 'significado novo' });
  checa('edita pela rota', r.status === 200 && r.j.termo.significado === 'significado novo');
  r = await api('POST', '/api/glossario/testar', { texto: 'a caixinha da rua tá sem net' });
  checa('o teste seco mostra o que a IA vai entender',
    r.status === 200 && r.j.achados.length >= 2 && r.j.achados.some((a: any) => a.termo === 'caixinha'), r.j.achados);
  r = await api('POST', '/api/glossario/testar', { texto: 'qual o rx da onu' });
  checa('frase técnica não ativa nada no teste seco', r.j.achados.length === 0);
  r = await api('DELETE', `/api/glossario/${id}`);
  checa('remove pela rota', r.status === 200);
  r = await api('DELETE', '/api/glossario/00000000-0000-4000-8000-000000000000');
  checa('termo inexistente devolve 404', r.status === 404);
  checa('mexer no vocabulário fica na auditoria',
    !!db().prepare(`SELECT 1 FROM auditoria WHERE acao = 'glossario.criar'`).get());

  servidor.close();
  fecharDb();
  console.log(`\n${passou} passaram, ${falhou} falharam\n`);
  process.exit(falhou ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
