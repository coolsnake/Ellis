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
      // For Raydium AMM v4, use hardcoded authority (not stored in pool data)
      const programId = hop.programId || stat?.programId || '';
      if (programId === '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8') {
        const { CONFIG } = await import('../../utils/config.js');
        hop.ammAuthority = String((CONFIG as any)?.raydium?.ammV4Authority || '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1');
      } else {
        hop.ammAuthority = String((p as any)?.authority || (p as any)?.amm_authority || '');
      }
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


