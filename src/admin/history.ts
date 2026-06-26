import fs from 'fs';
import path from 'path';
import type { ActiveSession, HistoryRecord } from './types';

const DATA_DIR = path.join(process.cwd(), 'data');
const HISTORY_FILE = path.join(DATA_DIR, 'call-history.jsonl');

function ensureDir(): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

export function saveCallHistory(session: ActiveSession, summary: string[]): void {
  ensureDir();
  const started = new Date(session.startedAt).getTime();
  const ended = Date.now();
  const record: HistoryRecord = {
    callId: session.callId,
    callerNumber: session.callerNumber,
    clienteNome: session.clienteNome,
    startedAt: session.startedAt,
    endedAt: new Date(ended).toISOString(),
    durationSec: Math.round((ended - started) / 1000),
    events: session.events,
    summary,
  };
  fs.appendFileSync(HISTORY_FILE, `${JSON.stringify(record)}\n`, 'utf8');
}

export function listHistory(limit = 50): HistoryRecord[] {
  ensureDir();
  if (!fs.existsSync(HISTORY_FILE)) return [];

  const lines = fs.readFileSync(HISTORY_FILE, 'utf8').trim().split('\n').filter(Boolean);
  const records: HistoryRecord[] = [];
  for (let i = lines.length - 1; i >= 0 && records.length < limit; i--) {
    try {
      records.push(JSON.parse(lines[i]) as HistoryRecord);
    } catch {
      // linha corrompida — ignora
    }
  }
  return records;
}

export function getHistory(callId: string): HistoryRecord | null {
  ensureDir();
  if (!fs.existsSync(HISTORY_FILE)) return null;

  const lines = fs.readFileSync(HISTORY_FILE, 'utf8').trim().split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const r = JSON.parse(lines[i]) as HistoryRecord;
      if (r.callId === callId) return r;
    } catch {
      // ignora
    }
  }
  return null;
}
