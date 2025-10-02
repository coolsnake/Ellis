import type { LeveragedGridConfig } from './types.js';
import { CONFIG } from '../utils/config.js';

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
    } catch {}
  }

  async cancelAll(marketIndex: number): Promise<void> {
    try {
      if (typeof this.client?.cancelOrders === 'function') {
        await this.client.cancelOrders({ marketIndex, marketType: 0 });
      }
    } catch {}
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
        } catch {}
      }
    } catch {}
  }

  async refreshLadder(marketIndex: number, ladder: GridLevel[], makerOnly: boolean, anchor: number, stepPct: number): Promise<void> {
    try {
      const now = Date.now();
      const lastAnchor = this.lastAnchorByMarket.get(marketIndex) || 0;
      const lastAt = this.lastActionAtByMarket.get(marketIndex) || 0;
      const moved = (Number.isFinite(anchor) && Number.isFinite(lastAnchor) && lastAnchor > 0) ? (Math.abs(anchor - lastAnchor) / lastAnchor) : Infinity;
      const stale = (now - lastAt) > 3000;
      if (!stale && moved < Math.max(0.25 * stepPct, 0.0025)) return; // require at least 25% of step or 0.25%
      await this.cancelAll(marketIndex);
      await this.placeLadder(marketIndex, ladder, makerOnly);
      this.lastAnchorByMarket.set(marketIndex, anchor);
      this.lastActionAtByMarket.set(marketIndex, now);
    } catch {}
  }
}


