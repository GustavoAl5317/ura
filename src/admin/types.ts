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
  totalUsd?: number;
  periodStart?: string;
  periodEnd?: string;
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
