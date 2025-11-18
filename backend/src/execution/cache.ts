import { CONFIG } from '../utils/config.js';
import { ensureDir, readJson, writeJson, joinPath } from '../utils/fs.js';

type PoolStatic = {
  programId: string;
  dex?: string;
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
};

type PoolHot = {
  sqrtPriceX64?: bigint;
  currentTickIndex?: number;
  activeId?: number;
  // OPTIMIZATION: Store liquidity and fee rate for local CLMM quotes (Orca/Raydium)
  liquidity?: bigint;
  feeRate?: number;  // Fee rate in basis points
  tickArrays?: { 
    lower?: string; 
    center?: string; 
    upper?: string;
    // OPTIMIZATION: Store actual tick array account data for direct use
    lowerData?: Buffer;
    centerData?: Buffer;
    upperData?: Buffer;
  };
  binArrays?: { 
    lower?: string; 
    upper?: string;
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
    this.ttlHotMs = Math.max(200, Number(opts?.ttlHotMs ?? 1000));
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
    this.hotByPool.set(poolId, { value: val, expiresAt: Date.now() + this.ttlHotMs });
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

  clear(): void {
    this.staticByPool.clear();
    this.hotByPool.clear();
    this.tokenMeta.clear();
  }
}

export const executionCache = new ExecutionCache();


