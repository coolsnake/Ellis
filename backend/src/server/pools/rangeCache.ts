/**
 * Range cache for CLMM tick boundaries and DLMM active bin reserves.
 *
 * Provides accurate reserve estimates for slippage simulation by lazily
 * fetching tick/bin array account data on first sight and boundary crossings.
 *
 * Integration flow:
 *   1. WS decoders call scheduleRangeFetch() after successful decode
 *   2. scheduleRangeFetch() fires a non-blocking async RPC fetch
 *   3. edgesFromPoolIncremental() calls getRangeData() synchronously
 *   4. On cache miss, the caller falls through to existing heuristic (no blocking)
 */

import { PublicKey } from '@solana/web3.js';
import { logger } from '../../utils/logger.js';
import { logCatchDebug } from '../../utils/errorHandler.js';

// ────────────────────── Types ──────────────────────

export interface ClmmRangeData {
  kind: 'clmm';
  /** sqrt(price) at nearest initialized tick below current (float, NOT Q64) */
  sqrtPriceLower: number;
  /** sqrt(price) at nearest initialized tick above current (float, NOT Q64) */
  sqrtPriceUpper: number;
  tickLower: number;
  tickUpper: number;
  /** Tick index when this data was fetched */
  currentTick: number;
  /** Active liquidity (L) at the current tick range */
  currentLiquidity: number;
  fetchedAt: number;
  /** All initialized ticks from the fetched arrays, sorted ascending by index.
   *  liquidityNet is the signed delta applied when crossing into this tick. */
  ticks: { index: number; liquidityNet: number }[];
}

export interface DlmmRangeData {
  kind: 'dlmm';
  activeBinId: number;
  /** Active bin reserve of token X in whole tokens (native order) */
  reserveX: number;
  /** Active bin reserve of token Y in whole tokens (native order) */
  reserveY: number;
  fetchedAt: number;
  /** All non-empty bins from the fetched arrays, sorted ascending by bin ID.
   *  Reserves are in whole tokens (native order, scaled by decimals). */
  bins: { id: number; reserveX: number; reserveY: number }[];
}

export type RangeData = ClmmRangeData | DlmmRangeData;

export interface RangeFetchOpts {
  poolId: string;
  poolKind: 'clmm' | 'dlmm';
  dex: string;
  currentTick?: number;
  tickSpacing?: number;
  activeId?: number;
  decimalsX?: number;
  decimalsY?: number;
  /** PDA address of the center tick array (CLMM) */
  tickArrayCenter?: string;
  /** PDA address of the lower tick array (CLMM) — fetched alongside center for wider coverage */
  tickArrayLower?: string;
  /** PDA address of the upper tick array (CLMM) — fetched alongside center for wider coverage */
  tickArrayUpper?: string;
  /** PDA address of the active bin array (DLMM) */
  binArrayActive?: string;
  /** Raw liquidity (bigint-ish string or number) at the current tick, used to populate currentLiquidity */
  liquidityRaw?: string | number;
}

// ──────────────────── Constants ────────────────────

/** Orca Whirlpool tick array: 88 ticks per array */
const ORCA_TICKS_PER_ARRAY = 88;
/** Orca tick struct size (packed): bool(1) + i128(16) + u128(16)*2 + u128x3(48) = 113 */
const ORCA_TICK_SIZE = 113;
/** Orca tick array header: discriminator(8) + startTickIndex(i32, 4) */
const ORCA_HEADER_SIZE = 12;

/** Raydium CLMM tick array: 60 ticks per array */
const RAYDIUM_TICKS_PER_ARRAY = 60;
/** Raydium tick struct size (packed): i32(4) + i128(16) + u128(16)*2 + u128x3(48) + u32x13(52) = 168 */
const RAYDIUM_TICK_SIZE = 168;
/** Raydium tick array header: discriminator(8) + poolId(32) */
const RAYDIUM_HEADER_SIZE = 40;

/** Meteora DLMM: 70 bins per array */
const METEORA_BIN_ARRAY_SIZE = 70;

/** How long cached data is valid (ms) */
const MAX_AGE_MS = 120_000;

// ──────────────────── State ────────────────────

const cache = new Map<string, RangeData>();
const inflight = new Set<string>();

// ────────────────── Public API ──────────────────

/**
 * Get cached range data for a pool.  Returns undefined on miss or stale data.
 * Always synchronous — never blocks.
 */
export function getRangeData(poolId: string): RangeData | undefined {
  const entry = cache.get(poolId);
  if (!entry) return undefined;
  if (Date.now() - entry.fetchedAt > MAX_AGE_MS) return undefined;
  return entry;
}

/** Force-invalidate cached data for a pool. */
export function invalidateRange(poolId: string): void {
  cache.delete(poolId);
}

/**
 * Schedule a non-blocking fetch of tick/bin array data.
 *
 * No-op if:
 * - A fetch is already in flight for this pool
 * - Cached data is fresh AND the tick/activeId hasn't crossed a boundary
 */
export function scheduleRangeFetch(opts: RangeFetchOpts): void {
  const { poolId, currentTick, activeId } = opts;
  if (inflight.has(poolId)) return;

  const existing = cache.get(poolId);
  if (existing && Date.now() - existing.fetchedAt < MAX_AGE_MS) {
    // CLMM: skip if current tick is still within cached boundaries
    if (existing.kind === 'clmm' && currentTick !== undefined) {
      if (currentTick >= existing.tickLower && currentTick < existing.tickUpper) return;
    }
    // DLMM: skip if active bin hasn't changed
    if (existing.kind === 'dlmm' && activeId !== undefined) {
      if (existing.activeBinId === activeId) return;
    }
  }

  inflight.add(poolId);
  fetchAndParse(opts)
    .catch(err => logCatchDebug('rangeCache.fetch', err, { pool: poolId.slice(0, 8) }))
    .finally(() => inflight.delete(poolId));
}

/** Diagnostic counters. */
export function rangeCacheStats(): { size: number; inflight: number } {
  return { size: cache.size, inflight: inflight.size };
}

// ─────────────────── Fetch logic ───────────────────

async function fetchAndParse(opts: RangeFetchOpts): Promise<void> {
  if (opts.poolKind === 'clmm') {
    await fetchClmmRange(opts);
  } else if (opts.poolKind === 'dlmm') {
    await fetchDlmmRange(opts);
  }
}

// ── CLMM ──

async function fetchClmmRange(opts: RangeFetchOpts): Promise<void> {
  const { poolId, dex, currentTick, tickSpacing, tickArrayCenter, tickArrayLower, tickArrayUpper, liquidityRaw } = opts;
  if (
    !tickArrayCenter ||
    !Number.isFinite(currentTick) ||
    !Number.isFinite(tickSpacing) ||
    tickSpacing! <= 0
  ) {
    return;
  }

  try {
    const { getConnection } = await import('../../wallet/wallet.js');
    const conn = getConnection();
    const d = dex.toLowerCase();
    const isOrca = d.includes('orca');

    // Build list of tick array addresses to fetch (center is required, lower/upper optional)
    const addresses: PublicKey[] = [];
    const labels: string[] = [];
    if (tickArrayLower && tickArrayLower !== tickArrayCenter) {
      addresses.push(new PublicKey(tickArrayLower));
      labels.push('lower');
    }
    addresses.push(new PublicKey(tickArrayCenter));
    labels.push('center');
    if (tickArrayUpper && tickArrayUpper !== tickArrayCenter && tickArrayUpper !== tickArrayLower) {
      addresses.push(new PublicKey(tickArrayUpper));
      labels.push('upper');
    }

    // Fetch all arrays in a single RPC call
    const infos = addresses.length === 1
      ? [await conn.getAccountInfo(addresses[0])]
      : await conn.getMultipleAccountsInfo(addresses);

    // Parse all arrays and merge ticks
    let allTicks: { index: number; liquidityNet: number }[] = [];
    let boundsLower = Number.MAX_SAFE_INTEGER;
    let boundsUpper = Number.MIN_SAFE_INTEGER;

    for (let a = 0; a < infos.length; a++) {
      const info = infos[a];
      if (!info?.data) continue;
      const data = Buffer.from(info.data);

      let parsed: ClmmArrayParseResult | null = null;
      if (isOrca) {
        parsed = parseOrcaTickArray(data, currentTick!, tickSpacing!);
      } else {
        parsed = parseRaydiumTickArray(data, currentTick!, tickSpacing!);
      }
      if (!parsed) continue;

      allTicks.push(...parsed.ticks);
      if (parsed.tickLower < boundsLower) boundsLower = parsed.tickLower;
      if (parsed.tickUpper > boundsUpper) boundsUpper = parsed.tickUpper;
    }

    if (allTicks.length === 0 && boundsLower >= boundsUpper) return;

    // Sort and deduplicate ticks by index (ascending)
    allTicks.sort((a, b) => a.index - b.index);
    const deduped: { index: number; liquidityNet: number }[] = [];
    for (const t of allTicks) {
      if (deduped.length === 0 || deduped[deduped.length - 1].index !== t.index) {
        deduped.push(t);
      }
      // If duplicate index, keep the one with larger absolute liquidityNet
      else if (Math.abs(t.liquidityNet) > Math.abs(deduped[deduped.length - 1].liquidityNet)) {
        deduped[deduped.length - 1] = t;
      }
    }

    // Find nearest boundaries around currentTick from the merged tick set
    let nearestLower = boundsLower;
    let nearestUpper = boundsUpper;
    for (const t of deduped) {
      if (t.index <= currentTick!) {
        nearestLower = t.index;
      } else {
        nearestUpper = t.index;
        break;
      }
    }

    const sqrtPriceLower = tickToSqrtPrice(nearestLower);
    const sqrtPriceUpper = tickToSqrtPrice(nearestUpper);

    // Parse current liquidity from raw value
    let currentLiquidity = 0;
    if (liquidityRaw !== undefined && liquidityRaw !== null) {
      try {
        currentLiquidity = Number(BigInt(String(liquidityRaw)));
      } catch {
        currentLiquidity = Number(liquidityRaw) || 0;
      }
    }

    if (sqrtPriceLower > 0 && sqrtPriceUpper > sqrtPriceLower) {
      cache.set(poolId, {
        kind: 'clmm',
        sqrtPriceLower,
        sqrtPriceUpper,
        tickLower: nearestLower,
        tickUpper: nearestUpper,
        currentTick: currentTick!,
        currentLiquidity,
        fetchedAt: Date.now(),
        ticks: deduped,
      });

      logger.debug('rangeCache.clmm.cached', {
        pool: poolId.slice(0, 8),
        dex,
        tickLower: nearestLower,
        tickUpper: nearestUpper,
        currentTick,
        tickCount: deduped.length,
        arrays: labels.join(','),
        cat: 'pools',
      });
    }
  } catch (err) {
    logCatchDebug('rangeCache.clmm', err, { pool: poolId.slice(0, 8) });
  }
}

// ── DLMM ──

async function fetchDlmmRange(opts: RangeFetchOpts): Promise<void> {
  const { poolId, activeId, decimalsX, decimalsY, binArrayActive } = opts;
  if (!binArrayActive || !Number.isFinite(activeId)) return;

  try {
    const { getConnection } = await import('../../wallet/wallet.js');
    const conn = getConnection();
    const pk = new PublicKey(binArrayActive);
    const info = await conn.getAccountInfo(pk);
    if (!info?.data) return;

    const data = Buffer.from(info.data);
    const result = await parseMeteoraBinArray(
      data,
      poolId,
      activeId!,
      decimalsX ?? 9,
      decimalsY ?? 9,
    );
    if (!result) return;

    cache.set(poolId, {
      kind: 'dlmm',
      activeBinId: activeId!,
      reserveX: result.reserveX,
      reserveY: result.reserveY,
      fetchedAt: Date.now(),
      bins: result.bins,
    });

    logger.debug('rangeCache.dlmm.cached', {
      pool: poolId.slice(0, 8),
      activeId,
      reserveX: result.reserveX.toFixed(4),
      reserveY: result.reserveY.toFixed(4),
      binCount: result.bins.length,
      cat: 'pools',
    });
  } catch (err) {
    logCatchDebug('rangeCache.dlmm', err, { pool: poolId.slice(0, 8) });
  }
}

// ───────────── Tick / Bin array parsing ─────────────

/** Result from parsing a single tick array account. */
interface ClmmArrayParseResult {
  tickLower: number;
  tickUpper: number;
  /** All initialized ticks in this array with their liquidityNet values. */
  ticks: { index: number; liquidityNet: number }[];
}

/**
 * Convert a tick index to a float sqrt-price.
 * sqrtP = 1.0001^(tick / 2)
 */
function tickToSqrtPrice(tick: number): number {
  return Math.pow(1.0001, tick / 2);
}

/**
 * Read a signed i128 from a Buffer at the given offset.
 * Returns a JavaScript number (precision loss acceptable for slippage estimation).
 * Layout: little-endian, low 64 bits first, then high 64 bits (signed).
 */
function readI128AsNumber(buf: Buffer, offset: number): number {
  try {
    const lo = (buf as any).readBigUInt64LE(offset) as bigint;
    const hi = (buf as any).readBigInt64LE(offset + 8) as bigint; // signed high word
    const val = lo + hi * (2n ** 64n);
    return Number(val);
  } catch {
    return 0;
  }
}

/**
 * Parse an Orca Whirlpool tick array account to find the nearest
 * initialized tick boundaries around `currentTick` and extract all
 * initialized ticks with their liquidityNet values.
 *
 * Orca tick array layout (packed):
 *   header: discriminator(8) + startTickIndex(i32, 4)
 *   ticks:  88 × { initialized(bool,1) + liquidityNet(i128,16) +
 *           liquidityGross(u128,16) + feeGrowthOutsideA(u128,16) +
 *           feeGrowthOutsideB(u128,16) + rewardGrowthsOutside(u128×3,48) }
 *   footer: whirlpool(Pubkey, 32)
 */
function parseOrcaTickArray(
  data: Buffer,
  currentTick: number,
  tickSpacing: number,
): ClmmArrayParseResult | null {
  const minSize = ORCA_HEADER_SIZE + ORCA_TICKS_PER_ARRAY * ORCA_TICK_SIZE;
  if (data.length < minSize) return null;

  const startTickIndex = (data as any).readInt32LE(8) as number;
  const ticksPerArray = ORCA_TICKS_PER_ARRAY * tickSpacing;
  const currentSlot = Math.floor((currentTick - startTickIndex) / tickSpacing);

  // Collect all initialized ticks and their liquidityNet
  const ticks: { index: number; liquidityNet: number }[] = [];
  for (let i = 0; i < ORCA_TICKS_PER_ARRAY; i++) {
    const off = ORCA_HEADER_SIZE + i * ORCA_TICK_SIZE;
    if (data[off] !== 0) {
      // initialized flag is true
      // liquidityNet (i128) starts at offset + 1
      const liqNet = readI128AsNumber(data, off + 1);
      ticks.push({
        index: startTickIndex + i * tickSpacing,
        liquidityNet: liqNet,
      });
    }
  }

  // Determine nearest initialized boundaries around currentTick
  let tickLower = startTickIndex;
  let tickUpper = startTickIndex + ticksPerArray;

  if (currentSlot >= 0 && currentSlot < ORCA_TICKS_PER_ARRAY) {
    // Scan downward from currentSlot
    for (let i = currentSlot; i >= 0; i--) {
      const off = ORCA_HEADER_SIZE + i * ORCA_TICK_SIZE;
      if (data[off] !== 0) {
        tickLower = startTickIndex + i * tickSpacing;
        break;
      }
    }
    // Scan upward from currentSlot+1
    for (let i = currentSlot + 1; i < ORCA_TICKS_PER_ARRAY; i++) {
      const off = ORCA_HEADER_SIZE + i * ORCA_TICK_SIZE;
      if (data[off] !== 0) {
        tickUpper = startTickIndex + i * tickSpacing;
        break;
      }
    }
  }

  return { tickLower, tickUpper, ticks };
}

/**
 * Parse a Raydium CLMM tick array account to find the nearest
 * initialized tick boundaries around `currentTick` and extract all
 * initialized ticks with their liquidityNet values.
 *
 * Raydium tick array layout (packed):
 *   header: discriminator(8) + poolId(Pubkey, 32)
 *   ticks:  60 × { tick(i32,4) + liquidityNet(i128,16) +
 *           liquidityGross(u128,16) + feeGrowthOutside0(u128,16) +
 *           feeGrowthOutside1(u128,16) + rewardGrowthsOutside(u128×3,48) +
 *           padding(u32×13,52) }
 *   footer: initializedTickCount(i32, 4)
 *
 * Ticks are at positions: startIndex + i * tickSpacing for i in 0..59.
 * A tick is initialized when liquidityGross > 0.
 */
function parseRaydiumTickArray(
  data: Buffer,
  currentTick: number,
  tickSpacing: number,
): ClmmArrayParseResult | null {
  const minSize = RAYDIUM_HEADER_SIZE + RAYDIUM_TICKS_PER_ARRAY * RAYDIUM_TICK_SIZE;
  if (data.length < minSize) return null;

  const ticksPerArray = RAYDIUM_TICKS_PER_ARRAY * tickSpacing;
  const startTickIndex = Math.floor(currentTick / ticksPerArray) * ticksPerArray;
  const currentSlot = Math.floor((currentTick - startTickIndex) / tickSpacing);

  // Collect all initialized ticks and their liquidityNet
  const ticks: { index: number; liquidityNet: number }[] = [];
  for (let i = 0; i < RAYDIUM_TICKS_PER_ARRAY; i++) {
    const off = RAYDIUM_HEADER_SIZE + i * RAYDIUM_TICK_SIZE;
    // liquidityGross (u128) starts at offset + 4 (tick) + 16 (liquidityNet) = +20
    try {
      const liqGrossLo = (data as any).readBigUInt64LE(off + 20) as bigint;
      if (liqGrossLo > 0n) {
        // liquidityNet (i128) starts at offset + 4
        const liqNet = readI128AsNumber(data, off + 4);
        ticks.push({
          index: startTickIndex + i * tickSpacing,
          liquidityNet: liqNet,
        });
      }
    } catch {
      break; // buffer read error
    }
  }

  // Determine nearest initialized boundaries around currentTick
  let tickLower = startTickIndex;
  let tickUpper = startTickIndex + ticksPerArray;

  for (let i = Math.min(currentSlot, RAYDIUM_TICKS_PER_ARRAY - 1); i >= 0; i--) {
    const off = RAYDIUM_HEADER_SIZE + i * RAYDIUM_TICK_SIZE;
    try {
      const liqGrossLo = (data as any).readBigUInt64LE(off + 20) as bigint;
      if (liqGrossLo > 0n) {
        tickLower = startTickIndex + i * tickSpacing;
        break;
      }
    } catch { break; }
  }

  for (let i = currentSlot + 1; i < RAYDIUM_TICKS_PER_ARRAY; i++) {
    const off = RAYDIUM_HEADER_SIZE + i * RAYDIUM_TICK_SIZE;
    try {
      const liqGrossLo = (data as any).readBigUInt64LE(off + 20) as bigint;
      if (liqGrossLo > 0n) {
        tickUpper = startTickIndex + i * tickSpacing;
        break;
      }
    } catch { break; }
  }

  return { tickLower, tickUpper, ticks };
}

/**
 * Parse a Meteora DLMM bin array to extract all non-empty bins.
 * Uses the SDK decoder for reliable parsing.
 */
async function parseMeteoraBinArray(
  data: Buffer,
  poolId: string,
  activeId: number,
  decimalsX: number,
  decimalsY: number,
): Promise<{ reserveX: number; reserveY: number; bins: { id: number; reserveX: number; reserveY: number }[] } | null> {
  try {
    // Lazy-import the Meteora SDK to decode the bin array.
    // This avoids a static circular dependency with the decoder module.
    let program: any = null;
    try {
      const dlmm = await import('@meteora-ag/dlmm');
      const { Connection } = await import('@solana/web3.js');
      const { CONFIG } = await import('../../utils/config.js');
      const rpcUrl =
        (CONFIG as any).rpc?.url ||
        (CONFIG as any).rpcUrl ||
        'https://api.mainnet-beta.solana.com';
      const conn = new Connection(rpcUrl);
      program = (dlmm as any).createProgram?.(conn);
    } catch {}

    if (!program) return null;

    const decoded = program.coder.accounts.decode('binArray', data);
    if (!decoded?.bins) return null;

    const binArrayIndex =
      decoded.index != null
        ? Number(decoded.index)
        : Math.floor(activeId / METEORA_BIN_ARRAY_SIZE);

    const scaleX = Math.pow(10, Math.max(0, Math.min(18, decimalsX)));
    const scaleY = Math.pow(10, Math.max(0, Math.min(18, decimalsY)));

    // Collect all non-empty bins from this array
    const bins: { id: number; reserveX: number; reserveY: number }[] = [];
    let activeReserveX = 0;
    let activeReserveY = 0;

    for (let i = 0; i < METEORA_BIN_ARRAY_SIZE; i++) {
      const bin = decoded.bins[i];
      if (!bin) continue;

      const amountX = Number(bin.amountX ?? bin.amount_x ?? 0);
      const amountY = Number(bin.amountY ?? bin.amount_y ?? 0);
      if (amountX === 0 && amountY === 0) continue;

      const binId = binArrayIndex * METEORA_BIN_ARRAY_SIZE + i;
      const rx = amountX / scaleX;
      const ry = amountY / scaleY;
      bins.push({ id: binId, reserveX: rx, reserveY: ry });

      if (binId === activeId) {
        activeReserveX = rx;
        activeReserveY = ry;
      }
    }

    if (bins.length === 0) return null;

    // Sort bins ascending by ID
    bins.sort((a, b) => a.id - b.id);

    return {
      reserveX: activeReserveX,
      reserveY: activeReserveY,
      bins,
    };
  } catch (err) {
    logCatchDebug('rangeCache.dlmm.parse', err, { pool: poolId.slice(0, 8) });
    return null;
  }
}
