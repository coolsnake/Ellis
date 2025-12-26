//! Orca Whirlpool CPI integration
//!
//! Program ID: whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc
//!
//! Orca Whirlpool is a concentrated liquidity AMM on Solana.
//! Uses swap_v2 instruction for Token-2022 support and better resilience.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{instruction::Instruction, program::invoke};

use crate::constants::dex_programs::ORCA_WHIRLPOOL;
use crate::error::ArbRouterError;

/// Number of accounts needed for an Orca Whirlpool swap_v2
/// 15 fixed accounts + 1 for Whirlpool program (for CPI) = 16
pub const ACCOUNTS_NEEDED: usize = 16;

/// Orca Whirlpool swap_v2 instruction discriminator
/// Computed as: sha256("global:swap_v2")[0..8]
/// Hex: 2b04ed0b1ac91e62
const SWAP_V2_DISCRIMINATOR: [u8; 8] = [0x2b, 0x04, 0xed, 0x0b, 0x1a, 0xc9, 0x1e, 0x62];

/// Sqrt price limits for swap direction
/// MIN_SQRT_PRICE_X64 + 1 for A->B (price decreases)
const MIN_SQRT_PRICE_LIMIT: u128 = 4295048017;
/// MAX_SQRT_PRICE_X64 - 1 for B->A (price increases)
const MAX_SQRT_PRICE_LIMIT: u128 = 79226673515401279992447579055;

/// Orca Whirlpool swap_v2 parameters
/// Note: swap_v2 also requires remainingAccountsInfo (empty Vec for simple swaps)
#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct SwapV2Params {
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
    // remainingAccountsInfo is serialized separately as empty Vec
}

/// Execute a swap_v2 on Orca Whirlpool
///
/// Expected accounts (in order) - swap_v2 layout:
/// 0. `[]` Token Program A
/// 1. `[]` Token Program B
/// 2. `[]` Memo Program
/// 3. `[signer]` Token Authority (user)
/// 4. `[writable]` Whirlpool
/// 5. `[]` Token Mint A
/// 6. `[]` Token Mint B
/// 7. `[writable]` Token Owner Account A (user's token A account)
/// 8. `[writable]` Token Vault A
/// 9. `[writable]` Token Owner Account B (user's token B account)
/// 10. `[writable]` Token Vault B
/// 11. `[writable]` Tick Array 0
/// 12. `[writable]` Tick Array 1
/// 13. `[writable]` Tick Array 2
/// 14. `[writable]` Oracle (whirlpool's oracle account)
/// 15. `[]` Whirlpool Program (for CPI)
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

    // Build the swap_v2 instruction data
    // Format: discriminator(8) + amount(8) + otherAmountThreshold(8) + sqrtPriceLimit(16) 
    //         + amountSpecifiedIsInput(1) + aToB(1) + remainingAccountsInfo (Option<...>)
    // For Option::None in Borsh: single byte 0x00
    let mut data = Vec::with_capacity(8 + 8 + 8 + 16 + 1 + 1 + 1);
    data.extend_from_slice(&SWAP_V2_DISCRIMINATOR);
    
    // Serialize swap parameters
    let params = SwapV2Params {
        amount: amount_in,
        other_amount_threshold: min_amount_out,
        sqrt_price_limit,
        amount_specified_is_input: true,
        a_to_b,
    };
    params.serialize(&mut data)?;
    
    // Append remainingAccountsInfo as Option::None (1 byte = 0x00)
    // This indicates no supplemental tick arrays or transfer hook accounts
    data.push(0u8); // Option::None

    // Build account metas for swap_v2
    // Accounts 0-14 go to the CPI (exclude index 15 which is Whirlpool program)
    let account_metas: Vec<AccountMeta> = accounts[..ACCOUNTS_NEEDED - 1]
        .iter()
        .enumerate()
        .map(|(i, acc)| {
            let is_signer = i == 3; // Token authority is signer (position 3 in swap_v2)
            // Writable: whirlpool(4), token_owner_a(7), vault_a(8), token_owner_b(9), vault_b(10), 
            //           tick_arrays(11,12,13), oracle(14)
            let is_writable = matches!(i, 4 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14);
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

    // Invoke the swap_v2
    let account_infos: Vec<AccountInfo> = accounts[..ACCOUNTS_NEEDED].to_vec();
    invoke(&ix, &account_infos)?;

    msg!("Orca Whirlpool swap_v2 executed: {} in, min {} out, a_to_b: {}", amount_in, min_amount_out, a_to_b);
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
    fn test_swap_v2_params_serialize() {
        let params = SwapV2Params {
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
    fn test_swap_v2_discriminator() {
        // Verify the discriminator matches sha256("global:swap_v2")[0..8]
        use anchor_lang::solana_program::hash::hash;
        let hash = hash(b"global:swap_v2");
        let expected: [u8; 8] = hash.to_bytes()[0..8].try_into().unwrap();
        assert_eq!(SWAP_V2_DISCRIMINATOR, expected, 
            "Discriminator mismatch! Expected {:?}, got {:?}", expected, SWAP_V2_DISCRIMINATOR);
    }
}

