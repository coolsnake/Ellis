import { CONFIG } from '../utils/config.js';
import { ensureDir, readJson, writeJson, joinPath } from '../utils/fs.js';

type PoolStatic = {
  programId?: string;
  dex?: string;
  pool_kind?: 'amm' | 'clmm';
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
  // Pumpswap-specific
  creator?: string;
  metadata_creator?: string;
  protocol_fee_recipient?: string;
  onchain_base_mint?: string;
  onchain_quote_mint?: string;
  onchain_base_vault?: string;
  onchain_quote_vault?: string;
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
};

type WithExpiry<T> = { value: T; expiresAt: number };

export class ExecutionCache {
  private staticByPool: Map<string, WithExpiry<PoolStatic>> = new Map();
  private hotByPool: Map<string, WithExpiry<PoolHot>> = new Map();
  private tokenMeta: Map<string, WithExpiry<{ decimals: number; program: 'spl-token'|'token-2022' }>> = new Map();
  private ttlStaticMs: number;
  private ttlHotMs: number;
  private ttlTokenMs: number;
  private snapshotFile: string;

  constructor(opts?: { ttlStaticMs?: number; ttlHotMs?: number; ttlTokenMs?: number; snapshotName?: string }) {
    this.ttlStaticMs = Math.max(5 * 60_000, Number(opts?.ttlStaticMs ?? 30 * 60_000));
    // Hot cache stores frequently-changing fields (tick/current price/liquidity/etc).
    // Default to a longer TTL to avoid execution-time misses when WS updates are sparse,
    // while still allowing fresher data to overwrite via WS/refresh.
    this.ttlHotMs = Math.max(200, Number(opts?.ttlHotMs ?? 60_000));
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
    const e = this.hotByPool.get(poolId);
    if (!e) return undefined;
    if (Date.now() > e.expiresAt) { this.hotByPool.delete(poolId); return undefined; }
    return e.value;
  }
  setHot(poolId: string, val: PoolHot): void {
    // Automatically merge with existing data to prevent loss of tickArrays/binArrays
    const existingEntry = this.hotByPool.get(poolId);
    const existing = (existingEntry && Date.now() <= existingEntry.expiresAt) ? existingEntry.value : {};
    
    // Detect if tick/bin crossed array boundaries - if so, replace arrays entirely
    // This prevents stale array addresses from persisting when price moves significantly
    const tickArrayBoundaryCrossed = this.didTickArrayBoundaryCross(existing, val);
    const binArrayBoundaryCrossed = this.didBinArrayBoundaryCross(existing, val);
    
    const merged: PoolHot = {
      ...existing,
      ...val,
      // If boundary crossed, replace arrays entirely; otherwise deep merge to preserve data
      tickArrays: tickArrayBoundaryCrossed
        ? val.tickArrays  // Replace entirely - old arrays are now stale
        : (val.tickArrays ? {
            ...(existing.tickArrays || {}),
            ...val.tickArrays,
          } : existing.tickArrays),
      binArrays: binArrayBoundaryCrossed
        ? val.binArrays  // Replace entirely - old arrays are now stale
        : (val.binArrays ? {
            ...(existing.binArrays || {}),
            ...val.binArrays,
          } : existing.binArrays),
    };
    
    this.hotByPool.set(poolId, { value: merged, expiresAt: Date.now() + this.ttlHotMs });
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
      const payload = {
        static: Array.from(this.staticByPool.entries()),
        tokenMeta: Array.from(this.tokenMeta.entries()),
        savedAt: new Date().toISOString(),
      } as any;
      await writeJson(this.snapshotFile, payload);
    } catch {}
  }

  async loadSnapshot(): Promise<void> {
    try {
      const payload = await readJson(this.snapshotFile, { static: [], tokenMeta: [] } as any);
      const now = Date.now();
      if (Array.isArray(payload?.static)) {
        for (const [poolId, val] of payload.static as Array<[string, PoolStatic]>) {
          this.staticByPool.set(poolId, { value: val, expiresAt: now + this.ttlStaticMs });
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
   * Extend the TTL of hot cache for a pool (useful during active arb execution)
   * Prevents cache expiry while a multi-hop transaction is being built
   */
  extendHotTtl(poolId: string, additionalMs: number = 30_000): void {
    const entry = this.hotByPool.get(poolId);
    if (entry) {
      entry.expiresAt = Math.max(entry.expiresAt, Date.now() + additionalMs);
    }
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
}

export const executionCache = new ExecutionCache();


