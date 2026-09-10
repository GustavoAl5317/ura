// Sync do espelho do SGP como job avulso, sem depender do servidor HTTP.
//   npm run sync:espelho              → base inteira (~20 min)
//   npm run sync:espelho -- --retomar → continua de onde o último sync falhou
//   npm run sync:espelho -- 5         → só 5 páginas (validação; deixa PARCIAL)
import { sincronizar, statusIndice } from './src/assistant/store/sgp-index';

const args = process.argv.slice(2);
const retomar = args.includes('--retomar');
const paginas = args.find((a) => /^\d+$/.test(a));

sincronizar({
  ...(paginas ? { maxPaginas: parseInt(paginas, 10) } : {}),
  ...(retomar ? { retomar: true } : {}),
}).then((r) => {
  console.log('\n=== RESULTADO ===');
  console.log(JSON.stringify(r, null, 1));
  console.log('=== ESPELHO ===');
  console.log(JSON.stringify(statusIndice(), null, 1));
  if (r.parcial) console.log('\nATENÇÃO: espelho INCOMPLETO (limite de páginas pedido).');
  if (!r.ok) console.log('\nFalhou. Continue de onde parou com:  npm run sync:espelho -- --retomar');
  process.exit(r.ok ? 0 : 1);
});
