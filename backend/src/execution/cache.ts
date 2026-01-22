import { CONFIG } from '../utils/config.js';
import { ensureDir, readJson, writeJson, joinPath } from '../utils/fs.js';
import { recomputeCapacityCurve, invalidateCapacityCurve } from './capacity/index.js';
import type { PoolType, SizingConfig } from './capacity/types.js';

type PoolStatic = {
  programId?: string;
  dex?: string;
  pool_kind?: 'amm' | 'clmm' | 'cpmm';
  vaults?: { a?: string; b?: string };
  // Common execution accounts
  authorities?: Record<string, string>;
  serum?: Record<string, string>;
  oracle?: string;
  tickSpacing?: number;
  binStep?: number;
  amm_config?: string;
  // OPTIMIZATION: Store raw account data from WebSocket for local decoding
  // This eliminates RPC calls in builders that need to decode pool state
  rawAccountData?: Buffer;
  rawAccountDataUpdatedMs?: number;
  // Pool mint orientation (CRITICAL for Raydium AMM to match Serum market)
  mint_a?: string;
  mint_b?: string;
  decimals_a?: number;
  decimals_b?: number;
  // Native mint orientation (original tokenX/tokenY order before canonicalization)
  native_mint_a?: string;
  native_mint_b?: string;
  native_decimals_a?: number;
  native_decimals_b?: number;
  native_vault_a?: string;
  native_vault_b?: string;
  native_account_a?: string;
  native_account_b?: string;
  token_program_a?: 'spl-token' | 'token-2022';
  token_program_b?: 'spl-token' | 'token-2022';
  // Raydium AMM market accounts (required for swaps)
  market_id?: string;
  market_program_id?: string;
  market_bids?: string;
  market_asks?: string;
  market_event_queue?: string;
  market_base_vault?: string;
  market_quote_vault?: string;
  market_authority?: string;
  amm_authority?: string;
  amm_open_orders?: string;
  amm_target_orders?: string;
  lp_mint?: string;
  // Legacy Serum market aliases (for backward compatibility with older code paths)
  market?: string;                      // Alias for market_id
  serum_bids?: string;                  // Alias for market_bids
  serum_asks?: string;                  // Alias for market_asks
  serum_event_queue?: string;           // Alias for market_event_queue
  serum_coin_vault?: string;            // Alias for market_base_vault
  serum_pc_vault?: string;              // Alias for market_quote_vault
  serum_vault_signer?: string;          // Alias for market_authority
  mint_lp?: string;                     // Alias for lp_mint
  // Generic vault/account references (used across DEXes)
  vault_a?: string;
  vault_b?: string;
  open_orders?: string;
  target_orders?: string;
  authority?: string;
  // CLMM execution-critical accounts (cached to avoid RPC calls during instruction building)
  // Meteora DLMM: bitmap_extension is handled automatically by the SDK, no need to cache
  // Raydium CLMM-specific
  observation_state?: string;           // Observation state account (oracle data)
  observation_key?: string;             // Alias for observation_state (CPMM pools)
  ex_bitmap?: string;                   // Extended bitmap for tick array tracking
  tickArrayLower?: string;
  tickArrayCenter?: string;
  tickArrayUpper?: string;
  // Orca Whirlpool-specific
  token_vault_a?: string;               // Token vault A
  token_vault_b?: string;               // Token vault B
  // Generic vault/account references
  account_a?: string;
  account_b?: string;
  tick_spacing?: number;
  bin_array_bitmap_extension?: string;
  // Meteora-specific
  bin_array_lower?: string;
  bin_array_upper?: string;
  bin_array_active?: string;  // Active bin array (containing the current active bin)
  bin_array_lower2?: string;  // Lower-2 bin array (for wider swaps)
  bin_array_upper2?: string;  // Upper-2 bin array (for wider swaps)
  // Pumpswap-specific
  creator?: string;
  metadata_creator?: string;
  protocol_fee_recipient?: string;
  onchain_base_mint?: string;
  onchain_quote_mint?: string;
  onchain_base_vault?: string;
  onchain_quote_vault?: string;
  // Canonicalization flag - CRITICAL for direction calculation when native_mint_a/b are missing
  // When was_swapped is true, canonical mint_a/b are reversed from native tokenX/tokenY
  was_swapped?: boolean;
};

type PoolHot = {
  sqrtPriceX64?: bigint;
  currentTickIndex?: number;
  activeId?: number;
  // OPTIMIZATION: Store liquidity and fee rate for local CLMM quotes (Orca/Raydium)
  liquidity?: bigint;
  feeRate?: number;  // Fee rate in basis points
  // Store tick spacing / bin step for boundary crossing detection
  // This enables intelligent cache invalidation when tick/bin crosses array boundaries
  tickSpacing?: number;
  binStep?: number;
  // Tick array validation flags - used to exclude pools with stale/unvalidated tick arrays
  // When tick crosses array boundary, arrays are cleared and this flag is set
  // Background validator will validate arrays on-chain and clear the flag
  needsTickArrayValidation?: boolean;
  tickArrayInvalidatedAt?: number;  // Timestamp when arrays were invalidated
  tickArraysValidatedAt?: number;   // Timestamp when arrays were last validated on-chain
  tickArrays?: { 
    center?: string;
    // Support both single value (backward compat) and arrays
    lower?: string | string[];
    upper?: string | string[];
    // OPTIMIZATION: Store actual tick array account data for direct use
    lowerData?: Buffer;
    centerData?: Buffer;
    upperData?: Buffer;
  };
  // Bin array validation flags (same pattern as tick arrays)
  needsBinArrayValidation?: boolean;
  binArrayInvalidatedAt?: number;
  binArraysValidatedAt?: number;
  binArrays?: { 
    lower?: string; 
    upper?: string;
    active?: string;
    // Full array list for more comprehensive coverage
    arrays?: Array<{ index: number; address: string }>;
    // Range covered by cached arrays
    range?: { lower: number; upper: number };
    // OPTIMIZATION: Store actual bin array account data for direct use
    lowerData?: Buffer;
    upperData?: Buffer;
  };
  // Validation state flags
  // noLiquidityValidatedAt: Pool was validated and found to have no liquidity
  // Re-check after timeout to handle pools that gain liquidity
  noLiquidityValidatedAt?: number;
  // liquidityOutsideRange: Pool has liquidity but tick arrays are outside search range
  // Pool is still tradeable - swap builder will derive arrays at execution time
  liquidityOutsideRange?: boolean;
};

type WithExpiry<T> = { value: T; expiresAt: number };

export class ExecutionCache {
  private staticByPool: Map<string, WithExpiry<PoolStatic>> = new Map();
  // Hot cache stores frequently-changing fields (tick/current price/liquidity/tick arrays/bin arrays).
  // No TTL - entries persist until explicitly updated via WebSocket or pool refresh.
  private hotByPool: Map<string, PoolHot> = new Map();
  private tokenMeta: Map<string, WithExpiry<{ decimals: number; program: 'spl-token'|'token-2022' }>> = new Map();
  private ttlStaticMs: number;
  private ttlTokenMs: number;
  private snapshotFile: string;

  constructor(opts?: { ttlStaticMs?: number; ttlTokenMs?: number; snapshotName?: string }) {
    this.ttlStaticMs = Math.max(5 * 60_000, Number(opts?.ttlStaticMs ?? 30 * 60_000));
    this.ttlTokenMs = Math.max(60_000, Number(opts?.ttlTokenMs ?? 3_600_000));
    const name = opts?.snapshotName || 'dex-accounts.json';
    this.snapshotFile = joinPath(CONFIG.cacheDir, name);
  }

  getStatic(poolId: string): PoolStatic | undefined {
    const e = this.staticByPool.get(poolId);
    if (!e) return undefined;
    if (Date.now() > e.expiresAt) { this.staticByPool.delete(poolId); return undefined; }
    return e.value;
  }
  setStatic(poolId: string, val: PoolStatic): void {
    this.staticByPool.set(poolId, { value: val, expiresAt: Date.now() + this.ttlStaticMs });
  }

  getHot(poolId: string): PoolHot | undefined {
    return this.hotByPool.get(poolId);
  }
  
  setHot(poolId: string, val: PoolHot): void {
    // Automatically merge with existing data to prevent loss of tickArrays/binArrays
    const existing = this.hotByPool.get(poolId) || {};
    
    // Detect if tick/bin crossed array boundaries - if so, INVALIDATE arrays
    // This prevents stale array addresses from persisting when price moves significantly
    const tickArrayBoundaryCrossed = this.didTickArrayBoundaryCross(existing, val);
    const binArrayBoundaryCrossed = this.didBinArrayBoundaryCross(existing, val);
    
    const now = Date.now();
    
    // Handle tick array boundary crossing
    let tickArrays = existing.tickArrays;
    let needsTickArrayValidation = existing.needsTickArrayValidation;
    let tickArrayInvalidatedAt = existing.tickArrayInvalidatedAt;
    let tickArraysValidatedAt = existing.tickArraysValidatedAt;
    
    if (tickArrayBoundaryCrossed) {
      // CRITICAL: Clear stale tick arrays and flag for validation
      // Don't use incoming tick arrays either - they haven't been validated on-chain
      tickArrays = undefined;
      needsTickArrayValidation = true;
      tickArrayInvalidatedAt = now;
      tickArraysValidatedAt = undefined;
    } else if (val.tickArrays) {
      // No boundary crossed - merge incoming arrays with existing
      // If incoming has needsTickArrayValidation explicitly set to false, it means validated
      if (val.needsTickArrayValidation === false) {
        // Explicitly validated - use incoming arrays and clear flag
        tickArrays = val.tickArrays;
        needsTickArrayValidation = false;
        tickArraysValidatedAt = val.tickArraysValidatedAt || now;
      } else {
        // Merge arrays, preserve validation state
        tickArrays = {
          ...(existing.tickArrays || {}),
          ...val.tickArrays,
        };
      }
    }
    
    // Handle bin array boundary crossing (same pattern)
    let binArrays = existing.binArrays;
    let needsBinArrayValidation = existing.needsBinArrayValidation;
    let binArrayInvalidatedAt = existing.binArrayInvalidatedAt;
    let binArraysValidatedAt = existing.binArraysValidatedAt;
    
    if (binArrayBoundaryCrossed) {
      // CRITICAL: Clear stale bin arrays and flag for validation
      binArrays = undefined;
      needsBinArrayValidation = true;
      binArrayInvalidatedAt = now;
      binArraysValidatedAt = undefined;
    } else if (val.binArrays) {
      if (val.needsBinArrayValidation === false) {
        binArrays = val.binArrays;
        needsBinArrayValidation = false;
        binArraysValidatedAt = val.binArraysValidatedAt || now;
      } else {
        binArrays = {
          ...(existing.binArrays || {}),
          ...val.binArrays,
        };
      }
    }
    
    const merged: PoolHot = {
      ...existing,
      ...val,
      tickArrays,
      needsTickArrayValidation,
      tickArrayInvalidatedAt,
      tickArraysValidatedAt,
      binArrays,
      needsBinArrayValidation,
      binArrayInvalidatedAt,
      binArraysValidatedAt,
    };
    
    this.hotByPool.set(poolId, merged);
    
    // Trigger capacity curve recomputation on boundary crossings
    // This runs asynchronously to avoid blocking the hot path
    if (tickArrayBoundaryCrossed || binArrayBoundaryCrossed) {
      const poolType = this.inferPoolType(poolId, existing, val);
      if (poolType) {
        // Invalidate existing curve and trigger async recomputation
        invalidateCapacityCurve(poolId);
        recomputeCapacityCurve(poolId, poolType, merged, this.sizingConfig);
      }
    }
  }
  
  /**
   * Infer pool type from hot data and static cache
   */
  private inferPoolType(poolId: string, existing: PoolHot, incoming: PoolHot): PoolType | null {
    // Check for CLMM indicators (tick-based)
    if (incoming.currentTickIndex !== undefined || existing.currentTickIndex !== undefined) {
      return 'clmm';
    }
    
    // Check for DLMM indicators (bin-based)
    if (incoming.activeId !== undefined || existing.activeId !== undefined) {
      return 'dlmm';
    }
    
    // Check static cache for pool_kind
    const staticData = this.staticByPool.get(poolId)?.value;
    if (staticData?.pool_kind === 'clmm') return 'clmm';
    if (staticData?.pool_kind === 'amm') return 'amm';
    
    // Check dex string
    const dex = staticData?.dex?.toLowerCase() || '';
    if (dex.includes('meteora') && !dex.includes('balanced')) return 'dlmm';
    if (dex.includes('orca') || dex.includes('clmm')) return 'clmm';
    
    // Default to AMM if we can't determine
    return 'amm';
  }
  
  /**
   * Sizing configuration for capacity computation
   * Can be updated at runtime via setSizingConfig()
   */
  private sizingConfig: SizingConfig | undefined;
  
  /**
   * Set the sizing configuration for capacity computation
   */
  setSizingConfig(config: SizingConfig): void {
    this.sizingConfig = config;
  }

  /**
   * Check if the current tick has crossed a tick array boundary
   * Each tick array covers 60 * tickSpacing ticks, so we check if the
   * floor division changed (meaning we moved to a different array)
   */
  private didTickArrayBoundaryCross(existing: PoolHot, incoming: PoolHot): boolean {
    // Need both old and new tick index to compare
    if (existing.currentTickIndex === undefined || incoming.currentTickIndex === undefined) {
      return false;
    }
    
    // Use incoming tickSpacing if provided, otherwise fall back to existing
    const tickSpacing = incoming.tickSpacing ?? existing.tickSpacing;
    if (!tickSpacing || tickSpacing <= 0) {
      return false;
    }
    
    // Tick array size is 60 * tickSpacing
    const arraySize = 60 * tickSpacing;
    
    // Calculate which tick array index each tick falls into
    const oldArrayIndex = Math.floor(existing.currentTickIndex / arraySize);
    const newArrayIndex = Math.floor(incoming.currentTickIndex / arraySize);
    
    // If array index changed, we crossed a boundary
    return oldArrayIndex !== newArrayIndex;
  }

  /**
   * Check if the active bin has crossed a bin array boundary
   * Bin arrays are indexed differently than tick arrays - each bin array
   * covers a range of bin IDs. We use a simplified check based on
   * significant bin ID changes.
   */
  private didBinArrayBoundaryCross(existing: PoolHot, incoming: PoolHot): boolean {
    // Need both old and new activeId to compare
    if (existing.activeId === undefined || incoming.activeId === undefined) {
      return false;
    }
    
    // Meteora bin arrays typically cover ~70 bins per array (based on SDK internals)
    // The exact formula is: binIdToBinArrayIndex(binId) = floor(binId / BIN_ARRAY_BITMAP_SIZE)
    // where BIN_ARRAY_BITMAP_SIZE is typically 512 for the bitmap, but each array covers fewer bins
    // Using 70 as a conservative estimate based on observed behavior
    const BINS_PER_ARRAY = 70;
    
    const oldArrayIndex = Math.floor(existing.activeId / BINS_PER_ARRAY);
    const newArrayIndex = Math.floor(incoming.activeId / BINS_PER_ARRAY);
    
    // If array index changed, we crossed a boundary
    return oldArrayIndex !== newArrayIndex;
  }

  getTokenMeta(mint: string): { decimals: number; program: 'spl-token'|'token-2022' } | undefined {
    const e = this.tokenMeta.get(mint);
    if (!e) return undefined;
    if (Date.now() > e.expiresAt) { this.tokenMeta.delete(mint); return undefined; }
    return e.value;
  }
  setTokenMeta(mint: string, meta: { decimals: number; program: 'spl-token'|'token-2022' }): void {
    this.tokenMeta.set(mint, { value: meta, expiresAt: Date.now() + this.ttlTokenMs });
  }

  async saveSnapshot(): Promise<void> {
    try {
      await ensureDir(joinPath(this.snapshotFile, '..'));
      // Convert hot cache entries to serializable format (bigint -> string)
      const hotEntries: Array<[string, any]> = [];
      for (const [poolId, val] of this.hotByPool.entries()) {
        hotEntries.push([poolId, {
          ...val,
          sqrtPriceX64: val.sqrtPriceX64?.toString(),
          liquidity: val.liquidity?.toString(),
        }]);
      }
      const payload = {
        static: Array.from(this.staticByPool.entries()),
        hot: hotEntries,
        tokenMeta: Array.from(this.tokenMeta.entries()),
        savedAt: new Date().toISOString(),
      } as any;
      await writeJson(this.snapshotFile, payload);
    } catch {}
  }

  async loadSnapshot(): Promise<void> {
    try {
      const payload = await readJson(this.snapshotFile, { static: [], hot: [], tokenMeta: [] } as any);
      const now = Date.now();
      if (Array.isArray(payload?.static)) {
        for (const [poolId, val] of payload.static as Array<[string, PoolStatic]>) {
          this.staticByPool.set(poolId, { value: val, expiresAt: now + this.ttlStaticMs });
        }
      }
      // Load hot cache (no expiry, convert string back to bigint)
      if (Array.isArray(payload?.hot)) {
        for (const [poolId, val] of payload.hot as Array<[string, any]>) {
          this.hotByPool.set(poolId, {
            ...val,
            sqrtPriceX64: val.sqrtPriceX64 ? BigInt(val.sqrtPriceX64) : undefined,
            liquidity: val.liquidity ? BigInt(val.liquidity) : undefined,
          });
        }
      }
      if (Array.isArray(payload?.tokenMeta)) {
        for (const [mint, meta] of payload.tokenMeta as Array<[string, { decimals: number; program: 'spl-token'|'token-2022' }]>) {
          this.tokenMeta.set(mint, { value: meta, expiresAt: now + this.ttlTokenMs });
        }
      }
    } catch {}
  }

  /**
   * Sync execution cache from pool cache for a specific pool
   * Useful when execution cache misses but pool cache has the data
   */
  async syncFromPoolCache(poolId: string): Promise<boolean> {
    try {
      const { findPoolInCache } = await import('../server/pools.cache.js');
      const found = findPoolInCache(poolId);
      if (!found) return false;
      
      const pool = found.pool as any;
      const source = found.source;
      
      // Populate static cache
      this.setStatic(poolId, {
        mint_a: pool.mint_a,
        mint_b: pool.mint_b,
        decimals_a: pool.decimals_a,
        decimals_b: pool.decimals_b,
        native_mint_a: pool.native_mint_a,
        native_mint_b: pool.native_mint_b,
        dex: source === 'orca' ? 'orca' : source === 'raydium' ? 'raydium' : source === 'meteora' ? 'meteora' : undefined,
        pool_kind: pool.pool_kind,
        tickSpacing: pool.tick_spacing,
        binStep: pool.bin_step,
      });
      
      // Populate hot cache if we have price data
      // Include tickSpacing/binStep for boundary crossing detection
      if (pool.sqrt_price_x64_raw) {
        this.setHot(poolId, {
          sqrtPriceX64: BigInt(pool.sqrt_price_x64_raw),
          feeRate: pool.fee_bps,
          currentTickIndex: pool.tick_current_index,
          activeId: pool.active_id,
          tickSpacing: pool.tick_spacing,
          binStep: pool.bin_step,
          liquidity: pool.liquidity_raw ? BigInt(pool.liquidity_raw) : undefined,
        });
      }
      
      return true;
    } catch {
      return false;
    }
  }

  clear(): void {
    this.staticByPool.clear();
    this.hotByPool.clear();
    this.tokenMeta.clear();
  }

  /**
   * Check if a pool needs tick array validation
   * Pools with this flag should be excluded from routing until validated
   */
  needsTickArrayValidation(poolId: string): boolean {
    const hot = this.hotByPool.get(poolId);
    return hot?.needsTickArrayValidation === true;
  }

  /**
   * Check if a pool needs bin array validation (Meteora DLMM)
   */
  needsBinArrayValidation(poolId: string): boolean {
    const hot = this.hotByPool.get(poolId);
    return hot?.needsBinArrayValidation === true;
  }

  /**
   * Check if a pool has validated tick arrays ready for use
   */
  hasValidatedTickArrays(poolId: string): boolean {
    const hot = this.hotByPool.get(poolId);
    if (!hot) return false;
    // Has arrays and doesn't need validation
    return !!(hot.tickArrays?.center) && hot.needsTickArrayValidation !== true;
  }

  /**
   * Get all pools that need tick array validation
   * Used by background validator to find work
   */
  getPoolsNeedingTickArrayValidation(): Array<{ poolId: string; invalidatedAt: number; tickSpacing?: number; currentTick?: number }> {
    const pools: Array<{ poolId: string; invalidatedAt: number; tickSpacing?: number; currentTick?: number }> = [];
    for (const [poolId, hot] of this.hotByPool.entries()) {
      if (hot.needsTickArrayValidation) {
        pools.push({
          poolId,
          invalidatedAt: hot.tickArrayInvalidatedAt || 0,
          tickSpacing: hot.tickSpacing,
          currentTick: hot.currentTickIndex,
        });
      }
    }
    // Sort by invalidatedAt (oldest first) for fairness
    pools.sort((a, b) => a.invalidatedAt - b.invalidatedAt);
    return pools;
  }

  /**
   * Get all pools that need bin array validation
   */
  getPoolsNeedingBinArrayValidation(): Array<{ poolId: string; invalidatedAt: number; binStep?: number; activeId?: number }> {
    const pools: Array<{ poolId: string; invalidatedAt: number; binStep?: number; activeId?: number }> = [];
    for (const [poolId, hot] of this.hotByPool.entries()) {
      if (hot.needsBinArrayValidation) {
        pools.push({
          poolId,
          invalidatedAt: hot.binArrayInvalidatedAt || 0,
          binStep: hot.binStep,
          activeId: hot.activeId,
        });
      }
    }
    pools.sort((a, b) => a.invalidatedAt - b.invalidatedAt);
    return pools;
  }

  /**
   * Mark tick arrays as validated (called by background validator)
   * This clears the needsTickArrayValidation flag and stores the validated arrays
   */
  setValidatedTickArrays(
    poolId: string, 
    tickArrays: { center?: string; lower?: string | string[]; upper?: string | string[] }
  ): void {
    const existing = this.hotByPool.get(poolId) || {};
    this.hotByPool.set(poolId, {
      ...existing,
      tickArrays,
      needsTickArrayValidation: false,
      tickArraysValidatedAt: Date.now(),
    });
  }

  /**
   * Mark bin arrays as validated (called by background validator)
   */
  setValidatedBinArrays(
    poolId: string,
    binArrays: { lower?: string; upper?: string; active?: string; arrays?: Array<{ index: number; address: string }> }
  ): void {
    const existing = this.hotByPool.get(poolId) || {};
    this.hotByPool.set(poolId, {
      ...existing,
      binArrays,
      needsBinArrayValidation: false,
      binArraysValidatedAt: Date.now(),
    });
  }

  /**
   * Invalidate tick arrays for a pool (trigger re-validation)
   * Call this when you know arrays might be stale (e.g., after failed tx)
   */
  invalidateTickArrays(poolId: string): void {
    const existing = this.hotByPool.get(poolId);
    if (!existing) return;
    this.hotByPool.set(poolId, {
      ...existing,
      tickArrays: undefined,
      needsTickArrayValidation: true,
      tickArrayInvalidatedAt: Date.now(),
      tickArraysValidatedAt: undefined,
    });
  }

  /**
   * Invalidate bin arrays for a pool
   */
  invalidateBinArrays(poolId: string): void {
    const existing = this.hotByPool.get(poolId);
    if (!existing) return;
    this.hotByPool.set(poolId, {
      ...existing,
      binArrays: undefined,
      needsBinArrayValidation: true,
      binArrayInvalidatedAt: Date.now(),
      binArraysValidatedAt: undefined,
    });
  }
}

export const executionCache = new ExecutionCache();


