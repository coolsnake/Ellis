import { logger } from '../utils/logger.js';
import type { LeveragedGridConfig, GridRuntimeState } from './types.js';
import { DriftService } from './client.js';
import { canPlaceOrders } from './risk.js';
import { fetchDlobL2 } from './marketdata.js';
import { emit } from '../server/realtime.js';
import { DriftPriceService } from './price.js';
import { generatePriceLadder, DriftOrderEngine } from './orders.js';
import { CONFIG } from '../utils/config.js';
import { RunnerRegistry } from '../utils/runnerRegistry.js';

export class DriftGridRunner {
  private timer: any | null = null;
  private state: GridRuntimeState = { running: false, openOrders: 0, netExposure: 0, effectiveLeverage: 0, liquidationBuffer: Infinity };
  private tickScheduledAt: number = 0;
  private lastTickAt: number = 0;
  private lastSubaccountSnapshot: { ts: number; sub?: any } = { ts: 0 };

  constructor(private config: LeveragedGridConfig) {}

  getStatus(): GridRuntimeState {
    return { ...this.state, config: this.config };
  }

  async start(pollMs = 1500): Promise<void> {
    if (this.timer) return;
    this.state.running = true;
    const cid = `grid-${this.config.name}-${this.config.market.marketIndex}-${this.config.subaccountId}`;
    logger.info('drift.grid.start', { name: this.config.name, marketIndex: this.config.market.marketIndex, subaccountId: this.config.subaccountId, levels: this.config.levels, notionalPerLevel: this.config.notionalPerLevel, cat: 'drift', code: 'DRIFT.GRID.START', cid, span: 'start' });
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
      this.tick().catch((e) => logger.error('drift.grid.tick_error', { error: String(e), cat: 'drift', code: 'DRIFT.GRID.TICK_ERROR' }));
    }, Math.max(500, pollMs));
  }

  stop(): void {
    if (this.timer) (globalThis as any).clearInterval(this.timer);
    this.timer = null;
    this.state.running = false;
    logger.info('drift.grid.stop', { name: this.config.name, marketIndex: this.config.market.marketIndex, subaccountId: this.config.subaccountId, cat: 'drift', code: 'DRIFT.GRID.STOP', span: 'end' });
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
      let sub: any | undefined = undefined;
      const cacheMs = Math.max(800, Math.min(5000, Number(((CONFIG as any)?.drift?.gridSubSnapshotMs) || 1500)));
      if (this.lastSubaccountSnapshot.sub && (Date.now() - this.lastSubaccountSnapshot.ts) < cacheMs) {
        sub = this.lastSubaccountSnapshot.sub;
      } else {
        const subs = await drift.getSubaccounts();
        sub = subs.find(s => s.id === this.config.subaccountId) || subs[0];
        this.lastSubaccountSnapshot = { ts: Date.now(), sub };
      }
      if (!sub) {
        logger.warn('drift.grid.no_subaccount', { requested: this.config.subaccountId, cat: 'drift' });
        return;
      }

      // For scaffold: compute proposed notional as sum of per-level notionals
      const perSide = Math.max(0, Number(this.config.levels || 0));
      const proposedNotional = perSide * (this.config.notionalPerLevel || 0);
      // Funding APY (best-effort) for risk gate
      let fundingApy: number | undefined = undefined;
      if (this.config.fundingGuard) {
        try {
          const fr = await DriftService.getInstance().getFundingRate(this.config.market.marketIndex);
          if (fr && typeof fr.lastFundingRate === 'number') {
            fundingApy = fr.lastFundingRate * 365 * 24;
          }
        } catch {}
      }
      const gate = canPlaceOrders(this.config, sub, proposedNotional, fundingApy);
      if (!gate.ok) {
        logger.warn('drift.grid.risk_gate_block', { reason: gate.reason, proposedNotional, freeCollateral: sub.freeCollateral, cat: 'drift' });
        return;
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
        // Determine anchor and sliding center similar to classic grid
        let anchor = (typeof oracle === 'number' ? oracle : mid);
        // Initialize center state if missing
        if (!this.state.centerPrice || !Number.isFinite(this.state.centerPrice)) {
          this.state.centerPrice = anchor;
          this.state.originalCenterPrice = anchor;
          this.state.lastSlideUpdate = Date.now();
        }
        // Sliding center toward current anchor
        if (this.config.slidingCenter && Number(this.config.slideRate) > 0) {
          const now = Date.now();
          const last = this.state.lastSlideUpdate || now;
          const dtSec = Math.max(0, (now - last) / 1000);
          const rate = Number(this.config.slideRate) / 10000; // fraction/sec
          const maxDist = Math.max(0, Number(this.config.slideMaxDistance || 0)) / 100; // fraction
          const currentCenter = Number(this.state.centerPrice || anchor);
          const delta = (anchor - currentCenter) * rate * dtSec;
          let nextCenter = currentCenter + delta;
          const orig = Number(this.state.originalCenterPrice || anchor);
          const cap = Math.abs(orig) * maxDist;
          nextCenter = Math.max(orig - cap, Math.min(orig + cap, nextCenter));
          if (Number.isFinite(nextCenter) && Math.abs(nextCenter - currentCenter) / Math.max(1e-9, Math.abs(currentCenter)) > 0.0001) {
            this.state.centerPrice = nextCenter;
            this.state.lastSlideUpdate = now;
          }
          anchor = this.state.centerPrice || anchor;
        } else {
          // Keep anchor synced when sliding disabled
          this.state.centerPrice = anchor;
          this.state.originalCenterPrice = this.state.originalCenterPrice ?? anchor;
          this.state.lastSlideUpdate = this.state.lastSlideUpdate ?? Date.now();
        }

        const ladder = generatePriceLadder(this.config, anchor);
        // Order refresh lifecycle (maker-only optional)
        try {
          const engine: DriftOrderEngine | undefined = (this as any)._engine;
          if (engine) {
            await engine.refreshLadder(
              this.config.market.marketIndex,
              ladder,
              !!this.config.makerOnly,
              anchor,
              Number(this.config.stepPct || 0.01),
              Number(this.config.maxOpenOrders || 0)
            );
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
          subaccountId: this.config.subaccountId,
          symbol: (l2 as any)?.symbol || shared?.symbol,
          pair: ((l2 as any)?.symbol || shared?.symbol) ? `USDC/${(l2 as any)?.symbol || shared?.symbol}` : undefined,
          gridLevels: ladder,
          unrealizedPnl,
          unrealizedFunding,
          fundingApy,
          feeBps,
          feeEstRoundTrip,
          netApprox,
          centerPrice: this.state.centerPrice,
          driftKey: `${this.config.name}#${this.config.market.marketIndex}#${this.config.subaccountId}`,
        });
        logger.debug('drift.grid.snapshot', { mid, openOrders: this.state.openOrders, effLev: this.state.effectiveLeverage, liqBuf: this.state.liquidationBuffer, marketIndex: this.config.market.marketIndex, cat: 'drift' });
      }
    } catch (e: any) {
      logger.error('drift.grid.tick_failed', { error: String(e?.message || e), cat: 'drift' });
    }
  }
}

export class DriftGridRegistry {
  private static reg = new RunnerRegistry<DriftGridRunner>();

  static keyOf(cfg: LeveragedGridConfig): string {
    return `${cfg.name}#${cfg.market.marketIndex}#${cfg.subaccountId}`;
  }

  static upsert(cfg: LeveragedGridConfig): DriftGridRunner {
    const key = this.keyOf(cfg);
    return this.reg.upsert(key, () => new DriftGridRunner(cfg));
  }

  static get(key: string): DriftGridRunner | undefined {
    return this.reg.get(key);
  }

  static list(): Array<{ key: string; status: GridRuntimeState }> {
    return this.reg.list();
  }

  static async start(key: string, pollMs?: number): Promise<boolean> {
    return this.reg.start(key, pollMs);
  }

  static stop(key: string): boolean {
    return this.reg.stop(key);
  }

  static remove(key: string): boolean {
    return this.reg.remove(key);
  }
}


