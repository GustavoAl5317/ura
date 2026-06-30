import fs from 'fs';
import path from 'path';
import { logger } from '../logger';

const STATE_FILE = path.join(process.cwd(), 'data', 'ura-event.json');

let eventMessage = '';

function loadEvent(): void {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as { message?: string };
      if (typeof raw.message === 'string') eventMessage = raw.message;
    }
  } catch {
    // defaults to empty
  }
}

function persistEvent(): void {
  const dir = path.dirname(STATE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify({ message: eventMessage, updatedAt: new Date().toISOString() }), 'utf8');
}

loadEvent();

export function getEventMessage(): string {
  return eventMessage;
}

export function setEventMessage(msg: string): void {
  eventMessage = msg.trim();
  persistEvent();
  logger.info(`Mensagem de evento atualizada: "${eventMessage}"`);
}
