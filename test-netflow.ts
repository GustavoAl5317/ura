// Testes da integração com o NetFlow (Flow Guard API).
//
// Sobe uma Flow Guard API FALSA em porta local, com respostas no formato visto
// na flow-vm em 16/09/2026. Nada sai da máquina.
//
//   npm run test:netflow

import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import type { AddressInfo } from 'net';

for (const k of ['OPENAI_API_KEY', 'SGP_BASE_URL', 'SGP_TOKEN']) {
  process.env[k] ||= 'teste-netflow-sem-uso';
}
const CHAVE = 'chave-de-teste-netflow';
process.env.NETFLOW_ENABLED = '1';
process.env.NETFLOW_API_KEY = CHAVE;
process.env.NETFLOW_FATOR_AMOSTRAGEM = '1024';

const RAIZ = __dirname;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aq-netflow-'));
process.chdir(dir);

let passou = 0;
let falhou = 0;
function checa(rotulo: string, ok: boolean, detalhe: unknown = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${rotulo}${ok || detalhe === '' ? '' : `\n      ${typeof detalhe === 'string' ? detalhe : JSON.stringify(detalhe).slice(0, 600)}`}`);
  ok ? passou++ : falhou++;
}

// ── Flow Guard falsa ─────────────────────────────────────────────────────────
const estado = {
  coletaViva: true,
  chaveAceita: true,
  chamadasResumo: 0,
  cabecalhos: [] as string[],
  ipSerieFormato: 'total_bytes' as 'total_bytes' | 'bytes' | 'sem_tempo',
};

const AGORA = Math.floor(Date.now() / 1000);

function responder(url: URL): unknown {
  const ini = Number(url.searchParams.get('epoch_begin'));
  const fim = Number(url.searchParams.get('epoch_end'));
  switch (url.pathname) {
    case '/api/netflow/summary': {
      estado.chamadasResumo++;
      // Janela curta que termina agora = checagem de frescor.
      const ehFrescor = fim - ini <= 15 * 60 && fim >= AGORA - 5;
      if (ehFrescor && !estado.coletaViva) return { total_flows: 0, total_bytes: 0, total_packets: 0, peak_mbps: 0, avg_mbps: 0, current_mbps: 0 };
      return { total_flows: 42700, total_bytes: 136398827, total_packets: 129800, peak_mbps: 0.677, avg_mbps: 0.587, current_mbps: 0.093 };
    }
    case '/api/netflow/timeseries': {
      const b = Number(url.searchParams.get('bucket_seconds'));
      return { records: [
        { bucket: ini, total_bytes: 5442861, in_bytes: 0, out_bytes: 0, total_packets: 5179, flows: 1600, critical: 0, warning: 0 },
        { bucket: ini + b, total_bytes: 10885722, in_bytes: 0, out_bytes: 0, total_packets: 9000, flows: 2000, critical: 1, warning: 0 },
      ] };
    }
    case '/api/netflow/bandwidth-by-client':
      return { records: [
        { ip: '100.64.10.20', total_bytes: 11006383, total_packets: 8749, flows: 1433, critical: 0, warning: 0 },
        { ip: '100.64.10.99', total_bytes: 5000000, total_packets: 4000, flows: 700, critical: 0, warning: 2 },
        { ip: '100.64.10.50', total_bytes: 1000000, total_packets: 900, flows: 100, critical: 0, warning: 0 },
      ] };
    case '/api/netflow/ip-timeseries': {
      const ip = url.searchParams.get('ip');
      if (ip === '100.64.99.99') return { records: [] };
      if (estado.ipSerieFormato === 'bytes') return { records: [{ ts: ini, bytes: 2048 }] };
      if (estado.ipSerieFormato === 'sem_tempo') return { records: [{ bytes: 2048 }] };
      return { records: [{ bucket: ini, total_bytes: 1048576, in_bytes: 0, out_bytes: 0 }] };
    }
    case '/api/netflow/top-asn':
      return { records: [
        { asn: 32934, total_bytes: 34168560, total_packets: 27744, flows: 6486 },
        { asn: 65001, total_bytes: 1000, total_packets: 2, flows: 1 },
      ] };
    case '/api/netflow/incidents':
      return { records: [{ id: 1, tstamp: AGORA - 60, severity: 'critical', score: 95, proto: 'UDP', ip: '100.64.10.20', cli_ip: '8.8.8.8', src_port: 53, dst_port: 50223, bytes: 398, packets: 1, duration: 0 }] };
    case '/api/correlation/attacks':
      return { attacks: [{
        victim_ip: '100.64.10.20', total_bytes: 2001070, total_packets: 1521,
        first_seen: AGORA - 1800, last_seen: AGORA - 10, unique_sources: 96, protocol_count: 3,
        event_count: 274, duration_s: 1790, max_severity: 'critical',
        protocols: [{ proto: 'UDP', cnt: 213, bytes: 1262345 }],
        top_sources: [{ ip: '203.0.113.9', cnt: 11, bytes: 660030 }],
        top_asns: [{ asn: 36040, cnt: 95, bytes: 849799 }],
      }] };
    default:
      return null;
  }
}

const servidor = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  estado.cabecalhos.push(String(req.headers.authorization ?? ''));
  if (!estado.chaveAceita || req.headers.authorization !== `Bearer ${CHAVE}`) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ detail: 'Not authenticated' }));
    return;
  }
  const corpo = responder(url);
  res.writeHead(corpo === null ? 404 : 200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(corpo ?? { detail: 'Not Found' }));
});

async function main() {
  await new Promise<void>((r) => servidor.listen(0, '127.0.0.1', r));
  process.env.NETFLOW_URL = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;

  /* eslint-disable @typescript-eslint/no-var-requires */
  const { db, fecharDb } = require(path.join(RAIZ, 'src', 'assistant', 'store', 'db')) as typeof import('./src/assistant/store/db');
  const { netflow, formatarMbps } = require(path.join(RAIZ, 'src', 'integrations', 'netflow')) as typeof import('./src/integrations/netflow');
  const { ferramentas } = require(path.join(RAIZ, 'src', 'assistant', 'tools', 'base')) as typeof import('./src/assistant/tools/base');
  const { registrarFerramentasNetflow } = require(path.join(RAIZ, 'src', 'assistant', 'tools', 'netflow')) as typeof import('./src/assistant/tools/netflow');
  const { sustenta } = require(path.join(RAIZ, 'src', 'assistant', 'types')) as typeof import('./src/assistant/types');
  /* eslint-enable @typescript-eslint/no-var-requires */

  // Espelho do SGP com três conexões; uma com IP repetido (ambíguo).
  const agoraIso = new Date().toISOString();
  const d = db();
  d.prepare(`INSERT INTO sgp_cliente (cliente_id, nome, atualizado_em) VALUES (1,'MARIA DA SILVA',?), (2,'JOAO SOUZA',?), (3,'ANA LIMA',?)`).run(agoraIso, agoraIso, agoraIso);
  d.prepare(`INSERT INTO sgp_contrato (contrato_id, cliente_id, atualizado_em) VALUES (101,1,?), (102,2,?), (103,3,?), (104,3,?)`).run(agoraIso, agoraIso, agoraIso, agoraIso);
  const sv = d.prepare(`INSERT INTO sgp_servico (servico_id, contrato_id, login, plano_desc, conexao_status, conexao_ip, conexao_desde, atualizado_em) VALUES (?,?,?,?,?,?,?,?)`);
  sv.run(1, 101, 'maria', '500 MEGA', 'online', '100.64.10.20', '2026-09-16 08:00:00', agoraIso);
  sv.run(2, 102, 'joao', '300 MEGA', 'online', '100.64.10.50', null, agoraIso);
  sv.run(3, 103, 'ana1', '300 MEGA', 'online', '100.64.10.50', null, agoraIso);   // mesmo IP do joão → ambíguo
  sv.run(4, 104, 'ana2', '300 MEGA', null, null, null, agoraIso);                    // offline no sync

  registrarFerramentasNetflow();
  let n = 0;
  const ctx = { proximoId: () => `evd_${++n}`, usuario: 'teste', fontesPermitidas: null };
  const rodar = async (nome: string, args: Record<string, unknown>) => {
    netflow.limparCache();
    const f = ferramentas.get(nome);
    if (!f) throw new Error(`ferramenta ${nome} não registrada`);
    return (await f.executar(args, ctx))[0];
  };
  const dados = (e: { dados?: unknown }) => e.dados as Record<string, any>;

  console.log('\n─── Registro ───');
  checa('cinco ferramentas de NetFlow registradas', ferramentas.disponiveis(['netflow']).length === 5,
    ferramentas.disponiveis(['netflow']).map((f) => f.nome));

  console.log('\n─── Tráfego geral e amostragem ───');
  let e = await rodar('netflow_trafego', { minutos: 30 });
  checa('responde com dado', sustenta(e), e);
  // 136.398.827 bytes × 1024 em 1800 s ≈ 620,8 Mbps
  checa('média multiplicada pelo fator 1024 (~621 Mbps, não 0,6)', dados(e).media === '621 Mbps', dados(e).media);
  checa('diz o fator e que é estimativa', dados(e).amostragem.fator === 1024 && /estimados/.test(dados(e).amostragem.observacao));
  checa('fluxos amostrados NÃO são multiplicados', dados(e).fluxos_amostrados === 42700);
  checa('pico vem da série, com horário', !!dados(e).pico_no_intervalo?.em && /Mbps|Gbps/.test(dados(e).pico_no_intervalo.mbps), dados(e).pico_no_intervalo);
  checa('envia a chave como Bearer', estado.cabecalhos.every((h) => h === `Bearer ${CHAVE}`));

  console.log('\n─── Coleta parada (o que aconteceu de 28/07 a 16/09) ───');
  estado.coletaViva = false;
  e = await rodar('netflow_trafego', { minutos: 30 });
  checa('janela até agora com coleta parada → fonte falha, não "sem tráfego"', !e.ok && /coleta do NetFlow parada/.test(e.erro ?? ''), e);
  e = await rodar('netflow_consumo_clientes', {});
  checa('vale para todas as ferramentas (consumo)', !e.ok && /parada/.test(e.erro ?? ''));
  const ontem = new Date(Date.now() - 2 * 86_400_000);
  e = await rodar('netflow_trafego', { inicio: new Date(ontem.getTime() - 3_600_000).toISOString(), fim: ontem.toISOString() });
  checa('janela só no passado não exige coleta viva', e.ok && dados(e).coleta === 'janela no passado', e);
  estado.coletaViva = true;

  console.log('\n─── Consumo por cliente ───');
  e = await rodar('netflow_consumo_clientes', { minutos: 30, limite: 3 });
  const c = dados(e).consumidores as Array<Record<string, any>>;
  checa('IP do cadastro vira cliente', c[0].cliente?.nome === 'MARIA DA SILVA' && c[0].cliente.contrato === 101, c[0]);
  checa('IP sem cadastro fica sem cliente', c[1].cliente === null);
  checa('IP em dois serviços (ambíguo) fica sem cliente', c[2].cliente === null, c[2]);
  checa('marca faixa de CGNAT', c[0].tipo_ip === 'cgnat');
  checa('participação calculada sobre o total estimado', typeof c[0].participacao_pct === 'number' && c[0].participacao_pct > 0);
  checa('alerta do Flow Guard aparece quando existe', c[1].alertas_flow_guard?.avisos === 2 && !('alertas_flow_guard' in c[0]));
  checa('avisa que a associação é foto do sync', /último sync/.test(dados(e).associacao_cliente));

  console.log('\n─── Tráfego de um IP ───');
  e = await rodar('netflow_trafego_ip', { ip: '100.64.10.20', minutos: 60 });
  const ip0 = dados(e).ips[0];
  checa('volume do IP estimado (1 MB × 1024 = 1 GB)', ip0.volume === '1,0 GB', ip0.volume);
  checa('mostra o cliente do cadastro', ip0.cliente_no_cadastro?.nome === 'MARIA DA SILVA');
  e = await rodar('netflow_trafego_ip', { contrato_id: 101 });
  checa('por contrato usa o IP do sync e diz a origem', dados(e).ips[0].ip === '100.64.10.20' && /espelho do SGP/.test(dados(e).ips[0].ip_veio_de), dados(e).ips[0]);
  e = await rodar('netflow_trafego_ip', { contrato_id: 104 });
  checa('contrato sem IP no sync → pede revisao_cliente', !e.ok && /revisao_cliente/.test(e.erro ?? ''), e.erro);
  e = await rodar('netflow_trafego_ip', { ip: '100.64.99.99' });
  checa('IP sem fluxo com coleta viva é informação, não vazio', e.ok && !e.vazio && dados(e).ips[0].sem_trafego_na_janela === true && /amostragem/.test(dados(e).observacao), dados(e));
  estado.ipSerieFormato = 'bytes';
  e = await rodar('netflow_trafego_ip', { ip: '100.64.10.20' });
  checa('aceita "ts"/"bytes" no lugar de "bucket"/"total_bytes"', e.ok && dados(e).ips[0].volume === '2,0 MB', dados(e).ips?.[0]?.volume);
  estado.ipSerieFormato = 'sem_tempo';
  e = await rodar('netflow_trafego_ip', { ip: '100.64.10.20' });
  checa('formato sem campo de tempo → falha, não zero', !e.ok && /formato inesperado/.test(e.erro ?? ''), e.erro);
  estado.ipSerieFormato = 'total_bytes';
  e = await rodar('netflow_trafego_ip', {});
  checa('sem ip nem contrato → erro claro', !e.ok && /informe ip ou contrato_id/.test(e.erro ?? ''));

  console.log('\n─── Ataques ───');
  e = await rodar('netflow_ataques', {});
  const s0 = dados(e).suspeitas[0];
  checa('marca como suspeita, não confirmação', /suspeita/.test(dados(e).natureza));
  checa('alvo associado ao cliente', s0.cliente?.nome === 'MARIA DA SILVA');
  checa('origens, duração e protocolos', s0.origens_distintas === 96 && s0.duracao_min === 30 && s0.protocolos[0] === 'UDP (213)', s0);
  checa('ASN de origem com nome quando conhecido', s0.asns_de_origem[0].nome === 'YouTube (Google)');
  checa('incidente crítico junto', dados(e).incidentes_criticos.length === 1);

  console.log('\n─── ASN ───');
  e = await rodar('netflow_top_asn', {});
  checa('ASN conhecido com nome, desconhecido sem inventar', dados(e).asns[0].nome === 'Meta (Facebook/Instagram/WhatsApp)' && dados(e).asns[1].nome === null, dados(e).asns);

  console.log('\n─── Frescor em cache ───');
  netflow.limparCache();
  const antes = estado.chamadasResumo;
  await netflow.frescor(); await netflow.frescor(); await netflow.frescor();
  checa('três checagens seguidas = uma consulta', estado.chamadasResumo - antes === 1, estado.chamadasResumo - antes);
  checa('formatação de Gbps', formatarMbps(1543.2) === '1,54 Gbps');

  console.log('\n─── Falhas da API ───');
  estado.chaveAceita = false;
  e = await rodar('netflow_trafego', {});
  checa('chave recusada → mensagem clara', !e.ok && /recusou a chave \(HTTP 401\)/.test(e.erro ?? ''), e.erro);
  estado.chaveAceita = true;
  servidor.closeAllConnections();
  await new Promise<void>((r) => servidor.close(() => r()));
  e = await rodar('netflow_trafego', {});
  checa('API fora do ar → fonte falha', !e.ok && /NetFlow/.test(e.erro ?? ''), e.erro);

  fecharDb();
  console.log(`\n${passou} passaram, ${falhou} falharam\n`);
  process.exit(falhou ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
