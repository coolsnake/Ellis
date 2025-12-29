//! Meteora DLMM (Dynamic Liquidity Market Maker) CPI integration
//!
//! Program ID: LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo
//!
//! Meteora DLMM uses a discrete liquidity distribution model with "bins"
//! for efficient capital usage.
//!
//! ## Swap Instructions
//! - `swap`: Original instruction for standard SPL tokens (14 fixed accounts, no Memo)
//! - `swap2`: Token-2022 compatible instruction (15 fixed accounts, includes Memo Program)
//!
//! The off-chain builder determines which variant to use based on token programs.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{instruction::Instruction, program::invoke};

use crate::constants::dex_programs::METEORA_DLMM;
use crate::error::ArbRouterError;

/// Minimum number of bin arrays to provide to Meteora DLMM swaps.
/// For execute (multi-hop), we use 3 bin arrays directionally:
/// - Active bin array (where current price is)
/// - 2 more bin arrays in the direction of price movement
/// Off-chain builder selects these based on swap direction (X→Y = lower, Y→X = upper)
pub const MIN_BIN_ARRAYS: usize = 3;

/// Number of accounts needed for Meteora DLMM `swap` (standard SPL tokens)
/// 14 fixed accounts + 1 program + MIN_BIN_ARRAYS bin arrays = 18 total
/// Account layout: NO Memo Program, user tokens in INPUT/OUTPUT order
pub const SWAP_ACCOUNTS_NEEDED: usize = 15 + MIN_BIN_ARRAYS; // 18 total

/// Number of accounts needed for Meteora DLMM `swap2` (Token-2022 compatible)
/// 15 fixed accounts + 1 program + MIN_BIN_ARRAYS bin arrays = 19 total
/// Account layout: INCLUDES Memo Program at index 13, user tokens in X/Y order
pub const SWAP2_ACCOUNTS_NEEDED: usize = 16 + MIN_BIN_ARRAYS; // 19 total

/// Default accounts needed (swap for standard tokens)
pub const ACCOUNTS_NEEDED: usize = SWAP_ACCOUNTS_NEEDED;

/// Meteora DLMM `swap` instruction discriminator (standard SPL tokens)
/// SHA256("global:swap")[0..8]
const SWAP_DISCRIMINATOR: [u8; 8] = [248, 198, 158, 145, 225, 117, 135, 200];

/// Meteora DLMM `swap2` instruction discriminator (Token-2022 compatible)
/// SHA256("global:swap2")[0..8]
const SWAP2_DISCRIMINATOR: [u8; 8] = [65, 75, 63, 76, 235, 91, 91, 136];

/// Meteora DLMM swap parameters
#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct SwapParams {
    /// Amount to swap
    pub amount_in: u64,
    /// Minimum output amount
    pub min_amount_out: u64,
}

/// Execute a swap on Meteora DLMM
///
/// Automatically detects whether to use `swap` or `swap2` based on account count:
/// - 18 accounts (SWAP_ACCOUNTS_NEEDED): Use `swap` for standard SPL tokens
/// - 19 accounts (SWAP2_ACCOUNTS_NEEDED): Use `swap2` for Token-2022
///
/// ## `swap` instruction layout (18 accounts, standard SPL tokens):
/// 0. `[writable]` LB Pair
/// 1. `[]` Bin Array Bitmap Extension (optional, use program ID as placeholder)
/// 2. `[writable]` Reserve X (token vault)
/// 3. `[writable]` Reserve Y (token vault)
/// 4. `[writable]` User Token In (INPUT token account)
/// 5. `[writable]` User Token Out (OUTPUT token account)
/// 6. `[]` Token X Mint
/// 7. `[]` Token Y Mint
/// 8. `[writable]` Oracle
/// 9. `[]` Host Fee In (program ID as placeholder)
/// 10. `[signer, writable]` User (authority)
/// 11. `[]` Token X Program
/// 12. `[]` Token Y Program
/// 13. `[]` Event Authority
/// 14. `[]` Meteora DLMM Program (for CPI invoke)
/// 15+. `[writable]` Bin Arrays (remaining accounts)
///
/// ## `swap2` instruction layout (19 accounts, Token-2022 compatible):
/// 0. `[writable]` LB Pair
/// 1. `[]` Bin Array Bitmap Extension (optional, use program ID as placeholder)
/// 2. `[writable]` Reserve X (token vault)
/// 3. `[writable]` Reserve Y (token vault)
/// 4. `[writable]` User Token X (X token account - native order, NOT input/output!)
/// 5. `[writable]` User Token Y (Y token account - native order, NOT input/output!)
/// 6. `[]` Token X Mint
/// 7. `[]` Token Y Mint
/// 8. `[writable]` Oracle
/// 9. `[]` Host Fee In (program ID as placeholder)
/// 10. `[signer, writable]` User (authority)
/// 11. `[]` Token X Program
/// 12. `[]` Token Y Program
/// 13. `[]` Memo Program (REQUIRED for swap2!)
/// 14. `[]` Event Authority
/// 15. `[]` Meteora DLMM Program (for CPI invoke)
/// 16+. `[writable]` Bin Arrays (remaining accounts)
pub fn swap(
    accounts: &[AccountInfo],
    amount_in: u64,
    min_amount_out: u64,
) -> Result<()> {
    // Determine which instruction variant to use based on account count
    let use_swap2 = accounts.len() >= SWAP2_ACCOUNTS_NEEDED;
    
    if !use_swap2 && accounts.len() < SWAP_ACCOUNTS_NEEDED {
        msg!("Meteora: Insufficient accounts. Expected at least {}, got {}", SWAP_ACCOUNTS_NEEDED, accounts.len());
        return Err(ArbRouterError::InvalidAccount.into());
    }

    let params = SwapParams {
        amount_in,
        min_amount_out,
    };

    let (discriminator, fixed_count, program_idx, bin_array_start) = if use_swap2 {
        // swap2: 15 fixed + 1 program, bin arrays start at 16
        (SWAP2_DISCRIMINATOR, 15usize, 15usize, 16usize)
    } else {
        // swap: 14 fixed + 1 program, bin arrays start at 15
        (SWAP_DISCRIMINATOR, 14usize, 14usize, 15usize)
    };

    // Build instruction data
    // swap: [discriminator(8), amount_in(8), min_amount_out(8)]
    // swap2: [discriminator(8), amount_in(8), min_amount_out(8), slices_len(4)]
    let data_size = if use_swap2 { 8 + 8 + 8 + 4 } else { 8 + 8 + 8 };
    let mut data = Vec::with_capacity(data_size);
    data.extend_from_slice(&discriminator);
    params.serialize(&mut data)?;
    if use_swap2 {
        data.extend_from_slice(&[0u8; 4]); // Empty slices Vec (length = 0)
    }

    let mut account_metas: Vec<AccountMeta> = Vec::new();
    
    // Add fixed accounts (0 to fixed_count-1)
    for (i, acc) in accounts[..fixed_count].iter().enumerate() {
        let is_signer = i == 10; // User is signer at index 10 for both variants
        
        // Writable accounts differ slightly between swap and swap2
        // Both: lbPair(0), reserves(2,3), userTokens(4,5), oracle(8), user(10)
        // swap: eventAuth is at 13, so hostFeeIn(9), tokenProgs(11,12), eventAuth(13) are NOT writable
        // swap2: memoProgram(13), eventAuth(14) are NOT writable
        let is_writable = matches!(i, 0 | 2 | 3 | 4 | 5 | 8 | 10);
        
        if is_signer {
            account_metas.push(AccountMeta::new(*acc.key, true));
        } else if is_writable {
            account_metas.push(AccountMeta::new(*acc.key, false));
        } else {
            account_metas.push(AccountMeta::new_readonly(*acc.key, false));
        }
    }
    
    // Add bin arrays (bin_array_start+) - all are writable
    for acc in accounts[bin_array_start..].iter() {
        account_metas.push(AccountMeta::new(*acc.key, false));
    }

    let ix = Instruction {
        program_id: METEORA_DLMM,
        accounts: account_metas,
        data,
    };

    // Invoke the swap - include all accounts for the CPI
    invoke(&ix, accounts)?;

    let variant = if use_swap2 { "swap2" } else { "swap" };
    msg!("Meteora DLMM {} executed: {} in, min {} out, {} bin arrays", 
         variant, amount_in, min_amount_out, accounts.len() - bin_array_start);
    Ok(())
}

/// Helper to derive bin array address
pub fn derive_bin_array_address(
    lb_pair: &Pubkey,
    bin_array_index: i32,
) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[
            b"bin_array",
            lb_pair.as_ref(),
            &bin_array_index.to_le_bytes(),
        ],
        &METEORA_DLMM,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_swap_params_serialize() {
        let params = SwapParams {
            amount_in: 1000000,
            min_amount_out: 990000,
        };
        
        let mut data = Vec::new();
        params.serialize(&mut data).unwrap();
        
        // Should be 8 + 8 = 16 bytes
        assert_eq!(data.len(), 16);
    }
}

