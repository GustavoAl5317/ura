// Regressão: Zabbix fora do ar NÃO pode virar "sem incidentes".
//
// O bug original: problemasPorPadroes e hostIdsPorNomes capturavam o erro dentro
// do laço, logavam warning e seguiam. Com o Zabbix inacessível, todos os padrões
// falhavam e a função devolvia lista vazia SEM lançar — então diagnosticar()
// concluía temIncidente:false, indistinguível de rede saudável. A URA chegava a
// dizer ao cliente que não havia problema na região dele.
//
// Aponta o cliente para uma porta morta e exige que o erro apareça.

import { config } from './src/config';

// Precisa mudar ANTES de instanciar: o construtor lê a baseUrl uma única vez.
config.zabbix.enabled = true;
config.zabbix.baseUrl = 'http://127.0.0.1:1';   // recusa conexão na hora
config.zabbix.username = 'teste';
config.zabbix.password = 'teste';
config.zabbix.timeoutMs = 3_000;

import { ZabbixClient } from './src/integrations/zabbix';

let passou = 0;
let falhou = 0;

function checa(rotulo: string, ok: boolean, detalhe = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${rotulo}${ok || !detalhe ? '' : `\n      ${detalhe}`}`);
  ok ? passou++ : falhou++;
}

async function main() {
  const z = new ZabbixClient();

  console.log('\n─── problemasPorPadroes com Zabbix inacessível ───');
  try {
    const r = await z.problemasPorPadroes(['CTO', 'PPPoE', 'POP']);
    checa(
      'deve LANÇAR, não devolver lista vazia',
      false,
      `devolveu ${JSON.stringify(r)} — falso negativo silencioso de volta`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    checa('lança quando todos os padrões falham', true);
    checa('a mensagem diz que o Zabbix está inacessível', /inacess/i.test(msg), msg);
  }

  console.log('\n─── historicoEventos com Zabbix inacessível ───');
  try {
    const r = await z.historicoEventos(['CTO 4 RUA 731, 310'], 24);
    checa(
      'deve LANÇAR, não devolver zero quedas',
      false,
      `devolveu ${JSON.stringify(r)} — "sem quedas" seria mentira`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    checa('lança ao não conseguir resolver o host', true);
    checa('a mensagem diz que o Zabbix está inacessível', /inacess/i.test(msg), msg);
  }

  console.log('\n─── diagnosticar converte a falha em erro explícito ───');
  const d = await z.diagnosticar(['CTO 4 RUA 731, 310']);
  checa('não afirma temIncidente=false silenciosamente', !!d.erro,
    `erro=${d.erro ?? '(vazio)'} temIncidente=${d.temIncidente}`);
  checa('temIncidente continua false, mas acompanhado de erro', d.temIncidente === false);

  // ── Semelhança de nomes ────────────────────────────────────────────────────
  // SGP, Zabbix e o técnico escrevem a mesma CTO de três jeitos diferentes.
  // Casar frouxo demais mistura CTOs vizinhas; apertado demais devolve "não
  // houve queda" para uma CTO que caiu. As duas falhas são graves.
  console.log('\n─── Semelhança de nomes de CTO ───');
  const CTO3 = 'CTO 3 - Rua Araçá, 194- OFFLINE';
  const CTO5 = 'CTO 5 - RUA NOVA JERUSALÉM, 432- OFFLINE';
  const LIMIAR = ZabbixClient.LIMIAR_SEMELHANCA;

  const casos: Array<[string, string, boolean]> = [
    ['sem acento e com "da"', 'CTO 3 da Rua Araca', true],
    ['só o essencial', 'cto 3 araca', true],
    ['com acento certo', 'CTO 3 Araçá', true],
    ['formato do SGP', 'CTO 3 Rua Araçá, 194', true],
    ['CTO vizinha NÃO pode casar', 'CTO 5 da Rua Araca', false],
    ['número diferente NÃO pode casar', 'CTO 9 Rua Araca', false],
    ['rua diferente NÃO pode casar', 'CTO 3 Rua Nova Jerusalem', false],
  ];

  for (const [rotulo, termo, deveCasar] of casos) {
    const s = ZabbixClient.semelhanca(termo, CTO3);
    checa(`${rotulo}: "${termo}" ${deveCasar ? 'casa' : 'não casa'} (${s.toFixed(2)})`,
      (s >= LIMIAR) === deveCasar);
  }

  checa('CTO 3 não casa com o nome da CTO 5',
    ZabbixClient.semelhanca('CTO 3 da Rua Araca', CTO5) < LIMIAR,
    `deu ${ZabbixClient.semelhanca('CTO 3 da Rua Araca', CTO5).toFixed(2)}`);

  checa('dígito único do número da CTO não é descartado',
    ZabbixClient.semelhanca('CTO 3', CTO3) > ZabbixClient.semelhanca('CTO 3', CTO5));

  console.log(`\n${passou} passaram, ${falhou} falharam\n`);
  process.exit(falhou ? 1 : 0);
}

main().catch((e) => { console.error('FALHOU:', e); process.exit(1); });
