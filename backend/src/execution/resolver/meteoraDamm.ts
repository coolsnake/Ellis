import type { DirectHop } from '../../execution/types.js';
import { executionCache } from '../cache.js';
import { determineSwapOrientation } from '../../server/pools/orientation.js';
import { PublicKey } from '@solana/web3.js';

// Program IDs for DAMM v1 and v2
const METEORA_DAMM_V1_PROGRAM = 'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB';
const METEORA_DAMM_V2_PROGRAM = 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG';

/**
 * Derive pool authority PDA for Meteora DAMM
 */
function derivePoolAuthority(poolId: string, programId: string, isV2: boolean): string {
  try {
    const pool = new PublicKey(poolId);
    const program = new PublicKey(programId);
    const seed = isV2 ? 'pool_authority' : 'vault_and_lp_mint_auth_pda';
    const [authority] = PublicKey.findProgramAddressSync(
      [Buffer.from(seed), pool.toBuffer()],
      program
    );
    return authority.toBase58();
  } catch {
    return poolId; // Fallback to pool ID if derivation fails
  }
}

/**
 * Resolver for Meteora Balanced (DAMM) pools - both v1 and v2
 * Populates vault addresses, pool authority, and reserve data for on-chain router execution
 */
export async function resolveMeteoraDamm(hop: DirectHop): Promise<DirectHop> {
  const stat = executionCache.getStatic(hop.poolId);
  if (stat?.programId) hop.programId = stat.programId;
  
  // Determine if this is v1 or v2 based on variant or program ID
  const isV2 = hop.variant === 'damm_v2' || hop.programId === METEORA_DAMM_V2_PROGRAM;
  
  // Set default program ID based on variant if not already set
  if (!hop.programId) {
    hop.programId = isV2 ? METEORA_DAMM_V2_PROGRAM : METEORA_DAMM_V1_PROGRAM;
  }
  
  try {
    // Import Meteora Balanced pools from server cache
    const { peekMeteoraBalancedPools } = await import('../../server/pools.js');
    const pools = peekMeteoraBalancedPools();
    const id = hop.poolId.replace(/[#-]rev$/, '');
    const p = (pools.amm || []).find((x: any) => String(x?.id || '') === id);
    
    if (p) {
      // Determine swap orientation to correctly map decimals and reserves
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
      
      // Store pool address for swap instruction
      (hop as any).poolAddress = String((p as any)?.id || id);
      
      // Decimals (prefer token meta, but use orientation-aware mapping if needed)
      if (!Number.isFinite(Number(hop.inputDecimals))) {
        hop.inputDecimals = orientation.decimalsInput;
      }
      if (!Number.isFinite(Number(hop.outputDecimals))) {
        hop.outputDecimals = orientation.decimalsOutput;
      }
      
      // Store reserve data for quoting (orientation-aware)
      // ReserveA should be the input reserve, ReserveB should be the output reserve
      // For DAMM, we use the vault balances (amount_a_whole, amount_b_whole)
      if (orientation.inputIsA) {
        if ((p as any)?.amount_a_whole != null) {
          (hop as any).reserveA = Number((p as any).amount_a_whole);
        }
        if ((p as any)?.amount_b_whole != null) {
          (hop as any).reserveB = Number((p as any).amount_b_whole);
        }
      } else {
        // Reverse direction: input is B, output is A
        if ((p as any)?.amount_b_whole != null) {
          (hop as any).reserveA = Number((p as any).amount_b_whole);
        }
        if ((p as any)?.amount_a_whole != null) {
          (hop as any).reserveB = Number((p as any).amount_a_whole);
        }
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
      
      // Derive and store pool authority for router usage
      const poolAuthority = derivePoolAuthority(id, hop.programId, isV2);
      (hop as any).poolAuthority = poolAuthority;
    }
  } catch (e) {
    // Silently fail - hop will use defaults
  }
  
  // Ensure pool authority is set even if pool lookup failed
  if (!(hop as any).poolAuthority && hop.programId) {
    (hop as any).poolAuthority = derivePoolAuthority(
      hop.poolId.replace(/[#-]rev$/, ''),
      hop.programId,
      isV2
    );
  }
  
  return hop;
}

