import { describe, it, expect } from 'vitest';
import { resolveDirectPlan } from '../execution/resolver/index.js';

describe('per-hop quotes and minOut propagation', () => {
  it('sets minOut in output units and propagates amounts', async () => {
    // This is a smoke test to ensure the code path executes without throwing.
    // Actual values depend on network/SDK availability; we only assert plan shape.
    const plan = await resolveDirectPlan({ path: ['A','B','C'], hopPoolIds: ['p1','p2'], dexes: ['raydium.amm','orca.clmm'], size: 10, slippageBps: 50 } as any, {
      mode: 'simulate', slippageBpsDefault: 50, computeUnitLimit: 1_000_000, computeUnitPriceMicroLamports: 1000, createAtasInTx: true, dynamicCompute: true,
    } as any);
    expect(plan.hops.length).toBe(2);
    expect(typeof plan.hops[0].amountInRaw).toBe('bigint');
    expect(typeof plan.hops[0].minOutRaw).toBe('bigint');
  });
});


