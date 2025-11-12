import type { DirectHop } from '../../execution/types.js';
import { executionCache } from '../cache.js';

/**
 * Resolver for Meteora Balanced (DAMM) pools - both v1 and v2
 * Populates vault addresses and reserve data for constant product AMM quoting
 */
export async function resolveMeteoraDamm(hop: DirectHop): Promise<DirectHop> {
  const stat = executionCache.getStatic(hop.poolId);
  if (stat?.programId) hop.programId = stat.programId;
  
  try {
    // Import Meteora Balanced pools from server cache
    const { peekMeteoraBalancedPools } = await import('../../server/pools.js');
    const pools = peekMeteoraBalancedPools();
    const id = hop.poolId.replace(/-rev$/, '');
    const p = (pools.amm || []).find((x: any) => String(x?.id || '') === id);
    
    if (p) {
      // Populate vault addresses (token accounts for token A and B)
      hop.vaultA = String((p as any)?.vault_a || '');
      hop.vaultB = String((p as any)?.vault_b || '');
      
      // Store pool address for swap instruction
      (hop as any).poolAddress = String((p as any)?.address || id);
      
      // Decimals (prefer token meta, but keep as fallback if provided)
      if (!Number.isFinite(Number(hop.inputDecimals)) && Number.isFinite((p as any)?.decimals_a)) {
        hop.inputDecimals = Number((p as any)?.decimals_a);
      }
      if (!Number.isFinite(Number(hop.outputDecimals)) && Number.isFinite((p as any)?.decimals_b)) {
        hop.outputDecimals = Number((p as any)?.decimals_b);
      }
      
      // Store reserve data for quoting
      // For DAMM, we use the vault balances (amount_a_whole, amount_b_whole)
      if ((p as any)?.amount_a_whole != null) {
        (hop as any).reserveA = Number((p as any).amount_a_whole);
      }
      if ((p as any)?.amount_b_whole != null) {
        (hop as any).reserveB = Number((p as any).amount_b_whole);
      }
      
      // Store fee (fee_bps) for accurate quoting
      if ((p as any)?.fee_bps != null) {
        (hop as any).feeBps = Number((p as any).fee_bps);
      }
      
      // Store LP mint for potential future use
      if ((p as any)?.mint_lp) {
        (hop as any).lpMint = String((p as any).mint_lp);
      }
      
      // Store token programs if specified
      if ((p as any)?.token_program_a) {
        (hop as any).tokenProgramA = String((p as any).token_program_a);
      }
      if ((p as any)?.token_program_b) {
        (hop as any).tokenProgramB = String((p as any).token_program_b);
      }
    }
  } catch (e) {
    // Silently fail - hop will use defaults
  }
  
  return hop;
}

