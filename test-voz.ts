// Round-trip real de voz: texto → TTS (OGG/Opus) → Whisper → texto.
// Fecha o buraco de "voice.ts nunca rodou". Usa a chave de produção.
import fs from 'fs';
import { sintetizar, transcrever, textoParaFala } from './src/assistant/voice';

const RESPOSTA_REAL = `🟢 *CONFIRMADO*

*Cliente* — ABACOS IRAPUAN, contrato 3351, plano 400 MEGAS, Ativo
*Óptico* — SN RCMG19c050ca, RX -19.17 dBm, TX 2.09 dBm
*CTO* — CTO 4 RUA 731, 310 · OLT-1 slot 2 PON 6
*Quedas* — 3 nas últimas 24h, 12 min fora no total

Sinal dentro do aceitável. As quedas coincidem com o incidente na CTO.

_Fontes:_
_evd_1 · sgp · sgp.onu_ao_vivo · 09:14_
_evd_2 · zabbix · zabbix.historico_quedas · 09:14_`;

async function main() {
  console.log('=== 1. Limpeza para fala ===');
  const falado = textoParaFala(RESPOSTA_REAL);
  console.log(falado);
  console.log();
  for (const [rotulo, ruim] of [
    ['rótulos evd_N', /evd_\d/i],
    ['rodapé de fontes', /Fontes:/i],
    ['asteriscos', /\*/],
    ['emoji de veredito', /🟢|🟡|🔴/],
  ] as Array<[string, RegExp]>) {
    console.log(`  ${ruim.test(falado) ? '✗ AINDA TEM' : '✓ removido'}: ${rotulo}`);
  }

  console.log('\n=== 2. TTS (OpenAI → OGG/Opus) ===');
  const t0 = Date.now();
  const ogg = await sintetizar(RESPOSTA_REAL);
  if (!ogg) { console.error('FALHOU: sintetizar devolveu null'); process.exit(1); }
  console.log(`  ${Math.round(ogg.length / 1024)} KB em ${Date.now() - t0} ms`);

  // OggS é a assinatura do container Ogg — se não bater, o WhatsApp rejeita como PTT.
  const magic = ogg.subarray(0, 4).toString('ascii');
  console.log(`  assinatura do container: "${magic}" ${magic === 'OggS' ? '✓ Ogg válido' : '✗ NÃO é Ogg'}`);
  fs.writeFileSync('voz-teste.ogg', ogg);

  console.log('\n=== 3. Whisper (OGG → texto) ===');
  const t1 = Date.now();
  const texto = await transcrever(ogg, 'voz-teste.ogg');
  if (!texto) { console.error('FALHOU: transcrever devolveu null'); process.exit(1); }
  console.log(`  ${Date.now() - t1} ms`);
  console.log(`  "${texto}"`);

  console.log('\n=== 4. Termos técnicos sobreviveram ao round-trip? ===');
  const alvo = texto.toLowerCase().replace(/[.,]/g, '');
  for (const termo of ['cto', 'olt', 'pon', 'contrato', 'sinal', 'quedas', 'ativo']) {
    console.log(`  ${alvo.includes(termo) ? '✓' : '✗'} ${termo}`);
  }
  const numeros = texto.match(/\d+/g) ?? [];
  console.log(`  números reconhecidos: ${numeros.join(', ')}`);
}

main().catch((e) => { console.error('FALHOU:', e?.message ?? e); process.exit(1); });
