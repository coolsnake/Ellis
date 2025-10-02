import { logger } from '../utils/logger.js';
import type { LeveragedGridConfig, GridRuntimeState } from './types.js';
import { DriftService } from './client.js';
import { canPlaceOrders } from './risk.js';
import { fetchDlobL2 } from './marketdata.js';
import { emit } from '../server/realtime.js';
import { DriftPriceService } from './price.js';
import { generatePriceLadder, DriftOrderEngine } from './orders.js';
import { CONFIG } from '../utils/config.js';

export class DriftGridRunner {
  private timer: any | null = null;
  private state: GridRuntimeState = { running: false, openOrders: 0, netExposure: 0, effectiveLeverage: 0, liquidationBuffer: Infinity };
  private tickScheduledAt: number = 0;
  private lastTickAt: number = 0;

  constructor(private config: LeveragedGridConfig) {}

  getStatus(): GridRuntimeState {
    return { ...this.state, config: this.config };
  }

  async start(pollMs = 1500): Promise<void> {
    if (this.timer) return;
    this.state.running = true;
    logger.info('drift.grid.start', { name: this.config.name, marketIndex: this.config.market.marketIndex, subaccountId: this.config.subaccountId, levels: this.config.levels, notionalPerLevel: this.config.notionalPerLevel, cat: 'drift' });
    // Subscribe shared price service for this market
    try {
      const svc = DriftPriceService.getInstance();
      svc.trackMarket(this.config.market.marketIndex, 400);
      // Debounced event-driven tick on price updates
      const debounceMs = Math.max(250, Math.min(600, Number(((CONFIG as any)?.websocketIntervalMs) || 400)));
      const onPrice = (_p: any) => {
        const now = Date.now();
        if ((now - this.lastTickAt) < debounceMs) {
          // schedule one-shot if not already scheduled
          if (!this.tickScheduledAt) {
            this.tickScheduledAt = now;
            (globalThis as any).setTimeout(() => {
              this.tickScheduledAt = 0;
              this.tick().catch(() => {});
            }, debounceMs - (now - this.lastTickAt));
          }
          return;
        }
        this.tick().catch(() => {});
      };
      (this as any)._onPrice = onPrice;
      svc.onPrice(this.config.market.marketIndex, onPrice);
    } catch {}
    // Initialize order engine once
    try {
      const drift = DriftService.getInstance();
      await drift.init();
      const engine = new DriftOrderEngine((drift as any)?.client);
      (this as any)._engine = engine;
    } catch {}
    this.timer = (globalThis as any).setInterval(() => {
      this.tick().catch((e) => logger.error('drift.grid.tick_error', { error: String(e), cat: 'drift' }));
    }, Math.max(500, pollMs));
  }

  stop(): void {
    if (this.timer) (globalThis as any).clearInterval(this.timer);
    this.timer = null;
    this.state.running = false;
    logger.info('drift.grid.stop', { name: this.config.name, marketIndex: this.config.market.marketIndex, subaccountId: this.config.subaccountId, cat: 'drift' });
    try {
      const svc = DriftPriceService.getInstance();
      if ((this as any)._onPrice) svc.offPrice(this.config.market.marketIndex, (this as any)._onPrice);
    } catch {}
  }

  async tick(): Promise<void> {
    try {
      this.lastTickAt = Date.now();
      const drift = DriftService.getInstance();
      await drift.init();
      const subs = await drift.getSubaccounts();
      const sub = subs.find(s => s.id === this.config.subaccountId) || subs[0];
      if (!sub) {
        logger.warn('drift.grid.no_subaccount', { requested: this.config.subaccountId, cat: 'drift' });
        return;
      }

      // For scaffold: compute proposed notional as sum of per-level notionals
      const perSide = Math.max(0, Number(this.config.levels || 0));
      const proposedNotional = perSide * (this.config.notionalPerLevel || 0);
      const gate = canPlaceOrders(this.config, sub, proposedNotional);
      if (!gate.ok) {
        logger.warn('drift.grid.risk_gate_block', { reason: gate.reason, proposedNotional, freeCollateral: sub.freeCollateral, cat: 'drift' });
        return;
      }
      // Funding guard (best-effort): drop placement if funding exceeds threshold
      if (this.config.fundingGuard) {
        try {
          const { DriftService } = await import('./client.js');
          const svc = DriftService.getInstance();
          const fr = await svc.getFundingRate(this.config.market.marketIndex);
          if (fr && typeof fr.lastFundingRate === 'number') {
            const apy = fr.lastFundingRate * 365 * 24; // hourly to annualized approximation
            const maxApy = Number(((await import('../utils/config.js')) as any).CONFIG?.drift?.maxFundingApy || 0);
            if (maxApy > 0 && Math.abs(apy) > maxApy) {
              logger.warn('drift.grid.funding_guard_block', { apy, maxApy, marketIndex: this.config.market.marketIndex, cat: 'drift' });
              return;
            }
          }
        } catch {}
      }
      // Placeholder: no real orders yet; update state snapshot
      this.state.openOrders = perSide * 2;
      this.state.effectiveLeverage = 0; // unknown until positions; keep zero for scaffold
      this.state.liquidationBuffer = Infinity; // unknown; will come from subaccount when wired

      // Fetch L2 for price context
      const shared = DriftPriceService.getInstance().getPrice(this.config.market.marketIndex);
      const l2 = shared || (await fetchDlobL2(this.config.market.marketIndex));
      const mid = l2 && (l2 as any).bid && (l2 as any).ask && (l2 as any).bid[0] && (l2 as any).ask[0] ? ((l2 as any).bid[0].price + (l2 as any).ask[0].price) / 2 : (shared?.mid);
      const oracle = (typeof (l2 as any)?.oracle === 'number' && isFinite((l2 as any).oracle)) ? (l2 as any).oracle : (shared?.oracle);
      if (typeof mid === 'number' && isFinite(mid)) {
        // Ladder generation (anchor on oracle if present, else mid)
        const anchor = (typeof oracle === 'number' ? oracle : mid);
        const ladder = generatePriceLadder(this.config, anchor);
        // Order refresh lifecycle (maker-only optional)
        try {
          const engine: DriftOrderEngine | undefined = (this as any)._engine;
          if (engine) {
            await engine.refreshLadder(this.config.market.marketIndex, ladder, !!this.config.makerOnly, anchor, Number(this.config.stepPct || 0.01));
          }
        } catch {}
        // Fetch PnL metrics (best-effort)
        let unrealizedPnl: number | undefined = undefined;
        let unrealizedFunding: number | undefined = undefined;
        try {
          const pnl = await DriftService.getInstance().getUnrealizedPerpPnl(this.config.market.marketIndex);
          if (typeof pnl === 'number') unrealizedPnl = pnl;
        } catch {}
        try {
          const f = await DriftService.getInstance().getUnrealizedFundingPnl(this.config.market.marketIndex);
          if (typeof f === 'number') unrealizedFunding = f;
        } catch {}
        // Estimate fees and funding
        let fundingApy: number | undefined = undefined;
        try {
          const fr = await DriftService.getInstance().getFundingRate(this.config.market.marketIndex);
          if (fr && typeof fr.lastFundingRate === 'number') fundingApy = fr.lastFundingRate * 365 * 24;
        } catch {}
        const feeMakerBps = Number((CONFIG as any)?.drift?.feeMakerBps || 0);
        const feeTakerBps = Number((CONFIG as any)?.drift?.feeTakerBps || 5);
        const feeBps = this.config.makerOnly ? feeMakerBps : feeTakerBps;
        const perSide = Math.max(0, Number(this.config.levels || 0));
        const proposedNotional = perSide * (this.config.notionalPerLevel || 0);
        const feeEstRoundTrip = (feeBps / 10000) * proposedNotional * 2;
        const netApprox = (typeof unrealizedPnl === 'number' ? unrealizedPnl : 0) - (typeof unrealizedFunding === 'number' ? Math.abs(unrealizedFunding) : 0) - feeEstRoundTrip;
        // broadcast lightweight snapshot
        emit('activity', {
          strategy: this.config.name,
          status: this.state.running ? 'active' : 'idle',
          current: mid,
          currentPairPrice: (typeof oracle === 'number' ? oracle : mid),
          oracle,
          mid,
          spread: (typeof shared?.bid === 'number' && typeof shared?.ask === 'number') ? (shared.ask - shared.bid) : undefined,
          openOrders: this.state.openOrders,
          effLev: this.state.effectiveLeverage,
          liqBuf: this.state.liquidationBuffer,
          marketIndex: this.config.market.marketIndex,
          symbol: (l2 as any)?.symbol || shared?.symbol,
          pair: ((l2 as any)?.symbol || shared?.symbol) ? `USDC/${(l2 as any)?.symbol || shared?.symbol}` : undefined,
          gridLevels: ladder,
          unrealizedPnl,
          unrealizedFunding,
          fundingApy,
          feeBps,
          feeEstRoundTrip,
          netApprox,
        });
        logger.debug('drift.grid.snapshot', { mid, openOrders: this.state.openOrders, effLev: this.state.effectiveLeverage, liqBuf: this.state.liquidationBuffer, marketIndex: this.config.market.marketIndex, cat: 'drift' });
      }
    } catch (e: any) {
      logger.error('drift.grid.tick_failed', { error: String(e?.message || e), cat: 'drift' });
    }
  }
}

export class DriftGridRegistry {
  private static runners: Map<string, DriftGridRunner> = new Map();

  static keyOf(cfg: LeveragedGridConfig): string {
    return `${cfg.name}#${cfg.market.marketIndex}#${cfg.subaccountId}`;
  }

  static upsert(cfg: LeveragedGridConfig): DriftGridRunner {
    const key = this.keyOf(cfg);
    let r = this.runners.get(key);
    if (!r) {
      r = new DriftGridRunner(cfg);
      this.runners.set(key, r);
    }
    return r;
  }

  static get(key: string): DriftGridRunner | undefined {
    return this.runners.get(key);
  }

  static list(): Array<{ key: string; status: GridRuntimeState }> {
    return Array.from(this.runners.entries()).map(([key, r]) => ({ key, status: r.getStatus() }));
  }

  static async start(key: string, pollMs?: number): Promise<boolean> {
    const r = this.runners.get(key);
    if (!r) return false;
    await r.start(pollMs);
    return true;
  }

  static stop(key: string): boolean {
    const r = this.runners.get(key);
    if (!r) return false;
    r.stop();
    return true;
  }
}


