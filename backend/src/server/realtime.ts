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
      let cat = ((payload?.cat as string) || (context as any)?.cat || 'other').toLowerCase();
      let code: string | undefined = (payload?.code as string) || (context as any)?.code as string | undefined;
      // Derive cid from message if present
      let cid: string | undefined = (payload?.cid as string) || (context as any)?.cid as string | undefined;
      try { if (!cid) { const m = /\bcid=([a-zA-Z0-9_-]+)/.exec(message); if (m) cid = m[1]; } } catch {}
      // Derive basic code when not provided to aid UI filtering
      if (!code) {
        const m = message.toLowerCase();
        if (/^pretrade:arb simulate start\b/.test(m)) code = 'PRETRADE.SIM.START';
        else if (/^pretrade:arb simulate result\b/.test(m)) code = 'PRETRADE.SIM.END';
        else if (/^pretrade:arb execute start\b/.test(m)) code = 'PRETRADE.EXEC.START';
        else if (/^pretrade:arb tx built\b/.test(m)) code = 'PRETRADE.TX.BUILT';
        else if (/^pretrade:arb (send|simulate) logs\b/.test(m)) code = 'PRETRADE.LOGS';
        else if (/^pools:subscribe ok\b/.test(m)) code = 'POOLS.SUBSCRIBE.OK';
        else if (/^pools:unsubscribe ok\b/.test(m)) code = 'POOLS.UNSUBSCRIBE.OK';
        else if (/^graph:push diff\b/.test(m)) code = 'GRAPH.PUSH.DIFF';
        else if (/^graph:push snapshot\b/.test(m)) code = 'GRAPH.PUSH.SNAPSHOT';
        else if (/^arb:push snapshot\b/.test(m)) code = 'ARB.PUSH.SNAPSHOT';
        else if (/^api\.request\b/.test(m)) code = 'API.REQUEST';
        else if (/^api\.response\b/.test(m)) code = 'API.RESPONSE';
      }
      // If backend category filtering is configured, drop disabled categories here as well
      try {
        const { CONFIG } = await import('../utils/config.js');
        // Legacy category allowlist
        const enabled = (CONFIG as any)?.system?.enabledLogCategories as string[] | undefined;
        if (Array.isArray(enabled) && enabled.length > 0 && !enabled.includes(cat)) return;
        // Structured logging rules
        const logCfg = (CONFIG as any)?.system?.log as any | undefined;
        if (logCfg) {
          const lvlOrder: Record<string, number> = { error: 0, warn: 1, info: 2, debug: 3 };
          const minLevel = String((logCfg.level || 'info')).toLowerCase();
          if ((lvlOrder[(level||'info').toLowerCase()] ?? 2) > (lvlOrder[minLevel] ?? 2)) return;
          const catLevels = (logCfg.categories || {}) as Record<string, string>;
          const keys = Object.keys(catLevels);
          let effMin: string | undefined;
          if (keys.length) {
            let best = -1;
            for (const k of keys) {
              const kl = String(k).toLowerCase();
              if (cat === kl || cat.startsWith(kl + '.')) { if (kl.length > best) { best = kl.length; effMin = String(catLevels[k]).toLowerCase(); } }
            }
          }
          if (effMin && (lvlOrder[(level||'info').toLowerCase()] ?? 2) > (lvlOrder[effMin] ?? 2)) return;
          const toRegex = (p: string) => new RegExp('^' + String(p||'').replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i');
          const enableCodes: string[] = Array.isArray(logCfg.enableCodes) ? logCfg.enableCodes : [];
          const disableCodes: string[] = Array.isArray(logCfg.disableCodes) ? logCfg.disableCodes : [];
          if (code && disableCodes.some((p) => toRegex(p).test(code))) return;
          if (enableCodes.length && code && (lvlOrder[(level||'info').toLowerCase()] ?? 2) > (lvlOrder['warn'] ?? 1)) {
            if (!enableCodes.some((p) => toRegex(p).test(code))) return;
          }
        }
      } catch {}
      recordSessionLog({ level, message, timestamp, context, cat });
      // Overwrite outgoing payload timestamp and normalized category
      try {
        payload = { ...payload, timestamp, cat, code, cid, context };
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

export async function pushArbGraphSnapshot(snapshot: any): Promise<void> {
  try {
    const host = process.env.ARB_SERVICE_URL || 'http://127.0.0.1:4010';
    // eslint-disable-next-line no-undef
    await fetch(`${host}/arb/graph/snapshot`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ graph: snapshot }) });
  } catch {}
}

export async function pushArbGraphDiff(diff: any): Promise<void> {
  try {
    const host = process.env.ARB_SERVICE_URL || 'http://127.0.0.1:4010';
    // eslint-disable-next-line no-undef
    await fetch(`${host}/arb/graph/update`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(diff) });
  } catch {}
}


