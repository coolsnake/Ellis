/**
 * Raydium CPMM pool resolver
 * 
 * Resolves DirectHop objects for Raydium CPMM pools by enriching them
 * with data from executionCache.
 * 
 * CPMM pools are simpler than CLMM - they use constant product formula
 * and don't require tick array derivation.
 * 
 * Program ID: CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C
 */

import type { DirectHop } from '../../execution/types.js';
import { executionCache } from '../cache.js';
import { peekCpmmPools } from '../../server/pools.cache.js';
import { logger } from '../../utils/logger.js';
import { logCatchError } from '../../utils/errorHandler.js';

// Program ID for Raydium CPMM
const RAYDIUM_CPMM_PROGRAM = 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C';

export async function resolveRaydiumCpmm(hop: DirectHop): Promise<DirectHop> {
  // Strip #rev suffix to match cache key format (pools are cached by base ID)
  const poolIdBase = hop.poolId.replace(/[#-]rev$/, '');
  
  // Get static cache data
  const stat = executionCache.getStatic(poolIdBase);
  
  // Populate hop with cached data
  if (stat?.programId) {
    hop.programId = stat.programId;
  } else {
    // Default to CPMM program ID
    hop.programId = RAYDIUM_CPMM_PROGRAM;
  }
  
  // CRITICAL: Use NATIVE vault ordering for SDK/on-chain compatibility
  // native_account_a/b are the actual on-chain values before canonicalization
  if (!hop.vaultA) {
    hop.vaultA = stat?.native_account_a || stat?.account_a || stat?.vault_a;
  }
  if (!hop.vaultB) {
    hop.vaultB = stat?.native_account_b || stat?.account_b || stat?.vault_b;
  }
  
  // CPMM-specific fields
  if (!hop.ammConfig && stat?.amm_config) {
    hop.ammConfig = stat.amm_config;
  }
  if (!hop.observationId && stat?.observation_key) {
    hop.observationId = stat.observation_key;
  }
  
  // Load mints and decimals (needed for swap instruction building)
  if (!hop.mintIn && stat?.mint_a) {
    // Determine input/output based on swap direction
    // For DirectHop, aToB means input is mint_a
    if (hop.aToB !== false) {
      hop.mintIn = stat.mint_a;
      hop.mintOut = stat.mint_b;
    } else {
      hop.mintIn = stat.mint_b;
      hop.mintOut = stat.mint_a;
    }
  }
  
  // Load decimals
  if (hop.decimalsIn === undefined || hop.decimalsOut === undefined) {
    const decA = stat?.decimals_a ?? stat?.native_decimals_a;
    const decB = stat?.decimals_b ?? stat?.native_decimals_b;
    
    if (hop.aToB !== false) {
      if (hop.decimalsIn === undefined && decA !== undefined) hop.decimalsIn = decA;
      if (hop.decimalsOut === undefined && decB !== undefined) hop.decimalsOut = decB;
    } else {
      if (hop.decimalsIn === undefined && decB !== undefined) hop.decimalsIn = decB;
      if (hop.decimalsOut === undefined && decA !== undefined) hop.decimalsOut = decA;
    }
  }
  
  // Load token programs (needed for Token-2022 support)
  if (!(hop as any).tokenProgramIn) {
    const progA = stat?.token_program_a;
    const progB = stat?.token_program_b;
    
    if (hop.aToB !== false) {
      if (progA) (hop as any).tokenProgramIn = progA;
      if (progB) (hop as any).tokenProgramOut = progB;
    } else {
      if (progB) (hop as any).tokenProgramIn = progB;
      if (progA) (hop as any).tokenProgramOut = progA;
    }
  }
  
  // Fallback: Get data from pool cache if not in execution cache
  if (!hop.vaultA || !hop.vaultB) {
    try {
      const pools = peekCpmmPools();
      const p = pools.cpmm.find(x => x.id === poolIdBase);
      
      if (p) {
        // CRITICAL: Use native vault ordering for SDK/on-chain compatibility
        if (!hop.vaultA) hop.vaultA = p.native_account_a || p.account_a;
        if (!hop.vaultB) hop.vaultB = p.native_account_b || p.account_b;
        if (!hop.ammConfig && p.amm_config) hop.ammConfig = p.amm_config;
        if (!hop.observationId && p.observation_key) hop.observationId = p.observation_key;
        
        // Load mints
        if (!hop.mintIn && p.mint_a) {
          if (hop.aToB !== false) {
            hop.mintIn = p.native_mint_a || p.mint_a;
            hop.mintOut = p.native_mint_b || p.mint_b;
          } else {
            hop.mintIn = p.native_mint_b || p.mint_b;
            hop.mintOut = p.native_mint_a || p.mint_a;
          }
        }
        
        // Load decimals
        if (hop.decimalsIn === undefined || hop.decimalsOut === undefined) {
          const decA = p.native_decimals_a ?? p.decimals_a;
          const decB = p.native_decimals_b ?? p.decimals_b;
          
          if (hop.aToB !== false) {
            if (hop.decimalsIn === undefined && decA !== undefined) hop.decimalsIn = decA;
            if (hop.decimalsOut === undefined && decB !== undefined) hop.decimalsOut = decB;
          } else {
            if (hop.decimalsIn === undefined && decB !== undefined) hop.decimalsIn = decB;
            if (hop.decimalsOut === undefined && decA !== undefined) hop.decimalsOut = decA;
          }
        }
        
        // Load token programs
        if (!(hop as any).tokenProgramIn && p.token_program_a) {
          if (hop.aToB !== false) {
            (hop as any).tokenProgramIn = p.token_program_a;
            (hop as any).tokenProgramOut = p.token_program_b;
          } else {
            (hop as any).tokenProgramIn = p.token_program_b;
            (hop as any).tokenProgramOut = p.token_program_a;
          }
        }
      }
    } catch (e) {
      logCatchError('resolver.raydiumCpmm', e);
    }
  }
  
  // Validate required fields
  const isComplete = !!(hop.vaultA && hop.vaultB && hop.programId);
  
  if (!isComplete) {
    try {
      logger.warn('raydium.cpmm.resolver.incomplete', {
        cat: 'tx',
        ctx: {
          pool: hop.poolId,
          hasVaultA: !!hop.vaultA,
          hasVaultB: !!hop.vaultB,
          hasProgramId: !!hop.programId,
          hasAmmConfig: !!hop.ammConfig,
          hasObservation: !!hop.observationId,
        }
      });
    } catch (e) { logCatchError('resolver.raydiumCpmm', e); }
  }
  
  try {
    logger.debug('raydium.cpmm.resolve', {
      cat: 'tx',
      ctx: {
        pool: hop.poolId,
        vaultA: hop.vaultA?.slice(0, 8) + '…',
        vaultB: hop.vaultB?.slice(0, 8) + '…',
        ammConfig: hop.ammConfig?.slice(0, 8) + '…',
        complete: isComplete,
      }
    });
  } catch (e) { logCatchError('resolver.raydiumCpmm', e); }
  
  return hop;
}
