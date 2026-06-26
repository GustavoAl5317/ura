import { randomUUID } from 'crypto';
import type { ActiveSession, CallEvent, CallEventType } from './types';

type SseClient = { id: string; write: (chunk: string) => void; close: () => void };

class SessionRegistry {
  private sessions = new Map<string, ActiveSession>();
  private sseClients = new Map<string, SseClient>();

  register(callId: string, meta: { callerNumber: string; channel?: string }): void {
    this.sessions.set(callId, {
      callId,
      callerNumber: meta.callerNumber,
      channel: meta.channel,
      startedAt: new Date().toISOString(),
      events: [],
    });
    this.emit(callId, 'call_started', `Chamada iniciada — ${meta.callerNumber || 'desconhecido'}`, meta);
  }

  updateMeta(callId: string, patch: Partial<Pick<ActiveSession, 'clienteNome' | 'contratoId'>>): void {
    const s = this.sessions.get(callId);
    if (!s) return;
    Object.assign(s, patch);
    this.broadcast({ type: 'session_update', callId, data: patch });
  }

  emit(
    callId: string,
    type: CallEventType,
    message: string,
    data?: Record<string, unknown>,
  ): CallEvent {
    const event: CallEvent = {
      id: randomUUID(),
      callId,
      type,
      message,
      data,
      at: new Date().toISOString(),
    };

    const session = this.sessions.get(callId);
    if (session) {
      session.events.push(event);
      if (session.events.length > 200) session.events.shift();
    }

    this.broadcast({ type: 'event', event });
    return event;
  }

  end(callId: string): ActiveSession | undefined {
    const s = this.sessions.get(callId);
    if (!s) return undefined;
    this.emit(callId, 'call_ended', 'Chamada encerrada');
    this.sessions.delete(callId);
    this.broadcast({ type: 'session_ended', callId });
    return s;
  }

  getActive(): ActiveSession[] {
    return [...this.sessions.values()];
  }

  get(callId: string): ActiveSession | undefined {
    return this.sessions.get(callId);
  }

  activeCount(): number {
    return this.sessions.size;
  }

  subscribeSse(write: (chunk: string) => void, close: () => void): string {
    const id = randomUUID();
    this.sseClients.set(id, { id, write, close });
    write(`event: connected\ndata: ${JSON.stringify({ active: this.activeCount() })}\n\n`);
    return id;
  }

  unsubscribeSse(id: string): void {
    this.sseClients.delete(id);
  }

  private broadcast(payload: unknown): void {
    const line = `data: ${JSON.stringify(payload)}\n\n`;
    for (const [id, client] of this.sseClients) {
      try {
        client.write(line);
      } catch {
        this.sseClients.delete(id);
        client.close();
      }
    }
  }
}

export const sessionRegistry = new SessionRegistry();
