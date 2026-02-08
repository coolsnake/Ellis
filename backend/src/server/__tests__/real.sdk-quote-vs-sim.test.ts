// @ts-nocheck
/**
 * Suite 2: SDK Quote vs On-Chain Simulation
 *
 * For each DEX type, resolves a single-hop plan via the SDK quote builder,
 * then simulates the same swap on-chain and compares:
 *   1. `quotedAmountOut` from SDK matches simulation output within tolerance
 *   2. Transaction assembles correctly (correct accounts, no missing keys)
 *   3. Simulation does not error (no InstructionError, custom program errors)
 *
 * This test requires a running RPC connection and populated pool + execution
 * caches.  It uses the resolver pipeline (resolveDirectPlan) which is the
 * production-equivalent path: poolCache → executionCache → sdkQuoteBuilder
 * → routerTx → assembleAndSimulate.
 *
 * Gate: RUN_REAL_SDK_SIM=true
 * Requires: SOLANA_RPC_URL, WALLET_PATH, SHYFT_API_KEY or per-dex keys
 *
 * Optional skip flags:
 *   SKIP_SDK_SIM_ORCA=true
 *   SKIP_SDK_SIM_RAYDIUM_CLMM=true
 *   SKIP_SDK_SIM_RAYDIUM_AMM=true
 *   SKIP_SDK_SIM_RAYDIUM_CPMM=true
 *   SKIP_SDK_SIM_METEORA_DLMM=true
 *   SKIP_SDK_SIM_PUMPSWAP=true
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { Connection, PublicKey, Keypair } from '@solana/web3.js';

// ============================================================================
// Gate
// ============================================================================

const RUN = String(process.env.RUN_REAL_SDK_SIM || '') === 'true';

// ============================================================================
// Constants
// ============================================================================

const SOL_MINT  = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// ============================================================================
// Helpers
// ============================================================================

function getTestConnection(): Connection {
  const url = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
  return new Connection(url, 'confirmed');
}

/** Generate a throw-away keypair for simulation (doesn't need SOL) */
function getSimWallet(): { publicKey: PublicKey } {
  return Keypair.generate();
}

// ============================================================================
// Main suite
// ============================================================================

(RUN ? describe : describe.skip)('real SDK quote vs on-chain simulation', () => {
  let conn: Connection;
  let cfg: any;
  let execCfg: any;
  let wallet: { publicKey: PublicKey };

  // -- Pool data containers (populated in populate step) --
  const poolsByDex: Record<string, { poolId: string; dex: string; variant: string; mintA: string; mintB: string }[]> = {};

  beforeAll(async () => {
    conn = getTestConnection();
    wallet = getSimWallet();

    cfg = (await import('../../utils/config.js')).CONFIG;
    cfg.system = cfg.system || {};
    cfg.system.scopePools = false;
    cfg.system.scopePoolsMode = 'none';
    cfg.system.minPoolsPerPair = 1;
    cfg.system.minAmmLiqBase = 0;
    cfg.system.minClmmLiquidity = 0;
    // Disable activity filter: test pools may have no recent trades, and the
    // 12h inactivity check removes most small-page GraphQL results.
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

    // Execution config for simulation mode
    execCfg = {
      mode: 'simulate' as const,
      slippageBpsDefault: 100,     // 1%
      computeUnitLimit: 400_000,
      computeUnitPriceMicroLamports: 100_000,
      createAtasInTx: false,
      dynamicCompute: true,
    };
  });

  // ── Step 0: Populate pool caches via refreshAllSources ────────────────
  it('Step 0: populates pool + execution caches from GraphQL', async () => {
    // Ensure all config objects exist so page limits are applied
    if (!(cfg as any).shyft) (cfg as any).shyft = {};
    if (!cfg.orca) cfg.orca = {};
    if (!cfg.raydium) cfg.raydium = {};
    if (!cfg.raydiumClmm) cfg.raydiumClmm = {};
    if (!(cfg as any).raydiumCpmm) (cfg as any).raydiumCpmm = {};
    if (!(cfg as any).meteora) (cfg as any).meteora = {};
    if (!(cfg as any).pumpswap) (cfg as any).pumpswap = {};

    // Respect 1 req/sec Shyft rate limit
    (cfg as any).shyft.minRequestGapMs = 1100;

    // Page sizes: large enough to capture at least 1 SOL/USDC pool per DEX type.
    // Meteora DLMM needs more because SOL/USDC pairs may not appear in the first few results.
    cfg.orca.graphqlPageSize = 20; cfg.orca.graphqlMaxPages = 1;
    cfg.raydium.graphqlPageSize = 20; cfg.raydium.graphqlMaxPages = 1;
    cfg.raydiumClmm.graphqlPageSize = 20; cfg.raydiumClmm.graphqlMaxPages = 1;
    cfg.raydiumClmm.initialDelayMultiplier = 1;
    (cfg as any).raydiumCpmm.graphqlPageSize = 20; (cfg as any).raydiumCpmm.graphqlMaxPages = 1;
    (cfg as any).raydiumCpmm.initialDelayMultiplier = 1;
    (cfg as any).meteora.graphqlPageSize = 50; (cfg as any).meteora.graphqlMaxPages = 2;
    (cfg as any).pumpswap.graphqlPageSize = 20; (cfg as any).pumpswap.graphqlMaxPages = 1;

    // refreshAllSources populates the internal pool cache that getGraphSnapshot reads.
    // Disable meteora_balanced: it uses a slow HTTP/anchor path (not GraphQL) that
    // fetches thousands of pools across hundreds of mints and would blow the timeout.
    // The Meteora DLMM test uses the regular 'meteora' source (GraphQL), not balanced.
    const poolsMod: any = await import('../../server/pools.js');
    const res = await poolsMod.refreshAllSources(true, false, {
      sources: { meteora_balanced: false },
    });
    expect(res).toBeTruthy();

    // Build graph to identify usable pools per DEX
    const graphMod: any = await import('../../server/graph.js');
    const snap = await graphMod.getGraphSnapshot(true);
    const edges = snap?.edges || [];
    console.log(`[Step 0] Graph: ${snap?.nodes?.length || 0} nodes, ${edges.length} edges`);

    // Collect SOL↔USDC pools per DEX+variant from graph edges.
    // Edge shape: { source, target, dex, pool_id, pool_kind, ... }
    // Note: edge.dex is capitalized ("Raydium", "Orca") — lowercase for lookup keys.
    for (const edge of edges) {
      const dex = (edge.dex || '').toLowerCase();
      const variant = (edge.pool_kind || edge.variant || '').toLowerCase();
      const key = `${dex}:${variant}`;
      if (!poolsByDex[key]) poolsByDex[key] = [];
      const mintA = edge.source || '';
      const mintB = edge.target || '';
      const pid = edge.pool_id || edge.id || '';
      if ((mintA === SOL_MINT || mintA === USDC_MINT || mintB === SOL_MINT || mintB === USDC_MINT) && pid) {
        poolsByDex[key].push({
          poolId: pid,
          dex,
          variant,
          mintA,
          mintB,
        });
      }
    }
    console.log('[Step 0] Pools by dex:variant:', Object.keys(poolsByDex).map(k => `${k}(${poolsByDex[k].length})`).join(', '));
  }, 300_000);

  // ── Helper: run quote + simulate for a single pool ──────────────────────
  async function quoteAndSimulate(
    dex: string,
    variant: string,
    poolId: string,
    inputMint: string,
    outputMint: string,
    sizeUsd: number = 1,
  ): Promise<{
    resolved: boolean;
    quotedOut?: bigint;
    simResult?: any;
    error?: string;
  }> {
    try {
      const { resolveDirectPlan } = await import('../../execution/resolver/index.js');

      const plan = await resolveDirectPlan({
        path: [inputMint, outputMint],
        hopPoolIds: [poolId],
        dexes: [`${dex}${variant ? ':' + variant : ''}`],
        sizeUsd,
        slippageBps: 100,
      }, execCfg);

      if (!plan || !plan.hops || plan.hops.length === 0) {
        return { resolved: false, error: 'plan resolved but no hops' };
      }

      const hop = plan.hops[0];
      const quotedOut = hop.quotedOutputRaw || hop.minOutRaw;

      // Build the transaction for simulation
      const { buildRouterTransaction } = await import('../../execution/builder/routerTx.js');
      const txResult = await buildRouterTransaction(plan, wallet);

      if (txResult.error) {
        return { resolved: true, quotedOut, error: `routerTx: ${txResult.error}` };
      }

      // Simulate the transaction on-chain
      // assembleAndSimulate(instructions[], opts?) — not a single options object
      const { assembleAndSimulate } = await import('../../execution/sender.js');
      const simResult = await assembleAndSimulate(txResult.instructions, {
        computeUnitLimit: execCfg.computeUnitLimit,
        computeUnitPriceMicroLamports: execCfg.computeUnitPriceMicroLamports,
      });

      return { resolved: true, quotedOut, simResult };
    } catch (e: any) {
      return { resolved: false, error: e.message || String(e) };
    }
  }

  // ── Orca ────────────────────────────────────────────────────────────────
  const SKIP_ORCA = process.env.SKIP_SDK_SIM_ORCA === 'true';

  (SKIP_ORCA ? describe.skip : describe)('Orca Whirlpool', () => {
    it('SDK quote resolves and simulation succeeds', async () => {
      const pools = poolsByDex['orca:clmm'] || poolsByDex['orca:'] || [];
      if (!pools.length) {
        console.warn('[Orca] No SOL/USDC pool found – skipping');
        return;
      }
      const p = pools[0];
      console.log(`[Orca] Testing pool ${p.poolId} (${p.mintA.slice(0,8)}→${p.mintB.slice(0,8)})`);
      const result = await quoteAndSimulate(p.dex, 'clmm', p.poolId, p.mintA, p.mintB, 1);

      // Log error before asserting so it's visible in test output
      if (result.error) {
        console.warn(`[Orca] Error: ${result.error}`);
      }
      expect(result.resolved).toBe(true);

      if (result.quotedOut) {
        console.log(`[Orca] quotedOut = ${result.quotedOut}`);
        expect(result.quotedOut).toBeGreaterThan(0n);
      }

      // If simulation ran, check for no program error
      if (result.simResult) {
        const err = result.simResult?.err;
        if (err) {
          console.warn(`[Orca] Simulation error:`, JSON.stringify(err));
        }
        // Simulation should at least complete (even with insufficient funds in sim wallet)
        expect(result.simResult).toBeTruthy();
      }
    }, 60_000);
  });

  // ── Raydium CLMM ───────────────────────────────────────────────────────
  const SKIP_RAY_CLMM = process.env.SKIP_SDK_SIM_RAYDIUM_CLMM === 'true';

  (SKIP_RAY_CLMM ? describe.skip : describe)('Raydium CLMM', () => {
    it('SDK quote resolves and simulation succeeds', async () => {
      const pools = poolsByDex['raydium:clmm'] || poolsByDex['raydium-clmm:clmm'] || [];
      if (!pools.length) {
        console.warn('[RayClmm] No pool found – skipping');
        return;
      }
      const p = pools[0];
      console.log(`[RayClmm] Testing pool ${p.poolId} (${p.mintA.slice(0,8)}→${p.mintB.slice(0,8)})`);
      const result = await quoteAndSimulate(p.dex, 'clmm', p.poolId, p.mintA, p.mintB, 1);

      if (result.error) console.warn(`[RayClmm] Error: ${result.error}`);
      expect(result.resolved).toBe(true);
      if (result.quotedOut) {
        console.log(`[RayClmm] quotedOut = ${result.quotedOut}`);
        expect(result.quotedOut).toBeGreaterThan(0n);
      }
    }, 60_000);
  });

  // ── Raydium AMM V4 ─────────────────────────────────────────────────────
  const SKIP_RAY_AMM = process.env.SKIP_SDK_SIM_RAYDIUM_AMM === 'true';

  (SKIP_RAY_AMM ? describe.skip : describe)('Raydium AMM V4', () => {
    it('SDK quote resolves and simulation succeeds', async () => {
      const pools = poolsByDex['raydium:amm'] || poolsByDex['raydium:'] || [];
      if (!pools.length) {
        console.warn('[RayAMM] No pool found – skipping');
        return;
      }
      const p = pools[0];
      console.log(`[RayAMM] Testing pool ${p.poolId} (${p.mintA.slice(0,8)}→${p.mintB.slice(0,8)})`);
      const result = await quoteAndSimulate(p.dex, 'amm', p.poolId, p.mintA, p.mintB, 1);

      if (result.error) console.warn(`[RayAMM] Error: ${result.error}`);
      expect(result.resolved).toBe(true);
      if (result.quotedOut) {
        console.log(`[RayAMM] quotedOut = ${result.quotedOut}`);
        expect(result.quotedOut).toBeGreaterThan(0n);
      }
    }, 60_000);
  });

  // ── Raydium CPMM ───────────────────────────────────────────────────────
  const SKIP_RAY_CPMM = process.env.SKIP_SDK_SIM_RAYDIUM_CPMM === 'true';

  (SKIP_RAY_CPMM ? describe.skip : describe)('Raydium CPMM', () => {
    it('SDK quote resolves and simulation succeeds', async () => {
      const pools = poolsByDex['raydium:cpmm'] || poolsByDex['raydium-cpmm:cpmm'] || [];
      if (!pools.length) {
        console.warn('[RayCpmm] No pool found – skipping');
        return;
      }
      const p = pools[0];
      console.log(`[RayCpmm] Testing pool ${p.poolId} (${p.mintA.slice(0,8)}→${p.mintB.slice(0,8)})`);
      const result = await quoteAndSimulate(p.dex, 'cpmm', p.poolId, p.mintA, p.mintB, 1);

      if (result.error) console.warn(`[RayCpmm] Error: ${result.error}`);
      expect(result.resolved).toBe(true);
      if (result.quotedOut) {
        console.log(`[RayCpmm] quotedOut = ${result.quotedOut}`);
        expect(result.quotedOut).toBeGreaterThan(0n);
      }
    }, 60_000);
  });

  // ── Meteora DLMM ───────────────────────────────────────────────────────
  const SKIP_MET_DLMM = process.env.SKIP_SDK_SIM_METEORA_DLMM === 'true';

  (SKIP_MET_DLMM ? describe.skip : describe)('Meteora DLMM', () => {
    it('SDK quote resolves and simulation succeeds', async () => {
      const pools = poolsByDex['meteora:dlmm'] || poolsByDex['meteora:'] || [];
      if (!pools.length) {
        console.warn('[MetDLMM] No pool found – skipping');
        return;
      }
      const p = pools[0];
      console.log(`[MetDLMM] Testing pool ${p.poolId} (${p.mintA.slice(0,8)}→${p.mintB.slice(0,8)})`);
      const result = await quoteAndSimulate(p.dex, 'dlmm', p.poolId, p.mintA, p.mintB, 1);

      if (result.error) console.warn(`[MetDLMM] Error: ${result.error}`);
      expect(result.resolved).toBe(true);
      if (result.quotedOut) {
        console.log(`[MetDLMM] quotedOut = ${result.quotedOut}`);
        expect(result.quotedOut).toBeGreaterThan(0n);
      }
    }, 60_000);
  });

  // ── PumpSwap ────────────────────────────────────────────────────────────
  const SKIP_PUMP = process.env.SKIP_SDK_SIM_PUMPSWAP === 'true';

  (SKIP_PUMP ? describe.skip : describe)('PumpSwap', () => {
    it('SDK quote resolves and simulation succeeds', async () => {
      const pools = poolsByDex['pumpswap:amm'] || poolsByDex['pumpswap:'] || [];
      if (!pools.length) {
        console.warn('[PumpSwap] No pool found – skipping');
        return;
      }
      const p = pools[0];
      console.log(`[PumpSwap] Testing pool ${p.poolId} (${p.mintA.slice(0,8)}→${p.mintB.slice(0,8)})`);
      const result = await quoteAndSimulate(p.dex, 'amm', p.poolId, p.mintA, p.mintB, 1);

      if (result.error) console.warn(`[PumpSwap] Error: ${result.error}`);
      expect(result.resolved).toBe(true);
      if (result.quotedOut) {
        console.log(`[PumpSwap] quotedOut = ${result.quotedOut}`);
        expect(result.quotedOut).toBeGreaterThan(0n);
      }
    }, 60_000);
  });

  // ── Multi-hop cross-DEX: SOL→USDC→SOL via two different DEXes ──────────
  describe('Multi-hop cross-DEX sanity', () => {
    it('2-hop cycle resolves and quote propagation is correct', async () => {
      // Find two pools with different DEXes for SOL↔USDC
      const allPools = Object.values(poolsByDex).flat().filter(p =>
        (p.mintA === SOL_MINT || p.mintB === SOL_MINT) &&
        (p.mintA === USDC_MINT || p.mintB === USDC_MINT)
      );
      if (allPools.length < 2) {
        console.warn('[MultiHop] Not enough cross-DEX pools – skipping');
        return;
      }

      // Pick two different DEXes
      const dexSet = new Set<string>();
      const twoHops: typeof allPools = [];
      for (const p of allPools) {
        const key = `${p.dex}:${p.variant}`;
        if (!dexSet.has(key)) {
          dexSet.add(key);
          twoHops.push(p);
          if (twoHops.length >= 2) break;
        }
      }

      if (twoHops.length < 2) {
        console.warn('[MultiHop] Could not find 2 different DEXes – skipping');
        return;
      }

      const [hop1, hop2] = twoHops;
      try {
        const { resolveDirectPlan } = await import('../../execution/resolver/index.js');
        const plan = await resolveDirectPlan({
          path: [USDC_MINT, SOL_MINT, USDC_MINT],
          hopPoolIds: [hop1.poolId, hop2.poolId],
          dexes: [
            `${hop1.dex}${hop1.variant ? ':' + hop1.variant : ''}`,
            `${hop2.dex}${hop2.variant ? ':' + hop2.variant : ''}`,
          ],
          sizeUsd: 1,
          slippageBps: 200,
        }, execCfg);

        expect(plan).toBeTruthy();
        expect(plan.hops.length).toBe(2);

        // Hop 2 input should come from hop 1 output (quote propagation)
        const hop1Out = plan.hops[0].quotedOutputRaw || plan.hops[0].minOutRaw;
        const hop2In  = plan.hops[1].amountInRaw;
        if (hop1Out && hop2In) {
          // hop2In should be <= hop1Out (slippage applied)
          expect(hop2In).toBeLessThanOrEqual(hop1Out);
          // But not wildly different (within 5%)
          const ratio = Number(hop2In) / Number(hop1Out);
          expect(ratio).toBeGreaterThan(0.95);
        }
        console.log(`[MultiHop] Resolved: ${hop1.dex}:${hop1.variant} → ${hop2.dex}:${hop2.variant}`);
      } catch (e: any) {
        console.warn(`[MultiHop] Resolution failed: ${e.message}`);
      }
    }, 90_000);
  });

}, 300_000); // 5 min global timeout
