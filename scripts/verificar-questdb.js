#!/usr/bin/env node
// Confere, contra o QuestDB de verdade, as MESMAS consultas que o assistente
// usa (o teste automático roda contra um QuestDB falso e não pega diferença de
// dialeto SQL). Só lê. Rode depois do build, na pasta do assistente:
//
//   node scripts/verificar-questdb.js

process.chdir(require('path').join(__dirname, '..'));
const { questdb, avaliarSinal, SINAL_RUIM_DBM } = require('../dist/integrations/questdb');
const { config } = require('../dist/config');

async function passo(nome, f) {
  const t0 = Date.now();
  try {
    const r = await f();
    console.log(`OK   ${nome} (${Date.now() - t0} ms)${r ? ` — ${r}` : ''}`);
    return true;
  } catch (err) {
    console.log(`FALHOU ${nome}: ${err.message}`);
    return false;
  }
}

(async () => {
  console.log(`QuestDB: ${config.questdb.baseUrl || '(sem URL)'} · tabela ${config.questdb.tabelaSinais} · ligado=${config.questdb.enabled}`);
  if (!questdb.disponivel) {
    console.log('FALHOU: QUESTDB_ENABLED=1 e QUESTDB_URL precisam estar no .env');
    process.exit(1);
  }
  let ok = true;
  let atuais = [];
  let recentes = [];
  let bases = [];
  ok = await passo('última leitura', async () => {
    const f = await questdb.frescor();
    return `${f.ultima} (há ${f.idadeMin} min, ${f.viva ? 'coleta viva' : 'COLETA PARADA'})`;
  }) && ok;
  ok = await passo('CTOs agora', async () => {
    atuais = await questdb.ctosAtuais();
    const semSinal = atuais.filter((c) => c.sinal === null).length;
    return `${atuais.length} CTOs, ${semSinal} sem leitura`;
  }) && ok;
  ok = await passo('média recente (30 min)', async () => {
    recentes = await questdb.recente(30);
    return `${recentes.length} CTOs, ${recentes[0] ? `ex.: id ${recentes[0].cto_id} = ${recentes[0].media} dBm em ${recentes[0].amostras} leituras` : 'vazio'}`;
  }) && ok;
  ok = await passo('referência (7 dias)', async () => {
    bases = await questdb.referencia(7, 30);
    return `${bases.length} CTOs, ${bases[0] ? `ex.: id ${bases[0].cto_id} = ${bases[0].media?.toFixed(2)} ±${bases[0].desvio?.toFixed(2)} em ${bases[0].amostras} leituras` : 'vazio'}`;
  }) && ok;
  if (atuais[0]) {
    ok = await passo(`série 24h de "${atuais[0].nome}"`, async () => {
      const s = await questdb.serie(atuais[0].cto_id, new Date(Date.now() - 86400_000), new Date(), 60);
      return `${s.length} pontos, primeiro ${s[0]?.em} = ${s[0]?.media}`;
    }) && ok;
  }
  if (atuais.length && recentes.length && bases.length) {
    const rec = new Map(recentes.map((x) => [x.cto_id, x]));
    const bas = new Map(bases.map((x) => [x.cto_id, x]));
    const conta = {};
    const pioraram = [];
    for (const c of atuais) {
      const a = avaliarSinal(rec.get(c.cto_id), bas.get(c.cto_id), 3);
      conta[a.situacao] = (conta[a.situacao] || 0) + 1;
      if (a.situacao === 'piorou') pioraram.push(`${c.nome}: ${a.atual} dBm (normal ${a.referencia}, ${a.variacao_db} dB pior)`);
    }
    console.log(`\nSituação com limiar de 3 dB: ${JSON.stringify(conta)}`);
    console.log(`Sinal abaixo de ${SINAL_RUIM_DBM} dBm: ${atuais.filter((c) => c.sinal !== null && c.sinal <= SINAL_RUIM_DBM).length}`);
    if (pioraram.length) console.log(`Pioraram (${pioraram.length}; o monitor avisaria):\n  ${pioraram.slice(0, 10).join('\n  ')}`);
  }
  console.log(ok ? '\nTUDO OK — pode reiniciar o serviço.' : '\nHOUVE FALHA — não reinicie com o QuestDB ligado; mande esta saída.');
  process.exit(ok ? 0 : 1);
})();
