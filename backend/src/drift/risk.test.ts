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
    // lev(900/500)=1.8 <= 2, liqBuf=(500-300)/300=0.67 >= 0.2 -> ok
    expect(canPlaceOrders(cfg, sub, 900).ok).toBe(true);
    // lev(1100/500)=2.2 > 2 -> blocked
    expect(canPlaceOrders(cfg, sub, 1100).ok).toBe(false);
    // lev(800/500)=1.6 <= 2, liqBuf ok -> ok
    expect(canPlaceOrders(cfg, sub, 800).ok).toBe(true);
  });
});


