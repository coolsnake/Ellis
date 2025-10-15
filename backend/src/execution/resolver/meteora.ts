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
    if (p) {
      hop.binStep = Number((p as any)?.bin_step || (p as any)?.binStep || hop.binStep || 0);
      hop.activeId = Number((p as any)?.active_id || (p as any)?.activeId || hop.activeId || 0);
      hop.vaultA = String((p as any)?.account_a || '');
      hop.vaultB = String((p as any)?.account_b || '');
    }
  } catch {}
  return hop;
}


