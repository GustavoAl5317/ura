// Monitor da governança: retenção, saúde e backup conferido.
//
// É o ciclo que cuida do próprio sistema. Ele também é o único que percebe
// silêncio: alerta nenhum consegue avisar que alertas pararam de existir.

import { obter, dentroDaJanela } from '../config-dinamica';
import { emitir } from '../alertas';
import { fazerBackup, limparAntigos, saude } from '../governanca';
import { logger } from '../../logger';
import { iniciarMonitor } from './base';

let ultimoBackupEm = '';

export async function cicloGovernanca(agora = new Date()): Promise<{ alertas: number; detalhe: Record<string, unknown> }> {
  let alertas = 0;
  const limpeza = limparAntigos(agora);
  const s = saude(agora);

  // Silêncio anormal vira alerta uma vez por dia: repetir de hora em hora não
  // acrescenta informação, só ruído.
  if (s.silencio.anormal) {
    const a = await emitir({
      origem: 'sistema', severidade: 'aviso',
      titulo: 'Nada acontece há tempo demais',
      texto: `⚠️ *Silêncio anormal*
Nenhum evento há ${s.silencio.minutos_sem_evento} min, com monitor ligado.
` +
        'Isso costuma ser coleta parada, não rede impecável. Confira os monitores no painel.',
      chave: `sistema:silencio:${agora.toISOString().slice(0, 10)}`,
      dados: { minutos: s.silencio.minutos_sem_evento, limite: s.silencio.limite_min },
    });
    if (a) alertas++;
  }

  for (const sinal of s.sinais.filter((x) => !x.ok)) {
    const a = await emitir({
      origem: 'sistema', severidade: 'aviso',
      titulo: `Plataforma: ${sinal.nome}`,
      texto: `⚠️ *${sinal.nome}*
${sinal.detalhe}`,
      chave: `sistema:saude:${sinal.nome}:${agora.toISOString().slice(0, 13)}`,
      dados: { sinal: sinal.nome, detalhe: sinal.detalhe },
    });
    if (a) alertas++;
  }

  // Backup na hora marcada, uma vez por dia.
  const hoje = agora.toISOString().slice(0, 10);
  const hora = obter<string>('backup.hora');
  const naHora = hora ? dentroDaJanela(hora, somarMinutos(hora, 30), agora) : false;
  let backup: Record<string, unknown> | null = null;
  if (obter<boolean>('backup.ativo') && naHora && ultimoBackupEm !== hoje) {
    ultimoBackupEm = hoje;
    const r = await fazerBackup(agora);
    backup = { arquivo: r.arquivo, mb: r.mb, verificado: r.verificado, integridade: r.integridade };
    if (!r.verificado) {
      logger.error('Backup do dia não passou na conferência', { arquivo: r.arquivo });
      const a = await emitir({
        origem: 'sistema', severidade: 'critico',
        titulo: 'Backup não confere',
        texto: `🔴 *Backup não confere*
A cópia ${r.arquivo} foi gerada, mas a conferência falhou: ${r.erro ?? r.integridade}.`,
        chave: `sistema:backup:${hoje}`,
        dados: { arquivo: r.arquivo, erro: r.erro ?? r.integridade },
      });
      if (a) alertas++;
    }
  }

  return {
    alertas,
    detalhe: {
      saudavel: s.ok,
      sinais_ruins: s.sinais.filter((x) => !x.ok).map((x) => x.nome),
      banco_mb: s.banco.mb,
      backups: s.banco.backups,
      minutos_sem_evento: s.silencio.minutos_sem_evento,
      apagados: limpeza.reduce((a, b) => a + b.apagados, 0),
      backup,
    },
  };
}

/** "03:30" + 30 = "04:00". Só para montar a janela do backup. */
function somarMinutos(hm: string, minutos: number): string {
  const [h, m] = hm.split(':').map(Number);
  const total = (h * 60 + m + minutos) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

export function iniciarMonitorGovernanca(): () => void {
  return iniciarMonitor({
    nome: 'governanca',
    descricao: 'Retenção de dados, saúde da plataforma e backup conferido',
    ativo: () => obter<boolean>('saude.ativa'),
    intervaloSeg: () => obter<number>('saude.intervalo_seg'),
    ciclo: () => cicloGovernanca(),
  });
}
