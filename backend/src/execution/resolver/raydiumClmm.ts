import type { DirectHop } from '../../execution/types.js';
import { executionCache } from '../cache.js';
import { peekRaydiumPools } from '../../server/pools.js';
import { logger } from '../../utils/logger.js';
import { getClmmStatic } from '../../execution/clmmCache.js';

export async function resolveRaydiumClmm(hop: DirectHop): Promise<DirectHop> {
  // Prefer statics from in-memory exec cache.
  const stat = executionCache.getStatic(hop.poolId);
  if (stat?.programId) hop.programId = stat.programId;
  if (stat?.oracle && !hop.oracle) hop.oracle = stat.oracle;
  if (stat?.account_a && !hop.vaultA) hop.vaultA = stat.account_a;
  if (stat?.account_b && !hop.vaultB) hop.vaultB = stat.account_b;
  if (stat?.tick_spacing && !hop.tickSpacing) hop.tickSpacing = stat.tick_spacing;
  if (stat?.tickArrayLower && !hop.tickArrayLower) hop.tickArrayLower = stat.tickArrayLower;
  if (stat?.tickArrayCenter && !hop.tickArrayCenter) hop.tickArrayCenter = stat.tickArrayCenter;
  if (stat?.tickArrayUpper && !hop.tickArrayUpper) hop.tickArrayUpper = stat.tickArrayUpper;
  if (stat?.observation_state && !hop.observationId) hop.observationId = stat.observation_state;
  if ((stat as any)?.amm_config && !hop.ammConfig) hop.ammConfig = (stat as any).amm_config;
  if (stat?.ex_bitmap && !(hop as any).exBitmap) (hop as any).exBitmap = stat.ex_bitmap;

  // Load from CLMM static cache (authoritative for arrays/oracle).
  const cached = getClmmStatic(hop.poolId.replace(/-rev$/, ''));
  if (cached) {
    // CRITICAL: Always prefer cached programId (from on-chain account owner) over any existing value
    // The cache contains the actual program ID that owns the pool account, which is authoritative
    hop.programId = cached.programId || hop.programId;
    hop.tickSpacing = hop.tickSpacing ?? cached.tickSpacing;
    hop.oracle = hop.oracle || cached.oracle;
    hop.vaultA = hop.vaultA || cached.vaultA;
    hop.vaultB = hop.vaultB || cached.vaultB;
    hop.tickArrayLower = hop.tickArrayLower || cached.tickArrays.lower;
    hop.tickArrayCenter = hop.tickArrayCenter || cached.tickArrays.center;
    hop.tickArrayUpper = hop.tickArrayUpper || cached.tickArrays.upper;
    if (!hop.observationId && cached.observationId) hop.observationId = cached.observationId;
    if (!hop.ammConfig && cached.ammConfig) hop.ammConfig = cached.ammConfig;
  } else {
    // Fallback: minimal hints from pools snapshot (non-authoritative)
    try {
      const id = hop.poolId.replace(/-rev$/, '');
      const pools = peekRaydiumPools();
      const p = (pools.clmm || []).find((x: any) => String(x?.id || '') === id);
      if (p) {
        hop.tickSpacing = Number((p as any)?.tick_spacing || (p as any)?.tickSpacing || hop.tickSpacing || 0);
        hop.oracle = hop.oracle || String((p as any)?.oracle || '');
        hop.vaultA = hop.vaultA || String((p as any)?.account_a || '');
        hop.vaultB = hop.vaultB || String((p as any)?.account_b || '');
        hop.tickArrayLower = hop.tickArrayLower || String((p as any)?.tick_array_lower || '');
        hop.tickArrayCenter = hop.tickArrayCenter || String((p as any)?.tick_array_center || '');
        hop.tickArrayUpper = hop.tickArrayUpper || String((p as any)?.tick_array_upper || '');
        if (!hop.observationId) {
          const obs = (p as any)?.observation_id || (p as any)?.observationId || '';
          if (obs) hop.observationId = String(obs);
        }
        if (!hop.ammConfig) {
          const cfg = (p as any)?.amm_config || (p as any)?.ammConfig || (p as any)?.config_id || '';
          if (cfg) hop.ammConfig = String(cfg);
        }
      }
    } catch {}
  }
  try { logger.info('raydium.clmm.resolve', { cat: 'tx', ctx: { pool: hop.poolId, lower: hop.tickArrayLower, upper: hop.tickArrayUpper } as any }); } catch {}
  return hop;
}


