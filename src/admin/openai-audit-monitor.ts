import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { config } from '../config';
import { logger } from '../logger';
import { addAlert } from './alerts';

const DATA_DIR = path.join(process.cwd(), 'data');
const STATE_FILE = path.join(DATA_DIR, 'openai-audit-state.json');

const MONITORED_TYPES = [
  'login.succeeded',
  'login.failed',
  'api_key.created',
  'api_key.deleted',
] as const;

type MonitoredType = (typeof MONITORED_TYPES)[number];

interface AuditActor {
  type?: string;
  session?: { ip_address?: string; user?: { email?: string } };
  api_key?: { user?: { email?: string } };
}

interface AuditLogEntry {
  id: string;
  effective_at: number;
  type: string;
  actor?: AuditActor;
  'login.failed'?: { error_message?: string };
}

interface AuditState {
  initialized: boolean;
  watermarkSec: number;
  seenIds: string[];
  lastError?: string;
  lastCheckAt?: string;
  lastEventAt?: string;
}

let timer: ReturnType<typeof setInterval> | null = null;
let lastStatus: { ok: boolean; note?: string; error?: string; lastCheckAt?: string } | null = null;

function ensureDir(): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadState(): AuditState {
  ensureDir();
  if (!fs.existsSync(STATE_FILE)) {
    return { initialized: false, watermarkSec: 0, seenIds: [] };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as AuditState;
    return {
      initialized: !!raw.initialized,
      watermarkSec: raw.watermarkSec ?? 0,
      seenIds: Array.isArray(raw.seenIds) ? raw.seenIds : [],
      lastError: raw.lastError,
      lastCheckAt: raw.lastCheckAt,
      lastEventAt: raw.lastEventAt,
    };
  } catch {
    return { initialized: false, watermarkSec: 0, seenIds: [] };
  }
}

function saveState(state: AuditState): void {
  ensureDir();
  const trimmed = { ...state, seenIds: state.seenIds.slice(-500) };
  fs.writeFileSync(STATE_FILE, JSON.stringify(trimmed, null, 2), 'utf8');
}

const HISTORY_FILE = path.join(DATA_DIR, 'openai-audit-history.json');
let auditHistory: AuditLogEntry[] = [];

function loadAuditHistory(): void {
  ensureDir();
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      const raw = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
      if (Array.isArray(raw)) auditHistory = raw;
    }
  } catch {
    auditHistory = [];
  }
}

function saveAuditHistory(): void {
  ensureDir();
  if (auditHistory.length > 500) auditHistory = auditHistory.slice(-500);
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(auditHistory, null, 2), 'utf8');
}

loadAuditHistory();

export function getAuditHistory(): AuditLogEntry[] {
  return auditHistory;
}

function actorEmail(entry: AuditLogEntry): string | undefined {
  return entry.actor?.session?.user?.email ?? entry.actor?.api_key?.user?.email;
}

function actorIp(entry: AuditLogEntry): string | undefined {
  return entry.actor?.session?.ip_address;
}

function formatEvent(entry: AuditLogEntry): { level: 'info' | 'warn' | 'critical'; title: string; message: string } {
  const email = actorEmail(entry) ?? 'usuário desconhecido';
  const ip = actorIp(entry);
  const quando = new Date(entry.effective_at * 1000).toLocaleString('pt-BR', { timeZone: config.tz });
  const ipTxt = ip ? ` · IP ${ip}` : '';

  switch (entry.type as MonitoredType) {
    case 'login.succeeded':
      return {
        level: 'warn',
        title: 'Login na conta OpenAI',
        message: `${email} entrou em platform.openai.com${ipTxt} · ${quando}`,
      };
    case 'login.failed': {
      const err = entry['login.failed']?.error_message;
      return {
        level: 'critical',
        title: 'Tentativa de login OpenAI falhou',
        message: `${email}${ipTxt} · ${quando}${err ? ` · ${err}` : ''}`,
      };
    }
    case 'api_key.created':
      return {
        level: 'critical',
        title: 'Nova API key OpenAI criada',
        message: `${email} criou uma chave de API${ipTxt} · ${quando}`,
      };
    case 'api_key.deleted':
      return {
        level: 'warn',
        title: 'API key OpenAI removida',
        message: `${email} removeu uma chave de API${ipTxt} · ${quando}`,
      };
    default:
      return {
        level: 'info',
        title: `Evento OpenAI: ${entry.type}`,
        message: `${email}${ipTxt} · ${quando}`,
      };
  }
}

async function fetchAuditLogs(sinceSec: number): Promise<AuditLogEntry[]> {
  const apiKey = config.admin.openaiAdminKey;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
  };
  if (config.admin.openaiOrgId) {
    headers['OpenAI-Organization'] = config.admin.openaiOrgId;
  }

  const params = new URLSearchParams();
  params.set('limit', '100');
  params.set('effective_at[gte]', String(Math.max(0, sinceSec - 120)));
  for (const t of MONITORED_TYPES) params.append('event_types', t);

  const res = await axios.get<{ data?: AuditLogEntry[] }>(
    `https://api.openai.com/v1/organization/audit_logs?${params.toString()}`,
    { headers, timeout: 20_000, validateStatus: (s) => s < 500 },
  );

  if (res.status === 401) {
    throw new Error('HTTP 401 — OPENAI_ADMIN_KEY inválida ou sem permissão.');
  }
  if (res.status === 403) {
    throw new Error(
      'HTTP 403 — audit logs indisponível. Ative em platform.openai.com → Settings → Data controls → Audit logging (requer plano Team/Enterprise).',
    );
  }
  if (res.status !== 200) {
    const detail = res.data ? JSON.stringify(res.data).slice(0, 200) : '';
    throw new Error(`HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
  }

  return res.data?.data ?? [];
}

export function getOpenAiAuditStatus() {
  return lastStatus;
}

export async function refreshOpenAiAudit(): Promise<void> {
  if (!config.admin.openaiAuditMonitor) return;

  if (!config.admin.openaiAdminKey || !config.admin.openaiOrgId) {
    lastStatus = {
      ok: false,
      error: 'OPENAI_ADMIN_KEY e OPENAI_ORG_ID necessários para monitorar logins.',
      lastCheckAt: new Date().toISOString(),
    };
    return;
  }

  const state = loadState();
  const nowSec = Math.floor(Date.now() / 1000);

  if (!state.initialized) {
    state.initialized = true;
    state.watermarkSec = nowSec;
    state.lastCheckAt = new Date().toISOString();
    saveState(state);
    lastStatus = {
      ok: true,
      note: 'Monitor de login OpenAI ativo — aguardando novos eventos.',
      lastCheckAt: state.lastCheckAt,
    };
    logger.info('OpenAI audit: baseline definido — alertas só para logins novos');
    return;
  }

  try {
    const entries = await fetchAuditLogs(state.watermarkSec);
    const seen = new Set(state.seenIds);
    const sorted = [...entries].sort((a, b) => a.effective_at - b.effective_at);

    let addedNew = false;
    for (const entry of sorted) {
      if (seen.has(entry.id)) continue;
      if (entry.effective_at < state.watermarkSec) continue;

      const { level, title, message } = formatEvent(entry);
      addAlert(level, title, message);
      seen.add(entry.id);
      
      // Salva no histórico de auditoria
      auditHistory.unshift(entry);
      addedNew = true;

      state.watermarkSec = Math.max(state.watermarkSec, entry.effective_at);
      state.lastEventAt = new Date(entry.effective_at * 1000).toISOString();
    }

    if (addedNew) saveAuditHistory();

    state.seenIds = [...seen];
    state.lastCheckAt = new Date().toISOString();
    state.lastError = undefined;
    saveState(state);

    lastStatus = {
      ok: true,
      note: 'Monitorando login.succeeded, login.failed e API keys.',
      lastCheckAt: state.lastCheckAt,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    state.lastError = msg;
    state.lastCheckAt = new Date().toISOString();
    saveState(state);
    lastStatus = { ok: false, error: msg, lastCheckAt: state.lastCheckAt };
    logger.warn('OpenAI audit poll falhou', { err: msg });
  }
}

export function startOpenAiAuditMonitor(): void {
  if (!config.admin.openaiAuditMonitor || timer) return;
  const interval = config.admin.openaiAuditPollMs;
  void refreshOpenAiAudit();
  timer = setInterval(() => void refreshOpenAiAudit(), interval);
  logger.info(`Monitor OpenAI audit (login) a cada ${Math.round(interval / 1000)}s`);
}

export function stopOpenAiAuditMonitor(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
