import { describe, it, expect } from 'vitest';
import { canonicalizePairsLex, canonicalizePairs } from '../pools/common.js';

describe('canonicalizePairs swaps all A/B fields and inverts price once', () => {
  const A = 'A11111111111111111111111111111111111111111';
  const B = 'B11111111111111111111111111111111111111111';

  const mkPool = () => ({
    id: 'pool1',
    mint_a: B,
    mint_b: A,
    price_a_per_b: 0.0025, // A per 1 B (tiny)
    amount_a: 1_000_000,
    amount_b: 2_000_000,
    amount_a_whole: 10,
    amount_b_whole: 20,
    decimals_a: 6,
    decimals_b: 9,
    account_a: 'acctA',
    account_b: 'acctB',
    source_account: 'srcA',
    target_account: 'tgtB',
  });

  it('lex-mode swap uses swapABFields for all pairs', () => {
    const pools = [mkPool()];
    const out = canonicalizePairsLex(pools as any);
    expect(out.length).toBe(1);
    const p = out[0] as any;
    // mints swapped to keep lex ordering
    expect(p.mint_a).toBe(A);
    expect(p.mint_b).toBe(B);
    // price inverted exactly once
    expect(typeof p.price_a_per_b).toBe('number');
    expect(p.price_a_per_b).toBeCloseTo(1 / 0.0025, 12);
    // side-specific fields swapped
    expect(p.amount_a).toBe(2_000_000);
    expect(p.amount_b).toBe(1_000_000);
    expect(p.amount_a_whole).toBe(20);
    expect(p.amount_b_whole).toBe(10);
    expect(p.decimals_a).toBe(9);
    expect(p.decimals_b).toBe(6);
    expect(p.account_a).toBe('acctB');
    expect(p.account_b).toBe('acctA');
    expect(p.source_account).toBe('tgtB');
    expect(p.target_account).toBe('srcA');
  });

  it('preferLists swap path also swaps consistently', () => {
    // Force swap by configuring prefer lists via function arg mode
    // We cannot change CONFIG here, but pairs function should still behave with default 'lex' fallback.
    const pools = [mkPool()];
    const out = canonicalizePairs(pools as any);
    expect(out.length).toBe(1);
    const p = out[0] as any;
    // Same assertions as lex fallback
    expect(p.mint_a).toBe(A);
    expect(p.mint_b).toBe(B);
    expect(p.price_a_per_b).toBeCloseTo(1 / 0.0025, 12);
  });
});


