//! Orca Whirlpool CPI integration
//!
//! Program ID: whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc
//!
//! Orca Whirlpool is a concentrated liquidity AMM on Solana.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{instruction::Instruction, program::invoke};

use crate::constants::dex_programs::ORCA_WHIRLPOOL;
use crate::error::ArbRouterError;

/// Number of accounts needed for an Orca Whirlpool swap
pub const ACCOUNTS_NEEDED: usize = 15;

/// Orca Whirlpool swap instruction discriminator
/// Computed as: sha256("global:swap")[0..8]
const SWAP_DISCRIMINATOR: [u8; 8] = [248, 198, 158, 145, 225, 117, 135, 200];

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
/// Expected accounts (in order):
/// 0. `[]` Token Program
/// 1. `[signer]` Token Authority (user)
/// 2. `[writable]` Whirlpool
/// 3. `[writable]` Token Owner Account A (user's token A account)
/// 4. `[writable]` Token Vault A
/// 5. `[writable]` Token Owner Account B (user's token B account)
/// 6. `[writable]` Token Vault B
/// 7. `[writable]` Tick Array 0
/// 8. `[writable]` Tick Array 1
/// 9. `[writable]` Tick Array 2
/// 10. `[]` Oracle (whirlpool's oracle account)
/// 11. `[]` Token Mint A
/// 12. `[]` Token Mint B
/// 13. `[]` Memo Program (optional)
/// 14. `[]` Whirlpool Program
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
    let params = SwapParams {
        amount: amount_in,
        other_amount_threshold: min_amount_out,
        sqrt_price_limit,
        amount_specified_is_input: true,
        a_to_b,
    };

    let mut data = Vec::with_capacity(8 + 8 + 8 + 16 + 1 + 1);
    data.extend_from_slice(&SWAP_DISCRIMINATOR);
    params.serialize(&mut data)?;

    // Build account metas
    let account_metas: Vec<AccountMeta> = accounts[..ACCOUNTS_NEEDED - 1]
        .iter()
        .enumerate()
        .map(|(i, acc)| {
            let is_signer = i == 1; // Token authority is signer
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
}

