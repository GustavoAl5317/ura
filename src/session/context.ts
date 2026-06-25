import type { SgpCliente, SgpOnu, SgpTitulo, SgpManutencao } from '../integrations/sgp';

export interface CallContext {
  callId: string;
  callerNumber: string;
  asteriskChannel?: string;
  startedAt: Date;

  // Dados do cliente (preenchidos após identificação)
  cliente?: SgpCliente;
  titulos?: SgpTitulo[];          // faturas em aberto (lazy loaded)
  onu?: SgpOnu;                   // status ONU (lazy loaded)
  manutencoesAtivas?: SgpManutencao[];

  // Flags de estado
  clienteIdentificado: boolean;
  clienteConfirmado: boolean;   // true após cliente confirmar titular (obrigatório após CPF)
  massivaAtiva: boolean;
  pendingTransfer: boolean;
  pendingHangup: boolean;

  // Para transferência
  transferSummary?: string;
  transferMotivo?: string;

  // Último endereço consultado na viabilidade (usado no registrar_interesse)
  enderecoConsultado?: string;

  // WhatsApp — celular confirmado pelo cliente nesta chamada
  celularWhatsApp?: string;
  protocolos: string[];
  faturaWhatsApp?: {
    valor: string;
    vencimento: string;
    pixCopiaCola?: string | null;
    linkBoleto?: string | null;
    linhaDigitavel?: string | null;
  };

  // Log resumido do atendimento
  log: string[];
}

export function createContext(callId: string, callerNumber: string): CallContext {
  return {
    callId,
    callerNumber,
    startedAt: new Date(),
    clienteIdentificado: false,
    clienteConfirmado: false,
    massivaAtiva: false,
    pendingTransfer: false,
    pendingHangup: false,
    protocolos: [],
    log: [],
  };
}
