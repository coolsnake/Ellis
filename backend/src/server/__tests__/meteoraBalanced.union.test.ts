import { describe, it, expect } from 'vitest';

describe('meteoraBalanced.union', () => {
  it('dedupes by id/pair and prefers v2 on conflicts', async () => {
    const mod: any = await import('../pools/meteoraBalanced.js');
    // Construct minimal normalized items
    const baseA = { id: 'POOL1', dex: 'Meteora', mint_a: 'A', mint_b: 'B', fee_bps: 30, price_a_per_b: 1, liquidity_base: 10, updated_ms: Date.now(), pool_kind: 'amm' } as any;
    const v1Only = { ...baseA, liquidity_base: 10 };
    const v2Override = { ...baseA, liquidity_base: 20 }; // should override v1
    const v1List = [v1Only];
    const v2List = [v2Override];
    const merged = mod.mergeBalancedPools(v2List, v1List);
    expect(Array.isArray(merged)).toBe(true);
    expect(merged.length).toBe(1);
    expect((merged[0] as any).liquidity_base).toBe(20);
  });
});


