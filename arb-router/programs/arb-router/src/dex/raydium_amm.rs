//! Raydium AMM v4 CPI integration
//!
//! Program ID: 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8
//!
//! Raydium AMM v4 is a constant product AMM that integrates with OpenBook (formerly Serum)
//! for order book liquidity. This is different from Raydium CLMM which uses concentrated liquidity.
//!
//! ## Swap Instructions
//! - `swap_base_in`: Swap with exact input amount, receive at least minimum output
//! - `swap_base_out`: Swap for exact output amount, spend at most maximum input
//!
//! This module implements CPI calls to the Raydium AMM v4 program.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{instruction::Instruction, program::invoke};

use crate::error::ArbRouterError;

// =============================================================================
// Account Counts
// =============================================================================

/// Number of accounts needed for Raydium AMM swap
/// 18 accounts to Raydium (including user signer at 17) + 1 program ID = 19 total
pub const ACCOUNTS_NEEDED: usize = 19;

// =============================================================================
// Instruction Discriminators
// =============================================================================

/// Raydium AMM v4 `swap_base_in` instruction discriminator
/// This instruction swaps a fixed input amount for a minimum output
const SWAP_BASE_IN_DISCRIMINATOR: u8 = 9;

/// Raydium AMM v4 `swap_base_out` instruction discriminator  
/// This instruction swaps for a fixed output amount with maximum input
#[allow(dead_code)]
const SWAP_BASE_OUT_DISCRIMINATOR: u8 = 11;

// =============================================================================
// Swap Function
// =============================================================================

/// Execute a swap on Raydium AMM v4
///
/// ## Account Layout (18 accounts total):
///
/// 0. `[]` Token Program
/// 1. `[writable]` AMM ID (Pool state account)
/// 2. `[]` AMM Authority (PDA)
/// 3. `[writable]` AMM Open Orders (Serum open orders account)
/// 4. `[writable]` AMM Target Orders (can be same as pool for newer pools)
/// 5. `[writable]` Pool Coin Token Account (base vault)
/// 6. `[writable]` Pool PC Token Account (quote vault)
/// 7. `[]` Serum Program ID (OpenBook)
/// 8. `[writable]` Serum Market
/// 9. `[writable]` Serum Bids
/// 10. `[writable]` Serum Asks
/// 11. `[writable]` Serum Event Queue
/// 12. `[writable]` Serum Coin Vault Account
/// 13. `[writable]` Serum PC Vault Account
/// 14. `[]` Serum Vault Signer
/// 15. `[writable]` User Source Token Account
/// 16. `[writable]` User Destination Token Account  
/// 17. `[signer]` User Owner
/// 18. `[]` Raydium AMM Program (passed last for CPI)
///
/// # Arguments
/// * `accounts` - DEX-specific accounts in the order above
/// * `amount_in` - Amount of input tokens to swap
/// * `min_amount_out` - Minimum output tokens (slippage protection)
pub fn swap(
    accounts: &[AccountInfo],
    amount_in: u64,
    min_amount_out: u64,
) -> Result<()> {
    if accounts.len() < ACCOUNTS_NEEDED {
        msg!("Raydium AMM: Insufficient accounts. Expected {}, got {}", ACCOUNTS_NEEDED, accounts.len());
        return Err(ArbRouterError::InvalidAccount.into());
    }

    // Build instruction data for swap_base_in
    // Format: [discriminator(1), amount_in(8), min_amount_out(8)] = 17 bytes
    let mut data = Vec::with_capacity(17);
    data.push(SWAP_BASE_IN_DISCRIMINATOR);
    data.extend_from_slice(&amount_in.to_le_bytes());
    data.extend_from_slice(&min_amount_out.to_le_bytes());

    let program_idx = ACCOUNTS_NEEDED - 1;
    let dex_program_id = *accounts[program_idx].key;

    // Build account metas for Raydium AMM swap
    // Most accounts are writable except: Token Program (0), Authority (2), 
    // Serum Program (7), Serum Vault Signer (14)
    let account_metas: Vec<AccountMeta> = accounts[..program_idx]
        .iter()
        .enumerate()
        .map(|(i, acc)| {
            let is_signer = i == 17; // User Owner is signer at position 17
            // Writable accounts: AMM(1), OpenOrders(3), TargetOrders(4), 
            // CoinVault(5), PCVault(6), Market(8), Bids(9), Asks(10),
            // EventQueue(11), SerumCoinVault(12), SerumPCVault(13),
            // UserSource(15), UserDest(16)
            let is_writable = matches!(i, 1 | 3 | 4 | 5 | 6 | 8 | 9 | 10 | 11 | 12 | 13 | 15 | 16);
            
            if is_signer {
                AccountMeta::new(*acc.key, true)
            } else if is_writable {
                AccountMeta::new(*acc.key, false)
            } else {
                AccountMeta::new_readonly(*acc.key, false)
            }
        })
        .collect();

    let ix = Instruction {
        program_id: dex_program_id,
        accounts: account_metas,
        data,
    };

    // Invoke the swap instruction
    let account_infos: Vec<AccountInfo> = accounts[..ACCOUNTS_NEEDED].to_vec();
    invoke(&ix, &account_infos)?;

    msg!("Raydium AMM swap executed: {} in, min {} out", amount_in, min_amount_out);
    Ok(())
}

// =============================================================================
// Helper Functions
// =============================================================================

/// Derive the AMM authority PDA for Raydium AMM v4
/// Seeds: [AMM_ID, "amm authority"]
pub fn derive_amm_authority(amm_id: &Pubkey, program_id: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[
            &amm_id.to_bytes(),
            &[97, 109, 109, 32, 97, 117, 116, 104, 111, 114, 105, 116, 121], // "amm authority"
        ],
        program_id,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_swap_data_format() {
        let amount_in: u64 = 1_000_000;
        let min_amount_out: u64 = 990_000;
        
        let mut data = Vec::with_capacity(17);
        data.push(SWAP_BASE_IN_DISCRIMINATOR);
        data.extend_from_slice(&amount_in.to_le_bytes());
        data.extend_from_slice(&min_amount_out.to_le_bytes());
        
        // Should be 1 + 8 + 8 = 17 bytes
        assert_eq!(data.len(), 17);
        assert_eq!(data[0], 9); // swap_base_in discriminator
    }
}
