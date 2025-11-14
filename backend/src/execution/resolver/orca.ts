import type { DirectHop } from '../../execution/types.js';
import { executionCache } from '../cache.js';
import { peekOrcaPools } from '../../server/pools.js';
import { logger } from '../../utils/logger.js';

export async function resolveOrca(hop: DirectHop): Promise<DirectHop> {
  const stat = executionCache.getStatic(hop.poolId);
  if (stat?.programId) hop.programId = stat.programId;
  
  // Load from hot cache for tick arrays (like Raydium CLMM)
  const hot = executionCache.getHot(hop.poolId);
  if (hot?.tickArrays) {
    hop.tickArrayLower = hot.tickArrays.lower || hop.tickArrayLower;
    hop.tickArrayCenter = hot.tickArrays.center || hop.tickArrayCenter;
    hop.tickArrayUpper = hot.tickArrays.upper || hop.tickArrayUpper;
    
    try {
      logger.info('orca.resolver.tick_arrays_from_cache', {
        cat: 'tx',
        ctx: {
          pool: hop.poolId,
          lower: hop.tickArrayLower?.slice(0, 8) + '…' || 'none',
          center: hop.tickArrayCenter?.slice(0, 8) + '…' || 'none',
          upper: hop.tickArrayUpper?.slice(0, 8) + '…' || 'none'
        }
      });
    } catch {}
  }
  
  try {
    const pools = peekOrcaPools();
    const id = hop.poolId.replace(/-rev$/, '');
    const p = (pools.clmm || []).find((x: any) => String(x?.id || '') === id);
    if (p) {
      hop.tickSpacing = Number((p as any)?.tick_spacing || (p as any)?.tickSpacing || hop.tickSpacing || 0);
      hop.oracle = hop.oracle || String((p as any)?.oracle || '');
      hop.vaultA = hop.vaultA || String((p as any)?.account_a || '');
      hop.vaultB = hop.vaultB || String((p as any)?.account_b || '');
    }
  } catch {}
  return hop;
}


