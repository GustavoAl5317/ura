// Agendador da URA de voz: liga/desliga automaticamente por janelas de horário
// (dia da semana + hora início/fim). Suporta janelas que viram a madrugada
// (ex.: 18:00 → 08:00) e dias inteiros (ex.: sábado). Usa o fuso do config.

import fs from 'fs';
import path from 'path';
import { config } from '../config';
import { logger } from '../logger';
import { isUraEnabled, setUraEnabled } from './ura-control';

const FILE = path.join(process.cwd(), 'data', 'ura-schedule.json');

/** Janela em que a URA fica LIGADA. Fora de todas as janelas → desligada. */
export interface Janela {
  id: string;
  /** Dias da semana em que a janela COMEÇA (0=domingo … 6=sábado). */
  dias: number[];
  /** "HH:MM" (24h) do fuso configurado. */
  inicio: string;
  fim: string;
}

export interface Agenda {
  /** Master: quando true, o agendador controla a URA. false = controle manual. */
  ativo: boolean;
  janelas: Janela[];
}

let agenda: Agenda = { ativo: false, janelas: [] };

function carregar(): void {
  try {
    if (fs.existsSync(FILE)) {
      const raw = JSON.parse(fs.readFileSync(FILE, 'utf8')) as Partial<Agenda>;
      agenda = {
        ativo: raw.ativo === true,
        janelas: Array.isArray(raw.janelas) ? raw.janelas.map(normalizarJanela).filter(Boolean) as Janela[] : [],
      };
    }
  } catch (err) {
    logger.warn('Agenda da URA: falha ao carregar, usando vazia', { err: String(err) });
  }
}

function salvar(): void {
  const dir = path.dirname(FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(agenda, null, 2), 'utf8');
}

function normalizarJanela(j: any): Janela | null {
  const hhmm = /^([01]?\d|2[0-3]):([0-5]\d)$/;
  const inicio = String(j?.inicio ?? '').trim();
  const fim = String(j?.fim ?? '').trim();
  if (!hhmm.test(inicio) || !hhmm.test(fim)) return null;
  const brutos: number[] = Array.isArray(j?.dias) ? (j.dias as unknown[]).map((d) => Number(d)) : [];
  const dias: number[] = [...new Set(brutos.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))];
  if (!dias.length) return null;
  return {
    id: String(j?.id ?? Math.random().toString(36).slice(2, 9)),
    dias: dias.sort((a, b) => a - b),
    inicio: inicio.padStart(5, '0'),
    fim: fim.padStart(5, '0'),
  };
}

/** Hora atual (dia da semana + minutos desde meia-noite) no fuso configurado. */
function agoraNoFuso(): { dia: number; minutos: number } {
  const local = new Date(new Date().toLocaleString('en-US', { timeZone: config.tz }));
  return { dia: local.getDay(), minutos: local.getHours() * 60 + local.getMinutes() };
}

function paraMinutos(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/** A janela está ativa agora? Trata virada de madrugada e dia inteiro. Exportada p/ teste. */
export function janelaAtiva(j: Janela, dia: number, minutos: number): boolean {
  const ini = paraMinutos(j.inicio);
  const fim = paraMinutos(j.fim);
  const diaAnterior = (dia + 6) % 7;

  if (ini === fim) return j.dias.includes(dia);            // dia inteiro (24h)

  if (ini < fim) {
    // Mesma data (ex.: 08:00 → 18:00)
    return j.dias.includes(dia) && minutos >= ini && minutos < fim;
  }
  // Vira a madrugada (ex.: 18:00 → 08:00):
  // trecho da noite conta pro dia de início; a madrugada conta pro dia anterior.
  if (j.dias.includes(dia) && minutos >= ini) return true;
  if (j.dias.includes(diaAnterior) && minutos < fim) return true;
  return false;
}

/** Deve estar ligada agora, segundo a agenda? null = agendador inativo. */
export function avaliarAgora(): boolean | null {
  if (!agenda.ativo) return null;
  const { dia, minutos } = agoraNoFuso();
  return agenda.janelas.some((j) => janelaAtiva(j, dia, minutos));
}

/** Aplica a agenda ao estado da URA (usado no tick e ao salvar). */
function aplicar(): void {
  const desejado = avaliarAgora();
  if (desejado === null) return;                          // agendador desligado → não mexe
  if (desejado !== isUraEnabled()) {
    setUraEnabled(desejado, 'agendamento');
    logger.info(`Agenda: URA ${desejado ? 'LIGADA' : 'DESLIGADA'} automaticamente`);
  }
}

export function getAgenda(): Agenda {
  return agenda;
}

export function setAgenda(nova: Partial<Agenda>): Agenda {
  agenda = {
    ativo: nova.ativo === true,
    janelas: Array.isArray(nova.janelas)
      ? (nova.janelas.map(normalizarJanela).filter(Boolean) as Janela[])
      : [],
  };
  salvar();
  aplicar();                                              // reflete na hora
  logger.info(`Agenda da URA salva: ${agenda.ativo ? 'ATIVA' : 'inativa'}, ${agenda.janelas.length} janela(s)`);
  return agenda;
}

/** Descrição do próximo evento (para o painel mostrar). */
export function statusAgenda() {
  const desejado = avaliarAgora();
  return {
    ativo: agenda.ativo,
    janelas: agenda.janelas,
    controlandoAgora: desejado !== null,
    deveriaEstar: desejado,             // true/false/null
  };
}

export function startUraSchedule(): void {
  carregar();
  if (agenda.ativo) {
    logger.info(`Agenda da URA: ATIVA com ${agenda.janelas.length} janela(s) — controlando liga/desliga`);
    aplicar();
  }
  // Reavalia a cada 30s (pega viradas de horário com folga).
  setInterval(aplicar, 30_000).unref?.();
}
