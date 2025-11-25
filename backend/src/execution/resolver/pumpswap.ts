import type { DirectHop } from '../../execution/types.js';
import { executionCache } from '../cache.js';
import { determineSwapOrientation } from '../../server/pools/orientation.js';

export async function resolvePumpswap(hop: DirectHop): Promise<DirectHop> {
  const stat = executionCache.getStatic(hop.poolId);
  
  // Read cached fields for zero-RPC transaction building
  if (stat?.programId) hop.programId = stat.programId;
  if (stat?.creator && !(hop as any).creator) (hop as any).creator = stat.creator;
  if (stat?.metadata_creator && !(hop as any).metadataCreator) (hop as any).metadataCreator = stat.metadata_creator;
  if (stat?.protocol_fee_recipient && !(hop as any).protocolFeeRecipient) (hop as any).protocolFeeRecipient = stat.protocol_fee_recipient;
  if (stat?.vault_a && !hop.vaultA) hop.vaultA = stat.vault_a;
  if (stat?.vault_b && !hop.vaultB) hop.vaultB = stat.vault_b;
  if (stat?.onchain_base_mint && !(hop as any).onchainBaseMint) (hop as any).onchainBaseMint = stat.onchain_base_mint;
  if (stat?.onchain_quote_mint && !(hop as any).onchainQuoteMint) (hop as any).onchainQuoteMint = stat.onchain_quote_mint;
  if (stat?.onchain_base_vault && !(hop as any).onchainBaseVault) (hop as any).onchainBaseVault = stat.onchain_base_vault;
  if (stat?.onchain_quote_vault && !(hop as any).onchainQuoteVault) (hop as any).onchainQuoteVault = stat.onchain_quote_vault;
  
  try {
    // Import Pumpswap pools from server cache
    const { peekPumpswapPools } = await import('../../server/pools.js');
    const pools = peekPumpswapPools();
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
      
      // Pumpswap AMM doesn't use authority/openOrders like Raydium
      // Store any additional pool-specific data if needed
      
      // Decimals (prefer token meta, but use orientation-aware mapping if needed)
      if (!Number.isFinite(Number(hop.inputDecimals))) {
        hop.inputDecimals = orientation.decimalsInput;
      }
      if (!Number.isFinite(Number(hop.outputDecimals))) {
        hop.outputDecimals = orientation.decimalsOutput;
      }
      
      // Store reserve data for quoting (orientation-aware)
      // ReserveA should be the input reserve, ReserveB should be the output reserve
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
    }
  } catch (e) {
    // Silently fail - hop will use defaults
  }
  
  return hop;
}

