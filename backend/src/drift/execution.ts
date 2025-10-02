import { logger } from '../utils/logger.js';
import type { LeveragedGridConfig, GridRuntimeState } from './types.js';
import { DriftService } from './client.js';
import { canPlaceOrders } from './risk.js';
import { fetchDlobL2 } from './marketdata.js';
import { emit } from '../server/realtime.js';

export class DriftGridRunner {
  private timer: NodeJS.Timeout | null = null;
  private state: GridRuntimeState = { running: false, openOrders: 0, netExposure: 0, effectiveLeverage: 0, liquidationBuffer: Infinity };

  constructor(private config: LeveragedGridConfig) {}

  getStatus(): GridRuntimeState {
    return { ...this.state, config: this.config };
  }

  async start(pollMs = 1500): Promise<void> {
    if (this.timer) return;
    this.state.running = true;
    logger.info('drift.grid.start', { name: this.config.name, marketIndex: this.config.market.marketIndex, subaccountId: this.config.subaccountId, levels: this.config.levels, notionalPerLevel: this.config.notionalPerLevel, cat: 'drift' });
    this.timer = setInterval(() => {
      this.tick().catch((e) => logger.error('drift.grid.tick_error', { error: String(e), cat: 'drift' }));
    }, Math.max(500, pollMs));
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.state.running = false;
    logger.info('drift.grid.stop', { name: this.config.name, marketIndex: this.config.market.marketIndex, subaccountId: this.config.subaccountId, cat: 'drift' });
  }

  async tick(): Promise<void> {
    try {
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
      // Placeholder: no real orders yet; update state snapshot
      this.state.openOrders = perSide * 2;
      this.state.effectiveLeverage = 0; // unknown until positions; keep zero for scaffold
      this.state.liquidationBuffer = Infinity; // unknown; will come from subaccount when wired

      // Fetch L2 for price context
      const l2 = await fetchDlobL2(this.config.market.marketIndex);
      const mid = l2 && l2.bid[0] && l2.ask[0] ? (l2.bid[0].price + l2.ask[0].price) / 2 : undefined;
      if (typeof mid === 'number' && isFinite(mid)) {
        // broadcast lightweight snapshot
        emit('activity', {
          strategy: this.config.name,
          status: this.state.running ? 'active' : 'idle',
          current: mid,
          openOrders: this.state.openOrders,
          effLev: this.state.effectiveLeverage,
          liqBuf: this.state.liquidationBuffer,
          marketIndex: this.config.market.marketIndex,
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


