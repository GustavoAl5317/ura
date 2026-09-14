// Execução periódica dos monitores, com estado visível no painel.
//
// Cada ciclo relê a configuração: ligar/desligar e mudar o intervalo pelo painel
// vale no ciclo seguinte, sem restart. Um ciclo nunca sobrepõe o anterior — se o
// Zabbix demorar mais que o intervalo, o próximo espera, em vez de empilhar
// consultas até derrubar o próprio Zabbix.

import { logger } from '../../logger';
import { publicar } from '../eventos';

export interface EstadoMonitor {
  nome: string;
  descricao: string;
  ativo: boolean;
  rodando: boolean;
  ultimaExecucao: string | null;
  ultimaDuracaoMs: number | null;
  ultimoErro: string | null;
  ultimoErroEm: string | null;
  execucoes: number;
  falhas: number;
  alertasEmitidos: number;
  detalhe: Record<string, unknown>;
}

const estados = new Map<string, EstadoMonitor>();

export function estadoMonitores(): EstadoMonitor[] {
  return [...estados.values()];
}

export function iniciarMonitor(p: {
  nome: string;
  descricao: string;
  ativo: () => boolean;
  intervaloSeg: () => number;
  /** Devolve quantos alertas emitiu e detalhes para o painel. */
  ciclo: () => Promise<{ alertas: number; detalhe?: Record<string, unknown> }>;
}): () => void {
  const estado: EstadoMonitor = {
    nome: p.nome, descricao: p.descricao, ativo: false, rodando: false,
    ultimaExecucao: null, ultimaDuracaoMs: null, ultimoErro: null, ultimoErroEm: null,
    execucoes: 0, falhas: 0, alertasEmitidos: 0, detalhe: {},
  };
  estados.set(p.nome, estado);

  let timer: NodeJS.Timeout | null = null;
  let parado = false;

  const agendar = (seg: number) => {
    if (parado) return;
    timer = setTimeout(executar, Math.max(5, seg) * 1000);
    timer.unref?.();
  };

  const executar = async () => {
    // ativo() e intervaloSeg() leem configuração do banco. Se lançarem fora do
    // try, a promise rejeita, ninguém reagenda e o monitor morre em silêncio —
    // parece ligado no painel e nunca mais roda.
    try {
      estado.ativo = p.ativo();
    } catch (err) {
      estado.ultimoErro = `não consegui ler se o monitor está ligado: ${err instanceof Error ? err.message : String(err)}`;
      estado.ultimoErroEm = new Date().toISOString();
      return agendar(60);
    }
    if (!estado.ativo) {
      // Desligado: continua acordando para perceber quando for religado.
      return agendar(60);
    }

    estado.rodando = true;
    const t0 = Date.now();
    try {
      const r = await p.ciclo();
      estado.alertasEmitidos += r.alertas;
      estado.detalhe = r.detalhe ?? {};
      estado.ultimoErro = null;
    } catch (err) {
      estado.falhas++;
      estado.ultimoErro = err instanceof Error ? err.message : String(err);
      estado.ultimoErroEm = new Date().toISOString();
      logger.warn(`Monitor ${p.nome}: ciclo falhou`, { err: estado.ultimoErro });
    } finally {
      estado.rodando = false;
      estado.execucoes++;
      estado.ultimaExecucao = new Date().toISOString();
      estado.ultimaDuracaoMs = Date.now() - t0;
      publicar('monitor', { ...estado });
      let proximo = 60;
      try { proximo = p.intervaloSeg(); } catch { /* mantém 60 s */ }
      agendar(proximo);
    }
  };

  // Primeiro ciclo depois de 10 s: dá tempo do resto do processo subir.
  timer = setTimeout(executar, 10_000);
  timer.unref?.();
  logger.info(`Monitor ${p.nome}: agendado`);

  return () => {
    parado = true;
    if (timer) clearTimeout(timer);
  };
}
