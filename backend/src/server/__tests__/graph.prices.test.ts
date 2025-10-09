import { describe, it, expect } from 'vitest';
import { getGraphSnapshot } from '../graph.js';
import { CONFIG } from '../../utils/config.js';

// We will mock peekRaydiumPools to inject a single AMM SOL/USDC edge
// A per 1 B orientation: price_a_per_b should be USDC per 1 SOL when A=USDC, B=SOL

describe('graph prices orientation - Raydium AMM forward uses normalized', () => {
  it('forward and reverse are reciprocal and near reference', async () => {
    const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const SOL = 'So11111111111111111111111111111111111111112';
    // Mock pools provider
    const poolsMod: any = await import('../pools.js');
    const fake: any = {
      amm: [{
        id: 'ray-amm-sol-usdc', dex: 'Raydium', pool_kind: 'amm',
        mint_a: USDC, mint_b: SOL,
        fee_bps: 25,
        price_a_per_b: 150, // 150 USDC per 1 SOL (normalized)
        liquidity_base: 1_000_000,
        amount_a_whole: 500_000,
        amount_b_whole: 4_000,
        liquidity_display: 80_0000,
      }],
      clmm: [],
    };
    (globalThis as any).__graphTestPools = { raydium: fake, orca: { amm: [], clmm: [] }, meteora: { amm: [], clmm: [] }, saber: { amm: [], clmm: [] }, meteora_balanced: { amm: [], clmm: [] } };
    // Mock Orca/Meteora providers empty
    const origPeekOrc = (poolsMod as any).peekOrcaPools;
    const origPeekMet = (poolsMod as any).peekMeteoraPools;
    try { (poolsMod as any).peekOrcaPools = () => ({ amm: [], clmm: [] }); } catch {}
    try { (poolsMod as any).peekMeteoraPools = () => ({ amm: [], clmm: [] }); } catch {}

    try {
      // Reduce scoping and TVL filters to ensure edges are built from fake pools
      const cfg: any = (await import('../../utils/config.js')).CONFIG;
      cfg.system.scopePools = false;
      cfg.system.scopePoolsMode = 'none';
      cfg.system.minAmmLiqBase = 0;
      cfg.system.minClmmLiquidity = 0;
      cfg.system.minDexOverlap = 1;
      const snap = await getGraphSnapshot(true);
      const edge = (snap.edges || []).find((e: any) => e.dex === 'Raydium' && e.source === USDC && e.target === SOL);
      const edgeRev = (snap.edges || []).find((e: any) => e.dex === 'Raydium' && e.source === SOL && e.target === USDC);
      // Graph edges store price_a_per_b for display and we add both forward and reverse with reciprocal.
      expect(edge).toBeTruthy();
      // Forward should be A per 1 B, which for USDC->SOL is USDC per 1 SOL ~ 150
      expect(edge?.price_a_per_b).toBeCloseTo(150, 8);
      // Reverse should be ~ 1/150
      expect(edgeRev?.price_a_per_b).toBeCloseTo(1 / 150, 8);
      // Product ~ 1
      if (edge && edgeRev) {
        const prod = Number(edge.price_a_per_b) * Number(edgeRev.price_a_per_b);
        expect(prod).toBeGreaterThan(0.98);
        expect(prod).toBeLessThan(1.02);
      }
    } finally {
      // Restore
      (globalThis as any).__graphTestPools = undefined;
      try { (poolsMod as any).peekOrcaPools = origPeekOrc; } catch {}
      try { (poolsMod as any).peekMeteoraPools = origPeekMet; } catch {}
    }
  });
});


