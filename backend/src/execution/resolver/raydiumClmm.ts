import type { DirectHop } from '../../execution/types.js';
import { executionCache } from '../cache.js';
import { peekRaydiumPools } from '../../server/pools.js';

export async function resolveRaydiumClmm(hop: DirectHop): Promise<DirectHop> {
  const stat = executionCache.getStatic(hop.poolId);
  if (stat?.programId) hop.programId = stat.programId;
  try {
    const id = hop.poolId.replace(/-rev$/, '');
    const pools = peekRaydiumPools();
    const p = (pools.clmm || []).find((x: any) => String(x?.id || '') === id);
    if (p) {
      hop.tickSpacing = Number((p as any)?.tick_spacing || (p as any)?.tickSpacing || hop.tickSpacing || 0);
      hop.oracle = String((p as any)?.oracle || '');
      // Placeholder: actual tick array PDAs should be derived; we use pool id hints for now
      hop.tickArrayLower = String((p as any)?.tick_array_lower || '');
      hop.tickArrayCenter = String((p as any)?.tick_array_center || '');
      hop.tickArrayUpper = String((p as any)?.tick_array_upper || '');
      hop.vaultA = String((p as any)?.account_a || '');
      hop.vaultB = String((p as any)?.account_b || '');
    }
  } catch {}
  return hop;
}


