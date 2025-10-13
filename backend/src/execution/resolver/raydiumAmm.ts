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
      // Populate market / serum program if available from normalized payload
      hop.market = String((p as any)?.market || (p as any)?.market_id || '');
      hop.serumProgramId = String((p as any)?.market_program_id || (p as any)?.marketProgramId || '');
      // Decimals (prefer token meta, but keep as fallback if provided)
      if (!Number.isFinite(Number(hop.inputDecimals)) && Number.isFinite((p as any)?.decimals_a)) hop.inputDecimals = Number((p as any)?.decimals_a);
      if (!Number.isFinite(Number(hop.outputDecimals)) && Number.isFinite((p as any)?.decimals_b)) hop.outputDecimals = Number((p as any)?.decimals_b);
    }
  } catch {}
  return hop;
}


