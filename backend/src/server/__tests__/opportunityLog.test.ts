import { describe, it, expect } from 'vitest';
import { formatOpportunityLog } from '../utils/opportunityLog';

describe('formatOpportunityLog', () => {
  it('uses hop array length for hops and aligns fields', () => {
    const o = {
      profit_bps: 30,
      est_profit_usd: 0.15,
      path: ['A','B','C'],
      hop_dexes: ['X','Y','Z'],
      hop_rates: [1.1, 0.9, 1.0030303],
      hop_outs: [55, 49.5, 49.65],
      hop_fee_bps: [25, 25, 25],
      hop_pool_ids: ['p1','p2','p3'],
      hop_liquidity_display: [1000, 1000, 1000],
      est_capacity: 1000,
    };
    const msg = formatOpportunityLog(o as any, 0);
    expect(msg).toContain('hops=3');
    expect(msg).toContain('rates=[1.10000000,0.90000000,1.00303030]');
    expect(msg).toContain('outs=[55.000000,49.500000,49.650000]');
  });
});


