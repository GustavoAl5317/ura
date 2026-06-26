import { randomUUID } from 'crypto';
import axios from 'axios';
import { config } from '../config';
import { logger } from '../logger';
import type { AdminAlert } from './types';

const MAX_ALERTS = 100;
const alerts: AdminAlert[] = [];

export function addAlert(
  level: AdminAlert['level'],
  title: string,
  message: string,
): AdminAlert {
  const alert: AdminAlert = {
    id: randomUUID(),
    level,
    title,
    message,
    at: new Date().toISOString(),
    read: false,
  };
  alerts.unshift(alert);
  if (alerts.length > MAX_ALERTS) alerts.pop();

  logger.warn(`[ALERTA ${level}] ${title}: ${message}`);
  void dispatchAlert(alert);
  return alert;
}

export function listAlerts(limit = 30): AdminAlert[] {
  return alerts.slice(0, limit);
}

export function markAlertRead(id: string): void {
  const a = alerts.find((x) => x.id === id);
  if (a) a.read = true;
}

async function dispatchAlert(alert: AdminAlert): Promise<void> {
  const url = config.admin.alertWebhookUrl;
  if (!url) return;

  try {
    await axios.post(url, {
      text: `[URA ${alert.level.toUpperCase()}] ${alert.title}\n${alert.message}`,
      alert,
    }, { timeout: 8_000 });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Falha ao enviar alerta webhook', { err: msg });
  }
}

const sentKeys = new Set<string>();

/** Evita spam do mesmo alerta na mesma hora. */
export function addAlertOnce(key: string, level: AdminAlert['level'], title: string, message: string): void {
  const hourKey = `${key}:${new Date().toISOString().slice(0, 13)}`;
  if (sentKeys.has(hourKey)) return;
  sentKeys.add(hourKey);
  addAlert(level, title, message);
}
