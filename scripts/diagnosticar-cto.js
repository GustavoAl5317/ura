#!/usr/bin/env node
// Verifica, contra o SGP REAL, se a detecção de queda coletiva de CTO funciona
// para um contrato específico. Roda no servidor, a partir de /opt/ura-chat:
//
//   /opt/node22/bin/node scripts/diagnosticar-cto.js <CPF ou contrato>
//
// Mostra cada etapa da cadeia (ONU → CTO no cadastro → vizinhos → RADIUS), para
// saber exatamente ONDE quebra quando não detecta.

const { sgp, loginDaOnu } = require('../dist/integrations/sgp');

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
      onus.map(loginDaOnu).filter((l) => l.length > 2),
    )];
    console.log(`✅ ONUs na CTO: ${onus.length} | com login PPPoE: ${logins.length}`);

    if (process.env.DEBUG_ONU === '1') {
      console.log('\n--- ONUs cruas da CTO (DEBUG_ONU=1) ---');
      for (const o of onus) console.log(JSON.stringify(o));
      console.log('--- fim ---\n');
    }

    // 5. Mede no RADIUS (CTO primeiro; PON se a caixa não render amostra) -----
    // Espelha a lógica de produção, inclusive excluir o próprio cliente: ele já
    // sabemos que está offline, contá-lo enviesaria a amostra.
    async function medir(onusEscopo, escopo) {
      const lista = [...new Set(
        onusEscopo
          .filter((o) => o.service_contrato !== contratoId)
          .map(loginDaOnu)
          .filter((l) => l.length > 2),
      )];
      console.log(`\n--- ${escopo}: ${onusEscopo.length} ONU(s), ${lista.length} vizinho(s) com login (fora o cliente) ---`);
      if (lista.length < 3) {
        console.log('   ⚠️  Menos de 3 vizinhos — amostra insuficiente, não conclui.');
        return null;
      }

      const amostra = lista.slice(0, 12);
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
      console.log(`   📊 online=${online} offline=${offline} sem_resposta=${mudo}`);
      if (conhecidos < 3) {
        console.log('   ⚠️  RADIUS respondeu por menos de 3 — não conclui.');
        return null;
      }
      const pct = Math.round((offline / conhecidos) * 100);
      console.log(`   📊 ${offline}/${conhecidos} offline = ${pct}% (limiar 60%)`);
      return { escopo, pct };
    }

    let r = await medir(onus, `CTO ${nomeCto}`);
    if (!r && onu.olt_id != null && onu.pon != null) {
      const daOlt = await sgp.onusDaOlt(onu.olt_id).catch((e) => {
        console.log(`   ⚠️  Listar ONUs da OLT falhou: ${e.message}`);
        return [];
      });
      const mesmaPon = daOlt.filter((o) => o.pon === onu.pon && o.slot === onu.slot);
      console.log(`\n   (OLT tem ${daOlt.length} ONUs no total)`);
      r = await medir(mesmaPon, `PON ${onu.slot}/${onu.pon}`);
    }

    if (!r) {
      return console.log('\n✅ Sem amostra suficiente — chamado seria LIBERADO (comportamento seguro).');
    }
    console.log(
      r.pct >= 60
        ? `\n🚨 QUEDA COLETIVA em ${r.escopo} — a IA trataria como massiva e NÃO abriria chamado.`
        : `\n✅ Sem queda coletiva em ${r.escopo} — problema individual, chamado liberado.`,
    );
  } catch (err) {
    console.error('❌ Erro:', err && err.message ? err.message : err);
    process.exit(1);
  }
})();
