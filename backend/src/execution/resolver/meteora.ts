import type { DirectHop } from '../../execution/types.js';
import { CONFIG } from '../../utils/config.js';
import { executionCache } from '../cache.js';
import { peekMeteoraPools } from '../../server/pools.js';

export async function resolveMeteoraDlmm(hop: DirectHop): Promise<DirectHop> {
  const stat = executionCache.getStatic(hop.poolId);
  if (stat?.programId) hop.programId = stat.programId;
  // Fallback to configured DLMM programId if still missing (helps builder)
  try { if (!hop.programId && (CONFIG as any)?.meteora?.programId) hop.programId = String((CONFIG as any)?.meteora?.programId); } catch {}
  try {
    const pools = peekMeteoraPools();
    const id = hop.poolId.replace(/-rev$/, '');
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
    } catch {}
    
    if (p) {
      hop.binStep = Number((p as any)?.bin_step || (p as any)?.binStep || hop.binStep || 0);
      hop.activeId = Number((p as any)?.active_id || (p as any)?.activeId || hop.activeId || 0);
      // NOTE: vaultA/vaultB always represent the pool's natural token order (mint_a/mint_b)
      // The instruction builder will handle mapping these to reserves based on swap direction
      const accountA = String((p as any)?.account_a || '');
      const accountB = String((p as any)?.account_b || '');
      hop.vaultA = accountA;
      hop.vaultB = accountB;
      
      // Pass bitmap extension from pool cache (checked during pool normalization)
      const bitmapExt = String((p as any)?.bin_array_bitmap_extension || '');
      if (bitmapExt) {
        hop.bitmapExtension = bitmapExt;
      }
      
      // Debug logging for vaults and bitmap extension
      try {
        const { logger } = await import('../../utils/logger.js');
        logger.info('meteora.resolver.accounts_set', {
          cat: 'tx',
          ctx: {
            poolId: hop.poolId,
            vaultA: accountA,
            vaultB: accountB,
            hasVaultA: !!accountA,
            hasVaultB: !!accountB,
            bitmapExtension: bitmapExt || 'not_cached',
            hasBitmapExtension: !!bitmapExt
          }
        });
      } catch {}
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
      } catch {}
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
    } catch {}
  }
  return hop;
}


