import type { DirectHop } from '../../execution/types.js';
import { CONFIG } from '../../utils/config.js';
import { executionCache } from '../cache.js';
import { peekMeteoraPools } from '../../server/pools.js';
import { logCatchError } from '../../utils/errorHandler.js';

export async function resolveMeteoraDlmm(hop: DirectHop): Promise<DirectHop> {
  const stat = executionCache.getStatic(hop.poolId);
  if (stat?.programId) hop.programId = stat.programId;
  // Read oracle from static cache
  if (stat?.oracle && !hop.oracle) hop.oracle = stat.oracle;
  const tokenProgramA = stat?.token_program_a;
  const tokenProgramB = stat?.token_program_b;
  if (!tokenProgramA || !tokenProgramB) {
    try {
      const { logger } = await import('../../utils/logger.js');
      logger.warn('meteora.resolver.token_program.missing', {
        cat: 'tx',
        ctx: {
          poolId: hop.poolId,
          hasA: !!tokenProgramA,
          hasB: !!tokenProgramB,
        },
      });
    } catch (e) { logCatchError('resolver.meteora', e); }
  }
  (hop as any).tokenProgramA = tokenProgramA;
  (hop as any).tokenProgramB = tokenProgramB;
  // Fallback to configured DLMM programId if still missing (helps builder)
  try { if (!hop.programId && (CONFIG as any)?.meteora?.programId) hop.programId = String((CONFIG as any)?.meteora?.programId); } catch (e) { logCatchError('resolver.meteora', e); }
  try {
    const pools = peekMeteoraPools();
    const id = hop.poolId.replace(/[#-]rev$/, '');
    const p = (pools.clmm || []).find((x: any) => String(x?.id || '') === id);
    
    // Debug logging for pool lookup
    try {
      const { logger } = await import('../../utils/logger.js');
      logger.info('meteora.resolver.pool_lookup', {
        cat: 'tx',
        ctx: {
          poolId: hop.poolId,
          strippedId: id,
          poolFound: !!p,
          poolCount: (pools.clmm || []).length
        }
      });
    } catch (e) { logCatchError('resolver.meteora', e); }
    
    if (p) {
      hop.binStep = Number((p as any)?.bin_step || (p as any)?.binStep || hop.binStep || 0);
      hop.activeId = Number((p as any)?.active_id || (p as any)?.activeId || hop.activeId || 0);
      
      // Get oracle from pool cache
      const oracleFromPool = String((p as any)?.oracle || '');
      if (oracleFromPool && !hop.oracle) hop.oracle = oracleFromPool;
      
      // NOTE: vaultA/vaultB always represent the pool's natural token order (mint_a/mint_b)
      // The instruction builder will handle mapping these to reserves based on swap direction
      const accountA = String((p as any)?.account_a || '');
      const accountB = String((p as any)?.account_b || '');
      hop.vaultA = accountA;
      hop.vaultB = accountB;
      
      // CRITICAL: Set reserveX/reserveY from native reserve_x/reserve_y (not canonical accounts!)
      // These are the on-chain lbPair.reserveX and lbPair.reserveY addresses
      // The Meteora has_one constraint validates these directly against the lbPair
      const nativeReserveX = String((p as any)?.reserve_x || '');
      const nativeReserveY = String((p as any)?.reserve_y || '');
      if (nativeReserveX) hop.reserveX = nativeReserveX;
      if (nativeReserveY) hop.reserveY = nativeReserveY;
      
      // Pass bitmap extension from pool cache (checked during pool normalization)
      const bitmapExt = String((p as any)?.bin_array_bitmap_extension || '');
      if (bitmapExt) {
        hop.bitmapExtension = bitmapExt;
      }
      
      // Extract all 5 bin arrays from pool cache
      const binActive = String((p as any)?.bin_array_active || '');
      const binLower = String((p as any)?.bin_array_lower || '');
      const binLower2 = String((p as any)?.bin_array_lower2 || '');
      const binUpper = String((p as any)?.bin_array_upper || '');
      const binUpper2 = String((p as any)?.bin_array_upper2 || '');
      if (binActive) (hop as any).binArrayActive = binActive;
      if (binLower && !hop.binArrayLower) hop.binArrayLower = binLower;
      if (binLower2) (hop as any).binArrayLower2 = binLower2;
      if (binUpper && !hop.binArrayUpper) hop.binArrayUpper = binUpper;
      if (binUpper2) (hop as any).binArrayUpper2 = binUpper2;
      
      // Extract token programs from pool cache if not in executionCache
      // This eliminates RPC calls in the builder for token program detection
      if (!tokenProgramA || !tokenProgramB) {
        const poolTokenA = (p as any)?.token_program_a as 'spl-token' | 'token-2022' | undefined;
        const poolTokenB = (p as any)?.token_program_b as 'spl-token' | 'token-2022' | undefined;
        if (poolTokenA) (hop as any).tokenProgramA = poolTokenA;
        if (poolTokenB) (hop as any).tokenProgramB = poolTokenB;
      }
      
      // Populate execution cache with mint_a/mint_b, native ordering, and other critical fields
      // This ensures the builder has mints and native ordering available for direction logic
      const poolMintA = (p as any)?.mint_a;
      const poolMintB = (p as any)?.mint_b;
      const nativeMintA = (p as any)?.native_mint_a;
      const nativeMintB = (p as any)?.native_mint_b;
      const existingStatic = executionCache.getStatic(id) || {} as any;
      
      // Update cache if critical fields are missing (mints, native ordering)
      const needsUpdate = 
        (poolMintA && poolMintB && (!existingStatic.mint_a || !existingStatic.mint_b)) ||
        (nativeMintA && !existingStatic.native_mint_a) ||
        (nativeReserveX && !existingStatic.reserve_x);
      
      if (needsUpdate) {
        executionCache.setStatic(id, {
          ...existingStatic,
          programId: existingStatic.programId || 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',
          dex: 'Meteora',
          mint_a: poolMintA || existingStatic.mint_a,
          mint_b: poolMintB || existingStatic.mint_b,
          // CRITICAL: Store native ordering for builder's direction logic
          native_mint_a: nativeMintA || existingStatic.native_mint_a,
          native_mint_b: nativeMintB || existingStatic.native_mint_b,
          native_account_a: (p as any)?.native_account_a || existingStatic.native_account_a,
          native_account_b: (p as any)?.native_account_b || existingStatic.native_account_b,
          // Native reserves (on-chain lbPair.reserveX/reserveY)
          reserve_x: nativeReserveX || existingStatic.reserve_x,
          reserve_y: nativeReserveY || existingStatic.reserve_y,
          decimals_a: (p as any)?.decimals_a ?? existingStatic.decimals_a,
          decimals_b: (p as any)?.decimals_b ?? existingStatic.decimals_b,
          token_program_a: (p as any)?.token_program_a || existingStatic.token_program_a,
          token_program_b: (p as any)?.token_program_b || existingStatic.token_program_b,
          account_a: (p as any)?.account_a || existingStatic.account_a,
          account_b: (p as any)?.account_b || existingStatic.account_b,
          bin_array_bitmap_extension: (p as any)?.bin_array_bitmap_extension || existingStatic.bin_array_bitmap_extension,
          oracle: (p as any)?.oracle || existingStatic.oracle,
          was_swapped: (p as any)?.was_swapped ?? existingStatic.was_swapped,
        });
      }
      
      // Debug logging for vaults, reserves, bitmap extension, and oracle
      try {
        const { logger } = await import('../../utils/logger.js');
        logger.info('meteora.resolver.accounts_set', {
          cat: 'tx',
          ctx: {
            poolId: hop.poolId,
            // Canonical accounts (may be swapped)
            vaultA: accountA,
            vaultB: accountB,
            // Native reserves (on-chain lbPair ordering - NOT swapped)
            reserveX: nativeReserveX || 'not_cached',
            reserveY: nativeReserveY || 'not_cached',
            hasReserveX: !!nativeReserveX,
            hasReserveY: !!nativeReserveY,
            bitmapExtension: bitmapExt || 'not_cached',
            hasBitmapExtension: !!bitmapExt,
            oracle: hop.oracle || 'not_cached',
            hasOracle: !!hop.oracle
          }
        });
      } catch (e) { logCatchError('resolver.meteora', e); }
    } else {
      // Debug logging for pool not found
      try {
        const { logger } = await import('../../utils/logger.js');
        logger.warn('meteora.resolver.pool_not_found', {
          cat: 'tx',
          ctx: {
            poolId: hop.poolId,
            strippedId: id
          }
        });
      } catch (e) { logCatchError('resolver.meteora', e); }
    }
  } catch (e: any) {
    try {
      const { logger } = await import('../../utils/logger.js');
      logger.warn('meteora.resolver.error', {
        cat: 'tx',
        ctx: {
          poolId: hop.poolId,
          error: String(e?.message || e)
        }
      });
    } catch (e) { logCatchError('resolver.meteora', e); }
  }
  return hop;
}


