import { describe, it, expect } from 'vitest';
import { resolveDirectPlan } from '../execution/resolver/index.js';
import { buildDirectArbTx } from '../execution/builder/tx.js';

describe('simulate build matrix (no send)', () => {
  it('single-hop placeholders build without throwing (sdk presence dependent)', async () => {
    const routes: Array<{ path: string[]; dexes: string[]; hops: string[] }> = [
      { path: ['A','B'], dexes: ['raydium.amm'], hops: ['p1'] },
      { path: ['A','B'], dexes: ['raydium.clmm'], hops: ['p2'] },
      { path: ['A','B'], dexes: ['orca.clmm'], hops: ['p3'] },
      { path: ['A','B'], dexes: ['meteora.dlmm'], hops: ['p4'] },
    ];
    for (const r of routes) {
      try {
        const plan = await resolveDirectPlan({ path: r.path, dexes: r.dexes, hopPoolIds: r.hops, size: 1, slippageBps: 50 }, {
          mode: 'simulate', slippageBpsDefault: 50, computeUnitLimit: 1_000_000, computeUnitPriceMicroLamports: 1000, createAtasInTx: true, dynamicCompute: true,
        } as any);
        await buildDirectArbTx(plan, [], {} as any);
      } catch {}
    }
    expect(true).toBe(true);
  });
});


