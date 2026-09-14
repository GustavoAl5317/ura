// Testes da camada administrativa (Bloco 6) contra o assistente rodando.
//   npm run assistant   (em outro terminal)
//   npm run test:admin
// Restaura toda configuração que alterar, mesmo se um teste falhar.

import 'dotenv/config';

const BASE = process.env.TESTE_URL ?? `http://127.0.0.1:${process.env.ASSISTANT_PORT ?? 9022}`;
const KEY = process.env.ADMIN_API_KEY ?? '';
const H = { 'Content-Type': 'application/json', 'x-admin-key': KEY, 'x-operador': 'teste-automatizado' };

let passou = 0;
let falhou = 0;
function checa(rotulo: string, ok: boolean, detalhe = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${rotulo}${ok || !detalhe ? '' : `\n      ${detalhe}`}`);
  ok ? passou++ : falhou++;
}

async function api(metodo: string, caminho: string, corpo?: unknown) {
  const r = await fetch(`${BASE}${caminho}`, { method: metodo, headers: H, body: corpo === undefined ? undefined : JSON.stringify(corpo) });
  const texto = await r.text();
  let j: any = null;
  try { j = JSON.parse(texto); } catch { j = texto; }
  return { status: r.status, j };
}

const USUARIO_TESTE = '85999990000';
const restaurar: string[] = [];

async function main() {
  console.log('\n─── Configuração: validação recusa valor ruim ───');
  let r = await api('PUT', '/api/config/ia.modelo', { valor: 'gpt-4o' });
  checa('recusa modelo fora da allowlist da OpenAI (gpt-4o)', r.status === 400, JSON.stringify(r.j));
  checa('a recusa lista os modelos liberados', /liberados/i.test(r.j?.error ?? ''));

  r = await api('PUT', '/api/config/monitor.sla.minutos', { valor: 0 });
  checa('recusa SLA de 0 minuto (mínimo 1)', r.status === 400, JSON.stringify(r.j));

  r = await api('PUT', '/api/config/alertas.silencio_inicio', { valor: '25:00' });
  checa('recusa hora inválida 25:00', r.status === 400, JSON.stringify(r.j));

  r = await api('PUT', '/api/config/monitor.zabbix.tipos', { valor: ['cto_off', 'inventado'] });
  checa('recusa tipo de incidente inexistente', r.status === 400, JSON.stringify(r.j));

  r = await api('PUT', '/api/config/nao.existe', { valor: 1 });
  checa('chave desconhecida → 404', r.status === 404);

  console.log('\n─── Configuração: valor bom grava, audita e restaura ───');
  r = await api('PUT', '/api/config/monitor.sla.minutos', { valor: 20 });
  restaurar.push('monitor.sla.minutos');
  checa('grava SLA de 20 minutos', r.status === 200 && r.j?.valor === 20, JSON.stringify(r.j));
  const cfg = await api('GET', '/api/config');
  const item = cfg.j.itens.find((i: any) => i.chave === 'monitor.sla.minutos');
  checa('aparece como alterado, com o padrão ao lado', item?.alterado === true && item?.valor === 20 && item?.padrao === 15);

  const aud = await api('GET', '/api/auditoria/busca?acao=config&alvo=monitor.sla.minutos&limite=1');
  const reg = aud.j.registros?.[0];
  checa('auditoria registra quem mudou, antes e depois',
    reg?.ator === 'painel:teste-automatizado' && JSON.parse(reg.antes) === 15 && JSON.parse(reg.depois) === 20,
    JSON.stringify(reg));

  console.log('\n─── Permissões ───');
  await api('DELETE', `/api/permissoes/${encodeURIComponent(`55${USUARIO_TESTE}@s.whatsapp.net`)}`);
  r = await api('POST', '/api/permissoes', { usuario: USUARIO_TESTE, nome: 'Técnico Teste', papel: 'tecnico', fontes: ['sgp'] });
  checa('cadastra técnico por número e normaliza para JID', r.status === 201 && r.j?.usuario === `55${USUARIO_TESTE}@s.whatsapp.net`, JSON.stringify(r.j));
  const jid = r.j?.usuario;

  r = await api('POST', '/api/permissoes', { usuario: USUARIO_TESTE });
  checa('recusa cadastro duplicado (409)', r.status === 409);

  r = await api('POST', '/api/permissoes', { usuario: '85988887777', fontes: ['sgp', 'inventada'] });
  checa('recusa fonte inexistente', r.status === 400);

  r = await api('PUT', `/api/permissoes/${encodeURIComponent(jid)}`, { ativo: false });
  checa('desativa', r.status === 200 && r.j?.permissao?.ativo === false, JSON.stringify(r.j));

  console.log('\n─── Regras de autorização (em processo) ───');
  const canal = await import('./src/assistant/channels/whatsapp-tecnicos');
  const agente = await import('./src/assistant/agent');
  checa('desativado no painel NÃO é autorizado', canal.autorizado(jid) === false);
  checa('desativado não tem fonte nenhuma (antes: acesso irrestrito)', JSON.stringify(agente.fontesDoUsuario(jid)) === '[]');
  checa('nono dígito: 5585 9 9999-0000 casa com 5585 9999-0000',
    canal.mesmoNumero('5585999990000@s.whatsapp.net', '558599990000@s.whatsapp.net'));
  checa('DDD diferente com mesmo final NÃO casa',
    !canal.mesmoNumero('5585999990000@s.whatsapp.net', '5511999990000@s.whatsapp.net'));

  await api('PUT', `/api/permissoes/${encodeURIComponent(jid)}`, { ativo: true });
  checa('reativado é autorizado sem mexer no .env', canal.autorizado(jid) === true);
  checa('fontes restritas respeitadas', JSON.stringify(agente.fontesDoUsuario(jid)) === '["sgp"]');

  r = await api('DELETE', `/api/permissoes/${encodeURIComponent(jid)}`);
  checa('remove', r.status === 200);
}

main()
  .catch((e) => { console.error('FALHOU:', e); falhou++; })
  .finally(async () => {
    for (const c of restaurar) await api('DELETE', `/api/config/${c}`);
    console.log(`\n${passou} passaram, ${falhou} falharam\n`);
    process.exit(falhou ? 1 : 0);
  });
