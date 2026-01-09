//! Raydium CPMM (Constant Product Market Maker) CPI integration
//!
//! Program ID: CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C
//!
//! CPMM pools use a constant product formula (x*y=k) like AMM V4 but with
//! a simpler account structure and support for Token-2022.
//!
//! ## Swap Instructions
//! - `swap_base_input`: Swap with exact input amount
//! - `swap_base_output`: Swap with exact output amount
//!
//! This module implements swap_base_input for consistency with other DEX handlers.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{instruction::Instruction, program::invoke};

use crate::error::ArbRouterError;

// =============================================================================
// Account Counts
// =============================================================================

/// Number of accounts for CPMM swap (14 accounts: 13 to CPMM + 1 program ID)
pub const ACCOUNTS_NEEDED: usize = 14;

// =============================================================================
// Instruction Discriminators
// =============================================================================

/// Raydium CPMM `swap_base_input` instruction discriminator
/// Anchor discriminator for "swap_base_input"
const SWAP_BASE_INPUT_DISCRIMINATOR: [u8; 8] = [143, 190, 90, 218, 196, 30, 51, 222];

/// Raydium CPMM swap_base_input parameters
#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct SwapBaseInputParams {
    /// Amount of input tokens to swap
    pub amount_in: u64,
    /// Minimum amount of output tokens (slippage protection)
    pub minimum_amount_out: u64,
}

/// Execute a swap on Raydium CPMM
///
/// ## Account Layout (14 accounts total, 13 to CPMM):
///
/// 0. `[signer]` Payer
/// 1. `[]` Authority (PDA)
/// 2. `[]` AMM Config
/// 3. `[writable]` Pool State
/// 4. `[writable]` User Input Token Account
/// 5. `[writable]` User Output Token Account
/// 6. `[writable]` Input Vault
/// 7. `[writable]` Output Vault
/// 8. `[]` Input Token Program
/// 9. `[]` Output Token Program
/// 10. `[]` Input Mint
/// 11. `[]` Output Mint
/// 12. `[writable]` Observation State
/// 13. `[]` CPMM Program ID
///
/// ## Parameters
/// - `accounts`: Account infos for the swap
/// - `amount_in`: Amount of input tokens to swap
/// - `min_amount_out`: Minimum output amount (slippage protection)
/// - `_a_to_b`: Swap direction (encoded in account ordering)
pub fn swap(
    accounts: &[AccountInfo],
    amount_in: u64,
    min_amount_out: u64,
    _a_to_b: bool, // Direction is encoded in account ordering (input/output ATAs and vaults)
) -> Result<()> {
    if accounts.len() < ACCOUNTS_NEEDED {
        msg!("Raydium CPMM swap: Insufficient accounts. Expected {}, got {}", 
             ACCOUNTS_NEEDED, accounts.len());
        return Err(ArbRouterError::InvalidAccount.into());
    }

    let params = SwapBaseInputParams {
        amount_in,
        minimum_amount_out: min_amount_out,
    };

    // Build instruction data
    let mut data = Vec::with_capacity(8 + 8 + 8);
    data.extend_from_slice(&SWAP_BASE_INPUT_DISCRIMINATOR);
    params.serialize(&mut data)?;

    // Program ID is at the last index
    let program_idx = ACCOUNTS_NEEDED - 1;
    let dex_program_id = *accounts[program_idx].key;

    // Build account metas
    // Writable accounts: 3 (pool), 4-5 (user ATAs), 6-7 (vaults), 12 (observation)
    let account_metas: Vec<AccountMeta> = accounts[..program_idx]
        .iter()
        .enumerate()
        .map(|(i, acc)| {
            let is_signer = i == 0;
            let is_writable = matches!(i, 3 | 4 | 5 | 6 | 7 | 12);
            
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

    let account_infos: Vec<AccountInfo> = accounts[..ACCOUNTS_NEEDED].to_vec();
    invoke(&ix, &account_infos)?;

    msg!("Raydium CPMM swap executed: {} in, min {} out", amount_in, min_amount_out);

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_swap_params_serialize() {
        let params = SwapBaseInputParams {
            amount_in: 1000000,
            minimum_amount_out: 990000,
        };
        
        let mut data = Vec::new();
        params.serialize(&mut data).unwrap();
        
        // Should be 8 + 8 = 16 bytes
        assert_eq!(data.len(), 16);
    }

    #[test]
    fn test_swap_base_input_discriminator() {
        // Verify the discriminator matches the expected value
        // This is the Anchor discriminator for "swap_base_input"
        let expected: [u8; 8] = [143, 190, 90, 218, 196, 30, 51, 222];
        assert_eq!(SWAP_BASE_INPUT_DISCRIMINATOR, expected, 
            "swap_base_input discriminator mismatch! Expected {:?}, got {:?}", 
            expected, SWAP_BASE_INPUT_DISCRIMINATOR);
    }
}
