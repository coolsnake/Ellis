import { logger } from '../utils/logger.js';
import { fetchDlobL2 } from './marketdata.js';

type PriceSample = {
  marketIndex: number;
  oracle?: number;
  mid?: number;
  bid?: number;
  ask?: number;
  symbol?: string;
  updatedAt: number;
};

export class DriftPriceService {
  private static instance: DriftPriceService | null = null;
  private prices: Map<number, PriceSample> = new Map();
  private timers: Map<number, any> = new Map();
  private backoffMs: Map<number, number> = new Map();
  private inFlight: Set<number> = new Set();

  static getInstance(): DriftPriceService {
    if (!this.instance) this.instance = new DriftPriceService();
    return this.instance;
  }

  trackMarket(marketIndex: number, intervalMs = 500): void {
    const idx = Number(marketIndex);
    if (!Number.isFinite(idx)) return;
    if (this.timers.has(idx)) return;
    const poll = async () => {
      await this.refresh(idx);
    };
    const t: any = (globalThis as any).setInterval(poll, Math.max(200, intervalMs));
    this.timers.set(idx, t);
    // immediate warmup
    poll().catch(() => {});
  }

  untrackMarket(marketIndex: number): void {
    const idx = Number(marketIndex);
    const t: any = this.timers.get(idx);
    if (t) (globalThis as any).clearInterval(t);
    this.timers.delete(idx);
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
      const sample: PriceSample = { marketIndex: idx, oracle: l2.oracle, mid, bid, ask, symbol: l2.symbol, updatedAt: Date.now() };
      this.prices.set(idx, sample);
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
}


