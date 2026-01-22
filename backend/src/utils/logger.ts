import { EventEmitter } from 'events';
import { promises as fsp } from 'fs';
import { resolve } from 'path';
import { CONFIG } from './config.js';

export type LogSpan = 'start' | 'end' | undefined;

export type LogEvent = {
  level: 'info' | 'error' | 'warn' | 'debug';
  message: string;
  context?: Record<string, unknown>;
  timestamp: string;
  cat?: string;
  subcat?: string;
  code?: string;
  cid?: string;
  span?: LogSpan;
};

class RealtimeLogger extends EventEmitter {
  private level: LogEvent['level'] = (process.env.LOG_LEVEL as any) || 'info';
  private enabled = process.env.ENABLE_LOGGING !== 'false';
  private logToFile = process.env.LOG_TO_FILE === 'true';
  private filePath = process.env.LOG_FILE_PATH || resolve(CONFIG.logDir, 'app.jsonl');
  private writing = false;
  private fileQueue: string[] = [];

  private order: Record<LogEvent['level'], number> = { error: 0, warn: 1, info: 2, debug: 3 } as const;

  setLevel(next: LogEvent['level']) {
    if (next === 'error' || next === 'warn' || next === 'info' || next === 'debug') {
      this.level = next;
      this.emit('level', next);
    }
  }

  getLevel(): LogEvent['level'] { return this.level; }
  setEnabled(val: boolean) { this.enabled = !!val; }
  setFileLogging(toFile: boolean, path?: string) {
    this.logToFile = !!toFile;
    if (path) this.filePath = path;
  }

  private shouldLog(level: LogEvent['level'], cat?: string, code?: string): boolean {
    if (!this.enabled) return false;
    // Global level gate
    if (this.order[level] > this.order[this.level]) return false;
    try {
      // Optional structured logging config
      const logCfg = (CONFIG as any)?.system?.log as any | undefined;
      if (!logCfg) return true;
      const lvlOrder = this.order;
      const name = String(cat || 'other').toLowerCase();
      // Per-category minimum level
      const catLevels = (logCfg.categories || {}) as Record<string, string>;
      const keys = Object.keys(catLevels);
      // Support nested cat.subcat overrides by longest match
      let minLevel: LogEvent['level'] | undefined;
      if (keys.length) {
        let bestLen = -1;
        for (const k of keys) {
          const kl = String(k).toLowerCase();
          if (name === kl || name.startsWith(kl + '.')) {
            if (kl.length > bestLen) { bestLen = kl.length; minLevel = (String(catLevels[k]).toLowerCase() as any); }
          }
        }
      }
      if (minLevel && lvlOrder[level] > (lvlOrder[minLevel] ?? lvlOrder.info)) return false;
      // Code enable/disable patterns
      const enableCodes: string[] = Array.isArray(logCfg.enableCodes) ? logCfg.enableCodes : [];
      const disableCodes: string[] = Array.isArray(logCfg.disableCodes) ? logCfg.disableCodes : [];
      if (code && disableCodes.length && this.matchesAny(code, disableCodes)) return false;
      if (enableCodes.length && code) {
        // When enableCodes configured, only allow events that match these (unless level>=warn)
        if (lvlOrder[level] > lvlOrder.warn && !this.matchesAny(code, enableCodes)) return false;
      }
      // Sampling
      const sample: Record<string, number> = (logCfg.sample || {}) as any;
      if (code && typeof sample[code] === 'number') {
        const p = Number(sample[code]);
        if (Number.isFinite(p) && p >= 0 && p < 1) { if (Math.random() > p) return false; }
      }
      // Rate limit (simple per-code interval)
      const rate = (logCfg.rateLimit || {}) as Record<string, { perSec?: number; minIntervalMs?: number }>;
      if (code && (rate[code]?.perSec || rate[code]?.minIntervalMs)) {
        const now = Date.now();
        const minMs = rate[code]?.minIntervalMs ?? (rate[code]?.perSec ? 1000 / Math.max(1, Number(rate[code]?.perSec)) : 0);
        if (minMs > 0) {
          const last = this.lastByCode.get(code) || 0;
          if ((now - last) < minMs) return false;
          this.lastByCode.set(code, now);
        }
      }
      return true;
    } catch {
      return true;
    }
  }

  private lastByCode: Map<string, number> = new Map();

  private matchesAny(code: string, patterns: string[]): boolean {
    const needle = String(code).toUpperCase();
    for (const p of patterns) {
      const pat = String(p || '').toUpperCase().replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
      try { if (new RegExp('^' + pat + '$').test(needle)) return true; } catch {}
    }
    return false;
  }

  private deriveCodeFromMessage(message: string): string | undefined {
    try {
      const m = String(message || '').toLowerCase();
      if (/^api\.request\b/.test(m)) return 'API.REQUEST';
      if (/^api\.response\b/.test(m)) return 'API.RESPONSE';
      if (/^pretrade:arb simulate start\b/.test(m)) return 'PRETRADE.SIM.START';
      if (/^pretrade:arb simulate result\b/.test(m)) return 'PRETRADE.SIM.END';
      if (/^pretrade:arb execute start\b/.test(m)) return 'PRETRADE.EXEC.START';
      if (/^pretrade:arb tx built\b/.test(m)) return 'PRETRADE.TX.BUILT';
      if (/^pretrade:arb (send|simulate) logs\b/.test(m)) return 'PRETRADE.LOGS';
      if (/^graph:push diff\b/.test(m)) return 'GRAPH.PUSH.DIFF';
      if (/^graph:push snapshot\b/.test(m)) return 'GRAPH.PUSH.SNAPSHOT';
      if (/^arb:push snapshot\b/.test(m)) return 'ARB.PUSH.SNAPSHOT';
      if (/^pools:subscribe ok\b/.test(m)) return 'POOLS.SUBSCRIBE.OK';
      if (/^pools:unsubscribe ok\b/.test(m)) return 'POOLS.UNSUBSCRIBE.OK';
      // Drift/ws/jup/strategy generic mapping: take leading token and normalize
      const first = m.split(/\s+/)[0] || '';
      if (first) {
        // Normalize separators ':' '::' ' - ' etc into dots, strip trailing punctuation
        const norm = first.replace(/:+/g, '.').replace(/[^a-z0-9.]+/g, '_');
        if (/[a-z0-9]/.test(norm)) return norm.toUpperCase();
      }
    } catch {}
    return undefined;
  }

  private deriveCategory(message: string, context?: Record<string, unknown>): string {
    const ctxCat = (context as any)?.cat as string | undefined;
    if (ctxCat && typeof ctxCat === 'string') return ctxCat.toLowerCase();
    const msg = String(message || '');
    if (/^api[.:]\b|^api\b/i.test(msg)) return 'api';
    if (/^(jup|jupiter)[.:]\b|^(jup|jupiter)\b/i.test(msg)) return 'jupiter';
    if (/^raydium[.:]\b|^raydium\b/i.test(msg)) return 'raydium';
    if (/^orca[.:]\b|^orca\b/i.test(msg)) return 'orca';
    if (/^arb[.:]\b|\barb\b/i.test(msg)) return 'arb';
    if (/^drift[.:]\b|^drift\b/i.test(msg)) return 'drift';
    if (/^strategy[.:]\b|^strategy\b/i.test(msg)) return 'strategy';
    if (/^pretrade[.:]\b|^pretrade\b/i.test(msg)) return 'pretrade';
    if (/^trade[.:]\b|^trade\b/i.test(msg)) return 'trade';
    if (/^terminal[.:]\b|^terminal\b/i.test(msg)) return 'terminal';
    if (/^graph[.:]\b|^graph\b/i.test(msg)) return 'graph';
    if (/^pools?[.:]\b|^pools?\b/i.test(msg)) return 'pools';
    if (/^price[.:]\b|^price\b/i.test(msg)) return 'price';
    if (/^wallet[.:]\b|^wallet\b/i.test(msg)) return 'wallet';
    if (/^server[.:]\b|^server\b/i.test(msg)) return 'server';
    if (/wallet|watchlist|token account|token search/i.test(msg)) return 'wallet';
    if (/graph/i.test(msg)) return 'graph';
    if (/pools?/i.test(msg)) return 'pools';
    if (/price/i.test(msg)) return 'price';
    if (/swap|trade/i.test(msg)) return 'trade';
    if (/drift|dlob|perp|subaccount|funding/i.test(msg)) return 'drift';
    if (/grid|strategy/i.test(msg)) return 'strategy';
    if (/server|backend|routes registered|listening on/i.test(msg)) return 'server';
    return 'other';
  }

  private isCategoryAllowed(_cat: string | undefined): boolean {
    // Do not drop any logs at source based on categories; frontend controls visibility
    return true;
  }

  private async writeFileLine(line: string) {
    try {
      this.fileQueue.push(line);
      if (this.writing) return;
      this.writing = true;
      while (this.fileQueue.length) {
        const item = this.fileQueue.shift() as string;
        try {
          await fsp.mkdir(resolve(this.filePath, '..'), { recursive: true }).catch(() => {});
          await fsp.appendFile(this.filePath, item + '\n');
        } catch {
          // ignore file sink errors to avoid feedback loops
        }
      }
    } finally {
      this.writing = false;
    }
  }

  // Patterns for logs that should ALWAYS be recorded to session (for tx dump completeness)
  // regardless of log level visibility settings. Console output still respects settings.
  private alwaysRecordPatterns = [
    /^routerTx\./i,                    // Router transaction builder (pool data, accounts, native mints, wasSwapped, etc.)
    /^tx\.(lookup_table|alt|build|preflight|send|resolve|sim)/i,  // ALT, build, and tx lifecycle logs
    /^arb\.executor\./i,               // Arb executor logs
    /^arb\.jito\./i,                   // Jito execution logs
    /^(raydium|orca|meteora|pumpswap)\./i,  // DEX-specific instruction builder logs
    /^ix\.build\./i,                   // Instruction building logs
    /^resolver\./i,                    // Resolver logs (plan resolution)
    /^sdkQuote(Builder)?\./i,          // SDK quote builder logs (cache hits/misses)
  ];

  private shouldAlwaysRecord(message: string): boolean {
    return this.alwaysRecordPatterns.some(p => p.test(message));
  }

  log(level: LogEvent['level'], message: string, context?: Record<string, unknown>): void {
    const ctx = context || undefined;
    // Promote structured fields from context if provided
    const catFromCtx = (ctx as any)?.cat as string | undefined;
    const subcat = (ctx as any)?.subcat as string | undefined;
    const code = (ctx as any)?.code as string | undefined;
    const cid = (ctx as any)?.cid as string | undefined;
    const span = (ctx as any)?.span as LogSpan | undefined;
    const cat = (catFromCtx && typeof catFromCtx === 'string') ? catFromCtx.toLowerCase() : this.deriveCategory(message, ctx);
    if (!this.isCategoryAllowed(cat)) return;
    
    const derivedCode = code || this.deriveCodeFromMessage(message);
    const event: LogEvent = {
      level,
      message,
      context: ctx,
      // Use short local time; backend websocket will also enforce
      timestamp: new Date().toLocaleTimeString(),
      cat,
      subcat,
      code: derivedCode,
      cid,
      span,
    };
    
    // Check if this log should bypass visibility settings for session recording
    // This ensures tx dumps capture ALL relevant logs even if console is filtered
    const alwaysRecord = this.shouldAlwaysRecord(message);
    const passesFilter = this.shouldLog(level, cat, code);
    
    // Always emit for session recording if it matches alwaysRecord patterns
    // This allows tx dump files to be complete regardless of console visibility
    if (alwaysRecord || passesFilter) {
      this.emit('log', event);
    }
    
    // Console output and file logging still respect visibility settings
    if (passesFilter) {
      const prefix = level.toUpperCase();
      // eslint-disable-next-line no-console
      console.log(`[${prefix}]`, event.timestamp, `[${cat}${subcat?'.'+subcat:''}]`, code ? code + ':' : '', message, ctx ? JSON.stringify(ctx) : '');
      if (this.logToFile) {
        try {
          const payload = JSON.stringify({ ts: event.timestamp, level, cat, subcat, code, cid, span, message, context: ctx || {} });
          this.writeFileLine(payload);
        } catch {}
      }
    }
  }

  info(message: string, context?: Record<string, unknown>): void {
    this.log('info', message, context);
  }

  warn(message: string, context?: Record<string, unknown>): void {
    this.log('warn', message, context);
  }

  error(message: string, context?: Record<string, unknown>): void {
    this.log('error', message, context);
  }

  debug(message: string, context?: Record<string, unknown>): void {
    this.log('debug', message, context);
  }
}

export const logger = new RealtimeLogger();
export const setLogLevel = (level: LogEvent['level']) => logger.setLevel(level);
export const setLoggingEnabled = (val: boolean) => logger.setEnabled(val);
export const setFileLogging = (toFile: boolean, path?: string) => logger.setFileLogging(toFile, path);

export type StructuredLogArgs = {
  level: LogEvent['level'];
  cat: string;
  subcat?: string;
  code?: string;
  cid?: string;
  span?: LogSpan;
  message: string;
  ctx?: Record<string, unknown>;
};

export function logStructured(args: StructuredLogArgs): void {
  const { level, cat, subcat, code, cid, span, message, ctx } = args;
  const context = { ...(ctx || {}), cat, ...(subcat ? { subcat } : {}), ...(code ? { code } : {}), ...(cid ? { cid } : {}), ...(span ? { span } : {}) } as Record<string, unknown>;
  logger.log(level, message, context);
}


