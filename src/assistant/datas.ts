// Datas no fuso da operação e datas vindas do SGP.
//
// O SGP devolve data em AAAA-MM-DD ou DD/MM/AAAA, com a hora às vezes no mesmo
// campo e às vezes num campo separado. Tudo que interpreta essas datas passa
// por aqui, para "cadastrada ontem" significar a mesma coisa em todo lugar.

import { config } from '../config';

export function partesLocais(d: Date): Record<string, string> {
  const f = new Intl.DateTimeFormat('en-GB', {
    timeZone: config.tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(d)) p[x.type] = x.value;
  if (p.hour === '24') p.hour = '00';
  return p;
}

/** AAAA-MM-DD no fuso da operação. */
export function diaLocal(d: Date): string {
  const p = partesLocais(d);
  return `${p.year}-${p.month}-${p.day}`;
}

/** HH:MM no fuso da operação. */
export function horaLocal(d: Date): string {
  const p = partesLocais(d);
  return `${p.hour}:${p.minute}`;
}

/** DD/MM HH:MM no fuso da operação. */
export function rotuloData(d: Date): string {
  const p = partesLocais(d);
  return `${p.day}/${p.month} ${p.hour}:${p.minute}`;
}

/** Instante UTC de um horário de parede no fuso da operação. */
export function localParaUtc(ano: number, mes: number, dia: number, h: number, mi: number, s: number): Date {
  const palpite = Date.UTC(ano, mes - 1, dia, h, mi, s);
  const p = partesLocais(new Date(palpite));
  const comoUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return new Date(palpite - (comoUtc - palpite));
}

/**
 * Data (e hora, se houver) do SGP → instante. Sem hora, devolve só o dia —
 * quem chama decide o que fazer com isso.
 */
export function instanteSgp(data: unknown, hora?: unknown): { instante: Date | null; dia: string | null } {
  const bruto = String(data ?? '').trim();
  let ano: number, mes: number, dia: number;
  let m = bruto.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) { ano = +m[1]; mes = +m[2]; dia = +m[3]; }
  else if ((m = bruto.match(/^(\d{2})\/(\d{2})\/(\d{4})/))) { ano = +m[3]; mes = +m[2]; dia = +m[1]; }
  else return { instante: null, dia: null };

  const diaIso = `${ano}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
  const h = bruto.match(/[ T](\d{2}):(\d{2})(?::(\d{2}))?/) ?? String(hora ?? '').match(/^(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!h) return { instante: null, dia: diaIso };
  return { instante: localParaUtc(ano, mes, dia, +h[1], +h[2], +(h[3] ?? 0)), dia: diaIso };
}

/** Texto sem acento e em minúsculas, para casar palavra-chave com motivo de O.S. */
export function normalizar(s: unknown): string {
  return String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}
