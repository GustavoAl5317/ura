// Sync do espelho do SGP como job avulso, sem depender do servidor HTTP.
//   npm run sync:espelho          → base inteira (~21 min, 3,6k clientes)
//   npm run sync:espelho -- 5     → só 5 páginas (validação; deixa o espelho PARCIAL)
import { sincronizar, statusIndice } from './src/assistant/store/sgp-index';

const arg = process.argv[2];
const maxPaginas = arg ? parseInt(arg, 10) : undefined;

sincronizar(maxPaginas ? { maxPaginas } : {}).then((r) => {
  console.log('\n=== RESULTADO ===');
  console.log(JSON.stringify(r, null, 1));
  console.log('=== ESPELHO ===');
  console.log(JSON.stringify(statusIndice(), null, 1));
  if (r.parcial) console.log('\nATENÇÃO: espelho INCOMPLETO. Rode sem argumento para a base toda.');
  process.exit(r.ok ? 0 : 1);
});
