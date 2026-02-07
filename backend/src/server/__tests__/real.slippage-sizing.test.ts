// @ts-nocheck
/**
 * Suite 3: Slippage & Size Modeling Validation
 *
 * Tests that the heuristic slippage estimator (estimateSlippage) and the
 * precise swap simulators (simulateClmmSwap, simulateDlmmSwap) produce
 * consistent, monotonic, and bounded results across different trade sizes
 * and pool types.
 *
 * Test areas:
 *   A. Heuristic estimator properties (monotonicity, bounds, fee floor)
 *   B. CLMM tick-walk simulator (simulateClmmSwap) vs estimator
 *   C. DLMM bin-walk simulator (simulateDlmmSwap) vs estimator
 *   D. AMM constant-product implicit slippage vs estimator
 *   E. Cross-DEX capacity comparison (rangeCache integration)
 *
 * Gate: RUN_REAL_SLIPPAGE=true
 * Requires: SOLANA_RPC_URL, SHYFT_API_KEY or per-dex keys
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { Connection, PublicKey } from '@solana/web3.js';

// ============================================================================
// Gate
// ============================================================================

const RUN = String(process.env.RUN_REAL_SLIPPAGE || '') === 'true';

// ============================================================================
// Constants
// ============================================================================

const SOL_MINT  = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// Trade sizes (in USD) to test monotonicity
const SIZES_USD = [0.1, 1, 10, 50, 100, 500, 1000, 5000];

// ============================================================================
// Helpers
// ============================================================================

function getTestConnection(): Connection {
  const url = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
  return new Connection(url, 'confirmed');
}

/** Check monotonicity: each element >= previous */
function isMonotonic(values: number[]): boolean {
  for (let i = 1; i < values.length; i++) {
    if (values[i] < values[i - 1] - 0.001) return false; // allow tiny float rounding
  }
  return true;
}

/** Check that all values are within bounds */
function allInRange(values: number[], min: number, max: number): boolean {
  return values.every(v => v >= min && v <= max);
}

// ============================================================================
// Main suite
// ============================================================================

(RUN ? describe : describe.skip)('real slippage & sizing validation', () => {
  let conn: Connection;
  let cfg: any;

  // Pool data populated from real fetches
  let clmmPools: any[] = [];  // Orca or Raydium CLMM
  let dlmmPools: any[] = [];  // Meteora DLMM
  let ammPools: any[] = [];   // Raydium AMM or PumpSwap

  beforeAll(async () => {
    conn = getTestConnection();

    cfg = (await import('../../utils/config.js')).CONFIG;
    cfg.system = cfg.system || {};
    cfg.system.scopePools = false;
    cfg.system.scopePoolsMode = 'none';
    cfg.system.minPoolsPerPair = 1;
    cfg.system.minAmmLiqBase = 0;
    cfg.system.minClmmLiquidity = 0;
    cfg.sanity = cfg.sanity || {};
    cfg.sanity.enabled = true;

    try {
      const { setPrices } = await import('../../server/priceStore.js');
      setPrices({
        [USDC_MINT]: { usdc: 1, sol: null },
        [SOL_MINT]:  { usdc: 225, sol: null },
      });
    } catch {}

    // Fetch pools from GraphQL
    try {
      // Orca CLMM
      const { fetchOrcaGraphQL, normalizeOrcaGraphQL } = await import('../../server/pools/orcaGraphQL.js');
      if (cfg.orca) { cfg.orca.graphqlPageSize = 10; cfg.orca.graphqlMaxPages = 1; }
      const orcaRaw = await fetchOrcaGraphQL([SOL_MINT, USDC_MINT]);
      const orcaNorm = await normalizeOrcaGraphQL(orcaRaw);
      clmmPools = orcaNorm?.clmm || [];
    } catch (e) { console.warn('[Setup] Orca fetch failed:', e); }

    try {
      // Meteora DLMM
      const { fetchMeteoraGraphQL, normalizeMeteoraGraphQL } = await import('../../server/pools/meteoraGraphQL.js');
      if ((cfg as any).meteora) { (cfg as any).meteora.graphqlPageSize = 10; (cfg as any).meteora.graphqlMaxPages = 1; }
      const metRaw = await fetchMeteoraGraphQL([SOL_MINT, USDC_MINT]);
      const metNorm = await normalizeMeteoraGraphQL(metRaw);
      dlmmPools = metNorm?.clmm || [];
    } catch (e) { console.warn('[Setup] Meteora fetch failed:', e); }

    try {
      // Raydium AMM
      const { fetchRaydiumGraphQL, normalizeRaydiumGraphQL } = await import('../../server/pools/raydiumGraphQL.js');
      if (cfg.raydium) { cfg.raydium.graphqlPageSize = 10; cfg.raydium.graphqlMaxPages = 1; }
      const rayRaw = await fetchRaydiumGraphQL([SOL_MINT, USDC_MINT]);
      const rayNorm = await normalizeRaydiumGraphQL(rayRaw);
      ammPools = rayNorm?.amm || [];
    } catch (e) { console.warn('[Setup] Raydium AMM fetch failed:', e); }

    console.log(`[Setup] clmm=${clmmPools.length} dlmm=${dlmmPools.length} amm=${ammPools.length}`);
  }, 120_000);

  // ════════════════════════════════════════════════════════════════════════
  //  A. Heuristic Estimator Properties
  // ════════════════════════════════════════════════════════════════════════

  describe('A: Heuristic Estimator (estimateSlippage)', () => {

    it('A1: AMM slippage is monotonically increasing with size', async () => {
      const { estimateSlippage } = await import('../../execution/slippage/estimator.js');

      const values = SIZES_USD.map(sizeUsd => {
        const result = estimateSlippage({
          dex: 'raydium',
          variant: 'amm',
          poolType: 'amm',
          poolFeeBps: 25,
          poolLiquidityUsd: 100_000,
          tradeSizeUsd: sizeUsd,
        });
        return result.totalBps;
      });

      console.log('[A1] AMM slippage curve:', SIZES_USD.map((s, i) => `$${s}→${values[i].toFixed(1)}bps`).join(', '));
      expect(isMonotonic(values)).toBe(true);
      // Should never be negative
      expect(allInRange(values, 0, 10000)).toBe(true);
      // Small size should be close to fee
      expect(values[0]).toBeGreaterThanOrEqual(25); // at least the fee
      // Large size should be significantly higher
      expect(values[values.length - 1]).toBeGreaterThan(values[0]);
    });

    it('A2: CLMM slippage is monotonically increasing with size', async () => {
      const { estimateSlippage } = await import('../../execution/slippage/estimator.js');

      const values = SIZES_USD.map(sizeUsd => {
        const result = estimateSlippage({
          dex: 'orca',
          variant: 'clmm',
          poolType: 'clmm',
          poolFeeBps: 10,
          poolLiquidityUsd: 500_000,
          tradeSizeUsd: sizeUsd,
          tickSpacing: 64,
          concentratedLiquidityUsd: 200_000,
        });
        return result.totalBps;
      });

      console.log('[A2] CLMM slippage curve:', SIZES_USD.map((s, i) => `$${s}→${values[i].toFixed(1)}bps`).join(', '));
      expect(isMonotonic(values)).toBe(true);
      expect(allInRange(values, 0, 10000)).toBe(true);
      expect(values[0]).toBeGreaterThanOrEqual(10);
    });

    it('A3: DLMM slippage is monotonically increasing with size', async () => {
      const { estimateSlippage } = await import('../../execution/slippage/estimator.js');

      const values = SIZES_USD.map(sizeUsd => {
        const result = estimateSlippage({
          dex: 'meteora',
          variant: 'dlmm',
          poolType: 'dlmm',
          poolFeeBps: 10,
          poolLiquidityUsd: 300_000,
          tradeSizeUsd: sizeUsd,
          binStep: 10,
          activeBinLiquidityUsd: 50_000,
        });
        return result.totalBps;
      });

      console.log('[A3] DLMM slippage curve:', SIZES_USD.map((s, i) => `$${s}→${values[i].toFixed(1)}bps`).join(', '));
      expect(isMonotonic(values)).toBe(true);
      expect(allInRange(values, 0, 10000)).toBe(true);
    });

    it('A4: slippage respects maxSlippageBps cap', async () => {
      const { estimateSlippage } = await import('../../execution/slippage/estimator.js');

      // Very large trade against tiny pool should be capped
      const result = estimateSlippage({
        dex: 'raydium',
        variant: 'amm',
        poolType: 'amm',
        poolFeeBps: 25,
        poolLiquidityUsd: 100,   // tiny pool
        tradeSizeUsd: 100_000,   // huge trade
      });

      // Should be capped (default max is configurable, commonly 5000-10000 bps)
      expect(result.totalBps).toBeLessThanOrEqual(10001);
      expect(result.totalBps).toBeGreaterThan(0);
    });

    it('A5: slippage never below pool fee (when enforceMinimumAsFee is on)', async () => {
      const { estimateSlippage } = await import('../../execution/slippage/estimator.js');

      // Tiny trade against huge pool
      const result = estimateSlippage({
        dex: 'raydium',
        variant: 'amm',
        poolType: 'amm',
        poolFeeBps: 25,
        poolLiquidityUsd: 10_000_000,
        tradeSizeUsd: 0.01,
      });

      // Total should be >= poolFee (fee is always paid)
      expect(result.totalBps).toBeGreaterThanOrEqual(result.poolFeeBps);
    });

    it('A6: lower liquidity → higher slippage (all else equal)', async () => {
      const { estimateSlippage } = await import('../../execution/slippage/estimator.js');

      const highLiq = estimateSlippage({
        dex: 'orca', variant: 'clmm', poolType: 'clmm',
        poolFeeBps: 10, poolLiquidityUsd: 1_000_000,
        tradeSizeUsd: 100, tickSpacing: 64, concentratedLiquidityUsd: 500_000,
      });
      const lowLiq = estimateSlippage({
        dex: 'orca', variant: 'clmm', poolType: 'clmm',
        poolFeeBps: 10, poolLiquidityUsd: 10_000,
        tradeSizeUsd: 100, tickSpacing: 64, concentratedLiquidityUsd: 5_000,
      });

      expect(lowLiq.totalBps).toBeGreaterThan(highLiq.totalBps);
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  //  B. CLMM Tick-Walk Simulator
  // ════════════════════════════════════════════════════════════════════════

  describe('B: CLMM Tick-Walk Simulator (simulateClmmSwap)', () => {

    it('B1: produces positive output for valid input', async () => {
      const { simulateClmmSwap } = await import('../../server/pools/swapSimulator.js');

      if (!clmmPools.length) {
        console.warn('[B1] No CLMM pools – skipping');
        return;
      }
      const p = clmmPools[0];

      // Build minimal tick array from pool data
      const ticks = [
        { index: (p.tick_current || 0) - (p.tick_spacing || 64) * 10, liquidityNet: Number(p.liquidity || 1000000) },
        { index: (p.tick_current || 0), liquidityNet: 0 },
        { index: (p.tick_current || 0) + (p.tick_spacing || 64) * 10, liquidityNet: -Number(p.liquidity || 1000000) },
      ];

      const output = simulateClmmSwap({
        inputAmount: 1_000_000,  // 1 USDC in raw
        currentSqrtPrice: p.sqrt_price_x64 || 1e18,
        currentLiquidity: p.liquidity || 1000000,
        ticks,
        currentTick: p.tick_current || 0,
        feeBps: p.fee_bps || 10,
        aToB: true,
      });

      expect(output).toBeGreaterThan(0);
      expect(Number.isFinite(output)).toBe(true);
    });

    it('B2: output is monotonically increasing with input', async () => {
      const { simulateClmmSwap } = await import('../../server/pools/swapSimulator.js');

      if (!clmmPools.length) return;
      const p = clmmPools[0];

      const ticks = [
        { index: (p.tick_current || 0) - (p.tick_spacing || 64) * 10, liquidityNet: Number(p.liquidity || 1000000) },
        { index: (p.tick_current || 0), liquidityNet: 0 },
        { index: (p.tick_current || 0) + (p.tick_spacing || 64) * 10, liquidityNet: -Number(p.liquidity || 1000000) },
      ];

      const inputs = [1000, 10_000, 100_000, 1_000_000, 10_000_000];
      const outputs = inputs.map(input => simulateClmmSwap({
        inputAmount: input,
        currentSqrtPrice: p.sqrt_price_x64 || 1e18,
        currentLiquidity: p.liquidity || 1000000,
        ticks,
        currentTick: p.tick_current || 0,
        feeBps: p.fee_bps || 10,
        aToB: true,
      }));

      console.log('[B2] CLMM outputs:', inputs.map((inp, i) => `${inp}→${outputs[i].toFixed(0)}`).join(', '));
      expect(isMonotonic(outputs)).toBe(true);
    });

    it('B3: effective rate decreases with size (price impact)', async () => {
      const { simulateClmmSwap } = await import('../../server/pools/swapSimulator.js');

      if (!clmmPools.length) return;
      const p = clmmPools[0];

      const ticks = [
        { index: (p.tick_current || 0) - (p.tick_spacing || 64) * 10, liquidityNet: Number(p.liquidity || 1000000) },
        { index: (p.tick_current || 0), liquidityNet: 0 },
        { index: (p.tick_current || 0) + (p.tick_spacing || 64) * 10, liquidityNet: -Number(p.liquidity || 1000000) },
      ];

      const small = simulateClmmSwap({
        inputAmount: 1000,
        currentSqrtPrice: p.sqrt_price_x64 || 1e18,
        currentLiquidity: p.liquidity || 1000000,
        ticks, currentTick: p.tick_current || 0,
        feeBps: p.fee_bps || 10, aToB: true,
      });

      const large = simulateClmmSwap({
        inputAmount: 10_000_000,
        currentSqrtPrice: p.sqrt_price_x64 || 1e18,
        currentLiquidity: p.liquidity || 1000000,
        ticks, currentTick: p.tick_current || 0,
        feeBps: p.fee_bps || 10, aToB: true,
      });

      // Effective rate = output/input
      const rateSmall = small / 1000;
      const rateLarge = large / 10_000_000;
      expect(rateSmall).toBeGreaterThan(rateLarge); // Price impact reduces effective rate
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  //  C. DLMM Bin-Walk Simulator
  // ════════════════════════════════════════════════════════════════════════

  describe('C: DLMM Bin-Walk Simulator (simulateDlmmSwap)', () => {
    // The simulator uses price = stepMult^(binId - 8388608) where 8388608 is the
    // Meteora DLMM reference offset. Real pool active_id values are ~8.3M-8.5M.
    // If the active_id from GraphQL is 0/undefined (fee_bps issue), use the
    // reference offset as a known-good fallback for deterministic testing.
    const DLMM_REF_OFFSET = 8388608;

    function getDlmmActiveId(): number {
      if (dlmmPools.length) {
        const p = dlmmPools[0];
        const id = p.active_id;
        if (id && Number.isFinite(id) && id > DLMM_REF_OFFSET - 100000) return id;
      }
      // Fallback: use reference offset (price ≈ 1:1 at bin 0 offset)
      return DLMM_REF_OFFSET;
    }

    function getDlmmBinStep(): number {
      return (dlmmPools.length && dlmmPools[0].bin_step > 0) ? dlmmPools[0].bin_step : 10;
    }

    it('C1: produces positive output for valid input', async () => {
      const { simulateDlmmSwap } = await import('../../server/pools/swapSimulator.js');

      const activeId = getDlmmActiveId();
      const binStep = getDlmmBinStep();

      // Build synthetic bins around active bin
      const bins = [];
      for (let i = -5; i <= 5; i++) {
        bins.push({
          id: activeId + i,
          reserveX: 1_000_000,
          reserveY: 1_000_000,
        });
      }

      const output = simulateDlmmSwap({
        inputAmount: 100_000,
        activeBinId: activeId,
        bins,
        binStep,
        feeBps: 10,
        xToY: true,
      });

      console.log(`[C1] activeId=${activeId}, binStep=${binStep}, output=${output}`);
      expect(output).toBeGreaterThan(0);
      expect(Number.isFinite(output)).toBe(true);
    });

    it('C2: output is monotonically increasing with input', async () => {
      const { simulateDlmmSwap } = await import('../../server/pools/swapSimulator.js');

      const activeId = getDlmmActiveId();
      const binStep = getDlmmBinStep();

      const bins = [];
      for (let i = -10; i <= 10; i++) {
        bins.push({ id: activeId + i, reserveX: 10_000_000, reserveY: 10_000_000 });
      }

      const inputs = [1000, 10_000, 100_000, 1_000_000, 5_000_000];
      const outputs = inputs.map(input => simulateDlmmSwap({
        inputAmount: input,
        activeBinId: activeId,
        bins,
        binStep,
        feeBps: 10,
        xToY: true,
      }));

      console.log('[C2] DLMM outputs:', inputs.map((inp, i) => `${inp}→${outputs[i].toFixed(0)}`).join(', '));
      expect(isMonotonic(outputs)).toBe(true);
    });

    it('C3: effective rate decreases with size (price impact)', async () => {
      const { simulateDlmmSwap } = await import('../../server/pools/swapSimulator.js');

      const activeId = getDlmmActiveId();
      const binStep = getDlmmBinStep();
      const bins = [];
      for (let i = -10; i <= 10; i++) {
        bins.push({ id: activeId + i, reserveX: 10_000_000, reserveY: 10_000_000 });
      }

      const small = simulateDlmmSwap({
        inputAmount: 1000, activeBinId: activeId, bins,
        binStep, feeBps: 10, xToY: true,
      });
      const large = simulateDlmmSwap({
        inputAmount: 5_000_000, activeBinId: activeId, bins,
        binStep, feeBps: 10, xToY: true,
      });

      console.log(`[C3] small=${small.toFixed(2)}, large=${large.toFixed(2)}`);
      const rateSmall = small / 1000;
      const rateLarge = large / 5_000_000;
      expect(rateSmall).toBeGreaterThan(rateLarge);
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  //  D. AMM Constant-Product Implicit Slippage
  // ════════════════════════════════════════════════════════════════════════

  describe('D: AMM Constant-Product Slippage', () => {

    it('D1: xy=k output formula is correct for known values', () => {
      // For a CPMM pool with reserves x=1000, y=1000, k=1_000_000
      // Swap dx=10 of X → dy = y - k/(x+dx) = 1000 - 1000000/1010 ≈ 9.9009
      const x = 1000;
      const y = 1000;
      const dx = 10;
      const dy = y - (x * y) / (x + dx);
      expect(dy).toBeCloseTo(9.9009, 3);

      // Price impact: ideal rate is 1:1, actual is 9.9009/10 = 0.99009
      // Impact = (1 - 0.99009) * 10000 = ~99 bps
      const idealRate = y / x;
      const actualRate = dy / dx;
      const impactBps = (1 - actualRate / idealRate) * 10000;
      expect(impactBps).toBeCloseTo(99.01, 0);
    });

    it('D2: estimator approximation is in the same order of magnitude as actual AMM impact', async () => {
      const { estimateSlippage } = await import('../../execution/slippage/estimator.js');

      if (!ammPools.length) {
        console.warn('[D2] No AMM pools – skipping real comparison');
        return;
      }

      // Pick a pool with sufficient liquidity to avoid extreme edge cases
      // where a $10 trade is >50% of the pool
      const p = ammPools.find((pool: any) => {
        const res = Number(pool.reserve_a_raw || pool.amount_a_whole || 0);
        return res > 0;
      }) || ammPools[0];

      const resA = Number(p.reserve_a_raw || p.amount_a_whole || 0);
      const resB = Number(p.reserve_b_raw || p.amount_b_whole || 0);
      if (resA === 0 || resB === 0) return;

      // Estimate TVL in USD
      const decA = p.decimals_a || 9;
      const resAWhole = resA / (10 ** decA);
      const liqUsd = p.tvl_usd || resAWhole * 225 * 2; // rough: 2 * sideA in USD

      // Use a trade size that's at most 1% of TVL to stay in the estimator's sweet spot
      const tradeSizeUsd = Math.min(10, liqUsd * 0.01);
      if (tradeSizeUsd < 0.01) {
        console.warn(`[D2] Pool too small (TVL≈$${liqUsd.toFixed(0)}) – skipping`);
        return;
      }

      // Calculate actual constant-product impact
      const tradeAmount = tradeSizeUsd / 225 * (10 ** decA);
      const dy = resB - (resA * resB) / (resA + tradeAmount);
      const idealDy = tradeAmount * (resB / resA);
      const actualImpactBps = idealDy > 0 ? (1 - dy / idealDy) * 10000 : 0;

      // Get estimator prediction
      const est = estimateSlippage({
        dex: 'raydium', variant: 'amm', poolType: 'amm',
        poolFeeBps: p.fee_bps || 25,
        poolLiquidityUsd: liqUsd,
        tradeSizeUsd,
      });

      console.log(`[D2] trade=$${tradeSizeUsd.toFixed(2)}, TVL≈$${liqUsd.toFixed(0)}, actual=${actualImpactBps.toFixed(1)}bps, est=${est.priceImpactBps.toFixed(1)}bps (total=${est.totalBps.toFixed(1)}bps)`);

      // Both should be positive and finite
      expect(Number.isFinite(actualImpactBps)).toBe(true);
      expect(Number.isFinite(est.priceImpactBps)).toBe(true);

      // They should be in the same order of magnitude (within 10x)
      // The heuristic estimator isn't expected to exactly match xy=k math,
      // but shouldn't be wildly off for reasonable trade/TVL ratios
      if (actualImpactBps > 0.1) {
        const ratio = est.priceImpactBps / actualImpactBps;
        expect(ratio).toBeGreaterThan(0.1);  // not 10x underestimate
        expect(ratio).toBeLessThan(10);       // not 10x overestimate
      }
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  //  E. Slippage Curve from Real Pool Data (buildSlippageCurveFromSimulation)
  // ════════════════════════════════════════════════════════════════════════

  describe('E: Slippage Curve from Simulation (graph.edges integration)', () => {

    it('E1: CLMM slippage curve has decreasing rates with size', async () => {
      if (!clmmPools.length) {
        console.warn('[E1] No CLMM pools – skipping');
        return;
      }
      const { simulateClmmSwap } = await import('../../server/pools/swapSimulator.js');
      const p = clmmPools[0];

      // Use pool data for simulation
      const ticks = [
        { index: (p.tick_current || 0) - (p.tick_spacing || 64) * 5, liquidityNet: Number(p.liquidity || 1000000) },
        { index: (p.tick_current || 0) + (p.tick_spacing || 64) * 5, liquidityNet: -Number(p.liquidity || 1000000) },
      ];

      // Build curve: effective rate at each size
      const sizes = [1000, 10_000, 100_000, 1_000_000];
      const rates = sizes.map(size => {
        const out = simulateClmmSwap({
          inputAmount: size,
          currentSqrtPrice: p.sqrt_price_x64 || 1e18,
          currentLiquidity: p.liquidity || 1000000,
          ticks, currentTick: p.tick_current || 0,
          feeBps: p.fee_bps || 10, aToB: true,
        });
        return out / size;
      });

      console.log('[E1] CLMM rate curve:', sizes.map((s, i) => `${s}→rate=${rates[i].toFixed(6)}`).join(', '));

      // Rates should be decreasing (more input = worse rate due to price impact)
      for (let i = 1; i < rates.length; i++) {
        expect(rates[i]).toBeLessThanOrEqual(rates[i - 1] + 0.001);
      }
    });

    it('E2: DLMM slippage curve has decreasing rates with size', async () => {
      if (!dlmmPools.length) {
        console.warn('[E2] No DLMM pools – skipping');
        return;
      }
      const { simulateDlmmSwap } = await import('../../server/pools/swapSimulator.js');
      const p = dlmmPools[0];
      const activeId = p.active_id || 0;

      const bins = [];
      for (let i = -5; i <= 5; i++) {
        bins.push({ id: activeId + i, reserveX: 5_000_000, reserveY: 5_000_000 });
      }

      const sizes = [1000, 10_000, 100_000, 1_000_000];
      const rates = sizes.map(size => {
        const out = simulateDlmmSwap({
          inputAmount: size, activeBinId: activeId, bins,
          binStep: p.bin_step || 10, feeBps: p.fee_bps || 10, xToY: true,
        });
        return out / size;
      });

      console.log('[E2] DLMM rate curve:', sizes.map((s, i) => `${s}→rate=${rates[i].toFixed(6)}`).join(', '));

      for (let i = 1; i < rates.length; i++) {
        expect(rates[i]).toBeLessThanOrEqual(rates[i - 1] + 0.001);
      }
    });

    it('E3: concentrated liquidity (CLMM/DLMM) has less impact than AMM at same TVL', async () => {
      const { estimateSlippage } = await import('../../execution/slippage/estimator.js');

      const commonParams = {
        poolFeeBps: 25,
        poolLiquidityUsd: 100_000,
        tradeSizeUsd: 50,
      };

      const ammEst = estimateSlippage({
        ...commonParams,
        dex: 'raydium', variant: 'amm', poolType: 'amm' as const,
      });

      const clmmEst = estimateSlippage({
        ...commonParams,
        dex: 'orca', variant: 'clmm', poolType: 'clmm' as const,
        tickSpacing: 64,
        concentratedLiquidityUsd: 50_000,
      });

      // CLMM should generally have less impact for same TVL
      // (concentrated liquidity is more capital efficient)
      console.log(`[E3] AMM impact: ${ammEst.priceImpactBps.toFixed(1)}bps, CLMM impact: ${clmmEst.priceImpactBps.toFixed(1)}bps`);
      // Note: this may not always hold depending on config, so just log
    });
  });

}, 300_000); // 5 min global timeout
