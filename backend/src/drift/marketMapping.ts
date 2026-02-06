import { CONFIG } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import { safeLog, guardExec } from './safeLogger.js';
import type { DriftMarketRef } from './types.js';

const allowlistLogState: { lastAt: number; lastCount: number } = { lastAt: 0, lastCount: -1 };

// ---------------------------------------------------------------------------
// Dynamic SDK market cache
// ---------------------------------------------------------------------------
// Populated by registerSdkMarkets() once DriftClient discovers all markets.
// This gives indexToSymbol/symbolToIndex access to all 79+ markets instead of
// just the static allowlist + 3 hardcoded fallbacks.

const sdkByIndex: Map<number, string> = new Map();
const sdkByName: Map<string, number> = new Map();
let sdkCachePopulated = false;
let lazyLoadAttempted = false;

/**
 * Register the full set of SDK-discovered markets so that indexToSymbol and
 * symbolToIndex can resolve any market, not just allowlisted ones.
 * Safe to call multiple times; last call wins.
 */
export function registerSdkMarkets(markets: DriftMarketRef[]): void {
  try {
    if (!Array.isArray(markets) || markets.length === 0) return;
    sdkByIndex.clear();
    sdkByName.clear();
    for (const m of markets) {
      const idx = Number(m.marketIndex);
      const sym = m.symbol;
      if (!Number.isFinite(idx) || !sym) continue;
      sdkByIndex.set(idx, sym);
      sdkByName.set(sym.toUpperCase(), idx);
    }
    sdkCachePopulated = sdkByIndex.size > 0;
    logger.info('drift.markets.mapping_registered', { cat: 'drift', count: sdkByIndex.size });
  } catch (e: any) { safeLog.debug('drift.markets.register', { error: String(e?.message || e), cat: 'drift' }); }
}

/**
 * Lazy-load SDK market data from DriftClient.getPerpMarketAccounts() if the
 * cache hasn't been populated yet.  Runs at most once per process lifetime
 * and is synchronous-safe (uses try-catch on the sync SDK accessors).
 */
function ensureSdkCache(): void {
  if (sdkCachePopulated || lazyLoadAttempted) return;
  lazyLoadAttempted = true;
  try {
    // Dynamic import would be async; instead access the singleton directly.
    // DriftService is lazily imported to avoid circular dependency at module load.
    const { DriftService } = require('./client.js');
    const client: any = (DriftService?.getInstance?.() as any)?.client;
    if (!client) return;

    const decodeMarketName = (raw: any): string | undefined => {
      try {
        if (!raw) return undefined;
        if (typeof raw === 'string') return raw.replace(/\0+$/g, '').trim() || undefined;
        if (Array.isArray(raw)) return Buffer.from(raw).toString('utf8').replace(/\0+$/g, '').trim() || undefined;
        if (raw?.data && Array.isArray(raw.data)) return Buffer.from(Uint8Array.from(raw.data)).toString('utf8').replace(/\0+$/g, '').trim() || undefined;
      } catch {}
      return undefined;
    };

    // Try getPerpMarketAccounts() (sync getter on already-loaded data)
    let accounts: any[] | null = null;
    try {
      if (typeof client.getPerpMarketAccounts === 'function') accounts = client.getPerpMarketAccounts();
    } catch {}
    if (Array.isArray(accounts) && accounts.length > 0) {
      const markets: DriftMarketRef[] = [];
      for (const a of accounts) {
        const idx = Number(a?.marketIndex ?? a?.market_index ?? 0);
        const name = decodeMarketName(a?.name || a?.symbol || a?.marketName);
        if (Number.isFinite(idx) && name) markets.push({ marketIndex: idx, symbol: name });
      }
      if (markets.length > 0) {
        registerSdkMarkets(markets);
        return;
      }
    }
  } catch (e: any) { safeLog.debug('drift.markets.lazy_load', { error: String(e?.message || e), cat: 'drift' }); }
}

// ---------------------------------------------------------------------------
// Allowlist (static config)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Public resolvers — priority: SDK cache > allowlist > hardcoded fallback
// ---------------------------------------------------------------------------

export function indexToSymbol(idx: number): string | undefined {
  // 1. SDK cache (populated from DriftClient market accounts)
  ensureSdkCache();
  const fromSdk = sdkByIndex.get(Number(idx));
  if (fromSdk) return fromSdk;

  // 2. Static allowlist from config
  try {
    const list = parseAllowlistMarkets();
    const found = list.find(m => Number(m.marketIndex) === Number(idx));
    if (found?.symbol) return found.symbol;
  } catch (e: any) { safeLog.debug('drift.markets.index_to_symbol', { error: String(e?.message || e), cat: 'drift' }); }

  // 3. Hardcoded fallback for the most common markets
  const fallback: Record<number, string> = { 0: 'SOL-PERP', 1: 'BTC-PERP', 2: 'ETH-PERP' };
  return fallback[Number(idx)];
}

export function symbolToIndex(name: string): number | undefined {
  try {
    const target = String(name || '').trim();
    if (!target) return undefined;

    // 1. SDK cache
    ensureSdkCache();
    const fromSdk = sdkByName.get(target.toUpperCase());
    if (fromSdk !== undefined) return fromSdk;

    // 2. Static allowlist
    const list = parseAllowlistMarkets();
    for (const m of list) {
      if (m.symbol && m.symbol.toUpperCase() === target.toUpperCase()) return m.marketIndex;
    }

    // 3. Hardcoded fallback
    if (/^sol/i.test(target)) return 0;
    if (/^btc/i.test(target)) return 1;
    if (/^eth/i.test(target)) return 2;
  } catch (e: any) { safeLog.debug('drift.markets.symbol_to_index', { error: String(e?.message || e), cat: 'drift' }); }
  return undefined;
}
