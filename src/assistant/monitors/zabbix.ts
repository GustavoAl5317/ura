// Monitor proativo de incidentes no Zabbix (Bloco 4).
//
// A cada ciclo lê os problemas abertos, alerta os novos que passam no filtro
// (tipo e severidade configuráveis) e alerta a resolução dos que fecharam.
//
// Primeiro boot: problemas que já estavam abertos ANTES do monitor subir são
// gravados sem envio. Sem isso, a primeira vez que o serviço sobe despeja no
// grupo todos os incidentes antigos de uma vez — e ninguém mais lê o grupo.

import { config } from '../../config';
import { zabbix, ZabbixClient, ZabbixEventoTipo } from '../../integrations/zabbix';
import { obter } from '../config-dinamica';
import { emitir, marcarResolvido, abertosDaOrigem, horaCurta, duracaoHumana, Severidade } from '../alertas';
import { listarCtos, servicosPorCto, statusIndice } from '../store/sgp-index';
import { iniciarMonitor } from './base';

const inicioProcesso = Date.now();
/** Problema aberto até este tanto antes do boot ainda alerta: pode ter caído enquanto o serviço reiniciava. */
const TOLERANCIA_BOOT_MS = 10 * 60_000;

const ROTULO_TIPO: Record<ZabbixEventoTipo, string> = {
  cto_off: 'CTO offline',
  pop_off: 'POP fora',
  fibra: 'Queda de interface / fibra',
  energia: 'Energia',
  pppoe_off: 'Queda de sessões PPPoE',
  equipamento_cliente: 'Equipamento de cliente',
  energia_cliente: 'Energia no cliente',
  link: 'Link',
  poe: 'PoE',
  outro: 'Outro',
};

const ROTULO_SEV = ['não classificado', 'informação', 'aviso', 'médio', 'alto', 'desastre'];

function severidadeAlerta(sevZabbix: number): Severidade {
  if (sevZabbix >= 4) return 'critico';
  if (sevZabbix >= 2) return 'aviso';
  return 'info';
}

/**
 * Quantos clientes a CTO do alerta atende, pelo espelho. Só é dito quando a
 * CTO do alerta casa sem ambiguidade com uma CTO cadastrada — número de
 * clientes da CTO errada num alerta é pior que nenhum número.
 */
function impactoCto(nomeAlerta: string): { cto: string; clientes: number } | null {
  if (!statusIndice().disponivel) return null;
  const ctoDoAlerta = ZabbixClient.extrairCtoDoAlerta(nomeAlerta);
  if (!ctoDoAlerta) return null;

  const ranking = listarCtos()
    .map((c) => ({ ...c, s: ZabbixClient.semelhanca(ctoDoAlerta, c.cto) }))
    .filter((c) => c.s >= ZabbixClient.LIMIAR_SEMELHANCA)
    .sort((a, b) => b.s - a.s);
  if (!ranking.length) return null;
  if (ranking.length > 1 && ranking[1].s === ranking[0].s) return null;   // ambíguo
  return { cto: ranking[0].cto, clientes: servicosPorCto(ranking[0].cto).length };
}

export function iniciarMonitorZabbix(): () => void {
  let primeiroCiclo = true;

  return iniciarMonitor({
    nome: 'zabbix',
    descricao: 'Incidentes novos e resolvidos na rede',
    ativo: () => config.zabbix.enabled && obter<boolean>('monitor.zabbix.ativo'),
    intervaloSeg: () => obter<number>('monitor.zabbix.intervalo_seg'),
    async ciclo() {
      const sevMin = obter<number>('monitor.zabbix.severidade_minima');
      const tipos = new Set(obter<string[]>('monitor.zabbix.tipos'));

      const problemas = await zabbix.problemasPorPadroes(config.zabbix.searchPatterns);
      const abertosIds = new Set(problemas.map((p) => p.eventid));
      let emitidos = 0;
      let semeados = 0;
      let filtrados = 0;

      for (const p of problemas) {
        const sev = parseInt(p.severity, 10) || 0;
        const host = p.hosts?.[0]?.name ?? '';
        const tipo = ZabbixClient.classificar(p.name, host);
        if (sev < sevMin || !tipos.has(tipo)) { filtrados++; continue; }

        const inicio = parseInt(p.clock, 10) * 1000;
        const antigo = primeiroCiclo && inicio < inicioProcesso - TOLERANCIA_BOOT_MS;
        const impacto = tipo === 'cto_off' ? impactoCto(p.name) : null;

        const linhas = [
          `🚨 *${ROTULO_TIPO[tipo]}*`,
          p.name,
          host ? `Equipamento: ${host}` : null,
          `Desde: ${horaCurta(new Date(inicio))} · severidade ${ROTULO_SEV[sev] ?? sev}`,
          impacto ? `Clientes na CTO: ${impacto.clientes} (cadastro SGP)` : null,
        ].filter(Boolean);

        const a = await emitir({
          origem: 'zabbix',
          severidade: severidadeAlerta(sev),
          titulo: `${ROTULO_TIPO[tipo]}: ${p.name}`,
          texto: linhas.join('\n'),
          chave: `zabbix:${p.eventid}`,
          dados: { eventid: p.eventid, nome: p.name, host, tipo, severidade: sev, inicio: new Date(inicio).toISOString(), impacto },
          silencioso: antigo,
        });
        if (a) antigo ? semeados++ : emitidos++;
      }

      // Resolução: alerta aberto cujo evento não está mais entre os problemas.
      let resolvidos = 0;
      for (const a of abertosDaOrigem('zabbix')) {
        const d = a.dados as { eventid?: string; nome?: string; inicio?: string } | null;
        if (!d?.eventid || abertosIds.has(d.eventid)) continue;
        const r = marcarResolvido(a.chave);
        if (!r) continue;
        resolvidos++;
        // Semeado no boot não recebe aviso de resolução: ninguém recebeu o de abertura.
        if (obter<boolean>('monitor.zabbix.alertar_resolucao') && a.enviado_em) {
          const dur = d.inicio ? Math.round((Date.now() - new Date(d.inicio).getTime()) / 1000) : null;
          await emitir({
            origem: 'zabbix',
            severidade: 'info',
            titulo: `Resolvido: ${d.nome}`,
            texto: [`✅ *Resolvido*`, d.nome, dur !== null ? `Durou: ${duracaoHumana(dur)}` : null]
              .filter(Boolean).join('\n'),
            chave: `zabbix:${d.eventid}:resolvido`,
            dados: { eventid: d.eventid, duracaoSeg: dur },
            evento: true,
          });
          emitidos++;
        }
      }

      primeiroCiclo = false;
      return {
        alertas: emitidos,
        detalhe: { problemas_abertos: problemas.length, filtrados, semeados, resolvidos },
      };
    },
  });
}
