#!/usr/bin/env node
// Testa as integrações novas do SGP usando o código compilado (dist/), para
// validar de uma vez os endpoints e a nossa implementação.
//
//   node scripts/testar-sgp.js <contrato_id>              → só leitura (seguro)
//   node scripts/testar-sgp.js <contrato_id> --alterar    → inclui ações que MEXEM
//
// O modo --alterar reinicia o roteador e troca o canal do Wi-Fi. Use apenas em
// contrato de teste, nunca em cliente real.

const path = require('path');
const raiz = path.resolve(__dirname, '..');

require(path.join(raiz, 'dist', 'config'));
const { sgp } = require(path.join(raiz, 'dist', 'integrations', 'sgp'));

const contratoId = Number(process.argv[2]);
const alterar = process.argv.includes('--alterar');

if (!Number.isInteger(contratoId) || contratoId <= 0) {
  console.error('uso: node scripts/testar-sgp.js <contrato_id> [--alterar]');
  process.exit(1);
}

const V = '\x1b[32m✓\x1b[0m';
const X = '\x1b[31m✗\x1b[0m';
const resumo = [];

function mostrar(v, prof = 1) {
  const pad = '  '.repeat(prof);
  if (v === null || v === undefined) return `${pad}(vazio)`;
  if (Array.isArray(v)) {
    if (!v.length) return `${pad}[] (lista vazia)`;
    return v.slice(0, 3).map((x) => `${pad}- ${JSON.stringify(x).slice(0, 260)}`).join('\n');
  }
  if (typeof v === 'object') {
    return Object.entries(v).slice(0, 14)
      .map(([k, x]) => `${pad}${k}: ${JSON.stringify(x).slice(0, 160)}`).join('\n');
  }
  return `${pad}${v}`;
}

async function teste(nome, fn, { critico = false } = {}) {
  process.stdout.write(`\n── ${nome}\n`);
  try {
    const r = await fn();
    const vazio = r === null || r === undefined || (Array.isArray(r) && !r.length);
    console.log(vazio ? `${X} sem retorno` : `${V} respondeu`);
    console.log(mostrar(r));
    resumo.push([vazio ? 'VAZIO' : 'OK', nome]);
    return r;
  } catch (e) {
    const st = e?.response?.status;
    const corpo = JSON.stringify(e?.response?.data ?? '').slice(0, 220);
    console.log(`${X} ERRO${st ? ` http ${st}` : ''}: ${e.message}`);
    if (corpo && corpo !== '""') console.log(`  corpo: ${corpo}`);
    resumo.push(['ERRO', nome]);
    if (critico) throw e;
    return null;
  }
}

(async () => {
  console.log(`\n═══ SGP · contrato ${contratoId} · ${alterar ? 'LEITURA + ALTERAÇÃO' : 'somente leitura'} ═══`);

  const dados = await teste('dadosDoContrato — status, endereço, serviços, PPPoE', () =>
    sgp.dadosDoContrato(contratoId));

  const ct = dados?.contratos?.find((c) => c.contrato === contratoId) ?? dados?.contratos?.[0];
  const servico = ct?.servicos?.[0];
  const servicoId = servico?.id;
  const login = servico?.login;

  console.log(`\n   → servico_id=${servicoId ?? '?'}  login_pppoe=${login ?? '?'}`);

  await teste('listarOcorrencias — histórico de chamados', () =>
    sgp.listarOcorrencias(contratoId, 5));

  await teste('listarOrdensServico — OS e visitas agendadas', () =>
    sgp.listarOrdensServico(contratoId, 5));

  if (login) {
    await teste('statusPppoe — sessão RADIUS', () => sgp.statusPppoe(login));
  } else {
    console.log(`\n${X} statusPppoe pulado: contrato sem login PPPoE`);
    resumo.push(['PULADO', 'statusPppoe']);
  }

  if (servicoId) {
    await teste('consultarCpe — Wi-Fi atual (SSID/status)', () =>
      sgp.consultarCpe(contratoId, servicoId));
    await teste('listarWifi — rádios e índices do CPE', () => sgp.listarWifi(servicoId));
  }

  const hoje = new Date();
  const em7 = new Date(hoje.getTime() + 7 * 864e5);
  const iso = (d) => d.toISOString().slice(0, 10);
  await teste(`agendaTecnica — visitas de ${iso(hoje)} a ${iso(em7)}`, () =>
    sgp.agendaTecnica(iso(hoje), iso(em7)));

  if (alterar && servicoId) {
    console.log('\n\x1b[33m⚠  MODO ALTERAÇÃO — as próximas ações mexem no equipamento\x1b[0m');
    await teste('reiniciarCpe — REBOOT do roteador', () => sgp.reiniciarCpe(servicoId));
    const radios = await sgp.listarWifi(servicoId).catch(() => []);
    const idx = radios.find((r) => r.index)?.index;
    if (idx) {
      await teste(`alterarCanalWifi — rádio ${idx} para canal 6`, () =>
        sgp.alterarCanalWifi(servicoId, idx, 6));
    } else {
      console.log(`${X} canal pulado: nenhum índice de rádio retornado`);
    }
  } else if (alterar) {
    console.log(`\n${X} modo --alterar pedido, mas não achei servico_id`);
  }

  console.log('\n═══ RESUMO ═══');
  for (const [st, nome] of resumo) {
    const cor = st === 'OK' ? '\x1b[32m' : st === 'ERRO' ? '\x1b[31m' : '\x1b[33m';
    console.log(`  ${cor}${st.padEnd(7)}\x1b[0m ${nome}`);
  }
  const erros = resumo.filter((r) => r[0] === 'ERRO').length;
  console.log(`\n${erros ? X : V} ${resumo.length - erros}/${resumo.length} responderam\n`);
})().catch((e) => {
  console.error('\nfalha geral:', e.message);
  process.exit(1);
});
