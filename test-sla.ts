// Testes do monitor de SLA com a fonte alternativa: leitura pelo Evolution.
//
// O Evolution é substituído por um dublê: nenhuma chamada sai da máquina.
//
//   npm run test:sla-evolution

import fs from 'fs';
import os from 'os';
import path from 'path';

for (const k of ['OPENAI_API_KEY', 'SGP_BASE_URL', 'SGP_TOKEN']) {
  process.env[k] ||= 'teste-sla-sem-uso';
}
process.env.EVO_ATEND_API_URL = 'http://evolution.teste';
process.env.EVO_ATEND_INSTANCE = 'atendimento-teste';
process.env.EVO_ATEND_API_KEY = 'chave-teste';

const RAIZ = __dirname;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aq-sla-'));
process.chdir(dir);

/* eslint-disable @typescript-eslint/no-var-requires */
const { db, fecharDb } = require(path.join(RAIZ, 'src', 'assistant', 'store', 'db')) as typeof import('./src/assistant/store/db');
const { definir } = require(path.join(RAIZ, 'src', 'assistant', 'config-dinamica')) as typeof import('./src/assistant/config-dinamica');
const S = require(path.join(RAIZ, 'src', 'assistant', 'monitors', 'sla')) as typeof import('./src/assistant/monitors/sla');
/* eslint-enable @typescript-eslint/no-var-requires */

let passou = 0;
let falhou = 0;
function checa(rotulo: string, ok: boolean, detalhe: unknown = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${rotulo}${ok || detalhe === '' ? '' : `\n      ${typeof detalhe === 'string' ? detalhe : JSON.stringify(detalhe)}`}`);
  ok ? passou++ : falhou++;
}

const AGORA = Date.now();
const seg = (minAtras: number) => Math.floor((AGORA - minAtras * 60_000) / 1000);
const conversa = (jid: string, id: string, deMim: boolean, minAtras: number, nome = 'MARIA CLIENTE') => ({
  remoteJid: jid,
  pushName: nome,
  lastMessage: { key: { id, fromMe: deMim }, messageTimestamp: seg(minAtras) },
});

let lista: unknown[] = [];
const evo = S.evoAtendimento as unknown as Record<string, unknown>;
evo.buscarConversas = async () => lista;
evo.ultimasMensagens = async () => [];

const alertas = () => db().prepare(`SELECT * FROM alerta WHERE origem = 'sla'`).all() as Array<{ chave: string; texto: string; resolvido_em: string | null }>;
const doJid = (jid: string) => alertas().find((a) => a.chave.startsWith(`sla:${jid}:`));

async function main() {
  definir('monitor.sla.fonte', 'evolution', 'teste');
  definir('monitor.sla.minutos', 15, 'teste');
  definir('monitor.sla.horario_inicio', '', 'teste');
  definir('monitor.sla.horario_fim', '', 'teste');

  console.log('\n─── Ciclo ───');
  lista = [
    conversa('j1@s.whatsapp.net', 'm1', false, 20),          // espera 20 min → alerta
    conversa('j2@s.whatsapp.net', 'm2', true, 5),            // respondida
    conversa('grupo@g.us', 'g1', false, 60),                 // grupo → fora
    conversa('j3@s.whatsapp.net', 'm3', false, 13 * 60),     // parada há 13 h → fora
    conversa('j4@s.whatsapp.net', 'm4', false, 5),           // espera curta → sem alerta
    conversa('j5@s.whatsapp.net', 'm5', false, 30, 'PEDRO'), // espera 30 min → alerta
  ];
  let r = await S.cicloSla();
  checa('alerta só quem passou do limite (j1 e j5)', r.alertas === 2 && !!doJid('j1@s.whatsapp.net') && !!doJid('j5@s.whatsapp.net'), r);
  checa('grupo e conversa velha ficam de fora', r.detalhe.ignoradas === 2, r.detalhe);
  checa('j4 conta como aguardando, sem alerta', r.detalhe.aguardando === 3 && !doJid('j4@s.whatsapp.net'), r.detalhe);

  r = await S.cicloSla();
  checa('segundo ciclo não repete alerta', r.alertas === 0 && alertas().length === 2, r);

  console.log('\n─── Resolução ───');
  lista = [
    conversa('j1@s.whatsapp.net', 'm1b', true, 1),           // respondida agora
    conversa('j4@s.whatsapp.net', 'm4', false, 5),
    // j5 sumiu da lista: encerrada ou arquivada
  ];
  r = await S.cicloSla();
  checa('respondida → alerta resolvido', !!doJid('j1@s.whatsapp.net')?.resolvido_em);
  checa('sumiu da lista → alerta resolvido', !!doJid('j5@s.whatsapp.net')?.resolvido_em);
  const j5 = db().prepare(`SELECT aguardando_desde FROM sla_conversa WHERE jid = 'j5@s.whatsapp.net'`).get() as { aguardando_desde: string | null };
  checa('e sai do "aguardando agora" do resumo', j5.aguardando_desde === null && r.detalhe.sairam_da_fila === 1, r.detalhe);

  console.log('\n─── Diagnóstico ───');
  lista = [conversa('j9@s.whatsapp.net', 'm9', false, 40, 'JOANA SIGILO')];
  const diag = await S.diagnosticoSla();
  checa('não expõe nome de cliente', !JSON.stringify(diag).includes('JOANA'), diag);
  checa('mostra a espera', JSON.stringify(diag).includes('"espera_min":40'), diag);

  console.log('\n─── Erro do Evolution ───');
  const { EvolutionClient } = require(path.join(RAIZ, 'src', 'integrations', 'evolution')) as typeof import('./src/integrations/evolution');
  const cli = new EvolutionClient({ apiUrl: 'http://x', instance: '3377 - AQUI', apiKey: 'k' }, 'evolution-atendimento');
  (cli as unknown as { http: unknown }).http = {
    post: () => Promise.reject(Object.assign(new Error('Request failed with status code 404'), {
      response: { status: 404, data: { status: 404, response: { message: ['The "3377 - AQUI" instance does not exist'] } } },
    })),
  };
  try {
    await cli.buscarConversas();
    checa('404 do Evolution lança', false);
  } catch (err) {
    checa('404 diz o motivo que o Evolution deu', /HTTP 404 — The "3377 - AQUI" instance does not exist/.test(String(err)), String(err));
  }

  fecharDb();
  console.log(`\n${passou} passaram, ${falhou} falharam\n`);
  process.exit(falhou ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
