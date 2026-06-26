import fs from 'fs';
import path from 'path';
import { config } from '../config';
import { logger } from '../logger';

const STATE_FILE = path.join(process.cwd(), 'data', 'ura-state.json');

let enabled = config.admin.uraEnabledDefault;

function loadState(): void {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as { enabled?: boolean };
      if (typeof raw.enabled === 'boolean') enabled = raw.enabled;
    }
  } catch {
    // usa default
  }
}

function persistState(): void {
  const dir = path.dirname(STATE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify({ enabled, updatedAt: new Date().toISOString() }), 'utf8');
}

loadState();

export function isUraEnabled(): boolean {
  return enabled;
}

export function setUraEnabled(value: boolean, reason = 'painel'): boolean {
  enabled = value;
  persistState();
  logger.info(`URA ${value ? 'LIGADA' : 'DESLIGADA'} via ${reason}`);
  return enabled;
}

export function getUraState(): { enabled: boolean; updatedAt?: string } {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as { enabled: boolean; updatedAt?: string };
    }
  } catch {
    // ignora
  }
  return { enabled };
}
