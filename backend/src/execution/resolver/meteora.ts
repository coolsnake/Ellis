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
      
      // CRITICAL FIX: Check if hop direction matches pool mint order
      // If pool is mint_a -> mint_b but hop is mint_b -> mint_a, swap the vaults
      const poolMintA = String((p as any)?.mint_a || (p as any)?.mintA || '');
      const poolMintB = String((p as any)?.mint_b || (p as any)?.mintB || '');
      const accountA = String((p as any)?.account_a || '');
      const accountB = String((p as any)?.account_b || '');
      
      if (poolMintA && poolMintB && accountA && accountB) {
        // Check if hop input/output matches pool mint_a/mint_b order
        const isNaturalDirection = (hop.inputMint === poolMintA && hop.outputMint === poolMintB);
        const isReversedDirection = (hop.inputMint === poolMintB && hop.outputMint === poolMintA);
        
        if (isNaturalDirection) {
          // Natural direction: input=mint_a, output=mint_b
          // Use account_a as vaultA (input vault), account_b as vaultB (output vault)
          hop.vaultA = accountA;
          hop.vaultB = accountB;
        } else if (isReversedDirection) {
          // Reversed direction: input=mint_b, output=mint_a
          // Swap vaults: use account_b as vaultA (input vault), account_a as vaultB (output vault)
          hop.vaultA = accountB;
          hop.vaultB = accountA;
        } else {
          // Fallback if mints don't match (shouldn't happen in normal operation)
          hop.vaultA = accountA;
          hop.vaultB = accountB;
        }
      } else {
        // Fallback if mint/account data is missing
        hop.vaultA = accountA;
        hop.vaultB = accountB;
      }
    }
  } catch {}
  return hop;
}


