import type { Server as SocketIOServer } from 'socket.io';
import { recordSessionLog } from '../utils/sessionLogs.js';

let ioRef: SocketIOServer | null = null;

export function setIo(io: SocketIOServer) {
  ioRef = io;
}

export async function emit(event: string, payload: any) {
  try {
    if (event === 'log' && payload) {
      const level = String(payload?.level || 'info');
      const message = String(payload?.message || '');
      // Normalize to short local time for UI display consistency
      const timestamp = new Date().toLocaleTimeString();
      const context = (payload?.context && typeof payload.context === 'object') ? payload.context as Record<string, unknown> : undefined;
      const cat = ((payload?.cat as string) || (context as any)?.cat || 'other').toLowerCase();
      // If backend category filtering is configured, drop disabled categories here as well
      try {
        const { CONFIG } = await import('../utils/config.js');
        const enabled = (CONFIG as any)?.system?.enabledLogCategories as string[] | undefined;
        // Only filter when the list is non-empty; empty means no filtering
        if (Array.isArray(enabled) && enabled.length > 0) {
          if (!enabled.includes(cat)) return;
        }
      } catch {}
      recordSessionLog({ level, message, timestamp, context, cat });
      // Overwrite outgoing payload timestamp and normalized category
      try {
        payload = { ...payload, timestamp, cat, context };
      } catch {}
    }
  } catch {}
  ioRef?.emit(event, payload);
}

export async function notifyArbServiceRefresh(): Promise<void> {
  try {
    const host = process.env.ARB_SERVICE_URL || 'http://127.0.0.1:4010';
    // eslint-disable-next-line no-undef
    await fetch(`${host}/graph/trigger-refresh`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'graph-diff' }) });
  } catch {}
}


