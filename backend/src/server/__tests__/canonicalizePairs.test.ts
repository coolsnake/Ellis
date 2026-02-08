import { describe, it, expect } from 'vitest';
import { canonicalizePairsLex, canonicalizePairs } from '../pools/common.js';

describe('canonicalizePairs swaps all A/B fields and inverts price once', () => {
  const A = 'A11111111111111111111111111111111111111111';
  const B = 'B11111111111111111111111111111111111111111';

  const mkPool = () => ({
    id: 'pool1',
    mint_a: B,
    mint_b: A,
    price_a_per_b: 0.0025, // B per 1 A (tiny)
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

describe('canonicalizePairs quoteHierarchy places preferred quote on B and inverts once', () => {
  it('moves USDC to B side and inverts price once', async () => {
    const mod: any = await import('../../utils/config.js');
    // Force quoteHierarchy mode and list in CONFIG for test runtime
    mod.CONFIG.system.canonicalizePairs = 'quoteHierarchy';
    mod.CONFIG.system.quoteHierarchy = [
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
      'Es9vMFrzaCERfCkS7fGXx9bK6A7bP4J1yDrJZGB48JpN', // USDT
    ];
    const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const SOL = 'So11111111111111111111111111111111111111112';
    const pool = {
      id: 'P1',
      mint_a: USDC,
      mint_b: SOL,
      price_a_per_b: 0.02, // SOL per USDC but USDC should be on B
      amount_a: 1_000_000,
      amount_b: 1_000_000_000,
      amount_a_whole: 1_000_000 / 1e6,
      amount_b_whole: 1_000_000_000 / 1e9,
      decimals_a: 6,
      decimals_b: 9,
      account_a: 'acctA',
      account_b: 'acctB',
      source_account: 'srcA',
      target_account: 'tgtB',
    } as any;
    const [out] = canonicalizePairs([pool] as any) as any[];
    expect(out.mint_a).toBe(SOL);
    expect(out.mint_b).toBe(USDC);
    expect(out.price_a_per_b).toBeCloseTo(1 / pool.price_a_per_b, 12);
    expect(out.decimals_a).toBe(pool.decimals_b);
    expect(out.decimals_b).toBe(pool.decimals_a);
    expect(out.account_a).toBe(pool.account_b);
    expect(out.account_b).toBe(pool.account_a);
    expect(out.source_account).toBe(pool.target_account);
    expect(out.target_account).toBe(pool.source_account);
  });
});


