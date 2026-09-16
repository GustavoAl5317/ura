// Testes do resumo diário (Bloco 9).
//
// O que importa garantir: número certo na janela certa, e fonte fora do ar
// dizendo que está fora — nunca virando "0". Roda num banco temporário e com o
// SGP substituído por um dublê; não fala com nenhum serviço de verdade.
//
//   npm run test:resumo

import fs from 'fs';
import os from 'os';
import path from 'path';

for (const k of ['OPENAI_API_KEY', 'SGP_BASE_URL', 'SGP_TOKEN']) {
  process.env[k] ||= 'teste-resumo-sem-uso';
}

const RAIZ = __dirname;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aq-resumo-'));
process.chdir(dir);

/* eslint-disable @typescript-eslint/no-var-requires */
const { config } = require(path.join(RAIZ, 'src', 'config')) as typeof import('./src/config');
const { db, fecharDb } = require(path.join(RAIZ, 'src', 'assistant', 'store', 'db')) as typeof import('./src/assistant/store/db');
const { definir } = require(path.join(RAIZ, 'src', 'assistant', 'config-dinamica')) as typeof import('./src/assistant/config-dinamica');
const { sgp } = require(path.join(RAIZ, 'src', 'integrations', 'sgp')) as typeof import('./src/integrations/sgp');
const R = require(path.join(RAIZ, 'src', 'assistant', 'resumo-diario')) as typeof import('./src/assistant/resumo-diario');
/* eslint-enable @typescript-eslint/no-var-requires */

let passou = 0;
let falhou = 0;
function checa(rotulo: string, ok: boolean, detalhe: unknown = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${rotulo}${ok || detalhe === '' ? '' : `\n      ${typeof detalhe === 'string' ? detalhe : JSON.stringify(detalhe)}`}`);
  ok ? passou++ : falhou++;
}

// 07:00 em Fortaleza (UTC-3). A janela é 13/09 07:00 → 14/09 07:00.
const FIM = new Date('2026-09-14T10:00:00Z');
const INI = new Date(FIM.getTime() - 24 * 3600_000);
const h = (horasAntesDoFim: number) => new Date(FIM.getTime() - horasAntesDoFim * 3600_000).toISOString();

(config as { tz: string }).tz = 'America/Fortaleza';
(config.zabbix as { enabled: boolean }).enabled = true;

function alerta(p: { chave: string; origem: string; criado: string; resolvido?: string | null; dados?: unknown; titulo?: string }) {
  db().prepare(
    `INSERT INTO alerta (id, origem, severidade, titulo, texto, dados, chave, criado_em, resolvido_em)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(p.chave, p.origem, 'aviso', p.titulo ?? p.chave, 't', p.dados ? JSON.stringify(p.dados) : null, p.chave, p.criado, p.resolvido ?? null);
}

async function main() {
  // ── Datas do SGP ───────────────────────────────────────────────────────────
  console.log('\n─── Data de cadastro das O.S. ───');
  const a = R.cadastroDaOs({ data_cadastro: '2026-09-14', hora_cadastro: '06:30:00' });
  checa('AAAA-MM-DD + hora_cadastro vira instante no fuso da operação', a.instante?.toISOString() === '2026-09-14T09:30:00.000Z', a);
  const b = R.cadastroDaOs({ data_cadastro: '14/09/2026 06:30' });
  checa('DD/MM/AAAA com hora no mesmo campo', b.instante?.toISOString() === '2026-09-14T09:30:00.000Z', b);
  const c = R.cadastroDaOs({ data_cadastro: '2026-09-14' });
  checa('sem hora: devolve só o dia', c.instante === null && c.dia === '2026-09-14', c);
  const d = R.cadastroDaOs({ data_cadastro: 'ontem' });
  checa('formato desconhecido: nada', d.instante === null && d.dia === null);

  // ── Duração legível ──
  console.log('\n─── Duração ───');
  const { duracaoHumana } = require(path.join(RAIZ, 'src', 'assistant', 'alertas')) as typeof import('./src/assistant/alertas');
  checa('25 h continua em horas', duracaoHumana(25 * 3600) === '25h00', duracaoHumana(25 * 3600));
  checa('meses viram dias, não "9373h44"', duracaoHumana(9373 * 3600 + 44 * 60) === '390 dias e 13h', duracaoHumana(9373 * 3600 + 44 * 60));
  checa('dias exatos sem "e 0h"', duracaoHumana(72 * 3600) === '3 dias', duracaoHumana(72 * 3600));

  // ── Hora de enviar ─────────────────────────────────────────────────────────
  console.log('\n─── Quando enviar ───');
  checa('06:59 ainda não', !R.situacaoDoDia(new Date('2026-09-14T09:59:00Z'), '07:00').enviar);
  checa('07:00 envia', R.situacaoDoDia(new Date('2026-09-14T10:00:00Z'), '07:00').enviar);
  const atrasado = R.situacaoDoDia(new Date('2026-09-14T11:30:00Z'), '07:00');
  checa('08:30 (não rodou às 07:00) ainda envia', atrasado.enviar && /atrasado 90 min/.test(atrasado.motivo), atrasado);
  checa('10:01 passou do atraso máximo: não envia', !R.situacaoDoDia(new Date('2026-09-14T13:01:00Z'), '07:00').enviar);
  checa('chave usa o dia LOCAL (23h de Fortaleza já é amanhã em UTC)',
    R.situacaoDoDia(new Date('2026-09-15T02:00:00Z'), '07:00').chave === 'resumo:2026-09-14');

  // ── Rede ───────────────────────────────────────────────────────────────────
  console.log('\n─── Rede (Zabbix) ───');
  definir('monitor.zabbix.ativo', false, 'teste');
  let rede = R.coletarRede(INI, FIM);
  checa('monitor desligado: indisponível, não "0 incidentes"', !rede.disponivel && /desligado/.test(rede.motivo));

  definir('monitor.zabbix.ativo', true, 'teste');
  // A: começou e resolveu na janela (2 h)
  alerta({ chave: 'zabbix:A', origem: 'zabbix', criado: h(5), resolvido: h(3), dados: { nome: 'CTO 12 offline', tipo: 'cto_off', inicio: h(5) } });
  // B: começou antes da janela e segue aberto (30 h)
  alerta({ chave: 'zabbix:B', origem: 'zabbix', criado: h(30), dados: { nome: 'Link Fortaleza', tipo: 'link', inicio: h(30) } });
  // C: começou antes, resolveu dentro (25 h)
  alerta({ chave: 'zabbix:C', origem: 'zabbix', criado: h(26), resolvido: h(1), dados: { nome: 'POP Centro fora', tipo: 'pop_off', inicio: h(26) } });
  // Aviso de resolução do A: não é incidente
  alerta({ chave: 'zabbix:A:resolvido', origem: 'zabbix', criado: h(3), resolvido: h(3), dados: { eventid: 'A' } });
  // E: todo fora da janela
  alerta({ chave: 'zabbix:E', origem: 'zabbix', criado: h(40), resolvido: h(30), dados: { nome: 'antigo', tipo: 'fibra', inicio: h(40) } });
  // Semeado no boot, mas o problema começou dentro da janela: conta como novo
  alerta({ chave: 'zabbix:F', origem: 'zabbix', criado: h(2), dados: { nome: 'Energia POP Sul', tipo: 'energia', inicio: h(10) } });

  rede = R.coletarRede(INI, FIM);
  if (rede.disponivel) {
    checa('novos = começaram na janela (A e F)', rede.novos === 2, rede);
    checa('resolvidos na janela = A e C', rede.resolvidos === 2, rede);
    checa('abertos agora = B e F', rede.abertosAgora === 2, rede);
    checa('aviso de resolução não conta como incidente', !JSON.stringify(rede).includes(':resolvido'));
    checa('mais longo resolvido = C, 25 h', rede.maisLongoResolvido?.nome === 'POP Centro fora' && rede.maisLongoResolvido.duracaoSeg === 25 * 3600, rede.maisLongoResolvido);
    checa('aberto há mais tempo = B, 30 h', rede.abertoHaMaisTempo?.nome === 'Link Fortaleza' && rede.abertoHaMaisTempo.duracaoSeg === 30 * 3600, rede.abertoHaMaisTempo);
    checa('tipos com rótulo legível', rede.porTipo.some((t) => t.tipo === 'CTO offline'), rede.porTipo);
  } else checa('rede disponível', false, rede);

  // ── O.S. ───────────────────────────────────────────────────────────────────
  console.log('\n─── Ordens de serviço (SGP) ───');
  const sgpMut = sgp as unknown as Record<string, unknown>;
  let pedido: string[] = [];
  sgpMut.ordensServicoPorCadastro = async (i: string, f: string) => {
    pedido = [i, f];
    return {
      janelaCompleta: true,
      ordens: [
        { id: 1, status_id: 1, status: 'Finalizada', data_cadastro: '2026-09-13', hora_cadastro: '15:00:00', motivo: 'Sem conexão' },
        { id: 2, status_id: 0, status: 'Aberta', data_cadastro: '2026-09-14', hora_cadastro: '06:00:00', motivo: 'Sem conexão' },
        { id: 3, status_id: 0, status: 'Aberta', data_cadastro: '2026-09-13', hora_cadastro: '05:00:00', motivo: 'Mudança' },   // antes da janela
        { id: 4, status_id: 0, status: 'Aberta', data_cadastro: '2026-09-14', motivo: 'Mudança' },                             // sem hora
        { id: 5, status_id: 0, status: 'Aberta', data_cadastro: '2026-09-14', hora_cadastro: '08:00:00', motivo: 'x' },         // depois do fim
      ],
    };
  };
  sgpMut.ordensServicoAbertas = async () => ({ abertas: new Array(42).fill({}), examinadas: 3000, janelaCompleta: false });

  let os_ = await R.coletarOs(INI, FIM);
  checa('pede ao SGP os dias locais da janela', pedido[0] === '2026-09-13' && pedido[1] === '2026-09-14', pedido);
  if (os_.disponivel) {
    checa('conta só as da janela de 24 h (1, 2 e 4)', os_.cadastradas === 3, os_);
    checa('finalizadas entre elas: 1', os_.jaFinalizadas === 1, os_);
    checa('avisa a que veio sem horário', os_.semHorario === 1, os_);
    checa('motivo mais comum primeiro', os_.principaisMotivos[0]?.motivo === 'Sem conexão' && os_.principaisMotivos[0].n === 2, os_.principaisMotivos);
    checa('em aberto com lista cortada fica marcado como incompleto', os_.emAbertoNaRede?.total === 42 && !os_.emAbertoNaRede.completa);
  } else checa('O.S. disponível', false, os_);

  sgpMut.ordensServicoPorCadastro = async () => { throw new Error('timeout of 120000ms exceeded'); };
  os_ = await R.coletarOs(INI, FIM);
  checa('SGP fora: indisponível com o motivo', !os_.disponivel && /SGP não respondeu.*timeout/.test(os_.motivo), os_);

  // ── URA ────────────────────────────────────────────────────────────────────
  console.log('\n─── URA ───');
  let ura = R.coletarUra(INI, FIM);
  checa('nunca recebeu chamada: aponta a ponte, não diz "0 chamadas"', !ura.disponivel && /ponte da URA/.test(ura.motivo), ura);

  const ch = db().prepare(
    `INSERT INTO chamada_ura (call_id, cliente_nome, intencao, status, iniciada_em, duracao_seg, atualizada_em) VALUES (?,?,?,?,?,?,?)`,
  );
  ch.run('c0', 'Antiga', 'Financeiro', 'encerrada', h(48), 60, h(48));
  ura = R.coletarUra(INI, FIM);
  checa('já recebeu antes, nada na janela: 0 com a data da última', ura.disponivel && ura.chamadas === 0 && ura.ultimaChamadaEm === h(48), ura);

  ch.run('c1', 'Maria', 'Suporte técnico', 'transferida', h(2), 120, h(2));
  ch.run('c2', null, null, 'encerrada', h(3), 60, h(3));
  ch.run('c3', 'João', 'Suporte técnico', 'em_andamento', h(1), null, h(1));
  ura = R.coletarUra(INI, FIM);
  if (ura.disponivel) {
    checa('3 chamadas, 1 transferida, 1 sem fim, 1 não identificada',
      ura.chamadas === 3 && ura.transferidas === 1 && ura.emAndamento === 1 && ura.naoIdentificados === 1, ura);
    checa('média só das que têm duração (120 e 60 → 90 s)', ura.duracaoMediaSeg === 90, ura.duracaoMediaSeg);
  } else checa('URA disponível', false, ura);

  // ── Atendimento ────────────────────────────────────────────────────────────
  console.log('\n─── Atendimento WhatsApp ───');
  let at = R.coletarAtendimento(INI, FIM);
  checa('monitor de SLA desligado (padrão): indisponível', !at.disponivel && /desligado/.test(at.motivo));

  definir('monitor.sla.ativo', true, 'teste');
  alerta({ chave: 'sla:j1:m1', origem: 'sla', criado: h(4), dados: { jid: 'j1', esperaMin: 15 } });
  alerta({ chave: 'sla:j1:m2', origem: 'sla', criado: h(2), dados: { jid: 'j1', esperaMin: 16 } });
  alerta({ chave: 'sla:j2:m1', origem: 'sla', criado: h(2), dados: { jid: 'j2', esperaMin: 20 } });
  alerta({ chave: 'sla:resumo:2026-09-14T08:00', origem: 'sla', criado: h(2) });
  db().prepare(`INSERT INTO sla_conversa (jid, aguardando_desde, atualizada_em) VALUES ('j3', ?, ?)`).run(h(0.5), h(0));
  at = R.coletarAtendimento(INI, FIM);
  if (at.disponivel) {
    checa('conversas distintas acima do limite: 2', at.conversasAcimaDoLimite === 2, at);
    checa('aviso de fila cheia separado', at.avisosDeFila === 1, at);
    checa('aguardando agora: 1, há 30 min', at.aguardandoAgora === 1 && at.esperaMaisLongaAgoraMin === 30, at);
  } else checa('atendimento disponível', false, at);

  // ── Assistente ─────────────────────────────────────────────────────────────
  console.log('\n─── Assistente ───');
  const cq = db().prepare(`INSERT INTO consulta (id, usuario, canal, pergunta, resposta, veredito, at) VALUES (?,?,?,?,?,?,?)`);
  cq.run('q1', 'ana', 'chat', 'p', 'r', 'CONFIRMADO', h(1));
  cq.run('q2', 'ana', 'whatsapp', 'p', 'r', 'PROVAVEL', h(2));
  cq.run('q3', 'bia', 'chat', 'p', 'r', 'CONFIRMADO', h(3));
  cq.run('q4', 'bia', 'chat', 'p', 'r', 'INCONCLUSIVO', h(30));   // fora
  const as = R.coletarAssistente(INI, FIM);
  checa('3 consultas de 2 pessoas na janela', as.consultas === 3 && as.pessoas === 2, as);

  // ── Texto completo ─────────────────────────────────────────────────────────
  console.log('\n─── Texto ───');
  sgpMut.ordensServicoPorCadastro = async () => { throw new Error('SGP fora'); };
  const r = await R.montarResumo(FIM, ['rede', 'os', 'ura', 'atendimento', 'assistente']);
  checa('cabeçalho com a janela em horário local', r.texto.includes('13/09 07:00 → 14/09 07:00'), r.texto.split('\n')[1]);
  checa('sem "undefined", "null" ou "NaN" no texto', !/undefined|null|NaN/.test(r.texto));
  checa('O.S. com SGP fora não mostra número', /Ordens de serviço \(SGP\)\*\n• _SGP não respondeu/.test(r.texto));
  checa('seções fora da lista não aparecem', !(await R.montarResumo(FIM, ['assistente'])).texto.includes('Rede'));
  console.log('\n' + r.texto.split('\n').map((l) => `      │ ${l}`).join('\n'));

  // ── Tráfego (NetFlow) ──────────────────────────────────────────────────────
  console.log('\n─── Tráfego (NetFlow) ───');
  /* eslint-disable @typescript-eslint/no-var-requires */
  const { netflow } = require(path.join(RAIZ, 'src', 'integrations', 'netflow')) as { netflow: Record<string, unknown> };
  const rel = require(path.join(RAIZ, 'src', 'assistant', 'tools', 'relatorios')) as Record<string, unknown>;
  /* eslint-enable @typescript-eslint/no-var-requires */
  let tr = await R.coletarTrafego(INI, FIM);
  checa('NetFlow não configurado: seção indisponível', !tr.disponivel && /não configurado/.test(tr.motivo), tr);

  Object.defineProperty(netflow, 'disponivel', { get: () => true, configurable: true });
  Object.defineProperty(netflow, 'fator', { get: () => 1024, configurable: true });
  let fluxos = 5000;
  netflow.resumo = async () => ({ total_flows: fluxos, total_bytes: 21_000_000_000 / 1024, total_packets: 1, peak_mbps: 0, avg_mbps: 0, current_mbps: 0 });
  netflow.serie = async (j: { inicio: number }) => [
    { bucket: j.inicio, total_bytes: 1_000_000 },
    { bucket: Math.floor(new Date('2026-09-13T23:15:00Z').getTime() / 1000), total_bytes: 90_000_000 },
  ];
  netflow.topAsn = async () => [
    { asn: 36040, total_bytes: 21_000_000_000 / 1024 / 4, total_packets: 1, flows: 1 },
    { asn: 64512, total_bytes: 21_000_000_000 / 1024 / 10, total_packets: 1, flows: 1 },
  ];
  netflow.ataques = async () => [{ max_severity: 'critical' }, { max_severity: 'warning' }];
  netflow.frescor = async () => ({ viva: false, fluxosRecentes: 0, janelaMin: 10, verificadoEm: '' });
  tr = await R.coletarTrafego(INI, FIM);
  if (tr.disponivel) {
    checa('média das 24 h com o fator 1024 (~1,94 Mbps)', Math.round(tr.mediaMbps * 100) / 100 === 1.94, tr.mediaMbps);
    checa('pico em hora local (20:15 de Fortaleza)', !!tr.pico && R.horaLocal(new Date(tr.pico.em)) === '20:15', tr.pico);
    checa('ASN com nome curto e desconhecido como AS+número', tr.principaisAsns[0].nome === 'YouTube' && tr.principaisAsns[1].nome === 'AS64512' && tr.principaisAsns[0].pct === 25, tr.principaisAsns);
    checa('conta só suspeitas críticas', tr.suspeitasCriticas === 1);
    checa('avisa coleta parada agora', tr.coletaAgora === false);
  } else checa('tráfego disponível', false, tr);
  fluxos = 0;
  tr = await R.coletarTrafego(INI, FIM);
  checa('nenhum fluxo no período: indisponível, não "0 Mbps"', !tr.disponivel && /coleta parada/.test(tr.motivo), tr);
  fluxos = 5000;

  // ── Clientes ───────────────────────────────────────────────────────────────
  console.log('\n─── Clientes ───');
  rel.lerSessoesOnline = async () => ({ online_agora: 1157, ontem_mesmo_horario: { valor: 1170 } });
  sgpMut.ordensServicoPorCadastro = async () => ({
    janelaCompleta: true,
    ordens: [
      { id: 1, contrato: 201, cliente: 'NOVO CLIENTE', status_id: 1, motivo: 'ADESÃO - instalação de KIT', data_cadastro: '2026-09-13', data_finalizacao: '2026-09-13', hora_finalizacao: '15:00:00' },
      { id: 2, contrato: 202, cliente: 'INSTALADO ANTES', status_id: 1, motivo: 'ADESÃO - instalação de KIT', data_cadastro: '2026-09-01', data_finalizacao: '2026-09-01', hora_finalizacao: '15:00:00' },
      { id: 3, contrato: 203, cliente: 'SAINDO', status_id: 0, motivo: 'ADESÃO - Retirada', data_cadastro: '2026-09-14', hora_cadastro: '06:00:00' },
      { id: 4, contrato: 204, cliente: 'REINCIDENTE', status_id: 1, motivo: 'SUPORTE - Sem Internet', data_cadastro: '2026-09-02' },
      { id: 5, contrato: 204, cliente: 'REINCIDENTE', status_id: 0, motivo: 'SUPORTE - Corretiva', data_cadastro: '2026-09-12' },
      { id: 6, contrato: 205, cliente: 'UMA VEZ', status_id: 0, motivo: 'SUPORTE - Corretiva', data_cadastro: '2026-09-12' },
    ],
  });
  const sv = db().prepare(`INSERT INTO sgp_servico (servico_id, contrato_id, rx, cto_nome, atualizado_em) VALUES (?,?,?,?,?)`);
  sv.run(901, 9, -28, 'CTO 7', h(10)); sv.run(902, 9, -31, 'CTO 7', h(10)); sv.run(903, 9, -20, 'CTO 8', h(10));
  db().prepare(`INSERT INTO sgp_contrato_evento (contrato_id, de, para, detectado_em) VALUES (206,'Ativo','Cancelado',?), (207,'Ativo','Cancelado',?)`).run(h(3), h(40));

  let cl = await R.coletarClientes(INI, FIM);
  if (cl.disponivel) {
    checa('online agora e ontem', 'agora' in cl.online && cl.online.agora === 1157 && cl.online.ontem === 1170, cl.online);
    checa('instalação concluída nas 24 h (a de 01/09 fica de fora)', cl.instalacoesConcluidas === 1, cl.instalacoesConcluidas);
    checa('retirada aberta nas 24 h', cl.retiradas === 1, cl.retiradas);
    checa('contrato que virou Cancelado nas 24 h (o de 40 h atrás não)', cl.contratosCancelados === 1, cl.contratosCancelados);
    checa('sinal ruim: 2 abaixo de -27, 1 abaixo de -30, CTO 7', cl.sinalRuim.abaixo27 === 2 && cl.sinalRuim.abaixo30 === 1 && cl.sinalRuim.ctos[0].cto === 'CTO 7', cl.sinalRuim);
    checa('reincidência: só contrato com 2+ O.S. de suporte', cl.reincidentes?.length === 1 && cl.reincidentes[0].contrato === 204 && cl.reincidentes[0].os === 2, cl.reincidentes);
  } else checa('clientes disponível', false, cl);

  rel.lerSessoesOnline = async () => { throw new Error('nenhum item de sessões PPPoE com coleta viva'); };
  sgpMut.ordensServicoPorCadastro = async () => { throw new Error('timeout'); };
  cl = await R.coletarClientes(INI, FIM);
  const txtCl = R.formatarResumo({ inicio: INI.toISOString(), fim: FIM.toISOString(), secoes: { clientes: cl } });
  checa('sem Zabbix e sem SGP: diz o que faltou, sem inventar número',
    /Online agora: sem dado/.test(txtCl) && /Instalações e retiradas: SGP não respondeu/.test(txtCl) && !/undefined|null|NaN/.test(txtCl), txtCl);

  rel.lerSessoesOnline = async () => ({ online_agora: 1157, ontem_mesmo_horario: { valor: 1170 } });
  const texto2 = R.formatarResumo({ inicio: INI.toISOString(), fim: FIM.toISOString(), secoes: { trafego: await R.coletarTrafego(INI, FIM), clientes: await R.coletarClientes(INI, FIM) } });
  checa('texto das seções novas sem "undefined/null/NaN"', /Tráfego \(NetFlow, estimado\)/.test(texto2) && /Online agora: 1\.157/.test(texto2) && !/undefined|null|NaN/.test(texto2), texto2);
  console.log('\n' + texto2.split('\n').map((l) => `      │ ${l}`).join('\n'));

  // ── Envio ──────────────────────────────────────────────────────────────────
  console.log('\n─── Envio ───');
  const e1 = await R.enviarResumo({ chave: 'resumo:2026-09-14', fim: FIM });
  checa('sem grupo configurado: registra com o motivo', !!e1 && !e1.enviado_em && /sem grupo/.test(e1.envio_erro ?? ''), e1?.envio_erro);
  checa('nasce resolvido (é acontecimento, não pendência)', !!e1?.resolvido_em);
  const e2 = await R.enviarResumo({ chave: 'resumo:2026-09-14', fim: FIM });
  checa('mesmo dia de novo não duplica', e2 === null);
  checa('depois de registrado, o dia não pede novo envio', !R.situacaoDoDia(new Date('2026-09-14T10:05:00Z'), '07:00').enviar);

  fecharDb();
  console.log(`\n${passou} passaram, ${falhou} falharam\n`);
  process.exit(falhou ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
