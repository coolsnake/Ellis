import type { LeveragedGridConfig } from './types.js';
import { CONFIG } from '../utils/config.js';
import { safeLog, guardExec } from './safeLogger.js';

export type GridLevel = { side: 'buy' | 'sell'; price: number; size?: number; filled?: boolean };

export function generatePriceLadder(cfg: LeveragedGridConfig, refPrice: number): GridLevel[] {
  const levels = Math.max(0, Number(cfg.levels || 0));
  const stepPct = Math.max(0, Number(cfg.stepPct || 0.01));
  const notional = Math.max(0, Number(cfg.notionalPerLevel || 0));
  if (!Number.isFinite(refPrice) || refPrice <= 0 || levels === 0 || notional <= 0) return [];
  const out: GridLevel[] = [];
  for (let i = 1; i <= levels; i += 1) {
    const buyPx = refPrice * (1 - stepPct * i);
    const sellPx = refPrice * (1 + stepPct * i);
    const buySz = notional / buyPx;
    const sellSz = notional / sellPx;
    out.push({ side: 'buy', price: buyPx, size: buySz });
    out.push({ side: 'sell', price: sellPx, size: sellSz });
  }
  return out;
}

export class DriftOrderEngine {
  private client: any;
  private lastAnchorByMarket: Map<number, number> = new Map();
  private lastActionAtByMarket: Map<number, number> = new Map();
  private makerFeeBps: number = 0;
  private takerFeeBps: number = 5;

  constructor(client: any) {
    this.client = client;
    try {
      this.makerFeeBps = Number((CONFIG as any)?.drift?.feeMakerBps || 0);
      this.takerFeeBps = Number((CONFIG as any)?.drift?.feeTakerBps || 5);
    } catch (e: any) {
      safeLog.debug('drift.order.config_read_failed', { error: String(e?.message || e), cat: 'drift' });
    }
  }

  async cancelAll(marketIndex: number): Promise<void> {
    try {
      if (typeof this.client?.cancelOrders === 'function') {
        await this.client.cancelOrders({ marketIndex, marketType: 0 });
      }
    } catch (e: any) {
      safeLog.warn('drift.order.cancelAll.failed', { marketIndex, error: String(e?.message || e), cat: 'drift' });
    }
  }

  async placeLadder(marketIndex: number, ladder: GridLevel[], makerOnly: boolean): Promise<void> {
    try {
      if (!Array.isArray(ladder) || ladder.length === 0) return;
      const convertQty = this.client?.convertToPerpPrecision?.bind(this.client);
      const convertPrice = this.client?.convertToPricePrecision?.bind(this.client);
      for (const lvl of ladder) {
        try {
          const dir = String(lvl.side).toLowerCase() === 'buy' ? 'LONG' : 'SHORT';
          const qty = Math.max(0, Number(lvl.size || 0));
          const px = Math.max(0, Number(lvl.price || 0));
          if (!qty || !px) continue;
          const baseAssetAmount = typeof convertQty === 'function' ? await convertQty(qty) : qty;
          const price = typeof convertPrice === 'function' ? await convertPrice(px) : px;
          const params: any = {
            orderType: (this.client?.types?.OrderType?.LIMIT) || 'LIMIT',
            marketIndex,
            direction: (this.client?.types?.PositionDirection?.[dir]) || dir,
            baseAssetAmount,
            price,
          };
          if (makerOnly) {
            // Post-only param naming varies; set common flags
            params.postOnly = true;
            params.postOnlySlide = true;
          }
          if (typeof this.client?.placePerpOrder === 'function') {
            await this.client.placePerpOrder(params);
          }
        } catch (e: any) {
          safeLog.warn('drift.order.placeLadder.order_failed', { marketIndex, side: lvl.side, price: lvl.price, error: String(e?.message || e), cat: 'drift' });
        }
      }
    } catch (e: any) {
      safeLog.warn('drift.order.placeLadder.failed', { marketIndex, error: String(e?.message || e), cat: 'drift' });
    }
  }

  private async getOpenOrdersForMarket(marketIndex: number): Promise<Array<{ id?: any; side?: 'buy'|'sell'; price?: number; size?: number }>> {
    try {
      // Try various SDK shapes best-effort
      const user = this.client?.user;
      let orders: any[] | null = null;
      try { orders = await this.client?.getOpenOrdersForMarket?.({ marketIndex, marketType: 0 }); } catch (e: any) {
        safeLog.debug('drift.order.getOpenOrders.method1_failed', { marketIndex, error: String(e?.message || e), cat: 'drift' });
      }
      if (!orders) { try { orders = await user?.getOpenOrders?.(); } catch (e: any) {
        safeLog.debug('drift.order.getOpenOrders.method2_failed', { marketIndex, error: String(e?.message || e), cat: 'drift' });
      } }
      if (!orders) { try { orders = await user?.getPerpOpenOrders?.(marketIndex); } catch (e: any) {
        safeLog.debug('drift.order.getOpenOrders.method3_failed', { marketIndex, error: String(e?.message || e), cat: 'drift' });
      } }
      if (!Array.isArray(orders)) return [];
      return orders
        .filter((o: any) => Number((o?.marketIndex ?? o?.market_index)) === Number(marketIndex))
        .map((o: any) => {
          const dir = String(o?.direction || o?.side || '').toUpperCase();
          const side = /LONG|BUY/.test(dir) ? 'buy' : 'sell';
          const price = Number(o?.price?.toString?.() || o?.price || o?.priceNumber || 0) || undefined;
          const size = Number(o?.baseAssetAmount?.toString?.() || o?.size || 0) || undefined;
          return { id: (o?.orderId ?? o?.order_id ?? o?.id), side, price, size };
        });
    } catch (e: any) {
      safeLog.debug('drift.order.getOpenOrders.failed', { marketIndex, error: String(e?.message || e), cat: 'drift' });
      return [];
    }
  }

  private async cancelOrderByIdSafe(order: { id?: any; marketIndex: number }): Promise<boolean> {
    try {
      if (order?.id != null) {
        if (typeof this.client?.cancelOrder === 'function') { await this.client.cancelOrder(order.id); return true; }
        if (typeof this.client?.cancelOrderById === 'function') { await this.client.cancelOrderById(order.id); return true; }
        if (typeof this.client?.cancelOrderByUserId === 'function') { await this.client.cancelOrderByUserId(order.id); return true; }
      }
    } catch (e: any) {
      safeLog.warn('drift.order.cancelById.failed', { orderId: order?.id, marketIndex: order?.marketIndex, error: String(e?.message || e), cat: 'drift' });
    }
    return false;
  }

  async refreshLadder(
    marketIndex: number,
    ladder: GridLevel[],
    makerOnly: boolean,
    anchor: number,
    stepPct: number,
    maxOpenOrders?: number
  ): Promise<void> {
    try {
      const refreshStart = Date.now();
      const plannedLevels = Array.isArray(ladder) ? ladder.length : 0;
      const dbg = { marketIndex, plannedLevels, anchor, stepPct, maxOpenOrders, makerOnly };
      safeLog.debug('drift.order.refresh.start', { ...dbg, cat: 'drift' });
      const now = Date.now();
      const lastAnchor = this.lastAnchorByMarket.get(marketIndex) || 0;
      const lastAt = this.lastActionAtByMarket.get(marketIndex) || 0;
      const moved = (Number.isFinite(anchor) && Number.isFinite(lastAnchor) && lastAnchor > 0) ? (Math.abs(anchor - lastAnchor) / lastAnchor) : Infinity;
      const stale = (now - lastAt) > 3000;
      if (!stale && moved < Math.max(0.25 * stepPct, 0.0025)) return; // require at least 25% of step or 0.25%

      // Enforce max open orders (total, across both sides). Prefer closest to anchor.
      let desired = Array.isArray(ladder) ? ladder.slice() : [];
      if (Number.isFinite(maxOpenOrders as number) && (maxOpenOrders as number) > 0) {
        desired.sort((a, b) => Math.abs(a.price - anchor) - Math.abs(b.price - anchor));
        desired = desired.slice(0, Number(maxOpenOrders));
      }

      // Fetch existing orders and compute delta
      const existing = await this.getOpenOrdersForMarket(marketIndex);
      const tolerance = Math.max(0.25 * stepPct, 0.0025);
      const toKeepFlags = new Array(desired.length).fill(false);
      const toCancel: Array<{ id?: any; marketIndex: number }> = [];
      safeLog.debug('drift.order.existing', { marketIndex, existing: existing.length, tolerance, cat: 'drift' });

      // Match existing to desired by closest price on same side
      for (const ex of existing) {
        if (!ex?.price || !ex?.side) { toCancel.push({ id: ex?.id, marketIndex }); continue; }
        let bestIdx = -1;
        let bestDiff = Infinity;
        for (let i = 0; i < desired.length; i += 1) {
          if (toKeepFlags[i]) continue;
          const d = desired[i];
          if (d.side !== ex.side) continue;
          const rel = Math.abs(d.price - ex.price!) / d.price;
          if (rel < bestDiff) { bestDiff = rel; bestIdx = i; }
        }
        if (bestIdx >= 0 && bestDiff <= tolerance) {
          toKeepFlags[bestIdx] = true; // keep this pairing, do not cancel
        } else {
          toCancel.push({ id: ex?.id, marketIndex });
        }
      }

      const toPlace: GridLevel[] = [];
      for (let i = 0; i < desired.length; i += 1) {
        if (!toKeepFlags[i]) toPlace.push(desired[i]);
      }
      safeLog.debug('drift.order.delta', {
        marketIndex,
        cancelCount: toCancel.length,
        placeCount: toPlace.length,
        keepCount: desired.length - toPlace.length,
        cat: 'drift'
      });

      // Dynamic pacing: cap operations per tick
      const maxOps = Math.max(2, Math.min(30, Number((CONFIG as any)?.drift?.gridMaxOpsPerTick || 10)));
      let ops = 0;
      for (const c of toCancel) {
        if (ops >= maxOps) break;
        const ok = await this.cancelOrderByIdSafe(c);
        if (ok) ops += 1;
      }
      if (ops < maxOps) {
        const remaining = maxOps - ops;
        await this.placeLadder(marketIndex, toPlace.slice(0, remaining), makerOnly);
      }

      this.lastAnchorByMarket.set(marketIndex, anchor);
      this.lastActionAtByMarket.set(marketIndex, now);
      safeLog.info('drift.order.refresh.end', { marketIndex, opsUsed: ops, ms: Date.now() - refreshStart, cat: 'drift', code: 'DRIFT.ORDER.REFRESH_END' });
    } catch (e: any) {
      safeLog.warn('drift.order.refreshLadder.failed', { marketIndex, error: String(e?.message || e), cat: 'drift' });
    }
  }
}
