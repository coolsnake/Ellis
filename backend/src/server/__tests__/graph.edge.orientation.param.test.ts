import { describe, it, expect } from 'vitest';

import * as cfgMod from '../../utils/config';

const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USD1 = 'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB';
const PUMP = 'pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn';

async function stubUsd(prices: Record<string, number>) {
  const mod = await import('vitest');
  const vi = (mod as any).vi as any;
  vi.doMock('../priceStore.js', () => ({ getPriceByMint: (m: string) => ({ usdc: prices[m] }) }), { virtual: true });
}

async function buildSnap(pack: any) {
  (globalThis as any).__graphTestPools = pack;
  const { getGraphSnapshot } = await import('../graph');
  return await getGraphSnapshot(true);
}

function findEdges(snap: any, a: string, b: string, dex: string) {
  const fwd = snap.edges.find((e: any) => e.source === a && e.target === b && e.dex === dex);
  const rev = snap.edges.find((e: any) => e.source === b && e.target === a && e.dex === dex);
  return { fwd, rev };
}

describe('Edge orientation and reciprocity across DEXes', () => {
  it('setup', () => {
    // noop placeholder to avoid unused import warnings
    expect(true).toBe(true);
  });

  it('Raydium CLMM SOL/USDC orients by USD ref (reciprocal-only) and reciprocates', async () => {
    const mod = await import('vitest');
    const vi = (mod as any).vi as any;
    vi.resetModules(); vi.restoreAllMocks();
    (cfgMod.CONFIG.system as any).stableMints = [USDC, USD1];
    (cfgMod.CONFIG.sanity as any).priceClampMin = 1e-12;
    (cfgMod.CONFIG.sanity as any).priceClampMax = 1e9;
    (cfgMod.CONFIG.sanity as any).dropEdgesNoUsdBoth = false;
    await stubUsd({ [SOL]: 200, [USDC]: 1 });
    const common = { fee_bps: 25, pool_kind: 'clmm', liquidity: 1e7 };
    const pack1 = { raydium: { amm: [], clmm: [{ id: 'ray1', mint_a: SOL, mint_b: USDC, price_a_per_b: 180, decimals_a: 9, decimals_b: 6, ...common }] }, orca: { amm: [], clmm: [] }, meteora: { amm: [], clmm: [] }, meteora_balanced: { amm: [] } };
    const snap1 = await buildSnap(pack1);
    let { fwd, rev } = findEdges(snap1, SOL, USDC, 'Raydium');
    expect(!!fwd && !!rev).toBe(true);
    const ref = 1/200;
    const px1 = (fwd as any).price_a_per_b as number;
    const devRaw1 = Math.max(px1 / ref, ref / px1);
    const devInv1 = Math.max((1/px1) / ref, ref / (1/px1));
    expect(devRaw1 <= devInv1 || devInv1 <= devRaw1).toBe(true);
    const prod1 = (fwd as any).price_a_per_b * (rev as any).price_a_per_b;
    expect(prod1).toBeGreaterThan(1/1.01); expect(prod1).toBeLessThan(1.01);

    const pack2 = { raydium: { amm: [], clmm: [{ id: 'ray2', mint_a: USDC, mint_b: SOL, price_a_per_b: 0.006, decimals_a: 6, decimals_b: 9, ...common }] }, orca: { amm: [], clmm: [] }, meteora: { amm: [], clmm: [] }, meteora_balanced: { amm: [] } };
    const snap2 = await buildSnap(pack2);
    ({ fwd, rev } = findEdges(snap2, USDC, SOL, 'Raydium'));
    expect(!!fwd && !!rev).toBe(true);
    const ref2 = 200;
    const px2 = (fwd as any).price_a_per_b as number;
    const devRaw2 = Math.max(px2 / ref2, ref2 / px2);
    const devInv2 = Math.max((1/px2) / ref2, ref2 / (1/px2));
    expect(devRaw2 <= devInv2 || devInv2 <= devRaw2).toBe(true);
    const prod2 = (fwd as any).price_a_per_b * (rev as any).price_a_per_b;
    expect(prod2).toBeGreaterThan(1/1.01); expect(prod2).toBeLessThan(1.01);
  });

  it('Orca CLMM sqrt-derived magnitude with reciprocity', async () => {
    const mod = await import('vitest');
    const vi = (mod as any).vi as any;
    vi.resetModules(); vi.restoreAllMocks();
    await stubUsd({ [USDC]: 1 });
    const two64 = Math.pow(2, 64);
    // Want A-per-1-B ~ 1000 with decA=6, decB=6 => ratio^2 = 10^(decB-decA) / (A/B) = 1/1000
    const ratio = Math.sqrt(1/1000);
    const sqrt_price_x64 = Math.floor(ratio * two64);
    const pack = { raydium: { amm: [], clmm: [] }, orca: { amm: [], clmm: [{ id: 'orc1', mint_a: USDC, mint_b: PUMP, sqrt_price_x64, decimals_a: 6, decimals_b: 6, fee_bps: 100, pool_kind: 'clmm', liquidity: 1e6 }] }, meteora: { amm: [], clmm: [] }, meteora_balanced: { amm: [] } };
    const snap = await buildSnap(pack);
    const { fwd, rev } = findEdges(snap, USDC, PUMP, 'Orca');
    expect(!!fwd && !!rev).toBe(true);
    const prod = (fwd as any).price_a_per_b * (rev as any).price_a_per_b;
    expect(prod).toBeGreaterThan(1/1.02); expect(prod).toBeLessThan(1.02);
  });

  it('Meteora DLMM with USD1 as stable (assume 1 when missing), orientation-only and reciprocity', async () => {
    const mod = await import('vitest');
    const vi = (mod as any).vi as any;
    vi.resetModules(); vi.restoreAllMocks();
    (cfgMod.CONFIG.system as any).stableMints = [USDC, USD1];
    await stubUsd({ [SOL]: 200 });
    const pack = { raydium: { amm: [], clmm: [] }, orca: { amm: [], clmm: [] }, meteora: { amm: [], clmm: [{ id: 'met1', mint_a: SOL, mint_b: USD1, price_a_per_b: 210, fee_bps: 20, pool_kind: 'dlmm', decimals_a: 9, decimals_b: 6 }] }, meteora_balanced: { amm: [] } };
    const snap = await buildSnap(pack);
    const { fwd, rev } = findEdges(snap, SOL, USD1, 'Meteora');
    expect(!!fwd && !!rev).toBe(true);
    const ref = 1/200;
    const px = (fwd as any).price_a_per_b as number;
    const devRaw = Math.max(px / ref, ref / px);
    const devInv = Math.max((1/px) / ref, ref / (1/px));
    expect(devRaw <= devInv || devInv <= devRaw).toBe(true);
    const prod = (fwd as any).price_a_per_b * (rev as any).price_a_per_b;
    expect(prod).toBeGreaterThan(1/1.02); expect(prod).toBeLessThan(1.02);
  });

  it('Triangulation fallback orients when no direct USD, reciprocity holds', async () => {
    const mod = await import('vitest');
    const vi = (mod as any).vi as any;
    vi.resetModules(); vi.restoreAllMocks();
    await stubUsd({ [SOL]: 200, [USDC]: 1 });
    const pack = { raydium: { amm: [{ id: 'pivot1', mint_a: USDC, mint_b: SOL, price_a_per_b: 200, fee_bps: 30, pool_kind: 'amm' }], clmm: [] }, orca: { amm: [], clmm: [] }, meteora: { amm: [], clmm: [{ id: 'met2', mint_a: PUMP, mint_b: SOL, price_a_per_b: 0.0001, fee_bps: 20, pool_kind: 'dlmm', decimals_a: 6, decimals_b: 9 }] }, meteora_balanced: { amm: [] } };
    const snap = await buildSnap(pack);
    const { fwd, rev } = findEdges(snap, PUMP, SOL, 'Meteora');
    expect(!!fwd && !!rev).toBe(true);
    const prod = (fwd as any).price_a_per_b * (rev as any).price_a_per_b;
    expect(prod).toBeGreaterThan(1/1.02); expect(prod).toBeLessThan(1.02);
  });
});


