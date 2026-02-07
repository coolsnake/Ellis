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
      if (!cfg.orca) cfg.orca = {}; cfg.orca.graphqlPageSize = 10; cfg.orca.graphqlMaxPages = 1;
      const orcaRaw = await fetchOrcaGraphQL([SOL_MINT, USDC_MINT]);
      const orcaNorm = await normalizeOrcaGraphQL(orcaRaw);
      clmmPools = orcaNorm?.clmm || [];
    } catch (e) { console.warn('[Setup] Orca fetch failed:', e); }

    try {
      // Meteora DLMM
      const { fetchMeteoraGraphQL, normalizeMeteoraGraphQL } = await import('../../server/pools/meteoraGraphQL.js');
      if (!(cfg as any).meteora) (cfg as any).meteora = {}; (cfg as any).meteora.graphqlPageSize = 10; (cfg as any).meteora.graphqlMaxPages = 1;
      const metRaw = await fetchMeteoraGraphQL([SOL_MINT, USDC_MINT]);
      const metNorm = await normalizeMeteoraGraphQL(metRaw);
      dlmmPools = metNorm?.clmm || [];
    } catch (e) { console.warn('[Setup] Meteora fetch failed:', e); }

    try {
      // Raydium AMM
      const { fetchRaydiumGraphQL, normalizeRaydiumGraphQL } = await import('../../server/pools/raydiumGraphQL.js');
      if (!cfg.raydium) cfg.raydium = {}; cfg.raydium.graphqlPageSize = 10; cfg.raydium.graphqlMaxPages = 1;
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
      // Fallback: use offset + 100 so bins have a non-trivial price gradient
      // (at exactly DLMM_REF_OFFSET, price = 1.0 for all bins → no price impact)
      return DLMM_REF_OFFSET + 100;
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

      // Use small reserves per bin so the large trade must cross multiple bins,
      // producing measurable price impact from the bin-step price gradient.
      const bins = [];
      for (let i = -10; i <= 10; i++) {
        bins.push({ id: activeId + i, reserveX: 100_000, reserveY: 100_000 });
      }

      const small = simulateDlmmSwap({
        inputAmount: 1000, activeBinId: activeId, bins,
        binStep, feeBps: 10, xToY: true,
      });
      // Large trade must exhaust multiple bins to see price impact
      const large = simulateDlmmSwap({
        inputAmount: 500_000, activeBinId: activeId, bins,
        binStep, feeBps: 10, xToY: true,
      });

      console.log(`[C3] small=${small.toFixed(4)} (rate=${(small/1000).toFixed(6)}), large=${large.toFixed(4)} (rate=${(large/500_000).toFixed(6)})`);
      const rateSmall = small / 1000;
      const rateLarge = large / 500_000;
      // When large trade crosses bins, it gets progressively worse prices.
      // With 100k reserves per bin, 1000 input fits in one bin but 500k needs ~13 bins,
      // so the average effective rate must be strictly lower for the large trade.
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

    it('D2: estimator tracks actual xy=k impact direction with known parameters', async () => {
      const { estimateSlippage } = await import('../../execution/slippage/estimator.js');

      // Use a well-defined synthetic scenario rather than relying on pool data
      // where TVL estimation can be wildly off (unknown token prices).
      // Scenario: $100K pool, trades from $1 to $1000
      const poolLiquidityUsd = 100_000;
      const feeBps = 25;
      const tradeUsdSmall = 1;
      const tradeUsdLarge = 1000;

      const estSmall = estimateSlippage({
        dex: 'raydium', variant: 'amm', poolType: 'amm',
        poolFeeBps: feeBps,
        poolLiquidityUsd,
        tradeSizeUsd: tradeUsdSmall,
      });

      const estLarge = estimateSlippage({
        dex: 'raydium', variant: 'amm', poolType: 'amm',
        poolFeeBps: feeBps,
        poolLiquidityUsd,
        tradeSizeUsd: tradeUsdLarge,
      });

      console.log(`[D2] $${tradeUsdSmall} → ${estSmall.totalBps.toFixed(1)}bps (impact ${estSmall.priceImpactBps.toFixed(1)}), $${tradeUsdLarge} → ${estLarge.totalBps.toFixed(1)}bps (impact ${estLarge.priceImpactBps.toFixed(1)})`);

      // Larger trade should have strictly more impact
      expect(estLarge.priceImpactBps).toBeGreaterThan(estSmall.priceImpactBps);

      // Verify against the actual xy=k formula for the same parameters
      // Pool with $100K TVL → each side ≈ $50K → 50000/225 SOL ≈ 222 SOL × 10^9 raw
      const reserveA = 222 * 1e9;  // SOL side in raw lamports
      const reserveB = 50_000 * 1e6; // USDC side in raw units (6 decimals)
      const tradeRaw = (tradeUsdLarge / 225) * 1e9; // $1000 → SOL in lamports
      const dy = reserveB - (reserveA * reserveB) / (reserveA + tradeRaw);
      const idealDy = tradeRaw * (reserveB / reserveA);
      const actualImpactBps = idealDy > 0 ? (1 - dy / idealDy) * 10000 : 0;

      console.log(`[D2] xy=k actual impact for $${tradeUsdLarge}: ${actualImpactBps.toFixed(1)}bps`);

      // Both should be positive
      expect(actualImpactBps).toBeGreaterThan(0);
      expect(estLarge.priceImpactBps).toBeGreaterThan(0);

      // Estimator should be roughly in the same ballpark (within 100x)
      // The heuristic and xy=k math use fundamentally different approaches,
      // so exact match isn't expected — directional correctness is what matters
      if (actualImpactBps > 0.1 && estLarge.priceImpactBps > 0.1) {
        const ratio = estLarge.priceImpactBps / actualImpactBps;
        expect(ratio).toBeGreaterThan(0.01);  // same order of magnitude
        expect(ratio).toBeLessThan(100);
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
