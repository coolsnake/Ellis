import { logger } from '../utils/logger.js';
import { fetchDlobL2 } from './marketdata.js';
import { CONFIG } from '../utils/config.js';
import { DriftDlobWs } from './priceWs.js';
import { emit } from '../server/realtime.js';

type PriceSample = {
  marketIndex: number;
  oracle?: number;
  mid?: number;
  bid?: number;
  ask?: number;
  symbol?: string;
  updatedAt: number;
  source?: 'ws' | 'http';
  stale?: boolean;
};

export class DriftPriceService {
  private static instance: DriftPriceService | null = null;
  private prices: Map<number, PriceSample> = new Map();
  private timers: Map<number, any> = new Map();
  private backoffMs: Map<number, number> = new Map();
  private inFlight: Set<number> = new Set();
  private ws: DriftDlobWs | null = null;
  private priceListeners: Map<number, Set<(p: PriceSample) => void>> = new Map();
  private staleTimers: Map<number, any> = new Map();

  private constructor() {
    try {
      const enableWs = !!((CONFIG as any)?.drift?.enableWsPrices);
      if (enableWs) {
        this.ws = new DriftDlobWs();
        this.ws.on('l2', (u: any) => {
          try {
            const idx = Number(u?.marketIndex);
            if (!Number.isFinite(idx)) return;
            const sample: PriceSample = {
              marketIndex: idx,
              oracle: (typeof u?.oracle === 'number') ? u.oracle : undefined,
              mid: (typeof u?.mid === 'number') ? u.mid : undefined,
              bid: (typeof u?.bid === 'number') ? u.bid : undefined,
              ask: (typeof u?.ask === 'number') ? u.ask : undefined,
              symbol: u?.symbol,
              updatedAt: Date.now(),
              source: 'ws',
              stale: false,
            };
            this.prices.set(idx, sample);
            // Stop HTTP polling while WS is healthy
            this.stopHttpPolling(idx);
            this.notify(idx, sample);
            // Optional broadcast to UI
            try { emit('drift-price', { marketIndex: idx, mid: sample.mid, bid: sample.bid, ask: sample.ask, oracle: sample.oracle, symbol: sample.symbol, source: 'ws' }); } catch {}
          } catch {}
        });
        this.ws.start();
      }
    } catch {}
  }

  static getInstance(): DriftPriceService {
    if (!this.instance) this.instance = new DriftPriceService();
    return this.instance;
  }

  trackMarket(marketIndex: number, intervalMs = 500): void {
    const idx = Number(marketIndex);
    if (!Number.isFinite(idx)) return;
    // Prefer WS when enabled
    const enableWs = !!((CONFIG as any)?.drift?.enableWsPrices);
    if (enableWs && this.ws) {
      try { this.ws.subscribeMarket(idx); } catch {}
      // Staleness watchdog: if WS stalls, ensure HTTP fallback polling
      const staleMs = Math.max(1000, Number(((CONFIG as any)?.drift?.priceStaleMs) || 3000));
      const watchdog = () => {
        try {
          const last = (this.ws as any)?.getLastUpdateTs?.(idx);
          if (!last || (Date.now() - last) > staleMs) {
            // Mark stale and ensure HTTP polling is active
            const current = this.prices.get(idx);
            if (current) this.prices.set(idx, { ...current, stale: true });
            this.ensureHttpPolling(idx, intervalMs);
          } else {
            // WS is fresh; stop HTTP polling if any
            this.stopHttpPolling(idx);
          }
        } catch {}
      };
      // Set or reset stale timer
      const prev = this.staleTimers.get(idx);
      if (prev) { try { (globalThis as any).clearInterval(prev); } catch {} }
      const st: any = (globalThis as any).setInterval(watchdog, Math.max(500, Math.min(staleMs, 2000)));
      this.staleTimers.set(idx, st);
      // Also warmup via HTTP immediately until first WS arrives
      this.ensureHttpPolling(idx, intervalMs);
      return;
    }
    // Fallback: HTTP-only polling
    this.ensureHttpPolling(idx, intervalMs);
  }

  untrackMarket(marketIndex: number): void {
    const idx = Number(marketIndex);
    const t: any = this.timers.get(idx);
    if (t) (globalThis as any).clearInterval(t);
    this.timers.delete(idx);
    const st: any = this.staleTimers.get(idx);
    if (st) { try { (globalThis as any).clearInterval(st); } catch {} }
    this.staleTimers.delete(idx);
    try { this.ws?.unsubscribeMarket(idx); } catch {}
  }

  getPrice(marketIndex: number): PriceSample | undefined {
    return this.prices.get(Number(marketIndex));
  }

  private async refresh(marketIndex: number): Promise<void> {
    const idx = Number(marketIndex);
    if (this.inFlight.has(idx)) return; // de-dupe
    this.inFlight.add(idx);
    const start = Date.now();
    try {
      const l2 = await fetchDlobL2(idx);
      if (!l2) throw new Error('no l2');
      const bid = l2.bid?.[0]?.price;
      const ask = l2.ask?.[0]?.price;
      const mid = (typeof bid === 'number' && typeof ask === 'number') ? (bid + ask) / 2 : undefined;
      const sample: PriceSample = { marketIndex: idx, oracle: l2.oracle, mid, bid, ask, symbol: l2.symbol, updatedAt: Date.now(), source: 'http', stale: false };
      this.prices.set(idx, sample);
      this.notify(idx, sample);
      try { emit('drift-price', { marketIndex: idx, mid: sample.mid, bid: sample.bid, ask: sample.ask, oracle: sample.oracle, symbol: sample.symbol, source: 'http' }); } catch {}
      this.backoffMs.delete(idx);
      if (Date.now() - start > 1000) {
        logger.warn('drift.price.poll_slow', { marketIndex: idx, ms: Date.now() - start, cat: 'drift' });
      }
    } catch (e: any) {
      // exponential backoff per market
      const cur = this.backoffMs.get(idx) || 500;
      const next = Math.min(cur * 2, 8000);
      this.backoffMs.set(idx, next);
      const t: any = this.timers.get(idx);
      if (t) { try { (globalThis as any).clearInterval(t); } catch {} }
      const nt: any = (globalThis as any).setInterval(() => { this.refresh(idx).catch(() => {}); }, next);
      this.timers.set(idx, nt);
      logger.warn('drift.price.refresh_failed', { marketIndex: idx, backoffMs: next, error: String(e?.message || e), cat: 'drift' });
    } finally {
      this.inFlight.delete(idx);
    }
  }

  private ensureHttpPolling(idx: number, intervalMs: number): void {
    if (this.timers.has(idx)) return;
    const poll = async () => { await this.refresh(idx); };
    const t: any = (globalThis as any).setInterval(poll, Math.max(200, intervalMs));
    this.timers.set(idx, t);
    // immediate warmup
    poll().catch(() => {});
  }

  private stopHttpPolling(idx: number): void {
    const t: any = this.timers.get(idx);
    if (t) { try { (globalThis as any).clearInterval(t); } catch {} }
    this.timers.delete(idx);
  }

  onPrice(marketIndex: number, listener: (p: PriceSample) => void): void {
    const idx = Number(marketIndex);
    if (!this.priceListeners.has(idx)) this.priceListeners.set(idx, new Set());
    (this.priceListeners.get(idx) as Set<(p: PriceSample) => void>).add(listener);
  }

  offPrice(marketIndex: number, listener: (p: PriceSample) => void): void {
    const idx = Number(marketIndex);
    (this.priceListeners.get(idx) as Set<(p: PriceSample) => void>)?.delete(listener);
  }

  private notify(idx: number, sample: PriceSample): void {
    const ls = this.priceListeners.get(idx);
    if (!ls || ls.size === 0) return;
    for (const fn of Array.from(ls)) {
      try { fn(sample); } catch {}
    }
  }
}


