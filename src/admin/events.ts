import fs from 'fs';
import path from 'path';
import { logger } from '../logger';

export interface UraEvent {
  id: string;
  message: string;
  startTime: string | null;
  endTime: string | null;
  active: boolean;
}

const STATE_FILE = path.join(process.cwd(), 'data', 'ura-events.json');

let events: UraEvent[] = [];

function loadEvents(): void {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as { events?: UraEvent[] };
      if (Array.isArray(raw.events)) {
        events = raw.events;
      }
    }
  } catch (err) {
    logger.error('Erro ao carregar ura-events.json', err);
  }
}

function persistEvents(): void {
  const dir = path.dirname(STATE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify({ events, updatedAt: new Date().toISOString() }, null, 2), 'utf8');
}

loadEvents();

export function getAllEvents(): UraEvent[] {
  return events;
}

export function getActiveEvents(): UraEvent[] {
  const now = new Date();
  return events.filter(e => {
    if (!e.active) return false;
    
    if (e.startTime) {
      const start = new Date(e.startTime);
      if (now < start) return false;
    }
    
    if (e.endTime) {
      const end = new Date(e.endTime);
      if (now > end) return false;
    }
    
    return true;
  });
}

export function setEvents(newEvents: UraEvent[]): void {
  events = newEvents;
  persistEvents();
  logger.info(`Lista de eventos atualizada: ${events.length} evento(s) configurado(s).`);
}
