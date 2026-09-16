// Teste da ponte URA → assistente. Simula ligações no registro de sessões e
// confere o que chega a um assistente falso. Nada sai da máquina.
//
//   npx ts-node --transpile-only test-ponte.ts

import http from 'http';
import type { AddressInfo } from 'net';

const recebidos: Array<Record<string, unknown>> = [];
const chaves: string[] = [];
let lento = false;

const servidor = http.createServer((req, res) => {
  let corpo = '';
  req.on('data', (c) => { corpo += c; });
  req.on('end', () => {
    chaves.push(String(req.headers['x-admin-key'] ?? ''));
    const responder = () => { recebidos.push(JSON.parse(corpo)); res.writeHead(202); res.end('{}'); };
    if (lento) setTimeout(responder, 10_000); else responder();
  });
});

let passou = 0;
let falhou = 0;
function checa(rotulo: string, ok: boolean, detalhe: unknown = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${rotulo}${ok || detalhe === '' ? '' : `  ${JSON.stringify(detalhe)}`}`);
  ok ? passou++ : falhou++;
}
const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await new Promise<void>((r) => servidor.listen(0, '127.0.0.1', r));
  process.env.ASSISTANT_EVENTS_URL = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}/`;
  process.env.ASSISTANT_EVENTS_KEY = 'CHAVE-URA';
  for (const k of ['OPENAI_API_KEY', 'SGP_BASE_URL', 'SGP_TOKEN']) process.env[k] ||= 'x';

  /* eslint-disable @typescript-eslint/no-var-requires */
  const { sessionRegistry } = require('./src/admin/registry');
  const { iniciarPonteAssistente } = require('./src/admin/assistant-bridge');
  /* eslint-enable @typescript-eslint/no-var-requires */
  iniciarPonteAssistente();

  console.log('\n─── Ligação completa ───');
  sessionRegistry.register('c1', { callerNumber: '5585999990000' });
  sessionRegistry.emit('c1', 'tool_start', 'x', { tool: 'buscar_cliente_por_cpf' });
  sessionRegistry.updateMeta('c1', { clienteNome: 'MARIA', contratoId: 101 });
  sessionRegistry.emit('c1', 'tool_start', 'x', { tool: 'verificar_massiva' });
  sessionRegistry.emit('c1', 'tool_start', 'x', { tool: 'transferir_para_atendente' });
  sessionRegistry.end('c1');
  await espera(500);

  const tipos = recebidos.map((r) => r.tipo);
  checa('envia início, identificação e fim, nessa ordem', tipos.join(',') === 'inicio,identificado,fim', tipos);
  const fim = recebidos.find((r) => r.tipo === 'fim')!;
  checa('fim leva cliente, contrato e ferramentas (sem as de só identificar)',
    fim.clienteNome === 'MARIA' && fim.contratoId === 101 &&
    JSON.stringify(fim.ferramentas) === JSON.stringify(['verificar_massiva', 'transferir_para_atendente']), fim);
  checa('usa a chave da URA', chaves.every((c) => c === 'CHAVE-URA'), chaves);
  checa('não envia nada da conversa', !JSON.stringify(recebidos).match(/transcri|texto|resposta/i));

  console.log('\n─── Assistente lento ou fora ───');
  lento = true;
  const t0 = Date.now();
  sessionRegistry.register('c2', { callerNumber: '5585988880000' });
  sessionRegistry.end('c2');
  checa('ligação não espera o assistente', Date.now() - t0 < 50, Date.now() - t0);
  servidor.closeAllConnections();
  servidor.close();
  let erro: unknown = null;
  try {
    sessionRegistry.register('c3', { callerNumber: '5585977770000' });
    sessionRegistry.emit('c3', 'tool_start', 'x', { tool: 'consultar_financeiro' });
    sessionRegistry.end('c3');
  } catch (e) { erro = e; }
  await espera(3500);
  checa('assistente fora do ar não gera erro na ligação', erro === null, String(erro));

  console.log(`\n${passou} passaram, ${falhou} falharam\n`);
  process.exit(falhou ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
