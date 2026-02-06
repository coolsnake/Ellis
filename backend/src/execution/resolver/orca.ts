import { PublicKey } from '@solana/web3.js';
import type { DirectHop } from '../../execution/types.js';
import { executionCache } from '../cache.js';
import { isValidTickSpacing } from '../constants.js';
import { peekOrcaPools } from '../../server/pools.js';
import { logger } from '../../utils/logger.js';
import { logCatchError } from '../../utils/errorHandler.js';

// Orca Whirlpool program ID (needed for oracle derivation)
const ORCA_WHIRLPOOL_PROGRAM = new PublicKey('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc');

// NOTE: Tick array derivation has been intentionally removed.
// Derived tick array PDAs may not exist on-chain (pools with thin liquidity).
// Tick arrays must come from validated sources:
// 1. Pool fetch with on-chain validation (orca.ts with getMultipleAccountsInfo)
// 2. cacheValidator.ts (explicit validation via /arb/pools/revalidate)
// 3. Pool persistence with REVALIDATE_ON_LOAD=true

/**
 * Derive Orca oracle PDA
 */
function deriveOrcaOracle(poolId: PublicKey): string {
  const [oracle] = PublicKey.findProgramAddressSync(
    [Buffer.from('oracle'), poolId.toBuffer()],
    ORCA_WHIRLPOOL_PROGRAM
  );
  return oracle.toBase58();
}

export async function resolveOrca(hop: DirectHop, traceId?: string): Promise<DirectHop> {
  // CRITICAL: Strip #rev suffix to match cache key format (pools are cached by base ID)
  const poolIdBase = hop.poolId.replace(/[#-]rev$/, '');
  const stat = executionCache.getStatic(poolIdBase);
  if (stat?.programId) hop.programId = stat.programId;
  
  // Load from hot cache for tick arrays (like Raydium CLMM)
  const hot = executionCache.getHot(poolIdBase);
  
  // Check if pool needs tick array validation (boundary crossed or freshly derived)
  // Even if validation pending, still USE the derived arrays - they're usually correct
  // The builder will catch any issues (duplicates, non-existent) at build time
  const cacheNeedsValidation = hot?.needsTickArrayValidation === true;
  
  // If hot cache is missing/expired, we can still derive tick arrays using pool-cache tick_current_index
  // (but pool-cache tick_current_index is often canonicalized/negated when was_swapped=true).
  let poolTickIndexNative: number | undefined;
  
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
      logger.debug('orca.resolver.tick_arrays_from_cache', {
        cat: 'tx',
        traceId,
        ctx: {
          pool: hop.poolId,
          lower: hop.tickArrayLower?.slice(0, 8) + '…' || 'none',
          center: hop.tickArrayCenter?.slice(0, 8) + '…' || 'none',
          upper: hop.tickArrayUpper?.slice(0, 8) + '…' || 'none',
          validated: !cacheNeedsValidation,
          traceId,
        }
      });
    } catch (e) { logCatchError('resolver.orca', e); }
  }
  
  try {
    const pools = peekOrcaPools();
    const p = (pools.clmm || []).find((x: any) => String(x?.id || '') === poolIdBase);
    if (p) {
      // Validate tickSpacing at entry: reject corrupted values (e.g. 32896 = 0x8080 from parse artifacts)
      const rawTs = Number((p as any)?.tick_spacing || (p as any)?.tickSpacing || 0);
      hop.tickSpacing = isValidTickSpacing(rawTs) ? rawTs : (isValidTickSpacing(hop.tickSpacing) ? hop.tickSpacing : 0);
      // Pool cache stores tick_current_index in canonical orientation (negated when was_swapped=true).
      // For tick-array PDA derivation we need NATIVE tick index.
      const tickCanonRaw = (p as any)?.tick_current_index ?? (p as any)?.tickCurrentIndex;
      const tickCanon = Number(tickCanonRaw);
      if (Number.isFinite(tickCanon)) {
        const wasSwapped = (p as any)?.was_swapped === true;
        poolTickIndexNative = wasSwapped ? -tickCanon : tickCanon;
        // Seed hot cache to reduce downstream misses during build validation
        if (hot?.currentTickIndex === undefined) {
          const existingHot = executionCache.getHot(poolIdBase) || {};
          executionCache.setHot(poolIdBase, {
            ...existingHot,
            currentTickIndex: poolTickIndexNative,
            // Only write tickSpacing if validated — don't propagate corruption into cache
            ...(isValidTickSpacing(hop.tickSpacing) ? { tickSpacing: hop.tickSpacing } : {}),
          });
        }
      }
      const oracleFromPool = String((p as any)?.oracle || '');
      if (oracleFromPool) {
        hop.oracle = hop.oracle || oracleFromPool;
      }
      
      // CRITICAL: Use NATIVE vault ordering for Orca
      // token_vault_a/token_vault_b are the on-chain native vault addresses
      // native_account_a/b are also native ordering if available
      // account_a/b may be canonical (swapped) ordering - use as last resort
      const vaultA = (p as any)?.native_account_a || (p as any)?.token_vault_a || (p as any)?.account_a;
      const vaultB = (p as any)?.native_account_b || (p as any)?.token_vault_b || (p as any)?.account_b;
      
      if (vaultA) hop.vaultA = hop.vaultA || String(vaultA);
      if (vaultB) hop.vaultB = hop.vaultB || String(vaultB);
      
      // CRITICAL: Cache vault addresses, oracle, mints, and NATIVE ordering in execution cache
      // This ensures the builder has all required data even if it wasn't in the initial cache population
      const existing = executionCache.getStatic(poolIdBase) || {} as any;
      const updates: any = {};
      
      if (vaultA && vaultB) {
        updates.vaults = {
          a: vaultA,
          b: vaultB
        };
      }
      
      if (oracleFromPool && oracleFromPool !== '11111111111111111111111111111111') {
        updates.oracle = oracleFromPool;
      }
      
      // Populate mints if missing (required by builder for swap direction)
      const poolMintA = (p as any)?.mint_a;
      const poolMintB = (p as any)?.mint_b;
      if (poolMintA && poolMintB && (!existing.mint_a || !existing.mint_b)) {
        updates.mint_a = poolMintA;
        updates.mint_b = poolMintB;
        updates.decimals_a = (p as any)?.decimals_a ?? existing.decimals_a;
        updates.decimals_b = (p as any)?.decimals_b ?? existing.decimals_b;
        updates.programId = existing.programId || (p as any)?.program_id || 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';
      }
      
      // CRITICAL: Store native mint/account ordering for builder's direction logic
      // The builder uses native ordering to determine isAtoB correctly
      const nativeMintA = (p as any)?.native_mint_a;
      const nativeMintB = (p as any)?.native_mint_b;
      const nativeAccountA = (p as any)?.native_account_a;
      const nativeAccountB = (p as any)?.native_account_b;
      
      if (nativeMintA && !existing.native_mint_a) updates.native_mint_a = nativeMintA;
      if (nativeMintB && !existing.native_mint_b) updates.native_mint_b = nativeMintB;
      if (nativeAccountA && !existing.native_account_a) updates.native_account_a = nativeAccountA;
      if (nativeAccountB && !existing.native_account_b) updates.native_account_b = nativeAccountB;
      
      if (Object.keys(updates).length > 0) {
        executionCache.setStatic(poolIdBase, {
          ...existing,
          ...updates
        });
      }
      
      // OPTIMIZATION: Set hop.aToB based on pool mint orientation
      // This enables SDK account caching to work on first call (no warm-up required)
      // Without this, direction resolution in sdkQuoteBuilder would fail on first call
      // because static cache might not be populated yet
      if (hop.aToB === undefined) {
        // Prefer native_mint_a (authoritative), fallback to canonical mint_a with was_swapped
        const poolMintANative = nativeMintA || ((p as any)?.was_swapped ? poolMintB : poolMintA);
        if (poolMintANative) {
          hop.aToB = hop.inputMint === poolMintANative;
          try {
            logger.debug('orca.resolver.direction_resolved', {
              cat: 'tx',
              traceId,
              ctx: {
                pool: hop.poolId,
                inputMint: hop.inputMint?.slice(0, 8) + '…',
                poolMintA: poolMintANative?.slice(0, 8) + '…',
                aToB: hop.aToB,
              }
            });
          } catch (e) { logCatchError('resolver.orca', e); }
        }
      }
    }
  } catch (e) { logCatchError('resolver.orca', e); }
  
  // FALLBACK: Try to set aToB from static cache if pool lookup failed
  // This handles cases where peekOrcaPools() doesn't have the pool but cache does
  if (hop.aToB === undefined) {
    const statAfter = executionCache.getStatic(poolIdBase);
    let poolMintA: string | undefined;
    if (statAfter?.native_mint_a) {
      poolMintA = statAfter.native_mint_a;
    } else if (statAfter?.mint_a) {
      const wasSwapped = statAfter?.was_swapped === true;
      poolMintA = wasSwapped ? statAfter?.mint_b : statAfter?.mint_a;
    }
    if (poolMintA) {
      hop.aToB = hop.inputMint === poolMintA;
    }
  }
  
  // WARNING: Do NOT blindly derive tick arrays - derived PDAs may not exist on-chain!
  // Tick arrays should come from validated sources (pool fetch, websocket updates, or cacheValidator).
  // If tick arrays are missing, log a warning - the builder should handle missing arrays gracefully.
  const hasAllTickArrays = hop.tickArrayLower && hop.tickArrayCenter && hop.tickArrayUpper;
  const isPendingValidation = cacheNeedsValidation || !hasAllTickArrays;
  
  if (isPendingValidation) {
    const currentTick = hot?.currentTickIndex ?? poolTickIndexNative;
    const tickSpacing = hop.tickSpacing || stat?.tickSpacing || stat?.tick_spacing;
    
    try {
      logger.warn('orca.resolver.tick_arrays_incomplete', {
        cat: 'tx',
        traceId,
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
    } catch (e) { logCatchError('resolver.orca', e); }
    
    // Mark hop as needing tick array validation (builder can check this)
    (hop as any).needsTickArrayValidation = true;
  }
  
  // FALLBACK: Derive oracle if still missing
  if (!hop.oracle) {
    try {
      hop.oracle = deriveOrcaOracle(new PublicKey(poolIdBase));
      
      try {
        logger.debug('orca.resolver.oracle_derived', {
          cat: 'tx',
          traceId,
          ctx: {
            pool: hop.poolId,
            oracle: hop.oracle?.slice(0, 8) + '…',
          }
        });
      } catch (e) { logCatchError('resolver.orca', e); }
    } catch (e) {
      logCatchError('resolver.orca.deriveOracle', e);
    }
  }
  
  return hop;
}


