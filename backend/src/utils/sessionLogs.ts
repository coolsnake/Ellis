import { promises as fsp } from 'fs';
import { resolve } from 'path';
import { CONFIG } from './config.js';

export type SessionLogEvent = {
  level: string;
  message: string;
  timestamp: string;
  context?: Record<string, unknown>;
  cat?: string;
};

// In-memory buffer of session events. Module-private; mutate via helpers below.
const _sessionEvents: SessionLogEvent[] = [];

// Test-only helper to seed/override session events without relying on CommonJS exports.
export function setSessionEventsForTest(events: SessionLogEvent[]): void {
  try {
    _sessionEvents.length = 0;
    if (Array.isArray(events)) _sessionEvents.push(...events);
  } catch {}
}
const MAX_EVENTS = Number((globalThis as any)?.process?.env?.SESSION_LOGS_MAX ?? 5000);

export function recordSessionLog(event: SessionLogEvent): void {
  try {
    _sessionEvents.push(event);
    // Bound memory: keep only the newest MAX_EVENTS
    if (_sessionEvents.length > MAX_EVENTS) {
      _sessionEvents.splice(0, _sessionEvents.length - MAX_EVENTS);
    }
  } catch {}
}

export async function writeSessionLogAndClear(): Promise<string | null> {
  try {
    if (_sessionEvents.length === 0) return null;
    const dir = CONFIG.logDir || resolve('backend', 'logs');
    await fsp.mkdir(dir, { recursive: true }).catch(() => {});
    const file = resolve(dir, 'session.json');
    // Limit to last 2000 events
    const items = _sessionEvents.slice(-2000);
    await fsp.writeFile(file, JSON.stringify(items, null, 2), 'utf-8');
    _sessionEvents.length = 0;
    return file;
  } catch {
    return null;
  }
}


export async function writeConsolidatedSessionLog(): Promise<string | null> {
  try {
    const dir = CONFIG.logDir || resolve('backend', 'logs');
    await fsp.mkdir(dir, { recursive: true }).catch(() => {});
    const out = (CONFIG as any)?.consolidated?.path || resolve(dir, 'consolidated-session.json');
    const max = Number((CONFIG as any)?.consolidated?.max || 2000);

    // Backend session events (prefer in-memory; if empty, fall back to last written session.json)
    let backend = _sessionEvents.slice(-max).map((e) => ({ ...e, source: 'backend' as const }));
    if (!backend.length) {
      try {
        const sessionFile = resolve(dir, 'session.json');
        const text = await fsp.readFile(sessionFile, 'utf-8').catch(() => null);
        if (text) {
          const arr = JSON.parse(text);
          if (Array.isArray(arr)) {
            backend = arr.slice(-max).map((e: any) => ({ ...(e || {}), source: 'backend' as const }));
          }
        }
      } catch {}
    }

    // Arb session: read if configured
    let arb: any[] = [];
    try {
      const arbPath = (CONFIG as any)?.consolidated?.arbSessionPath
        || (((CONFIG as any)?.consolidated?.arbLogDir) && resolve((CONFIG as any).consolidated.arbLogDir, 'session.json'))
        || null;
      if (arbPath) {
        const text = await fsp.readFile(arbPath, 'utf-8').catch(() => null);
        if (text) {
          const arr = JSON.parse(text);
          if (Array.isArray(arr)) {
            arb = arr.slice(-max).map((line: any) => ({
              source: 'arb', level: 'info', message: String(line), timestamp: null, cat: 'rust' as const,
            }));
          }
        }
      }
    } catch {}

    const merged = [...backend, ...arb];
    // Interleave tails to preserve both sources when present
    const cap = Math.max(1, max);
    const backTail = backend.slice(-cap);
    const arbTail = arb.slice(-cap);
    const outArr: any[] = [];
    let i = backTail.length - 1, j = arbTail.length - 1;
    while (outArr.length < cap && (i >= 0 || j >= 0)) {
      if (i >= 0) outArr.push(backTail[i--]);
      if (outArr.length < cap && j >= 0) outArr.push(arbTail[j--]);
    }
    const items = outArr.reverse();
    await fsp.writeFile(out, JSON.stringify(items, null, 2), 'utf-8');
    return out;
  } catch {
    return null;
  }
}

// Get recent session logs filtered by traceId (unified transaction trace ID)
// The traceId is generated at the start of each execution attempt and propagated through
// resolver -> builder -> sender for complete log correlation
export function getTxRelatedLogs(traceId: string | undefined, startTime?: number, endTime?: number, maxLogs: number = 200): SessionLogEvent[] {
  try {
    const relevant: SessionLogEvent[] = [];
    const txPatterns = [
      // Transaction lifecycle patterns
      /^tx\.(preflight|send|build|execute|resolve|intents|ixs|size|slippage|rpc|ix\.coerce|ix\.coerce\.skip|ix\.coerce\.err)/i,
      /tx\.(preflight|send|build|execute|resolve|intents|ixs|size|slippage|rpc)/i,
      // DEX-specific instruction builder patterns
      /^(raydium|orca|meteora)\.(clmm|amm|dlmm|whirlpool)\./i,
      /ix\.build\.(raydium|orca|meteora)/i,
      // SDK account verification patterns (explicitly match these)
      /\.sdk\.(account|accounts)\.(missing|verified|verify)/i,
      // Account verification patterns
      /\.(account|accounts|verification|verify|missing|exists)\./i,
      // Instruction details
      /\.(ix\.|instruction)/i,
      /\.(builder|build|swap)/i,
      // Arb executor patterns - capture opportunity acceptance and execution logs
      /^arb\.executor\.(accepted|attempt|simulated|success|failed|opportunity_check|opportunity_data|cycle_closed|balance_check|filtered|resolving_plan)/i,
      /arb\.executor\./i,
      // Jito patterns
      /arb\.jito\./i,
    ];
    
    // Exclusion patterns - filter out graph sync/push logs
    const excludePatterns = [
      /^arb\.push/i,           // Graph push operations
      /arb\.push\.ack/i,       // Graph push acknowledgments
      /arb\.sync/i,            // Graph sync operations
      /graph\.(push|sync|version|update)/i,  // Graph state updates
      /queue_depth/i,          // Queue depth logs
      /wantversion/i,          // Version synchronization
      /push_success|push_failed/i,  // Push operation status
      /kind.*diff/i,           // Graph diff operations
      /acked.*true/i,          // Acknowledgment logs
    ];
    
    // Iterate backwards through recent events (most recent first)
    // Events are stored chronologically, so we start from the end
    // Increase window to capture all logs from the entire execution lifecycle
    const eventsToCheck = Math.min(_sessionEvents.length, maxLogs * 10); // Check more to find all related logs
    const startIdx = Math.max(0, _sessionEvents.length - eventsToCheck);
    
    for (let i = _sessionEvents.length - 1; i >= startIdx; i--) {
      const event = _sessionEvents[i];
      if (!event) continue;
      
      const msg = String(event.message || '').toLowerCase();
      const ctx = event.context || {};
      const ctxStr = JSON.stringify(ctx).toLowerCase();
      
      // Skip if matches exclusion patterns (graph sync/push logs)
      const shouldExclude = excludePatterns.some(p => p.test(msg) || p.test(ctxStr));
      if (shouldExclude) continue;
      
      // PRIMARY CHECK: Direct traceId match in context (most reliable)
      // This captures all logs that were explicitly tagged with the traceId
      const hasDirectTraceId = traceId && (
        (ctx as any).traceId === traceId ||
        (ctx as any).txId === traceId ||
        ((ctx as any).ctx && ((ctx as any).ctx.traceId === traceId || (ctx as any).ctx.txId === traceId))
      );
      
      // SECONDARY CHECK: traceId substring in context or message
      const hasTraceIdSubstring = traceId && (
        ctxStr.includes(traceId.toLowerCase()) ||
        msg.includes(traceId.toLowerCase())
      );
      
      // FALLBACK CHECK: Pattern matching for tx.* category logs without traceId
      // Only used when we have a traceId to avoid pulling in unrelated logs
      const matchesPattern = traceId && txPatterns.some(p => p.test(msg) || p.test(ctxStr));
      
      // Check if cat is 'tx' or 'arb' (transaction/arbitrage category)
      // But only include arb logs that are executor-related, not graph sync
      const isTxCat = event.cat === 'tx' || (event.cat === 'arb' && /arb\.executor\.|arb\.jito\./i.test(msg));
      
      // Prioritize direct traceId matches, then substring matches, then pattern matches for tx category
      if (hasDirectTraceId || hasTraceIdSubstring || (matchesPattern && isTxCat)) {
        relevant.unshift(event); // Add to beginning to maintain chronological order
        if (relevant.length >= maxLogs) break;
      }
    }
    
    return relevant;
  } catch {
    return [];
  }
}


