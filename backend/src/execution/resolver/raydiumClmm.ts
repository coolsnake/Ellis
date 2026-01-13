import type { DirectHop } from '../../execution/types.js';
import { executionCache } from '../cache.js';
import { peekRaydiumPools } from '../../server/pools.js';
import { logger } from '../../utils/logger.js';
import { getClmmStatic } from '../../execution/clmmCache.js';
import { logCatchError } from '../../utils/errorHandler.js';

// NOTE: Tick array derivation has been intentionally removed.
// Derived tick array PDAs may not exist on-chain (pools with thin liquidity).
// Tick arrays must come from validated sources:
// 1. Pool fetch with on-chain validation (raydiumGraphQL.ts, orca.ts)
// 2. WebSocket updates (websockets/decoders/raydium.ts)
// 3. cacheValidator.ts (explicit validation via /arb/pools/revalidate)
// 4. Pool persistence with REVALIDATE_ON_LOAD=true

export async function resolveRaydiumClmm(hop: DirectHop): Promise<DirectHop> {
  // Prefer statics from in-memory exec cache.
  // CRITICAL: Strip #rev suffix to match cache key format (pools are cached by base ID)
  const poolIdBase = hop.poolId.replace(/[#-]rev$/, '');
  const stat = executionCache.getStatic(poolIdBase);
  if (stat?.programId) hop.programId = stat.programId;
  if (stat?.oracle && !hop.oracle) hop.oracle = stat.oracle;
  // CRITICAL: Use NATIVE vault ordering for SDK/on-chain compatibility
  // native_account_a/b are the actual on-chain values before canonicalization
  if (!hop.vaultA) hop.vaultA = stat?.native_account_a || stat?.account_a;
  if (!hop.vaultB) hop.vaultB = stat?.native_account_b || stat?.account_b;
  if (stat?.tick_spacing && !hop.tickSpacing) hop.tickSpacing = stat.tick_spacing;
  // Don't load tick arrays from static cache here - check hot cache validation flag first
  if (stat?.observation_state && !hop.observationId) hop.observationId = stat.observation_state;
  if ((stat as any)?.amm_config && !hop.ammConfig) hop.ammConfig = (stat as any).amm_config;
  if (stat?.ex_bitmap && !(hop as any).exBitmap) (hop as any).exBitmap = stat.ex_bitmap;

  // Load from hot cache for tick arrays (like Orca resolver)
  // CRITICAL: Hot cache contains tick array data - use even if not yet validated on-chain
  const hot = executionCache.getHot(poolIdBase);
  
  // Check if pool needs tick array validation (boundary crossed or freshly derived)
  // Even if validation pending, still USE the derived arrays - they're usually correct
  // The builder will catch any issues (duplicates, non-existent) at build time
  const cacheNeedsValidation = hot?.needsTickArrayValidation === true;
  
  // Use cached tick arrays regardless of validation status
  // Derived arrays are usually correct; validation just confirms on-chain existence
  if (hot?.tickArrays) {
    // Handle arrays for lower/upper (take first element), string for center
    const hotLower = Array.isArray(hot.tickArrays.lower) ? hot.tickArrays.lower[0] : hot.tickArrays.lower;
    const hotCenter = hot.tickArrays.center;
    const hotUpper = Array.isArray(hot.tickArrays.upper) ? hot.tickArrays.upper[0] : hot.tickArrays.upper;
    
    // Use hot cache values, only fall back to hop if hot cache is undefined
    if (hotLower) hop.tickArrayLower = hotLower;
    if (hotCenter) hop.tickArrayCenter = hotCenter;
    if (hotUpper) hop.tickArrayUpper = hotUpper;
    
    try {
      logger.debug('raydium.clmm.resolver.tick_arrays_from_hot_cache', {
        cat: 'tx',
        ctx: {
          pool: hop.poolId,
          lower: hop.tickArrayLower?.slice(0, 8) + '…' || 'none',
          center: hop.tickArrayCenter?.slice(0, 8) + '…' || 'none',
          upper: hop.tickArrayUpper?.slice(0, 8) + '…' || 'none',
          validated: !cacheNeedsValidation,
        }
      });
    } catch (e) { logCatchError('resolver.raydiumClmm', e); }
  } else {
    // No hot cache tick arrays - try static cache as fallback
    if (stat?.tickArrayLower && !hop.tickArrayLower) hop.tickArrayLower = stat.tickArrayLower;
    if (stat?.tickArrayCenter && !hop.tickArrayCenter) hop.tickArrayCenter = stat.tickArrayCenter;
    if (stat?.tickArrayUpper && !hop.tickArrayUpper) hop.tickArrayUpper = stat.tickArrayUpper;
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
    
    // PREFER CLMM cache over existing hop values for tick arrays (validated data)
    if (cached.tickArrays.center) {
      hop.tickArrayCenter = cached.tickArrays.center;
    }
    
    // Handle both single values and arrays from clmmCache
    if (cached.tickArrays.lower) {
      if (typeof cached.tickArrays.lower === 'string') {
        hop.tickArrayLower = cached.tickArrays.lower;
      } else if (Array.isArray(cached.tickArrays.lower) && cached.tickArrays.lower.length > 0) {
        hop.tickArrayLower = cached.tickArrays.lower[0];
        // Store full array for builder
        (hop as any).tickArrayLowerList = cached.tickArrays.lower;
      }
    }
    
    if (cached.tickArrays.upper) {
      if (typeof cached.tickArrays.upper === 'string') {
        hop.tickArrayUpper = cached.tickArrays.upper;
      } else if (Array.isArray(cached.tickArrays.upper) && cached.tickArrays.upper.length > 0) {
        hop.tickArrayUpper = cached.tickArrays.upper[0];
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
        // CRITICAL: Use native vault ordering for SDK/on-chain compatibility
        hop.vaultA = hop.vaultA || String((p as any)?.native_account_a || (p as any)?.account_a || '');
        hop.vaultB = hop.vaultB || String((p as any)?.native_account_b || (p as any)?.account_b || '');
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
  
  // WARNING: Do NOT blindly derive tick arrays - derived PDAs may not exist on-chain!
  // Tick arrays should come from validated sources (pool fetch, websocket updates, or cacheValidator).
  // If tick arrays are missing, log a warning - the builder should handle missing arrays gracefully.
  const hasAllTickArrays = hop.tickArrayLower && hop.tickArrayCenter && hop.tickArrayUpper;
  const isPendingValidation = cacheNeedsValidation || !hasAllTickArrays;
  
  if (isPendingValidation) {
    const currentTick = hot?.currentTickIndex;
    const tickSpacing = hop.tickSpacing || stat?.tick_spacing || (stat as any)?.tickSpacing;
    
    try {
      logger.warn('raydium.clmm.resolver.tick_arrays_incomplete', {
        cat: 'tx',
        ctx: {
          pool: hop.poolId,
          hasLower: !!hop.tickArrayLower,
          hasCenter: !!hop.tickArrayCenter,
          hasUpper: !!hop.tickArrayUpper,
          cacheNeedsValidation,
          hasCurrentTick: currentTick !== undefined,
          hasTickSpacing: !!tickSpacing,
          hint: cacheNeedsValidation 
            ? 'Tick arrays pending background validation. Pool may be temporarily unavailable.'
            : 'Tick arrays not in cache. Pool needs validation via /arb/pools/revalidate or REVALIDATE_ON_LOAD=true',
        }
      });
    } catch (e) { logCatchError('resolver.raydiumClmm', e); }
    
    // Mark hop as needing tick array validation (builder can check this)
    (hop as any).needsTickArrayValidation = true;
  }
  
  try { logger.debug('raydium.clmm.resolve', { cat: 'tx', ctx: { pool: hop.poolId, lower: hop.tickArrayLower, upper: hop.tickArrayUpper, needsValidation: isPendingValidation } as any }); } catch (e) { logCatchError('resolver.raydiumClmm', e); }
  return hop;
}


