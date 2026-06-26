export type CallEventType =
  | 'call_started'
  | 'call_ended'
  | 'client_speech'
  | 'assistant_text'
  | 'tool_start'
  | 'tool_done'
  | 'tool_error'
  | 'system'
  | 'error';

export interface CallEvent {
  id: string;
  callId: string;
  type: CallEventType;
  message: string;
  data?: Record<string, unknown>;
  at: string;
}

export interface ActiveSession {
  callId: string;
  callerNumber: string;
  channel?: string;
  clienteNome?: string;
  contratoId?: number;
  startedAt: string;
  events: CallEvent[];
}

export interface HistoryRecord {
  callId: string;
  callerNumber: string;
  clienteNome?: string;
  startedAt: string;
  endedAt: string;
  durationSec: number;
  events: CallEvent[];
  summary: string[];
}

export interface OpenAiUsageSnapshot {
  checkedAt: string;
  ok: boolean;
  /** Gasto real no mês (API Organization/costs) */
  spendUsd?: number;
  /** @deprecated alias de spendUsd */
  totalUsd?: number;
  periodStart?: string;
  periodEnd?: string;
  /** Créditos que você carregou na conta (OPENAI_PREPAID_USD) */
  prepaidUsd?: number;
  /** Estimativa: prepaid - gasto (não é saldo oficial da OpenAI) */
  creditsEstimatedUsd?: number;
  /** Limite manual só para alertas (OPENAI_BUDGET_USD) — não é saldo real */
  alertBudgetUsd?: number;
  /** @deprecated */
  budgetUsd?: number;
  remainingUsd?: number;
  percentUsed?: number;
  error?: string;
  note?: string;
}

export interface AdminAlert {
  id: string;
  level: 'info' | 'warn' | 'critical';
  title: string;
  message: string;
  at: string;
  read: boolean;
}
