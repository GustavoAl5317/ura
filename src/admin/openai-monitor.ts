import axios from 'axios';
import { config } from '../config';
import { addAlertOnce } from './alerts';
import type { OpenAiUsageSnapshot } from './types';

let lastSnapshot: OpenAiUsageSnapshot | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

interface CostBucket {
  results?: Array<{ object?: string; amount?: { value?: number } }>;
}

function sumCostsFromBuckets(buckets: CostBucket[]): number {
  let total = 0;
  for (const bucket of buckets) {
    for (const row of bucket.results ?? []) {
      if (row.amount?.value != null) {
        total += Number(row.amount.value);
      }
    }
  }
  return total;
}

async function fetchOrganizationCosts(
  startSec: number,
  endSec: number,
): Promise<{ spend: number }> {
  const apiKey = config.admin.openaiAdminKey;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
  };
  if (config.admin.openaiOrgId) {
    headers['OpenAI-Organization'] = config.admin.openaiOrgId;
  }

  // Uma única requisição (limit cobre o mês inteiro) — evita erro 400 na paginação
  const res = await axios.get<{
    data?: CostBucket[];
  }>('https://api.openai.com/v1/organization/costs', {
    headers,
    params: {
      start_time: startSec,
      end_time: endSec,
      bucket_width: '1d',
      limit: 31,
    },
    timeout: 20_000,
    validateStatus: (s) => s < 500,
  });

  if (res.status === 401) {
    throw new Error(
      'HTTP 401 — verifique OPENAI_ADMIN_KEY (Admin key read-only) e OPENAI_ORG_ID.',
    );
  }
  if (res.status !== 200) {
    const detail = res.data ? JSON.stringify(res.data).slice(0, 160) : '';
    throw new Error(`HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
  }

  return { spend: sumCostsFromBuckets(res.data?.data ?? []) };
}

export function getOpenAiSnapshot(): OpenAiUsageSnapshot | null {
  return lastSnapshot;
}

export async function refreshOpenAiUsage(): Promise<OpenAiUsageSnapshot> {
  const alertBudget = config.admin.openaiBudgetUsd;
  const prepaid = config.admin.openaiPrepaidUsd;
    const now = new Date();
    // Puxa os últimos 30 dias contínuos em vez de apenas o mês atual
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 30);

  const snapshot: OpenAiUsageSnapshot = {
    checkedAt: now.toISOString(),
    ok: false,
    alertBudgetUsd: alertBudget > 0 ? alertBudget : undefined,
    budgetUsd: alertBudget > 0 ? alertBudget : undefined,
    prepaidUsd: prepaid > 0 ? prepaid : undefined,
    periodStart: start.toISOString().slice(0, 10),
    periodEnd: now.toISOString().slice(0, 10),
  };

  if (!config.admin.openaiAdminKey) {
    snapshot.error = 'OPENAI_ADMIN_KEY não configurada';
    snapshot.note =
      'A OPENAI_API_KEY (sk-proj) não lê custos — crie uma Admin key em platform.openai.com → ' +
      'Organization settings → Admin keys → Create (Read only). Cole em OPENAI_ADMIN_KEY.';
    lastSnapshot = snapshot;
    return snapshot;
  }

  if (!config.admin.openaiOrgId) {
    snapshot.error = 'OPENAI_ORG_ID não configurado';
    snapshot.note =
      'Para ver o gasto real: pegue o org ID em platform.openai.com → Settings → Organization. ' +
      'Use OPENAI_ADMIN_KEY (chave Admin, read-only) em platform.openai.com → Admin keys. ' +
      'OPENAI_PREPAID_USD = créditos que você comprou (para estimar saldo restante).';
    lastSnapshot = snapshot;
    return snapshot;
  }

  try {
    const startSec = Math.floor(start.getTime() / 1000);
    // OpenAI exige que o end_date seja estritamente DEPOIS do start_date
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const endSec = Math.floor(end.getTime() / 1000);
    const { spend } = await fetchOrganizationCosts(startSec, endSec);
    const spendUsd = Math.round(spend * 100) / 100;

    snapshot.ok = true;
    snapshot.spendUsd = spendUsd;
    snapshot.totalUsd = spendUsd;
    snapshot.note = `Gasto do mês (API OpenAI). Saldo de créditos: veja em platform.openai.com → Billing.`;

    if (alertBudget > 0) {
      snapshot.remainingUsd = Math.max(0, Math.round((alertBudget - spendUsd) * 100) / 100);
      snapshot.percentUsed = Math.min(100, Math.round((spendUsd / alertBudget) * 100));
    }
  } catch (err: unknown) {
    snapshot.ok = false;
    snapshot.error = err instanceof Error ? err.message : String(err);
    snapshot.note =
      'Falha ao consultar /v1/organization/costs. Crie uma Admin API key (read-only) em platform.openai.com ' +
      'e defina OPENAI_ADMIN_KEY + OPENAI_ORG_ID no .env. OPENAI_BUDGET_USD é só limite de alerta, não saldo real.';
  }

  lastSnapshot = snapshot;
  checkThresholds(snapshot);
  return snapshot;
}

function checkThresholds(s: OpenAiUsageSnapshot): void {
  const spend = s.spendUsd ?? s.totalUsd;
  const limit = s.alertBudgetUsd ?? s.budgetUsd;
  if (!limit || spend == null) return;

  const remaining = s.remainingUsd ?? limit - spend;
  const pct = s.percentUsed ?? Math.round((spend / limit) * 100);
  const threshold = config.admin.openaiAlertThresholdPct;

  if (pct >= 100 - threshold) {
    addAlertOnce(
      'openai-low',
      'critical',
      'Gasto OpenAI próximo do limite',
      `Gasto no mês: $${spend.toFixed(2)} (limite de alerta $${limit.toFixed(2)}). Restante estimado: ~$${remaining.toFixed(2)}.`,
    );
  } else if (pct >= 70) {
    addAlertOnce(
      'openai-warn',
      'warn',
      'Gasto OpenAI elevado',
      `Gasto no mês: $${spend.toFixed(2)} de $${limit.toFixed(2)} (${pct}%).`,
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
