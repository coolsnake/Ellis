import type { DirectHop } from '../../execution/types.js';
import { executionCache } from '../cache.js';
import { peekRaydiumPools } from '../../server/pools.js';
import { determineSwapOrientation } from '../../server/pools/orientation.js';
import { logCatchError } from '../../utils/errorHandler.js';

export async function resolveRaydiumAmm(hop: DirectHop): Promise<DirectHop> {
  const stat = executionCache.getStatic(hop.poolId);
  if (stat?.programId) hop.programId = stat.programId;
  try {
    const pools = peekRaydiumPools();
    const id = hop.poolId.replace(/[#-]rev$/, '');
    const p = (pools.amm || []).find((x: any) => String(x?.id || '') === id);
    if (p) {
      // Determine swap orientation to correctly map decimals
      const orientation = determineSwapOrientation(
        {
          mint_a: (p as any).mint_a,
          mint_b: (p as any).mint_b,
          account_a: (p as any).account_a,
          account_b: (p as any).account_b,
          decimals_a: (p as any).decimals_a,
          decimals_b: (p as any).decimals_b,
        },
        {
          inputMint: hop.inputMint,
          outputMint: hop.outputMint,
          userSourceAta: hop.userSourceAta,
          userDestAta: hop.userDestAta,
          inputDecimals: hop.inputDecimals,
          outputDecimals: hop.outputDecimals,
        }
      );
      
      // Populate vault addresses based on swap direction
      hop.vaultA = orientation.poolVaultInput || String((p as any)?.account_a || '');
      hop.vaultB = orientation.poolVaultOutput || String((p as any)?.account_b || '');
      
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
      
      // Decimals (prefer token meta, but use orientation-aware mapping if needed)
      if (!Number.isFinite(Number(hop.inputDecimals))) {
        hop.inputDecimals = orientation.decimalsInput;
      }
      if (!Number.isFinite(Number(hop.outputDecimals))) {
        hop.outputDecimals = orientation.decimalsOutput;
      }
    }
  } catch (e) { logCatchError('resolver.raydiumAmm', e); }
  return hop;
}


