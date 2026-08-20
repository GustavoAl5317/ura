import type { SgpCliente, SgpOnu, SgpTitulo, SgpManutencao } from '../integrations/sgp';

export interface CallContext {
  callId: string;
  callerNumber: string;
  asteriskChannel?: string;
  startedAt: Date;

  /** Canal do atendimento: 'voz' (URA/Asterisk) ou 'chat' (WhatsApp texto). */
  canal?: 'voz' | 'chat';

  /** Instância Evolution que enviará as mensagens (chat multi-número). Vazio = padrão do config. */
  whatsappInstance?: string;

  /**
   * Transporte de envio ao cliente (chat). Quando definido, os handlers enviam
   * fatura/resumo por aqui em vez da Evolution — usado para a Cloud API oficial.
   * Recebe o texto já montado e devolve se entregou.
   */
  enviarTextoCliente?: (numero: string, texto: string) => Promise<{ enviado: boolean; motivo?: string }>;

  // Dados do cliente (preenchidos após identificação)
  cliente?: SgpCliente;
  titulos?: SgpTitulo[];          // faturas em aberto (lazy loaded)
  onu?: SgpOnu;                   // status ONU (lazy loaded)
  manutencoesAtivas?: SgpManutencao[];

  // Flags de estado
  clienteIdentificado: boolean;
  clienteConfirmado: boolean;   // true após cliente confirmar titular (obrigatório após CPF)
  contratoSelecionado: boolean; // true quando há 1 contrato ou cliente escolheu o endereço
  massivaAtiva: boolean;
  pendingTransfer: boolean;
  pendingHangup: boolean;

  // Para transferência
  transferSummary?: string;
  transferMotivo?: string;
  /** Setor identificado pela IA (financeiro/suporte/vendas/outro) — só chat. */
  transferSetor?: string;

  /**
   * Fila de atendimento humano (só chat). Quando entrou (filaEntradaEm) e o
   * escalonamento sonoro/mensagens já disparado (filaNivelEnviado) vivem
   * juntos: sem isso o sweep não sabe se já mandou o aviso de 3/5/8 minutos.
   */
  filaTipo?: 'atendimento' | 'adesao';
  filaEntradaEm?: number;
  /** 1 = entrou na fila (nível imediato) … 4 = crítico (8min sem atendimento). */
  filaNivelEnviado?: number;

  // Último endereço consultado na viabilidade (usado no registrar_interesse)
  enderecoConsultado?: string;

  // WhatsApp — celular informado e confirmado pelo cliente nesta chamada
  celularWhatsApp?: string;
  celularWhatsAppConfirmado?: boolean;
  protocolos: string[];
  faturaWhatsApp?: {
    valor: string;
    vencimento: string;
    pixCopiaCola?: string | null;
    linkBoleto?: string | null;
    linhaDigitavel?: string | null;
  };

  /** Termos OLT/CTO usados para cruzar com Zabbix */
  infraTermos?: string[];

  // Log resumido do atendimento
  log: string[];

  /** Agente desta chamada (nome + voz ElevenLabs) */
  agentName?: string;
  voiceId?: string;
  /** Voz OpenAI (Realtime ou Speech API) — feminina/masculina conforme o agente */
  openaiVoice?: string;
  /** Gênero do agente para concordância no prompt e TTS */
  agentGender?: 'f' | 'm';

  /** Última transcrição do cliente (validação de confirmações) */
  lastClientSpeech?: string;

  /** Após titular confirmado: financeiro deve ser consultado sem esperar o cliente */
  precisaConsultarFinanceiro?: boolean;
  consultaFinanceiraFeita?: boolean;
  consultaMassivaFeita?: boolean;
  consultaPlanosFeita?: boolean;
  /** Cliente relatou queda/lentidão/etc. — encadear verificar_massiva após financeiro */
  relatouProblemaTecnico?: boolean;
  /** Se o cliente tem faturas atrasadas ou bloqueio financeiro */
  financeiroBloqueado?: boolean;
}

export function createContext(callId: string, callerNumber: string): CallContext {
  return {
    callId,
    callerNumber,
    startedAt: new Date(),
    clienteIdentificado: false,
    clienteConfirmado: false,
    contratoSelecionado: false,
    massivaAtiva: false,
    pendingTransfer: false,
    pendingHangup: false,
    protocolos: [],
    log: [],
  };
}
