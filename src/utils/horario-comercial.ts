// Janela de atendimento humano. A IA responde 24h — isto só decide se dá pra
// prometer um atendente humano agora ou se o cliente precisa esperar o
// expediente reabrir.

import { config } from '../config';

const DIA_NOME: Record<number, string> = {
  0: 'domingo', 1: 'segunda', 2: 'terça', 3: 'quarta',
  4: 'quinta', 5: 'sexta', 6: 'sábado',
};

function paraMinutos(hhmm: string): number {
  const [h, m] = hhmm.split(':').map((s) => Number(s.trim()));
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
}

/** true se `agora` cai dentro do horário comercial configurado (TZ do processo). */
export function estaNoHorarioComercial(agora: Date = new Date()): boolean {
  if (!config.businessHours.enabled) return true;
  if (!config.businessHours.days.includes(agora.getDay())) return false;
  const minutosAgora = agora.getHours() * 60 + agora.getMinutes();
  return minutosAgora >= paraMinutos(config.businessHours.start)
    && minutosAgora < paraMinutos(config.businessHours.end);
}

/** "segunda a sábado, das 08:00 às 18:00" — pra citar ao cliente. */
export function descricaoHorarioComercial(): string {
  const dias = [...config.businessHours.days].sort((a, b) => a - b);
  const nomes = dias.map((d) => DIA_NOME[d] ?? String(d));
  const contiguo = dias.length > 1 && dias.every((d, i) => i === 0 || d === dias[i - 1] + 1);
  const diasTexto = contiguo
    ? `${nomes[0]} a ${nomes[nomes.length - 1]}`
    : nomes.join(', ');
  return `${diasTexto}, das ${config.businessHours.start} às ${config.businessHours.end}`;
}
