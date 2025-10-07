import type { DirectHop } from '../../execution/types.js';
import { executionCache } from '../cache.js';

export async function resolveRaydiumClmm(hop: DirectHop): Promise<DirectHop> {
  const stat = executionCache.getStatic(hop.poolId);
  if (stat?.programId) hop.programId = stat.programId;
  // Future: set tick arrays, oracle, tick spacing
  return hop;
}


