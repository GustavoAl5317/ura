#!/usr/bin/env node
// Testa o webhook da Cloud API sem depender da Meta e sem migrar o número.
//
//   node scripts/testar-cloud-webhook.js https://chatbot.aquitelecom.com
//
// Lê CLOUD_VERIFY_TOKEN, CLOUD_APP_SECRET e CLOUD_ALLOWED_PHONE_IDS do .env
// (ou do ambiente) e faz três checagens:
//   1. GET  /cloud/webhook com token errado  → espera 403
//   2. GET  /cloud/webhook com token certo   → espera 200 + o challenge de volta
//   3. POST /cloud/webhook assinado          → espera 200 e a conversa no painel
//
// O passo 3 exercita a stack inteira (assinatura, IA, consultas SGP, banco,
// painel). Só o envio da resposta falha enquanto o número não estiver ativo —
// isso aparece no log como erro da Graph API e é esperado.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const base = (process.argv[2] || 'https://chatbot.aquitelecom.com').replace(/\/+$/, '');
const numeroTeste = process.argv[3] || '5585999999999';

// ── Carrega o .env sem dependências ─────────────────────────────────────────
function lerEnv() {
  const arquivo = path.resolve(__dirname, '..', '.env');
  if (!fs.existsSync(arquivo)) return {};
  const out = {};
  for (const linha of fs.readFileSync(arquivo, 'utf8').split('\n')) {
    const m = linha.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

const env = { ...lerEnv(), ...process.env };
const verifyToken = env.CLOUD_VERIFY_TOKEN;
const appSecret = env.CLOUD_APP_SECRET;
const phoneNumberId = (env.CLOUD_ALLOWED_PHONE_IDS || '').split(',')[0].trim();

if (!verifyToken) {
  console.error('✗ CLOUD_VERIFY_TOKEN não encontrado (.env ou ambiente)');
  process.exit(1);
}
if (!phoneNumberId) {
  console.error('✗ CLOUD_ALLOWED_PHONE_IDS não encontrado — preciso do phone_number_id');
  process.exit(1);
}

const ok = (m) => console.log(`\x1b[32m✓\x1b[0m ${m}`);
const falha = (m) => console.log(`\x1b[31m✗\x1b[0m ${m}`);

async function teste1() {
  const url = `${base}/cloud/webhook?hub.mode=subscribe&hub.verify_token=token-errado&hub.challenge=123`;
  const r = await fetch(url);
  if (r.status === 403) return ok('1. Token inválido recusado (403)');
  if (r.status === 404) {
    falha('1. 404 — a rota não existe no ar. O servidor está com build antigo.');
    process.exit(1);
  }
  falha(`1. Esperava 403, veio ${r.status}`);
}

async function teste2() {
  const challenge = String(Date.now());
  const url = `${base}/cloud/webhook?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(verifyToken)}&hub.challenge=${challenge}`;
  const r = await fetch(url);
  const corpo = (await r.text()).trim();
  if (r.status === 200 && corpo === challenge) {
    return ok('2. Verificação da Meta aceita — pode cadastrar o webhook no painel');
  }
  falha(`2. Esperava 200 + "${challenge}", veio ${r.status} + "${corpo.slice(0, 60)}"`);
  if (r.status === 403) {
    console.log('   → o CLOUD_VERIFY_TOKEN do servidor é diferente do que está aqui');
  }
}

async function teste3(texto) {
  const payload = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{
      id: '1452417953189101',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: '558532211777', phone_number_id: phoneNumberId },
          contacts: [{ profile: { name: 'Teste Automatizado' }, wa_id: numeroTeste }],
          messages: [{
            from: numeroTeste,
            id: `wamid.TESTE.${Date.now()}`,
            timestamp: String(Math.floor(Date.now() / 1000)),
            type: 'text',
            text: { body: texto },
          }],
        },
      }],
    }],
  });

  const headers = { 'Content-Type': 'application/json' };
  if (appSecret) {
    headers['X-Hub-Signature-256'] =
      'sha256=' + crypto.createHmac('sha256', appSecret).update(payload, 'utf8').digest('hex');
  }

  const r = await fetch(`${base}/cloud/webhook`, { method: 'POST', headers, body: payload });
  if (r.status === 200) {
    ok(`3. Mensagem aceita: "${texto}"`);
    console.log('   → confira no painel se a conversa apareceu e o que a IA respondeu');
    return;
  }
  if (r.status === 403) {
    falha('3. Assinatura recusada — CLOUD_APP_SECRET diferente do servidor');
    return;
  }
  falha(`3. Esperava 200, veio ${r.status}`);
}

(async () => {
  console.log(`\nTestando ${base}\nphone_number_id: ${phoneNumberId}\n`);
  await teste1();
  await teste2();
  await teste3('oi, quero saber sobre os planos de internet');
  console.log('');
})().catch((e) => {
  falha(`erro de conexão: ${e.message}`);
  process.exit(1);
});
