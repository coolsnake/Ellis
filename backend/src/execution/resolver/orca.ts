import { PublicKey } from '@solana/web3.js';
import type { DirectHop } from '../../execution/types.js';
import { executionCache } from '../cache.js';
import { peekOrcaPools } from '../../server/pools.js';
import { logger } from '../../utils/logger.js';
import { logCatchError } from '../../utils/errorHandler.js';

// Constants for tick array derivation
const ORCA_WHIRLPOOL_PROGRAM = new PublicKey('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc');
const ORCA_TICK_ARRAY_SIZE = 88;

/**
 * Derive Orca tick array PDAs from current tick and tick spacing
 */
function deriveOrcaTickArrays(
  poolId: PublicKey,
  currentTickIndex: number,
  tickSpacing: number
): { lower: string; center: string; upper: string } {
  const ticksInArray = ORCA_TICK_ARRAY_SIZE * tickSpacing;
  const realIndex = Math.floor(currentTickIndex / ticksInArray);
  
  const deriveTickArrayPda = (startTickIndex: number): PublicKey => {
    const startTickBuffer = Buffer.alloc(4);
    startTickBuffer.writeInt32LE(startTickIndex, 0);
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from('tick_array'), poolId.toBuffer(), startTickBuffer],
      ORCA_WHIRLPOOL_PROGRAM
    );
    return pda;
  };
  
  return {
    lower: deriveTickArrayPda((realIndex - 1) * ticksInArray).toBase58(),
    center: deriveTickArrayPda(realIndex * ticksInArray).toBase58(),
    upper: deriveTickArrayPda((realIndex + 1) * ticksInArray).toBase58(),
  };
}

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
  const stat = executionCache.getStatic(hop.poolId);
  if (stat?.programId) hop.programId = stat.programId;
  
  // Load from hot cache for tick arrays (like Raydium CLMM)
  const hot = executionCache.getHot(hop.poolId);
  if (hot?.tickArrays) {
    // Handle arrays for lower/upper (take first element), string for center
    hop.tickArrayLower = (Array.isArray(hot.tickArrays.lower) ? hot.tickArrays.lower[0] : hot.tickArrays.lower) || hop.tickArrayLower;
    hop.tickArrayCenter = hot.tickArrays.center || hop.tickArrayCenter;
    hop.tickArrayUpper = (Array.isArray(hot.tickArrays.upper) ? hot.tickArrays.upper[0] : hot.tickArrays.upper) || hop.tickArrayUpper;
    
    try {
      logger.info('orca.resolver.tick_arrays_from_cache', {
        cat: 'tx',
        traceId,
        ctx: {
          pool: hop.poolId,
          lower: hop.tickArrayLower?.slice(0, 8) + '…' || 'none',
          center: hop.tickArrayCenter?.slice(0, 8) + '…' || 'none',
          upper: hop.tickArrayUpper?.slice(0, 8) + '…' || 'none',
          traceId,
        }
      });
    } catch (e) { logCatchError('resolver.orca', e); }
  }
  
  try {
    const pools = peekOrcaPools();
    const id = hop.poolId.replace(/[#-]rev$/, '');
    const p = (pools.clmm || []).find((x: any) => String(x?.id || '') === id);
    if (p) {
      hop.tickSpacing = Number((p as any)?.tick_spacing || (p as any)?.tickSpacing || hop.tickSpacing || 0);
      const oracleFromPool = String((p as any)?.oracle || '');
      if (oracleFromPool) {
        hop.oracle = hop.oracle || oracleFromPool;
      }
      
      // Get vault addresses from pool data (prefer token_vault_a/token_vault_b, fallback to account_a/account_b)
      const vaultA = (p as any)?.token_vault_a || (p as any)?.account_a;
      const vaultB = (p as any)?.token_vault_b || (p as any)?.account_b;
      
      if (vaultA) hop.vaultA = hop.vaultA || String(vaultA);
      if (vaultB) hop.vaultB = hop.vaultB || String(vaultB);
      
      // CRITICAL: Cache vault addresses, oracle, and mints in execution cache if we found them
      // This ensures the builder has all required data even if it wasn't in the initial cache population
      const existing = executionCache.getStatic(hop.poolId) || {} as any;
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
      
      // Populate mints if missing (required by buildOrcaSwapIxLocal for swap direction)
      const poolMintA = (p as any)?.mint_a;
      const poolMintB = (p as any)?.mint_b;
      if (poolMintA && poolMintB && (!existing.mint_a || !existing.mint_b)) {
        updates.mint_a = poolMintA;
        updates.mint_b = poolMintB;
        updates.decimals_a = (p as any)?.decimals_a ?? existing.decimals_a;
        updates.decimals_b = (p as any)?.decimals_b ?? existing.decimals_b;
        updates.programId = existing.programId || (p as any)?.program_id || 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';
      }
      
      if (Object.keys(updates).length > 0) {
        executionCache.setStatic(hop.poolId, {
          ...existing,
          ...updates
        });
      }
    }
  } catch (e) { logCatchError('resolver.orca', e); }
  
  // FALLBACK: If tick arrays are still missing, derive them from current tick and tick spacing
  if (!hop.tickArrayLower || !hop.tickArrayCenter || !hop.tickArrayUpper) {
    const currentTick = hot?.currentTickIndex;
    const tickSpacing = hop.tickSpacing || stat?.tickSpacing || stat?.tick_spacing;
    
    if (currentTick !== undefined && tickSpacing && tickSpacing > 0) {
      try {
        const poolId = hop.poolId.replace(/[#-]rev$/, '');
        const poolPk = new PublicKey(poolId);
        const derived = deriveOrcaTickArrays(poolPk, currentTick, tickSpacing);
        
        if (!hop.tickArrayLower) hop.tickArrayLower = derived.lower;
        if (!hop.tickArrayCenter) hop.tickArrayCenter = derived.center;
        if (!hop.tickArrayUpper) hop.tickArrayUpper = derived.upper;
        
        // Also update hot cache for future use
        const existingHot = executionCache.getHot(poolId) || {};
        executionCache.setHot(poolId, {
          ...existingHot,
          tickArrays: {
            lower: hop.tickArrayLower,
            center: hop.tickArrayCenter,
            upper: hop.tickArrayUpper,
          },
        });
        
        try {
          logger.info('orca.resolver.tick_arrays_derived', {
            cat: 'tx',
            traceId,
            ctx: {
              pool: hop.poolId,
              currentTick,
              tickSpacing,
              lower: hop.tickArrayLower?.slice(0, 8) + '…',
              center: hop.tickArrayCenter?.slice(0, 8) + '…',
              upper: hop.tickArrayUpper?.slice(0, 8) + '…',
            }
          });
        } catch (e) { logCatchError('resolver.orca', e); }
      } catch (e) {
        logCatchError('resolver.orca.deriveTickArrays', e);
      }
    } else {
      try {
        logger.warn('orca.resolver.tick_arrays_missing', {
          cat: 'tx',
          traceId,
          ctx: {
            pool: hop.poolId,
            hasCurrentTick: currentTick !== undefined,
            hasTickSpacing: !!tickSpacing,
          }
        });
      } catch (e) { logCatchError('resolver.orca', e); }
    }
  }
  
  // FALLBACK: Derive oracle if still missing
  if (!hop.oracle) {
    try {
      const poolId = hop.poolId.replace(/[#-]rev$/, '');
      hop.oracle = deriveOrcaOracle(new PublicKey(poolId));
      
      try {
        logger.info('orca.resolver.oracle_derived', {
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


