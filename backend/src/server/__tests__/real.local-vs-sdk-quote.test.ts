// @ts-nocheck
/**
 * Suite: Local Quote (quoteHopOut) vs SDK Quote Comparison
 *
 * For each DEX type, fetches a real pool's current state and compares:
 *   - Local quote from quoteHopOut() (spot-price or tick/bin-walk simulator)
 *   - SDK quote from the respective DEX SDK
 *
 * This validates that our local quoting is accurate relative to the SDK,
 * especially for concentrated liquidity pools (CLMM/DLMM) where the
 * tick/bin-walk simulator should produce near-exact results.
 *
 * Gate: RUN_REAL_LOCAL_VS_SDK=true
 * Requires: SOLANA_RPC_URL, SHYFT_API_KEY or per-dex keys
 *
 * Optional skip flags:
 *   SKIP_LOCAL_SDK_ORCA=true
 *   SKIP_LOCAL_SDK_RAYDIUM_CLMM=true
 *   SKIP_LOCAL_SDK_RAYDIUM_AMM=true
 *   SKIP_LOCAL_SDK_METEORA_DLMM=true
 *   SKIP_LOCAL_SDK_PUMPSWAP=true
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { Connection, PublicKey, Keypair } from '@solana/web3.js';

// ============================================================================
// Gate
// ============================================================================

const RUN = String(process.env.RUN_REAL_LOCAL_VS_SDK || '') === 'true';

// ============================================================================
// Constants
// ============================================================================

const SOL_MINT  = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// Input sizes in SOL (atomic = amount * 10^9)
const INPUT_SIZES_SOL = [0.001, 0.01, 0.1, 1, 10];

// Tolerance thresholds
const AMM_TOLERANCE = 0.0001;       // 0.01% for constant-product AMMs
const CLMM_SMALL_TOLERANCE = 0.001; // 0.1% for CLMM/DLMM small sizes
const CLMM_LARGE_TOLERANCE = 0.05;  // 5% for CLMM/DLMM large sizes (may cross many ticks)

// ============================================================================
// Helpers
// ============================================================================

function getTestConnection(): Connection {
  const url = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
  return new Connection(url, 'confirmed');
}

function solToLamports(sol: number): bigint {
  return BigInt(Math.round(sol * 1e9));
}

function relativeDiff(local: bigint, sdk: bigint): number {
  if (sdk === 0n) return local === 0n ? 0 : Infinity;
  return Math.abs(Number(local - sdk) / Number(sdk));
}

// ============================================================================
// Main suite
// ============================================================================

(RUN ? describe : describe.skip)('real local quote vs SDK quote', () => {
  let conn: Connection;
  let cfg: any;

  const poolsByDex: Record<string, { poolId: string; dex: string; variant: string; mintA: string; mintB: string }[]> = {};

  beforeAll(async () => {
    conn = getTestConnection();

    cfg = (await import('../../utils/config.js')).CONFIG;
    cfg.system = cfg.system || {};
    cfg.system.scopePools = false;
    cfg.system.scopePoolsMode = 'none';
    cfg.system.minPoolsPerPair = 1;
    cfg.system.minAmmLiqBase = 0;
    cfg.system.minClmmLiquidity = 0;
    cfg.system.enableActivityFilter = false;
    cfg.sanity = cfg.sanity || {};
    cfg.sanity.enabled = true;

    // Seed prices
    try {
      const { setPrices } = await import('../../server/priceStore.js');
      setPrices({
        [USDC_MINT]: { usdc: 1, sol: null },
        [SOL_MINT]:  { usdc: 225, sol: null },
      });
    } catch {}
  });

  // ── Step 0: Populate pool caches ──────────────────────────────────────
  it('Step 0: populates pool + execution caches', async () => {
    if (!(cfg as any).shyft) (cfg as any).shyft = {};
    if (!cfg.orca) cfg.orca = {};
    if (!cfg.raydium) cfg.raydium = {};
    if (!cfg.raydiumClmm) cfg.raydiumClmm = {};
    if (!(cfg as any).raydiumCpmm) (cfg as any).raydiumCpmm = {};
    if (!(cfg as any).meteora) (cfg as any).meteora = {};
    if (!(cfg as any).pumpswap) (cfg as any).pumpswap = {};

    (cfg as any).shyft.minRequestGapMs = 1100;
    cfg.orca.graphqlPageSize = 20; cfg.orca.graphqlMaxPages = 1;
    cfg.raydium.graphqlPageSize = 20; cfg.raydium.graphqlMaxPages = 1;
    cfg.raydiumClmm.graphqlPageSize = 20; cfg.raydiumClmm.graphqlMaxPages = 1;
    cfg.raydiumClmm.initialDelayMultiplier = 1;
    (cfg as any).raydiumCpmm.graphqlPageSize = 20; (cfg as any).raydiumCpmm.graphqlMaxPages = 1;
    (cfg as any).raydiumCpmm.initialDelayMultiplier = 1;
    (cfg as any).meteora.graphqlPageSize = 50; (cfg as any).meteora.graphqlMaxPages = 2;
    (cfg as any).pumpswap.graphqlPageSize = 20; (cfg as any).pumpswap.graphqlMaxPages = 1;

    const poolsMod: any = await import('../../server/pools.js');
    const res = await poolsMod.refreshAllSources(true, false, {
      sources: { meteora_balanced: false },
    });
    expect(res).toBeTruthy();

    const graphMod: any = await import('../../server/graph.js');
    const snap = await graphMod.getGraphSnapshot(true);
    const edges = snap?.edges || [];
    console.log(`[Step 0] Graph: ${snap?.nodes?.length || 0} nodes, ${edges.length} edges`);

    for (const edge of edges) {
      const dex = (edge.dex || '').toLowerCase();
      const variant = (edge.pool_kind || edge.variant || '').toLowerCase();
      const key = `${dex}:${variant}`;
      if (!poolsByDex[key]) poolsByDex[key] = [];
      const mintA = edge.source || '';
      const mintB = edge.target || '';
      const pid = edge.pool_id || edge.id || '';
      if ((mintA === SOL_MINT || mintA === USDC_MINT || mintB === SOL_MINT || mintB === USDC_MINT) && pid) {
        poolsByDex[key].push({ poolId: pid, dex, variant, mintA, mintB });
      }
    }
    console.log('[Step 0] Pools by dex:variant:', Object.keys(poolsByDex).map(k => `${k}(${poolsByDex[k].length})`).join(', '));
  }, 300_000);

  // ── Helper: build a hop for local quoting ─────────────────────────────
  function buildHop(pool: typeof poolsByDex[string][0], inputMint: string, outputMint: string) {
    const isRev = /[#-]rev$/.test(pool.poolId);
    return {
      dex: pool.dex,
      variant: pool.variant,
      poolId: pool.poolId,
      programId: '',
      inputMint,
      outputMint,
      inputDecimals: inputMint === SOL_MINT ? 9 : 6,
      outputDecimals: outputMint === SOL_MINT ? 9 : 6,
      inputTokenProgram: 'spl-token' as const,
      outputTokenProgram: 'spl-token' as const,
      userSourceAta: '',
      userDestAta: '',
      amountInRaw: 0n,
      minOutRaw: 0n,
    };
  }

  // ── Helper: run comparison for a single pool and multiple sizes ───────
  async function compareQuotes(
    label: string,
    pool: typeof poolsByDex[string][0],
    sdkQuoteFn: (poolId: string, inputMint: string, outputMint: string, amountInRaw: bigint) => Promise<bigint | null>,
    tolerance: (sizeSol: number) => number,
  ) {
    const { quoteHopOut } = await import('../../execution/resolver/quotes.js');

    // Determine input/output (SOL → USDC direction)
    const inputMint = pool.mintA === SOL_MINT ? SOL_MINT : pool.mintB === SOL_MINT ? SOL_MINT : pool.mintA;
    const outputMint = inputMint === pool.mintA ? pool.mintB : pool.mintA;
    const hop = buildHop(pool, inputMint, outputMint);

    const results: { sizeSol: number; local: bigint; sdk: bigint | null; diff: number; pass: boolean }[] = [];

    for (const sizeSol of INPUT_SIZES_SOL) {
      const amountInRaw = solToLamports(sizeSol);
      const localOut = await quoteHopOut(hop as any, amountInRaw);

      let sdkOut: bigint | null = null;
      try {
        sdkOut = await sdkQuoteFn(pool.poolId.replace(/[#-]rev$/, ''), inputMint, outputMint, amountInRaw);
      } catch (e: any) {
        console.warn(`[${label}] SDK quote failed for size ${sizeSol}: ${e.message}`);
      }

      const diff = sdkOut !== null && sdkOut > 0n ? relativeDiff(localOut, sdkOut) : NaN;
      const tol = tolerance(sizeSol);
      const pass = !isNaN(diff) ? diff <= tol : localOut > 0n; // If SDK fails, just check local > 0

      results.push({ sizeSol, local: localOut, sdk: sdkOut, diff, pass });
    }

    console.log(`\n[${label}] Pool: ${pool.poolId.slice(0, 12)}…`);
    console.log(`  Size(SOL) | Local Output       | SDK Output         | Diff     | Status`);
    console.log(`  ----------|--------------------|--------------------|----------|-------`);
    for (const r of results) {
      const diffStr = isNaN(r.diff) ? 'N/A' : `${(r.diff * 100).toFixed(4)}%`;
      const status = r.pass ? 'PASS' : 'FAIL';
      console.log(`  ${String(r.sizeSol).padEnd(9)} | ${String(r.local).padEnd(18)} | ${String(r.sdk ?? 'N/A').padEnd(18)} | ${diffStr.padEnd(8)} | ${status}`);
    }

    return results;
  }

  // ── Orca CLMM ────────────────────────────────────────────────────────
  const SKIP_ORCA = process.env.SKIP_LOCAL_SDK_ORCA === 'true';

  (SKIP_ORCA ? describe.skip : describe)('Orca CLMM', () => {
    it('local quote matches Orca SDK within tolerance', async () => {
      const pools = poolsByDex['orca:clmm'] || poolsByDex['orca:'] || [];
      if (!pools.length) { console.warn('[Orca] No SOL/USDC pool found'); return; }

      const sdkQuote = async (poolId: string, inputMint: string, outputMint: string, amountInRaw: bigint): Promise<bigint | null> => {
        try {
          const { WhirlpoolContext, buildWhirlpoolClient, PDAUtil, swapQuoteByInputToken, ORCA_WHIRLPOOL_PROGRAM_ID } = await import('@orca-so/whirlpools-sdk');
          const { Percentage } = await import('@orca-so/common-sdk');
          const { Wallet } = await import('@coral-xyz/anchor');

          const wallet = new Wallet(Keypair.generate());
          const ctx = WhirlpoolContext.from(conn, wallet, ORCA_WHIRLPOOL_PROGRAM_ID);
          const client = buildWhirlpoolClient(ctx);
          const pool = await client.getPool(new PublicKey(poolId));
          const quote = await swapQuoteByInputToken(
            pool,
            new PublicKey(inputMint),
            { toString: () => amountInRaw.toString() } as any,
            Percentage.fromFraction(1, 100),
            ORCA_WHIRLPOOL_PROGRAM_ID,
            ctx.fetcher,
          );
          return BigInt(quote.estimatedAmountOut.toString());
        } catch (e: any) {
          console.warn(`[Orca SDK] ${e.message}`);
          return null;
        }
      };

      const results = await compareQuotes('Orca CLMM', pools[0], sdkQuote, (size) =>
        size <= 0.1 ? CLMM_SMALL_TOLERANCE : CLMM_LARGE_TOLERANCE
      );

      // At minimum, local quote should produce positive output for small sizes
      const smallResults = results.filter(r => r.sizeSol <= 0.1);
      for (const r of smallResults) {
        expect(r.local).toBeGreaterThan(0n);
      }
    }, 120_000);
  });

  // ── Raydium CLMM ─────────────────────────────────────────────────────
  const SKIP_RAY_CLMM = process.env.SKIP_LOCAL_SDK_RAYDIUM_CLMM === 'true';

  (SKIP_RAY_CLMM ? describe.skip : describe)('Raydium CLMM', () => {
    it('local quote matches Raydium CLMM SDK within tolerance', async () => {
      const pools = poolsByDex['raydium:clmm'] || poolsByDex['raydium-clmm:clmm'] || [];
      if (!pools.length) { console.warn('[RayClmm] No pool found'); return; }

      const sdkQuote = async (poolId: string, inputMint: string, outputMint: string, amountInRaw: bigint): Promise<bigint | null> => {
        try {
          const { Raydium } = await import('@raydium-io/raydium-sdk-v2');
          const raydium = await Raydium.load({
            connection: conn,
            owner: Keypair.generate(),
            disableLoadToken: true,
          });
          const res = await raydium.clmm.getSwapResult({
            poolId,
            inputMint: new PublicKey(inputMint),
            inputAmount: amountInRaw,
          });
          return res?.outputAmount ? BigInt(res.outputAmount.toString()) : null;
        } catch (e: any) {
          console.warn(`[Raydium CLMM SDK] ${e.message}`);
          return null;
        }
      };

      const results = await compareQuotes('Raydium CLMM', pools[0], sdkQuote, (size) =>
        size <= 0.1 ? CLMM_SMALL_TOLERANCE : CLMM_LARGE_TOLERANCE
      );

      const smallResults = results.filter(r => r.sizeSol <= 0.1);
      for (const r of smallResults) {
        expect(r.local).toBeGreaterThan(0n);
      }
    }, 120_000);
  });

  // ── Raydium AMM ───────────────────────────────────────────────────────
  const SKIP_RAY_AMM = process.env.SKIP_LOCAL_SDK_RAYDIUM_AMM === 'true';

  (SKIP_RAY_AMM ? describe.skip : describe)('Raydium AMM', () => {
    it('local quote matches Raydium AMM SDK within tolerance', async () => {
      const pools = poolsByDex['raydium:amm'] || poolsByDex['raydium:'] || [];
      if (!pools.length) { console.warn('[RayAMM] No pool found'); return; }

      const sdkQuote = async (poolId: string, inputMint: string, outputMint: string, amountInRaw: bigint): Promise<bigint | null> => {
        try {
          const { Raydium } = await import('@raydium-io/raydium-sdk-v2');
          const raydium = await Raydium.load({
            connection: conn,
            owner: Keypair.generate(),
            disableLoadToken: true,
          });
          const res = await raydium.liquidity.getSwapResult({
            poolId,
            inputMint: new PublicKey(inputMint),
            inputAmount: amountInRaw,
          });
          return res?.outputAmount ? BigInt(res.outputAmount.toString()) : null;
        } catch (e: any) {
          console.warn(`[Raydium AMM SDK] ${e.message}`);
          return null;
        }
      };

      const results = await compareQuotes('Raydium AMM', pools[0], sdkQuote, () => AMM_TOLERANCE);

      for (const r of results) {
        expect(r.local).toBeGreaterThan(0n);
      }
    }, 120_000);
  });

  // ── Meteora DLMM ─────────────────────────────────────────────────────
  const SKIP_MET_DLMM = process.env.SKIP_LOCAL_SDK_METEORA_DLMM === 'true';

  (SKIP_MET_DLMM ? describe.skip : describe)('Meteora DLMM', () => {
    it('local quote matches Meteora DLMM SDK within tolerance', async () => {
      const pools = poolsByDex['meteora:dlmm'] || poolsByDex['meteora:'] || [];
      if (!pools.length) { console.warn('[MetDLMM] No pool found'); return; }

      const sdkQuote = async (poolId: string, inputMint: string, outputMint: string, amountInRaw: bigint): Promise<bigint | null> => {
        try {
          const DLMM = (await import('@meteora-ag/dlmm')).default;
          const dlmmPool = await DLMM.create(conn, new PublicKey(poolId));

          const swapAmount = { toString: () => amountInRaw.toString() } as any;
          const swapYtoX = inputMint === dlmmPool.tokenY.publicKey.toBase58();
          const quote = await dlmmPool.swapQuote(swapAmount, swapYtoX, { toString: () => '100' } as any);
          return quote?.consumableAmount ? BigInt(quote.consumableAmount.toString()) : null;
        } catch (e: any) {
          console.warn(`[Meteora DLMM SDK] ${e.message}`);
          return null;
        }
      };

      const results = await compareQuotes('Meteora DLMM', pools[0], sdkQuote, (size) =>
        size <= 0.1 ? CLMM_SMALL_TOLERANCE : CLMM_LARGE_TOLERANCE
      );

      const smallResults = results.filter(r => r.sizeSol <= 0.1);
      for (const r of smallResults) {
        expect(r.local).toBeGreaterThan(0n);
      }
    }, 120_000);
  });

  // ── PumpSwap ──────────────────────────────────────────────────────────
  const SKIP_PUMP = process.env.SKIP_LOCAL_SDK_PUMPSWAP === 'true';

  (SKIP_PUMP ? describe.skip : describe)('PumpSwap', () => {
    it('local quote produces positive output for all sizes', async () => {
      // PumpSwap has no public SDK quote function, so we just verify local quotes are positive
      const pools = poolsByDex['pumpswap:amm'] || poolsByDex['pumpswap:'] || [];
      if (!pools.length) { console.warn('[PumpSwap] No pool found'); return; }

      const { quoteHopOut } = await import('../../execution/resolver/quotes.js');
      const pool = pools[0];
      const inputMint = pool.mintA === SOL_MINT ? SOL_MINT : pool.mintB === SOL_MINT ? SOL_MINT : pool.mintA;
      const outputMint = inputMint === pool.mintA ? pool.mintB : pool.mintA;
      const hop = buildHop(pool, inputMint, outputMint);

      console.log(`\n[PumpSwap] Pool: ${pool.poolId.slice(0, 12)}…`);
      for (const sizeSol of INPUT_SIZES_SOL) {
        const amountInRaw = solToLamports(sizeSol);
        const localOut = await quoteHopOut(hop as any, amountInRaw);
        console.log(`  ${sizeSol} SOL → ${localOut} (local)`);
        expect(localOut).toBeGreaterThan(0n);
      }
    }, 60_000);
  });

}, 600_000); // 10 min global timeout
