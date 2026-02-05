// @ts-nocheck
import { logger } from '../utils/logger.js';
import { DriftService } from './client.js';
import { CONFIG } from '../utils/config.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type UnwindTask = {
  id: string;
  type: 'perp' | 'spot';
  marketIndex: number;
  /** Signed raw base for perp (positive = long acquired, negative = short acquired) */
  baseAmountRaw?: number;
  /** Spot market index of the deposit asset we received */
  spotDepositMarketIndex?: number;
  /** Raw amount of the deposit asset received (always positive) */
  spotDepositAmountRaw?: number;
  /** Public key of the liquidated user (for logging) */
  userPk: string;
  acquiredAtMs: number;
  notionalUsd?: number;
};

// ---------------------------------------------------------------------------
// MarketFeeCache – reads per-market liquidatorFee from on-chain accounts
// ---------------------------------------------------------------------------

const PERCENTAGE_PRECISION = 1_000_000;

export class MarketFeeCache {
  private perpFees: Map<number, number> = new Map();
  private spotFees: Map<number, number> = new Map();
  private lastRefreshMs = 0;
  private refreshIntervalMs = 60_000;
  private fallbackRate: number;

  constructor(fallbackRate?: number) {
    this.fallbackRate = fallbackRate ?? 0.01;
  }

  async refresh(): Promise<void> {
    try {
      const drift: any = (DriftService.getInstance() as any)?.client;
      if (!drift) return;

      // Perp markets
      try {
        const perpMarkets = drift.getPerpMarketAccounts?.() || [];
        for (const mkt of perpMarkets) {
          try {
            const idx = Number(mkt?.marketIndex);
            const fee = Number(mkt?.liquidatorFee ?? 0);
            if (Number.isFinite(idx) && Number.isFinite(fee) && fee > 0) {
              this.perpFees.set(idx, fee / PERCENTAGE_PRECISION);
            }
          } catch {}
        }
      } catch {}

      // Spot markets
      try {
        const spotMarkets = drift.getSpotMarketAccounts?.() || [];
        for (const mkt of spotMarkets) {
          try {
            const idx = Number(mkt?.marketIndex);
            const fee = Number(mkt?.liquidatorFee ?? 0);
            if (Number.isFinite(idx) && Number.isFinite(fee) && fee > 0) {
              this.spotFees.set(idx, fee / PERCENTAGE_PRECISION);
            }
          } catch {}
        }
      } catch {}

      this.lastRefreshMs = Date.now();
      try {
        logger.info('drift.unwind.fee_cache_refreshed', {
          perpMarkets: this.perpFees.size,
          spotMarkets: this.spotFees.size,
          cat: 'drift',
        });
      } catch {}
    } catch (e: any) {
      try { logger.warn('drift.unwind.fee_cache_refresh_failed', { error: String(e?.message || e), cat: 'drift' }); } catch {}
    }
  }

  getPerpFee(marketIndex: number): number {
    return this.perpFees.get(marketIndex) ?? this.getFallback();
  }

  getSpotFee(marketIndex: number): number {
    return this.spotFees.get(marketIndex) ?? this.getFallback();
  }

  needsRefresh(): boolean {
    return (Date.now() - this.lastRefreshMs) > this.refreshIntervalMs;
  }

  /** Return all cached perp fees as { marketIndex, rate } entries */
  getAllPerpFees(): Array<{ marketIndex: number; rate: number }> {
    return Array.from(this.perpFees.entries()).map(([marketIndex, rate]) => ({ marketIndex, rate }));
  }

  /** Return all cached spot fees as { marketIndex, rate } entries */
  getAllSpotFees(): Array<{ marketIndex: number; rate: number }> {
    return Array.from(this.spotFees.entries()).map(([marketIndex, rate]) => ({ marketIndex, rate }));
  }

  private getFallback(): number {
    try {
      const feeCfg: any = (CONFIG as any)?.drift?.liquidator?.feeAssumptions || {};
      const rate = Number(feeCfg.liqFeeRate);
      if (Number.isFinite(rate) && rate > 0) return rate;
    } catch {}
    return this.fallbackRate;
  }
}

// ---------------------------------------------------------------------------
// UnwindQueue – non-blocking async queue for position unwinding
// ---------------------------------------------------------------------------

export class UnwindQueue {
  private queue: UnwindTask[] = [];
  private inFlight = 0;
  private maxConcurrent: number;
  private slippageBps: number;
  private enabled: boolean;
  private draining = false;

  constructor(opts?: { maxConcurrent?: number; slippageBps?: number; enabled?: boolean }) {
    this.maxConcurrent = Math.max(1, Number(opts?.maxConcurrent ?? 2));
    this.slippageBps = Math.max(1, Number(opts?.slippageBps ?? 100));
    this.enabled = opts?.enabled !== false;
  }

  /** Non-blocking push. Kicks off drain without awaiting. */
  push(task: UnwindTask): void {
    if (!this.enabled) return;
    this.queue.push(task);
    // Fire-and-forget drain
    Promise.resolve().then(() => this.drain()).catch(() => {});
  }

  /** Pending + in-flight count for observability. */
  size(): number {
    return this.queue.length + this.inFlight;
  }

  /** Stop accepting new tasks and let in-flight finish. */
  shutdown(): void {
    this.enabled = false;
    this.queue.length = 0;
  }

  // ---- internal ---------------------------------------------------------

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0 && this.inFlight < this.maxConcurrent) {
        const task = this.queue.shift()!;
        this.inFlight++;
        this.execute(task)
          .catch((e: any) => {
            try { logger.warn('drift.unwind.task_error', { id: task.id, error: String(e?.message || e), cat: 'drift' }); } catch {}
          })
          .finally(() => {
            this.inFlight--;
            // Kick drain again in case more work queued while we were busy
            Promise.resolve().then(() => this.drain()).catch(() => {});
          });
      }
    } finally {
      this.draining = false;
    }
  }

  private async execute(task: UnwindTask): Promise<void> {
    if (task.type === 'perp') {
      await this.unwindPerp(task);
    } else if (task.type === 'spot') {
      await this.unwindSpot(task);
    }
  }

  // ---- perp unwind ------------------------------------------------------

  private async unwindPerp(task: UnwindTask): Promise<void> {
    const drift: any = (DriftService.getInstance() as any)?.client;
    if (!drift || !task.baseAmountRaw) return;

    const t0 = Date.now();
    try {
      // Load SDK enums dynamically (same pattern as liquidator.ts)
      const sdk: any = await import('@drift-labs/sdk');
      const OrderType = (sdk as any)?.OrderType;
      const PositionDirection = (sdk as any)?.PositionDirection;
      let BN = (sdk as any)?.BN;
      if (!BN) { try { const mod: any = await import('bn.js'); BN = (mod as any)?.default || (mod as any)?.BN || mod; } catch {} }

      // User was long (positive base) → we acquired long → close by going SHORT
      // User was short (negative base) → we acquired short → close by going LONG
      const isLong = task.baseAmountRaw > 0;
      const absBase = Math.abs(task.baseAmountRaw);

      const direction = isLong
        ? (PositionDirection?.SHORT ?? PositionDirection?.short ?? 'SHORT')
        : (PositionDirection?.LONG ?? PositionDirection?.long ?? 'LONG');

      const orderType = OrderType?.MARKET ?? OrderType?.market ?? 'MARKET';

      const baseAssetAmount = BN ? new BN(absBase) : absBase;

      const params: any = {
        orderType,
        marketIndex: task.marketIndex,
        direction,
        baseAssetAmount,
        reduceOnly: true,
      };

      if (typeof drift?.placePerpOrder === 'function') {
        const result = await drift.placePerpOrder(params);
        const sig = typeof result === 'string' ? result : (result?.txSig || result?.signature || null);
        try {
          logger.info('drift.unwind.perp_ok', {
            marketIndex: task.marketIndex,
            direction: isLong ? 'SHORT' : 'LONG',
            absBase,
            sig,
            ms: Date.now() - t0,
            liquidatedUser: task.userPk,
            notionalUsd: task.notionalUsd,
            cat: 'drift',
          });
        } catch {}
      } else {
        try { logger.warn('drift.unwind.perp_unavailable', { marketIndex: task.marketIndex, cat: 'drift' }); } catch {}
      }
    } catch (e: any) {
      try {
        logger.warn('drift.unwind.perp_failed', {
          marketIndex: task.marketIndex,
          error: String(e?.message || e),
          liquidatedUser: task.userPk,
          ms: Date.now() - t0,
          cat: 'drift',
        });
      } catch {}
    }
  }

  // ---- spot unwind (Strategy A: Drift internal Jupiter swap) ------------

  private async unwindSpot(task: UnwindTask): Promise<void> {
    const drift: any = (DriftService.getInstance() as any)?.client;
    const connection: any = (DriftService.getInstance() as any)?.connection;
    if (!drift || !task.spotDepositAmountRaw || !task.spotDepositMarketIndex) return;

    // USDC is always spot market index 0 — if we already received USDC, nothing to do
    if (task.spotDepositMarketIndex === 0) return;

    const t0 = Date.now();
    try {
      // Build JupiterClient from SDK
      const sdk: any = await import('@drift-labs/sdk');
      const JupiterClient = (sdk as any)?.JupiterClient;
      let BN = (sdk as any)?.BN;
      if (!BN) { try { const mod: any = await import('bn.js'); BN = (mod as any)?.default || (mod as any)?.BN || mod; } catch {} }

      if (typeof drift?.swap !== 'function') {
        try { logger.warn('drift.unwind.spot_swap_unavailable', { reason: 'drift.swap not a function', cat: 'drift' }); } catch {}
        return;
      }

      let jupiterClient: any = null;
      if (JupiterClient && connection) {
        try {
          jupiterClient = new JupiterClient({ connection });
        } catch (e: any) {
          try { logger.warn('drift.unwind.jupiter_client_init_failed', { error: String(e?.message || e), cat: 'drift' }); } catch {}
        }
      }

      const amount = BN ? new BN(Math.floor(task.spotDepositAmountRaw)) : Math.floor(task.spotDepositAmountRaw);

      const result = await drift.swap({
        jupiterClient,
        inMarketIndex: task.spotDepositMarketIndex,
        outMarketIndex: 0, // USDC
        amount,
        slippageBps: this.slippageBps,
      });

      const sig = typeof result === 'string' ? result : (result?.txSig || result?.signature || null);
      try {
        logger.info('drift.unwind.spot_ok', {
          inMarketIndex: task.spotDepositMarketIndex,
          outMarketIndex: 0,
          amountRaw: task.spotDepositAmountRaw,
          sig,
          ms: Date.now() - t0,
          liquidatedUser: task.userPk,
          cat: 'drift',
        });
      } catch {}
    } catch (e: any) {
      try {
        logger.warn('drift.unwind.spot_failed', {
          inMarketIndex: task.spotDepositMarketIndex,
          error: String(e?.message || e),
          liquidatedUser: task.userPk,
          ms: Date.now() - t0,
          cat: 'drift',
        });
      } catch {}
    }
  }
}
