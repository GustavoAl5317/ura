// Teste da decisão de acesso às rotas /api: chave de administrador e chave
// própria da URA (que só entrega eventos de chamada).
//
//   npm run test:acesso

import fs from 'fs';
import os from 'os';
import path from 'path';

for (const k of ['OPENAI_API_KEY', 'SGP_BASE_URL', 'SGP_TOKEN']) {
  process.env[k] ||= 'teste-acesso-sem-uso';
}
process.env.ASSISTANT_ENABLED = '0';   // importar o index não sobe o servidor
process.env.ADMIN_API_KEY = 'CHAVE-ADMIN';
process.env.URA_EVENTS_KEY = 'CHAVE-URA';
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'aq-acesso-')));

/* eslint-disable @typescript-eslint/no-var-requires */
const { acessoApi } = require(path.join(__dirname, 'src', 'assistant', 'index')) as typeof import('./src/assistant/index');
const { config } = require(path.join(__dirname, 'src', 'config')) as typeof import('./src/config');
/* eslint-enable @typescript-eslint/no-var-requires */

let passou = 0;
let falhou = 0;
function checa(rotulo: string, ok: boolean, detalhe: unknown = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${rotulo}${ok || detalhe === '' ? '' : `  ${JSON.stringify(detalhe)}`}`);
  ok ? passou++ : falhou++;
}

const req = (method: string, chave?: string) => ({ method, headers: chave ? { 'x-admin-key': chave } : {} }) as never;
const url = (p: string) => new URL(`http://x${p}`);
const acesso = (method: string, p: string, chave?: string) => acessoApi(req(method, chave), url(p), p);

console.log('\n─── Chave da URA ───');
checa('entrega evento de chamada', acesso('POST', '/api/eventos/ura', 'CHAVE-URA') === 200);
checa('não lê consultas', acesso('GET', '/api/consultas', 'CHAVE-URA') === 403);
checa('não muda configuração', acesso('PUT', '/api/config/ia.modelo', 'CHAVE-URA') === 403);
checa('não usa o chat', acesso('POST', '/api/chat', 'CHAVE-URA') === 403);
checa('não lê as chamadas (só envia)', acesso('GET', '/api/chamadas', 'CHAVE-URA') === 403);

console.log('\n─── Chave de administrador ───');
checa('acessa tudo', acesso('GET', '/api/consultas', 'CHAVE-ADMIN') === 200 && acesso('POST', '/api/eventos/ura', 'CHAVE-ADMIN') === 200);
checa('sem chave: 401', acesso('POST', '/api/eventos/ura') === 401 && acesso('GET', '/api/consultas') === 401);
checa('chave errada: 401', acesso('POST', '/api/eventos/ura', 'OUTRA') === 401);

console.log('\n─── Configuração ───');
(config.assistant as { chaveEventosUra: string }).chaveEventosUra = '';
checa('sem URA_EVENTS_KEY: evento exige a chave de administrador', acesso('POST', '/api/eventos/ura', 'CHAVE-URA') === 401 && acesso('POST', '/api/eventos/ura', 'CHAVE-ADMIN') === 200);
(config.assistant as { chaveEventosUra: string }).chaveEventosUra = 'CHAVE-ADMIN';
checa('URA_EVENTS_KEY igual à de admin não rebaixa o admin', acesso('GET', '/api/consultas', 'CHAVE-ADMIN') === 200);

console.log(`\n${passou} passaram, ${falhou} falharam\n`);
process.exit(falhou ? 1 : 0);
