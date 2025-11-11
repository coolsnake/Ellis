import type { DirectHop } from '../../execution/types.js';
import { executionCache } from '../cache.js';

export async function resolvePumpswap(hop: DirectHop): Promise<DirectHop> {
  const stat = executionCache.getStatic(hop.poolId);
  if (stat?.programId) hop.programId = stat.programId;
  
  try {
    // Import Pumpswap pools from server cache
    const { peekPumpswapPools } = await import('../../server/pools.js');
    const pools = peekPumpswapPools();
    const id = hop.poolId.replace(/-rev$/, '');
    const p = (pools.amm || []).find((x: any) => String(x?.id || '') === id);
    
    if (p) {
      // Populate vault addresses (token accounts for base and quote)
      hop.vaultA = String((p as any)?.account_a || '');
      hop.vaultB = String((p as any)?.account_b || '');
      
      // Pumpswap AMM doesn't use authority/openOrders like Raydium
      // Store any additional pool-specific data if needed
      
      // Decimals (prefer token meta, but keep as fallback if provided)
      if (!Number.isFinite(Number(hop.inputDecimals)) && Number.isFinite((p as any)?.decimals_a)) {
        hop.inputDecimals = Number((p as any)?.decimals_a);
      }
      if (!Number.isFinite(Number(hop.outputDecimals)) && Number.isFinite((p as any)?.decimals_b)) {
        hop.outputDecimals = Number((p as any)?.decimals_b);
      }
      
      // Store reserve data for quoting (if available from RPC enrichment)
      if ((p as any)?.amount_a_whole) {
        (hop as any).reserveA = Number((p as any).amount_a_whole);
      }
      if ((p as any)?.amount_b_whole) {
        (hop as any).reserveB = Number((p as any).amount_b_whole);
      }
    }
  } catch (e) {
    // Silently fail - hop will use defaults
  }
  
  return hop;
}

