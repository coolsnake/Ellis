import type { DirectHop } from '../../execution/types.js';
import { executionCache } from '../cache.js';
import { peekRaydiumPools } from '../../server/pools.js';
import { logger } from '../../utils/logger.js';
import { getClmmStatic } from '../../execution/clmmCache.js';
import { logCatchError } from '../../utils/errorHandler.js';

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

  // Load from hot cache for tick arrays (like Orca resolver)
  // This is critical because tick arrays are cached here during quote phase
  const hot = executionCache.getHot(hop.poolId.replace(/[#-]rev$/, ''));
  if (hot?.tickArrays) {
    // Handle arrays for lower/upper (take first element), string for center
    hop.tickArrayLower = (Array.isArray(hot.tickArrays.lower) ? hot.tickArrays.lower[0] : hot.tickArrays.lower) || hop.tickArrayLower;
    hop.tickArrayCenter = hot.tickArrays.center || hop.tickArrayCenter;
    hop.tickArrayUpper = (Array.isArray(hot.tickArrays.upper) ? hot.tickArrays.upper[0] : hot.tickArrays.upper) || hop.tickArrayUpper;
    
    try {
      logger.info('raydium.clmm.resolver.tick_arrays_from_hot_cache', {
        cat: 'tx',
        ctx: {
          pool: hop.poolId,
          lower: hop.tickArrayLower?.slice(0, 8) + '…' || 'none',
          center: hop.tickArrayCenter?.slice(0, 8) + '…' || 'none',
          upper: hop.tickArrayUpper?.slice(0, 8) + '…' || 'none'
        }
      });
    } catch (e) { logCatchError('resolver.raydiumClmm', e); }
  }

  // Load from CLMM static cache (authoritative for arrays/oracle).
  const cached = getClmmStatic(hop.poolId.replace(/[#-]rev$/, ''));
  if (cached) {
    // CRITICAL: Always prefer cached programId (from on-chain account owner) over any existing value
    // The cache contains the actual program ID that owns the pool account, which is authoritative
    hop.programId = cached.programId || hop.programId;
    hop.tickSpacing = hop.tickSpacing ?? cached.tickSpacing;
    hop.oracle = hop.oracle || cached.oracle;
    hop.vaultA = hop.vaultA || cached.vaultA;
    hop.vaultB = hop.vaultB || cached.vaultB;
    hop.tickArrayCenter = hop.tickArrayCenter || cached.tickArrays.center;
    
    // Handle both single values and arrays from clmmCache
    if (cached.tickArrays.lower) {
      if (typeof cached.tickArrays.lower === 'string') {
        hop.tickArrayLower = hop.tickArrayLower || cached.tickArrays.lower;
      } else if (Array.isArray(cached.tickArrays.lower) && cached.tickArrays.lower.length > 0) {
        hop.tickArrayLower = hop.tickArrayLower || cached.tickArrays.lower[0];
        // Store full array for builder
        (hop as any).tickArrayLowerList = cached.tickArrays.lower;
      }
    }
    
    if (cached.tickArrays.upper) {
      if (typeof cached.tickArrays.upper === 'string') {
        hop.tickArrayUpper = hop.tickArrayUpper || cached.tickArrays.upper;
      } else if (Array.isArray(cached.tickArrays.upper) && cached.tickArrays.upper.length > 0) {
        hop.tickArrayUpper = hop.tickArrayUpper || cached.tickArrays.upper[0];
        // Store full array for builder
        (hop as any).tickArrayUpperList = cached.tickArrays.upper;
      }
    }
    
    if (!hop.observationId && cached.observationId) hop.observationId = cached.observationId;
    if (!hop.ammConfig && cached.ammConfig) hop.ammConfig = cached.ammConfig;
  } else {
    // Fallback: minimal hints from pools snapshot (non-authoritative)
    try {
      const id = hop.poolId.replace(/[#-]rev$/, '');
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
    } catch (e) { logCatchError('resolver.raydiumClmm', e); }
  }
  try { logger.info('raydium.clmm.resolve', { cat: 'tx', ctx: { pool: hop.poolId, lower: hop.tickArrayLower, upper: hop.tickArrayUpper } as any }); } catch (e) { logCatchError('resolver.raydiumClmm', e); }
  return hop;
}


