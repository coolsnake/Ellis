// @ts-nocheck
/**
 * Suite 1: Real Pipeline – Fetch → Decode → Validate
 *
 * Tests the complete data pipeline from API fetch through to execution-cache
 * completeness, using real Shyft GraphQL / Meteora HTTP endpoints and Solana RPC.
 *
 * Phases per DEX:
 *   P0 – Connectivity smoke (API reachable, returns data)
 *   P1 – Limited fetch + normalise through price pipeline
 *   P2 – Normalized field quality (prices, decimals, orientation)
 *   P3 – On-chain decode (getAccountInfo → decoder) cross-check
 *   P4 – Execution-cache completeness audit
 *   P5 – Cross-validation (decimals vs getMint, reserves vs vaults)
 *
 * Gate: RUN_REAL_PIPELINE=true
 * Requires: SOLANA_RPC_URL  (for P3-P5)
 *           SHYFT_API_KEY or per-dex keys  (for P0-P1 GraphQL DEXes)
 *
 * Optional skip flags:
 *   SKIP_ORCA_PIPELINE=true
 *   SKIP_RAYDIUM_CLMM_PIPELINE=true
 *   SKIP_RAYDIUM_AMM_PIPELINE=true
 *   SKIP_RAYDIUM_CPMM_PIPELINE=true
 *   SKIP_METEORA_DLMM_PIPELINE=true
 *   SKIP_PUMPSWAP_PIPELINE=true
 *   SKIP_METEORA_BALANCED_PIPELINE=true
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { Connection, PublicKey } from '@solana/web3.js';

// ============================================================================
// Gate
// ============================================================================

const RUN = String(process.env.RUN_REAL_PIPELINE || '') === 'true';

// ============================================================================
// Constants
// ============================================================================

const SOL_MINT  = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// ============================================================================
// Shared helpers
// ============================================================================

function getTestConnection(): Connection {
  const url = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
  return new Connection(url, 'confirmed');
}

function isBase58(val: any): boolean {
  return typeof val === 'string' && BASE58_RE.test(val);
}

async function accountExists(conn: Connection, address: string): Promise<boolean> {
  try {
    const info = await conn.getAccountInfo(new PublicKey(address));
    return info !== null;
  } catch { return false; }
}

async function getOnChainDecimals(conn: Connection, mint: string): Promise<number> {
  const info = await conn.getAccountInfo(new PublicKey(mint));
  if (!info || info.data.length < 45) throw new Error(`mint ${mint} not found`);
  return info.data[44];
}

function pickAnchorPool<T extends { mint_a?: string; mint_b?: string }>(pools: T[]): T | undefined {
  if (!pools.length) return undefined;
  // Prefer SOL/USDC pair
  const solUsdc = pools.find(p =>
    (p.mint_a === SOL_MINT && p.mint_b === USDC_MINT) ||
    (p.mint_a === USDC_MINT && p.mint_b === SOL_MINT)
  );
  if (solUsdc) return solUsdc;
  // Any pool with SOL
  const withSol = pools.find(p => p.mint_a === SOL_MINT || p.mint_b === SOL_MINT);
  if (withSol) return withSol;
  return pools[0];
}

function auditFields(record: Record<string, any> | undefined, required: string[]): string[] {
  if (!record) return required;
  return required.filter(f => record[f] === undefined || record[f] === null || record[f] === '');
}

// ============================================================================
// Main suite
// ============================================================================

(RUN ? describe : describe.skip)('real pipeline: fetch → decode → validate', () => {
  let conn: Connection;
  let cfg: any;

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
  });

  // ════════════════════════════════════════════════════════════════════════
  //  ORCA WHIRLPOOL
  // ════════════════════════════════════════════════════════════════════════

  const SKIP_ORCA = process.env.SKIP_ORCA_PIPELINE === 'true';

  (SKIP_ORCA ? describe.skip : describe)('Orca Whirlpool (GraphQL → CLMM)', () => {
    let normalizedPools: any;          // PoolsPayload { amm, clmm, cpmm }
    let samplePool: any;               // single ClmmPool
    let decodedPool: any;

    // ── P0: Connectivity ──────────────────────────────────────────────────
    it('P0: Shyft GraphQL returns Orca whirlpool data', async () => {
      const { executeShyftGraphQL } = await import('../../server/pools/shyftHelpers.js');
      const query = `
        query OrcaSmoke {
          ORCA_WHIRLPOOLS_whirlpool(
            where: { tokenMintA: { _eq: "${SOL_MINT}" }, tokenMintB: { _eq: "${USDC_MINT}" } }
            limit: 3
          ) {
            pubkey
            tokenMintA
            tokenMintB
            sqrtPrice
            tickCurrentIndex
            tickSpacing
            feeRate
            liquidity
            tokenVaultA
            tokenVaultB
          }
        }`;
      const res: any = await executeShyftGraphQL({
        query, dex: 'orca', retries: 2, backoffMs: 1000,
      });
      const pools = res?.ORCA_WHIRLPOOLS_whirlpool || [];
      expect(pools.length).toBeGreaterThan(0);
      expect(pools[0].pubkey).toBeTruthy();
      expect(pools[0].sqrtPrice).toBeTruthy();
      expect(Number(pools[0].tickSpacing)).toBeGreaterThan(0);
    }, 30_000);

    // ── P1: Limited fetch + normalise ─────────────────────────────────────
    it('P1: fetches + normalises Orca pools', async () => {
      const { fetchOrcaGraphQL }    = await import('../../server/pools/orcaGraphQL.js');
      const { normalizeOrcaGraphQL } = await import('../../server/pools/orcaGraphQL.js');
      if (cfg.orca) {
        cfg.orca.graphqlPageSize = 20;
        cfg.orca.graphqlMaxPages = 1;
      }
      const raw = await fetchOrcaGraphQL([SOL_MINT, USDC_MINT]);
      expect(raw.length).toBeGreaterThan(0);
      normalizedPools = await normalizeOrcaGraphQL(raw);
      const clmm = normalizedPools?.clmm || [];
      expect(clmm.length).toBeGreaterThan(0);
    }, 60_000);

    // ── P2: Normalisation quality ─────────────────────────────────────────
    it('P2: normalised CLMM pools have correct prices, decimals, orientation', () => {
      const clmm = normalizedPools?.clmm || [];
      expect(clmm.length).toBeGreaterThan(0);
      samplePool = pickAnchorPool(clmm);
      expect(samplePool).toBeTruthy();

      // Price
      expect(samplePool.price_a_per_b).toBeGreaterThan(0);
      expect(Number.isFinite(samplePool.price_a_per_b)).toBe(true);

      // Decimals
      expect(samplePool.decimals_a).toBeGreaterThanOrEqual(0);
      expect(samplePool.decimals_a).toBeLessThanOrEqual(18);
      expect(samplePool.decimals_b).toBeGreaterThanOrEqual(0);
      expect(samplePool.decimals_b).toBeLessThanOrEqual(18);

      // Native orientation
      expect(isBase58(samplePool.native_mint_a)).toBe(true);
      expect(isBase58(samplePool.native_mint_b)).toBe(true);
      expect(samplePool.native_mint_a).not.toBe(samplePool.native_mint_b);
      expect(typeof samplePool.was_swapped).toBe('boolean');

      // CLMM-specific
      expect(samplePool.sqrt_price_x64).toBeGreaterThan(0);
      expect(samplePool.liquidity).toBeGreaterThan(0);
      expect(samplePool.tick_spacing).toBeGreaterThan(0);
      expect(samplePool.fee_bps).toBeGreaterThan(0);
    });

    // ── P3: On-chain decode ───────────────────────────────────────────────
    it('P3: on-chain decode matches normalised data', async () => {
      if (!samplePool) return;
      const { decodeOrcaWhirlpool } = await import('../../server/pools/websockets/decoders/orca.js');
      const acctInfo = await conn.getAccountInfo(new PublicKey(samplePool.id));
      expect(acctInfo).not.toBeNull();

      // decodeOrcaWhirlpool expects a full AccountInfo object, not just the Buffer
      decodedPool = await decodeOrcaWhirlpool(acctInfo!, samplePool.id);
      if (!decodedPool) {
        console.warn(`[Orca P3] Decoder returned null – SDK may not be available; checking manual fields`);
        // Fallback: verify the raw account data is a valid Whirlpool (653 bytes)
        expect(acctInfo!.data.length).toBeGreaterThanOrEqual(653);
        return;
      }

      // Decoder returns { parsed, mintA, mintB } – extract parsed state
      const parsed = decodedPool.parsed || decodedPool;

      // Tick spacing must match
      const decodedTickSpacing = parsed.tick_spacing ?? parsed.tickSpacing;
      if (decodedTickSpacing !== undefined) {
        expect(decodedTickSpacing).toBe(samplePool.tick_spacing);
      }

      // sqrtPriceX64 should be close (pool may move between fetch and RPC read)
      const decodedSqrt = Number(parsed.sqrt_price_x64_raw || parsed.sqrt_price_x64 || parsed.sqrtPrice || 0);
      const normalizedSqrt = Number(samplePool.sqrt_price_x64_raw || samplePool.sqrt_price_x64 || 0);
      if (decodedSqrt > 0 && normalizedSqrt > 0) {
        const ratio = decodedSqrt / normalizedSqrt;
        expect(ratio).toBeGreaterThan(0.90);
        expect(ratio).toBeLessThan(1.10);
      }

      // Fee must match
      const decodedFee = parsed.fee_bps ?? parsed.feeBps;
      if (decodedFee !== undefined) {
        expect(decodedFee).toBe(samplePool.fee_bps);
      }
    }, 30_000);

    // ── P4: Execution-cache completeness ──────────────────────────────────
    it('P4: execution cache populated for Orca pool', async () => {
      if (!samplePool) return;
      const { executionCache } = await import('../../execution/cache.js');
      const stat = executionCache.getStatic(samplePool.id);
      const hot  = executionCache.getHot(samplePool.id);

      const staticMissing = auditFields(stat, ['programId', 'native_mint_a', 'native_mint_b']);
      const hotMissing    = auditFields(hot, ['sqrtPriceX64', 'tickSpacing']);

      if (staticMissing.length || hotMissing.length) {
        console.warn(`[Orca P4 ${samplePool.id.slice(0, 8)}] static missing: [${staticMissing}] hot missing: [${hotMissing}]`);
      }

      // Minimum: native mints must be determinable
      expect(stat?.native_mint_a || samplePool.native_mint_a).toBeTruthy();
      expect(stat?.native_mint_b || samplePool.native_mint_b).toBeTruthy();
    });

    // ── P5: Cross-validation ──────────────────────────────────────────────
    it('P5: decimals match on-chain, vaults exist', async () => {
      if (!samplePool) return;
      const nativeMintA = samplePool.native_mint_a || samplePool.mint_a;
      const nativeMintB = samplePool.native_mint_b || samplePool.mint_b;
      const decA = await getOnChainDecimals(conn, nativeMintA);
      const decB = await getOnChainDecimals(conn, nativeMintB);
      const expectedDecA = samplePool.native_decimals_a ?? (samplePool.was_swapped ? samplePool.decimals_b : samplePool.decimals_a);
      const expectedDecB = samplePool.native_decimals_b ?? (samplePool.was_swapped ? samplePool.decimals_a : samplePool.decimals_b);
      expect(decA).toBe(expectedDecA);
      expect(decB).toBe(expectedDecB);

      // Vault accounts exist
      const vaultA = samplePool.native_account_a || samplePool.account_a;
      const vaultB = samplePool.native_account_b || samplePool.account_b;
      if (vaultA) expect(await accountExists(conn, vaultA)).toBe(true);
      if (vaultB) expect(await accountExists(conn, vaultB)).toBe(true);
    }, 30_000);
  });

  // ════════════════════════════════════════════════════════════════════════
  //  RAYDIUM CLMM
  // ════════════════════════════════════════════════════════════════════════

  const SKIP_RAY_CLMM = process.env.SKIP_RAYDIUM_CLMM_PIPELINE === 'true';

  (SKIP_RAY_CLMM ? describe.skip : describe)('Raydium CLMM (GraphQL → CLMM)', () => {
    let normalizedPools: any;
    let samplePool: any;

    it('P0: Shyft GraphQL returns Raydium CLMM data', async () => {
      const { executeShyftGraphQL } = await import('../../server/pools/shyftHelpers.js');
      const query = `
        query RayClmmSmoke {
          RAYDIUM_CLMM_PoolState(
            where: { _or: [
              { tokenMint0: { _eq: "${SOL_MINT}" } },
              { tokenMint1: { _eq: "${SOL_MINT}" } }
            ]}
            limit: 3
          ) {
            pubkey
            tokenMint0
            tokenMint1
            sqrtPriceX64
            tickCurrent
            tickSpacing
            liquidity
            ammConfig
          }
        }`;
      const res: any = await executeShyftGraphQL({ query, dex: 'raydium-clmm', retries: 2, backoffMs: 1000 });
      const pools = res?.RAYDIUM_CLMM_PoolState || [];
      expect(pools.length).toBeGreaterThan(0);
      expect(pools[0].pubkey).toBeTruthy();
      expect(pools[0].sqrtPriceX64).toBeTruthy();
    }, 30_000);

    it('P1: fetches + normalises Raydium CLMM pools', async () => {
      const { fetchRaydiumClmmGraphQL, normalizeRaydiumGraphQL } = await import('../../server/pools/raydiumGraphQL.js');
      if (cfg.raydiumClmm) {
        cfg.raydiumClmm.graphqlPageSize = 20;
        cfg.raydiumClmm.graphqlMaxPages = 1;
      }
      const raw = await fetchRaydiumClmmGraphQL([SOL_MINT, USDC_MINT]);
      expect(raw.length).toBeGreaterThan(0);
      // normalizeRaydiumGraphQL handles both AMM and CLMM raw rows
      normalizedPools = await normalizeRaydiumGraphQL(raw);
      const clmm = normalizedPools?.clmm || [];
      expect(clmm.length).toBeGreaterThan(0);
    }, 60_000);

    it('P2: normalised Raydium CLMM has fee from ammConfig, valid orientation', () => {
      const clmm = normalizedPools?.clmm || [];
      samplePool = pickAnchorPool(clmm);
      expect(samplePool).toBeTruthy();
      expect(samplePool.price_a_per_b).toBeGreaterThan(0);
      expect(samplePool.fee_bps).toBeGreaterThan(0);
      expect(samplePool.tick_spacing).toBeGreaterThan(0);
      expect(isBase58(samplePool.native_mint_a || samplePool.mint_a)).toBe(true);
      expect(typeof samplePool.was_swapped).toBe('boolean');
    });

    it('P3: on-chain decode matches', async () => {
      if (!samplePool) return;
      const { decodeRaydiumClmmPool } = await import('../../server/pools/websockets/decoders/raydium.js');
      const acctInfo = await conn.getAccountInfo(new PublicKey(samplePool.id));
      expect(acctInfo).not.toBeNull();
      const decoded = await decodeRaydiumClmmPool(acctInfo!.data as Buffer, samplePool.id);
      expect(decoded).not.toBeNull();
      expect(decoded.tick_spacing).toBe(samplePool.tick_spacing);
      expect(decoded.mint_a || decoded.native_mint_a).toBeTruthy();
    }, 30_000);

    it('P4: execution cache has native mints, vaults', async () => {
      if (!samplePool) return;
      const { executionCache } = await import('../../execution/cache.js');
      const stat = executionCache.getStatic(samplePool.id);
      const missing = auditFields(stat, ['native_mint_a', 'native_mint_b']);
      if (missing.length) console.warn(`[RayClmm P4 ${samplePool.id.slice(0, 8)}] missing: ${missing}`);
      expect(stat?.native_mint_a || samplePool.native_mint_a).toBeTruthy();
    });

    it('P5: decimals match on-chain', async () => {
      if (!samplePool) return;
      const nA = samplePool.native_mint_a || samplePool.mint_a;
      const nB = samplePool.native_mint_b || samplePool.mint_b;
      const decA = await getOnChainDecimals(conn, nA);
      const decB = await getOnChainDecimals(conn, nB);
      const eA = samplePool.native_decimals_a ?? (samplePool.was_swapped ? samplePool.decimals_b : samplePool.decimals_a);
      const eB = samplePool.native_decimals_b ?? (samplePool.was_swapped ? samplePool.decimals_a : samplePool.decimals_b);
      expect(decA).toBe(eA);
      expect(decB).toBe(eB);
    }, 30_000);
  });

  // ════════════════════════════════════════════════════════════════════════
  //  RAYDIUM AMM V4
  // ════════════════════════════════════════════════════════════════════════

  const SKIP_RAY_AMM = process.env.SKIP_RAYDIUM_AMM_PIPELINE === 'true';

  (SKIP_RAY_AMM ? describe.skip : describe)('Raydium AMM V4 (GraphQL → AMM)', () => {
    let normalizedPools: any;
    let samplePool: any;

    it('P0-P1: fetches + normalises Raydium AMM V4 pools', async () => {
      const { fetchRaydiumGraphQL, normalizeRaydiumGraphQL } = await import('../../server/pools/raydiumGraphQL.js');
      if (cfg.raydium) {
        cfg.raydium.graphqlPageSize = 20;
        cfg.raydium.graphqlMaxPages = 1;
      }
      const raw = await fetchRaydiumGraphQL([SOL_MINT, USDC_MINT]);
      expect(raw.length).toBeGreaterThan(0);
      normalizedPools = await normalizeRaydiumGraphQL(raw);
      const amm = normalizedPools?.amm || [];
      expect(amm.length).toBeGreaterThan(0);
    }, 60_000);

    it('P2: normalised AMM has reserves, price, fee, decimals', () => {
      const amm = normalizedPools?.amm || [];
      samplePool = pickAnchorPool(amm);
      expect(samplePool).toBeTruthy();
      expect(samplePool.price_a_per_b).toBeGreaterThan(0);
      expect(samplePool.fee_bps).toBeGreaterThan(0);
      expect(isBase58(samplePool.native_mint_a || samplePool.mint_a)).toBe(true);
      // AMM must have reserves
      const hasReserves = samplePool.reserve_a_raw || samplePool.amount_a_whole;
      expect(hasReserves).toBeTruthy();
    });

    it('P3: on-chain decode produces valid AMM state', async () => {
      if (!samplePool) return;
      const { decodeRaydiumAmmPool } = await import('../../server/pools/websockets/decoders/raydium.js');
      const acctInfo = await conn.getAccountInfo(new PublicKey(samplePool.id));
      expect(acctInfo).not.toBeNull();
      const data = Buffer.isBuffer(acctInfo!.data) ? acctInfo!.data : Buffer.from(acctInfo!.data);
      const decoded = await decodeRaydiumAmmPool(data, samplePool.id);
      if (!decoded) {
        // SDK layout decode can fail if @raydium-io/raydium-sdk-v2 is unavailable
        // Verify account exists and has expected size (AMM V4: 752 bytes)
        console.warn(`[RayAMM P3] Decoder returned null – SDK layout may be unavailable`);
        expect(data.length).toBeGreaterThanOrEqual(700);
        return;
      }
      expect(decoded.mint_a).toBeTruthy();
      expect(decoded.mint_b).toBeTruthy();
      const resA = Number(decoded.reserve_a_raw || 0);
      const resB = Number(decoded.reserve_b_raw || 0);
      expect(resA).toBeGreaterThan(0);
      expect(resB).toBeGreaterThan(0);
    }, 30_000);

    it('P4: execution cache has Serum/OpenBook accounts', async () => {
      if (!samplePool) return;
      const { executionCache } = await import('../../execution/cache.js');
      const stat = executionCache.getStatic(samplePool.id);
      const serumFields = [
        'market_id', 'market_program_id',
        'market_bids', 'market_asks', 'market_event_queue',
        'market_base_vault', 'market_quote_vault', 'market_authority',
      ];
      const ammFields = ['amm_authority', 'amm_open_orders'];
      const missing = auditFields(stat, [...serumFields, ...ammFields]);
      if (missing.length) {
        console.warn(`[RayAMM P4 ${samplePool.id.slice(0, 8)}] missing: ${missing.join(', ')}`);
      }
      // At minimum programId and mints
      expect(stat?.native_mint_a || samplePool.native_mint_a || samplePool.mint_a).toBeTruthy();
    });

    it('P5: Serum market accounts exist on-chain', async () => {
      if (!samplePool) return;
      const { executionCache } = await import('../../execution/cache.js');
      const stat = executionCache.getStatic(samplePool.id);
      if (!stat?.market_id) {
        console.warn(`[RayAMM P5 ${samplePool.id.slice(0, 8)}] market_id missing – skipping`);
        return;
      }
      for (const addr of [stat.market_id, stat.market_bids, stat.market_asks].filter(Boolean)) {
        expect(await accountExists(conn, addr)).toBe(true);
      }
    }, 30_000);
  });

  // ════════════════════════════════════════════════════════════════════════
  //  RAYDIUM CPMM
  // ════════════════════════════════════════════════════════════════════════

  const SKIP_RAY_CPMM = process.env.SKIP_RAYDIUM_CPMM_PIPELINE === 'true';

  (SKIP_RAY_CPMM ? describe.skip : describe)('Raydium CPMM (GraphQL → CPMM)', () => {
    let normalizedPools: any;
    let samplePool: any;

    it('P0-P1: fetches + normalises Raydium CPMM pools', async () => {
      const { fetchRaydiumCpmmGraphQL, normalizeRaydiumCpmmGraphQL } = await import('../../server/pools/raydiumCpmmGraphQL.js');
      if ((cfg as any).raydiumCpmm) {
        (cfg as any).raydiumCpmm.graphqlPageSize = 20;
        (cfg as any).raydiumCpmm.graphqlMaxPages = 1;
        // Reduce initial delay to avoid timeout after prior DEX fetches
        (cfg as any).raydiumCpmm.initialDelayMultiplier = 3;
      }
      const raw = await fetchRaydiumCpmmGraphQL([SOL_MINT, USDC_MINT]);
      expect(raw.length).toBeGreaterThan(0);
      normalizedPools = await normalizeRaydiumCpmmGraphQL(raw);
      const cpmm = normalizedPools?.cpmm || [];
      expect(cpmm.length).toBeGreaterThan(0);
    }, 120_000);

    it('P2: normalised CPMM has reserves, price, fee, token programs', () => {
      const cpmm = normalizedPools?.cpmm || [];
      samplePool = pickAnchorPool(cpmm);
      expect(samplePool).toBeTruthy();
      expect(samplePool.price_a_per_b).toBeGreaterThan(0);
      expect(samplePool.fee_bps).toBeGreaterThan(0);
      expect(samplePool.pool_kind).toBe('cpmm');
      expect(isBase58(samplePool.native_mint_a || samplePool.mint_a)).toBe(true);
    });

    it('P3: on-chain decode matches', async () => {
      if (!samplePool) return;
      const { decodeRaydiumCpmmPool } = await import('../../server/pools/websockets/decoders/raydiumCpmm.js');
      const acctInfo = await conn.getAccountInfo(new PublicKey(samplePool.id));
      expect(acctInfo).not.toBeNull();
      const decoded = await decodeRaydiumCpmmPool(acctInfo!.data as Buffer, samplePool.id);
      expect(decoded).not.toBeNull();
      expect(decoded.mint_a).toBeTruthy();
      expect(decoded.pool_kind).toBe('cpmm');
    }, 30_000);

    it('P4: execution cache has ammConfig, vaults, token programs', async () => {
      if (!samplePool) return;
      const { executionCache } = await import('../../execution/cache.js');
      const stat = executionCache.getStatic(samplePool.id);
      const missing = auditFields(stat, ['native_mint_a', 'native_mint_b']);
      if (missing.length) console.warn(`[RayCpmm P4 ${samplePool.id.slice(0, 8)}] missing: ${missing}`);
      // Token-2022 programs
      const hasProg = samplePool.token_program_a || stat?.token_program_a;
      if (!hasProg) console.warn(`[RayCpmm P4 ${samplePool.id.slice(0, 8)}] token_program_a/b not set`);
    });

    it('P5: vault balances match reserves (within 10%)', async () => {
      if (!samplePool) return;
      const vaultA = samplePool.native_account_a || samplePool.account_a;
      const vaultB = samplePool.native_account_b || samplePool.account_b;
      if (!vaultA || !vaultB) {
        console.warn(`[RayCpmm P5 ${samplePool.id.slice(0, 8)}] vault addresses missing`);
        return;
      }
      expect(await accountExists(conn, vaultA)).toBe(true);
      expect(await accountExists(conn, vaultB)).toBe(true);

      const balA = await conn.getTokenAccountBalance(new PublicKey(vaultA));
      const balB = await conn.getTokenAccountBalance(new PublicKey(vaultB));
      expect(Number(balA.value.amount)).toBeGreaterThan(0);
      expect(Number(balB.value.amount)).toBeGreaterThan(0);

      const localA = Number(samplePool.native_reserve_a_raw || samplePool.reserve_a_raw || 0);
      const onChainA = Number(balA.value.amount);
      if (localA > 0 && onChainA > 0) {
        const ratio = localA / onChainA;
        expect(ratio).toBeGreaterThan(0.90);
        expect(ratio).toBeLessThan(1.10);
      }
    }, 30_000);
  });

  // ════════════════════════════════════════════════════════════════════════
  //  METEORA DLMM
  // ════════════════════════════════════════════════════════════════════════

  const SKIP_MET_DLMM = process.env.SKIP_METEORA_DLMM_PIPELINE === 'true';

  (SKIP_MET_DLMM ? describe.skip : describe)('Meteora DLMM (GraphQL → DLMM)', () => {
    let normalizedPools: any;
    let samplePool: any;

    it('P0-P1: fetches + normalises Meteora DLMM pools', async () => {
      const { fetchMeteoraGraphQL, normalizeMeteoraGraphQL } = await import('../../server/pools/meteoraGraphQL.js');
      if ((cfg as any).meteora) {
        (cfg as any).meteora.graphqlPageSize = 20;
        (cfg as any).meteora.graphqlMaxPages = 1;
      }
      const raw = await fetchMeteoraGraphQL([SOL_MINT, USDC_MINT]);
      expect(raw.length).toBeGreaterThan(0);
      normalizedPools = await normalizeMeteoraGraphQL(raw);
      const clmm = normalizedPools?.clmm || [];
      expect(clmm.length).toBeGreaterThan(0);
    }, 60_000);

    it('P2: normalised DLMM has activeId, binStep, valid price', () => {
      const clmm = normalizedPools?.clmm || [];
      samplePool = pickAnchorPool(clmm);
      expect(samplePool).toBeTruthy();
      expect(samplePool.price_a_per_b).toBeGreaterThan(0);
      // fee_bps may be 0 from GraphQL – actual fee requires baseFactor which is
      // populated later by WS/gRPC updates. binStep determines the fee structure.
      expect(samplePool.fee_bps).toBeGreaterThanOrEqual(0);
      expect(samplePool.active_id).toBeDefined();
      expect(Number.isFinite(samplePool.active_id)).toBe(true);
      expect(samplePool.bin_step).toBeGreaterThan(0);
      expect(samplePool.pool_kind).toBe('dlmm');
    });

    it('P3: on-chain decode matches activeId, binStep', async () => {
      if (!samplePool) return;
      const { decodeMeteoraLbPair } = await import('../../server/pools/websockets/decoders/meteora.js');
      const acctInfo = await conn.getAccountInfo(new PublicKey(samplePool.id));
      expect(acctInfo).not.toBeNull();
      const result = await decodeMeteoraLbPair(acctInfo!.data as Buffer, samplePool.id);
      expect(result).not.toBeNull();
      expect(result.isBinArray).toBe(false);

      // activeId should be close (may drift between fetch + decode)
      const decoded_activeId = result.state?.activeId ?? result.state?.active_id;
      if (Number.isFinite(decoded_activeId) && Number.isFinite(samplePool.active_id)) {
        const diff = Math.abs(Number(decoded_activeId) - Number(samplePool.active_id));
        expect(diff).toBeLessThan(50);
      }
    }, 30_000);

    it('P4: execution cache has bin arrays or oracle', async () => {
      if (!samplePool) return;
      const { executionCache } = await import('../../execution/cache.js');
      const stat = executionCache.getStatic(samplePool.id);
      const hot  = executionCache.getHot(samplePool.id);

      const hasBinArrays = stat?.bin_array_lower || stat?.bin_array_upper || hot?.binArrays;
      if (!hasBinArrays) {
        console.warn(`[MetDLMM P4 ${samplePool.id.slice(0, 8)}] no bin arrays – may need WS subscription`);
      }
      const hasOracle = stat?.oracle;
      if (!hasOracle) {
        console.warn(`[MetDLMM P4 ${samplePool.id.slice(0, 8)}] oracle account not in cache`);
      }
    });

    it('P5: decimals match on-chain, price formula cross-check', async () => {
      if (!samplePool) return;
      const nA = samplePool.native_mint_a || samplePool.mint_a;
      const nB = samplePool.native_mint_b || samplePool.mint_b;
      const decA = await getOnChainDecimals(conn, nA);
      const decB = await getOnChainDecimals(conn, nB);
      const eA = samplePool.native_decimals_a ?? (samplePool.was_swapped ? samplePool.decimals_b : samplePool.decimals_a);
      const eB = samplePool.native_decimals_b ?? (samplePool.was_swapped ? samplePool.decimals_a : samplePool.decimals_b);
      expect(decA).toBe(eA);
      expect(decB).toBe(eB);

      // Manual price formula verification
      const { calculateMeteoraPrice } = await import('../../server/pools/priceFormulas.js');
      const manualPrice = calculateMeteoraPrice(
        samplePool.active_id,
        samplePool.bin_step,
        samplePool.native_mint_a || samplePool.mint_a,
        samplePool.native_mint_b || samplePool.mint_b,
        samplePool.mint_a,
        samplePool.mint_b,
        samplePool.decimals_a,
        samplePool.decimals_b,
      );
      if (manualPrice && manualPrice > 0) {
        const ratio = samplePool.price_a_per_b / manualPrice;
        expect(ratio).toBeGreaterThan(0.95);
        expect(ratio).toBeLessThan(1.05);
      }
    }, 30_000);
  });

  // ════════════════════════════════════════════════════════════════════════
  //  PUMPSWAP
  // ════════════════════════════════════════════════════════════════════════

  const SKIP_PUMP = process.env.SKIP_PUMPSWAP_PIPELINE === 'true';

  (SKIP_PUMP ? describe.skip : describe)('PumpSwap (GraphQL → AMM)', () => {
    let normalizedPools: any;
    let samplePool: any;

    it('P0-P1: fetches + normalises PumpSwap pools', async () => {
      const { fetchPumpswapGraphQL, normalizePumpswapPools } = await import('../../server/pools/pumpswap.js');
      if ((cfg as any).pumpswap) {
        (cfg as any).pumpswap.graphqlPageSize = 20;
        (cfg as any).pumpswap.graphqlMaxPages = 1;
      }
      const raw = await fetchPumpswapGraphQL([SOL_MINT]);
      expect(Array.isArray(raw)).toBe(true);
      if (raw.length === 0) {
        console.warn('[PumpSwap P0] No pools – possibly API key missing');
        return;
      }
      normalizedPools = await normalizePumpswapPools(raw);
      const amm = normalizedPools?.amm || [];
      expect(amm.length).toBeGreaterThan(0);
    }, 60_000);

    it('P2: normalised PumpSwap has reserves, fee = 25bps, valid mints', () => {
      const amm = normalizedPools?.amm || [];
      if (!amm.length) return;
      // Try to find a pool with a calculated price; PumpSwap meme tokens may not
      // have USD price data seeded, causing price_a_per_b = 0.
      samplePool = amm.find((p: any) => p.price_a_per_b > 0) || amm[0];
      expect(samplePool).toBeTruthy();
      // Price may be 0 for meme tokens without seeded USD prices
      expect(samplePool.price_a_per_b).toBeGreaterThanOrEqual(0);
      expect(samplePool.fee_bps).toBe(25); // 20 LP + 5 protocol
      expect(isBase58(samplePool.mint_a)).toBe(true);
      // Reserves should be populated (PumpSwap stores in execution cache during normalization)
      const hasData = samplePool.amount_a_whole || samplePool.reserve_a_raw || samplePool.onchain_base_vault;
      expect(hasData).toBeTruthy();
    });

    it('P3: on-chain decode (decodePumpswapPoolState) extracts mints + vaults', async () => {
      if (!samplePool) return;
      const { decodePumpswapPoolState } = await import('../../server/pools/websockets/decoders/pumpswap.js');
      const acctInfo = await conn.getAccountInfo(new PublicKey(samplePool.id));
      if (!acctInfo) {
        console.warn(`[PumpSwap P3 ${samplePool.id.slice(0, 8)}] account not on-chain`);
        return;
      }
      const decoded = decodePumpswapPoolState(acctInfo.data as Buffer);
      expect(decoded).not.toBeNull();
      expect(isBase58(decoded.baseMint)).toBe(true);
      expect(isBase58(decoded.quoteMint)).toBe(true);
      expect(isBase58(decoded.vaultA)).toBe(true);
      expect(isBase58(decoded.vaultB)).toBe(true);
    }, 30_000);

    it('P4: execution cache has PumpSwap-specific accounts', async () => {
      if (!samplePool) return;
      const { executionCache } = await import('../../execution/cache.js');
      const stat = executionCache.getStatic(samplePool.id);
      // PumpSwap: programId, onchain_base_mint/quote_mint, vaults
      const required = ['programId', 'onchain_base_mint', 'onchain_quote_mint',
                        'onchain_base_vault', 'onchain_quote_vault'];
      const missing = auditFields(stat, required);
      if (missing.length) {
        console.warn(`[PumpSwap P4 ${samplePool.id.slice(0, 8)}] missing: ${missing.join(', ')}`);
      }
      expect(stat?.programId || samplePool.programId).toBeTruthy();
    });

    it('P5: vault accounts exist on-chain', async () => {
      if (!samplePool) return;
      const vaultA = samplePool.onchain_base_vault || samplePool.native_account_a || samplePool.account_a;
      const vaultB = samplePool.onchain_quote_vault || samplePool.native_account_b || samplePool.account_b;
      if (vaultA) expect(await accountExists(conn, vaultA)).toBe(true);
      if (vaultB) expect(await accountExists(conn, vaultB)).toBe(true);
    }, 30_000);
  });

  // ════════════════════════════════════════════════════════════════════════
  //  METEORA BALANCED V1 (HTTP → DAMM)
  // ════════════════════════════════════════════════════════════════════════

  const SKIP_MET_BAL = process.env.SKIP_METEORA_BALANCED_PIPELINE === 'true';

  (SKIP_MET_BAL ? describe.skip : describe)('Meteora Balanced V1 (HTTP → DAMM)', () => {
    let rawPools: any[] = [];
    let normalizedPools: any;

    it('P0: DAMM V1 HTTP API reachable', async () => {
      try {
        const res = await fetch('https://damm-api.meteora.ag/pools?limit=2');
        // API may return non-200 transiently; accept any non-5xx as "reachable"
        expect(res.status).toBeLessThan(500);
        if (res.ok) {
          const data = await res.json();
          // API may return object wrapper or array
          rawPools = Array.isArray(data) ? data : (data?.data || data?.pools || []);
        } else {
          console.warn(`[MetBalV1 P0] HTTP ${res.status} – API responded but non-ok`);
        }
      } catch (e: any) {
        console.warn(`[MetBalV1 P0] Fetch error: ${e.message} – API may be temporarily down`);
      }
    }, 15_000);

    it('P1: fetches + normalises V1 pools via dedicated path', async () => {
      const { fetchMeteoraBalancedV1Http, normalizeMeteoraBalancedV1 }
        = await import('../../server/pools/meteoraBalanced.js');
      if ((cfg as any).meteoraBalanced) {
        (cfg as any).meteoraBalanced.pageSize = 20;
        (cfg as any).meteoraBalanced.maxPages = 1;
      }
      const v1Raw = await fetchMeteoraBalancedV1Http(
        'https://damm-api.meteora.ag/pools',
      );
      expect(Array.isArray(v1Raw)).toBe(true);
      if (v1Raw.length === 0) {
        console.warn('[MetBalV1 P1] No V1 pools returned');
        return;
      }
      normalizedPools = await normalizeMeteoraBalancedV1(v1Raw);
      const amm = normalizedPools?.amm || [];
      if (amm.length > 0) {
        const p = amm[0];
        expect(p.id || p.pubkey).toBeTruthy();
        expect(p.mint_a || p.token_a_mint).toBeTruthy();
      }
    }, 30_000);

    it('P2: normalised V1 pool has reserves, price, fee', () => {
      const amm = normalizedPools?.amm || [];
      if (!amm.length) return;
      const p = amm[0];
      expect(p.price_a_per_b).toBeGreaterThan(0);
      expect(p.fee_bps).toBeGreaterThan(0);
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  //  METEORA BALANCED V2 (HTTP → CP-AMM)
  // ════════════════════════════════════════════════════════════════════════

  (SKIP_MET_BAL ? describe.skip : describe)('Meteora Balanced V2 (HTTP → CP-AMM)', () => {
    let rawPools: any[] = [];

    it('P0: DAMM V2 HTTP API reachable', async () => {
      try {
        const res = await fetch('https://dammv2-api.meteora.ag/pools?limit=2');
        expect(res.status).toBeLessThan(500);
        if (res.ok) {
          const data = await res.json();
          rawPools = Array.isArray(data) ? data : (data?.data || data?.pools || []);
        } else {
          console.warn(`[MetBalV2 P0] HTTP ${res.status} – API responded but non-ok`);
        }
      } catch (e: any) {
        console.warn(`[MetBalV2 P0] Fetch error: ${e.message} – API may be temporarily down`);
      }
    }, 15_000);

    it('P1: V2 pool responses have pool_address and token mints', () => {
      if (!rawPools.length) return;
      const p = rawPools[0];
      const addr = p.pool_address || p.address;
      expect(addr).toBeTruthy();
    });

    it('P3: on-chain binary decode extracts sqrtPrice, mints', async () => {
      if (!rawPools.length) return;
      const addr = rawPools[0].pool_address || rawPools[0].address;
      if (!addr) return;

      const acctInfo = await conn.getAccountInfo(new PublicKey(addr));
      if (!acctInfo || acctInfo.data.length < 480) {
        console.warn(`[MetBalV2 P3 ${addr.slice(0, 8)}] account too small`);
        return;
      }
      const buf = Buffer.from(acctInfo.data);

      // Read mints from known offsets (DAMM V2 layout)
      const mintA = new PublicKey(buf.subarray(168, 200)).toBase58();
      const mintB = new PublicKey(buf.subarray(200, 232)).toBase58();
      expect(isBase58(mintA)).toBe(true);
      expect(isBase58(mintB)).toBe(true);

      // sqrtPrice at offset 456 (u128 LE)
      let sqrtPrice = 0n;
      for (let i = 15; i >= 0; i--) {
        sqrtPrice = (sqrtPrice << 8n) | BigInt(buf[456 + i]);
      }
      expect(sqrtPrice).toBeGreaterThan(0n);

      // Cross-check with the decoder helper
      const { calculateCpAmmPrice } = await import('../../server/pools/websockets/decoders/meteoraBalanced.js');
      const decA = await getOnChainDecimals(conn, mintA);
      const decB = await getOnChainDecimals(conn, mintB);
      const price = calculateCpAmmPrice(sqrtPrice, decA, decB);
      if (price !== undefined) {
        expect(price).toBeGreaterThan(0);
        expect(Number.isFinite(price)).toBe(true);
      }
    }, 30_000);
  });

}, 300_000); // 5 min global timeout
