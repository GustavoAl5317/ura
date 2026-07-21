#!/usr/bin/env node
// Redefine a senha de um usuário do painel de atendimento.
// Funciona nas duas formas de armazenamento: SQLite (data/atendimento.db)
// e o JSON antigo (data/chat-usuarios.json).
//
//   node scripts/resetar-senha.js <login> <nova-senha>
//
// Pare o serviço antes (systemctl stop ura-chat) para não escrever junto.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const [login, senha] = process.argv.slice(2);

if (!login || !senha) {
  console.error('Uso: node scripts/resetar-senha.js <login> <nova-senha>');
  process.exit(1);
}
if (senha.length < 6) {
  console.error('A senha precisa de pelo menos 6 caracteres.');
  process.exit(1);
}

// Mesmo esquema usado pelo painel: scrypt com salt, guardado como "salt:hash".
function hashSenha(txt) {
  const salt = crypto.randomBytes(16);
  return `${salt.toString('hex')}:${crypto.scryptSync(txt, salt, 64).toString('hex')}`;
}

const dir = path.join(process.cwd(), 'data');
const arqDb = path.join(dir, 'atendimento.db');
const arqJson = path.join(dir, 'chat-usuarios.json');
const hash = hashSenha(senha);
let feito = false;

// ── SQLite ────────────────────────────────────────────────────────────────
let semSqlite = false;
if (fs.existsSync(arqDb)) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch {
    // Sem node:sqlite aqui — ainda pode haver o JSON antigo em uso.
    semSqlite = true;
    console.warn(
      `⚠ Existe data/atendimento.db, mas este Node (${process.version}) não tem node:sqlite.`,
    );
  }
  if (DatabaseSync) {
  const db = new DatabaseSync(arqDb);
  const r = db.prepare('UPDATE usuarios SET senha_hash = ?, ativo = 1 WHERE login = ?')
    .run(hash, login);
  if (r.changes) {
    db.prepare('DELETE FROM sessoes').run();
    console.log(`✔ SQLite: senha de "${login}" redefinida (sessões encerradas).`);
    feito = true;
  } else {
    const todos = db.prepare('SELECT login FROM usuarios').all().map((u) => u.login);
    console.error(`✘ SQLite: login "${login}" não existe. Disponíveis: ${todos.join(', ') || '(nenhum)'}`);
  }
  db.close();
  }
}

// ── JSON antigo ───────────────────────────────────────────────────────────
if (!feito && fs.existsSync(arqJson)) {
  const lista = JSON.parse(fs.readFileSync(arqJson, 'utf8'));
  const u = lista.find((x) => x.login === login);
  if (u) {
    u.senhaHash = hash;
    u.ativo = true;
    fs.writeFileSync(arqJson, JSON.stringify(lista, null, 2), 'utf8');
    console.log(`✔ JSON: senha de "${login}" redefinida.`);
    feito = true;
  } else {
    console.error(`✘ JSON: login "${login}" não existe. Disponíveis: ${lista.map((x) => x.login).join(', ')}`);
  }
}

if (!feito) {
  if (semSqlite) {
    console.error(
      'Para mexer no banco SQLite use o Node 22, ex.:\n' +
      '  /opt/node22/bin/node scripts/resetar-senha.js ' + login + ' <senha>',
    );
  } else if (!fs.existsSync(arqDb) && !fs.existsSync(arqJson)) {
    console.error(
      'Nenhum cadastro encontrado em data/. Se o serviço nunca subiu, defina ' +
      'CHAT_ADMIN_PASS no .env e inicie — o administrador é criado no primeiro boot.',
    );
  }
  process.exit(1);
}

console.log('Agora inicie o serviço: systemctl start ura-chat');
