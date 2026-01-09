import type { DirectHop } from '../../execution/types.js';
import { executionCache } from '../cache.js';
import { peekRaydiumPools } from '../../server/pools.js';
import { determineSwapOrientation } from '../../server/pools/orientation.js';
import { logCatchError } from '../../utils/errorHandler.js';

/**
 * Resolver for Raydium AMM v4 pools
 * Populates all required accounts for on-chain router execution including
 * Serum/OpenBook market accounts for order book routing.
 */
export async function resolveRaydiumAmm(hop: DirectHop): Promise<DirectHop> {
  const stat = executionCache.getStatic(hop.poolId);
  if (stat?.programId) hop.programId = stat.programId;
  
  // Read market info from executionCache first (populated during GraphQL normalization)
  if (stat?.market_id && !hop.market) hop.market = stat.market_id;
  if (stat?.market_program_id && !hop.serumProgramId) hop.serumProgramId = stat.market_program_id;
  if (stat?.vault_a && !hop.vaultA) hop.vaultA = stat.vault_a;
  if (stat?.vault_b && !hop.vaultB) hop.vaultB = stat.vault_b;
  if (stat?.open_orders && !(hop as any).openOrders) (hop as any).openOrders = stat.open_orders;
  if (stat?.target_orders && !(hop as any).targetOrders) (hop as any).targetOrders = stat.target_orders;
  if (stat?.authority && !hop.ammAuthority) hop.ammAuthority = stat.authority;
  if (stat?.lp_mint && !(hop as any).lpMint) (hop as any).lpMint = stat.lp_mint;
  // Fallback to amm_ prefixed fields if available
  if (stat?.amm_open_orders && !(hop as any).openOrders) (hop as any).openOrders = stat.amm_open_orders;
  if (stat?.amm_target_orders && !(hop as any).targetOrders) (hop as any).targetOrders = stat.amm_target_orders;
  if (stat?.amm_authority && !hop.ammAuthority) hop.ammAuthority = stat.amm_authority;
  
  // Serum/OpenBook market accounts (required for router execution)
  if (stat?.serum_bids && !(hop as any).serumBids) (hop as any).serumBids = stat.serum_bids;
  if (stat?.serum_asks && !(hop as any).serumAsks) (hop as any).serumAsks = stat.serum_asks;
  if (stat?.serum_event_queue && !(hop as any).serumEventQueue) (hop as any).serumEventQueue = stat.serum_event_queue;
  if (stat?.serum_coin_vault && !(hop as any).serumCoinVault) (hop as any).serumCoinVault = stat.serum_coin_vault;
  if (stat?.serum_pc_vault && !(hop as any).serumPcVault) (hop as any).serumPcVault = stat.serum_pc_vault;
  if (stat?.serum_vault_signer && !(hop as any).serumVaultSigner) (hop as any).serumVaultSigner = stat.serum_vault_signer;
  
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
      if (!hop.market) hop.market = String((p as any)?.market || (p as any)?.market_id || '');
      if (!hop.serumProgramId) hop.serumProgramId = String((p as any)?.market_program_id || (p as any)?.marketProgramId || '');
      
      // Populate open orders and target orders from pool data
      if (!(hop as any).openOrders) (hop as any).openOrders = String((p as any)?.open_orders || (p as any)?.amm_open_orders || '');
      if (!(hop as any).targetOrders) (hop as any).targetOrders = String((p as any)?.target_orders || (p as any)?.amm_target_orders || '');
      
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


