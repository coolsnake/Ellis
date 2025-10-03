import { describe, it, expect } from 'vitest';
import { generatePriceLadder } from './orders.js';

describe('orders - ladder generation', () => {
  it('generates symmetric ladder with step percent', () => {
    const cfg: any = { levels: 2, stepPct: 0.05, notionalPerLevel: 1000 };
    const ref = 100;
    const ladder = generatePriceLadder(cfg, ref);
    expect(ladder.length).toBe(4);
    const buys = ladder.filter(l => l.side === 'buy');
    const sells = ladder.filter(l => l.side === 'sell');
    expect(buys[0].price).toBeCloseTo(95, 6);
    expect(sells[0].price).toBeCloseTo(105, 6);
    expect(buys[0].size).toBeCloseTo(1000 / 95, 6);
    expect(sells[0].size).toBeCloseTo(1000 / 105, 6);
  });
});


