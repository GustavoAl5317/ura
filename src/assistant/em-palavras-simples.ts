// Uma linha "em palavras simples" para cada aviso automático.
//
// Alerta sai de monitor, não da IA: "CTO offline", "Queda de sessões PPPoE",
// "Interface XGigabitEthernet0/0/5 down". A casa pediu que tudo que chega no
// WhatsApp seja entendido por quem não sabe nada de rede. A explicação é fixa
// por tipo de aviso, escrita aqui, e não gerada por modelo: alerta precisa sair
// na hora, e uma frase inventada num alerta crítico seria o pior lugar para
// errar.

export interface AvisoParaExplicar {
  origem: string;
  chave: string;
  dados?: unknown;
}

const POR_TIPO_ZABBIX: Record<string, string> = {
  cto_off: 'Uma caixinha no poste parou. As casas ligadas nela estão sem internet agora.',
  pop_off: 'Um ponto central da rede caiu. Muitas casas da região podem estar sem internet.',
  fibra: 'Caiu uma ligação entre equipamentos da rede. Pode ser um fio de fibra rompido.',
  energia: 'Faltou energia num equipamento da rede. Se não voltar logo, as casas que dependem dele ficam sem internet.',
  pppoe_off: 'Muitos clientes perderam a internet ao mesmo tempo.',
  equipamento_cliente: 'O aparelhinho da internet de um cliente parou de responder.',
  energia_cliente: 'Faltou energia na casa de um cliente: o aparelhinho da internet dele desligou.',
  link: 'O cano grande por onde a internet chega até nós (a ligação com a operadora) caiu ou está com problema.',
  poe: 'Um equipamento que recebe energia pelo próprio cabo ficou sem energia.',
  outro: 'O sistema que vigia a rede apontou um problema num equipamento.',
};

function clientesNoAviso(dados: unknown): number | null {
  const n = (dados as { impacto?: { clientes?: unknown } } | null)?.impacto?.clientes;
  return typeof n === 'number' && n > 0 ? n : null;
}

/** A frase simples do aviso, ou null quando o aviso já é simples (resumo, bot). */
export function explicacaoSimples(a: AvisoParaExplicar): string | null {
  const c = a.chave;
  if (c.startsWith('resumo:')) return null;           // o resumo já abre com "Em poucas palavras"
  if (a.origem === 'bot') return null;
  if (c.endsWith(':resolvido')) return 'Voltou ao normal.';

  if (c.startsWith('zabbix:')) {
    const tipo = String((a.dados as { tipo?: unknown } | null)?.tipo ?? 'outro');
    const base = POR_TIPO_ZABBIX[tipo] ?? POR_TIPO_ZABBIX.outro;
    const n = clientesNoAviso(a.dados);
    return tipo === 'cto_off' && n
      ? `Uma caixinha no poste parou. As ${n} casas ligadas nela estão sem internet agora.`
      : base;
  }
  if (c.startsWith('ctos:sinal:')) {
    return 'A força da luz que leva a internet até uma caixinha ficou mais fraca que o normal. ' +
      'Ainda funciona, mas pode começar a falhar.';
  }
  if (c.startsWith('ctos:sem_coleta:')) {
    return 'Paramos de receber a medição de uma caixinha. Não quer dizer que ela caiu: só não estamos conseguindo ver.';
  }
  if (c.startsWith('ctos:coleta_parada')) {
    return 'A medição de todas as caixinhas parou. A internet pode estar normal: quem precisa ser olhado é o sistema de medição.';
  }
  if (c.startsWith('netflow:ataque:')) {
    return 'Um cliente está recebendo uma quantidade anormal de acessos, parece um ataque. ' +
      'A internet dele, e às vezes a dos vizinhos, pode ficar lenta.';
  }
  if (c.startsWith('netflow:queda')) return 'O uso da internet caiu de repente. Pode ser que algum trecho tenha ficado sem internet.';
  if (c.startsWith('netflow:coleta_parada')) return 'Paramos de receber a medição de uso da internet. A internet pode estar normal.';
  if (c.startsWith('sla:')) return 'Tem cliente esperando resposta no atendimento há mais tempo que o combinado.';
  if (c.startsWith('ura:')) return 'Chegou uma ligação na central telefônica.';
  if (c.startsWith('incidente:') && c.endsWith(':encerrado')) return 'Esse problema foi encerrado.';
  if (c.startsWith('sistema:')) return 'Aviso do próprio assistente, não da internet dos clientes.';
  return null;
}

/** Texto do aviso com a linha simples no fim do corpo. */
export function comExplicacao(texto: string, a: AvisoParaExplicar): string {
  const e = explicacaoSimples(a);
  return e ? `${texto}\n\n💬 ${e}` : texto;
}
