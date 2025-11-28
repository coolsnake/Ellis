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
/// swap instruction: [248, 198, 158, 145, 225, 117, 135, 200] - same as "swap"
const SWAP_DISCRIMINATOR: [u8; 8] = [43, 4, 237, 11, 26, 201, 30, 98];

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
pub fn swap(
    accounts: &[AccountInfo],
    amount_in: u64,
    min_amount_out: u64,
) -> Result<()> {
    if accounts.len() < ACCOUNTS_NEEDED {
        msg!("Orca: Insufficient accounts. Expected {}, got {}", ACCOUNTS_NEEDED, accounts.len());
        return Err(ArbRouterError::InvalidAccount.into());
    }

    // Build the swap instruction data
    let params = SwapParams {
        amount: amount_in,
        other_amount_threshold: min_amount_out,
        sqrt_price_limit: 0, // No price limit (will use MIN or MAX based on direction)
        amount_specified_is_input: true,
        a_to_b: true, // This should be determined by the route, simplified here
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

    msg!("Orca Whirlpool swap executed: {} in, min {} out", amount_in, min_amount_out);
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

