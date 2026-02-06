import { CONFIG } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import { safeLog, guardExec } from './safeLogger.js';
import type { DriftMarketRef } from './types.js';

const allowlistLogState: { lastAt: number; lastCount: number } = { lastAt: 0, lastCount: -1 };

function readAllowlist(): string[] {
  try {
    const raw: any = (CONFIG as any)?.drift?.marketsAllowlist || [];
    return Array.isArray(raw) ? raw : [];
  } catch (e: any) { safeLog.debug('drift.markets.read_allowlist', { error: String(e?.message || e), cat: 'drift' }); return []; }
}

export function parseAllowlistMarkets(): DriftMarketRef[] {
  try {
    const raw = readAllowlist();
    const out: DriftMarketRef[] = [];
    for (const entry of raw) {
      const s = String(entry || '').trim();
      if (!s) continue;
      let marketIndex: number | null = null;
      let symbol: string | undefined = undefined;
      if (/^\d+\s*[:=]\s*[^:]+$/.test(s)) {
        const parts = s.split(/[:=]/);
        marketIndex = Number(parts[0].trim());
        symbol = String(parts[1]).trim();
      } else if (/^\d+$/.test(s)) {
        marketIndex = Number(s);
        symbol = undefined;
      } else {
        symbol = s;
      }
      if (Number.isFinite(marketIndex as number)) out.push({ marketIndex: Number(marketIndex), symbol });
    }
    const seen = new Set<number>();
    const uniq = out.filter(m => {
      if (seen.has(m.marketIndex)) return false;
      seen.add(m.marketIndex);
      return true;
    }).sort((a, b) => a.marketIndex - b.marketIndex);
    try {
      const now = Date.now();
      const shouldLog = (now - allowlistLogState.lastAt) > 60_000 || allowlistLogState.lastCount !== uniq.length;
      if (shouldLog) {
        allowlistLogState.lastAt = now;
        allowlistLogState.lastCount = uniq.length;
        logger.info('drift.markets.allowlist_parsed', { cat: 'drift', count: uniq.length, rawCount: out.length, sample: uniq.slice(0, 8) });
      }
    } catch (e: any) { safeLog.debug('drift.markets.allowlist_log', { error: String(e?.message || e), cat: 'drift' }); }
    return uniq;
  } catch (e: any) { safeLog.debug('drift.markets.allowlist_parse', { error: String(e?.message || e), cat: 'drift' }); return []; }
}

export function getAllowlistIndices(): number[] {
  return parseAllowlistMarkets().map(m => m.marketIndex);
}

export function indexToSymbol(idx: number): string | undefined {
  try {
    const list = parseAllowlistMarkets();
    const found = list.find(m => Number(m.marketIndex) === Number(idx));
    if (found?.symbol) return found.symbol;
  } catch (e: any) { safeLog.debug('drift.markets.index_to_symbol', { error: String(e?.message || e), cat: 'drift' }); }
  const fallback: Record<number, string> = { 0: 'SOL-PERP', 1: 'BTC-PERP', 2: 'ETH-PERP' };
  return fallback[Number(idx)];
}

export function symbolToIndex(name: string): number | undefined {
  try {
    const target = String(name || '').trim();
    if (!target) return undefined;
    const list = parseAllowlistMarkets();
    for (const m of list) {
      if (m.symbol && m.symbol.toUpperCase() === target.toUpperCase()) return m.marketIndex;
    }
    // fallback common mapping
    if (/^sol/i.test(target)) return 0;
    if (/^btc/i.test(target)) return 1;
    if (/^eth/i.test(target)) return 2;
  } catch (e: any) { safeLog.debug('drift.markets.symbol_to_index', { error: String(e?.message || e), cat: 'drift' }); }
  return undefined;
}


