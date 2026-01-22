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
    
    // Patterns that REQUIRE traceId correlation (general execution patterns)
    const traceIdRequiredPatterns = [
      // Transaction lifecycle patterns (specific execution phases only)
      /^tx\.(preflight|send|build|execute|resolve|intents|ixs|size|slippage|rpc|ix\.coerce)/i,
      // DEX-specific instruction builder patterns
      /^(raydium|orca|meteora|pumpswap)\.(clmm|amm|dlmm|whirlpool)\./i,
      /ix\.build\.(raydium|orca|meteora|pumpswap)/i,
      // SDK account verification patterns (explicitly match these)
      /\.sdk\.(account|accounts)\.(missing|verified|verify)/i,
      // Instruction details (specific to building)
      /\.(ix\.|instruction)\.(ready|built|build|coerce)/i,
      /\.swap\.(quote|built|ready)/i,
      // Arb executor patterns - ONLY execution-specific logs (not config/status)
      /^arb\.executor\.(accepted|attempt|simulated|success|failed|opportunity_data|cycle_closed|balance_check_passed|resolving_plan|sizing|flashloan|build)/i,
      // Jito execution patterns
      /^arb\.jito\.(bundle|tip|send)/i,
    ];
    
    // TIME-WINDOW ONLY patterns - captured based on timing alone (no traceId required)
    // These are router/ALT logs that don't have traceId in their context but are
    // highly relevant to transaction building and occur within the execution window
    const timeWindowOnlyPatterns = [
      // Router transaction builder patterns (onchain router - includes pool data, native mints, wasSwapped, etc.)
      /^routerTx\./i,
      // SDK Quote Builder patterns (cache hits/misses for SDK account resolution)
      /^sdkQuoteBuilder\./i,
      // ALT/Lookup table patterns (for transaction assembly)
      /^tx\.(lookup_table|alt)\./i,
      // Additional tx.build patterns for router mode and ALTs
      /^tx\.build\.(router|alts|timing|compute|detail|ok|err|hop|arb_cycle|amount_propagation|priority|accounts)/i,
    ];
    
    // EXCLUSION patterns - filter out non-execution logs
    const excludePatterns = [
      // Graph sync/push operations
      /^arb\.push/i,
      /arb\.push\.ack/i,
      /arb\.sync/i,
      /graph\.(push|sync|version|update)/i,
      /queue_depth/i,
      /wantversion/i,
      /push_success|push_failed/i,
      /kind.*diff/i,
      /acked.*true/i,
      // Config and status logs (NOT execution-specific)
      /arb\.executor\.config/i,           // Config changes
      /arb\.executor\.(starting|stopped|already_running)/i,  // Lifecycle status
      /arb\.executor\.status/i,           // Periodic status updates
      /arb\.executor\.ws\./i,             // WebSocket connection logs
      /arb\.executor\.batch_(received|skipped|rate_limited|processed)/i,  // Batch processing meta
      /arb\.executor\.opportunity_check/i,  // Pre-filter checks (not actual execution)
      /arb\.executor\.filtered/i,         // Filtered opportunities (not executed)
      /arb\.executor\.(tracker|notify|quarantine|api\.)/i,  // Infrastructure logs
      /arb\.executor\.jito_tip_feed/i,    // Tip feed status
      /arb\.executor\.wallet_cache/i,     // Wallet caching
    ];
    
    // Iterate backwards through recent events (most recent first)
    // Events are stored chronologically, so we start from the end
    const eventsToCheck = Math.min(_sessionEvents.length, maxLogs * 5);
    const startIdx = Math.max(0, _sessionEvents.length - eventsToCheck);
    
    for (let i = _sessionEvents.length - 1; i >= startIdx; i--) {
      const event = _sessionEvents[i];
      if (!event) continue;
      
      const msg = String(event.message || '');
      const ctx = event.context || {};
      const ctxStr = JSON.stringify(ctx);
      
      // FIRST: Check exclusion patterns (always skip these regardless of traceId)
      const shouldExclude = excludePatterns.some(p => p.test(msg) || p.test(ctxStr));
      if (shouldExclude) continue;
      
      // PRIMARY CHECK: Direct traceId match in context
      // This ensures logs explicitly tagged with this traceId are captured
      const hasDirectTraceId = traceId && (
        (ctx as any).traceId === traceId ||
        (ctx as any).txId === traceId ||
        ((ctx as any).ctx && ((ctx as any).ctx.traceId === traceId || (ctx as any).ctx.txId === traceId))
      );
      
      // SECONDARY CHECK: traceId substring in context (for logs that embed traceId)
      const hasTraceIdSubstring = traceId && (
        ctxStr.includes(traceId) ||
        msg.includes(traceId)
      );
      
      // Pattern checks
      const matchesTraceIdRequiredPattern = traceIdRequiredPatterns.some(p => p.test(msg));
      const matchesTimeWindowOnlyPattern = timeWindowOnlyPatterns.some(p => p.test(msg));
      
      // CAPTURE LOGIC:
      // 1. Direct traceId match - always capture (log was explicitly tagged)
      // 2. TraceId substring + any execution pattern - capture (indirect correlation)
      // 3. Time-window patterns (routerTx, tx.lookup_table, tx.build.*) - capture based on timing alone
      //    These logs don't have traceId but are highly relevant to transaction building
      const shouldCapture = 
        hasDirectTraceId ||
        (hasTraceIdSubstring && (matchesTraceIdRequiredPattern || matchesTimeWindowOnlyPattern)) ||
        matchesTimeWindowOnlyPattern;  // Capture router/ALT logs within time window
      
      if (shouldCapture) {
        relevant.unshift(event); // Add to beginning to maintain chronological order
        if (relevant.length >= maxLogs) break;
      }
    }
    
    return relevant;
  } catch {
    return [];
  }
}


