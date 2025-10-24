import { logger } from '../utils/logger.js';
import { fetchDlobL2 } from './marketdata.js';
import { getDriftConfig } from '../utils/driftConfig.js';
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
  private scheduler: any | null = null;
  private nextPollAt: Map<number, number> = new Map();

  private constructor() {
    try {
      const enableWs = !!getDriftConfig().enableWsPrices;
      try { logger.info('drift.price.ws_enabled', { cat: 'drift', enabled: enableWs }); } catch {}
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
        this.ws.start().catch(() => {});
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
    const cfg = getDriftConfig();
    const enableWs = !!cfg.enableWsPrices;
    try { logger.info('drift.price.track_market', { cat: 'drift', marketIndex: idx, intervalMs, mode: (enableWs && this.ws) ? 'ws' : 'http' }); } catch {}
    if (enableWs && this.ws) {
      try { this.ws.subscribeMarket(idx); } catch {}
      // Staleness watchdog: if WS stalls, ensure HTTP fallback polling (unless wsOnlyPrices)
      const staleMs = Math.max(1000, Number(getDriftConfig().priceStaleMs || 3000));
      const watchdog = () => {
        try {
          const last = (this.ws as any)?.getLastUpdateTs?.(idx);
          if (!last || (Date.now() - last) > staleMs) {
            // Mark stale and ensure HTTP polling is active
            const current = this.prices.get(idx);
            if (current) this.prices.set(idx, { ...current, stale: true });
            const cfg2 = getDriftConfig();
            if (!cfg2.wsOnlyPrices) this.ensureHttpPolling(idx, intervalMs);
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
      // Also warmup via HTTP immediately until first WS arrives (unless wsOnlyPrices)
      if (!cfg.wsOnlyPrices) this.ensureHttpPolling(idx, intervalMs);
      return;
    }
    // Fallback: HTTP-only polling via single scheduler
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
      // Add timeout via AbortController (guarded for environments without it)
      const AC: any = (globalThis as any).AbortController;
      const ac = typeof AC === 'function' ? new AC() : undefined;
      const timeoutMs = Math.max(400, Math.min(2000, Number(getDriftConfig().httpTimeoutMs || 1200)));
      let to: any = null;
      if (ac) {
        try { to = (globalThis as any).setTimeout(() => { try { ac.abort(); } catch {} }, timeoutMs); } catch {}
      }
      const l2 = await fetchDlobL2(idx);
      if (to) { try { (globalThis as any).clearTimeout(to); } catch {} }
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
      // Single-scheduler will respect nextPollAt
      this.nextPollAt.set(idx, Date.now() + next);
      logger.warn('drift.price.refresh_failed', { marketIndex: idx, backoffMs: next, error: String(e?.message || e), cat: 'drift' });
    } finally {
      this.inFlight.delete(idx);
    }
  }

  private ensureHttpPolling(idx: number, intervalMs: number): void {
    // Record initial backoff and schedule; start global scheduler if not running
    if (!this.backoffMs.has(idx)) this.backoffMs.set(idx, Math.max(200, intervalMs));
    if (!this.nextPollAt.has(idx)) this.nextPollAt.set(idx, 0);
    if (!this.scheduler) this.startScheduler();
    // immediate warmup
    this.refresh(idx).catch(() => {});
  }

  private stopHttpPolling(idx: number): void {
    const t: any = this.timers.get(idx);
    if (t) { try { (globalThis as any).clearInterval(t); } catch {} }
    this.timers.delete(idx);
    this.nextPollAt.delete(idx);
    this.backoffMs.delete(idx);
  }

  onPrice(marketIndex: number, listener: (p: PriceSample) => void): void {
    const idx = Number(marketIndex);
    if (!this.priceListeners.has(idx)) this.priceListeners.set(idx, new Set());
    (this.priceListeners.get(idx) as Set<(p: PriceSample) => void>).add(listener);
  }

  offPrice(marketIndex: number, listener: (p: PriceSample) => void): void {
    const idx = Number(marketIndex);
    (this.priceListeners.get(idx) as Set<(p: PriceSample) => void>)?.delete(listener);
    // Auto-untrack when last listener removed and WS not tracking
    const set = this.priceListeners.get(idx);
    if (!set || set.size === 0) {
      try { this.untrackMarket(idx); } catch {}
    }
  }

  private notify(idx: number, sample: PriceSample): void {
    const ls = this.priceListeners.get(idx);
    if (!ls || ls.size === 0) return;
    for (const fn of Array.from(ls)) {
      try { fn(sample); } catch {}
    }
  }

  private startScheduler(): void {
    if (this.scheduler) return;
    const tick = async () => {
      try {
        const now = Date.now();
        for (const idx of Array.from(this.nextPollAt.keys())) {
          const due = (this.nextPollAt.get(idx) || 0) <= now;
          if (due && !this.inFlight.has(idx)) {
            this.nextPollAt.set(idx, now + (this.backoffMs.get(idx) || 500));
            this.refresh(idx).catch(() => {});
          }
        }
      } catch {}
    };
    this.scheduler = (globalThis as any).setInterval(tick, 150);
  }
}


