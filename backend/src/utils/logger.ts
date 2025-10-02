import { EventEmitter } from 'events';
import { promises as fsp } from 'fs';
import { resolve } from 'path';
import { CONFIG } from './config.js';

export type LogEvent = {
  level: 'info' | 'error' | 'warn' | 'debug';
  message: string;
  context?: Record<string, unknown>;
  timestamp: string;
  cat?: string;
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

  private shouldLog(level: LogEvent['level']): boolean {
    return this.enabled && this.order[level] <= this.order[this.level];
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

  private isCategoryAllowed(cat: string | undefined): boolean {
    try {
      const enabled = (CONFIG as any)?.system?.enabledLogCategories as string[] | undefined;
      if (Array.isArray(enabled)) {
        const name = String(cat || 'other').toLowerCase();
        return enabled.includes(name);
      }
    } catch {}
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

  log(level: LogEvent['level'], message: string, context?: Record<string, unknown>): void {
    if (!this.shouldLog(level)) return;
    const cat = this.deriveCategory(message, context);
    if (!this.isCategoryAllowed(cat)) return;
    const event: LogEvent = {
      level,
      message,
      context,
      // Use short local time; backend websocket will also enforce
      timestamp: new Date().toLocaleTimeString(),
      cat,
    };
    this.emit('log', event);
    const prefix = level.toUpperCase();
    // eslint-disable-next-line no-console
    console.log(`[${prefix}]`, event.timestamp, `[${cat}]`, message, context ? JSON.stringify(context) : '');
    if (this.logToFile) {
      try {
        const payload = JSON.stringify({ ts: event.timestamp, level, cat, message, context: context || {} });
        this.writeFileLine(payload);
      } catch {}
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


