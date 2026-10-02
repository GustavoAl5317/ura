// Resumo com áudio: o texto completo vai, e logo depois um áudio curto com o
// principal, para todos que recebem. Modelo e voz simulados.
//
//   npm run test:resumo-audio

import fs from 'fs';
import os from 'os';
import path from 'path';

for (const k of ['OPENAI_API_KEY', 'SGP_BASE_URL', 'SGP_TOKEN']) {
  process.env[k] ||= 'teste-resumo-audio-sem-uso';
}
process.env.TZ ||= 'America/Fortaleza';
const RAIZ = __dirname;
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'aq-resumo-audio-')));

/* eslint-disable @typescript-eslint/no-var-requires */
const axios = require('axios');
const { db, fecharDb } = require(path.join(RAIZ, 'src', 'assistant', 'store', 'db')) as typeof import('./src/assistant/store/db');
const cfg = require(path.join(RAIZ, 'src', 'assistant', 'config-dinamica')) as typeof import('./src/assistant/config-dinamica');
const alertas = require(path.join(RAIZ, 'src', 'assistant', 'alertas')) as typeof import('./src/assistant/alertas');
const R = require(path.join(RAIZ, 'src', 'assistant', 'resumo-diario')) as typeof import('./src/assistant/resumo-diario');
const { evoTecnicos } = require(path.join(RAIZ, 'src', 'assistant', 'channels', 'whatsapp-tecnicos')) as typeof import('./src/assistant/channels/whatsapp-tecnicos');
/* eslint-enable @typescript-eslint/no-var-requires */

let passou = 0;
let falhou = 0;
function checa(rotulo: string, ok: boolean, detalhe: unknown = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${rotulo}${ok || detalhe === '' ? '' : `\n      ${typeof detalhe === 'string' ? detalhe : JSON.stringify(detalhe).slice(0, 400)}`}`);
  ok ? passou++ : falhou++;
}

// Modelo e voz: o roteiro diz o que cada um devolve.
let falaDoModelo: string | null = '*Boa tarde.* Resumo das últimas horas: a rede está funcionando. A caixa 3 da Rua Araçá continua sem sinal.';
let vozFalha = false;
const pedidosModelo: Array<{ messages: Array<{ role: string; content: string }> }> = [];
axios.post = async (url: string, corpo: any) => {
  if (/audio\/speech/.test(url)) {
    if (vozFalha) throw Object.assign(new Error('voz fora'), { response: { status: 500 } });
    return { data: Buffer.from('OGG-FALSO') };
  }
  pedidosModelo.push(corpo);
  if (falaDoModelo === null) throw new Error('modelo fora');
  return { data: { choices: [{ message: { role: 'assistant', content: falaDoModelo } }], usage: {} } };
};

const textos: string[] = [];
const audios: Array<{ para: string; tamanho: number }> = [];
Object.defineProperty(evoTecnicos, 'disponivel', { get: () => true });
(evoTecnicos as any).enviarTextoComId = async (para: string, texto: string) => { textos.push(`${para}|${texto}`); return { ok: true, id: `m${textos.length}` }; };
(evoTecnicos as any).enviarAudio = async (para: string, ogg: Buffer) => { audios.push({ para, tamanho: ogg.length }); return true; };

async function main(): Promise<void> {
  db();
  cfg.definir('alertas.destino_grupo', '12345@g.us', 'teste');
  cfg.definir('alertas.silencio_inicio', '00:00', 'teste');
  cfg.definir('alertas.silencio_fim', '00:00', 'teste');

  console.log('\n─── Versão falada ───');
  const fim = new Date('2026-10-02T17:00:00Z'); // 14:00 em Fortaleza
  const instr = R.instrucaoResumoFalado('14:00');
  checa('a instrução diz a hora, o tamanho e "só fatos do resumo"',
    /Agora são 14:00/.test(instr) && new RegExp(`${R.MAX_FALA_RESUMO} caracteres`).test(instr) && /SÓ fatos/.test(instr));
  const f = await R.resumoFalado('*Resumo*\n• rede ok\n• CTO 3 sem sinal', fim);
  checa('a fala sai sem asterisco nem marcador', !!f && !/[*•_]/.test(f), f);
  checa('e termina mandando ver o texto', /O detalhe está no texto\.$/.test(f ?? ''), f);
  checa('o modelo recebe o resumo e a instrução, sem ferramenta',
    pedidosModelo[0].messages[1].content.includes('CTO 3 sem sinal') && !('tools' in pedidosModelo[0] && (pedidosModelo[0] as any).tools));
  falaDoModelo = 'Boa tarde. ' + 'A rede está funcionando e nada mudou nas caixas. '.repeat(40);
  const longa = await R.resumoFalado('resumo', fim);
  checa('fala comprida demais é cortada numa frase inteira', !!longa && longa.length <= R.MAX_FALA_RESUMO + 40, longa?.length);
  falaDoModelo = null;
  checa('modelo fora: sem fala', (await R.resumoFalado('resumo', fim)) === null);

  console.log('\n─── Envio ───');
  falaDoModelo = 'Boa tarde. A rede está funcionando. O detalhe está no texto.';
  textos.length = 0; audios.length = 0;
  let a = await R.enviarResumo({ chave: 'resumo:teste:1', fim });
  checa('o texto completo vai', textos.length === 1 && /12345@g\.us/.test(textos[0]), textos);
  checa('o texto abre com "Em poucas palavras", sem o "detalhe no texto"',
    /\|\*Em poucas palavras:\* Boa tarde\. A rede está funcionando\.\n\n/.test(textos[0] ?? '') && !/detalhe está no texto/.test(textos[0] ?? ''), textos[0]?.slice(0, 160));
  checa('e o áudio vai junto para o mesmo destino', audios.length === 1 && audios[0].para === '12345@g.us', audios);
  checa('o resumo fica registrado como enviado', !!a?.enviado_em, a?.envio_erro);

  textos.length = 0; audios.length = 0;
  vozFalha = true;
  a = await R.enviarResumo({ chave: 'resumo:teste:2', fim });
  checa('voz fora: vai só o texto, sem erro', textos.length === 1 && audios.length === 0 && !!a?.enviado_em, { textos: textos.length, audios });
  vozFalha = false;

  textos.length = 0; audios.length = 0;
  falaDoModelo = null;
  a = await R.enviarResumo({ chave: 'resumo:teste:3', fim });
  checa('modelo fora: vai só o texto', textos.length === 1 && audios.length === 0, audios);

  textos.length = 0; audios.length = 0;
  falaDoModelo = 'Boa tarde. Tudo certo. O detalhe está no texto.';
  cfg.definir('resumo.enviar_audio', false, 'teste');
  await R.enviarResumo({ chave: 'resumo:teste:4', fim });
  checa('desligado no painel: sem áudio', textos.length === 1 && audios.length === 0);

  textos.length = 0; audios.length = 0;
  await alertas.emitir({ origem: 'zabbix', severidade: 'critico', titulo: 'CTO off', texto: 'CTO 3 off', chave: 'teste:alerta:1' });
  checa('alerta comum continua sem áudio', audios.length === 0 && textos.length === 1, { textos, audios });

  console.log('\n─── Aviso em palavras simples ───');
  /* eslint-disable-next-line @typescript-eslint/no-var-requires */
  const S = require(path.join(RAIZ, 'src', 'assistant', 'em-palavras-simples')) as typeof import('./src/assistant/em-palavras-simples');
  checa('caixa parada, com quantas casas',
    S.explicacaoSimples({ origem: 'zabbix', chave: 'zabbix:9', dados: { tipo: 'cto_off', impacto: { clientes: 12 } } }) ===
      'Uma caixinha no poste parou. As 12 casas ligadas nela estão sem internet agora.');
  checa('link vira "o cano grande"', /cano grande/.test(S.explicacaoSimples({ origem: 'zabbix', chave: 'zabbix:10', dados: { tipo: 'link' } }) ?? ''));
  checa('tipo desconhecido tem frase genérica', /sistema que vigia a rede/.test(S.explicacaoSimples({ origem: 'zabbix', chave: 'zabbix:11', dados: {} }) ?? ''));
  checa('sinal fraco explicado', /força da luz/.test(S.explicacaoSimples({ origem: 'ctos', chave: 'ctos:sinal:5:123' }) ?? ''));
  checa('sem medição não é "caiu"', /Não quer dizer que ela caiu/.test(S.explicacaoSimples({ origem: 'ctos', chave: 'ctos:sem_coleta:5:1' }) ?? ''));
  checa('resolvido: "Voltou ao normal."', S.explicacaoSimples({ origem: 'zabbix', chave: 'zabbix:9:resolvido' }) === 'Voltou ao normal.');
  checa('resumo não ganha linha (já abre simples)', S.explicacaoSimples({ origem: 'sistema', chave: 'resumo:2026-10-02:1400' }) === null);
  textos.length = 0;
  await alertas.emitir({ origem: 'zabbix', severidade: 'critico', titulo: 'CTO offline', texto: '🚨 *CTO offline*', chave: 'zabbix:777', dados: { tipo: 'cto_off', impacto: { clientes: 8 } } });
  checa('o alerta enviado leva a linha simples', /💬 Uma caixinha no poste parou\. As 8 casas/.test(textos[0] ?? ''), textos[0]);
  cfg.definir('alertas.explicar_simples', false, 'teste');
  textos.length = 0;
  await alertas.emitir({ origem: 'zabbix', severidade: 'critico', titulo: 'CTO offline', texto: '🚨 *CTO offline*', chave: 'zabbix:778', dados: { tipo: 'cto_off' } });
  checa('desligado no painel: sem a linha', !/💬/.test(textos[0] ?? ''), textos[0]);

  fecharDb();
  console.log(`\n${passou} ok, ${falhou} falha(s)`);
  process.exit(falhou ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
