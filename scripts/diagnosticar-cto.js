#!/usr/bin/env node
// Verifica, contra o SGP REAL, se a detecção de queda coletiva de CTO funciona
// para um contrato específico. Roda no servidor, a partir de /opt/ura-chat:
//
//   /opt/node22/bin/node scripts/diagnosticar-cto.js <CPF ou contrato>
//
// Mostra cada etapa da cadeia (ONU → CTO no cadastro → vizinhos → RADIUS), para
// saber exatamente ONDE quebra quando não detecta.

const { sgp } = require('../dist/integrations/sgp');

const arg = (process.argv[2] || '').replace(/\D/g, '');
if (!arg) {
  console.error('Uso: node scripts/diagnosticar-cto.js <CPF ou número do contrato>');
  process.exit(1);
}

(async () => {
  try {
    // 1. Contrato ------------------------------------------------------------
    let contratoId;
    if (arg.length === 11 || arg.length === 14) {
      const cli = await sgp.buscarPorCpf(arg);
      if (!cli) return console.error('❌ CPF não encontrado no SGP.');
      contratoId = cli.contratoId ?? cli.contratos?.[0]?.contrato;
      console.log(`✅ Cliente: ${cli.nome} — contrato ${contratoId}`);
    } else {
      contratoId = Number(arg);
      console.log(`✅ Contrato informado: ${contratoId}`);
    }
    if (!contratoId) return console.error('❌ Sem contrato utilizável.');

    // 2. ONU do cliente ------------------------------------------------------
    const onu = await sgp.onuDoContrato(contratoId, { fullFttx: true });
    if (!onu) return console.error('❌ ONU não localizada para este contrato.');
    const nomeCto = onu.cto_nome || onu.caixa;
    console.log(`✅ ONU: serial=${onu.serial} rx=${onu.rx} olt=${onu.olt_nome}`);
    console.log(`   CTO no cadastro: ${nomeCto || '(VAZIA — técnico não preencheu)'}`);
    if (!nomeCto) {
      return console.error(
        '\n❌ PARA AQUI: sem CTO no cadastro da ONU não há como achar os vizinhos.\n'
        + '   A detecção automática de queda de CTO não vai funcionar para este cliente.',
      );
    }

    // 3. CTO no catálogo de planta -------------------------------------------
    const alvo = nomeCto.trim().toLowerCase();
    const casa = (lista) => lista.find((c) => {
      const id = (c.ident || '').trim().toLowerCase();
      return !!id && (id === alvo || id.includes(alvo) || alvo.includes(id));
    });

    let ctos = [];
    let cto;
    if (onu.olt_id) {
      ctos = await sgp.listarCtosDaOlt(onu.olt_id).catch((e) => {
        console.log(`   ⚠️  CTOs da OLT falharam: ${e.message}`);
        return [];
      });
      console.log(`✅ CTOs da OLT ${onu.olt_id}: ${ctos.length} caixa(s)`);
      cto = casa(ctos);
    }
    if (!cto) {
      console.log('   ↳ não achou na OLT, tentando a planta inteira (chamada pesada)…');
      const todas = await sgp.listarCtos().catch((e) => {
        console.log(`   ⚠️  Planta inteira falhou: ${e.message}`);
        return [];
      });
      if (todas.length) { ctos = todas; console.log(`✅ Planta inteira: ${todas.length} caixa(s)`); }
      cto = casa(todas);
    }
    if (!cto) {
      return console.error(
        `\n❌ PARA AQUI: a CTO "${nomeCto}" não casou com nenhuma do catálogo.\n`
        + '   Exemplos de ident cadastrados: '
        + ctos.slice(0, 8).map((c) => JSON.stringify(c.ident)).join(' | '),
      );
    }
    console.log(`✅ CTO no catálogo: id=${cto.id} ident="${cto.ident}" portas=${cto.ports}`);

    // 4. Vizinhos ------------------------------------------------------------
    const onus = await sgp.onusDaCto(cto.id);
    const logins = [...new Set(
      onus.map((o) => (o.login || o.onu_login || '').trim()).filter((l) => l.length > 2),
    )];
    console.log(`✅ ONUs na CTO: ${onus.length} | com login PPPoE: ${logins.length}`);

    if (process.env.DEBUG_ONU === '1') {
      console.log('\n--- ONUs cruas da CTO (DEBUG_ONU=1) ---');
      for (const o of onus) console.log(JSON.stringify(o));
      console.log('--- fim ---\n');
    }

    if (logins.length < 3) {
      console.error(
        '\n⚠️  Menos de 3 vizinhos com login PPPoE nesta CTO.\n'
        + '   Por segurança o sistema NÃO conclui queda de CTO (chamado segue liberado).',
      );
      if (!logins.length && onus.length) {
        console.error(
          '   ↳ As ONUs existem mas vieram SEM login. Rode de novo com DEBUG_ONU=1\n'
          + '     para ver os campos disponíveis e achar por onde ligar no RADIUS.',
        );
      }

      // A CTO é uma amostra pequena. A PON do cliente costuma ter dezenas de
      // ONUs e um rompimento na fibra derruba a PON inteira — vale medir.
      console.log('\n--- Tentando pela PON (amostra maior que a CTO) ---');
      try {
        const daOlt = await sgp.onusDaOlt(onu.olt_id);
        const mesmaPon = daOlt.filter((o) => o.pon === onu.pon && o.slot === onu.slot);
        const loginsPon = [...new Set(
          mesmaPon.map((o) => (o.login || o.onu_login || '').trim()).filter((l) => l.length > 2),
        )];
        console.log(`   ONUs na OLT: ${daOlt.length} | na PON ${onu.slot}/${onu.pon}: ${mesmaPon.length} | com login: ${loginsPon.length}`);
        if (process.env.DEBUG_ONU === '1' && mesmaPon.length) {
          console.log('   exemplo:', JSON.stringify(mesmaPon[0]));
        }
      } catch (e) {
        console.log(`   ⚠️  Falhou: ${e.message}`);
      }
      return;
    }

    // 5. RADIUS --------------------------------------------------------------
    const amostra = logins.slice(0, 12);
    console.log(`\n   Consultando RADIUS para ${amostra.length} vizinho(s)…`);
    const sessoes = await Promise.all(
      amostra.map((l) => sgp.statusPppoe(l).then((s) => ({ l, s })).catch(() => ({ l, s: undefined }))),
    );

    let online = 0, offline = 0, mudo = 0;
    for (const { l, s } of sessoes) {
      if (s === undefined || s === null) { mudo++; console.log(`   • ${l}: (RADIUS não respondeu)`); continue; }
      const on = s.online === true || s.online === 1 || s.online === '1';
      on ? online++ : offline++;
      console.log(`   • ${l}: ${on ? 'ONLINE' : 'OFFLINE'}`);
    }

    const conhecidos = online + offline;
    console.log(`\n📊 online=${online} offline=${offline} sem_resposta=${mudo}`);
    if (conhecidos < 3) {
      return console.error('⚠️  RADIUS respondeu por menos de 3 vizinhos — não conclui (chamado liberado).');
    }
    const pct = Math.round((offline / conhecidos) * 100);
    console.log(`📊 ${offline}/${conhecidos} offline = ${pct}% (limiar: 60%)`);
    console.log(
      pct >= 60
        ? '\n🚨 QUEDA COLETIVA DE CTO — a IA trataria como massiva e NÃO abriria chamado.'
        : '\n✅ Sem queda coletiva — problema individual, chamado liberado normalmente.',
    );
  } catch (err) {
    console.error('❌ Erro:', err && err.message ? err.message : err);
    process.exit(1);
  }
})();
