import type { DirectHop } from '../../execution/types.js';
import { executionCache } from '../cache.js';
import { peekRaydiumPools } from '../../server/pools.js';

export async function resolveRaydiumAmm(hop: DirectHop): Promise<DirectHop> {
  const stat = executionCache.getStatic(hop.poolId);
  if (stat?.programId) hop.programId = stat.programId;
  try {
    const pools = peekRaydiumPools();
    const id = hop.poolId.replace(/-rev$/, '');
    const p = (pools.amm || []).find((x: any) => String(x?.id || '') === id);
    if (p) {
      hop.vaultA = String((p as any)?.account_a || '');
      hop.vaultB = String((p as any)?.account_b || '');
      hop.ammAuthority = String((p as any)?.authority || (p as any)?.amm_authority || '');
    }
  } catch {}
  return hop;
}


