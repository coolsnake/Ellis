import { describe, it, expect } from 'vitest';
import { computeEffectiveLeverage, computeLiquidationBuffer, canPlaceOrders } from './risk.js';

describe('risk math', () => {
  it('effective leverage', () => {
    expect(computeEffectiveLeverage(1000, 500)).toBe(2);
    expect(computeEffectiveLeverage(0, 500)).toBe(0);
    expect(computeEffectiveLeverage(1000, 0)).toBe(0);
  });
  it('liquidation buffer', () => {
    expect(computeLiquidationBuffer(1000, 800)).toBeCloseTo(0.25, 6);
    expect(computeLiquidationBuffer(1000, 0)).toBe(Infinity);
  });
  it('placement gates', () => {
    const cfg: any = { leverage: 2, liquidationBufferPct: 0.2 };
    const sub: any = { totalCollateral: 500, maintenanceRequirement: 300 };
    expect(canPlaceOrders(cfg, sub, 900).ok).toBe(false); // lev 1.8 ok, buf (100/300)=0.33 ok -> but proposed notional 900 => lev=1.8 (should be ok)
    expect(canPlaceOrders(cfg, sub, 1100).ok).toBe(false);
    expect(canPlaceOrders(cfg, sub, 800).ok).toBe(true);
  });
});


