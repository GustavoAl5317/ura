import type { SgpCliente, SgpOnu, SgpTitulo, SgpManutencao } from '../integrations/sgp';

export interface CallContext {
  callId: string;
  callerNumber: string;
  asteriskChannel?: string;
  startedAt: Date;

  /** Canal do atendimento: 'voz' (URA/Asterisk) ou 'chat' (WhatsApp texto). */
  canal?: 'voz' | 'chat';

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
