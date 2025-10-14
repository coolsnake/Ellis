import type { Server as SocketIOServer } from 'socket.io';
import { readJson } from '../utils/fs.js';
import { CONFIG } from '../utils/config.js';
import { fetchTokenPrices, fetchPricesByMints } from '../jupiter/jupiter.js';
import { logger } from '../utils/logger.js';
import { systemStatus } from './status.js';
import { setPrices } from './priceStore.js';
import { emit } from './realtime.js';

export class PriceFeed {
  private interval?: NodeJS.Timeout;
  private pollIntervalMs: number = 1000;
  private latest: Record<string, { usdc: number | null; sol: number | null }> = {};
  private cache: Map<string, { usdc: number | null; sol: number | null; ts: number }> = new Map();
  private cooldownUntil: number | null = null;
  private windowRequests = 0;
  private windowResetAt: number = Date.now() + 60000;
  private enabled = false;

  constructor(private readonly io: SocketIOServer) {}

  getLatest() {
    return this.latest;
  }

  start(pollMs = 1000) {
    if (this.interval) return;
    this.pollIntervalMs = pollMs;
    this.interval = setInterval(() => {
      if (this.enabled) this.poll().catch((e) => {
        const msg = String(e);
        if (msg.includes('429')) {
          try { emit('log', { level: 'warn', message: 'arb:429 source=jupiter kind=price', timestamp: new Date().toISOString(), context: { cat: 'arb' } }); } catch {}
        }
        logger.error('price poll failed', { error: String(e) });
      });
    }, pollMs);
    // immediate first poll
    if (this.enabled) this.poll().catch((e) => {
      const msg = String(e);
      if (msg.includes('429')) {
        try { emit('log', { level: 'warn', message: 'arb:429 source=jupiter kind=price', timestamp: new Date().toISOString(), context: { cat: 'arb' } }); } catch {}
      }
      logger.error('price poll failed', { error: String(e) });
    });
  }

  stop() {
    if (this.interval) clearInterval(this.interval);
    this.interval = undefined;
  }

  setPollInterval(ms: number) {
    const next = Math.max(200, Math.floor(ms || 0));
    this.pollIntervalMs = next;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = setInterval(() => {
        if (this.enabled) this.poll().catch((e) => logger.error('price poll failed', { error: String(e) }));
      }, next);
    }
  }

  // Public method to trigger an immediate poll once (best-effort)
  async pollNow(): Promise<void> {
    try {
      if (this.enabled) await this.poll();
    } catch (e: any) {
      logger.error('price immediate poll failed', { error: String(e) });
    }
  }

  private async poll() {
    if (!this.enabled) return;
    const watchlist = await readJson<any[]>(CONFIG.watchlistPath, []);
    if (watchlist.length === 0) return;
    const mints = (watchlist.map((t) => (typeof t === 'string' ? t : t?.id)).filter(Boolean) as string[]);

    // cooldown handling
    if (this.cooldownUntil && Date.now() < this.cooldownUntil) {
      systemStatus.rateLimitActive = true;
      systemStatus.cooldownUntilMs = this.cooldownUntil;
      // serve from cache if available
      const mapped: Record<string, { usdc: number | null; sol: number | null }> = {};
      for (const mint of mints) {
        const c = this.cache.get(mint);
        if (c) mapped[mint] = { usdc: c.usdc, sol: c.sol };
      }
      if (Object.keys(mapped).length > 0) {
        this.latest = mapped;
        setPrices(mapped);
        this.io.emit('prices-update', mapped);
      }
      return;
    }

    // enforce RPM 60 in 60s window (Lite API)
    const now = Date.now();
    if (now >= this.windowResetAt) {
      this.windowResetAt = now + 60000;
      this.windowRequests = 0;
      systemStatus.windowResetAtMs = this.windowResetAt;
    }
    systemStatus.requestsInWindow = this.windowRequests;

    // fetch only stale mints - use configurable TTL that respects target tick time and rate limits
    const configTtl = (CONFIG as any).system?.priceFeedTtlMs || 15000;
    const targetTickTime = (CONFIG as any).system?.targetTickTimeMs || 2000;
    const websocketInterval = CONFIG.websocketIntervalMs || 1000;

    // Smart TTL: use config value, but ensure it respects target tick time for responsiveness
    // while maintaining rate limit safety (minimum 1000ms between fetches)
    const priceFeedResponsive = (CONFIG as any).system?.priceFeedResponsive || false;
    const ttlMs = Math.max(configTtl, targetTickTime, websocketInterval);

    logger.debug(`price feed TTL calculated`, {
      cat: 'price',
      configTtl,
      targetTickTime,
      websocketInterval,
      priceFeedResponsive,
      finalTtl: ttlMs,
      toFetchCount: mints.length
    });

    const toFetch = mints.filter((mint) => {
      const c = this.cache.get(mint);
      if (!c) return true; // No cache, must fetch

      const age = now - c.ts;
      const isStale = age > ttlMs;

      // If responsive mode is enabled, also fetch if price is older than target tick time
      // but still respect minimum intervals to avoid API spam
      const shouldFetchForResponsiveness = priceFeedResponsive &&
        age > targetTickTime &&
        age > websocketInterval;

      return isStale || shouldFetchForResponsiveness;
    });
    if (toFetch.length > 0) {
      // Chunk requests to stay under RPM: each fetchPricesByMints call counts as 1 request
      const maxRequestsLeft = Math.max(0, 60 - this.windowRequests);
      if (maxRequestsLeft <= 0) {
        this.cooldownUntil = this.windowResetAt;
        systemStatus.rateLimitActive = true;
        systemStatus.cooldownUntilMs = this.cooldownUntil;
        return;
      }
      const chunkSize = toFetch.length; // price endpoint can take multiple ids at once
      const idsThisCall = toFetch.slice(0, chunkSize);
      try {
        const fresh = await fetchPricesByMints(idsThisCall);
        for (const [mint, val] of Object.entries(fresh)) {
          this.cache.set(mint, { ...val, ts: now });
        }
        this.windowRequests += 1;
        systemStatus.requestsInWindow = this.windowRequests;
        systemStatus.windowResetAtMs = this.windowResetAt;
      } catch (e: any) {
        const msg = String(e?.message || e);
        if (msg.includes('429')) {
          // back off for 60s
          this.cooldownUntil = Date.now() + 60000;
          systemStatus.rateLimitActive = true;
          systemStatus.cooldownUntilMs = this.cooldownUntil;
          systemStatus.last429AtMs = Date.now();
          try { emit('log', { level: 'warn', message: `arb:429 source=jupiter kind=price ids=${idsThisCall.length}`, timestamp: new Date().toISOString(), context: { cat: 'arb' } }); } catch {}
        }
        throw e;
      }
    }

    const mapped: Record<string, { usdc: number | null; sol: number | null }> = {};
    for (const mint of mints) {
      const c = this.cache.get(mint);
      if (c) mapped[mint] = { usdc: c.usdc, sol: c.sol };
    }
    this.latest = mapped;
    setPrices(mapped);
    this.io.emit('prices-update', mapped);
    systemStatus.lastPriceUpdateMs = Date.now();
    // also emit a system snapshot for UI to react to feed activity
    this.io.emit('system', { lastPriceUpdateMs: systemStatus.lastPriceUpdateMs });
    if (!this.cooldownUntil || Date.now() >= this.cooldownUntil) {
      systemStatus.rateLimitActive = false;
      systemStatus.cooldownUntilMs = null;
    }
  }

  setEnabled(val: boolean) {
    this.enabled = val;
  }

  getEnabled(): boolean {
    return this.enabled;
  }

  // Optional one-shot warmup for Jupiter universe prices
  async warmUniverseOnce(maxRequests: number = 3): Promise<{ total: number; priced: number; missing: number } | null> {
    try {
      const { bootstrapPricesForUniverse } = await import('./priceBootstrap.js');
      const cov = await bootstrapPricesForUniverse({ maxRequests, chunkSize: 100, cat: 'priceFeed.warm' });
      return cov;
    } catch {
      return null;
    }
  }
}

export function createPriceFeed(io: SocketIOServer) {
  return new PriceFeed(io);
}


