import { describe, it, expect } from 'vitest';
import * as cfgMod from '../../utils/config';

describe('graph clamp drops extremes', () => {
  it('setup', () => { expect(true).toBe(true); });

  it('drops meteora clmm edge with absurd price', async () => {
    (globalThis as any).__graphTestPools = {
      raydium: { amm: [], clmm: [] },
      orca: { amm: [], clmm: [] },
      meteora: { amm: [], clmm: [{ id: 'x', mint_a: 'A', mint_b: 'B', price_a_per_b: 1e20, fee_bps: 30, pool_kind: 'clmm' }] },
      meteora_balanced: { amm: [] }
    };
    const { getGraphSnapshot } = await import('../graph');
    const snap = await getGraphSnapshot(true);
    const bad = snap.edges.find((e: any) => e.id === 'x' || (e.source === 'A' && e.target === 'B'));
    expect(!bad).toBe(true);
  });
});


