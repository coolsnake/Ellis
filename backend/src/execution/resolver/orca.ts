import type { DirectHop } from '../../execution/types.js';
import { executionCache } from '../cache.js';
import { peekOrcaPools } from '../../server/pools.js';
import { logger } from '../../utils/logger.js';

export async function resolveOrca(hop: DirectHop): Promise<DirectHop> {
  const stat = executionCache.getStatic(hop.poolId);
  if (stat?.programId) hop.programId = stat.programId;
  
  // Load from hot cache for tick arrays (like Raydium CLMM)
  const hot = executionCache.getHot(hop.poolId);
  if (hot?.tickArrays) {
    // Handle arrays for lower/upper (take first element), string for center
    hop.tickArrayLower = (Array.isArray(hot.tickArrays.lower) ? hot.tickArrays.lower[0] : hot.tickArrays.lower) || hop.tickArrayLower;
    hop.tickArrayCenter = hot.tickArrays.center || hop.tickArrayCenter;
    hop.tickArrayUpper = (Array.isArray(hot.tickArrays.upper) ? hot.tickArrays.upper[0] : hot.tickArrays.upper) || hop.tickArrayUpper;
    
    try {
      logger.info('orca.resolver.tick_arrays_from_cache', {
        cat: 'tx',
        ctx: {
          pool: hop.poolId,
          lower: hop.tickArrayLower?.slice(0, 8) + '…' || 'none',
          center: hop.tickArrayCenter?.slice(0, 8) + '…' || 'none',
          upper: hop.tickArrayUpper?.slice(0, 8) + '…' || 'none'
        }
      });
    } catch {}
  }
  
  try {
    const pools = peekOrcaPools();
    const id = hop.poolId.replace(/[#-]rev$/, '');
    const p = (pools.clmm || []).find((x: any) => String(x?.id || '') === id);
    if (p) {
      hop.tickSpacing = Number((p as any)?.tick_spacing || (p as any)?.tickSpacing || hop.tickSpacing || 0);
      const oracleFromPool = String((p as any)?.oracle || '');
      if (oracleFromPool) {
        hop.oracle = hop.oracle || oracleFromPool;
      }
      
      // Get vault addresses from pool data (prefer token_vault_a/token_vault_b, fallback to account_a/account_b)
      const vaultA = (p as any)?.token_vault_a || (p as any)?.account_a;
      const vaultB = (p as any)?.token_vault_b || (p as any)?.account_b;
      
      if (vaultA) hop.vaultA = hop.vaultA || String(vaultA);
      if (vaultB) hop.vaultB = hop.vaultB || String(vaultB);
      
      // CRITICAL: Cache vault addresses and oracle in execution cache if we found them
      const existing = executionCache.getStatic(hop.poolId) || {} as any;
      const updates: any = {};
      
      if (vaultA && vaultB) {
        updates.vaults = {
          a: vaultA,
          b: vaultB
        };
      }
      
      if (oracleFromPool && oracleFromPool !== '11111111111111111111111111111111') {
        updates.oracle = oracleFromPool;
      }
      
      if (Object.keys(updates).length > 0) {
        executionCache.setStatic(hop.poolId, {
          ...existing,
          ...updates
        });
      }
    }
  } catch {}
  return hop;
}


