//! Orca Whirlpool CPI integration
//!
//! Program ID: whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc
//!
//! Orca Whirlpool is a concentrated liquidity AMM on Solana.
//! Uses the standard swap instruction (matches working local builder).

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{instruction::Instruction, program::invoke};

use crate::constants::dex_programs::ORCA_WHIRLPOOL;
use crate::error::ArbRouterError;

/// Number of accounts needed for an Orca Whirlpool swap
/// 11 swap accounts + 1 for Whirlpool program (for CPI) = 12
pub const ACCOUNTS_NEEDED: usize = 12;

/// Orca Whirlpool swap instruction discriminator
/// Computed as: sha256("global:swap")[0..8]
/// Hex: f8c69e91e17587c8
const SWAP_DISCRIMINATOR: [u8; 8] = [0xf8, 0xc6, 0x9e, 0x91, 0xe1, 0x75, 0x87, 0xc8];

/// Sqrt price limits for swap direction
/// MIN_SQRT_PRICE_X64 + 1 for A->B (price decreases)
const MIN_SQRT_PRICE_LIMIT: u128 = 4295048017;
/// MAX_SQRT_PRICE_X64 - 1 for B->A (price increases)
const MAX_SQRT_PRICE_LIMIT: u128 = 79226673515401279992447579055;

/// Orca Whirlpool swap parameters
#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct SwapParams {
    /// Amount to swap
    pub amount: u64,
    /// Minimum/maximum amount for the other token (depends on amount_specified_is_input)
    pub other_amount_threshold: u64,
    /// Sqrt price limit (0 for no limit, u128::MAX or 0 depending on direction)
    pub sqrt_price_limit: u128,
    /// If true, amount is the input amount; if false, amount is the output amount
    pub amount_specified_is_input: bool,
    /// If true, swap A for B; if false, swap B for A
    pub a_to_b: bool,
}

/// Execute a swap on Orca Whirlpool
///
/// Expected accounts (in order) - standard swap layout (matches working local builder):
/// 0. `[]` Token Program
/// 1. `[signer]` Token Authority (user)
/// 2. `[writable]` Whirlpool
/// 3. `[writable]` Token Owner Account A (user's token A account)
/// 4. `[writable]` Token Vault A
/// 5. `[writable]` Token Owner Account B (user's token B account)
/// 6. `[writable]` Token Vault B
/// 7. `[writable]` Tick Array 0 (lower)
/// 8. `[writable]` Tick Array 1 (center)
/// 9. `[writable]` Tick Array 2 (upper)
/// 10. `[]` Oracle
/// 11. `[]` Whirlpool Program (for CPI)
///
/// # Arguments
/// * `accounts` - DEX-specific accounts in the order above
/// * `amount_in` - Amount of input tokens to swap
/// * `min_amount_out` - Minimum output tokens (slippage protection)
/// * `a_to_b` - Swap direction: true = A->B, false = B->A
pub fn swap(
    accounts: &[AccountInfo],
    amount_in: u64,
    min_amount_out: u64,
    a_to_b: bool,
) -> Result<()> {
    if accounts.len() < ACCOUNTS_NEEDED {
        msg!("Orca: Insufficient accounts. Expected {}, got {}", ACCOUNTS_NEEDED, accounts.len());
        return Err(ArbRouterError::InvalidAccount.into());
    }

    // Set sqrt_price_limit based on direction
    // A->B: price decreases, use MIN limit
    // B->A: price increases, use MAX limit
    let sqrt_price_limit = if a_to_b {
        MIN_SQRT_PRICE_LIMIT
    } else {
        MAX_SQRT_PRICE_LIMIT
    };

    // Build the swap instruction data
    // Format: discriminator(8) + amount(8) + otherAmountThreshold(8) + sqrtPriceLimit(16) 
    //         + amountSpecifiedIsInput(1) + aToB(1) = 42 bytes total
    let mut data = Vec::with_capacity(42);
    data.extend_from_slice(&SWAP_DISCRIMINATOR);
    
    // Serialize swap parameters
    let params = SwapParams {
        amount: amount_in,
        other_amount_threshold: min_amount_out,
        sqrt_price_limit,
        amount_specified_is_input: true,
        a_to_b,
    };
    params.serialize(&mut data)?;

    // Build account metas for swap
    // Accounts 0-10 go to the CPI (exclude index 11 which is Whirlpool program)
    let account_metas: Vec<AccountMeta> = accounts[..ACCOUNTS_NEEDED - 1]
        .iter()
        .enumerate()
        .map(|(i, acc)| {
            let is_signer = i == 1; // Token authority is signer (position 1)
            // Writable: whirlpool(2), token_owner_a(3), vault_a(4), token_owner_b(5), vault_b(6), 
            //           tick_arrays(7,8,9)
            // Oracle(10) is read-only in standard swap
            let is_writable = matches!(i, 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9);
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
        program_id: ORCA_WHIRLPOOL,
        accounts: account_metas,
        data,
    };

    // Invoke the swap
    let account_infos: Vec<AccountInfo> = accounts[..ACCOUNTS_NEEDED].to_vec();
    invoke(&ix, &account_infos)?;

    msg!("Orca Whirlpool swap executed: {} in, min {} out, a_to_b: {}", amount_in, min_amount_out, a_to_b);
    Ok(())
}

/// Helper to derive tick array address
pub fn derive_tick_array_address(
    whirlpool: &Pubkey,
    start_tick_index: i32,
) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[
            b"tick_array",
            whirlpool.as_ref(),
            &start_tick_index.to_le_bytes(),
        ],
        &ORCA_WHIRLPOOL,
    )
}

/// Helper to derive oracle address
pub fn derive_oracle_address(whirlpool: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[b"oracle", whirlpool.as_ref()],
        &ORCA_WHIRLPOOL,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_swap_params_serialize() {
        let params = SwapParams {
            amount: 1000000,
            other_amount_threshold: 990000,
            sqrt_price_limit: 0,
            amount_specified_is_input: true,
            a_to_b: true,
        };
        
        let mut data = Vec::new();
        params.serialize(&mut data).unwrap();
        
        // Should be 8 + 8 + 16 + 1 + 1 = 34 bytes
        assert_eq!(data.len(), 34);
    }
    
    #[test]
    fn test_swap_discriminator() {
        // Verify the discriminator is correct
        // sha256("global:swap")[0..8] = [0xf8, 0xc6, 0x9e, 0x91, 0xe1, 0x75, 0x87, 0xc8]
        let expected: [u8; 8] = [0xf8, 0xc6, 0x9e, 0x91, 0xe1, 0x75, 0x87, 0xc8];
        assert_eq!(SWAP_DISCRIMINATOR, expected, 
            "Discriminator mismatch! Expected {:?}, got {:?}", expected, SWAP_DISCRIMINATOR);
    }
}
