import { logger } from '../utils/logger.js';
import { emit } from './realtime.js';
import { CONFIG } from '../utils/config.js';
import { readJson } from '../utils/fs.js';
import { enablePriceFeed, isPriceFeedEnabled } from './feedRegistry.js';
// Defer web3 imports to runtime to prevent type issues in environments without types
// import { PublicKey } from '@solana/web3.js';
import type { AmmPool, ClmmPool, PoolsPayload } from './pools/types.js';
import { anyToBigInt, ratioToDecimalString, sqrtPriceX64ToPriceRatio } from './pools/precision.js';
import { fetchRaydiumPoolsRaw as fetchRaydiumPoolsRawImpl, normalizeRaydiumPools as normalizeRaydiumPoolsImpl } from './pools/raydium.js';
import { fetchOrcaHttp as fetchOrcaHttpImpl, normalizeOrcaHttp as normalizeOrcaHttpImpl, deriveOrcaFeeBps } from './pools/orca.js';
import { fetchMeteoraHttp as fetchMeteoraHttpImpl, normalizeMeteoraHttp as normalizeMeteoraHttpImpl } from './pools/meteora.js';
import { fetchPumpswapGraphQL as fetchPumpswapGraphQLImpl, normalizePumpswapPools as normalizePumpswapPoolsImpl, enrichPumpswapPoolsWithRpc as enrichPumpswapPoolsWithRpcImpl } from './pools/pumpswap.js';
import { validateCrossDexPrices, verifyCanonicalization } from './pools/validation.js';
import { httpLogStart, httpLogResponse, httpLog429, httpLogNonOk } from './pools/httpLog.js';
import { fetchMeteoraBalancedHttp as fetchMeteoraBalancedHttpImpl, normalizeMeteoraBalancedHttp as normalizeMeteoraBalancedHttpImpl, fetchMeteoraBalancedAll as fetchMeteoraBalancedAllImpl } from './pools/meteoraBalanced.js';
import { canonicalizePairs } from './pools/common.js';
import { createProgram } from '@meteora-ag/dlmm';
import { PoolInfoLayout as RaydiumClmmLayout } from '@raydium-io/raydium-sdk-v2/lib/raydium/clmm/layout.js';
import BN from 'bn.js';
import { createHash } from 'crypto';

const raydiumCache: { data: PoolsPayload | null; ts: number; inflight?: Promise<PoolsPayload> } = { data: null, ts: 0 };
const orcaCache: { data: PoolsPayload | null; ts: number; inflight?: Promise<PoolsPayload> } = { data: null, ts: 0 };
const meteoraCache: { data: PoolsPayload | null; ts: number; inflight?: Promise<PoolsPayload> } = { data: null, ts: 0 };
const metbalCache: { data: PoolsPayload | null; ts: number; inflight?: Promise<PoolsPayload> } = { data: null, ts: 0 };
const pumpswapCache: { data: PoolsPayload | null; ts: number; inflight?: Promise<PoolsPayload> } = { data: null, ts: 0 };
const METEORA_DEFAULT_PROGRAM_ID = 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo';
const METEORA_BIN_BITMAP_SIZE = 512;
type MeteoraBinTracker = {
  indexes: Set<number>;
  accounts: Map<string, { id: number; index: number }>;
  binHashes: Map<string, string>;
  aggregate?: string;
};
const meteoraBinTrackers: Map<string, MeteoraBinTracker> = new Map();
const meteoraBinAccountToPool: Map<string, string> = new Map();

// Maps for tracking derived accounts (vaults, reserves, tick arrays) to their parent pool
const derivedAccountToPool: Map<string, { poolId: string; accountType: 'vault' | 'reserve' | 'tick_array' | 'oracle' | 'observation' }> = new Map();

// Track which pools have had their derived accounts attached (for lazy loading)
const poolsWithDerivedAccounts: Set<string> = new Set();

// WS lifecycle flags: defer websocket subscriptions until graph signals readiness
let wsAllowed: boolean = false;
let wsSetupActive: boolean = false;
let targetedWsActive: boolean = false;

function toB58Any(v: any): string {
  try { if (v && typeof v.toBase58 === 'function') return String(v.toBase58()); } catch {}
  try { const s = v?.toString?.(); if (typeof s === 'string') { const m = /^PublicKey\(([^)]+)\)$/.exec(s); return m ? m[1] : s; } } catch {}
  return typeof v === 'string' ? v : '';
}

// Apply token mint blocklist across normalized pools
function applyTokenMintBlocklist<T extends { mint_a: string; mint_b: string }>(
  pools: { amm: T[]; clmm: T[] },
  blocklist: Set<string>
): { amm: T[]; clmm: T[] } {
  if (!blocklist || blocklist.size === 0) return pools;
  const allow = (p: T) => !blocklist.has(p.mint_a) && !blocklist.has(p.mint_b);
  return {
    amm: (pools.amm || []).filter(allow),
    clmm: (pools.clmm || []).filter(allow),
  };
}

// Simple in-memory metrics for pool fetches and results
const poolsMetrics: {
  raydium: {
    fetches: number; lastMs: number; lastAmm: number; lastClmm: number;
    filteredAmm: number; filteredClmm: number; universe: string; zeroOverlapSkips: number;
    scannedPoolAccs: number; updatedFromPoolAccs: number; scannedVaults: number; updatedFromVaults: number;
    ownerClmmCount: number; ownerAmmCount: number; http429: number; backoffMs: number; apiBatches: number; apiBatchSizeAvg: number;
  };
  orca: { fetches: number; lastMs: number; lastAmm: number; lastClmm: number };
  meteora: { fetches: number; lastMs: number; lastClmm: number };
  meteora_balanced: { fetches: number; lastMs: number; lastAmm: number };
  pumpswap: { fetches: number; lastMs: number; lastAmm: number; enrichmentSuccess: number; enrichmentFail: number; enrichmentMs: number };
} = {
  raydium: {
    fetches: 0, lastMs: 0, lastAmm: 0, lastClmm: 0,
    filteredAmm: 0, filteredClmm: 0, universe: '', zeroOverlapSkips: 0,
    scannedPoolAccs: 0, updatedFromPoolAccs: 0, scannedVaults: 0, updatedFromVaults: 0,
    ownerClmmCount: 0, ownerAmmCount: 0, http429: 0, backoffMs: 0, apiBatches: 0, apiBatchSizeAvg: 0,
  },
  orca: { fetches: 0, lastMs: 0, lastAmm: 0, lastClmm: 0 },
  meteora: { fetches: 0, lastMs: 0, lastClmm: 0 },
  meteora_balanced: { fetches: 0, lastMs: 0, lastAmm: 0 },
  pumpswap: { fetches: 0, lastMs: 0, lastAmm: 0, enrichmentSuccess: 0, enrichmentFail: 0, enrichmentMs: 0 },
};

export function getPoolsMetrics(): any {
  return poolsMetrics;
}

// Raydium HTTP fetcher is implemented in ./pools/raydium.ts

 

 

 

// Compute normalized pool deltas (updated entries only) based on id and key fields
export function diffNormalizedPools(prev: PoolsPayload | null | undefined, next: PoolsPayload): { amm: AmmPool[]; clmm: ClmmPool[]; addedAmm: number; removedAmm: number; addedClmm: number; removedClmm: number } {
  const byId = <T extends { id: string }>(arr: T[] | undefined | null) => {
    const m = new Map<string, T>();
    for (const it of (arr || [])) { if (it && it.id) m.set(String(it.id), it); }
    return m;
  };
  const pA = byId(prev?.amm); const pC = byId(prev?.clmm);
  const nA = byId(next.amm); const nC = byId(next.clmm);
  const updatedAmm: AmmPool[] = [];
  const updatedClmm: ClmmPool[] = [];
  const eps = 1e-9;
  const changedAmm = (a?: AmmPool, b?: AmmPool): boolean => {
    if (!a || !b) return true;
    const reserveChanged = ((a as any).reserve_a_raw && (b as any).reserve_a_raw && (a as any).reserve_b_raw && (b as any).reserve_b_raw)
      ? ((a as any).reserve_a_raw !== (b as any).reserve_a_raw || (a as any).reserve_b_raw !== (b as any).reserve_b_raw)
      : false;
    if (reserveChanged) return true;
    const ratioChanged = ((a as any).price_a_per_b_num && (a as any).price_a_per_b_den && (b as any).price_a_per_b_num && (b as any).price_a_per_b_den)
      ? ((a as any).price_a_per_b_num !== (b as any).price_a_per_b_num || (a as any).price_a_per_b_den !== (b as any).price_a_per_b_den)
      : false;
    if (ratioChanged) return true;
    if (((a as any).liquidity_base_raw && (b as any).liquidity_base_raw) && (a as any).liquidity_base_raw !== (b as any).liquidity_base_raw) return true;
    if (Math.abs((a.price_a_per_b || 0) - (b.price_a_per_b || 0)) > eps) return true;
    if (Math.abs((a.liquidity_base || 0) - (b.liquidity_base || 0)) > eps) return true;
    if ((a.tvl_usd || 0) !== (b.tvl_usd || 0)) return true;
    return false;
  };
  const changedClmm = (a?: ClmmPool, b?: ClmmPool): boolean => {
    if (!a || !b) return true;
    const rawChanged = ((a as any).sqrt_price_x64_raw && (b as any).sqrt_price_x64_raw)
      ? (a as any).sqrt_price_x64_raw !== (b as any).sqrt_price_x64_raw
      : false;
    if (rawChanged) return true;
    const ratioChanged = ((a as any).price_a_per_b_num && (a as any).price_a_per_b_den && (b as any).price_a_per_b_num && (b as any).price_a_per_b_den)
      ? ((a as any).price_a_per_b_num !== (b as any).price_a_per_b_num || (a as any).price_a_per_b_den !== (b as any).price_a_per_b_den)
      : false;
    if (ratioChanged) return true;
    if (((a as any).liquidity_raw && (b as any).liquidity_raw) && (a as any).liquidity_raw !== (b as any).liquidity_raw) return true;
    if (Math.abs((a.liquidity || 0) - (b.liquidity || 0)) > 0) return true;
    if ((a.tvl_usd || 0) !== (b.tvl_usd || 0)) return true;
    if (Math.abs((a.price_a_per_b || 0) - (b.price_a_per_b || 0)) > eps) return true;
    if (Math.abs((a.amount_a || 0) - (b.amount_a || 0)) > 0) return true;
    if (Math.abs((a.amount_b || 0) - (b.amount_b || 0)) > 0) return true;
    if (((a as any).meteora_bin_hash || undefined) !== ((b as any).meteora_bin_hash || undefined)) return true;
    return false;
  };
  for (const [id, nx] of nA) { const pv = pA.get(id); if (!pv || changedAmm(pv, nx)) updatedAmm.push(nx); }
  for (const [id, nx] of nC) { const pv = pC.get(id); if (!pv || changedClmm(pv, nx)) updatedClmm.push(nx); }
  const addedAmm = Math.max(0, nA.size - pA.size);
  const addedClmm = Math.max(0, nC.size - pC.size);
  const removedAmm = Math.max(0, pA.size - nA.size);
  const removedClmm = Math.max(0, pC.size - nC.size);
  return { amm: updatedAmm, clmm: updatedClmm, addedAmm, removedAmm, addedClmm, removedClmm };
}

export async function normalizeRaydiumPools(raw: any): Promise<PoolsPayload> { return normalizeRaydiumPoolsImpl(raw); }

// Synchronous default normalizer for tests that import without awaiting.
// Mirrors core fields from normalizeRaydiumPools but avoids async imports and network calls.
export function defaultNormalizeRaydiumPools(raw: any): PoolsPayload {
  const now = Date.now();
  const amm: any[] = [];
  const clmm: any[] = [];
  const arr: any[] = Array.isArray(raw?.data?.data)
    ? raw.data.data
    : (Array.isArray(raw?.data) ? raw.data : (Array.isArray(raw) ? raw : []));
  const toMint = (v: any): string => {
    if (!v) return '';
    if (typeof v === 'string') return v;
    if ((v as any)?.address) return String((v as any).address);
    return '';
  };
  const toFeeBps = (v: any): number => {
    const n = Number(v);
    if (!Number.isFinite(n)) return 30;
    return n <= 1 ? Math.round(n * 10_000) : Math.round(n);
  };
  for (const it of (arr || [])) {
    if (!it) continue;
    const id = String(it?.id || it?.address || it?.pool_id || it?.ammId || '');
    const mintA = toMint(it?.mintA);
    const mintB = toMint(it?.mintB);
    if (!id || !mintA || !mintB) continue;
    const typeStr = String(it?.type || it?.poolType || '').toLowerCase();
    const pooltype = Array.isArray((it as any)?.pooltype) ? (it as any).pooltype : [];
    const tickSpacing = (it as any)?.tickSpacing ?? (it as any)?.config?.tickSpacing;
    const hasTick = typeof tickSpacing === 'number' && tickSpacing > 0; // Only consider valid tick spacing
    const isClmm = (
      typeStr.includes('concentrated') ||
      pooltype.map((s: any) => String(s).toLowerCase()).includes('clmm') ||
      hasTick ||
      (typeof (it as any)?.sqrtPriceX64 !== 'undefined' || typeof (it as any)?.sqrtPrice !== 'undefined')
    );
    const fee_bps = toFeeBps((it as any)?.feeRate ?? (it as any)?.tradeFeeRate ?? (it as any)?.feeBps ?? (it as any)?.tradeFeeBps);
    let decA = Number((it?.mintA as any)?.decimals);
    let decB = Number((it?.mintB as any)?.decimals);
    const price = Number((it as any)?.price);
    const tvl = Number((it as any)?.tvl);
    const mintAmountA = Number((it as any)?.mintAmountA);
    const mintAmountB = Number((it as any)?.mintAmountB);
    if (isClmm) {
      const tick = Number((it as any)?.tickSpacing ?? (it as any)?.config?.tickSpacing ?? 0);
      const sqrtCandidate = (it as any)?.sqrtPriceX64 ?? (it as any)?.sqrtPrice ?? 0;
      const sqrtBig = anyToBigInt(sqrtCandidate);
      const sqrt = typeof sqrtCandidate === 'number' ? sqrtCandidate : Number(sqrtBig ?? 0n);
      const liquidityCandidate = (it as any)?.liquidity ?? 0;
      const liquidity = Number(liquidityCandidate);
      const liquidityRaw = anyToBigInt(liquidityCandidate);
      const tvl_usd = Number.isFinite(tvl) && tvl > 0 ? tvl : undefined;
      let price_from_sqrt = 0;
      let ratio: ReturnType<typeof sqrtPriceX64ToPriceRatio> | null = null;
      if (sqrtBig && Number.isFinite(decA) && Number.isFinite(decB)) {
        ratio = sqrtPriceX64ToPriceRatio(sqrtBig, decA as number, decB as number);
        if (ratio?.float && Number.isFinite(ratio.float) && ratio.float > 0) {
          price_from_sqrt = ratio.float;
        }
      } else if (sqrt > 0 && Number.isFinite(decA) && Number.isFinite(decB)) {
        const two64 = Math.pow(2, 64);
        const calcRatio = sqrt / two64;
        const scale = Math.pow(10, (decB as number) - (decA as number));
        const cand = scale / (calcRatio * calcRatio);
        price_from_sqrt = Number.isFinite(cand) && cand > 0 ? cand : 0;
      }
      const px = price_from_sqrt > 0 ? price_from_sqrt : (Number(price) > 0 ? Number(price) : 0);
      clmm.push({
        id,
        dex: 'Raydium',
        mint_a: mintA,
        mint_b: mintB,
        fee_bps,
        sqrt_price_x64: Number.isFinite(sqrt) ? sqrt : 0,
        sqrt_price_x64_raw: sqrtBig ? sqrtBig.toString() : undefined,
        liquidity: Number.isFinite(liquidity) ? liquidity : 0,
        liquidity_raw: liquidityRaw ? liquidityRaw.toString() : undefined,
        'tick_spacing': Number.isFinite(tick) ? tick : 0,
        updated_ms: now,
        price_a_per_b: px > 0 ? px : undefined,
        price_a_per_b_num: ratio ? ratio.numerator.toString() : undefined,
        price_a_per_b_den: ratio ? ratio.denominator.toString() : undefined,
        price_a_per_b_exact: ratioToDecimalString(ratio) ?? undefined,
        decimals_a: Number.isFinite(decA) ? decA : undefined,
        decimals_b: Number.isFinite(decB) ? decB : undefined,
        pool_kind: 'clmm',
        tvl_usd,
      } as any);
    } else {
      const tvl_usd = Number.isFinite(tvl) && tvl > 0 ? tvl : undefined;
      const reserveA = Number((it as any)?.reserveA ?? NaN);
      const reserveB = Number((it as any)?.reserveB ?? NaN);
      const amount_a_whole = Number.isFinite(mintAmountA) ? mintAmountA : (Number.isFinite(reserveA) ? reserveA : undefined);
      const amount_b_whole = Number.isFinite(mintAmountB) ? mintAmountB : (Number.isFinite(reserveB) ? reserveB : undefined);
      const reserveA0 = Number((it as any)?.reserveA ?? 0);
      const reserveB0 = Number((it as any)?.reserveB ?? 0);
      const price_res = (Number.isFinite(amount_a_whole as any) && Number.isFinite(amount_b_whole as any) && (amount_b_whole as number) > 0)
        ? ((amount_a_whole as number) / (amount_b_whole as number))
        : ((reserveB0 > 0) ? (reserveA0 / reserveB0) : 0);
      const price_res_decs = (Number.isFinite(decA) && Number.isFinite(decB) && Number.isFinite(mintAmountA) && Number.isFinite(mintAmountB) && (mintAmountB as number) > 0)
        ? ((mintAmountA as number) / Math.pow(10, decA as number)) / ((mintAmountB as number) / Math.pow(10, decB as number))
        : 0;
      const px = price_res_decs > 0 ? price_res_decs : (price_res > 0 ? price_res : (Number(price) > 0 ? Number(price) : 0));
      const reserveARaw = anyToBigInt((it as any)?.reserveA ?? mintAmountA);
      const reserveBRaw = anyToBigInt((it as any)?.reserveB ?? mintAmountB);
      amm.push({
        id,
        dex: 'Raydium',
        mint_a: mintA,
        mint_b: mintB,
        fee_bps,
        price_a_per_b: Number.isFinite(px) ? px : 0,
        updated_ms: now,
        pool_kind: 'amm',
        tvl_usd,
        amount_a_whole,
        amount_b_whole,
        decimals_a: Number.isFinite(decA) ? decA : undefined,
        decimals_b: Number.isFinite(decB) ? decB : undefined,
        reserve_a_raw: reserveARaw ? reserveARaw.toString() : undefined,
        reserve_b_raw: reserveBRaw ? reserveBRaw.toString() : undefined,
      } as any);
    }
  }
  return { amm, clmm } as any;
}

let rayTimer: any | undefined;
let orcaTimer: any | undefined;
let meteoraTimer: any | undefined;
let wsUnsubscribe: (() => void) | undefined;
// Track current Connection instance and any pending close so new setups wait for a clean state
let wsConn: any | undefined;
let wsClosePromise: Promise<void> | null = null;
let healthTimer: any | undefined;
let lastWsEventMs: number = 0;
let wsHealthy: boolean = false;
let aggTimer: any | undefined;
const wsCounts: { raydium: number; orca: number; meteora?: number } = { raydium: 0, orca: 0, meteora: 0 };
const wsDeltaStats: Record<'raydium' | 'orca' | 'meteora', { decoded: number; applied: number; skipped: number; skipReasons?: Record<string, number> }> = {
  raydium: { decoded: 0, applied: 0, skipped: 0, skipReasons: {} },
  orca: { decoded: 0, applied: 0, skipped: 0, skipReasons: {} },
  meteora: { decoded: 0, applied: 0, skipped: 0, skipReasons: {} },
};

// Decode success/failure tracking for coverage verification
const wsDecodeStats: Record<'raydium' | 'orca' | 'meteora', { attempts: number; successes: number; failures: number }> = {
  raydium: { attempts: 0, successes: 0, failures: 0 },
  orca: { attempts: 0, successes: 0, failures: 0 },
  meteora: { attempts: 0, successes: 0, failures: 0 },
};

// Helper function to increment skip reason
function incrementSkipReason(dex: 'raydium' | 'orca' | 'meteora', reason: string): void {
  const stats = wsDeltaStats[dex];
  if (!stats.skipReasons) stats.skipReasons = {};
  stats.skipReasons[reason] = (stats.skipReasons[reason] || 0) + 1;
}
const wsDebugCounters: Record<'raydium' | 'orca' | 'meteora' | 'pumpswap', number> = { raydium: 0, orca: 0, meteora: 0, pumpswap: 0 };
const wsTargetDebugCounters: Record<'raydium' | 'orca' | 'meteora' | 'pumpswap', number> = { raydium: 0, orca: 0, meteora: 0, pumpswap: 0 };
let meteoraProgramInstance: any | null = null;

function debugLogTargeted(source: 'raydium' | 'orca' | 'meteora' | 'pumpswap', account: string, extra: Record<string, unknown>): void {
  try {
    const limit = Number((CONFIG.system as any)?.wsDebugAccountLogLimit ?? 10);
    if (!(limit > 0)) return;
    if (wsTargetDebugCounters[source] >= limit) return;
    wsTargetDebugCounters[source] += 1;
    logger.info('pools.ws debug.subscribe', { source, account, ...extra, cat: 'pools' });
  } catch {}
}

// Helper: parse SPL token account amount from raw account data
function parseTokenAccountAmount(data: Buffer | Uint8Array): bigint | null {
  try {
    // SPL Token account layout: amount is at offset 64 (u64, 8 bytes, little-endian)
    if (data.length < 72) return null;
    
    // Read 8 bytes as little-endian u64
    const bytes = data.slice(64, 72);
    let value = 0n;
    for (let i = 0; i < 8; i++) {
      value |= BigInt(bytes[i]) << BigInt(i * 8);
    }
    return value;
  } catch {
    return null;
  }
}

// Helper: find a pool in the caches by ID
function findPoolInCache(poolId: string): { pool: AmmPool | ClmmPool; source: 'raydium' | 'orca' | 'meteora' } | null {
  // Check Orca
  const orcaPools = orcaCache.data;
  if (orcaPools) {
    const orcaAmm = orcaPools.amm.find(p => p.id === poolId);
    if (orcaAmm) return { pool: orcaAmm, source: 'orca' };
    const orcaClmm = orcaPools.clmm.find(p => p.id === poolId);
    if (orcaClmm) return { pool: orcaClmm, source: 'orca' };
  }
  
  // Check Raydium
  const raydiumPools = raydiumCache.data;
  if (raydiumPools) {
    const rayAmm = raydiumPools.amm.find(p => p.id === poolId);
    if (rayAmm) return { pool: rayAmm, source: 'raydium' };
    const rayClmm = raydiumPools.clmm.find(p => p.id === poolId);
    if (rayClmm) return { pool: rayClmm, source: 'raydium' };
  }
  
  // Check Meteora
  const meteoraPools = meteoraCache.data;
  if (meteoraPools) {
    const metAmm = meteoraPools.amm.find(p => p.id === poolId);
    if (metAmm) return { pool: metAmm, source: 'meteora' };
    const metClmm = meteoraPools.clmm.find(p => p.id === poolId);
    if (metClmm) return { pool: metClmm, source: 'meteora' };
  }
  
  return null;
}
// Batching queue for getAccountInfo calls during subscription setup
const accountInfoQueue: Map<string, { resolve: (info: any) => void; reject: (err: any) => void }[]> = new Map();
let accountInfoBatchTimer: NodeJS.Timeout | null = null;

async function batchGetAccountInfo(conn: any, address: string): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!accountInfoQueue.has(address)) {
      accountInfoQueue.set(address, []);
    }
    accountInfoQueue.get(address)!.push({ resolve, reject });
    
    // Schedule batch processing
    if (!accountInfoBatchTimer) {
      accountInfoBatchTimer = setTimeout(async () => {
        accountInfoBatchTimer = null;
        const addresses = Array.from(accountInfoQueue.keys());
        if (addresses.length === 0) return;
        
        try {
          const { withRpcLimit } = await import('../utils/rpcLimiter.js');
          const web3 = await import('@solana/web3.js');
          const pks = addresses.map(addr => new web3.PublicKey(addr));
          
          // Use getMultipleAccountsInfo for batch fetch
          const weight = Math.max(1, Math.ceil(addresses.length / 100));
          const infos = await withRpcLimit(
            () => conn.getMultipleAccountsInfo(pks, CONFIG.system.txCommitment as any),
            weight,
            { module: 'pools', method: 'getMultipleAccountsInfo' }
          );
          
          // Resolve all promises
          addresses.forEach((addr, idx) => {
            const waiters = accountInfoQueue.get(addr) || [];
            const info = infos[idx];
            waiters.forEach(w => w.resolve(info));
            accountInfoQueue.delete(addr);
          });
        } catch (err) {
          // Reject all on error
          addresses.forEach(addr => {
            const waiters = accountInfoQueue.get(addr) || [];
            waiters.forEach(w => w.reject(err));
            accountInfoQueue.delete(addr);
          });
        }
      }, 50); // 50ms batch window
    }
  });
}

let attachedOrcaPools: number = 0;
  let attachedRaydiumPools: number = 0;
  let attachedMeteoraPools: number = 0;
  let attachedPumpswapPools: number = 0;
  let attachedMeteoraBalancedPools: number = 0;

// When true, the next call to startRaydiumRefreshLoop will attach WS subscriptions
// without starting timers or triggering an extra initial HTTP warmup fetch.
let suppressInitialOnce: boolean = false;
export function startPoolWebsocketsOnlyOnce(): void {
  suppressInitialOnce = true;
  try { enablePoolWebsocketRefreshes(); } catch {}
  startRaydiumRefreshLoop();
}

export function getWsActivity(): { orca: { attached: number; events: number }; raydium: { attached: number; events: number }; meteora: { attached: number; events: number } } {
  return {
    orca: { attached: attachedOrcaPools, events: wsCounts.orca || 0 },
    raydium: { attached: attachedRaydiumPools, events: wsCounts.raydium || 0 },
    meteora: { attached: attachedMeteoraPools, events: (wsCounts.meteora || 0) as number },
  };
}

// Compute target counts for WS subscriptions based on current graph edges per source
export async function getWsTargets(): Promise<{ orca: { target: number }; raydium: { target: number }; meteora: { target: number }; meteora_balanced: { target: number }; pumpswap: { target: number } }> {
  try {
    const { getGraphSnapshot } = await import('./graph.js');
    const snap = await getGraphSnapshot(false);
    const ray = new Set<string>();
    const orc = new Set<string>();
    const met = new Set<string>();
    const metBal = new Set<string>();
    const pump = new Set<string>();
    for (const e of (snap?.edges || [])) {
      const pid = String((e as any)?.pool_id || '');
      if (!pid) continue;
      const base = pid.replace(/-rev$/, '');
      const dex = String((e as any)?.dex || '');
      if (dex === 'Raydium') ray.add(base);
      else if (dex === 'Orca') orc.add(base);
      else if (dex === 'Meteora') met.add(base);
      else if (dex === 'MeteoraBalanced') metBal.add(base);
      else if (dex === 'Pumpswap') pump.add(base);
    }
    const out = { orca: { target: orc.size }, raydium: { target: ray.size }, meteora: { target: met.size }, meteora_balanced: { target: metBal.size }, pumpswap: { target: pump.size } };
    try { (getWsTargets as any)._last = out; } catch {}
    return out;
  } catch {
    const out = { orca: { target: 0 }, raydium: { target: 0 }, meteora: { target: 0 }, meteora_balanced: { target: 0 }, pumpswap: { target: 0 } };
    try { (getWsTargets as any)._last = out; } catch {}
    return out;
  }
}

// Expose cache ages for observability (ms since last fetch)
export function getPoolCacheAges(): { raydium: number; orca: number; meteora: number; meteora_balanced: number; ttl: { raydium: number; orca: number; meteora: number; meteora_balanced: number } } {
  const now = Date.now();
  const rayTtl = Number((CONFIG as any)?.raydium?.cacheTtlMs || 300_000);
  const orcTtl = Number((CONFIG as any)?.orca?.cacheTtlMs || 300_000);
  const metTtl = Number(((CONFIG as any)?.meteora?.cacheTtlMs) || 300_000);
  const mblTtl = Number(((CONFIG as any)?.meteoraBalanced?.cacheTtlMs) || 300_000);
  const rayAge = raydiumCache.ts ? (now - raydiumCache.ts) : Number.POSITIVE_INFINITY;
  const orcAge = orcaCache.ts ? (now - orcaCache.ts) : Number.POSITIVE_INFINITY;
  const metAge = meteoraCache.ts ? (now - meteoraCache.ts) : Number.POSITIVE_INFINITY;
  const mblAge = metbalCache.ts ? (now - metbalCache.ts) : Number.POSITIVE_INFINITY;
  return { raydium: rayAge, orca: orcAge, meteora: metAge, meteora_balanced: mblAge, ttl: { raydium: rayTtl, orca: orcTtl, meteora: metTtl, meteora_balanced: mblTtl } };
}

// Retarget WS: unsubscribe and re-subscribe to current graph-derived targets
// Uses sequential subscription with throttling to avoid RPC burst
export async function retargetPoolWebsockets(): Promise<{ attached: { orca: number; raydium: number; meteora: number; meteora_balanced: number; pumpswap: number } }> {
  try { 
    emit('log', { 
      level: 'info', 
      message: 'pools:ws retarget.start - sequential resubscription with throttling', 
      timestamp: new Date().toISOString(), 
      context: { cat: 'pools' } 
    }); 
  } catch {}
  
  // Step 1: Unsubscribe all existing subscriptions
  try { disablePoolWebsocketRefreshes(); } catch {}
  
  // Step 2: Wait for websocket cleanup to complete before starting new subscriptions
  try { 
    if (wsClosePromise) { 
      await wsClosePromise.catch(() => {}); 
      wsClosePromise = null;
    } 
  } catch {}
  
  // Step 3: Cooldown period to let RPC limiter refill tokens after unsubscribe burst
  const cooldownMs = Number((CONFIG.system as any)?.wsRetargetCooldownMs || 2000);
  try { 
    logger.info('pools.ws retarget.cooldown', { ms: cooldownMs, cat: 'pools' });
    emit('log', { 
      level: 'info', 
      message: `pools:ws retarget.cooldown ${cooldownMs}ms`, 
      timestamp: new Date().toISOString(), 
      context: { cat: 'pools' } 
    }); 
  } catch {}
  await new Promise(r => setTimeout(r, cooldownMs));
  
  // Step 3.5: Wait for any active setup to complete before starting new one
  // This prevents race condition where old setup's cleanup is still running
  try {
    const maxWait = Number((CONFIG.system as any)?.wsSetupMaxWaitMs || 10000);
    const started = Date.now();
    let waited = false;
    while (wsSetupActive && (Date.now() - started) < maxWait) {
      if (!waited) {
        try { 
          logger.info('pools.ws retarget.waiting_for_setup_clear', { cat: 'pools' });
        } catch {}
        waited = true;
      }
      await new Promise(r => setTimeout(r, 100));
    }
    if (wsSetupActive) {
      try { 
        logger.warn('pools.ws retarget.setup_still_active', { 
          waitedMs: Date.now() - started, 
          maxWaitMs: maxWait,
          cat: 'pools' 
        }); 
      } catch {}
    } else if (waited) {
      try {
        logger.info('pools.ws retarget.setup_cleared', { 
          waitedMs: Date.now() - started,
          cat: 'pools' 
        });
      } catch {}
    }
  } catch {}
  
  // Step 4: Start resubscription in SEQUENTIAL mode (flag tells setup to stagger DEX sources)
  try { 
    // Set sequential mode flag before starting
    (startPoolWebsocketsOnlyOnce as any).__sequentialMode = true;
    startPoolWebsocketsOnlyOnce(); 
  } catch {}
  
  // Step 5: Give subscriptions time to attach with sequential throttling
  // With sequential mode, this takes longer: (cooldown + orca_time + stagger + raydium_time + stagger + meteora_time)
  // Estimate: 2s cooldown + 6s orca + 5s stagger + 8s raydium + 5s stagger + 4s meteora = ~30s
  const attachWaitMs = Number((CONFIG.system as any)?.wsRetargetAttachWaitMs || 15000);
  try { 
    logger.info('pools.ws retarget.waiting', { ms: attachWaitMs, reason: 'sequential attachment', cat: 'pools' });
    emit('log', { 
      level: 'info', 
      message: `pools:ws retarget.waiting ${attachWaitMs}ms for sequential attachment`, 
      timestamp: new Date().toISOString(), 
      context: { cat: 'pools' } 
    }); 
  } catch {}
  await new Promise(r => setTimeout(r, attachWaitMs));
  
  // Step 6: Check health and report results
  try {
    const st = getPoolWsStatus();
    const attached = { orca: attachedOrcaPools, raydium: attachedRaydiumPools, meteora: attachedMeteoraPools, meteora_balanced: attachedMeteoraBalancedPools, pumpswap: attachedPumpswapPools };
    if (!st.healthy) {
      try { 
        logger.warn('pools.ws retarget.unhealthy', { attached, cat: 'pools' });
        emit('log', { 
          level: 'warn', 
          message: 'pools:ws unhealthy after retarget', 
          timestamp: new Date().toISOString(), 
          context: { cat: 'pools', attached } 
        }); 
      } catch {}
    } else {
      try { 
        logger.info('pools.ws retarget.complete', { attached, cat: 'pools' });
        emit('log', { 
          level: 'info', 
          message: `pools:ws retarget.complete healthy=true`, 
          timestamp: new Date().toISOString(), 
          context: { cat: 'pools', attached } 
        }); 
      } catch {}
    }
  } catch {}
  
  return { attached: { orca: attachedOrcaPools, raydium: attachedRaydiumPools, meteora: attachedMeteoraPools, meteora_balanced: attachedMeteoraBalancedPools, pumpswap: attachedPumpswapPools } };
}

// Unified refresh orchestrator: fetch all sources and optionally (re)subscribe
// REFACTORED: Sequential operations with proper filtering stages
export interface RefreshSourcesOptions {
  force?: boolean;
  subscribe?: boolean;
  // Control which DEXes to fetch (defaults from config if not specified)
  sources?: {
    raydium?: boolean | { amm?: boolean; clmm?: boolean };
    orca?: boolean | { amm?: boolean; clmm?: boolean };
    meteora?: boolean;
    meteora_balanced?: boolean;
    pumpswap?: boolean;
  };
}

export async function refreshAllSources(force = true, subscribe = true, opts?: RefreshSourcesOptions): Promise<{ raydium: PoolsPayload; orca: PoolsPayload; meteora: PoolsPayload; meteora_balanced: PoolsPayload; pumpswap: PoolsPayload }> {
  // Parse options with backward compatibility
  const options: RefreshSourcesOptions = {
    force: opts?.force ?? force,
    subscribe: opts?.subscribe ?? subscribe,
    sources: opts?.sources
  };
  
  // Load enabled sources from config (defaults to all enabled)
  const configSources = (CONFIG.system as any)?.enabledDexSources || {};
  const shouldFetch = {
    raydium: options.sources?.raydium ?? configSources.raydium ?? true,
    orca: options.sources?.orca ?? configSources.orca ?? true,
    meteora: options.sources?.meteora ?? configSources.meteora ?? true,
    meteora_balanced: options.sources?.meteora_balanced ?? configSources.meteora_balanced ?? true,
    pumpswap: options.sources?.pumpswap ?? configSources.pumpswap ?? true,
  };
  
  try {
    logger.info('pools.refresh.start', { 
      force: options.force, 
      subscribe: options.subscribe, 
      enabledSources: shouldFetch,
      caller: new Error().stack?.split('\n')?.[2]?.trim() || 'unknown',
      cat: 'pools' 
    });
    
    // Deep bootstrap phase: optionally pause feed/API, fetch Jup tokens, then hydrate prices
    if (force) {
      let shouldResumeFeed = false;
      const pauseFeed = ((CONFIG.system as any)?.pausePriceFeedDuringBootstrap !== false);
      if (pauseFeed) {
        try { emit('log', { level: 'info', message: 'pools:bootstrap api.pause', timestamp: new Date().toISOString(), context: { cat: 'pools' } }); } catch {}
        try { logger.info('pools:bootstrap api.pause', { cat: 'pools' }); } catch {}
        try {
          const reg: any = await import('./feedRegistry.js');
          shouldResumeFeed = reg.isPriceFeedEnabled?.() === true;
          reg.enablePriceFeed?.(false);
        } catch {}
        try { (await import('../jupiter/rateLimiter.js')).apiStop(); } catch {}
      }

      // Removed auto verified token refresh in refresh flow; use manual endpoint

      // Removed auto bootstrap on refresh; use manual endpoint

      // Resume Jupiter API before source fetches so downstream calls are allowed
      if (pauseFeed) {
        try { (await import('../jupiter/rateLimiter.js')).apiStart(); } catch {}
        try { emit('log', { level: 'info', message: 'pools:bootstrap api.resume', timestamp: new Date().toISOString(), context: { cat: 'pools' } }); } catch {}
        try { logger.info('pools:bootstrap api.resume', { cat: 'pools' }); } catch {}
        // Stash the intent to resume the feed at the end of refresh
        (refreshAllSources as any).__resumeFeed = shouldResumeFeed;
        // Opportunistically resume immediately if it was previously enabled
        try {
          if (shouldResumeFeed === true) {
            const reg: any = await import('./feedRegistry.js');
            reg.enablePriceFeed?.(true);
          }
        } catch {}
      }
    }
  } catch {}
  
  // === PHASE 1: FETCH ALL DEXES IN SEQUENCE (no filtering yet) ===
  logger.info('pools.refresh.phase.fetch', { enabled: shouldFetch, cat: 'pools' });
  
  let r: PoolsPayload = { amm: [], clmm: [] };
  let o: PoolsPayload = { amm: [], clmm: [] };
  let m: PoolsPayload = { amm: [], clmm: [] };
  let mb: PoolsPayload = { amm: [], clmm: [] };
  let pump: PoolsPayload = { amm: [], clmm: [] };
  
  if (shouldFetch.raydium) {
    try {
      r = await getRaydiumPoolsNormalized(!!options.force, { skipUniverseFilter: true });
      // Apply pool type filtering if specified
      if (typeof options.sources?.raydium === 'object') {
        const poolTypes = options.sources.raydium;
        if (poolTypes.amm === false) r.amm = [];
        if (poolTypes.clmm === false) r.clmm = [];
      }
    } catch (err) {
      logger.warn('pools.refresh.phase.fetch.raydium.failed', { error: String((err as any)?.message || err), cat: 'pools' });
      r = { amm: [], clmm: [] };
    }
  } else {
    logger.info('pools.refresh.phase.fetch.raydium.skipped', { reason: 'disabled', cat: 'pools' });
  }
  
  if (shouldFetch.orca) {
    try {
      o = await getOrcaPoolsCached(!!options.force, { skipUniverseFilter: true });
      // Apply pool type filtering if specified
      if (typeof options.sources?.orca === 'object') {
        const poolTypes = options.sources.orca;
        if (poolTypes.amm === false) o.amm = [];
        if (poolTypes.clmm === false) o.clmm = [];
      }
    } catch (err) {
      logger.warn('pools.refresh.phase.fetch.orca.failed', { error: String((err as any)?.message || err), cat: 'pools' });
      o = { amm: [], clmm: [] };
    }
  } else {
    logger.info('pools.refresh.phase.fetch.orca.skipped', { reason: 'disabled', cat: 'pools' });
  }
  
  if (shouldFetch.meteora) {
    try {
      m = await getMeteoraPoolsCached(!!options.force, { skipUniverseFilter: true });
    } catch (err) {
      logger.warn('pools.refresh.phase.fetch.meteora.failed', { error: String((err as any)?.message || err), cat: 'pools' });
      m = { amm: [], clmm: [] };
    }
  } else {
    logger.info('pools.refresh.phase.fetch.meteora.skipped', { reason: 'disabled', cat: 'pools' });
  }
  
  if (shouldFetch.meteora_balanced) {
    try {
      mb = await getMeteoraBalancedPoolsCached(!!options.force, { skipUniverseFilter: true });
    } catch (err) {
      logger.warn('pools.refresh.phase.fetch.meteora_balanced.failed', { error: String((err as any)?.message || err), cat: 'pools' });
      mb = { amm: [], clmm: [] };
    }
  } else {
    logger.info('pools.refresh.phase.fetch.meteora_balanced.skipped', { reason: 'disabled', cat: 'pools' });
  }
  
  if (shouldFetch.pumpswap) {
    try {
      pump = await getPumpswapPoolsCached(!!options.force);
    } catch (err) {
      logger.warn('pools.refresh.phase.fetch.pumpswap.failed', { error: String((err as any)?.message || err), cat: 'pools' });
      pump = { amm: [], clmm: [] };
    }
  } else {
    logger.info('pools.refresh.phase.fetch.pumpswap.skipped', { reason: 'disabled', cat: 'pools' });
  }
  
  try {
    const fetchCounts = {
      raydium: { amm: r.amm?.length || 0, clmm: r.clmm?.length || 0 },
      orca: { amm: o.amm?.length || 0, clmm: o.clmm?.length || 0 },
      meteora: { amm: m.amm?.length || 0, clmm: m.clmm?.length || 0 },
      meteora_balanced: { amm: mb.amm?.length || 0, clmm: mb.clmm?.length || 0 },
      pumpswap: { amm: pump.amm?.length || 0, clmm: pump.clmm?.length || 0 },
    };
    logger.info('pools.refresh.phase.fetch.complete', { counts: fetchCounts, cat: 'pools' });
  } catch {}
  
  // === PHASE 2: FILTER BY UNIVERSE (across all DEXes) ===
  logger.info('pools.refresh.phase.universe_filter', { cat: 'pools' });
  try {
    const mode = String((CONFIG.system as any)?.scopePoolsMode || 'jupiter');
    const scoped = CONFIG.system.scopePools !== false && mode !== 'none';
    if (scoped) {
      const { computeTokenUniverse, filterPoolsByUniverse } = await import('./universe.js');
      const universe = await computeTokenUniverse(mode as any);
      const anchorBridging = !!((CONFIG.system as any)?.enableAnchorBridging);
      
      const rScoped = filterPoolsByUniverse(r as any, universe, anchorBridging);
      const oScoped = filterPoolsByUniverse(o as any, universe, anchorBridging);
      const mScoped = filterPoolsByUniverse(m as any, universe, anchorBridging);
      const mbScoped = filterPoolsByUniverse(mb as any, universe, anchorBridging);
      const pScoped = filterPoolsByUniverse(pump as any, universe, anchorBridging);
      
      const beforeCounts = {
        raydium: (r.amm?.length || 0) + (r.clmm?.length || 0),
        orca: (o.amm?.length || 0) + (o.clmm?.length || 0),
        meteora: (m.amm?.length || 0) + (m.clmm?.length || 0),
        meteora_balanced: (mb.amm?.length || 0) + (mb.clmm?.length || 0),
        pumpswap: (pump.amm?.length || 0) + (pump.clmm?.length || 0),
      };
      
      r = rScoped as any;
      o = oScoped as any;
      m = mScoped as any;
      mb = mbScoped as any;
      pump = pScoped as any;
      
      const afterCounts = {
        raydium: (r.amm?.length || 0) + (r.clmm?.length || 0),
        orca: (o.amm?.length || 0) + (o.clmm?.length || 0),
        meteora: (m.amm?.length || 0) + (m.clmm?.length || 0),
        meteora_balanced: (mb.amm?.length || 0) + (mb.clmm?.length || 0),
        pumpswap: (pump.amm?.length || 0) + (pump.clmm?.length || 0),
      };
      
      logger.info('pools.refresh.phase.universe_filter.complete', { 
        mode, 
        before: beforeCounts, 
        after: afterCounts,
        cat: 'pools' 
      });
    }
  } catch (e: any) {
    logger.warn('pools.refresh.phase.universe_filter.failed', { error: String(e?.message || e), cat: 'pools' });
  }
  
  // === PHASE 3: FILTER BY MINIMUM POOLS PER PAIR (first pass) ===
  logger.info('pools.refresh.phase.min_pools_filter', { cat: 'pools' });
  try {
    const minPools = Math.max(1, Number(((CONFIG.system as any)?.minPoolsPerPair) || 1));
    if (minPools > 1) {
      const canonicalPairKey = (mintA: string, mintB: string): string => {
        const a = String(mintA || '');
        const b = String(mintB || '');
        return a <= b ? `${a}-${b}` : `${b}-${a}`;
      };
      
      // Count total pools per pair across all DEXes
      const poolCounts = new Map<string, number>();
      const countPools = (arr: any[]) => {
        for (const p of (arr || [])) {
          const pairKey = canonicalPairKey(p.mint_a, p.mint_b);
          poolCounts.set(pairKey, (poolCounts.get(pairKey) || 0) + 1);
        }
      };
      
      countPools(r.amm);
      countPools(r.clmm);
      countPools(o.amm);
      countPools(o.clmm);
      countPools(m.amm);
      countPools(m.clmm);
      countPools(mb.amm);
      countPools(pump.amm);
      
      // Allow pairs with at least minPools total pools
      const allow = new Set<string>();
      for (const [k, count] of poolCounts.entries()) {
        if (count >= minPools) {
          allow.add(k);
        }
      }
      
      const filt = <T extends { mint_a: string; mint_b: string }>(arr: T[]) => 
        (arr || []).filter(p => allow.has(canonicalPairKey(p.mint_a, p.mint_b)));
      
      const beforeCounts = {
        raydium: (r.amm?.length || 0) + (r.clmm?.length || 0),
        orca: (o.amm?.length || 0) + (o.clmm?.length || 0),
        meteora: (m.amm?.length || 0) + (m.clmm?.length || 0),
        meteora_balanced: (mb.amm?.length || 0) + (mb.clmm?.length || 0),
        pumpswap: (pump.amm?.length || 0) + (pump.clmm?.length || 0),
      };
      
      r = { amm: filt(r.amm), clmm: filt(r.clmm) } as any;
      o = { amm: filt(o.amm), clmm: filt(o.clmm) } as any;
      m = { amm: filt(m.amm), clmm: filt(m.clmm) } as any;
      mb = { amm: filt(mb.amm || []), clmm: filt(mb.clmm || []) } as any;
      pump = { amm: filt(pump.amm || []), clmm: filt(pump.clmm || []) } as any;
      
      const afterCounts = {
        raydium: (r.amm?.length || 0) + (r.clmm?.length || 0),
        orca: (o.amm?.length || 0) + (o.clmm?.length || 0),
        meteora: (m.amm?.length || 0) + (m.clmm?.length || 0),
        meteora_balanced: (mb.amm?.length || 0) + (mb.clmm?.length || 0),
        pumpswap: (pump.amm?.length || 0) + (pump.clmm?.length || 0),
      };
      
      logger.info('pools.refresh.phase.min_pools_filter.complete', { 
        minPools, 
        before: beforeCounts, 
        after: afterCounts,
        cat: 'pools' 
      });
    }
  } catch (e: any) {
    logger.warn('pools.refresh.phase.min_pools_filter.failed', { error: String(e?.message || e), cat: 'pools' });
  }
  
  // === PHASE 4: ENRICH ALL DEXES IN SEQUENCE ===
  // Note: Pumpswap enrichment already happens in fetchPumpswapGraphQL (RPC reserves)
  // Orca/Raydium/Meteora enrichment happens in their normalizers
  // No additional enrichment phase needed currently
  logger.info('pools.refresh.phase.enrich', { note: 'enrichment_embedded_in_normalizers', cat: 'pools' });
  
  // === PHASE 5: FILTER BY TVL/LIQUIDITY ===
  logger.info('pools.refresh.phase.tvl_filter', { cat: 'pools' });
  try {
    const minAmm = Math.max(0, Number(((CONFIG.system as any)?.minAmmLiqBase) ?? 0));
    const minClmm = Math.max(0, Number(((CONFIG.system as any)?.minClmmLiquidity) ?? 0));
    if (minAmm > 0 || minClmm > 0) {
      const valAmm = (p: any) => {
        const tvl = Number((p as any)?.tvl_usd ?? 0);
        if (Number.isFinite(tvl) && tvl > 0) return tvl;
        const disp = Number((p as any)?.liquidity_display ?? 0);
        if (Number.isFinite(disp) && disp > 0) return disp;
        const base = Number((p as any)?.liquidity_base ?? 0);
        return Number.isFinite(base) && base > 0 ? base : 0;
      };
      const valClmm = (p: any) => {
        const tvl = Number((p as any)?.tvl_usd ?? 0);
        if (Number.isFinite(tvl) && tvl > 0) return tvl;
        const disp = Number((p as any)?.liquidity_display ?? 0);
        if (Number.isFinite(disp) && disp > 0) return disp;
        const liq = Number((p as any)?.liquidity ?? 0);
        if (Number.isFinite(liq) && liq > 0) return liq;
        const raw = Number((p as any)?.pool_liquidity_raw ?? 0);
        return Number.isFinite(raw) && raw > 0 ? raw : 0;
      };
      const filt = (norm: { amm: any[]; clmm: any[] }) => ({
        amm: minAmm > 0 ? (norm.amm || []).filter((p: any) => valAmm(p) >= minAmm) : (norm.amm || []),
        clmm: minClmm > 0 ? (norm.clmm || []).filter((p: any) => valClmm(p) >= minClmm) : (norm.clmm || []),
      });
      
      const beforeCounts = {
        raydium: { a: r.amm?.length || 0, c: r.clmm?.length || 0 },
        orca: { a: o.amm?.length || 0, c: o.clmm?.length || 0 },
        meteora: { a: m.amm?.length || 0, c: m.clmm?.length || 0 },
        meteora_balanced: { a: mb.amm?.length || 0, c: mb.clmm?.length || 0 },
        pumpswap: { a: pump.amm?.length || 0, c: pump.clmm?.length || 0 },
      };
      
      r = filt(r) as any;
      o = filt(o) as any;
      m = filt(m) as any;
      mb = filt(mb) as any;
      pump = filt(pump) as any;
      
      const afterCounts = {
        raydium: { a: r.amm?.length || 0, c: r.clmm?.length || 0 },
        orca: { a: o.amm?.length || 0, c: o.clmm?.length || 0 },
        meteora: { a: m.amm?.length || 0, c: m.clmm?.length || 0 },
        meteora_balanced: { a: mb.amm?.length || 0, c: mb.clmm?.length || 0 },
        pumpswap: { a: pump.amm?.length || 0, c: pump.clmm?.length || 0 },
      };
      
      logger.info('pools.refresh.phase.tvl_filter.complete', { 
        minAmm, 
        minClmm, 
        before: beforeCounts, 
        after: afterCounts,
        cat: 'pools' 
      });
    } else {
      logger.info('pools.refresh.phase.tvl_filter.skipped', { 
        reason: 'thresholds_are_zero',
        minAmm, 
        minClmm,
        cat: 'pools' 
      });
    }
  } catch (e: any) {
    logger.warn('pools.refresh.phase.tvl_filter.failed', { error: String(e?.message || e), cat: 'pools' });
  }
  
  // === PHASE 6: FILTER BY MINIMUM POOLS PER PAIR (second pass after TVL filtering) ===
  logger.info('pools.refresh.phase.min_pools_filter_2nd', { cat: 'pools' });
  try {
    const minPools = Math.max(1, Number(((CONFIG.system as any)?.minPoolsPerPair) || 1));
    if (minPools > 1) {
      const canonicalPairKey = (mintA: string, mintB: string): string => {
        const a = String(mintA || '');
        const b = String(mintB || '');
        return a <= b ? `${a}-${b}` : `${b}-${a}`;
      };
      
      // Count total pools per pair across all DEXes again
      const poolCounts = new Map<string, number>();
      const countPools = (arr: any[]) => {
        for (const p of (arr || [])) {
          const pairKey = canonicalPairKey(p.mint_a, p.mint_b);
          poolCounts.set(pairKey, (poolCounts.get(pairKey) || 0) + 1);
        }
      };
      
      countPools(r.amm);
      countPools(r.clmm);
      countPools(o.amm);
      countPools(o.clmm);
      countPools(m.amm);
      countPools(m.clmm);
      countPools(mb.amm);
      countPools(pump.amm);
      
      // Allow pairs with at least minPools total pools
      const allow = new Set<string>();
      for (const [k, count] of poolCounts.entries()) {
        if (count >= minPools) {
          allow.add(k);
        }
      }
      
      const filt = <T extends { mint_a: string; mint_b: string }>(arr: T[]) => 
        (arr || []).filter(p => allow.has(canonicalPairKey(p.mint_a, p.mint_b)));
      
      const beforeCounts = {
        raydium: (r.amm?.length || 0) + (r.clmm?.length || 0),
        orca: (o.amm?.length || 0) + (o.clmm?.length || 0),
        meteora: (m.amm?.length || 0) + (m.clmm?.length || 0),
        meteora_balanced: (mb.amm?.length || 0) + (mb.clmm?.length || 0),
        pumpswap: (pump.amm?.length || 0) + (pump.clmm?.length || 0),
      };
      
      r = { amm: filt(r.amm), clmm: filt(r.clmm) } as any;
      o = { amm: filt(o.amm), clmm: filt(o.clmm) } as any;
      m = { amm: filt(m.amm), clmm: filt(m.clmm) } as any;
      mb = { amm: filt(mb.amm || []), clmm: filt(mb.clmm || []) } as any;
      pump = { amm: filt(pump.amm || []), clmm: filt(pump.clmm || []) } as any;
      
      const afterCounts = {
        raydium: (r.amm?.length || 0) + (r.clmm?.length || 0),
        orca: (o.amm?.length || 0) + (o.clmm?.length || 0),
        meteora: (m.amm?.length || 0) + (m.clmm?.length || 0),
        meteora_balanced: (mb.amm?.length || 0) + (mb.clmm?.length || 0),
        pumpswap: (pump.amm?.length || 0) + (pump.clmm?.length || 0),
      };
      
      logger.info('pools.refresh.phase.min_pools_filter_2nd.complete', { 
        minPools, 
        before: beforeCounts, 
        after: afterCounts,
        cat: 'pools' 
      });
    } else {
      logger.info('pools.refresh.phase.min_pools_filter_2nd.skipped', { 
        reason: 'minPoolsPerPair_is_1',
        minPools,
        cat: 'pools' 
      });
    }
  } catch (e: any) {
    logger.warn('pools.refresh.phase.min_pools_filter_2nd.failed', { error: String(e?.message || e), cat: 'pools' });
  }
  
  // Update caches with filtered results
  raydiumCache.data = r;
  raydiumCache.ts = Date.now();
  orcaCache.data = o;
  orcaCache.ts = Date.now();
  meteoraCache.data = m;
  meteoraCache.ts = Date.now();
  metbalCache.data = mb;
  metbalCache.ts = Date.now();
  pumpswapCache.data = pump;
  pumpswapCache.ts = Date.now();

  // Post-fetch bootstrap: if pricing coverage is low, hydrate prices for all fetched mints and rebuild graph
  try {
    if (force) {
      const { getAllPrices } = await import('./priceStore.js');
      const mintSet = new Set<string>();
      const addFrom = (pp: PoolsPayload) => {
        try { for (const p of (pp?.amm || [])) { if (p?.mint_a) mintSet.add(String(p.mint_a)); if (p?.mint_b) mintSet.add(String(p.mint_b)); } } catch {}
        try { for (const p of (pp?.clmm || [])) { if (p?.mint_a) mintSet.add(String(p.mint_a)); if (p?.mint_b) mintSet.add(String(p.mint_b)); } } catch {}
      };
      addFrom(r); addFrom(o); addFrom(m); addFrom(mb); addFrom(pump);
      if (mintSet.size > 0) {
        const pricedMap = getAllPrices() || {};
        let pricedCount = 0;
        for (const x of mintSet) { if (typeof (pricedMap as any)[x]?.usdc === 'number') pricedCount++; }
        const coverage = pricedCount / Math.max(1, mintSet.size);
        const minPriced = Math.max(50, Number((CONFIG.system as any)?.minMintPriceBootstrap || 120));
        const minCoverage = Math.max(0.05, Math.min(0.9, Number((CONFIG.system as any)?.minMintPriceCoverage || 0.4)));
        // Removed post-refresh mass bootstrap; only report coverage metrics

        // Secondary pass: price any fetched mints outside the Jupiter token list
        // Removed secondary pass for outside-Jupiter mints
      }
    }
  } catch {}
  
  logger.info('pools.refresh.phase.complete_all_filtering', { 
    finalCounts: {
      raydium: { amm: r.amm?.length || 0, clmm: r.clmm?.length || 0 },
      orca: { amm: o.amm?.length || 0, clmm: o.clmm?.length || 0 },
      meteora: { amm: m.amm?.length || 0, clmm: m.clmm?.length || 0 },
      meteora_balanced: { amm: mb.amm?.length || 0, clmm: mb.clmm?.length || 0 },
      pumpswap: { amm: pump.amm?.length || 0, clmm: pump.clmm?.length || 0 },
    },
    cat: 'pools'
  });
  // Pair diagnostics: log a single SOL-USDC pool per fetcher
  try {
    const SOL = 'So11111111111111111111111111111111111111112';
    const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const compute = (p: any): { forward: number | undefined; reverse: number | undefined } => {
      try {
        const a = String(p?.mint_a || '');
        const b = String(p?.mint_b || '');
        const px = Number(p?.price_a_per_b || 0);
        if (!a || !b) return { forward: undefined, reverse: undefined };
        if (!Number.isFinite(px) || px <= 0) return { forward: undefined, reverse: undefined };
        // forward = USDC per 1 SOL
        if (a === USDC && b === SOL) return { forward: px, reverse: 1 / px };
        if (a === SOL && b === USDC) return { forward: 1 / px, reverse: px };
        return { forward: undefined, reverse: undefined };
      } catch { return { forward: undefined, reverse: undefined }; }
    };
    const pickOne = (pools: PoolsPayload): any => {
      for (const p of (pools?.clmm || [])) {
        const a = String(p?.mint_a || ''), b = String(p?.mint_b || '');
        if ((a === SOL && b === USDC) || (a === USDC && b === SOL)) return p;
      }
      for (const p of (pools?.amm || [])) {
        const a = String(p?.mint_a || ''), b = String(p?.mint_b || '');
        if ((a === SOL && b === USDC) || (a === USDC && b === SOL)) return p;
      }
      return null;
    };
    const rayPick = pickOne(r);
    if (rayPick) {
      const { forward, reverse } = compute(rayPick);
      if (forward && reverse) {
        try { logger.debug('pools.pair_sol_usdc', { source: 'raydium', id: rayPick.id, kind: rayPick.pool_kind || (rayPick.sqrt_price_x64 != null ? 'clmm' : 'amm'), forward_usdc_per_sol: forward, reverse_sol_per_usdc: reverse, cat: 'pools' }); } catch {}
        try { emit('log', { level: 'info', message: `pools:pair_sol_usdc source=raydium id=${rayPick.id} kind=${rayPick.pool_kind || (rayPick.sqrt_price_x64 != null ? 'clmm' : 'amm')} fwd=${forward} rev=${reverse}`, timestamp: new Date().toISOString(), context: { cat: 'pools' } }); } catch {}
      } else {
        try { logger.debug('pools.pair_sol_usdc.skip', { source: 'raydium', reason: 'invalid_price_or_orientation', id: rayPick.id, a: rayPick.mint_a, b: rayPick.mint_b, px: rayPick.price_a_per_b, cat: 'pools' }); } catch {}
        try { emit('log', { level: 'debug', message: `pools:pair_sol_usdc.skip source=raydium reason=invalid_price_or_orientation id=${rayPick.id} a=${rayPick.mint_a} b=${rayPick.mint_b} px=${rayPick.price_a_per_b}`, timestamp: new Date().toISOString(), context: { cat: 'pools' } }); } catch {}
      }
    } else {
      try { logger.debug('pools.pair_sol_usdc.skip', { source: 'raydium', reason: 'no_sol_usdc', cat: 'pools' }); } catch {}
      try { emit('log', { level: 'debug', message: 'pools:pair_sol_usdc.skip source=raydium reason=no_sol_usdc', timestamp: new Date().toISOString(), context: { cat: 'pools' } }); } catch {}
    }
    const orcPick = pickOne(o);
    if (orcPick) {
      const { forward, reverse } = compute(orcPick);
      if (forward && reverse) {
        try { logger.debug('pools.pair_sol_usdc', { source: 'orca', id: orcPick.id, kind: orcPick.pool_kind || (orcPick.sqrt_price_x64 != null ? 'clmm' : 'amm'), forward_usdc_per_sol: forward, reverse_sol_per_usdc: reverse, cat: 'pools' }); } catch {}
        try { emit('log', { level: 'info', message: `pools:pair_sol_usdc source=orca id=${orcPick.id} kind=${orcPick.pool_kind || (orcPick.sqrt_price_x64 != null ? 'clmm' : 'amm')} fwd=${forward} rev=${reverse}`, timestamp: new Date().toISOString(), context: { cat: 'pools' } }); } catch {}
      } else {
        try { logger.debug('pools.pair_sol_usdc.skip', { source: 'orca', reason: 'invalid_price_or_orientation', id: orcPick.id, a: orcPick.mint_a, b: orcPick.mint_b, px: orcPick.price_a_per_b, cat: 'pools' }); } catch {}
        try { emit('log', { level: 'debug', message: `pools:pair_sol_usdc.skip source=orca reason=invalid_price_or_orientation id=${orcPick.id} a=${orcPick.mint_a} b=${orcPick.mint_b} px=${orcPick.price_a_per_b}`, timestamp: new Date().toISOString(), context: { cat: 'pools' } }); } catch {}
      }
    } else {
      try { logger.debug('pools.pair_sol_usdc.skip', { source: 'orca', reason: 'no_sol_usdc', cat: 'pools' }); } catch {}
      try { emit('log', { level: 'debug', message: 'pools:pair_sol_usdc.skip source=orca reason=no_sol_usdc', timestamp: new Date().toISOString(), context: { cat: 'pools' } }); } catch {}
    }
    const metPick = pickOne(m);
    if (metPick) {
      const { forward, reverse } = compute(metPick);
      if (forward && reverse) {
        try { logger.debug('pools.pair_sol_usdc', { source: 'meteora', id: metPick.id, kind: metPick.pool_kind || (metPick.sqrt_price_x64 != null ? 'clmm' : 'amm'), forward_usdc_per_sol: forward, reverse_sol_per_usdc: reverse, cat: 'pools' }); } catch {}
        try { emit('log', { level: 'info', message: `pools:pair_sol_usdc source=meteora id=${metPick.id} kind=${metPick.pool_kind || (metPick.sqrt_price_x64 != null ? 'clmm' : 'amm')} fwd=${forward} rev=${reverse}`, timestamp: new Date().toISOString(), context: { cat: 'pools' } }); } catch {}
      } else {
        try { logger.debug('pools.pair_sol_usdc.skip', { source: 'meteora', reason: 'invalid_price_or_orientation', id: metPick.id, a: metPick.mint_a, b: metPick.mint_b, px: metPick.price_a_per_b, cat: 'pools' }); } catch {}
        try { emit('log', { level: 'debug', message: `pools:pair_sol_usdc.skip source=meteora reason=invalid_price_or_orientation id=${metPick.id} a=${metPick.mint_a} b=${metPick.mint_b} px=${metPick.price_a_per_b}`, timestamp: new Date().toISOString(), context: { cat: 'pools' } }); } catch {}
      }
    } else {
      try { logger.debug('pools.pair_sol_usdc.skip', { source: 'meteora', reason: 'no_sol_usdc', cat: 'pools' }); } catch {}
      try { emit('log', { level: 'debug', message: 'pools:pair_sol_usdc.skip source=meteora reason=no_sol_usdc', timestamp: new Date().toISOString(), context: { cat: 'pools' } }); } catch {}
    }
    const pumpPick = pickOne(pump);
    if (pumpPick) {
      const { forward, reverse } = compute(pumpPick);
      if (forward && reverse) {
        try { logger.debug('pools.pair_sol_usdc', { source: 'pumpswap', id: pumpPick.id, kind: pumpPick.pool_kind || 'amm', forward_usdc_per_sol: forward, reverse_sol_per_usdc: reverse, cat: 'pools' }); } catch {}
        try { emit('log', { level: 'info', message: `pools:pair_sol_usdc source=pumpswap id=${pumpPick.id} kind=${pumpPick.pool_kind || 'amm'} fwd=${forward} rev=${reverse}`, timestamp: new Date().toISOString(), context: { cat: 'pools' } }); } catch {}
      } else {
        try { logger.debug('pools.pair_sol_usdc.skip', { source: 'pumpswap', reason: 'invalid_price_or_orientation', id: pumpPick.id, a: pumpPick.mint_a, b: pumpPick.mint_b, px: pumpPick.price_a_per_b, cat: 'pools' }); } catch {}
        try { emit('log', { level: 'debug', message: `pools:pair_sol_usdc.skip source=pumpswap reason=invalid_price_or_orientation id=${pumpPick.id} a=${pumpPick.mint_a} b=${pumpPick.mint_b} px=${pumpPick.price_a_per_b}`, timestamp: new Date().toISOString(), context: { cat: 'pools' } }); } catch {}
      }
    } else {
      try { logger.debug('pools.pair_sol_usdc.skip', { source: 'pumpswap', reason: 'no_sol_usdc', cat: 'pools' }); } catch {}
      try { emit('log', { level: 'debug', message: 'pools:pair_sol_usdc.skip source=pumpswap reason=no_sol_usdc', timestamp: new Date().toISOString(), context: { cat: 'pools' } }); } catch {}
    }
  } catch (e:any) {
    try { logger.warn('pools.pair_sol_usdc.failed', { error: String(e?.message || e), cat: 'pools' }); } catch {}
    try { emit('log', { level: 'warn', message: `pools:pair_sol_usdc.failed error=${String(e?.message || e)}`, timestamp: new Date().toISOString(), context: { cat: 'pools' } }); } catch {}
  }
  // Resume watchlist price feed based on prior state or watchlist
  try {
    if (force) {
      const reg: any = await import('./feedRegistry.js');
      const wantResume = (refreshAllSources as any).__resumeFeed === true || reg.isPriceFeedEnabled?.() === true;
      delete (refreshAllSources as any).__resumeFeed;
      const fsmod: any = await import('../utils/fs.js');
      const wl = await fsmod.readJson(CONFIG.watchlistPath, [] as any[]);
      const shouldEnable = wantResume || (Array.isArray(wl) && wl.length > 0);
      reg.enablePriceFeed?.(shouldEnable);
      try { emit('log', { level: 'info', message: `pools:bootstrap feed.resume enabled=${shouldEnable}`, timestamp: new Date().toISOString(), context: { cat: 'pools' } }); } catch {}
      try { logger.info(`pools:bootstrap feed.resume enabled=${shouldEnable}`, { cat: 'pools' }); } catch {}
    }
  } catch {}
  
  // === PHASE 7: SUBSCRIBE TO RETAINED POOLS PER DEX IN SEQUENCE ===
  if (options.subscribe) {
    logger.info('pools.refresh.phase.subscribe', { enabled: shouldFetch, cat: 'pools' });
    try {
      // Wait for any existing WebSocket cleanup to complete before starting new subscriptions
      // This prevents race conditions where accountSubscribe is called on a closed socket
      if (wsClosePromise) {
        await wsClosePromise.catch(() => {});
        wsClosePromise = null;
      }
      
      // Sequential subscription: enable WS and start refresh loop
      // The refresh loop internally handles sequential DEX subscription via startPoolWebsocketsOnlyOnce
      enablePoolWebsocketRefreshes();
      
      // Small delay to ensure WS connection is fully established before subscribing
      await new Promise(resolve => setTimeout(resolve, 500));
      
      logger.info('pools.refresh.phase.subscribe.start_loop', { cat: 'pools' });
      startRaydiumRefreshLoop();
      
      logger.info('pools.refresh.phase.subscribe.complete', { cat: 'pools' });
    } catch (e: any) {
      logger.warn('pools.refresh.phase.subscribe.failed', { error: String(e?.message || e), cat: 'pools' });
    }
  }
  // One-shot consolidated graph push after initial forced refresh completes (guarded)
  try {
    (refreshAllSources as any).__didInitialGraphPush = (refreshAllSources as any).__didInitialGraphPush || false;
    if (options.force && !(refreshAllSources as any).__didInitialGraphPush) {
      const gmod: any = await import('./graph.js');
      try { await gmod.rebuildGraphNow(); } catch {}
      // Ensure websocket-based pool refreshes are enabled immediately after first graph build
      try { const pools = await import('./pools.js'); (pools as any).enablePoolWebsocketRefreshes?.(); } catch {}
      (refreshAllSources as any).__didInitialGraphPush = true;
    }
  } catch {}
  
  logger.info('pools.refresh.complete', { 
    fetched: {
      raydium: { amm: r.amm?.length || 0, clmm: r.clmm?.length || 0 },
      orca: { amm: o.amm?.length || 0, clmm: o.clmm?.length || 0 },
      meteora: { clmm: m.clmm?.length || 0 },
      meteora_balanced: { amm: mb.amm?.length || 0 },
      pumpswap: { amm: pump.amm?.length || 0 },
    },
    cat: 'pools' 
  });
  
  return { raydium: r, orca: o, meteora: m, meteora_balanced: mb, pumpswap: pump };
}

export function startRaydiumRefreshLoop(): void {
  // Clear existing timers if any, to allow dynamic TTL updates
  if (rayTimer) { clearInterval(rayTimer); rayTimer = undefined; }
  if (orcaTimer) { clearInterval(orcaTimer); orcaTimer = undefined; }
  if (meteoraTimer) { clearInterval(meteoraTimer); meteoraTimer = undefined; }
  try { if (wsUnsubscribe) { wsUnsubscribe(); wsUnsubscribe = undefined; } } catch {}
  if (healthTimer) { clearInterval(healthTimer); healthTimer = undefined; }
  if (aggTimer) { clearInterval(aggTimer); aggTimer = undefined; }

  // Use unified cadence unless explicitly overridden per source
  const unified = Math.max(1000, Number((CONFIG.system as any)?.poolsRefreshMs || 60_000));
  const rayPeriod = unified;
  const orcaPeriod = unified;
  const meteoraPeriod = unified;

  const wsEnabled = !!(CONFIG.system as any)?.enablePoolWs;
  // Defer any activity until graph is ready
  if (!wsAllowed) { logger.info('pools.init deferred until graph ready'); return; }
  // Auto-start timers/WS when allowed by config and graph readiness

    if (!wsEnabled && !suppressInitialOnce) {
    rayTimer = setInterval(() => {
      try {
        logger.info('pools.refresh timer raydium', { cat: 'pools' });
        emit('log', { level: 'debug', message: 'pools:refresh timer source=raydium', timestamp: new Date().toISOString(), context: { cat: 'pools' } });
      } catch {}
      getRaydiumPoolsNormalized(true).catch(() => {});
    }, rayPeriod);
    orcaTimer = setInterval(() => {
      try {
        logger.info('pools.refresh timer orca', { cat: 'pools' });
        emit('log', { level: 'debug', message: 'pools:refresh timer source=orca', timestamp: new Date().toISOString(), context: { cat: 'pools' } });
      } catch {}
      getOrcaPoolsCached(true).catch(() => {});
    }, orcaPeriod);
    meteoraTimer = setInterval(() => {
      try {
        logger.info('pools.refresh timer meteora', { cat: 'pools' });
        emit('log', { level: 'debug', message: 'pools:refresh timer source=meteora', timestamp: new Date().toISOString(), context: { cat: 'pools' } });
      } catch {}
      getMeteoraPoolsCached(true).catch(() => {});
    }, meteoraPeriod);
  }
    // Proceed to initial fetch and optional WS

  // Kick immediately once activated so data is available without waiting
  // Kick immediately once, but respect min-force gap for subsequent calls
  if (!suppressInitialOnce) {
    // Respect DEX source control configuration
    const configSources = (CONFIG.system as any)?.enabledDexSources || {};
    
    if (configSources.raydium !== false) {
      try { getRaydiumPoolsNormalized(true).catch(() => {}); } catch {}
    }
    if (configSources.orca !== false) {
      try { getOrcaPoolsCached(true).catch(() => {}); } catch {}
    }
    if (configSources.meteora !== false) {
      try { getMeteoraPoolsCached(true).catch(() => {}); } catch {}
    }
  }

  // Optional: subscribe to on-chain account changes to push updates into caches (auto-enabled)
  if (wsEnabled) {
    if (!wsAllowed) {
      logger.info('pools.ws deferred until graph ready');
      return;
    }
    try {
      const setup = async () => {
        if (wsSetupActive) { try { logger.info('pools.ws setup already active'); } catch {} return; }
        wsSetupActive = true;
        let web3: any = null;
        try { const mod = ['@solana/web3.js'].join(''); web3 = await import(mod as any); } catch {}
        if (!web3) { logger.warn('pools.ws disabled: @solana/web3.js not available'); return; }
        // If a previous unsubscribe initiated a websocket close, wait for it to finish before creating a new Connection
        try { if (wsClosePromise) { await wsClosePromise.catch(() => {}); } } catch {}
        wsClosePromise = null;
        const conn = new web3.Connection(CONFIG.rpcUrl, CONFIG.system.txCommitment as any);
        // Record connection so we can actively close its underlying WS on unsubscribe
        wsConn = conn;
        
        // Protect the RPC WebSocket from being called on closed sockets
        // This prevents web3.js's internal _updateSubscriptions from crashing
        try {
          const { protectRpcWebSocket } = await import('../drift/wsHelper.js');
          protectRpcWebSocket(conn, 'pools.setup');
        } catch (err) {
          try { 
            logger.warn('pools.ws failed to protect WebSocket', { 
              error: String(err), 
              cat: 'pools' 
            }); 
          } catch {}
        }
        
        const ensureMeteoraProgram = (): any | null => {
          if (meteoraProgramInstance) return meteoraProgramInstance;
          try {
            const idStr = String(((CONFIG as any)?.meteora?.programId) || METEORA_DEFAULT_PROGRAM_ID).trim();
            const programId = new web3.PublicKey(idStr);
            meteoraProgramInstance = createProgram(conn, { programId });
            try { logger.info('meteora.program.init', { programId: idStr, cat: 'pools' }); } catch {}
          } catch (err: any) {
            meteoraProgramInstance = null;
            try { logger.warn('meteora.program.init failed', { error: String(err?.message || err), cat: 'pools' }); } catch {}
          }
          return meteoraProgramInstance;
        };
        const rayAmm = new web3.PublicKey(String(CONFIG.raydium?.ammV4Program).trim());
        const rayClmm = new web3.PublicKey(String(CONFIG.raydium?.clmmProgram).trim());
        const orcaProg = new web3.PublicKey(String(CONFIG.orca?.programId || 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc').trim());
        const subs: Array<{ kind: 'account' | 'program'; id: number }> = [];
        // Track explicit targets so we can classify events for SPL Token vault accounts (e.g., Raydium AMM vaults)
        const targetedSourceByAccount: Map<string, 'raydium' | 'orca' | 'meteora' | 'pumpswap'> = new Map();
        // Debounce frequent program change bursts to at most one refresh per source per min gap
        const minGap = Number((CONFIG.system as any)?.poolRefreshMinGapMs || 3000);
        let lastRay = 0; let lastOrc = 0;
        let meteoraTargets = new Set<string>();
        try {
          const gmod: any = await import('./graph.js');
          // Use forced snapshot when retargeting (suppressInitialOnce) to ensure fresh data
          const snap = await gmod.getGraphSnapshot(suppressInitialOnce);
          const mset = new Set<string>();
          for (const e of (snap?.edges || [])) {
            const pid = String((e as any)?.pool_id || '');
            if (!pid) continue;
            const base = pid.replace(/-rev$/, '');
            if ((e as any)?.dex === 'Meteora') mset.add(base);
          }
          meteoraTargets = mset;
          if (meteoraTargets.size > 0) {
            try { logger.info('pools.ws targets.meteora from graph', { size: meteoraTargets.size, forced: suppressInitialOnce }); } catch {}
          }
        } catch {}

        const handle = async (pk: any, info: any) => {
          try {
            lastWsEventMs = Date.now();
            wsHealthy = true;
            
            const pk58 = toB58Any(pk);
            
            // Check if this is a derived account (vault, reserve, tick array, oracle)
            const derivedMeta = derivedAccountToPool.get(pk58);
            if (derivedMeta) {
              // Process vault/reserve updates locally without RPC calls
              if (derivedMeta.accountType === 'vault' || derivedMeta.accountType === 'reserve') {
                try {
                  // Parse token account balance
                  const newBalance = parseTokenAccountAmount(info.data);
                  if (newBalance === null) {
                    logger.debug('pools.ws vault.parse.fail', { account: pk58.slice(0,8)+'…', cat: 'pools' });
                    return; // Can't parse, skip
                  }
                  
                  // Find the pool in our caches
                  const poolData = findPoolInCache(derivedMeta.poolId);
                  if (!poolData) {
                    logger.debug('pools.ws vault.pool.not_found', { 
                      vault: pk58.slice(0,8)+'…', 
                      pool: derivedMeta.poolId.slice(0,8)+'…', 
                      cat: 'pools' 
                    });
                    return; // Pool not in cache yet, skip
                  }
                  
                  const { pool, source } = poolData;
                  
                  // For CLMM pools: vault changes don't directly change price
                  // The sqrt_price_x64 field determines price, not vault balances
                  // Vault changes only affect liquidity availability
                  // Just wait for the pool WebSocket update to deliver the actual price change
                  if (pool.pool_kind === 'clmm') {
                    logger.debug('pools.ws vault.clmm.skip', { 
                      vault: pk58.slice(0,8)+'…', 
                      pool: derivedMeta.poolId.slice(0,8)+'…',
                      reason: 'clmm_price_from_sqrtprice_not_vaults',
                      cat: 'pools' 
                    });
                    return; // CLMM: price isn't derived from vaults, skip
                  }
                  
                  // For AMM pools: we could compute price from vault balances
                  // But we'd need to track both vaults A and B, and know which vault is which
                  // For now, rely on pool WebSocket updates
                  // This still eliminates the RPC call - we're subscribed to the pool account too
                  logger.debug('pools.ws vault.amm.skip', { 
                    vault: pk58.slice(0,8)+'…', 
                    pool: derivedMeta.poolId.slice(0,8)+'…',
                    balance: newBalance.toString(),
                    reason: 'amm_awaiting_pool_update',
                    cat: 'pools' 
                  });
                  return;
                  
                } catch (err) {
                  logger.debug('pools.ws vault.process.error', { 
                    vault: pk58.slice(0,8)+'…', 
                    error: String(err), 
                    cat: 'pools' 
                  });
                  return;
                }
              }
              
              // For tick arrays, oracle, observation accounts
              // These also don't directly determine price - the pool account does
              // Skip RPC fetch and let the pool's own WebSocket update handle it
              logger.debug('pools.ws derived.skip', { 
                account: pk58.slice(0,8)+'…', 
                accountType: derivedMeta.accountType,
                parentPool: derivedMeta.poolId.slice(0,8)+'…',
                reason: 'awaiting_pool_update',
                cat: 'pools' 
              });
              return;
            }
            
            // Lightweight classify: owner indicates which decoder to attempt
            const owner = toB58Any((info as any)?.owner);
            const ownerRayAmm = rayAmm.toBase58();
            const ownerRayClmm = rayClmm.toBase58();
            const ownerOrca = orcaProg.toBase58();
            const ownerMeteora = String((CONFIG as any)?.meteora?.programId || '').trim();
            const isMeteoraTarget = meteoraTargets.has(pk58);
            try {
              const shortPk = pk ? `${toB58Any(pk).slice(0,6)}…` : '';
              const mapped = targetedSourceByAccount.get(pk58);
              const src = mapped || ((owner === ownerRayAmm || owner === ownerRayClmm) ? 'raydium' : (owner === ownerOrca ? 'orca' : ((ownerMeteora && owner === ownerMeteora) || isMeteoraTarget ? 'meteora' : 'unknown')));
              // Emit raw event snapshot (truncated) for audit
              const raw = {
                owner,
                lamports: Number(info?.lamports ?? 0),
                dataLen: Number(info?.data?.length ?? 0),
              };
              emit('log', { level: 'debug', message: `pools:ws event source=${src} acct=${shortPk}`, timestamp: new Date().toISOString(), context: { cat: 'pools', raw, source: src } });
            } catch {}
            const now = Date.now();
            // Debug account logging removed - use 'pools.ws aggregate' info logs for monitoring
            const maybeDebugAccount = (_source: 'raydium' | 'orca' | 'meteora') => {
              // No-op: debug account logs removed to respect log levels
            };
            if (owner === ownerRayAmm || owner === ownerRayClmm) {
              try { wsCounts.raydium += 1; } catch {}
              try { wsDecodeStats.raydium.attempts += 1; } catch {}
              const pk58 = toB58Any(pk);
              let updated = false;
              try {
                const rmod: any = await import('@raydium-io/raydium-sdk-v2').catch(() => null);
                if (!rmod || !info?.data) { throw new Error('raydium sdk missing'); }
                  // Try CLMM pool decode first
                  let state: any = null;
                const clmmLayout = (rmod as any)?.Clmm?.PoolStateLayout || (rmod as any)?.CLMM?.POOL_STATE_LAYOUT || (rmod as any)?.PoolStateLayout || (rmod as any)?.PoolInfoLayout;
                  maybeDebugAccount('raydium');
                  if (clmmLayout && typeof clmmLayout.decode === 'function') {
                    let clmmDecodeError: any = null;
                    try { state = clmmLayout.decode(info.data); } catch (err: any) { clmmDecodeError = err; state = null; }
                    if (!state && clmmDecodeError) {
                      try { logger.debug('raydium.ws clmm.decode.fail', { id: pk58, error: String(clmmDecodeError?.message || clmmDecodeError), dataLen: Number(info?.data?.length ?? 0), cat: 'pools' }); } catch {}
                    }
                    if (state) {
                      try {
                        logger.debug('raydium.ws state.inspect', {
                          id: pk58,
                          keys: Object.keys(state || {}),
                          liquidityType: typeof (state as any)?.liquidity,
                          cat: 'pools'
                        });
                      } catch {}
                    }
                    const hasLiquidityField = !!(state && (state as any)?.liquidity != null);
                    const hasMintFields = !!(state && ((state as any)?.mintA || (state as any)?.tokenMintA || (state as any)?.mint_a || (state as any)?.token_mint_a));
                    if (state && (!hasLiquidityField || !hasMintFields)) {
                      try { logger.debug('raydium.ws clmm.skip', { id: pk58, hasLiquidityField, hasMintFields, cat: 'pools' }); } catch {}
                    }
                    if (state && hasLiquidityField && hasMintFields) {
                      const mintA = ((state as any).mintA || (state as any).tokenMintA)?.toBase58?.() || '';
                      const mintB = ((state as any).mintB || (state as any).tokenMintB)?.toBase58?.() || '';
                      const sqrtRaw = anyToBigInt((state as any).sqrtPriceX64 ?? (state as any).sqrt_price_x64 ?? (state as any).sqrtPrice ?? 0);
                      const precision = await (async () => {
                        try {
                          let decA: number | undefined;
                          let decB: number | undefined;
                          try {
                            const tok = await import('../utils/tokens.js');
                            const a = await (tok as any).resolveMint(mintA);
                            const b = await (tok as any).resolveMint(mintB);
                            decA = Number(a?.decimals);
                            decB = Number(b?.decimals);
                          } catch {}
                          if (!Number.isFinite(decA)) decA = undefined;
                          if (!Number.isFinite(decB)) decB = undefined;
                          let ratio = (sqrtRaw && decA != null && decB != null)
                            ? sqrtPriceX64ToPriceRatio(sqrtRaw, decA, decB)
                            : null;
                          let price: number | undefined;
                          if (ratio?.float && Number.isFinite(ratio.float) && ratio.float > 0) {
                            price = ratio.float;
                          }
                          if ((!price || price <= 0) && sqrtRaw && decA != null && decB != null) {
                          try {
                            const SqrtPriceMath = rmod?.SqrtPriceMath || rmod?.Clmm?.SqrtPriceMath;
                            if (SqrtPriceMath?.sqrtPriceX64ToPrice) {
                                const priceFromSdk = SqrtPriceMath.sqrtPriceX64ToPrice(sqrtRaw, decA, decB);
                              if (priceFromSdk != null && Number(priceFromSdk) > 0 && Number.isFinite(Number(priceFromSdk))) {
                                  price = Number(priceFromSdk);
                              }
                            }
                          } catch {}
                          }
                          if ((!price || price <= 0) && sqrtRaw && decA != null && decB != null) {
                            try {
                              const ratioApprox = Number(sqrtRaw) / Math.pow(2, 64);
                              const scale = Math.pow(10, decB - decA);
                              const cand = scale / (ratioApprox * ratioApprox);
                              if (Number.isFinite(cand) && cand > 0) price = cand;
                            } catch {}
                          }
                          return { price, decA, decB, ratio };
                        } catch {
                          return { price: undefined, decA: undefined, decB: undefined, ratio: null };
                        }
                      })();
                      try {
                        logger.debug('raydium.ws clmm.fields', {
                          id: pk58,
                          priceCandidate: precision.price,
                          ratio: precision.ratio ? { num: precision.ratio.numerator.toString(), den: precision.ratio.denominator.toString() } : null,
                          liquidityPresent: (state as any)?.liquidity != null,
                          mintA,
                          mintB,
                          cat: 'pools'
                        });
                      } catch {}
                      const price_a_per_b = precision.price;
                      const liqRaw = anyToBigInt((state as any).liquidity ?? 0);
                      const liq = Number((state as any).liquidity ?? 0);
                      const tick = Number((state as any).tickSpacing ?? (state as any).tick_spacing ?? 0);
                      // Skip adding to CLMM list if tickSpacing is invalid (must be > 0 for valid CLMM pools)
                      if (tick > 0) {
                        const fee = Number((state as any).tradeFeeRate ?? (state as any).feeRate ?? (state as any).fee_rate ?? 0);
                        const item: ClmmPool = {
                          id: pk58,
                          dex: 'Raydium',
                          mint_a: mintA,
                          mint_b: mintB,
                          fee_bps: fee,
                          sqrt_price_x64: Number.isFinite(Number(sqrtRaw)) ? Number(sqrtRaw) : Number((state as any).sqrtPriceX64 ?? (state as any).sqrt_price_x64 ?? (state as any).sqrtPrice ?? 0),
                          sqrt_price_x64_raw: sqrtRaw ? sqrtRaw.toString() : undefined,
                          liquidity: Number.isFinite(liq) ? liq : 0,
                          liquidity_raw: liqRaw ? liqRaw.toString() : undefined,
                          'tick_spacing': tick,
                          updated_ms: Date.now(),
                          pool_kind: 'clmm',
                          liquidity_display: liq,
                          price_a_per_b,
                          price_a_per_b_num: precision.ratio ? precision.ratio.numerator.toString() : undefined,
                          price_a_per_b_den: precision.ratio ? precision.ratio.denominator.toString() : undefined,
                          price_a_per_b_exact: ratioToDecimalString(precision.ratio) ?? undefined,
                          decimals_a: precision.decA,
                          decimals_b: precision.decB,
                        } as any;
                        const prev = raydiumCache.data || { amm: [], clmm: [] };
                        const next: PoolsPayload = { amm: prev.amm.slice(), clmm: prev.clmm.slice() };
                        const idx = next.clmm.findIndex(p => p.id === item.id);
                        if (idx >= 0) next.clmm[idx] = { ...next.clmm[idx], ...item }; else next.clmm.push(item);
                        
                        // OPTIMIZATION: Store raw account data in execution cache for builders
                        try {
                          const { executionCache } = await import('../execution/cache.js');
                          const existing = executionCache.getStatic(pk58) || {} as any;
                          executionCache.setStatic(pk58, {
                            ...existing,
                            rawAccountData: Buffer.from(info.data),
                            rawAccountDataUpdatedMs: Date.now(),
                          });
                        } catch {}
                        
                        try { wsDecodeStats.raydium.successes += 1; } catch {}
                        wsDeltaStats.raydium.decoded += 1;
                        const d = diffNormalizedPools(prev, next);
                        raydiumCache.data = next; raydiumCache.ts = Date.now();
                        const hasDelta = (d.amm.length || d.clmm.length || d.addedAmm || d.removedAmm || d.addedClmm || d.removedClmm);
                        if (hasDelta) { 
                          wsDeltaStats.raydium.applied += 1; 
                        } else { 
                          wsDeltaStats.raydium.skipped += 1;
                          // Diagnose why no delta detected
                          const prevPool = prev.clmm.find(p => p.id === item.id);
                          if (prevPool) {
                            const reasons: string[] = [];
                            if ((prevPool as any).sqrt_price_x64_raw === (item as any).sqrt_price_x64_raw) reasons.push('sqrt_price_unchanged');
                            if ((prevPool as any).liquidity_raw === (item as any).liquidity_raw) reasons.push('liquidity_raw_unchanged');
                            if (Math.abs((prevPool.liquidity || 0) - (item.liquidity || 0)) === 0) reasons.push('liquidity_unchanged');
                            if (Math.abs((prevPool.price_a_per_b || 0) - (item.price_a_per_b || 0)) <= 1e-9) reasons.push('price_unchanged');
                            if ((prevPool as any).price_a_per_b_num === (item as any).price_a_per_b_num && (prevPool as any).price_a_per_b_den === (item as any).price_a_per_b_den) reasons.push('ratio_unchanged');
                            incrementSkipReason('raydium', reasons.length > 0 ? reasons.join('+') : 'no_delta_detected');
                          } else {
                            incrementSkipReason('raydium', 'new_pool');
                          }
                        }
                        try { emit('pool-updates', { source: 'raydium', updatedAmm: d.amm.length, updatedClmm: d.clmm.length, sample: { amm: d.amm.slice(0, 20), clmm: [] }, ts: Date.now() }); } catch {}
                    // Always use incremental graph updates
                    try {
                      const gmod: any = await import('./graph.js');
                      const hasDelta = (d.amm.length || d.clmm.length || d.addedAmm || d.removedAmm || d.addedClmm || d.removedClmm);
                      if (hasDelta) {
                        await scheduleDexApply('raydium', prev as any);
                      }
                    } catch {}
                      } else {
                        try { logger.debug('raydium.ws clmm.skip.invalid_tick', { id: pk58, tick, cat: 'pools' }); } catch {}
                        updated = true; // Mark as processed to avoid further handling
                      }
                      updated = true;
                    }
                  }
                  // Try AMM V4 decode
                  if (!updated) {
                    const ammLayout = (rmod as any)?.LiquidityStateLayoutV4 || (rmod as any)?.LIQUIDITY_STATE_LAYOUT_V4 || null;
                    if (ammLayout && typeof ammLayout.decode === 'function') {
                      try { state = ammLayout.decode(info.data); } catch { state = null; }
                      if (state) {
                        const mintA = (state.baseMint || state.mintA || state.mint_a)?.toBase58?.() || '';
                        const mintB = (state.quoteMint || state.mintB || state.mint_b)?.toBase58?.() || '';
                        // Reserves may be BN; best-effort convert to number
                        const rA = Number((state.baseReserve || state.reserveA || state.vaultA || 0).toString ? (state.baseReserve.toString()) : (state.baseReserve || 0));
                        const rB = Number((state.quoteReserve || state.reserveB || state.vaultB || 0).toString ? (state.quoteReserve.toString()) : (state.quoteReserve || 0));
                        let price_a_per_b: number | undefined;
                        try {
                          let decA: number | undefined; let decB: number | undefined;
                          try {
                            const tok = await import('../utils/tokens.js');
                            const a = await (tok as any).resolveMint(mintA);
                            const b = await (tok as any).resolveMint(mintB);
                            decA = Number(a?.decimals);
                            decB = Number(b?.decimals);
                          } catch {}
                          const wholeA = Number.isFinite(decA as any) ? (rA / Math.pow(10, decA as number)) : rA;
                          const wholeB = Number.isFinite(decB as any) ? (rB / Math.pow(10, decB as number)) : rB;
                          if (wholeA > 0 && wholeB > 0) price_a_per_b = wholeA / wholeB;
                        } catch {}
                        const liqBase = (rA > 0 && rB > 0) ? Math.min(rA, rB) : 0;
                        const item: AmmPool = { id: pk58, dex: 'Raydium', mint_a: mintA, mint_b: mintB, fee_bps: Number((state as any).tradeFeeRate || (state as any).feeRate || 0), price_a_per_b, liquidity_base: liqBase, updated_ms: Date.now(), pool_kind: 'amm', liquidity_display: liqBase } as any;
                        const prev = raydiumCache.data || { amm: [], clmm: [] };
                        const next: PoolsPayload = { amm: prev.amm.slice(), clmm: prev.clmm.slice() };
                        const idx = next.amm.findIndex(p => p.id === item.id);
                        if (idx >= 0) next.amm[idx] = { ...next.amm[idx], ...item }; else next.amm.push(item);
                        
                        // OPTIMIZATION: Store raw account data in execution cache for builders
                        try {
                          const { executionCache } = await import('../execution/cache.js');
                          const existing = executionCache.getStatic(pk58) || {} as any;
                          executionCache.setStatic(pk58, {
                            ...existing,
                            rawAccountData: Buffer.from(info.data),
                            rawAccountDataUpdatedMs: Date.now(),
                          });
                        } catch {}
                        
                        try { wsDecodeStats.raydium.successes += 1; } catch {}
                        wsDeltaStats.raydium.decoded += 1;
                        const d = diffNormalizedPools(prev, next);
                        raydiumCache.data = next; raydiumCache.ts = Date.now();
                        const hasDelta = (d.amm.length || d.clmm.length || d.addedAmm || d.removedAmm || d.addedClmm || d.removedClmm);
                        if (hasDelta) { 
                          wsDeltaStats.raydium.applied += 1; 
                        } else { 
                          wsDeltaStats.raydium.skipped += 1;
                          // Diagnose why no delta detected
                          const prevPool = prev.amm.find(p => p.id === item.id);
                          if (prevPool) {
                            const reasons: string[] = [];
                            if ((prevPool as any).reserve_a_raw === (item as any).reserve_a_raw && (prevPool as any).reserve_b_raw === (item as any).reserve_b_raw) reasons.push('reserves_unchanged');
                            if (Math.abs((prevPool.liquidity_base || 0) - (item.liquidity_base || 0)) === 0) reasons.push('liquidity_unchanged');
                            if (Math.abs((prevPool.price_a_per_b || 0) - (item.price_a_per_b || 0)) <= 1e-9) reasons.push('price_unchanged');
                            incrementSkipReason('raydium', reasons.length > 0 ? reasons.join('+') : 'no_delta_detected');
                          } else {
                            incrementSkipReason('raydium', 'new_pool');
                          }
                        }
                        try { emit('pool-updates', { source: 'raydium', updatedAmm: d.amm.length, updatedClmm: d.clmm.length, sample: { amm: d.amm.slice(0, 20), clmm: [] }, ts: Date.now() }); } catch {}
                        // Always use incremental graph updates
                        try {
                          const gmod: any = await import('./graph.js');
                          if (hasDelta) {
                            await scheduleDexApply('raydium', prev as any);
                          }
                        } catch {}
                        updated = true;
                    }
                  }
                } else if (!(handle as any).__raydiumClmmLayoutMissing) {
                  (handle as any).__raydiumClmmLayoutMissing = true;
                  try {
                    logger.debug('raydium.ws clmm.layout.missing', {
                      id: pk58,
                      keys: Object.keys(rmod || {}),
                      cat: 'pools'
                    });
                  } catch {}
                }
              } catch (e:any) {
                try { wsDecodeStats.raydium.failures += 1; } catch {}
                try { logger.warn('raydium.ws.decode failed', { id: pk58.slice(0,6)+'…', error: String(e?.message || e) }); } catch {}
              }
              // Unparsed events are tracked in aggregate metrics, no need for individual debug logs
              return;
            } else if (owner === ownerOrca) {
              try { wsCounts.orca += 1; } catch {}
              try { wsDecodeStats.orca.attempts += 1; } catch {}
              // Attempt to parse and upsert single Whirlpool from account data; fallback to full refresh on failure
              let ok = false;
              try {
                const pk58 = toB58Any(pk);
                const sdk = await import('@orca-so/whirlpools-sdk').catch(() => null);
                if (!sdk) { throw new Error('orca sdk missing'); }
                const { ParsableWhirlpool } = sdk as any;
                const parsed = ParsableWhirlpool.parse(pk, info);
                if (parsed) {
                  maybeDebugAccount('orca');
                  const id = pk58;
                  const mint_a = parsed.tokenMintA.toBase58();
                  const mint_b = parsed.tokenMintB.toBase58();
                  const sqrtRaw = anyToBigInt(parsed.sqrtPrice);
                  const sqrt_price_x64 = sqrtRaw ? Number(sqrtRaw) : Number(parsed.sqrtPrice);
                  const precision = await (async () => {
                    try {
                      let decA: number | undefined;
                      let decB: number | undefined;
                      try {
                        const tok = await import('../utils/tokens.js');
                        const a = await (tok as any).resolveMint(mint_a);
                        const b = await (tok as any).resolveMint(mint_b);
                        decA = Number(a?.decimals);
                        decB = Number(b?.decimals);
                      } catch {}
                      if (!Number.isFinite(decA)) decA = undefined;
                      if (!Number.isFinite(decB)) decB = undefined;
                      const ratio = (sqrtRaw && decA != null && decB != null)
                        ? sqrtPriceX64ToPriceRatio(sqrtRaw, decA, decB)
                        : null;
                      const price = ratio?.float && Number.isFinite(ratio.float) && ratio.float > 0
                        ? ratio.float
                        : 0;
                      return { price, ratio, decA, decB };
                    } catch {
                      return { price: 0, ratio: null, decA: undefined, decB: undefined };
                    }
                  })();
                  const liquidityRaw = anyToBigInt(parsed.liquidity);
                  const liquidity = Number(parsed.liquidity);
                  const tick_spacing = Number(parsed.tickSpacing);
                  const fee_bps = deriveOrcaFeeBps(parsed as any);
                  const clmmItem: ClmmPool = {
                    id,
                    dex: 'Orca',
                    mint_a,
                    mint_b,
                    fee_bps,
                    sqrt_price_x64,
                    sqrt_price_x64_raw: sqrtRaw ? sqrtRaw.toString() : undefined,
                    liquidity,
                    liquidity_raw: liquidityRaw ? liquidityRaw.toString() : undefined,
                    'tick_spacing': tick_spacing,
                    updated_ms: Date.now(),
                    pool_kind: 'clmm',
                    liquidity_display: liquidity,
                    price_a_per_b: precision.price > 0 ? precision.price : undefined,
                    price_a_per_b_num: precision.ratio ? precision.ratio.numerator.toString() : undefined,
                    price_a_per_b_den: precision.ratio ? precision.ratio.denominator.toString() : undefined,
                    price_a_per_b_exact: ratioToDecimalString(precision.ratio) ?? undefined,
                    decimals_a: precision.decA,
                    decimals_b: precision.decB,
                  } as any;
                  const prev = orcaCache.data || { amm: [], clmm: [] };
                  const next: PoolsPayload = { amm: prev.amm.slice(), clmm: prev.clmm.slice() };
                  const idx = next.clmm.findIndex(p => p.id === id);
                  if (idx >= 0) { next.clmm[idx] = { ...next.clmm[idx], ...clmmItem }; } else { next.clmm.push(clmmItem); }
                  try { wsDecodeStats.orca.successes += 1; } catch {}
                  wsDeltaStats.orca.decoded += 1;
                  orcaCache.data = next; orcaCache.ts = Date.now();
                  const d = diffNormalizedPools(prev, next);
                  const sample = { amm: [], clmm: d.clmm.slice(0, 20) };
                  emit('pool-updates', { source: 'orca', updatedAmm: d.amm.length, updatedClmm: d.clmm.length, addedAmm: d.addedAmm, removedAmm: d.removedAmm, addedClmm: d.addedClmm, removedClmm: d.removedClmm, sample, ts: Date.now() });
                  // Delta stats are tracked in aggregate metrics
                  // Always use incremental graph updates
                  try {
                    const gmod: any = await import('./graph.js');
                    const prevSnap = orcaCache.data ? prev : { amm: [], clmm: [] };
                    const hasDelta = (d.clmm.length || d.amm.length || d.addedClmm || d.removedClmm || d.addedAmm || d.removedAmm);
                    if (hasDelta) { 
                      wsDeltaStats.orca.applied += 1; 
                    } else { 
                      wsDeltaStats.orca.skipped += 1;
                      // Diagnose why no delta detected
                      const prevPool = prev.clmm.find(p => p.id === id);
                      if (prevPool) {
                        const reasons: string[] = [];
                        if ((prevPool as any).sqrt_price_x64_raw === (clmmItem as any).sqrt_price_x64_raw) reasons.push('sqrt_price_unchanged');
                        if ((prevPool as any).liquidity_raw === (clmmItem as any).liquidity_raw) reasons.push('liquidity_raw_unchanged');
                        if (Math.abs((prevPool.liquidity || 0) - (clmmItem.liquidity || 0)) === 0) reasons.push('liquidity_unchanged');
                        if (Math.abs((prevPool.price_a_per_b || 0) - (clmmItem.price_a_per_b || 0)) <= 1e-9) reasons.push('price_unchanged');
                        if ((prevPool as any).price_a_per_b_num === (clmmItem as any).price_a_per_b_num && (prevPool as any).price_a_per_b_den === (clmmItem as any).price_a_per_b_den) reasons.push('ratio_unchanged');
                        incrementSkipReason('orca', reasons.length > 0 ? reasons.join('+') : 'no_delta_detected');
                      } else {
                        incrementSkipReason('orca', 'new_pool');
                      }
                    }
                    if (hasDelta) {
                      await scheduleDexApply('orca', prevSnap as any);
                    }
                  } catch {}
                  ok = true;
                }
              } catch (e:any) {
                try { wsDecodeStats.orca.failures += 1; } catch {}
                try { logger.warn('orca.ws.parse failed', { error: String(e?.message || e) }); } catch {}
              }
              // Do not fallback to HTTP refresh when user subscribed; leave updates to manual refresh
            } else if ((ownerMeteora && owner === ownerMeteora) || isMeteoraTarget) {
              try { wsCounts.meteora = (wsCounts.meteora || 0) + 1; } catch {}
              try { wsDecodeStats.meteora.attempts += 1; } catch {}
              const pk58 = toB58Any(pk);
              const parentPoolId = meteoraBinAccountToPool.get(pk58);
              if (parentPoolId) {
                const tracker = meteoraBinTrackers.get(parentPoolId);
                if (tracker) {
                  const accountMeta = tracker.accounts.get(pk58);
                  if (!info?.data || info.data.length === 0) {
                    if (accountMeta) {
                      tracker.indexes.delete(accountMeta.index);
                    }
                    tracker.accounts.delete(pk58);
                    tracker.binHashes.delete(pk58);
                    meteoraBinAccountToPool.delete(pk58);
                  } else {
                    const dataBuf = Buffer.isBuffer(info.data) ? info.data : Buffer.from(info.data as Uint8Array);
                    tracker.binHashes.set(pk58, hashBuffer(dataBuf));
                  }
                  await applyMeteoraBinHash(parentPoolId);
                }
                return;
              }
              // Try on-chain decode via Meteora DLMM SDK; fallback to HTTP refresh if unavailable
              let updated = false;
              try {
                maybeDebugAccount('meteora');
                const poolId = pk58;
                const program = ensureMeteoraProgram();
                let state: any = null;
                let isBinArray = false;
                if (program && info?.data) {
                  try {
                    state = program.coder.accounts.decode('lbPair', info.data);
                    logger.debug('meteora.ws state.inspect', {
                      id: poolId,
                      gotState: true,
                      keys: Object.keys(state || {}),
                      source: 'program',
                      cat: 'pools'
                    });
                  } catch (err: any) {
                    try { logger.debug('meteora.ws decode.fail', { id: poolId, error: String(err?.message || err), cat: 'pools' }); } catch {}
                    try {
                      const bin = program.coder.accounts.decode('binArray', info.data);
                      if (bin) {
                        isBinArray = true;
                        logger.debug('meteora.ws binarray.inspect', {
                          id: poolId,
                          gotState: true,
                          keys: Object.keys(bin || {}),
                          cat: 'pools'
                        });
                      }
                    } catch {}
                  }
                }
                // Only log warning if it's not a binArray (which is expected to not have lbPair state)
                if (!state && !isBinArray) {
                  logger.warn('meteora.ws state.missing', { id: poolId, cat: 'pools' });
                }
                if (state) {
                  await ensureMeteoraBinSubscriptionsForState(pk, poolId, state);
                  // Fallback: try reading minimal fields via generic accessors
                  let tokenX: string | undefined;
                  let tokenY: string | undefined;
                  let activeId: number | undefined;
                  let binStep: number | undefined;
                  try { tokenX = state?.tokenXMint?.toBase58?.() || state?.mint_x || state?.tokenXMint || state?.tokenA || undefined; } catch {}
                  try { tokenY = state?.tokenYMint?.toBase58?.() || state?.mint_y || state?.tokenYMint || state?.tokenB || undefined; } catch {}
                  try { activeId = Number(state?.activeId ?? state?.active_id); } catch {}
                  try { binStep = Number(state?.binStep ?? state?.bin_step); } catch {}
                  const accountA = toB58Any((state as any)?.reserveX);
                  const accountB = toB58Any((state as any)?.reserveY);
                  let decA: number | undefined;
                  let decB: number | undefined;
                  let price_a_per_b: number | undefined;
                  if (tokenX && tokenY) {
                    try {
                      const tok = await import('../utils/tokens.js');
                      const a = await (tok as any).resolveMint(tokenX);
                      const b = await (tok as any).resolveMint(tokenY);
                      decA = Number(a?.decimals);
                      decB = Number(b?.decimals);
                      if (!Number.isFinite(decA)) decA = undefined;
                      if (!Number.isFinite(decB)) decB = undefined;
                    } catch {}
                    if (Number.isFinite(activeId as any) && Number.isFinite(binStep as any) && decA != null && decB != null) {
                      try {
                        const f = Math.pow(1.0001, Number(binStep));
                        if (f > 0) {
                          const bPerA = Math.pow(f, Number(activeId)) * Math.pow(10, (decA as number) - (decB as number));
                          const candidates = [
                            bPerA > 0 ? (1 / bPerA) : 0,
                            bPerA,
                          ].filter(v => Number.isFinite(v) && v > 0);
                          if (candidates.length) price_a_per_b = candidates[0];
                        }
                      } catch {}
                    }
                  }
                  if (tokenX && tokenY) {
                    const tickSpacing = Number.isFinite(binStep as any) ? Number(binStep) : 0;
                    const liquidityRaw = anyToBigInt((state as any)?.liquidity ?? 0);
                    const liquidity = liquidityRaw ? Number(liquidityRaw) : Number((state as any)?.liquidity ?? 0);
                    const sqrtPriceRaw = anyToBigInt((state as any)?.sqrtPriceX64 ?? (state as any)?.sqrt_price_x64 ?? 0);
                    const feeBps = Number((state as any)?.tradeFeeRate ?? (state as any)?.feeRate ?? (state as any)?.fee_rate ?? (state as any)?.fees ?? 0);
                    const item: ClmmPool = {
                      id: poolId,
                      dex: 'Meteora',
                      mint_a: tokenX,
                      mint_b: tokenY,
                      fee_bps: Number.isFinite(feeBps) ? feeBps : 0,
                      sqrt_price_x64: sqrtPriceRaw ? Number(sqrtPriceRaw) : Number((state as any)?.sqrtPriceX64 ?? (state as any)?.sqrt_price_x64 ?? 0),
                      sqrt_price_x64_raw: sqrtPriceRaw ? sqrtPriceRaw.toString() : undefined,
                      liquidity: Number.isFinite(liquidity) ? liquidity : 0,
                      liquidity_raw: liquidityRaw ? liquidityRaw.toString() : undefined,
                      'tick_spacing': tickSpacing,
                      updated_ms: Date.now(),
                      pool_kind: 'clmm',
                      price_a_per_b: price_a_per_b && price_a_per_b > 0 ? price_a_per_b : undefined,
                      decimals_a: Number.isFinite(decA as any) ? Number(decA) : undefined,
                      decimals_b: Number.isFinite(decB as any) ? Number(decB) : undefined,
                      account_a: accountA,
                      account_b: accountB,
                      price_a_per_b_exact: price_a_per_b && price_a_per_b > 0 ? price_a_per_b.toString() : undefined,
                    } as any;
                    const tracker = meteoraBinTrackers.get(poolId);
                    if (tracker?.aggregate) (item as any).meteora_bin_hash = tracker.aggregate;
                    if (Number.isFinite(activeId as any)) (item as any).active_id = Number(activeId);
                    if (tickSpacing) (item as any).bin_step = tickSpacing;
                    const [canonicalItem] = canonicalizePairs([{ ...item }]);
                    const finalItem = canonicalItem || item;
                    const prev = meteoraCache.data || { amm: [], clmm: [] };
                    const next: PoolsPayload = { amm: prev.amm.slice(), clmm: prev.clmm.slice() };
                    const idx = next.clmm.findIndex(p => p.id === finalItem.id);
                    if (idx >= 0) next.clmm[idx] = { ...next.clmm[idx], ...finalItem }; else next.clmm.push(finalItem);
                    try { wsDecodeStats.meteora.successes += 1; } catch {}
                    wsDeltaStats.meteora.decoded += 1;
                    const d = diffNormalizedPools(prev, next);
                    meteoraCache.data = next; meteoraCache.ts = Date.now();
                    const hasDelta = (d.amm.length || d.clmm.length || d.addedAmm || d.removedAmm || d.addedClmm || d.removedClmm);
                    if (hasDelta) { 
                      wsDeltaStats.meteora.applied += 1; 
                    } else { 
                      wsDeltaStats.meteora.skipped += 1;
                      // Diagnose why no delta detected
                      const prevPool = prev.clmm.find(p => p.id === finalItem.id);
                      if (prevPool) {
                        const reasons: string[] = [];
                        if ((prevPool as any).sqrt_price_x64_raw === (finalItem as any).sqrt_price_x64_raw) reasons.push('sqrt_price_unchanged');
                        if ((prevPool as any).liquidity_raw === (finalItem as any).liquidity_raw) reasons.push('liquidity_raw_unchanged');
                        if (Math.abs((prevPool.liquidity || 0) - (finalItem.liquidity || 0)) === 0) reasons.push('liquidity_unchanged');
                        if (Math.abs((prevPool.price_a_per_b || 0) - (finalItem.price_a_per_b || 0)) <= 1e-9) reasons.push('price_unchanged');
                        if ((prevPool as any).meteora_bin_hash === (finalItem as any).meteora_bin_hash) reasons.push('bin_hash_unchanged');
                        incrementSkipReason('meteora', reasons.length > 0 ? reasons.join('+') : 'no_delta_detected');
                      } else {
                        incrementSkipReason('meteora', 'prev_pool_missing');
                      }
                    }
                    try {
                      const sample = { amm: [], clmm: d.clmm.slice(0, 20) };
                      emit('pool-updates', { source: 'meteora', updatedAmm: d.amm.length, updatedClmm: d.clmm.length, addedAmm: d.addedAmm, removedAmm: d.removedAmm, addedClmm: d.addedClmm, removedClmm: d.removedClmm, sample, ts: Date.now(), canon: (CONFIG.system as any)?.canonicalizePairs || 'none' });
                    } catch {}
                    try {
                      const gmod: any = await import('./graph.js');
                      if (hasDelta) {
                        await scheduleDexApply('meteora', prev as any);
                      }
                    } catch {}
                    try { logger.debug('meteora.ws clmm.fields', { id: poolId, priceCandidate: price_a_per_b, binStep: tickSpacing, activeId, decimals: { a: decA, b: decB }, cat: 'pools' }); } catch {}
                    updated = true;
                  } else {
                    wsDeltaStats.meteora.skipped += 1;
                    const tokenReason = `missing_tokens_${!tokenX ? 'x' : ''}${!tokenY ? 'y' : ''}`;
                    incrementSkipReason('meteora', tokenReason);
                    try { logger.debug('meteora.ws state.skip', { id: poolId, hasTokenX: !!tokenX, hasTokenY: !!tokenY, activeId, binStep, cat: 'pools' }); } catch {}
                  }
                }
              } catch {}
              if (!updated) {
                // Fallback: debounced HTTP refresh
                const minGap = Number((CONFIG.system as any)?.poolRefreshMinGapMs || 3000);
                const last = (getMeteoraPoolsCached as any).__lastForceAt || 0;
                const nowMs = Date.now();
                if (nowMs - last >= minGap) {
                  (getMeteoraPoolsCached as any).__lastForceAt = nowMs;
                  getMeteoraPoolsCached(true).catch(() => {});
                }
              }
              return;
            } else if (pk) {
              // Fallback: if account belongs to any known program, refresh both
              // Disabled while subscribed
            }
          } catch {}
        };
        // Helper: subscribe with retry/backoff to avoid calling while WS is closing
        const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
        
        // Use shared WebSocket utilities
        const { getWebSocketReadyState, waitUntilWsReady: waitUntilWsReadyShared } = await import('../drift/wsHelper.js');
        const getRpcWebSocketReadyState = () => getWebSocketReadyState(conn);
        
        const subscribeAccountWithRetry = async (accountPk: any, cb: (pk: any, info: any) => void): Promise<number> => {
          const maxAttempts = Math.max(1, Number(((CONFIG.system as any)?.wsSubscribeMaxAttempts) || 10));
          const baseBackoffMs = Math.max(50, Number(((CONFIG.system as any)?.wsSubscribeBackoffMs) || 250));
          let attempt = 0;
          
          // Import RPC limiter for tracking
          const { withRpcLimit } = await import('../utils/rpcLimiter.js');
          
          // Attempt loop
          for (;;) {
            await waitUntilWsReadyShared(conn, 'pools.subscribeAccount');
            try {
              // Wrap subscription call with RPC tracking and rate limiting
              const id = await withRpcLimit(
                () => conn.onAccountChange(accountPk, (info: any) => { try { cb(accountPk, info); } catch {} }),
                1,
                { module: 'pools', method: 'accountSubscribe' }
              );
              
              return id as unknown as number;
            } catch (e: any) {
              const msg = String(e?.message || e);
              const isWsState = msg.includes('socket was not') || msg.includes('readyState') || msg.includes('not ready');
              attempt += 1;
              if (!isWsState || attempt >= maxAttempts) {
                // Give up on non-WS errors or after exhausting retries
                throw e;
              }
              const delay = Math.min(5000, Math.floor(baseBackoffMs * Math.pow(1.5, attempt - 1)));
              // Retry attempts are expected behavior, no need to log each one
              await sleep(delay);
            }
          }
        };
        const subscribeProgramWithRetry = async (programPk: any, cb: (ch: any) => void): Promise<number> => {
          const maxAttempts = Math.max(1, Number(((CONFIG.system as any)?.wsSubscribeMaxAttempts) || 10));
          const baseBackoffMs = Math.max(50, Number(((CONFIG.system as any)?.wsSubscribeBackoffMs) || 250));
          let attempt = 0;
          
          // Import RPC limiter for tracking
          const { withRpcLimit } = await import('../utils/rpcLimiter.js');
          
          for (;;) {
            await waitUntilWsReadyShared(conn, 'pools.subscribeProgram');
            try {
              // Wrap subscription call with RPC tracking
              const id = await withRpcLimit(
                () => conn.onProgramAccountChange(programPk, (ch: any) => { try { cb(ch); } catch {} }),
                1,
                { module: 'pools', method: 'programSubscribe' }
              );
              
              return id as unknown as number;
            } catch (e: any) {
              const msg = String(e?.message || e);
              const isWsState = msg.includes('socket was not') || msg.includes('readyState') || msg.includes('not ready');
              attempt += 1;
              if (!isWsState || attempt >= maxAttempts) {
                throw e;
              }
              const delay = Math.min(5000, Math.floor(baseBackoffMs * Math.pow(1.5, attempt - 1)));
              // Retry attempts are expected behavior, no need to log each one
              await sleep(delay);
            }
          }
        };
        // Debounced per-DEX apply: coalesce multiple WS updates into a single apply+push
        const wsApply: Record<'raydium'|'orca'|'meteora', { timer: NodeJS.Timeout | null; baseline: any | null }> = {
          raydium: { timer: null, baseline: null },
          orca: { timer: null, baseline: null },
          meteora: { timer: null, baseline: null },
        };
        const WS_APPLY_DEBOUNCE_MS = Math.max(10, Number(((CONFIG.system as any)?.wsApplyDebounceMs) || 100));
        const getCurrentCache = (dex: 'raydium'|'orca'|'meteora'): any => {
          if (dex === 'raydium') return raydiumCache.data || { amm: [], clmm: [] };
          if (dex === 'orca') return orcaCache.data || { amm: [], clmm: [] };
          return meteoraCache.data || { amm: [], clmm: [] };
        };
        async function scheduleDexApply(dex: 'raydium'|'orca'|'meteora', baseline: any): Promise<void> {
          try {
            if (!wsApply[dex].baseline) wsApply[dex].baseline = baseline;
            // Reset timer on new updates - clear existing timer if present
            if (wsApply[dex].timer) {
              clearTimeout(wsApply[dex].timer);
              wsApply[dex].timer = null;
            }
            wsApply[dex].timer = setTimeout(async () => {
              const base = wsApply[dex].baseline; wsApply[dex].baseline = null; wsApply[dex].timer = null;
              if (!base) return;
              try {
                const gmod: any = await import('./graph.js');
                const cur = getCurrentCache(dex);
                if (typeof gmod.applyPoolUpdates === 'function') {
                  await gmod.applyPoolUpdates(base, cur, { pushToArb: true });
                }
              } catch {}
            }, WS_APPLY_DEBOUNCE_MS);
          } catch {}
        }
        const bnFrom = (value: any): BN => {
          if (BN.isBN && BN.isBN(value)) return value as BN;
          if (value instanceof BN) return value;
          if (typeof value === 'bigint') return new BN(value.toString());
          if (typeof value === 'number') return new BN(value);
          if (typeof value === 'string') {
            try { return new BN(value, 10); } catch { return new BN(0); }
          }
          if (value && typeof value === 'object') {
            try {
              if (typeof value.toArrayLike === 'function') return new BN(value.toArrayLike(Buffer, 'le', 32));
              if (Array.isArray(value)) return bnFrom(value[0]);
            } catch {}
          }
          return new BN(0);
        };

        const computeMeteoraBinIndexes = (state: any): number[] => {
          const words: BN[] = Array.isArray(state?.binArrayBitmap)
            ? state.binArrayBitmap.map((w: any) => bnFrom(w))
            : [];
          if (!words.length) return [];
          const indexes: number[] = [];
          const totalBits = METEORA_BIN_BITMAP_SIZE * 2; // default coverage (-512 .. 511)
          const offset = METEORA_BIN_BITMAP_SIZE;
          for (let bit = 0; bit < totalBits; bit++) {
            const wordIndex = Math.floor(bit / 64);
            const bitIndex = bit % 64;
            const word = words[wordIndex];
            if (!word || typeof word.testn !== 'function') continue;
            if (word.testn(bitIndex)) {
              const index = bit - offset;
              indexes.push(index);
            }
          }
          return Array.from(new Set(indexes));
        };

        const deriveMeteoraBinArrayAddress = (pairPk: any, index: number, programId: any): any => {
          const idx = new BN(index);
          const seed = idx.isNeg()
            ? idx.toTwos(64).toArrayLike(Buffer, 'le', 8)
            : idx.toArrayLike(Buffer, 'le', 8);
          return (web3.PublicKey as any).findProgramAddressSync([
            Buffer.from('bin_array'),
            pairPk.toBuffer(),
            Buffer.from(seed),
          ], programId)[0];
        };

        const getMeteoraTracker = (poolId: string): MeteoraBinTracker => {
          let tracker = meteoraBinTrackers.get(poolId);
          if (!tracker) {
            tracker = { indexes: new Set(), accounts: new Map(), binHashes: new Map(), aggregate: undefined };
            meteoraBinTrackers.set(poolId, tracker);
          }
          return tracker;
        };

        const hashBuffer = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

        const applyMeteoraBinHash = async (poolId: string): Promise<void> => {
          const tracker = meteoraBinTrackers.get(poolId);
          if (!tracker) return;
          wsDeltaStats.meteora.decoded += 1;
          const aggregate = (() => {
            if (tracker.binHashes.size === 0) return undefined;
            const digest = createHash('sha256');
            const sorted = Array.from(tracker.binHashes.entries()).sort(([a], [b]) => a.localeCompare(b));
            for (const [addr, hash] of sorted) {
              digest.update(addr);
              digest.update(':');
              digest.update(hash);
              digest.update('|');
            }
            return digest.digest('hex');
          })();
          if (aggregate === tracker.aggregate) {
            wsDeltaStats.meteora.skipped += 1;
            incrementSkipReason('meteora', 'bin_hash_aggregate_unchanged');
            return;
          }
          tracker.aggregate = aggregate;
          const prev = meteoraCache.data || { amm: [], clmm: [] };
          const next: PoolsPayload = { amm: prev.amm.slice(), clmm: prev.clmm.slice() };
          const idx = next.clmm.findIndex(p => p.id === poolId);
          if (idx === -1) {
            // Pool snapshot not yet cached; bin state will be included on next pair update
            wsDeltaStats.meteora.skipped += 1;
            incrementSkipReason('meteora', 'bin_update_pool_not_cached');
            return;
          }
          const updated: any = { ...next.clmm[idx] };
          if (aggregate) updated.meteora_bin_hash = aggregate; else delete updated.meteora_bin_hash;
          next.clmm[idx] = updated;
          const d = diffNormalizedPools(prev, next);
          meteoraCache.data = next; meteoraCache.ts = Date.now();
          const hasDelta = (d.amm.length || d.clmm.length || d.addedAmm || d.removedAmm || d.addedClmm || d.removedClmm);
          if (hasDelta) {
            wsDeltaStats.meteora.applied += 1;
          } else {
            wsDeltaStats.meteora.skipped += 1;
            incrementSkipReason('meteora', 'bin_update_no_delta');
          }
          try {
            const sample = { amm: [], clmm: d.clmm.slice(0, 20) };
            emit('pool-updates', { source: 'meteora', updatedAmm: d.amm.length, updatedClmm: d.clmm.length, addedAmm: d.addedAmm, removedAmm: d.removedAmm, addedClmm: d.addedClmm, removedClmm: d.removedClmm, sample, ts: Date.now(), canon: (CONFIG.system as any)?.canonicalizePairs || 'none' });
          } catch {}
          try {
            const gmod: any = await import('./graph.js');
            if (hasDelta) {
              await scheduleDexApply('meteora', prev as any);
            }
          } catch {}
        };

        const ensureMeteoraBinSubscriptionsForState = async (pairPk: any, poolId: string, state: any): Promise<void> => {
          try {
            const program = ensureMeteoraProgram();
            if (!program) return;
            const programId = program.programId;
            const indexes = computeMeteoraBinIndexes(state);
            if (indexes.length === 0) return;
            const tracker = getMeteoraTracker(poolId);
            const newIndexes = indexes.filter((idx) => !tracker.indexes.has(idx));
            for (const index of newIndexes) {
              try {
                const binPk = deriveMeteoraBinArrayAddress(pairPk, index, programId);
                const id = await subscribeAccountWithRetry(binPk, handle);
                subs.push({ kind: 'account', id });
                const acct = binPk.toBase58();
                meteoraBinAccountToPool.set(acct, poolId);
                tracker.accounts.set(acct, { id, index });
                tracker.indexes.add(index);
                targetedSourceByAccount.set(acct, 'meteora');
                debugLogTargeted('meteora', acct, { kind: 'bin_array', index });
                // Don't fetch initial bin data via RPC - wait for WebSocket update
                // The first WebSocket update will populate the hash
                // This eliminates RPC calls during pool updates when price moves to new bins
                try {
                  logger.debug('meteora.bin.subscribed', { 
                    pool: poolId, 
                    index, 
                    binAccount: acct.slice(0,8)+'…', 
                    reason: 'awaiting_first_ws_update',
                    cat: 'pools' 
                  });
                } catch {}
              } catch (err) {
                try { logger.info('meteora.ws bin.subscribe.fail', { pool: poolId, index, error: String((err as any)?.message || err) }); } catch {}
              }
            }
            // Ensure aggregate reflects any freshly fetched hashes
            if (tracker.binHashes.size > 0) {
              await applyMeteoraBinHash(poolId);
            }
          } catch (err) {
            try { logger.debug('meteora.ws bin.ensure.failed', { pool: poolId, error: String((err as any)?.message || err) }); } catch {}
          }
        };

        // Helper: attach Raydium AMM vault (token) accounts for a given AMM pool address
        const attachRaydiumAmmVaults = async (poolAddr: string) => {
          try {
            logger.info('raydium.amm.attach.start', { pool: poolAddr.slice(0,8)+'…', cat: 'pools' });
            const pk = new web3.PublicKey(poolAddr);
            const { withRpcRetry } = await import('../utils/rpcLimiter.js');
            
            // Use withRpcRetry which handles rate limiting, timeout, and retries
            const acc: any = await withRpcRetry(
              () => conn.getAccountInfo(pk, CONFIG.system.txCommitment as any),
              { 
                timeoutMs: 5000,  // 5 second timeout per attempt
                retries: 2,        // 2 retries
                weight: 1,
                module: 'pools',
                method: 'getAccountInfo',
                label: 'raydium.amm.getAccountInfo'
              }
            ).catch((err) => {
              logger.info('raydium.amm.attach.rpc_fail', { pool: poolAddr.slice(0,8)+'…', error: String(err), cat: 'pools' });
              return null;
            });
            
            if (!acc || !acc.data) return;
            
            const rmod: any = await import('@raydium-io/raydium-sdk-v2').catch(() => null);
            const ammLayout = rmod?.LiquidityStateLayoutV4 || rmod?.LIQUIDITY_STATE_LAYOUT_V4;
            if (!ammLayout || typeof ammLayout.decode !== 'function') return;
            
            let state: any = null;
            try { state = ammLayout.decode((acc as any).data); } catch { state = null; }
            
            const vA = state?.baseVault?.toBase58?.() || state?.vaultA?.toBase58?.();
            const vB = state?.quoteVault?.toBase58?.() || state?.vaultB?.toBase58?.();
            const vaults = Array.from(new Set([vA, vB].filter(Boolean)));
            
            for (const v of vaults) {
              try {
                const vpk = new web3.PublicKey(v as string);
                const id = await subscribeAccountWithRetry(vpk, handle);
                subs.push({ kind: 'account', id });
                targetedSourceByAccount.set(String(v), 'raydium');
                    debugLogTargeted('raydium', String(v), { kind: 'vault' });
                derivedAccountToPool.set(String(v), { poolId: poolAddr, accountType: 'vault' });
              } catch {}
            }
            
            logger.info('raydium.amm.attach.complete', { pool: poolAddr.slice(0,8)+'…', cat: 'pools' });
          } catch (err) {
            logger.info('raydium.amm.attach.error', { pool: poolAddr.slice(0,8)+'…', error: String(err), cat: 'pools' });
          }
        };

        // Helper: attach Raydium CLMM vault, observation, and tick array accounts for a given CLMM pool address
        const attachRaydiumClmmAccounts = async (poolAddr: string) => {
          try {
            logger.info('raydium.clmm.attach.start', { pool: poolAddr.slice(0,8)+'…', cat: 'pools' });
            const pk = new web3.PublicKey(poolAddr);
            const { withRpcRetry } = await import('../utils/rpcLimiter.js');
            
            // Use withRpcRetry which handles rate limiting, timeout, and retries
            const acc: any = await withRpcRetry(
              () => conn.getAccountInfo(pk, CONFIG.system.txCommitment as any),
              { 
                timeoutMs: 5000,  // 5 second timeout per attempt
                retries: 2,        // 2 retries
                weight: 1,
                module: 'pools',
                method: 'getAccountInfo',
                label: 'raydium.clmm.getAccountInfo'
              }
            ).catch((err) => {
              logger.info('raydium.clmm.attach.rpc_fail', { pool: poolAddr.slice(0,8)+'…', error: String(err), cat: 'pools' });
              return null;
            });
            
            if (!acc || !acc.data) return;
            
            const rmod: any = await import('@raydium-io/raydium-sdk-v2').catch(() => null);
            const clmmLayout = rmod?.PoolInfoLayout || rmod?.AmmV3PoolPersonalPosition || rmod?.PoolState;
            if (!clmmLayout || typeof clmmLayout.decode !== 'function') return;
            
            let state: any = null;
            try { state = clmmLayout.decode((acc as any).data); } catch { return; }
            
            // Subscribe to vaults
            const vA = state?.vaultA?.toBase58?.() || state?.tokenVault0?.toBase58?.();
            const vB = state?.vaultB?.toBase58?.() || state?.tokenVault1?.toBase58?.();
            const vaults = Array.from(new Set([vA, vB].filter(Boolean)));
            for (const v of vaults) {
              try {
                const vpk = new web3.PublicKey(v as string);
                const id = await subscribeAccountWithRetry(vpk, handle);
                subs.push({ kind: 'account', id });
                targetedSourceByAccount.set(String(v), 'raydium');
                debugLogTargeted('raydium', String(v), { kind: 'clmm_vault' });
                derivedAccountToPool.set(String(v), { poolId: poolAddr, accountType: 'vault' });
          } catch {}
            }
            
            // Subscribe to observationId
            const obsId = state?.observationId?.toBase58?.() || state?.observationKey?.toBase58?.();
            if (obsId) {
              try {
                const obsPk = new web3.PublicKey(obsId);
                const id = await subscribeAccountWithRetry(obsPk, handle);
                subs.push({ kind: 'account', id });
                targetedSourceByAccount.set(String(obsId), 'raydium');
                debugLogTargeted('raydium', String(obsId), { kind: 'observation' });
                derivedAccountToPool.set(String(obsId), { poolId: poolAddr, accountType: 'observation' });
              } catch {}
            }
            
            // Subscribe to oracle
            const oracle = state?.oracle?.toBase58?.();
            if (oracle) {
              try {
                const oraclePk = new web3.PublicKey(oracle);
                const id = await subscribeAccountWithRetry(oraclePk, handle);
                subs.push({ kind: 'account', id });
                targetedSourceByAccount.set(String(oracle), 'raydium');
                debugLogTargeted('raydium', String(oracle), { kind: 'oracle' });
                derivedAccountToPool.set(String(oracle), { poolId: poolAddr, accountType: 'oracle' });
              } catch {}
            }
            
            // Subscribe to active tick arrays
            const currentTick = state?.tickCurrent ?? state?.tick_current;
            const tickSpacing = state?.tickSpacing ?? state?.tick_spacing;
            if (currentTick !== undefined && tickSpacing) {
              try {
                const clmmProgramId = new web3.PublicKey(String((CONFIG as any)?.raydium?.clmmProgram || 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK'));
                
                for (let offset = -1; offset <= 1; offset++) {
                  try {
                    const startTickIndex = Math.floor(currentTick / (tickSpacing * 60)) + offset;
                    const actualStartTick = startTickIndex * tickSpacing * 60;
                    const startIndexBuffer = Buffer.alloc(4);
                    startIndexBuffer.writeInt32LE(actualStartTick, 0);
                    const [tickArrayPda] = web3.PublicKey.findProgramAddressSync(
                      [Buffer.from('tick_array'), pk.toBuffer(), startIndexBuffer],
                      clmmProgramId
                    );
                    
                    const id = await subscribeAccountWithRetry(tickArrayPda, handle);
                    subs.push({ kind: 'account', id });
                    targetedSourceByAccount.set(tickArrayPda.toBase58(), 'raydium');
                    debugLogTargeted('raydium', tickArrayPda.toBase58(), { kind: 'tick_array', offset });
                    derivedAccountToPool.set(tickArrayPda.toBase58(), { poolId: poolAddr, accountType: 'tick_array' });
                  } catch (err) {
                    logger.info('raydium.clmm.tickarray.subscribe.fail', { pool: poolAddr, offset, error: String((err as any)?.message || err) });
                  }
                }
              } catch (err) {
                logger.info('raydium.clmm.tickarray.derive.fail', { pool: poolAddr, error: String((err as any)?.message || err) });
              }
            }
            
            logger.info('raydium.clmm.attach.complete', { pool: poolAddr.slice(0,8)+'…', cat: 'pools' });
          } catch (err) {
            logger.info('raydium.clmm.attach.error', { pool: poolAddr.slice(0,8)+'…', error: String(err), cat: 'pools' });
          }
        };

        // Helper: attach Orca Whirlpool vault, oracle, and tick array accounts for a given pool address
        const attachOrcaWhirlpoolAccounts = async (poolAddr: string) => {
          try {
            logger.info('orca.attach.start', { pool: poolAddr.slice(0,8)+'…', cat: 'pools' });
            const pk = new web3.PublicKey(poolAddr);
            const { withRpcRetry } = await import('../utils/rpcLimiter.js');
            
            // Use withRpcRetry which handles rate limiting, timeout, and retries
            const acc: any = await withRpcRetry(
              () => conn.getAccountInfo(pk, CONFIG.system.txCommitment as any),
              { 
                timeoutMs: 5000,  // 5 second timeout per attempt
                retries: 2,        // 2 retries
                weight: 1,
                module: 'pools',
                method: 'getAccountInfo',
                label: 'orca.getAccountInfo'
              }
            ).catch((err) => {
              logger.info('orca.attach.rpc_fail', { pool: poolAddr.slice(0,8)+'…', error: String(err), cat: 'pools' });
              return null;
            });
            
            if (!acc || !acc.data) {
              logger.info('orca.attach.no_data', { pool: poolAddr.slice(0,8)+'…', cat: 'pools' });
              return;
            }
            
            const sdkAny: any = await import('@orca-so/whirlpools-sdk').catch(() => null);
            const ParsableWhirlpool = sdkAny?.ParsableWhirlpool;
            const PDAUtil = sdkAny?.PDAUtil;
            
            if (!ParsableWhirlpool || typeof ParsableWhirlpool.parse !== 'function') {
              logger.info('orca.attach.no_sdk', { pool: poolAddr.slice(0,8)+'…', cat: 'pools' });
              return;
            }
            
            let whirlpoolData: any = null;
            try { 
              whirlpoolData = ParsableWhirlpool.parse(pk, acc);
              logger.info('orca.attach.parsed', { 
                pool: poolAddr.slice(0,8)+'…', 
                dataKeys: Object.keys(whirlpoolData || {}),
                hasTokenVaultA: !!whirlpoolData?.tokenVaultA,
                hasTokenVaultB: !!whirlpoolData?.tokenVaultB,
                hasOracle: !!whirlpoolData?.oracle,
                hasTickSpacing: whirlpoolData?.tickSpacing !== undefined,
                hasTickCurrentIndex: whirlpoolData?.tickCurrentIndex !== undefined,
                cat: 'pools' 
              });
            } catch (err) { 
              logger.info('orca.attach.parse_fail', { pool: poolAddr.slice(0,8)+'…', error: String(err), cat: 'pools' });
              return;
            }
            
            // Subscribe to vaults
            const vaultA = whirlpoolData?.tokenVaultA;
            const vaultB = whirlpoolData?.tokenVaultB;
            const vaults = [vaultA, vaultB].filter(Boolean);
            logger.info('orca.vaults.attempting', { pool: poolAddr.slice(0,8)+'…', count: vaults.length, hasA: !!vaultA, hasB: !!vaultB, cat: 'pools' });
            for (const vault of vaults) {
              try {
                const id = await subscribeAccountWithRetry(vault, handle);
                subs.push({ kind: 'account', id });
                targetedSourceByAccount.set(vault.toBase58(), 'orca');
                debugLogTargeted('orca', vault.toBase58(), { kind: 'vault' });
                derivedAccountToPool.set(vault.toBase58(), { poolId: poolAddr, accountType: 'vault' });
                logger.info('orca.vault.subscribed', { pool: poolAddr.slice(0,8)+'…', vault: vault.toBase58().slice(0,8)+'…', cat: 'pools' });
              } catch (err) {
                logger.info('orca.vault.subscribe.fail', { pool: poolAddr.slice(0,8)+'…', error: String(err), cat: 'pools' });
              }
            }
            
            // Subscribe to oracle
            if (whirlpoolData?.oracle) {
              try {
                const id = await subscribeAccountWithRetry(whirlpoolData.oracle, handle);
                subs.push({ kind: 'account', id });
                targetedSourceByAccount.set(whirlpoolData.oracle.toBase58(), 'orca');
                debugLogTargeted('orca', whirlpoolData.oracle.toBase58(), { kind: 'oracle' });
                derivedAccountToPool.set(whirlpoolData.oracle.toBase58(), { poolId: poolAddr, accountType: 'oracle' });
                logger.info('orca.oracle.subscribed', { pool: poolAddr.slice(0,8)+'…', oracle: whirlpoolData.oracle.toBase58().slice(0,8)+'…', cat: 'pools' });
              } catch (err) {
                logger.info('orca.oracle.subscribe.fail', { pool: poolAddr.slice(0,8)+'…', error: String(err), cat: 'pools' });
              }
            } else {
              logger.info('orca.oracle.missing', { pool: poolAddr.slice(0,8)+'…', cat: 'pools' });
            }
            
            // Subscribe to active tick arrays
            const tickSpacing = whirlpoolData?.tickSpacing;
            const currentTick = whirlpoolData?.tickCurrentIndex;
            logger.info('orca.tickarrays.attempting', { pool: poolAddr.slice(0,8)+'…', tickSpacing, currentTick, hasPDAUtil: !!PDAUtil, cat: 'pools' });
            
            if (tickSpacing !== undefined && currentTick !== undefined && PDAUtil) {
              try {
                const TickUtil = sdkAny?.TickUtil || (await import('@orca-so/whirlpools-sdk/dist/utils/public/tick-utils.js').catch(() => null))?.TickUtil;
                const orcaProgramId = new web3.PublicKey(String(CONFIG.orca?.programId || 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc'));
                
                if (TickUtil && typeof TickUtil.getStartTickIndex === 'function') {
                  let tickArrayCount = 0;
                  for (let offset = -1; offset <= 1; offset++) {
                    try {
                      const startTick = TickUtil.getStartTickIndex(currentTick, tickSpacing, offset);
                      const tickArrayPda = PDAUtil.getTickArray(orcaProgramId, pk, startTick);
                      
                      if (tickArrayPda?.publicKey) {
                        const id = await subscribeAccountWithRetry(tickArrayPda.publicKey, handle);
                        subs.push({ kind: 'account', id });
                        targetedSourceByAccount.set(tickArrayPda.publicKey.toBase58(), 'orca');
                        debugLogTargeted('orca', tickArrayPda.publicKey.toBase58(), { kind: 'tick_array', offset });
                        derivedAccountToPool.set(tickArrayPda.publicKey.toBase58(), { poolId: poolAddr, accountType: 'tick_array' });
                        tickArrayCount++;
                      }
                    } catch (err) {
                      logger.info('orca.whirlpool.tickarray.subscribe.fail', { pool: poolAddr, offset, error: String((err as any)?.message || err) });
                    }
                  }
                  logger.info('orca.tickarrays.subscribed', { pool: poolAddr.slice(0,8)+'…', count: tickArrayCount, cat: 'pools' });
                } else {
                  logger.info('orca.tickarrays.no_tickutil', { pool: poolAddr.slice(0,8)+'…', hasTickUtil: !!TickUtil, cat: 'pools' });
                }
              } catch (err) {
                logger.info('orca.whirlpool.tickarray.derive.fail', { pool: poolAddr, error: String((err as any)?.message || err) });
              }
            } else {
              logger.info('orca.tickarrays.skipped', { pool: poolAddr.slice(0,8)+'…', reason: !tickSpacing ? 'no_spacing' : !currentTick ? 'no_tick' : 'no_pda', cat: 'pools' });
            }
            
            logger.info('orca.attach.complete', { pool: poolAddr.slice(0,8)+'…', cat: 'pools' });
          } catch (err) {
            logger.info('orca.attach.error', { pool: poolAddr.slice(0,8)+'…', error: String(err), cat: 'pools' });
          }
        };

        // Helper: attach Meteora DLMM reserve accounts (reserveX, reserveY) and oracle for a given pool address
        // OPTIMIZED: Use SDK derivation without RPC fetch!
        const attachMeteoraReserves = async (poolAddr: string) => {
          try {
            logger.info('meteora.attach.start', { pool: poolAddr.slice(0,8)+'…', cat: 'pools' });
            const pk = new web3.PublicKey(poolAddr);
            const program = ensureMeteoraProgram();
            if (!program) {
              logger.info('meteora.attach.no_program', { pool: poolAddr.slice(0,8)+'…', cat: 'pools' });
              return;
            }
            const programId = program.programId;
            
            // NO RPC FETCH NEEDED - Pure SDK derivation!
            const DLMM: any = await import('@meteora-ag/dlmm').catch(() => null);
            const deriveReserve = DLMM?.DLMM?.deriveReserve;
            
            if (typeof deriveReserve === 'function') {
              try {
                // Derive reserveX (deterministic, no RPC)
                const rxResult = await deriveReserve(programId, pk, true);
                const reserveX = rxResult?.publicKey || rxResult;
                if (reserveX) {
                  const id = await subscribeAccountWithRetry(reserveX, handle);
                  subs.push({ kind: 'account', id });
                  targetedSourceByAccount.set(reserveX.toBase58(), 'meteora');
                  debugLogTargeted('meteora', reserveX.toBase58(), { kind: 'reserveX' });
                  derivedAccountToPool.set(reserveX.toBase58(), { poolId: poolAddr, accountType: 'reserve' });
                  logger.info('meteora.reserve.x.subscribed', { pool: poolAddr.slice(0,8)+'…', reserve: reserveX.toBase58().slice(0,8)+'…', cat: 'pools' });
                }
              } catch (err) {
                try { logger.info('meteora.reserve.x.subscribe.fail', { pool: poolAddr, error: String((err as any)?.message || err) }); } catch {}
              }
              
              try {
                // Derive reserveY (deterministic, no RPC)
                const ryResult = await deriveReserve(programId, pk, false);
                const reserveY = ryResult?.publicKey || ryResult;
                if (reserveY) {
                  const id = await subscribeAccountWithRetry(reserveY, handle);
                  subs.push({ kind: 'account', id });
                  targetedSourceByAccount.set(reserveY.toBase58(), 'meteora');
                  debugLogTargeted('meteora', reserveY.toBase58(), { kind: 'reserveY' });
                  derivedAccountToPool.set(reserveY.toBase58(), { poolId: poolAddr, accountType: 'reserve' });
                  logger.info('meteora.reserve.y.subscribed', { pool: poolAddr.slice(0,8)+'…', reserve: reserveY.toBase58().slice(0,8)+'…', cat: 'pools' });
                }
              } catch (err) {
                try { logger.info('meteora.reserve.y.subscribe.fail', { pool: poolAddr, error: String((err as any)?.message || err) }); } catch {}
              }
            }
            
            // Derive oracle (deterministic, no RPC)
            const deriveOracle = DLMM?.DLMM?.deriveOracle;
            if (typeof deriveOracle === 'function') {
              try {
                const oracleResult = await deriveOracle(programId, pk);
                const oracle = oracleResult?.publicKey || oracleResult;
                if (oracle) {
                  const id = await subscribeAccountWithRetry(oracle, handle);
                  subs.push({ kind: 'account', id });
                  targetedSourceByAccount.set(oracle.toBase58(), 'meteora');
                  debugLogTargeted('meteora', oracle.toBase58(), { kind: 'oracle' });
                  derivedAccountToPool.set(oracle.toBase58(), { poolId: poolAddr, accountType: 'oracle' });
                  logger.info('meteora.oracle.subscribed', { pool: poolAddr.slice(0,8)+'…', oracle: oracle.toBase58().slice(0,8)+'…', cat: 'pools' });
                }
              } catch (err) {
                try { logger.info('meteora.oracle.subscribe.fail', { pool: poolAddr, error: String((err as any)?.message || err) }); } catch {}
              }
            }
            
            logger.info('meteora.attach.complete', { pool: poolAddr.slice(0,8)+'…', cat: 'pools' });
          } catch (err) {
            logger.info('meteora.attach.error', { pool: poolAddr.slice(0,8)+'…', error: String(err), cat: 'pools' });
          }
        };

        // Check if sequential mode is enabled (used during retarget to avoid RPC burst)
        const isSequentialMode = suppressInitialOnce === true && !!(startPoolWebsocketsOnlyOnce as any).__sequentialMode;
        const staggerDelayMs = isSequentialMode ? Number((CONFIG.system as any)?.wsRetargetStaggerMs || 3000) : 0;
        
        if (isSequentialMode) {
          logger.info('pools.ws sequential.mode', { enabled: true, staggerMs: staggerDelayMs, cat: 'pools' });
        }

        // Subscribe to Orca Whirlpool POOL accounts only: prefer graph edge pool ids, else derive PDAs from watchlist
        logger.info('pools.ws dex.subscribe.start', { dex: 'orca', sequential: isSequentialMode, cat: 'pools' });
        try {
          const { PublicKey } = web3;
          const sdkAny: any = await import('@orca-so/whirlpools-sdk').catch(() => null);
          const PDAUtil = sdkAny?.PDAUtil;
          const programId = new PublicKey(String(CONFIG.orca?.programId));
          const configPk = new PublicKey(String(CONFIG.orca?.configPubkey));
          const wl = await readJson<any[]>(CONFIG.watchlistPath, []);
          // Build target set from current graph snapshot edges
          const edgePoolIds = new Set<string>();
          try {
            const gmod: any = await import('./graph.js');
            const snap = await gmod.getGraphSnapshot(false);
            for (const e of (snap?.edges || [])) {
              const dex = String((e as any)?.dex || '');
              if (dex !== 'Orca') continue;
              const pid = String((e as any)?.pool_id || '');
              if (pid) edgePoolIds.add(pid.replace(/-rev$/,''));
            }
          } catch {}
          const SOL = 'So11111111111111111111111111111111111111112';
          const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
          const tickSpacings = [8, 16, 32, 64, 128, 256];
          let uniq: string[] = [];
          if (edgePoolIds.size > 0) {
            uniq = Array.from(edgePoolIds);
            targetedWsActive = true;
            try { logger.info('pools.ws targets.orca from graph', { size: uniq.length }); } catch {}
          } else {
            // Fallback: derive from watchlist pairs (legacy behavior)
            const pairs: Array<[string, string]> = [];
            const watchMints: string[] = Array.from(new Set(wl.map((t: any) => (typeof t === 'string' ? t : t?.id)).filter(Boolean)));
            for (const m of watchMints.slice(0, 100)) { if (m !== USDC) pairs.push([m, USDC]); if (m !== SOL) pairs.push([m, SOL]); }
            pairs.push([SOL, USDC]);
            const poolAddrs: string[] = [];
            if (PDAUtil) {
              for (const [a, b] of pairs) {
                const [mintA, mintB] = String(a) < String(b) ? [a, b] : [b, a];
                for (const ts of tickSpacings) {
                  try {
                    const pda = PDAUtil.getWhirlpool(programId, configPk, new PublicKey(mintA), new PublicKey(mintB), ts);
                    poolAddrs.push(pda.publicKey.toBase58());
                  } catch {}
                }
              }
            }
            uniq = Array.from(new Set(poolAddrs));
          }
          const startTsOrca = Date.now();
          let attached = 0;
          // Rate-limit new attachments per second based on config
          // During retarget (sequential mode), use slower rate to avoid overwhelming RPC limiter
          const basePerSec = Math.max(1, Number(((CONFIG.system as any)?.wsAttachPerSec) || 10));
          const perSec = isSequentialMode 
            ? Math.max(1, Number((CONFIG.system as any)?.wsRetargetAttachPerSec || Math.floor(basePerSec / 2)))
            : basePerSec;
          const intervalMs = Math.floor(1000 / perSec);
          const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
          logger.info('pools.ws orca.loop.start', { 
            poolCount: uniq.length, 
            rateLimit: `${perSec}/sec`, 
            intervalMs, 
            sequential: isSequentialMode,
            cat: 'pools' 
          });
          for (let i = 0; i < uniq.length; i++) {
            const addr = uniq[i];
            logger.info('pools.ws orca.pool.processing', { index: i, total: uniq.length, pool: addr.slice(0,8)+'…', cat: 'pools' });
            try {
              const pk = new PublicKey(addr);
              const id = await subscribeAccountWithRetry(pk, handle);
              subs.push({ kind: 'account', id }); attached++;
              try {
                const acct = pk.toBase58();
                targetedSourceByAccount.set(acct, 'orca');
                debugLogTargeted('orca', acct, { kind: 'pool' });
                logger.info('pools.ws orca.pool.subscribed', { index: i, pool: addr.slice(0,8)+'…', cat: 'pools' });
              } catch {}
              // Attach Orca Whirlpool vault, oracle, and tick array listeners
              // Await to respect rate limiter (additional attachments also consume WS attach slots)
              await attachOrcaWhirlpoolAccounts(addr).catch((err) => {
                try { logger.info('orca.attach.fail', { pool: addr.slice(0,8)+'…', error: String(err?.message || err), stack: err?.stack }); } catch {}
              });
              logger.info('pools.ws orca.pool.attached', { index: i, pool: addr.slice(0,8)+'…', cat: 'pools' });
            } catch {}
            if (i < uniq.length - 1 && intervalMs > 0) { await sleep(intervalMs); }
            logger.info('pools.ws orca.pool.complete', { index: i, pool: addr.slice(0,8)+'…', cat: 'pools' });
          }
          attachedOrcaPools = attached;
          logger.info('pools.ws subscribe orca.pools', { attached, target: uniq.length, source: 'orca', ms: Date.now() - startTsOrca });
          // Subscribe at program level only if we had no targeted addresses and explicit fallback is allowed
          if (attached === 0 && !!((CONFIG.system as any)?.wsFallbackPrograms) && ((CONFIG.system as any)?.wsFallbackAllowZeroTargets === true)) {
            try { logger.info('pools.ws subscribe orca(program)', { source: 'orca', cat: 'pools' }); } catch {}
            {
              const id = await subscribeProgramWithRetry(orcaProg, (ch: any) => handle(ch.accountId, ch.accountInfo));
              subs.push({ kind: 'program', id });
            }
          }
        } catch (e:any) {
          logger.warn('pools.ws orca address subscribe failed', { error: String(e?.message || e) });
          // Fallback to program-level subscription (may include non-pool accounts) only when explicitly allowed
          if (!!((CONFIG.system as any)?.wsFallbackPrograms) && ((CONFIG.system as any)?.wsFallbackAllowZeroTargets === true)) {
            try { logger.info('pools.ws subscribe orca(fallback)', { source: 'orca', cat: 'pools' }); } catch {}
            {
              const id = await subscribeProgramWithRetry(orcaProg, (ch: any) => handle(ch.accountId, ch.accountInfo));
              subs.push({ kind: 'program', id });
            }
          }
        }
        
        // Stagger delay between DEX sources in sequential mode to avoid RPC burst
        if (isSequentialMode && staggerDelayMs > 0) {
          logger.info('pools.ws sequential.stagger', { 
            afterDex: 'orca', 
            beforeDex: 'raydium', 
            delayMs: staggerDelayMs, 
            cat: 'pools' 
          });
          await new Promise(r => setTimeout(r, staggerDelayMs));
        }
        
        // Raydium address-level subscriptions when we have known pool ids (from prior refresh)
        logger.info('pools.ws dex.subscribe.start', { dex: 'raydium', sequential: isSequentialMode, cat: 'pools' });
        try {
          // Prefer graph edge pool ids if available
          const edgePoolIds = new Set<string>();
          try {
            const gmod: any = await import('./graph.js');
            const snap = await gmod.getGraphSnapshot(false);
            for (const e of (snap?.edges || [])) {
              const dex = String((e as any)?.dex || '');
              if (dex !== 'Raydium') continue;
              const pid = String((e as any)?.pool_id || '');
              if (pid) edgePoolIds.add(pid.replace(/-rev$/,''));
            }
            try { logger.info('pools.ws targets.raydium from graph', { size: edgePoolIds.size }); } catch {}
          } catch {}
          const rayKnown: string[] = [];
          try { for (const p of (raydiumCache.data?.amm || [])) if (p?.id) rayKnown.push(String(p.id)); } catch {}
          try { for (const p of (raydiumCache.data?.clmm || [])) if (p?.id) rayKnown.push(String(p.id)); } catch {}
          const startTsRay = Date.now();
          const base = edgePoolIds.size > 0 ? Array.from(edgePoolIds) : rayKnown;
          const uniqueRay = Array.from(new Set(base.filter(Boolean)));
          let attachedRay = 0;
          // Rate-limit new attachments per second based on config
          // During retarget (sequential mode), use slower rate to avoid overwhelming RPC limiter
          const basePerSecRay = Math.max(1, Number(((CONFIG.system as any)?.wsAttachPerSec) || 10));
          const perSecRay = isSequentialMode 
            ? Math.max(1, Number((CONFIG.system as any)?.wsRetargetAttachPerSec || Math.floor(basePerSecRay / 2)))
            : basePerSecRay;
          const intervalMsRay = Math.floor(1000 / perSecRay);
          const sleepRay = (ms: number) => new Promise(r => setTimeout(r, ms));
          logger.info('pools.ws raydium.loop.start', { 
            poolCount: uniqueRay.length, 
            rateLimit: `${perSecRay}/sec`, 
            intervalMs: intervalMsRay, 
            sequential: isSequentialMode,
            cat: 'pools' 
          });
          for (let i = 0; i < uniqueRay.length; i++) {
            const addr = uniqueRay[i];
            try {
              const pk = new web3.PublicKey(addr);
              const id = await subscribeAccountWithRetry(pk, handle);
              subs.push({ kind: 'account', id }); attachedRay++;
              try {
                const acct = pk.toBase58();
                targetedSourceByAccount.set(acct, 'raydium');
                debugLogTargeted('raydium', acct, { kind: 'pool' });
              } catch {}
              // Detect pool type (AMM vs CLMM) and attach appropriate accounts
              // Check account owner to determine pool type
              try {
                const { withRpcLimit } = await import('../utils/rpcLimiter.js');
                const poolAcc: any = await withRpcLimit(
                  () => conn.getAccountInfo(pk, CONFIG.system.txCommitment as any),
                  1,
                  { module: 'pools', method: 'getAccountInfo' }
                );
                if (poolAcc) {
                  const owner = poolAcc.owner?.toBase58?.();
                  const rayAmmOwner = rayAmm.toBase58();
                  const rayClmmOwner = rayClmm.toBase58();
                  
                  if (owner === rayClmmOwner) {
                    // CLMM pool: attach vaults, observation, tick arrays
                    await attachRaydiumClmmAccounts(addr).catch((err) => {
                      try { logger.info('raydium.clmm.attach.fail', { pool: addr.slice(0,8)+'…', error: String(err?.message || err) }); } catch {}
                    });
                  } else if (owner === rayAmmOwner) {
                    // AMM pool: attach vaults
                    await attachRaydiumAmmVaults(addr).catch((err) => {
                      try { logger.info('raydium.amm.attach.fail', { pool: addr.slice(0,8)+'…', error: String(err?.message || err) }); } catch {}
                    });
                  } else {
                    // Unknown type, try AMM first (more common)
                    await attachRaydiumAmmVaults(addr).catch((err) => {
                      try { logger.info('raydium.unknown.attach.fail', { pool: addr.slice(0,8)+'…', error: String(err?.message || err) }); } catch {}
                    });
                  }
                }
              } catch {
                // Fallback: try AMM first
                await attachRaydiumAmmVaults(addr).catch((err) => {
                  try { logger.info('raydium.attach.fallback.fail', { pool: addr.slice(0,8)+'…', error: String(err?.message || err) }); } catch {}
                });
              }
            } catch {}
            if (i < uniqueRay.length - 1 && intervalMsRay > 0) { await sleepRay(intervalMsRay); }
          }
          attachedRaydiumPools = attachedRay;
          logger.info('pools.ws subscribe raydium.pools', { attached: attachedRay, target: uniqueRay.length, ms: Date.now() - startTsRay });
          // Fallback to program-level if none attached and explicit fallback is allowed
          if (attachedRay === 0 && !!((CONFIG.system as any)?.wsFallbackPrograms) && ((CONFIG.system as any)?.wsFallbackAllowZeroTargets === true)) {
            try { logger.info('pools.ws subscribe raydium.amm(fallback)', { source: 'raydium', cat: 'pools' }); } catch {}
            {
              const idA = await subscribeProgramWithRetry(rayAmm, (ch: any) => handle(ch.accountId, ch.accountInfo));
              subs.push({ kind: 'program', id: idA });
            }
            try { logger.info('pools.ws subscribe raydium.clmm(fallback)', { source: 'raydium', cat: 'pools' }); } catch {}
            {
              const idC = await subscribeProgramWithRetry(rayClmm, (ch: any) => handle(ch.accountId, ch.accountInfo));
              subs.push({ kind: 'program', id: idC });
            }
          }
        } catch {}
        
        // Stagger delay between DEX sources in sequential mode to avoid RPC burst
        if (isSequentialMode && staggerDelayMs > 0) {
          logger.info('pools.ws sequential.stagger', { 
            afterDex: 'raydium', 
            beforeDex: 'meteora', 
            delayMs: staggerDelayMs, 
            cat: 'pools' 
          });
          await new Promise(r => setTimeout(r, staggerDelayMs));
        }
        
        // Meteora targeted subscriptions from graph edges. Fallback to cached pools if graph doesn't have edges yet.
        logger.info('pools.ws dex.subscribe.start', { dex: 'meteora', sequential: isSequentialMode, cat: 'pools' });
        try {
          const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
          
          // Build target set: prefer graph edges, fallback to cached pools (like Raydium does)
          let meteoraPoolIds = Array.from(meteoraTargets);
          if (meteoraPoolIds.length === 0) {
            // Fallback to cached pool IDs
            const meteoraKnown: string[] = [];
            try { for (const p of (meteoraCache.data?.clmm || [])) if (p?.id) meteoraKnown.push(String(p.id)); } catch {}
            meteoraPoolIds = meteoraKnown;
            if (meteoraPoolIds.length > 0) {
              try { logger.info('pools.ws targets.meteora from cache', { size: meteoraPoolIds.length }); } catch {}
              // Also update meteoraTargets Set so handle() closure can recognize events
              for (const id of meteoraPoolIds) { meteoraTargets.add(id); }
            }
          }
          
          const attachMeteora = async (targetIds: string[]): Promise<number> => {
            const startTs = Date.now();
            let attached = 0;
            let failed = 0;
            const edgeIds: string[] = targetIds;
            // Rate-limit new attachments per second based on config
            // During retarget (sequential mode), use slower rate to avoid overwhelming RPC limiter
            const basePerSecMet = Math.max(1, Number(((CONFIG.system as any)?.wsAttachPerSec) || 10));
            const perSecMet = isSequentialMode 
              ? Math.max(1, Number((CONFIG.system as any)?.wsRetargetAttachPerSec || Math.floor(basePerSecMet / 2)))
              : basePerSecMet;
            const intervalMsMet = Math.floor(1000 / perSecMet);
            const sleepMet = (ms: number) => new Promise(r => setTimeout(r, ms));
            logger.info('pools.ws meteora.loop.start', { 
              poolCount: edgeIds.length, 
              rateLimit: `${perSecMet}/sec`, 
              intervalMs: intervalMsMet, 
              sequential: isSequentialMode,
              cat: 'pools' 
            });
            for (let i = 0; i < edgeIds.length; i++) {
              const addr = edgeIds[i];
              try {
                const pk = new web3.PublicKey(addr);
                const id = await subscribeAccountWithRetry(pk, handle);
                subs.push({ kind: 'account', id }); attached++;
                try {
                  const acct = pk.toBase58();
                  targetedSourceByAccount.set(acct, 'meteora');
                  debugLogTargeted('meteora', acct, { kind: 'pool' });
                } catch {}
                // Attach Meteora reserve and oracle accounts
                // Await to respect rate limiter (additional attachments also consume WS attach slots)
                await attachMeteoraReserves(addr).catch((err) => {
                  try { logger.info('meteora.attach.fail', { pool: addr.slice(0,8)+'…', error: String(err?.message || err), stack: err?.stack }); } catch {}
                });
                // Ensure meteoraTargets Set includes this ID for handle() closure
                meteoraTargets.add(addr);
              } catch (e: any) {
                failed++;
                try { logger.info('pools.ws meteora subscribe failed for pool', { addr: addr.slice(0,8)+'…', error: String(e?.message || e).slice(0,100) }); } catch {}
              }
              if (i < edgeIds.length - 1 && intervalMsMet > 0) { await sleepMet(intervalMsMet); }
            }
            if (failed > 0) {
              try { logger.warn('pools.ws meteora subscribe partial failure', { attached, failed, total: edgeIds.length }); } catch {}
            }
            try {
              logger.info('pools.ws meteora.attach.complete', { attached, failed, total: edgeIds.length, ms: Date.now() - startTs, cat: 'pools' });
            } catch {}
            return attached;
          };
          
          // Try immediate targets; if none, make a couple of quick retries to allow first graph to include Meteora edges
          let attachedMet = await attachMeteora(meteoraPoolIds);
          if (attachedMet === 0 && meteoraTargets.size === 0) {
            const maxRetries = Math.max(1, Number(((CONFIG.system as any)?.meteoraWsRetryCount) || 2));
            const delayMs = Math.max(200, Number(((CONFIG.system as any)?.meteoraWsRetryDelayMs) || 600));
            for (let i = 0; i < maxRetries && attachedMet === 0; i++) {
              try {
                // Refresh targets from a fresh graph snapshot
                const gmod: any = await import('./graph.js');
                const snap = await gmod.getGraphSnapshot(true);
                const mset = new Set<string>();
                for (const e of (snap?.edges || [])) {
                  const pid = String((e as any)?.pool_id || '');
                  if (!pid) continue;
                  const base = pid.replace(/-rev$/, '');
                  if ((e as any)?.dex === 'Meteora') mset.add(base);
                }
                // Merge new targets into existing Set (don't replace, to preserve any already subscribed)
                for (const id of mset) { meteoraTargets.add(id); }
                meteoraPoolIds = Array.from(meteoraTargets);
              } catch {}
              if (meteoraPoolIds.length > 0) attachedMet = await attachMeteora(meteoraPoolIds);
              if (attachedMet === 0) await sleep(delayMs);
            }
          }
          attachedMeteoraPools = attachedMet;
          
          // Always log (like Orca and Raydium do), even if attachedMet === 0
          logger.info('pools.ws subscribe meteora.pools', { attached: attachedMet, target: meteoraPoolIds.length, source: 'meteora' });
          
          // Program-level fallback when configured
          if (attachedMet === 0) {
            const meteoraProg = String((CONFIG as any)?.meteora?.programId || '').trim();
            if (meteoraProg && !!((CONFIG.system as any)?.meteoraWsProgramFallback)) {
              try { logger.info('pools.ws subscribe meteora(program)', { source: 'meteora', cat: 'pools' }); } catch {}
              {
                const id = await subscribeProgramWithRetry(new web3.PublicKey(meteoraProg), (ch: any) => handle(ch.accountId, ch.accountInfo));
                subs.push({ kind: 'program', id });
              }
              attachedMeteoraPools = 1;
            }
          }
        } catch (e:any) {
          logger.warn('pools.ws meteora subscribe failed', { error: String(e?.message || e), stack: String(e?.stack || '').slice(0,200) });
          attachedMeteoraPools = 0;
        }
        
        // Stagger delay between DEX sources in sequential mode
        if (isSequentialMode && staggerDelayMs > 0) {
          logger.info('pools.ws sequential.stagger', { 
            afterDex: 'meteora', 
            beforeDex: 'pumpswap', 
            delayMs: staggerDelayMs, 
            cat: 'pools' 
          });
          await new Promise(r => setTimeout(r, staggerDelayMs));
        }
        
        // Pumpswap pool subscriptions
        logger.info('pools.ws dex.subscribe.start', { dex: 'pumpswap', sequential: isSequentialMode, cat: 'pools' });
        try {
          const { PUMPSWAP_PROGRAM_ID } = await import('./pools/pumpswap.js');
          const pumpswapProg = new web3.PublicKey(PUMPSWAP_PROGRAM_ID);
          
          // Get pool IDs from cache or graph
          const edgePoolIds = new Set<string>();
          try {
            const gmod: any = await import('./graph.js');
            const snap = await gmod.getGraphSnapshot(false);
            for (const e of (snap?.edges || [])) {
              const dex = String((e as any)?.dex || '');
              if (dex !== 'Pumpswap') continue;
              const pid = String((e as any)?.pool_id || '');
              if (pid) edgePoolIds.add(pid.replace(/-rev$/,''));
            }
            try { logger.info('pools.ws targets.pumpswap from graph', { size: edgePoolIds.size }); } catch {}
          } catch {}
          
          const pumpKnown: string[] = [];
          try { for (const p of (pumpswapCache.data?.amm || [])) if (p?.id) pumpKnown.push(String(p.id)); } catch {}
          
          const startTsPump = Date.now();
          const base = edgePoolIds.size > 0 ? Array.from(edgePoolIds) : pumpKnown;
          const uniquePump = Array.from(new Set(base.filter(Boolean)));
          let attachedPump = 0;
          
          // Rate-limit attachments
          const basePerSecPump = Math.max(1, Number(((CONFIG.system as any)?.wsAttachPerSec) || 10));
          const perSecPump = isSequentialMode 
            ? Math.max(1, Number((CONFIG.system as any)?.wsRetargetAttachPerSec || Math.floor(basePerSecPump / 2)))
            : basePerSecPump;
          const intervalMsPump = Math.floor(1000 / perSecPump);
          const sleepPump = (ms: number) => new Promise(r => setTimeout(r, ms));
          
          logger.info('pools.ws pumpswap.loop.start', { 
            poolCount: uniquePump.length, 
            rateLimit: `${perSecPump}/sec`, 
            intervalMs: intervalMsPump, 
            sequential: isSequentialMode,
            cat: 'pools' 
          });
          
          for (let i = 0; i < uniquePump.length; i++) {
            const addr = uniquePump[i];
            try {
              const pk = new web3.PublicKey(addr);
              const id = await subscribeAccountWithRetry(pk, handle);
              subs.push({ kind: 'account', id }); 
              attachedPump++;
              
              try {
                const acct = pk.toBase58();
                targetedSourceByAccount.set(acct, 'pumpswap');
                debugLogTargeted('pumpswap' as any, acct, { kind: 'pool' });
                logger.debug('pools.ws pumpswap.pool.subscribed', { index: i, pool: addr.slice(0,8)+'…', cat: 'pools' });
              } catch {}
              
              // Attach vault listeners for Pumpswap AMM pools
              try {
                const pool = pumpswapCache.data?.amm?.find(p => p.id === addr);
                if (pool) {
                  if (pool.account_a) {
                    const vaultAPk = new web3.PublicKey(pool.account_a);
                    const vaultAId = await subscribeAccountWithRetry(vaultAPk, handle);
                    subs.push({ kind: 'account', id: vaultAId });
                    derivedAccountToPool.set(pool.account_a, { poolId: addr, accountType: 'vault' });
                    targetedSourceByAccount.set(pool.account_a, 'pumpswap');
                    debugLogTargeted('pumpswap' as any, pool.account_a, { kind: 'vault', side: 'a' });
                  }
                  if (pool.account_b) {
                    const vaultBPk = new web3.PublicKey(pool.account_b);
                    const vaultBId = await subscribeAccountWithRetry(vaultBPk, handle);
                    subs.push({ kind: 'account', id: vaultBId });
                    derivedAccountToPool.set(pool.account_b, { poolId: addr, accountType: 'vault' });
                    targetedSourceByAccount.set(pool.account_b, 'pumpswap');
                    debugLogTargeted('pumpswap' as any, pool.account_b, { kind: 'vault', side: 'b' });
                  }
                }
              } catch (e: any) {
                try { logger.debug('pools.ws pumpswap.vault.attach.fail', { pool: addr.slice(0,8)+'…', error: String(e?.message || e), cat: 'pools' }); } catch {}
              }
            } catch {}
            
            if (i < uniquePump.length - 1 && intervalMsPump > 0) { await sleepPump(intervalMsPump); }
          }
          
          attachedPumpswapPools = attachedPump;
          logger.info('pools.ws subscribe pumpswap.pools', { attached: attachedPump, target: uniquePump.length, source: 'pumpswap', ms: Date.now() - startTsPump });
          
          // Program-level fallback when configured
          if (attachedPump === 0 && !!((CONFIG.system as any)?.pumpswapWsProgramFallback)) {
            try { logger.info('pools.ws subscribe pumpswap(program)', { source: 'pumpswap', cat: 'pools' }); } catch {}
            {
              const id = await subscribeProgramWithRetry(pumpswapProg, (ch: any) => handle(ch.accountId, ch.accountInfo));
              subs.push({ kind: 'program', id });
            }
            attachedPumpswapPools = 1;
          }
        } catch (e:any) {
          logger.warn('pools.ws pumpswap subscribe failed', { error: String(e?.message || e), stack: String(e?.stack || '').slice(0,200) });
          attachedPumpswapPools = 0;
        }
        
        // Stagger delay between DEX sources in sequential mode
        if (isSequentialMode && staggerDelayMs > 0) {
          logger.info('pools.ws sequential.stagger', { 
            afterDex: 'pumpswap', 
            beforeDex: 'meteora_balanced', 
            delayMs: staggerDelayMs, 
            cat: 'pools' 
          });
          await new Promise(r => setTimeout(r, staggerDelayMs));
        }
        
        // Meteora Balanced pool subscriptions (AMM)
        logger.info('pools.ws dex.subscribe.start', { dex: 'meteora_balanced', sequential: isSequentialMode, cat: 'pools' });
        try {
          // Get pool IDs from graph edges
          const edgePoolIds = new Set<string>();
          try {
            const gmod: any = await import('./graph.js');
            const snap = await gmod.getGraphSnapshot(false);
            for (const e of (snap?.edges || [])) {
              const dex = String((e as any)?.dex || '');
              if (dex !== 'MeteoraBalanced') continue;
              const pid = String((e as any)?.pool_id || '');
              if (pid) edgePoolIds.add(pid.replace(/-rev$/,''));
            }
            try { logger.info('pools.ws targets.meteora_balanced from graph', { size: edgePoolIds.size }); } catch {}
          } catch {}
          
          // Fallback: use cache
          const mbalKnown: string[] = [];
          try { 
            for (const p of (metbalCache.data?.amm || [])) {
              if (p?.id) mbalKnown.push(String(p.id)); 
            }
          } catch {}
          
          const startTsMbal = Date.now();
          const base = edgePoolIds.size > 0 ? Array.from(edgePoolIds) : mbalKnown;
          const uniqueMbal = Array.from(new Set(base.filter(Boolean)));
          let attachedMbal = 0;
          
          // Rate-limit attachments
          const basePerSecMbal = Math.max(1, Number(((CONFIG.system as any)?.wsAttachPerSec) || 10));
          const perSecMbal = isSequentialMode 
            ? Math.max(1, Number((CONFIG.system as any)?.wsRetargetAttachPerSec || Math.floor(basePerSecMbal / 2)))
            : basePerSecMbal;
          const intervalMsMbal = Math.floor(1000 / perSecMbal);
          const sleepMbal = (ms: number) => new Promise(r => setTimeout(r, ms));
          
          logger.info('pools.ws meteora_balanced.loop.start', { 
            poolCount: uniqueMbal.length, 
            rateLimit: `${perSecMbal}/sec`, 
            intervalMs: intervalMsMbal, 
            sequential: isSequentialMode,
            cat: 'pools' 
          });
          
          for (let i = 0; i < uniqueMbal.length; i++) {
            const addr = uniqueMbal[i];
            try {
              const pk = new web3.PublicKey(addr);
              const id = await subscribeAccountWithRetry(pk, handle);
              subs.push({ kind: 'account', id }); 
              attachedMbal++;
              
              try {
                const acct = pk.toBase58();
                targetedSourceByAccount.set(acct, 'pumpswap' as any);
                debugLogTargeted('pumpswap' as any, acct, { kind: 'pool', source: 'meteora_balanced' });
                logger.debug('pools.ws meteora_balanced.pool.subscribed', { index: i, pool: addr.slice(0,8)+'…', cat: 'pools' });
              } catch {}
              
              // Attach vault listeners for Meteora Balanced AMM pools
              try {
                const pool = metbalCache.data?.amm?.find(p => p.id === addr);
                if (pool) {
                  if ((pool as any).account_a) {
                    const vaultAPk = new web3.PublicKey((pool as any).account_a);
                    const vaultAId = await subscribeAccountWithRetry(vaultAPk, handle);
                    subs.push({ kind: 'account', id: vaultAId });
                    derivedAccountToPool.set((pool as any).account_a, { poolId: addr, accountType: 'vault' });
                    targetedSourceByAccount.set((pool as any).account_a, 'pumpswap' as any);
                    debugLogTargeted('pumpswap' as any, (pool as any).account_a, { kind: 'vault', side: 'a', source: 'meteora_balanced' });
                  }
                  if ((pool as any).account_b) {
                    const vaultBPk = new web3.PublicKey((pool as any).account_b);
                    const vaultBId = await subscribeAccountWithRetry(vaultBPk, handle);
                    subs.push({ kind: 'account', id: vaultBId });
                    derivedAccountToPool.set((pool as any).account_b, { poolId: addr, accountType: 'vault' });
                    targetedSourceByAccount.set((pool as any).account_b, 'pumpswap' as any);
                    debugLogTargeted('pumpswap' as any, (pool as any).account_b, { kind: 'vault', side: 'b', source: 'meteora_balanced' });
                  }
                }
              } catch (e: any) {
                try { logger.debug('pools.ws meteora_balanced.vault.attach.fail', { pool: addr.slice(0,8)+'…', error: String(e?.message || e), cat: 'pools' }); } catch {}
              }
            } catch {}
            
            if (i < uniqueMbal.length - 1 && intervalMsMbal > 0) { await sleepMbal(intervalMsMbal); }
          }
          
          attachedMeteoraBalancedPools = attachedMbal;
          logger.info('pools.ws subscribe meteora_balanced.pools', { 
            attached: attachedMbal, 
            target: uniqueMbal.length, 
            source: 'meteora_balanced', 
            ms: Date.now() - startTsMbal 
          });
        } catch (e: any) {
          logger.warn('pools.ws meteora_balanced subscribe failed', { 
            error: String(e?.message || e), 
            stack: String(e?.stack || '').slice(0,200) 
          });
          attachedMeteoraBalancedPools = 0;
        }

        wsUnsubscribe = () => {
          try {
            // Begin async teardown and websocket close; future setups will await wsClosePromise
            wsClosePromise = (async () => {
              try {
                // Collect all bin subscriptions from trackers before clearing
                // These might not be in the subs array if setup() was called multiple times
                const binSubIds: number[] = [];
                try {
                  for (const tracker of meteoraBinTrackers.values()) {
                    for (const accountInfo of tracker.accounts.values()) {
                      if (typeof accountInfo.id === 'number') {
                        binSubIds.push(accountInfo.id);
                      }
                    }
                  }
                } catch {}

                // Best-effort await listener removals, but avoid calling into RPC when WS is CLOSING/CLOSED
                const removals: Array<Promise<any>> = [];
                const wsAny = (wsConn as any)?._rpcWebSocket?._ws;
                const ready: number = Number(wsAny?.readyState);
                // Only allow RPC calls if socket is OPEN (1), not CONNECTING (0) as CONNECTING may fail
                const canRpc = (ready === 1); // Only OPEN, not CONNECTING
                
                // Unsubscribe from main subs array BEFORE closing WebSocket
                // This ensures subscription maps are still intact during unsubscribe
                for (const s of subs) {
                  try {
                    if (!canRpc) continue;
                    if (s.kind === 'account') {
                      removals.push((conn as any).removeAccountChangeListener(s.id).catch(() => {}));
                    } else {
                      removals.push((conn as any).removeProgramAccountChangeListener(s.id).catch(() => {}));
                    }
                  } catch {}
                }
                
                // Also unsubscribe from bin subscriptions that might not be in subs array
                for (const binId of binSubIds) {
                  try {
                    if (!canRpc) continue;
                    // Check if this ID is already in subs to avoid double-unsubscribe
                    const alreadyInSubs = subs.some(s => s.id === binId);
                    if (!alreadyInSubs) {
                      removals.push((conn as any).removeAccountChangeListener(binId).catch(() => {}));
                    }
                  } catch {}
                }
                
                // Wait for all unsubscribe operations to complete before closing WebSocket
                if (canRpc && removals.length) {
                  try { await Promise.allSettled(removals); } catch {}
                }
                
                // NOW close WebSocket and clear subscription maps AFTER unsubscribing
                // This prevents "Ignored unsubscribe request" warnings from web3.js
                const { safeCloseWebSocket } = await import('../drift/wsHelper.js');
                await safeCloseWebSocket(conn, 'pools.unsubscribe');
                
                // Clear bin trackers after unsubscribing to prevent stale references
                try {
                  meteoraBinTrackers.clear();
                  meteoraBinAccountToPool.clear();
                } catch {}

                // Give a small delay to allow any in-flight subscription updates to complete
                await new Promise(r => setTimeout(r, 100));

                // Close underlying websocket if present to avoid CLOSING race on next subscribe
                try {
                  const wsAny2 = (wsConn as any)?._rpcWebSocket?._ws;
                  const rs: number | undefined = Number(wsAny2?.readyState);
                  // 0 CONNECTING, 1 OPEN, 2 CLOSING, 3 CLOSED
                  if (wsAny2 && (rs === 1 || rs === 2)) { // Only close if OPEN or CLOSING, not CONNECTING
                    try { (wsConn as any)?._rpcWebSocket?.close?.(); } catch {}
                  }
                  // Wait until CLOSED (3) or socket disappears, with small timeout
                  const deadline = Date.now() + Math.max(500, Number(((CONFIG.system as any)?.wsCloseWaitMs) || 2000));
                  let cur = Number(wsAny2?.readyState);
                  while (wsAny2 && cur !== 3 && Date.now() < deadline) {
                    await new Promise(r => setTimeout(r, 100));
                    cur = Number(wsAny2?.readyState);
                  }
                } catch {}
              } finally {
                try { wsConn = undefined; } catch {}
              }
            })();
            // Detach immediately; actual close will be awaited by the next setup
            wsClosePromise?.catch(() => {});
          } catch {}
        };
        logger.info('pools.ws subscriptions active');
        // Immediately emit a ws-activity snapshot so UI reflects attached counts without waiting for first aggregate tick
        try { emit('ws-activity', { healthy: wsHealthy, lastEventMs: lastWsEventMs, orca: { attached: attachedOrcaPools, events: 0 }, raydium: { attached: attachedRaydiumPools, events: 0 }, meteora: { attached: attachedMeteoraPools, events: 0 } }); } catch {}

        // Health monitor: if no WS events for timeoutMs, trigger periodic refresh as fallback
        const timeoutMs = Math.max(5000, Number((CONFIG.system as any)?.wsHealthTimeoutMs || 15000));
        if (healthTimer) { clearInterval(healthTimer); healthTimer = undefined; }
        healthTimer = setInterval(() => {
          try {
            const now = Date.now();
            const idle = now - (lastWsEventMs || 0);
            const healthy = wsHealthy && idle < timeoutMs * 2;
            if (!healthy) {
              // WS unhealthy: attempt auto-retarget with exponential backoff and reconnect hints
              try { logger.warn('pools.ws unhealthy', { idleMs: idle, timeoutMs }); } catch {}
              wsHealthy = false;
              (async () => {
                try {
                  const last = (reconcileNow as any)._last || 0;
                  const gap = Math.max(2000, Number((CONFIG.system as any)?.wsReconnectMinGapMs || 5000));
                  if (Date.now() - last > gap) {
                    await reconcileNow();
                  }
                } catch {}
              })();
            }
          } catch {}
        }, Math.max(2000, Math.floor((Number((CONFIG.system as any)?.wsHealthTimeoutMs || 15000)) / 3)));

        // Periodic aggregate logs for WS activity
        const aggPeriod = Math.max(5000, Number((CONFIG.system as any)?.wsAggLogPeriodMs || 15000));
        aggTimer = setInterval(() => {
          try {
            const snapshot = { raydium: wsCounts.raydium, orca: wsCounts.orca, meteora: wsCounts.meteora } as any;
            wsCounts.raydium = 0; wsCounts.orca = 0; wsCounts.meteora = 0;
            const metrics = {
              raydium: { ...wsDeltaStats.raydium, skipReasons: wsDeltaStats.raydium.skipReasons },
              orca: { ...wsDeltaStats.orca, skipReasons: wsDeltaStats.orca.skipReasons },
              meteora: { ...wsDeltaStats.meteora, skipReasons: wsDeltaStats.meteora.skipReasons },
            };
            const decodeMetrics = {
              raydium: { ...wsDecodeStats.raydium },
              orca: { ...wsDecodeStats.orca },
              meteora: { ...wsDecodeStats.meteora },
            };
            logger.info('pools.ws aggregate', { 
              events: snapshot, 
              healthy: wsHealthy, 
              lastEventMs: lastWsEventMs,
              counts: {
                raydium: { attached: attachedRaydiumPools, target: (typeof getWsTargets === 'function' ? (getWsTargets as any)._last?.raydium?.target : undefined) },
                orca: { attached: attachedOrcaPools, target: (typeof getWsTargets === 'function' ? (getWsTargets as any)._last?.orca?.target : undefined) },
                meteora: { attached: attachedMeteoraPools, target: (typeof getWsTargets === 'function' ? (getWsTargets as any)._last?.meteora?.target : undefined) }
              },
              metrics,
              decodeStats: decodeMetrics,
            });
            wsDeltaStats.raydium = { decoded: 0, applied: 0, skipped: 0, skipReasons: {} };
            wsDeltaStats.orca = { decoded: 0, applied: 0, skipped: 0, skipReasons: {} };
            wsDeltaStats.meteora = { decoded: 0, applied: 0, skipped: 0, skipReasons: {} };
            wsDecodeStats.raydium = { attempts: 0, successes: 0, failures: 0 };
            wsDecodeStats.orca = { attempts: 0, successes: 0, failures: 0 };
            wsDecodeStats.meteora = { attempts: 0, successes: 0, failures: 0 };
            // Emit a dedicated ws-activity event for UI regardless of log filtering
            try { emit('ws-activity', { healthy: wsHealthy, lastEventMs: lastWsEventMs, orca: { attached: attachedOrcaPools, events: snapshot.orca || 0 }, raydium: { attached: attachedRaydiumPools, events: snapshot.raydium || 0 }, meteora: { attached: attachedMeteoraPools, events: snapshot.meteora || 0 } }); } catch {}
            // Aggregate metrics are already logged above via logger.info('pools.ws aggregate', ...), no need for duplicate emit
            // Reconcile targets vs attached (debounced): if attached << targets, trigger retarget
            (async () => {
              try {
                // Check if auto-reconciliation is enabled
                const autoReconcile = (CONFIG.system as any)?.wsAutoReconcile !== false;
                if (!autoReconcile) return; // Skip reconciliation if disabled
                
                const tgt = await getWsTargets();
                const needRay = Math.max(0, (tgt.raydium.target || 0) - (attachedRaydiumPools || 0));
                const needOrc = Math.max(0, (tgt.orca.target || 0) - (attachedOrcaPools || 0));
                const needMet = Math.max(0, (tgt.meteora.target || 0) - (attachedMeteoraPools || 0));
                const needPump = Math.max(0, (tgt.pumpswap.target || 0) - (attachedPumpswapPools || 0));
                const sumNeed = needRay + needOrc + needMet + needPump;
                
                // Also retarget if significantly over target (shed excess subs)
                const lastTgts: any = (getWsTargets as any)?._last || {};
                const tgtRay = Math.max(0, Number(lastTgts?.raydium?.target || 0));
                const tgtOrc = Math.max(0, Number(lastTgts?.orca?.target || 0));
                const tgtMet = Math.max(0, Number(lastTgts?.meteora?.target || 0));
                const tgtPump = Math.max(0, Number(lastTgts?.pumpswap?.target || 0));
                const overRay = (tgtRay > 0) && (attachedRaydiumPools || 0) > Math.floor(tgtRay * 1.5);
                const overOrc = (tgtOrc > 0) && (attachedOrcaPools || 0) > Math.floor(tgtOrc * 1.5);
                const overMet = (tgtMet > 0) && (attachedMeteoraPools || 0) > Math.floor(tgtMet * 1.5);
                const overPump = (tgtPump > 0) && (attachedPumpswapPools || 0) > Math.floor(tgtPump * 1.5);
                
                // Only reconcile if mismatch exceeds threshold
                const threshold = Math.max(1, Number((CONFIG.system as any)?.wsReconcileThreshold || 10));
                const minGap = Number((CONFIG.system as any)?.wsReconcileMinGapMs || 60000);
                
                if (sumNeed > threshold || overRay || overOrc || overMet || overPump) {
                  const last = (reconcileNow as any)._last || 0;
                  if (Date.now() - last > minGap) {
                    try {
                      logger.info('pools.ws reconcile.triggered', {
                        reason: sumNeed > threshold ? 'missing_subscriptions' : 'excess_subscriptions',
                        missing: { total: sumNeed, raydium: needRay, orca: needOrc, meteora: needMet, pumpswap: needPump },
                        excess: { raydium: overRay, orca: overOrc, meteora: overMet, pumpswap: overPump },
                        threshold,
                        minGapMs: minGap,
                        cat: 'pools'
                      });
                    } catch {}
                    await reconcileNow();
                  }
                }
              } catch {}
            })();
          } catch {}
        }, aggPeriod);
      };
      setup()
        .catch((e: any) => logger.warn('pools.ws setup failed', { error: String(e?.message || e) }))
        .finally(() => { 
          wsSetupActive = false; 
          // Clear sequential mode flag after setup completes
          try { delete (startPoolWebsocketsOnlyOnce as any).__sequentialMode; } catch {}
        });
    } catch (e: any) {
      logger.warn('pools.ws unavailable', { error: String(e?.message || e) });
    }
  }
  // Reset the one-shot suppression flag
  suppressInitialOnce = false;
}

async function reconcileNow(): Promise<void> {
  try {
    (reconcileNow as any)._last = Date.now();
    await retargetPoolWebsockets();
  } catch {}
}

// Stop all pool activity: timers and websocket subscriptions
export function stopPoolRefreshLoop(): void {
  try { if (rayTimer) { clearInterval(rayTimer); rayTimer = undefined; } } catch {}
  try { if (orcaTimer) { clearInterval(orcaTimer); orcaTimer = undefined; } } catch {}
  try { if (aggTimer) { clearInterval(aggTimer); aggTimer = undefined; } } catch {}
  try { if (meteoraTimer) { clearInterval(meteoraTimer); meteoraTimer = undefined; } } catch {}
  try { if (healthTimer) { clearInterval(healthTimer); healthTimer = undefined; } } catch {}
  try { if (wsUnsubscribe) { wsUnsubscribe(); wsUnsubscribe = undefined; } } catch {}
  wsHealthy = false; lastWsEventMs = 0;
  
  // Clear Meteora bin trackers to prevent stale subscription references
  try {
    meteoraBinTrackers.clear();
    meteoraBinAccountToPool.clear();
  } catch {}
  
  try { logger.info('pools.stop all timers and ws unsubscribed'); } catch {}
}

// Allow external trigger (from graph start) to enable websocket-based refreshes
export function enablePoolWebsocketRefreshes(): void {
  if (wsAllowed) return;
  wsAllowed = true;
  try {
    // Only mark allowed; actual start is controlled by subscribe/unsubscribe routes
    logger.info('pools.ws allowed');
  } catch {}
}

export function disablePoolWebsocketRefreshes(): void {
  try {
    if (wsUnsubscribe) { wsUnsubscribe(); wsUnsubscribe = undefined; }
    if (healthTimer) { clearInterval(healthTimer); healthTimer = undefined; }
    wsHealthy = false; lastWsEventMs = 0;
    // Reset wsSetupActive to allow new setup to proceed
    wsSetupActive = false;
    
    // Clear Meteora bin trackers to prevent stale subscription references
    // that could trigger _updateSubscriptions after shutdown
    try {
      meteoraBinTrackers.clear();
      meteoraBinAccountToPool.clear();
    } catch {}
    
    logger.info('pools.ws unsubscribed');
  } catch {}
}

export function getPoolWsStatus(): { enabled: boolean; healthy: boolean; lastEventMs: number } {
  const enabled = !!((CONFIG.system as any)?.enablePoolWs) && wsAllowed;
  return { enabled, healthy: !!wsHealthy, lastEventMs: lastWsEventMs || 0 };
}

// Clear all in-memory normalized caches to force a fresh rebuild next boot
export function clearAllPoolCaches(): void {
  try { raydiumCache.data = undefined as any; raydiumCache.ts = 0; raydiumCache.inflight = undefined; } catch {}
  try { orcaCache.data = undefined as any; orcaCache.ts = 0; orcaCache.inflight = undefined; } catch {}
  try { meteoraCache.data = undefined as any; meteoraCache.ts = 0; meteoraCache.inflight = undefined; } catch {}
  try { metbalCache.data = undefined as any; metbalCache.ts = 0; metbalCache.inflight = undefined; } catch {}
  try { pumpswapCache.data = undefined as any; pumpswapCache.ts = 0; pumpswapCache.inflight = undefined; } catch {}
  try { enrichMemo.clear(); } catch {}
  try { meteoraBinTrackers.clear(); } catch {}
  try { meteoraBinAccountToPool.clear(); } catch {}
  try { logger.info('pools.caches cleared'); } catch {}
}

// Simple memo cache for per-pool enrichment results across cycles
const enrichMemo: Map<string, { mint_a?: string; mint_b?: string; decimals_a?: number; decimals_b?: number; ts: number }> = new Map();

// Non-fetching peek helpers so the graph can rebuild from current caches only
export function peekRaydiumPools(): PoolsPayload { return raydiumCache.data || { amm: [], clmm: [] }; }
export function peekOrcaPools(): PoolsPayload { return orcaCache.data || { amm: [], clmm: [] }; }
export function peekMeteoraPools(): PoolsPayload { return meteoraCache.data || { amm: [], clmm: [] }; }
export function peekMeteoraBalancedPools(): PoolsPayload { return metbalCache.data || { amm: [], clmm: [] }; }
export function peekPumpswapPools(): PoolsPayload { return pumpswapCache.data || { amm: [], clmm: [] }; }


export async function getMeteoraBalancedPoolsCached(force = false, opts?: { skipUniverseFilter?: boolean }): Promise<PoolsPayload> {
  const ttlMs = Number(((CONFIG as any)?.meteoraBalanced?.cacheTtlMs) || 300_000);
  const minForceGap = Math.max(1000, Number((CONFIG.system as any)?.poolRefreshMinGapMs || 3000));
  (getMeteoraBalancedPoolsCached as any).__lastForceAt = (getMeteoraBalancedPoolsCached as any).__lastForceAt || 0;
  const now = Date.now();
  if (!force) {
    if (metbalCache.data && now - metbalCache.ts < ttlMs) return metbalCache.data;
    return metbalCache.data || { amm: [], clmm: [] };
  }
  if (force) {
    const last = (getMeteoraBalancedPoolsCached as any).__lastForceAt as number;
    if (now - last < minForceGap && metbalCache.data) return metbalCache.data as any;
    (getMeteoraBalancedPoolsCached as any).__lastForceAt = now;
  }
  if (metbalCache.inflight) return metbalCache.inflight;
  metbalCache.inflight = (async () => {
    try {
      const t0 = Date.now();
      // Use union of v2+v1 (prefer v2) when available
      const union = await fetchMeteoraBalancedAllImpl().catch(async () => {
        const raw = await fetchMeteoraBalancedHttpImpl();
        return await normalizeMeteoraBalancedHttpImpl(raw);
      });
      const norm = union;
      const prev = metbalCache.data;
      metbalCache.data = norm; metbalCache.ts = Date.now();
      poolsMetrics.meteora_balanced.fetches = (poolsMetrics.meteora_balanced.fetches || 0) + 1;
      poolsMetrics.meteora_balanced.lastMs = Date.now();
      poolsMetrics.meteora_balanced.lastAmm = (norm.amm || []).length;
      try {
        const d = diffNormalizedPools(prev || { amm: [], clmm: [] }, norm);
        emit('pools-update', { source: 'meteora_balanced', amm: (norm.amm || []).length, clmm: 0, ts: Date.now() });
        emit('pool-updates', { source: 'meteora_balanced', updatedAmm: d.amm.length, updatedClmm: d.clmm.length, addedAmm: d.addedAmm, removedAmm: d.removedAmm, addedClmm: d.addedClmm, removedClmm: d.removedClmm, sample: { amm: d.amm.slice(0, 50), clmm: [] }, ts: Date.now() });
        const inc = !!((CONFIG.system as any)?.graphIncrementalMode);
        const hasDelta = d.amm.length || d.clmm.length || d.addedAmm || d.removedAmm || d.addedClmm || d.removedClmm;
        try {
          const gmod: any = await import('./graph.js');
          if (inc && hasDelta && typeof gmod.applyPoolUpdates === 'function') {
            // Fire-and-forget: don't await to avoid blocking HTTP fetchers
            void gmod.applyPoolUpdates(prev || { amm: [], clmm: [] }, norm, { pushToArb: true }).catch((err: any) => {
              try { logger.warn('graph.update.fire_forget_failed', { error: String(err?.message || err), source: 'meteora_balanced', cat: 'graph' }); } catch {}
            });
          } else if (!inc && hasDelta) {
            // Non-incremental mode: schedule rebuild only (only one path)
            const thresh = Math.max(0, Number((CONFIG.system as any)?.graphDeltaRebuildThreshold || 0));
            const delta = d.amm.length + d.clmm.length + d.addedAmm + d.addedClmm + d.removedAmm + d.removedClmm;
            // Only schedule if threshold met (0 means always, but check delta > 0 to avoid empty rebuilds)
            if ((thresh === 0 && delta > 0) || delta >= thresh) {
              gmod.scheduleGraphRebuild(undefined, Math.max(50, Number((CONFIG.system as any)?.graphRebuildDebounceMs || 150)));
            }
          }
        } catch {}
      } catch {}
      return norm;
    } finally {
      metbalCache.inflight = undefined;
    }
  })();
  return metbalCache.inflight;
}

export async function getPumpswapPoolsCached(force = false): Promise<PoolsPayload> {
  const ttlMs = Number((CONFIG as any)?.pumpswap?.cacheTtlMs || 60_000);
  const minForceGap = Math.max(1000, Number((CONFIG.system as any)?.poolRefreshMinGapMs || 3000));
  (getPumpswapPoolsCached as any).__lastForceAt = (getPumpswapPoolsCached as any).__lastForceAt || 0;
  const now = Date.now();
  if (!force) {
    if (pumpswapCache.data && now - pumpswapCache.ts < ttlMs) return pumpswapCache.data;
    return pumpswapCache.data || { amm: [], clmm: [] };
  }
  if (force) {
    const last = (getPumpswapPoolsCached as any).__lastForceAt as number;
    if (now - last < minForceGap && pumpswapCache.data) return pumpswapCache.data as any;
    (getPumpswapPoolsCached as any).__lastForceAt = now;
  }
  if (pumpswapCache.inflight) return pumpswapCache.inflight;
  pumpswapCache.inflight = (async () => {
    try {
      const mode = 'graphql';
      try { logger.info('pumpswap.fetch start', { mode, ttlMs, cat: 'pumpswap' }); } catch {}
      try { emit('log', { level: 'info', message: `arb:pools pumpswap.fetch start mode=${mode}`, timestamp: new Date().toISOString(), context: { cat: 'arb' } }); } catch {}
      const t0 = Date.now();
      const raw = await fetchPumpswapGraphQLImpl();
      
      // Enrich pools with RPC data (token account balances)
      const enrichResult = await enrichPumpswapPoolsWithRpcImpl(raw);
      const enrichedRaw = enrichResult.pools || raw;
      poolsMetrics.pumpswap.enrichmentSuccess = enrichResult.metrics?.success || 0;
      poolsMetrics.pumpswap.enrichmentFail = enrichResult.metrics?.fail || 0;
      poolsMetrics.pumpswap.enrichmentMs = enrichResult.metrics?.ms || 0;
      
      let norm = await normalizePumpswapPoolsImpl(enrichedRaw);
      // Apply token blocklist (exclude pools containing any blocked mint)
      try {
        const blist = new Set<string>(Array.isArray((CONFIG.system as any)?.tokenBlocklistMints) ? (CONFIG.system as any).tokenBlocklistMints : []);
        if (blist.size > 0) {
          const beforeAmm = (norm.amm || []).length;
          const filtered = applyTokenMintBlocklist(norm as any, blist);
          if ((filtered.amm || []).length !== beforeAmm) {
            try { logger.info('pumpswap.blocklist.filter', { beforeAmm, afterAmm: filtered.amm.length }); } catch {}
          }
          norm = filtered as any;
        }
      } catch {}
      
      // Apply TVL-based filtering (similar to Raydium)
      try {
        const globalAmm = Number(((CONFIG.system as any)?.minAmmLiqBase) ?? 0);
        const minAmmUsd = Math.max(globalAmm, Number(((CONFIG as any)?.pumpswap?.minLiqBase) || 0));
        if (minAmmUsd > 0) {
          const beforeAmm = norm.amm.length;
          const amm = norm.amm.filter(p => Number((p as any).liquidity_base || 0) >= minAmmUsd);
          if (amm.length !== beforeAmm) { 
            try { logger.info('pumpswap.filter tvl', { minAmmUsd, beforeAmm, afterAmm: amm.length, cat: 'pumpswap' }); } catch {} 
          }
          norm = { amm, clmm: [] } as any;
        }
      } catch {}
      
      // Cross-DEX price validation for Pumpswap pools
      try {
        const enableValidation = ((CONFIG as any)?.pumpswap?.validatePrices !== false);
        const maxSamples = Number(((CONFIG as any)?.pumpswap?.validationSamples || 5));
        if (enableValidation && norm.amm.length > 0) {
          // Get other DEX pools for comparison
          const rayPools = raydiumCache.data?.amm || [];
          const orcaPools = orcaCache.data?.amm || [];
          const metPools = metbalCache.data?.amm || [];
          
          // Build a map of (mint_a, mint_b) -> pools from other DEXes
          const otherDexPools = new Map<string, Array<{ dex: string; price: number; liquidity: number; pool: any }>>();
          const addPool = (pools: any[], dexName: string) => {
            for (const p of pools) {
              if (!p.mint_a || !p.mint_b || !p.price_a_per_b || p.price_a_per_b <= 0) continue;
              const key = `${p.mint_a}:${p.mint_b}`;
              if (!otherDexPools.has(key)) otherDexPools.set(key, []);
              otherDexPools.get(key)!.push({
                dex: dexName,
                price: p.price_a_per_b,
                liquidity: Number((p as any).liquidity_base || (p as any).tvl_usd || 0),
                pool: p
              });
            }
          };
          addPool(rayPools, 'Raydium');
          addPool(orcaPools, 'Orca');
          addPool(metPools, 'Meteora');
          
          // Compare Pumpswap pools against other DEXes
          let compared = 0;
          let withinTolerance = 0;
          let outsideTolerance = 0;
          const samples: any[] = [];
          
          for (const pump of norm.amm) {
            if (!pump.price_a_per_b || pump.price_a_per_b <= 0) continue;
            const key = `${pump.mint_a}:${pump.mint_b}`;
            const others = otherDexPools.get(key);
            if (!others || others.length === 0) continue;
            
            // Compare against the most liquid pool from other DEXes
            const mostLiquid = others.reduce((best, curr) => 
              curr.liquidity > best.liquidity ? curr : best
            );
            
            const pumpPrice = pump.price_a_per_b;
            const otherPrice = mostLiquid.price;
            const deviation = Math.abs(pumpPrice - otherPrice) / otherPrice;
            const deviationPct = (deviation * 100).toFixed(2);
            
            compared++;
            
            // Log if deviation exceeds 5%
            if (deviation > 0.05) {
              outsideTolerance++;
              if (samples.length < maxSamples) {
                samples.push({
                  pair: `${pump.mint_a.slice(0, 6)}.../${pump.mint_b.slice(0, 6)}...`,
                  pumpPrice: pumpPrice.toFixed(6),
                  pumpLiq: Number((pump as any).liquidity_base || 0).toFixed(2),
                  otherDex: mostLiquid.dex,
                  otherPrice: otherPrice.toFixed(6),
                  otherLiq: mostLiquid.liquidity.toFixed(2),
                  deviationPct: `${deviationPct}%`,
                  poolId: pump.id.slice(0, 8) + '...'
                });
              }
            } else {
              withinTolerance++;
            }
          }
          
          if (compared > 0) {
            try {
              logger.info('pumpswap.price.validation', {
                compared,
                withinTolerance,
                outsideTolerance,
                tolerancePct: 5,
                cat: 'pumpswap'
              });
              
              if (samples.length > 0) {
                logger.warn('pumpswap.price.deviations', {
                  count: samples.length,
                  samples,
                  cat: 'pumpswap'
                });
              }
            } catch {}
          }
        }
      } catch (e: any) {
        try { logger.warn('pumpswap.price.validation.error', { error: String(e?.message || e), cat: 'pumpswap' }); } catch {}
      }
      
      const prev = pumpswapCache.data;
      pumpswapCache.data = norm; pumpswapCache.ts = Date.now();
      poolsMetrics.pumpswap.fetches += 1;
      poolsMetrics.pumpswap.lastMs = Date.now();
      poolsMetrics.pumpswap.lastAmm = norm.amm.length;
      try { logger.info('pumpswap.fetch normalized', { amm: norm.amm.length, ms: Date.now() - t0, cat: 'pumpswap' }); } catch {}
      try { emit('log', { level: 'info', message: `arb:pools pumpswap.fetch ok amm=${norm.amm.length}`, timestamp: new Date().toISOString(), context: { cat: 'arb' } }); } catch {}
      try {
        const d = diffNormalizedPools(prev || { amm: [], clmm: [] }, norm);
        const sample = { amm: d.amm.slice(0, 100), clmm: [] };
        emit('pools-update', { source: 'pumpswap', amm: norm.amm.length, clmm: 0, ts: Date.now() });
        emit('pool-updates', { source: 'pumpswap', updatedAmm: d.amm.length, updatedClmm: d.clmm.length, addedAmm: d.addedAmm, removedAmm: d.removedAmm, addedClmm: d.addedClmm, removedClmm: d.removedClmm, sample, ts: Date.now() });
        const hasDelta = d.amm.length || d.clmm.length || d.addedAmm || d.removedAmm || d.addedClmm || d.removedClmm;
        try {
          const gmod: any = await import('./graph.js');
          if (hasDelta && typeof gmod.applyPoolUpdates === 'function') {
            // Fire-and-forget: don't await to avoid blocking HTTP fetchers
            void gmod.applyPoolUpdates(prev || { amm: [], clmm: [] }, norm, { pushToArb: true }).catch((err: any) => {
              try { logger.warn('graph.update.fire_forget_failed', { error: String(err?.message || err), source: 'pumpswap', cat: 'graph' }); } catch {}
            });
          }
        } catch {}
      } catch {}
      return pumpswapCache.data!;
    } finally {
      pumpswapCache.inflight = undefined;
    }
  })();
  return pumpswapCache.inflight;
}

export async function getRaydiumPoolsNormalized(force = false, opts?: { skipUniverseFilter?: boolean }): Promise<PoolsPayload> {
  const ttlMs = Number(CONFIG.raydium?.cacheTtlMs || 300_000);
  const minForceGap = Math.max(1000, Number((CONFIG.system as any)?.poolRefreshMinGapMs || 3000));
  (getRaydiumPoolsNormalized as any).__lastForceAt = (getRaydiumPoolsNormalized as any).__lastForceAt || 0;
  const now = Date.now();
  // Capture opts for use in closure
  const skipUniverseFilter = opts?.skipUniverseFilter === true;
  // In non-forced mode, never initiate a fetch. Only return cached data (even if stale) or empty.
  if (!force) {
    if (raydiumCache.data && now - raydiumCache.ts < ttlMs) return raydiumCache.data;
    return raydiumCache.data || { amm: [], clmm: [] };
  }
  if (force) {
    const last = (getRaydiumPoolsNormalized as any).__lastForceAt as number;
    if (now - last < minForceGap && raydiumCache.data) return raydiumCache.data;
    (getRaydiumPoolsNormalized as any).__lastForceAt = now;
  }
  if (raydiumCache.inflight) return raydiumCache.inflight;

  raydiumCache.inflight = (async () => {
    try {
      const t0 = Date.now();
      const mode = 'api';
      logger.info('raydium.fetch start', {
        mode,
        ttlMs,
        concurrency: Number(CONFIG.raydium?.sdkConcurrency || 8),
        uniMode: (CONFIG.system as any)?.tokenUniverseMode || 'jupiter',
        anchorBridging: !!((CONFIG.system as any)?.enableAnchorBridging),
        includeAnchors: (CONFIG.system as any)?.includeAnchorsInUniverse !== false,
        canonicalizePairs: (CONFIG.system as any)?.canonicalizePairs || 'none',
        cat: 'raydium'
      });
        try { emit('log', { level: 'info', message: `arb:pools raydium.fetch start mode=${mode}`, timestamp: new Date().toISOString(), context: { cat: 'arb' } }); } catch {}

      const raw: any = await fetchRaydiumPoolsRawImpl();
      let norm = await normalizeRaydiumPoolsImpl(raw);
      
      // Populate execution cache with enriched pool data (including market accounts)
      // This ensures instruction builders have access to all required Serum market accounts
      try {
        const { executionCache } = await import('../execution/cache.js');
        
        // Populate AMM pools with market accounts
        for (const pool of norm.amm || []) {
          const existing = executionCache.getStatic(pool.id) || {} as any;
          const staticData: any = {
            ...existing,
            programId: pool.dex === 'Raydium' ? '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8' : (existing.programId || ''),
          };
          
          // CRITICAL: Store pool mints and decimals (required for correct Serum market orientation)
          // The pool's mint_a/mint_b must match the Serum market's base/quote orientation
          if (pool.mint_a) staticData.mint_a = pool.mint_a;
          if (pool.mint_b) staticData.mint_b = pool.mint_b;
          if (pool.decimals_a != null) staticData.decimals_a = pool.decimals_a;
          if (pool.decimals_b != null) staticData.decimals_b = pool.decimals_b;
          
          // Add market accounts for Raydium AMM pools (required for swap execution)
          if (pool.market_id) staticData.market_id = pool.market_id;
          if (pool.market_program_id) staticData.market_program_id = pool.market_program_id;
          if (pool.market_bids) staticData.market_bids = pool.market_bids;
          if (pool.market_asks) staticData.market_asks = pool.market_asks;
          if (pool.market_event_queue) staticData.market_event_queue = pool.market_event_queue;
          if (pool.market_base_vault) staticData.market_base_vault = pool.market_base_vault;
          if (pool.market_quote_vault) staticData.market_quote_vault = pool.market_quote_vault;
          if (pool.market_authority) staticData.market_authority = pool.market_authority;
          if (pool.amm_authority) staticData.amm_authority = pool.amm_authority;
          if (pool.amm_open_orders) staticData.amm_open_orders = pool.amm_open_orders;
          if (pool.amm_target_orders) staticData.amm_target_orders = pool.amm_target_orders;
          if (pool.lp_mint) staticData.lp_mint = pool.lp_mint;
          
          executionCache.setStatic(pool.id, staticData);
        }
        
        // Populate CLMM pools with execution-critical accounts
        for (const pool of norm.clmm || []) {
          const existing = executionCache.getStatic(pool.id) || {} as any;
          const staticData: any = {
            ...existing,
            programId: 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
            dex: 'Raydium',
          };
          
          // Store pool mints and decimals
          if (pool.mint_a) staticData.mint_a = pool.mint_a;
          if (pool.mint_b) staticData.mint_b = pool.mint_b;
          if (pool.decimals_a != null) staticData.decimals_a = pool.decimals_a;
          if (pool.decimals_b != null) staticData.decimals_b = pool.decimals_b;
          
          // Store execution-critical accounts (observation_state, ex_bitmap)
          if (pool.observation_state) staticData.observation_state = pool.observation_state;
          if (pool.ex_bitmap) staticData.ex_bitmap = pool.ex_bitmap;
          
          // Store vault/account references
          if (pool.account_a) staticData.account_a = pool.account_a;
          if (pool.account_b) staticData.account_b = pool.account_b;
          
          // Store tick spacing
          if (pool.tick_spacing) staticData.tick_spacing = pool.tick_spacing;
          
          executionCache.setStatic(pool.id, staticData);
        }
        
        // Log successful cache population for our target pool
        try {
          const targetPool = norm.amm?.find((p: any) => p.id === '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2');
          if (targetPool) {
            logger.info('raydium.execution_cache.target_pool_populated', {
              cat: 'pools',
              ctx: {
                poolId: targetPool.id,
                hasMarketId: !!targetPool.market_id,
                hasMarketBids: !!targetPool.market_bids,
                hasMarketAsks: !!targetPool.market_asks,
                hasAmmAuthority: !!targetPool.amm_authority
              }
            });
          }
        } catch {}
        
        logger.info('raydium.execution_cache.populated', {
          cat: 'pools',
          ctx: { 
            ammCount: norm.amm?.length || 0, 
            clmmCount: norm.clmm?.length || 0,
            clmmWithExBitmap: (norm.clmm || []).filter((p: any) => p.ex_bitmap).length,
            clmmWithObservationState: (norm.clmm || []).filter((p: any) => p.observation_state).length,
          }
        });
      } catch (err) {
        logger.warn('raydium.execution_cache.populate.failed', {
          cat: 'pools',
          ctx: { error: String((err as any)?.message || err) }
        });
      }
      
      // Apply universe filtering early so caches are consistent across sources
      try {
        if (!skipUniverseFilter) {
          const { computeTokenUniverse, filterPoolsByUniverse } = await import('./universe.js');
          const mode: any = (CONFIG.system as any)?.tokenUniverseMode || 'jupiter';
          const uni = await computeTokenUniverse(mode);
          const beforeAmm = norm.amm.length, beforeClmm = norm.clmm.length;
          const scoped = filterPoolsByUniverse(norm as any, uni, !!((CONFIG.system as any)?.enableAnchorBridging));
          if (scoped.amm.length !== beforeAmm || scoped.clmm.length !== beforeClmm) {
            poolsMetrics.raydium.filteredAmm += (beforeAmm - scoped.amm.length);
            poolsMetrics.raydium.filteredClmm += (beforeClmm - scoped.clmm.length);
            poolsMetrics.raydium.universe = String(mode);
            try { logger.info('raydium.universe.filter', { mode, beforeAmm, beforeClmm, afterAmm: scoped.amm.length, afterClmm: scoped.clmm.length }); } catch {}
          }
          norm = scoped as any;
        }
      } catch {}

      // Apply token blocklist (exclude pools containing any blocked mint)
      try {
        const blist = new Set<string>(Array.isArray((CONFIG.system as any)?.tokenBlocklistMints) ? (CONFIG.system as any).tokenBlocklistMints : []);
        if (blist.size > 0) {
          const beforeAmm = norm.amm.length, beforeClmm = norm.clmm.length;
          const filtered = applyTokenMintBlocklist(norm as any, blist);
          if (filtered.amm.length !== beforeAmm || filtered.clmm.length !== beforeClmm) {
            try { logger.info('raydium.blocklist.filter', { beforeAmm, beforeClmm, afterAmm: filtered.amm.length, afterClmm: filtered.clmm.length }); } catch {}
          }
          norm = filtered as any;
        }
      } catch {}

      // Optional: TVL-based filtering to drop dust pools (config-driven)
      try {
        const globalAmm = Number(((CONFIG.system as any)?.minAmmLiqBase) ?? 0);
        const globalClmm = Number(((CONFIG.system as any)?.minClmmLiquidity) ?? 0);
        const minAmmUsd = Math.max(globalAmm, Number((CONFIG.raydium as any)?.minAmmLiqBase || 0));
        const minClmmUsd = Math.max(globalClmm, Number((CONFIG.raydium as any)?.minClmmLiquidity || 0));
        if (minAmmUsd > 0 || minClmmUsd > 0) {
          const beforeAmm = norm.amm.length, beforeClmm = norm.clmm.length;
          const amm = minAmmUsd > 0 ? norm.amm.filter(p => Number((p as any).tvl_usd || 0) >= minAmmUsd) : norm.amm;
          const clmm = minClmmUsd > 0 ? norm.clmm.filter(p => Number((p as any).tvl_usd || 0) >= minClmmUsd) : norm.clmm;
          if (amm.length !== beforeAmm || clmm.length !== beforeClmm) { logger.info('raydium.filter tvl', { minAmmUsd, minClmmUsd, beforeAmm, beforeClmm, afterAmm: amm.length, afterClmm: clmm.length }); }
          norm = { amm, clmm } as any;
        }
      } catch {}

      poolsMetrics.raydium.fetches += 1;
      poolsMetrics.raydium.lastMs = Date.now();
      poolsMetrics.raydium.lastAmm = norm.amm.length;
      poolsMetrics.raydium.lastClmm = norm.clmm.length;
      logger.info('raydium.fetch normalized', { amm: norm.amm.length, clmm: norm.clmm.length, ms: Date.now() - t0, cat: 'raydium', canon: (CONFIG.system as any)?.canonicalizePairs || 'none' });
      try { emit('log', { level: 'info', message: `arb:pools raydium.fetch ok amm=${norm.amm.length} clmm=${norm.clmm.length}`, timestamp: new Date().toISOString(), context: { cat: 'arb' } }); } catch {}

      const prev = raydiumCache.data;
      raydiumCache.data = norm;
      raydiumCache.ts = Date.now();

      // Emit socket event when normalized cache changes
      try {
        const prevAmm = prev?.amm?.length || 0;
        const prevClmm = prev?.clmm?.length || 0;
        const nextAmm = norm.amm.length;
        const nextClmm = norm.clmm.length;
        const changed = !prev || prevAmm !== nextAmm || prevClmm !== nextClmm;
        if (changed) {
          emit('pools-update', { source: 'raydium', amm: nextAmm, clmm: nextClmm, ts: Date.now() });
          emit('log', { level: 'info', message: `pools:update source=raydium amm=${nextAmm} clmm=${nextClmm}`, timestamp: new Date().toISOString(), context: { cat: 'pools' } });
        }
      } catch {}
      // Emit fine-grained pool-updates (deltas) and prefer incremental graph apply when enabled
      try {
        const d = diffNormalizedPools(prev || { amm: [], clmm: [] }, norm);
        const sample = { amm: d.amm.slice(0, 100), clmm: d.clmm.slice(0, 100) };
        emit('pool-updates', { source: 'raydium', updatedAmm: d.amm.length, updatedClmm: d.clmm.length, addedAmm: d.addedAmm, removedAmm: d.removedAmm, addedClmm: d.addedClmm, removedClmm: d.removedClmm, sample, ts: Date.now(), canon: (CONFIG.system as any)?.canonicalizePairs || 'none' });
        const hasDelta = d.amm.length || d.clmm.length || d.addedAmm || d.removedAmm || d.addedClmm || d.removedClmm;
        try {
          const gmod: any = await import('./graph.js');
          if (hasDelta && typeof gmod.applyPoolUpdates === 'function') {
            // Fire-and-forget: don't await to avoid blocking HTTP fetchers
            void gmod.applyPoolUpdates(prev || { amm: [], clmm: [] }, norm, { pushToArb: true }).catch((err: any) => {
              try { logger.warn('graph.update.fire_forget_failed', { error: String(err?.message || err), source: 'raydium', cat: 'graph' }); } catch {}
            });
          }
        } catch {}
        try { logger.info('pools.delta raydium', { updatedAmm: d.amm.length, updatedClmm: d.clmm.length, addedAmm: d.addedAmm, removedAmm: d.removedAmm, addedClmm: d.addedClmm, removedClmm: d.removedClmm, cat: 'pools' }); } catch {}
      } catch {}
      // Cross-DEX validation: Compare prices across all DEXes
      try {
        const allPools = {
          raydium: raydiumCache.data || { amm: [], clmm: [] },
          orca: orcaCache.data || { amm: [], clmm: [] },
          meteora: meteoraCache.data || { amm: [], clmm: [] },
          pumpswap: pumpswapCache.data || { amm: [], clmm: [] }
        };
        validateCrossDexPrices(allPools);
      } catch {}
      // Opportunistic price warmup (anchors + top-N pool mints) after first source completes
      try {
        const sys: any = (CONFIG as any)?.system || {};
        const enable = sys.warmPricesOnStart !== false;
        if (enable && !(refreshAllSources as any).__didWarmPricesOnce) {
          const topN = Math.max(10, Number(sys.priceWarmTopN || 200));
          const collect = (pp: { amm: any[]; clmm: any[] }) => {
            const arr = [...(pp.amm || []), ...(pp.clmm || [])];
            return arr.map(p => ({
              mints: [String(p.mint_a || ''), String(p.mint_b || '')],
              tvl: Number((p as any)?.tvl_usd ?? (p as any)?.liquidity_display ?? 0)
            }));
          };
          const items = [
            ...collect(raydiumCache.data || { amm: [], clmm: [] }),
            ...collect(orcaCache.data || { amm: [], clmm: [] }),
            ...collect(meteoraCache.data || { amm: [], clmm: [] }),
            ...collect(metbalCache.data || { amm: [], clmm: [] }),
          ];
          const ranked = items.sort((a,b) => (b.tvl || 0) - (a.tvl || 0)).slice(0, topN);
          const set = new Set<string>();
          for (const it of ranked) { for (const m of (it.mints || [])) if (m) set.add(m); }
          // Always include anchors
          set.add('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
          set.add('So11111111111111111111111111111111111111112');
          const ids = Array.from(set);
          if (ids.length) {
            const { fetchPricesByMints } = await import('../jupiter/jupiter.js');
            const fresh = await fetchPricesByMints(ids, { catOverride: 'priceWarm', ignorePause: true });
            const priceStore = await import('./priceStore.js');
            priceStore.setPrices(fresh as any);
            (refreshAllSources as any).__didWarmPricesOnce = true;
          }
        }
      } catch {}
      // Graph rebuilds now orchestrated by refresh endpoint; avoid redundant triggers here

      return norm;
    } finally {
      raydiumCache.inflight = undefined;
    }
  })();

  return raydiumCache.inflight;
}

export async function getOrcaPoolsCached(force = false, opts?: { skipUniverseFilter?: boolean }): Promise<PoolsPayload> {
  const ttlMs = CONFIG.orca?.cacheTtlMs ?? 300_000; // 5 minutes default
  const minForceGap = Math.max(1000, Number((CONFIG.system as any)?.poolRefreshMinGapMs || 3000));
  (getOrcaPoolsCached as any).__lastForceAt = (getOrcaPoolsCached as any).__lastForceAt || 0;
  const now = Date.now();
  // In non-forced mode, never initiate a fetch. Only return cached data (even if stale) or empty.
  if (!force) {
    if (orcaCache.data && now - orcaCache.ts < ttlMs) return orcaCache.data;
    return orcaCache.data || { amm: [], clmm: [] };
  }
  // Debounce forced refreshes
  if (force) {
    const last = (getOrcaPoolsCached as any).__lastForceAt as number;
    if (now - last < minForceGap && orcaCache.data) return orcaCache.data as any;
    (getOrcaPoolsCached as any).__lastForceAt = now;
  }
  if (orcaCache.inflight) return orcaCache.inflight;
  orcaCache.inflight = (async () => {
    try {
      const t0 = Date.now();
      const data = await getOrcaPoolsNormalized(opts);
      const prev = orcaCache.data;
      orcaCache.data = data;
      orcaCache.ts = Date.now();
      poolsMetrics.orca.fetches += 1;
      poolsMetrics.orca.lastMs = Date.now();
      poolsMetrics.orca.lastAmm = (data.amm || []).length;
      poolsMetrics.orca.lastClmm = (data.clmm || []).length;
      // Emit socket event when normalized cache changes
      try {
        const prevAmm = prev?.amm?.length || 0;
        const prevClmm = prev?.clmm?.length || 0;
        const nextAmm = (data.amm || []).length;
        const nextClmm = (data.clmm || []).length;
        const changed = !prev || prevAmm !== nextAmm || prevClmm !== nextClmm;
        if (changed) {
          emit('pools-update', { source: 'orca', amm: nextAmm, clmm: nextClmm, ts: Date.now() });
          emit('log', { level: 'info', message: `pools:update source=orca amm=${nextAmm} clmm=${nextClmm}`, timestamp: new Date().toISOString(), context: { cat: 'pools' } });
        }
      } catch {}
      // Emit fine-grained pool-updates (deltas) and prefer incremental graph apply when enabled
      try {
        const d = diffNormalizedPools(prev || { amm: [], clmm: [] }, data);
        const sample = { amm: d.amm.slice(0, 100), clmm: d.clmm.slice(0, 100) };
        emit('pool-updates', { source: 'orca', updatedAmm: d.amm.length, updatedClmm: d.clmm.length, addedAmm: d.addedAmm, removedAmm: d.removedAmm, addedClmm: d.addedClmm, removedClmm: d.removedClmm, sample, ts: Date.now(), canon: (CONFIG.system as any)?.canonicalizePairs || 'none' });
        try { logger.debug('pools.delta orca', { updatedAmm: d.amm.length, updatedClmm: d.clmm.length, addedAmm: d.addedAmm, removedAmm: d.removedAmm, addedClmm: d.addedClmm, removedClmm: d.removedClmm, cat: 'pools' }); } catch {}
        const hasDelta = d.amm.length || d.clmm.length || d.addedAmm || d.removedAmm || d.addedClmm || d.removedClmm;
        try {
          const gmod: any = await import('./graph.js');
          if (hasDelta && typeof gmod.applyPoolUpdates === 'function') {
            // Fire-and-forget: don't await to avoid blocking HTTP fetchers
            void gmod.applyPoolUpdates(prev || { amm: [], clmm: [] }, data, { pushToArb: true }).catch((err: any) => {
              try { logger.warn('graph.update.fire_forget_failed', { error: String(err?.message || err), source: 'orca', cat: 'graph' }); } catch {}
            });
          }
        } catch {}
      } catch {}
      // Graph rebuilds now orchestrated by refresh endpoint; avoid redundant triggers here
      return data;
    } finally {
      orcaCache.inflight = undefined;
    }
  })();
  return orcaCache.inflight;
}

export async function getOrcaPoolsNormalized(opts?: { skipUniverseFilter?: boolean }): Promise<PoolsPayload> {
  logger.info('orca.fetch start', {
    mode: 'http',
    uniMode: (CONFIG.system as any)?.tokenUniverseMode || 'jupiter',
    anchorBridging: !!((CONFIG.system as any)?.enableAnchorBridging),
    includeAnchors: (CONFIG.system as any)?.includeAnchorsInUniverse !== false,
    canonicalizePairs: (CONFIG.system as any)?.canonicalizePairs || 'none',
  });
  // Try configured mode, then fallbacks to maximize robustness
  const tried: string[] = [];
    try {
    const raw = await fetchOrcaHttpImpl();
    let norm = await normalizeOrcaHttpImpl(raw);
        // Apply token blocklist (exclude pools containing any blocked mint)
        try {
          const blist = new Set<string>(Array.isArray((CONFIG.system as any)?.tokenBlocklistMints) ? (CONFIG.system as any).tokenBlocklistMints : []);
          if (blist.size > 0) {
            const beforeAmm = (norm.amm || []).length, beforeClmm = (norm.clmm || []).length;
            const filtered = applyTokenMintBlocklist(norm as any, blist);
            if (filtered.amm.length !== beforeAmm || filtered.clmm.length !== beforeClmm) {
              try { logger.info('orca.blocklist.filter', { beforeAmm, beforeClmm, afterAmm: filtered.amm.length, afterClmm: filtered.clmm.length }); } catch {}
            }
            norm = filtered as any;
          }
        } catch {        }
        // Apply universe filtering early so caches are consistent across sources
        try {
          const skipUniverseFilter = opts?.skipUniverseFilter === true;
          if (!skipUniverseFilter) {
            const uniModeAny: any = (CONFIG.system as any)?.tokenUniverseMode || 'jupiter';
            const isTest = String(((globalThis as any)?.process?.env?.NODE_ENV) || '') === 'test';
            const isVitest = !!((globalThis as any)?.vi || (globalThis as any)?.vitest || (String(((globalThis as any)?.process?.env?.VITEST) || '') === 'true'));
            const skipUniverseMode = isTest || isVitest || String(uniModeAny) === 'none';
            if (!skipUniverseMode) {
              const { computeTokenUniverse, filterPoolsByUniverse } = await import('./universe.js');
              const uni = await computeTokenUniverse(uniModeAny);
              const beforeAmm = norm.amm.length, beforeClmm = norm.clmm.length;
              const scoped = filterPoolsByUniverse(norm as any, uni, !!((CONFIG.system as any)?.enableAnchorBridging));
              if (scoped.amm.length !== beforeAmm || scoped.clmm.length !== beforeClmm) {
                poolsMetrics.orca.lastAmm = scoped.amm.length;
                poolsMetrics.orca.lastClmm = scoped.clmm.length;
                try { logger.info('orca.universe.filter', { mode: uniModeAny, beforeAmm, beforeClmm, afterAmm: scoped.amm.length, afterClmm: scoped.clmm.length }); } catch {}
              }
              norm = scoped as any;
            } else {
              try { logger.info('orca.universe.filter skip', { reason: isTest ? 'test' : 'mode:none' }); } catch {}
            }
          }
        } catch {}
        // Defer TVL filtering to graph-level to avoid early pruning across sources
  
  // Populate execution cache with Orca Whirlpool pool data
  try {
    const { executionCache } = await import('../execution/cache.js');
    for (const pool of norm.clmm || []) {
      const existing = executionCache.getStatic(pool.id) || {} as any;
      const staticData: any = {
        ...existing,
        programId: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
        dex: 'Orca',
      };
      
      // Store pool mints and decimals
      if (pool.mint_a) staticData.mint_a = pool.mint_a;
      if (pool.mint_b) staticData.mint_b = pool.mint_b;
      if (pool.decimals_a != null) staticData.decimals_a = pool.decimals_a;
      if (pool.decimals_b != null) staticData.decimals_b = pool.decimals_b;
      
      // Store execution-critical accounts (oracle, vaults)
      if (pool.oracle) staticData.oracle = pool.oracle;
      if (pool.token_vault_a) staticData.token_vault_a = pool.token_vault_a;
      if (pool.token_vault_b) staticData.token_vault_b = pool.token_vault_b;
      
      // Store vault/account references
      if (pool.account_a) staticData.account_a = pool.account_a;
      if (pool.account_b) staticData.account_b = pool.account_b;
      
      // Store tick spacing
      if (pool.tick_spacing) staticData.tick_spacing = pool.tick_spacing;
      
      executionCache.setStatic(pool.id, staticData);
    }
    
    try {
      logger.info('orca.execution_cache.populated', {
        cat: 'pools',
        ctx: {
          poolCount: (norm.clmm || []).length,
          withOracle: (norm.clmm || []).filter((p: any) => p.oracle).length,
          withVaults: (norm.clmm || []).filter((p: any) => p.token_vault_a && p.token_vault_b).length,
        }
      });
    } catch {}
  } catch (e: any) {
    try {
      logger.warn('orca.execution_cache.population.failed', {
        cat: 'pools',
        ctx: { error: String(e?.message || e) }
      });
    } catch {}
  }
  
  logger.info('orca.http normalized', { clmm: norm.clmm.length, canon: (CONFIG.system as any)?.canonicalizePairs || 'none' });
        return norm;
    } catch (e: any) {
    tried.push(`http:${String(e?.message || e)}`);
    logger.warn('orca.http failed', { tried });
  return { amm: [], clmm: [] };
  }
}

export async function getMeteoraPoolsCached(force = false, opts?: { skipUniverseFilter?: boolean }): Promise<PoolsPayload> {
  const ttlMs = Number(((CONFIG as any)?.meteora?.cacheTtlMs) || 300_000);
  const minForceGap = Math.max(1000, Number((CONFIG.system as any)?.poolRefreshMinGapMs || 3000));
  (getMeteoraPoolsCached as any).__lastForceAt = (getMeteoraPoolsCached as any).__lastForceAt || 0;
  const now = Date.now();
  // Capture opts for use in closure
  const skipUniverseFilter = opts?.skipUniverseFilter === true;
  if (!force) {
    if (meteoraCache.data && now - meteoraCache.ts < ttlMs) return meteoraCache.data;
    return meteoraCache.data || { amm: [], clmm: [] };
  }
  if (force) {
    const last = (getMeteoraPoolsCached as any).__lastForceAt as number;
    if (now - last < minForceGap && meteoraCache.data) return meteoraCache.data as any;
    (getMeteoraPoolsCached as any).__lastForceAt = now;
  }
  if (meteoraCache.inflight) return meteoraCache.inflight;
  meteoraCache.inflight = (async () => {
    try {
      const mode = 'http';
      try { logger.info('meteora.fetch start', { mode, ttlMs, uniMode: (CONFIG.system as any)?.tokenUniverseMode || 'jupiter', anchorBridging: !!((CONFIG.system as any)?.enableAnchorBridging), includeAnchors: (CONFIG.system as any)?.includeAnchorsInUniverse !== false, canonicalizePairs: (CONFIG.system as any)?.canonicalizePairs || 'none', cat: 'meteora' }); } catch {}
      try { emit('log', { level: 'info', message: `arb:pools meteora.fetch start mode=${mode}`, timestamp: new Date().toISOString(), context: { cat: 'arb' } }); } catch {}
      const t0 = Date.now();
      const raw = await fetchMeteoraHttpImpl();
      let norm = await normalizeMeteoraHttpImpl(raw);
      // Apply token blocklist (exclude pools containing any blocked mint)
      try {
        const blist = new Set<string>(Array.isArray((CONFIG.system as any)?.tokenBlocklistMints) ? (CONFIG.system as any).tokenBlocklistMints : []);
        if (blist.size > 0) {
          const beforeClmm = (norm.clmm || []).length;
          const filtered = applyTokenMintBlocklist(norm as any, blist);
          if ((filtered.clmm || []).length !== beforeClmm) {
            try { logger.info('meteora.blocklist.filter', { beforeClmm, afterClmm: filtered.clmm.length }); } catch {}
          }
          norm = filtered as any;
        }
      } catch {}
      // Optionally apply universe filtering early (disabled by default for Meteora)
      try {
        if (!skipUniverseFilter) {
          const prefilter = !!((CONFIG as any)?.meteora?.universePrefilter);
          if (prefilter) {
            const { computeTokenUniverse, filterPoolsByUniverse } = await import('./universe.js');
            const mode: any = (CONFIG.system as any)?.tokenUniverseMode || 'jupiter';
            const uni = await computeTokenUniverse(mode);
            const beforeClmm = norm.clmm.length;
            const scoped = filterPoolsByUniverse(norm as any, uni, !!((CONFIG.system as any)?.enableAnchorBridging));
            if (scoped.clmm.length !== beforeClmm) { try { logger.info('meteora.universe.filter', { mode, beforeClmm, afterClmm: scoped.clmm.length }); } catch {} }
            norm = { amm: [], clmm: scoped.clmm } as any;
          }
        }
      } catch {}
       // TVL filter (apply global thresholds on top of per-source)
      // Defer TVL filtering to graph-level to avoid early pruning across sources
      const prev = meteoraCache.data;
      meteoraCache.data = norm; meteoraCache.ts = Date.now();
      
      // Populate execution cache with Meteora DLMM pool data
      // This ensures instruction builders have access to execution-critical accounts
      try {
        const { executionCache } = await import('../execution/cache.js');
        for (const pool of norm.clmm || []) {
          const existing = executionCache.getStatic(pool.id) || {} as any;
          const staticData: any = {
            ...existing,
            programId: 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',
            dex: 'Meteora',
          };
          
          // Store pool mints and decimals
          if (pool.mint_a) staticData.mint_a = pool.mint_a;
          if (pool.mint_b) staticData.mint_b = pool.mint_b;
          if (pool.decimals_a != null) staticData.decimals_a = pool.decimals_a;
          if (pool.decimals_b != null) staticData.decimals_b = pool.decimals_b;
          
          // Store execution-critical accounts (bin_array_bitmap_extension)
          if (pool.bin_array_bitmap_extension) {
            staticData.bin_array_bitmap_extension = pool.bin_array_bitmap_extension;
          }
          
          // Store vault/reserve accounts
          if (pool.account_a) staticData.account_a = pool.account_a;
          if (pool.account_b) staticData.account_b = pool.account_b;
          
          // Store tick spacing (bin_step for Meteora)
          if (pool.tick_spacing) staticData.tick_spacing = pool.tick_spacing;
          
          executionCache.setStatic(pool.id, staticData);
        }
        
        try {
          logger.info('meteora.execution_cache.populated', {
            cat: 'pools',
            ctx: {
              poolCount: (norm.clmm || []).length,
              withBitmapExt: (norm.clmm || []).filter((p: any) => p.bin_array_bitmap_extension).length,
            }
          });
        } catch {}
      } catch (e: any) {
        try {
          logger.warn('meteora.execution_cache.population.failed', {
            cat: 'pools',
            ctx: { error: String(e?.message || e) }
          });
        } catch {}
      }
      
      poolsMetrics.meteora.fetches += 1;
      poolsMetrics.meteora.lastMs = Date.now();
      poolsMetrics.meteora.lastClmm = norm.clmm.length;
      try { logger.info('meteora.fetch normalized', { clmm: norm.clmm.length, ms: Date.now() - t0, cat: 'meteora' }); } catch {}
      try { emit('log', { level: 'info', message: `arb:pools meteora.fetch ok clmm=${norm.clmm.length}`, timestamp: new Date().toISOString(), context: { cat: 'arb' } }); } catch {}
      try {
        const d = diffNormalizedPools(prev || { amm: [], clmm: [] }, norm);
        const sample = { amm: [], clmm: d.clmm.slice(0, 100) };
        emit('pools-update', { source: 'meteora', amm: 0, clmm: norm.clmm.length, ts: Date.now() });
        emit('pool-updates', { source: 'meteora', updatedAmm: d.amm.length, updatedClmm: d.clmm.length, addedAmm: d.addedAmm, removedAmm: d.removedAmm, addedClmm: d.addedClmm, removedClmm: d.removedClmm, sample, ts: Date.now() });
        const hasDelta = d.amm.length || d.clmm.length || d.addedAmm || d.removedAmm || d.addedClmm || d.removedClmm;
        try {
          const gmod: any = await import('./graph.js');
          if (hasDelta && typeof gmod.applyPoolUpdates === 'function') {
            // Fire-and-forget: don't await to avoid blocking HTTP fetchers
            void gmod.applyPoolUpdates(prev || { amm: [], clmm: [] }, norm, { pushToArb: true }).catch((err: any) => {
              try { logger.warn('graph.update.fire_forget_failed', { error: String(err?.message || err), source: 'meteora', cat: 'graph' }); } catch {}
            });
          }
        } catch {}
      } catch {}
      // Graph rebuilds now orchestrated by refresh endpoint; avoid redundant triggers here
      return meteoraCache.data!;
    } finally {
      meteoraCache.inflight = undefined;
    }
  })();
  return meteoraCache.inflight;
}

// Orca HTTP fetcher provided in ./pools/orca.ts

// Orca normalization and fetch helpers are provided in ./pools/orca.ts
 

const meteoraProgram = createProgram(await import('@solana/web3.js').then(m => m.Connection).then(() => undefined));

// Add this export function near the other exports (around line 2928)
export function isMeteoraBinArraySubscribed(accountAddress: string): boolean {
  return meteoraBinAccountToPool.has(accountAddress);
}


