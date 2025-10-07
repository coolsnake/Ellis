import { describe, it, expect } from 'vitest';
import { resolveDirectPlan } from '../execution/resolver/index.js';

describe('execution e2e simulate-only', () => {
  it('resolves a 2-hop plan with placeholders', async () => {
    const plan = await resolveDirectPlan({
      path: ['A','B','C'],
      hopPoolIds: ['p1','p2'],
      dexes: ['raydium.amm','orca.clmm'],
      size: 100,
      slippageBps: 50,
    }, {
      mode: 'simulate', slippageBpsDefault: 50, computeUnitLimit: 1_000_000, computeUnitPriceMicroLamports: 1000, createAtasInTx: true, dynamicCompute: true,
    });
    expect(plan.hops.length).toBe(2);
  });
});


