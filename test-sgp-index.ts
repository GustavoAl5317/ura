// Valida o espelho local ponta a ponta: busca 1 página real do SGP, indexa e
// consulta por SN, nome, login, CPF, contrato e CTO.
import { sgp } from './src/integrations/sgp';
import { indexar, buscar, statusIndice } from './src/assistant/store/sgp-index';
import { db } from './src/assistant/store/db';

async function main() {
  console.log('Buscando 1 página real do SGP (limit=100)…');
  const t0 = Date.now();
  const pagina = await sgp.listarPaginaBruta(0, 100);
  if (!pagina) throw new Error('SGP não respondeu');
  console.log(`  → ${pagina.clientes.length} clientes de ${pagina.total} totais em ${Math.round((Date.now() - t0) / 1000)}s`);

  const r = indexar(pagina.clientes);
  console.log(`  → indexados ${r.clientes} clientes / ${r.servicos} serviços`);
  console.log('  → status:', statusIndice());

  const alvo = pagina.clientes
    .flatMap((c) => (c.contratos ?? []).flatMap((ct) => (ct.servicos ?? []).map((s) => ({ c, ct, s }))))
    .find((x) => x.s.onu?.serial);

  if (!alvo) { console.log('!! nenhum serviço com SN nesta página'); return; }

  const sn = alvo.s.onu!.serial!;
  const nome = alvo.c.nome;
  const login = alvo.s.login ?? '';
  const cpf = alvo.c.cpfcnpj ?? '';
  const cto = alvo.s.onu!.splitter?.nome ?? '';

  const casos: Array<[string, string]> = [
    ['SN exato', sn],
    ['SN minúsculo', sn.toLowerCase()],
    ['nome completo', nome],
    ['nome parcial', nome.split(' ').slice(0, 2).join(' ')],
    ['nome sem acento', nome.normalize('NFD').replace(/[̀-ͯ]/g, '')],
    ['login', login],
    ['CPF pontuado', cpf],
    ['CPF só dígitos', cpf.replace(/\D/g, '')],
    ['contrato', String(alvo.ct.id)],
    ['CTO', cto],
    ['inexistente', 'ZZZZ NAO EXISTE 99999'],
  ];

  console.log('\n─── Busca ───');
  for (const [rotulo, termo] of casos) {
    if (!termo) { console.log(`  ${rotulo.padEnd(16)} (sem valor no registro, pulado)`); continue; }
    const res = buscar(termo);
    const p = res[0];
    console.log(
      `  ${rotulo.padEnd(16)} "${termo.slice(0, 32)}" → ${res.length} result` +
      (p ? ` | ${p.nome} · contrato ${p.contratoId} · via ${p.casouPor}` : ''),
    );
  }

  console.log('\n─── Segurança ───');
  for (const tabela of ['sgp_cliente', 'sgp_contrato', 'sgp_servico']) {
    const cols = (db().prepare(`PRAGMA table_info(${tabela})`).all() as Array<{ name: string }>).map((c) => c.name);
    const suspeitas = cols.filter((c) => /senha|password|pass/i.test(c));
    console.log(`  ${tabela.padEnd(14)} colunas com cara de senha: ${suspeitas.length ? suspeitas.join(', ') : 'nenhuma ✓'}`);
  }
}

main().catch((e) => { console.error('FALHOU:', e); process.exit(1); });
