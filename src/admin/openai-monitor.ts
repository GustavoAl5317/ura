import axios from 'axios';
import { config } from '../config';
import { addAlertOnce } from './alerts';
import type { OpenAiUsageSnapshot } from './types';

let lastSnapshot: OpenAiUsageSnapshot | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

export function getOpenAiSnapshot(): OpenAiUsageSnapshot | null {
  return lastSnapshot;
}

export async function refreshOpenAiUsage(): Promise<OpenAiUsageSnapshot> {
  const budget = config.admin.openaiBudgetUsd;
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);

  const snapshot: OpenAiUsageSnapshot = {
    checkedAt: now.toISOString(),
    ok: false,
    budgetUsd: budget > 0 ? budget : undefined,
    periodStart: start.toISOString().slice(0, 10),
    periodEnd: now.toISOString().slice(0, 10),
  };

  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${config.openai.apiKey}`,
    };
    if (config.admin.openaiOrgId) {
      headers['OpenAI-Organization'] = config.admin.openaiOrgId;
    }

    // Custos do mês (API Organization — requer chave com permissão de billing)
    const startSec = Math.floor(start.getTime() / 1000);
    const endSec = Math.floor(now.getTime() / 1000);

    const res = await axios.get<{ data?: Array<{ amount?: { value?: number } }> }>(
      'https://api.openai.com/v1/organization/costs',
      {
        headers,
        params: {
          start_time: startSec,
          end_time: endSec,
          bucket_width: '1d',
        },
        timeout: 15_000,
        validateStatus: (s) => s < 500,
      },
    );

    if (res.status === 200 && res.data?.data) {
      const total = res.data.data.reduce((sum, row) => sum + (row.amount?.value ?? 0), 0);
      snapshot.ok = true;
      snapshot.totalUsd = Math.round(total * 100) / 100;
      if (budget > 0) {
        snapshot.remainingUsd = Math.max(0, Math.round((budget - total) * 100) / 100);
        snapshot.percentUsed = Math.min(100, Math.round((total / budget) * 100));
      }
      snapshot.note = 'Custos via API Organization (mês corrente).';
    } else {
      snapshot.ok = false;
      snapshot.error = `API custos retornou HTTP ${res.status}`;
      snapshot.note =
        'Configure OPENAI_ORG_ID e uma chave com acesso a billing, ou informe OPENAI_BUDGET_USD para alertas manuais. ' +
        'Acesso à conta platform.openai.com não é monitorável por esta API — use auditoria da OpenAI (plano Team/Enterprise).';
    }
  } catch (err: unknown) {
    snapshot.ok = false;
    snapshot.error = err instanceof Error ? err.message : String(err);
    snapshot.note = 'Não foi possível consultar custos. Verifique OPENAI_ORG_ID e permissões da API key.';
  }

  lastSnapshot = snapshot;
  checkThresholds(snapshot);
  return snapshot;
}

function checkThresholds(s: OpenAiUsageSnapshot): void {
  if (!s.budgetUsd || !s.totalUsd) return;

  const remaining = s.remainingUsd ?? s.budgetUsd - s.totalUsd;
  const pct = s.percentUsed ?? Math.round((s.totalUsd / s.budgetUsd) * 100);
  const threshold = config.admin.openaiAlertThresholdPct;

  if (pct >= 100 - threshold) {
    addAlertOnce(
      'openai-low',
      'critical',
      'Créditos OpenAI baixos',
      `Uso do mês: $${s.totalUsd.toFixed(2)} de $${s.budgetUsd.toFixed(2)} (${pct}%). Restante: ~$${remaining.toFixed(2)}.`,
    );
  } else if (pct >= 70) {
    addAlertOnce(
      'openai-warn',
      'warn',
      'Uso OpenAI elevado',
      `Uso do mês: $${s.totalUsd.toFixed(2)} de $${s.budgetUsd.toFixed(2)} (${pct}%).`,
    );
  }
}

export function startOpenAiMonitor(): void {
  if (timer) return;
  const interval = config.admin.openaiPollMs;
  void refreshOpenAiUsage();
  timer = setInterval(() => void refreshOpenAiUsage(), interval);
}

export function stopOpenAiMonitor(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
