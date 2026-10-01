// Testes do aviso de CTO que para de ser coletada enquanto o resto segue.
//
//   npm run test:sem-coleta

import fs from 'fs';
import os from 'os';
import path from 'path';

for (const k of ['OPENAI_API_KEY', 'SGP_BASE_URL', 'SGP_TOKEN']) {
  process.env[k] ||= 'teste-sem-coleta-sem-uso';
}
process.env.QUESTDB_ENABLED = 'true';
process.env.TZ ||= 'America/Fortaleza';
const RAIZ = __dirname;
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'aq-semcoleta-')));

/* eslint-disable @typescript-eslint/no-var-requires */
const { db, fecharDb } = require(path.join(RAIZ, 'src', 'assistant', 'store', 'db')) as typeof import('./src/assistant/store/db');
const mon = require(path.join(RAIZ, 'src', 'assistant', 'monitors', 'ctos')) as typeof import('./src/assistant/monitors/ctos');
const alertas = require(path.join(RAIZ, 'src', 'assistant', 'alertas')) as typeof import('./src/assistant/alertas');
const cfg = require(path.join(RAIZ, 'src', 'assistant', 'config-dinamica')) as typeof import('./src/assistant/config-dinamica');
const { questdb } = require(path.join(RAIZ, 'src', 'integrations', 'questdb')) as typeof import('./src/integrations/questdb');
const { evoTecnicos } = require(path.join(RAIZ, 'src', 'assistant', 'channels', 'whatsapp-tecnicos')) as typeof import('./src/assistant/channels/whatsapp-tecnicos');
/* eslint-enable @typescript-eslint/no-var-requires */

let passou = 0;
let falhou = 0;
function checa(rotulo: string, ok: boolean, detalhe: unknown = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${rotulo}${ok || detalhe === '' ? '' : `\n      ${typeof detalhe === 'string' ? detalhe : JSON.stringify(detalhe).slice(0, 400)}`}`);
  ok ? passou++ : falhou++;
}

const enviados: Array<{ para: string; texto: string }> = [];
Object.defineProperty(evoTecnicos, 'disponivel', { get: () => true });
(evoTecnicos as any).enviarTextoComId = async (para: string, texto: string) => { enviados.push({ para, texto }); return { ok: true, id: `M${enviados.length}` }; };
(evoTecnicos as any).enviarTexto = async () => true;

const minAtras = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
function cto(id: number, nome: string, idadeMin: number, clientes = 8): any {
  return {
    cto_id: id, nome, pon: '1/1/1', lat: -3.75, long: -38.6, sinal: -20, clientes, portas: 16, ocupacao: 50,
    em: minAtras(idadeMin), idadeMin, semLeituraRecente: idadeMin > 20,
  };
}

let atuais: any[] = [];
let historico: any[] = [];
let consultasHistorico = 0;
(questdb as any).limparCache = () => undefined;
(questdb as any).frescor = async () => ({ viva: true, idadeMin: 3, ultima: minAtras(3), limiteMin: 20 });
(questdb as any).ctosAtuais = async () => atuais;
(questdb as any).ctosEmQualquerEpoca = async () => { consultasHistorico++; return historico; };
(questdb as any).recente = async () => atuais.filter((c) => c.idadeMin <= 30).map((c) => ({ cto_id: c.cto_id, media: -20, amostras: 6 }));
(questdb as any).referencia = async () => atuais.map((c) => ({ cto_id: c.cto_id, media: -20, desvio: 0.3, min: -21, max: -19, amostras: 200 }));

const abertosSemColeta = () => alertas.listar({ abertos: true, limite: 200 }).filter((a) => a.chave.startsWith('ctos:sem_coleta:') && !a.chave.includes(':grupo:'));

async function main(): Promise<void> {
  db();
  cfg.definir('alertas.destino_grupo', '99999@g.us', 'teste');
  cfg.definir('incidentes.ativo', false, 'teste');

  console.log('\n─── Uma CTO para, o resto segue ───');
  atuais = [cto(1, 'CTO - BOA', 3), cto(2, 'CTO - PARADA', 180, 12)];
  historico = atuais;
  mon.reiniciarVarreduraHistorica();
  enviados.length = 0;
  let r = await mon.cicloCtos();
  checa('a CTO parada gera aviso proprio', abertosSemColeta().length === 1 && /PARADA/.test(abertosSemColeta()[0].titulo), abertosSemColeta().map((a) => a.titulo));
  checa('a mensagem diz que o resto da coleta funciona', enviados.some((e) => /O resto da coleta está funcionando/.test(e.texto)), enviados.map((e) => e.texto));
  checa('e quantos clientes a caixa tem', enviados.some((e) => /12 clientes no cadastro/.test(e.texto)));
  checa('a CTO boa nao gera nada', !abertosSemColeta().some((a) => /BOA/.test(a.titulo)));
  checa('o detalhe do monitor conta as paradas', (r.detalhe as any).sem_coleta.paradas === 1, r.detalhe);

  enviados.length = 0;
  await mon.cicloCtos();
  checa('no ciclo seguinte nao repete o aviso', abertosSemColeta().length === 1 && !enviados.some((e) => /PARADA/.test(e.texto)));

  console.log('\n─── Volta a ser coletada ───');
  atuais = [cto(1, 'CTO - BOA', 3), cto(2, 'CTO - PARADA', 4, 12)];
  enviados.length = 0;
  await mon.cicloCtos();
  checa('quando volta, o aviso fecha', abertosSemColeta().length === 0);
  checa('e avisa que voltou', enviados.some((e) => /voltou a ser coletada/.test(e.texto)), enviados.map((e) => e.texto));

  console.log('\n─── Um ciclo perdido nao e alarme ───');
  atuais = [cto(1, 'CTO - BOA', 3), cto(3, 'CTO - ATRASOU', 12)];
  await mon.cicloCtos();
  checa('12 min sem leitura (limite 60) nao abre aviso', !abertosSemColeta().some((a) => /ATRASOU/.test(a.titulo)));

  console.log('\n─── Sumiu ha mais de 30 dias (fora da janela) ───');
  atuais = [cto(1, 'CTO - BOA', 3)];
  historico = [cto(1, 'CTO - BOA', 3), cto(731, 'CTO - CYBER VIVO, 148', 105000, 1)];
  mon.reiniciarVarreduraHistorica();
  const antes = consultasHistorico;
  enviados.length = 0;
  await mon.cicloCtos();
  checa('a varredura historica acha quem sumiu da janela', consultasHistorico === antes + 1);
  checa('e abre aviso para ela', abertosSemColeta().some((a) => /CYBER VIVO/.test(a.titulo)), abertosSemColeta().map((a) => a.titulo));
  checa('com a data da ultima leitura', enviados.some((e) => /CYBER VIVO/.test(e.texto) && /sem leitura desde/.test(e.texto)));
  await mon.cicloCtos();
  checa('a varredura cara nao roda a cada ciclo', consultasHistorico === antes + 1);
  checa('e o aviso de quem sumiu continua aberto', abertosSemColeta().some((a) => /CYBER VIVO/.test(a.titulo)));

  console.log('\n─── Varias de uma vez ───');
  atuais = [cto(1, 'CTO - BOA', 3), ...[10, 11, 12, 13, 14].map((id) => cto(id, `CTO - X${id}`, 300))];
  historico = atuais;
  mon.reiniciarVarreduraHistorica();
  enviados.length = 0;
  await mon.cicloCtos();
  const grupo = enviados.filter((e) => /pararam de ser coletadas/.test(e.texto));
  checa('cinco ao mesmo tempo viram UMA mensagem', grupo.length === 1 && !enviados.some((e) => /CTO parou de ser coletada — CTO - X10/.test(e.texto)), enviados.map((e) => e.texto.slice(0, 60)));
  checa('cada uma ainda ganha seu registro, para fechar depois',
    [10, 11, 12, 13, 14].every((id) => abertosSemColeta().some((a) => a.chave.startsWith(`ctos:sem_coleta:${id}:`))));

  console.log('\n─── Desligado ───');
  cfg.definir('monitor.ctos.alertar_sem_coleta', false, 'teste');
  atuais = [cto(1, 'CTO - BOA', 3), cto(20, 'CTO - DESLIGADO', 500)];
  await mon.cicloCtos();
  checa('desligado no painel, nao avisa', !abertosSemColeta().some((a) => /DESLIGADO/.test(a.titulo)));

  fecharDb();
  console.log(`\n${passou} passaram, ${falhou} falharam\n`);
  process.exit(falhou ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
