//! Raydium CLMM (Concentrated Liquidity Market Maker) CPI integration
//!
//! Mainnet Program ID: CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK
//! Devnet Program ID: DRayAUgENGQBKVaX8owNhgzkEDyoHTGVEGHVJT1E9pfH
//!
//! Raydium CLMM is a concentrated liquidity DEX similar to Uniswap V3.
//! The DEX program ID is passed as the last account to support both devnet and mainnet.
//!
//! This module supports two account layouts:
//! - WITH exBitmap (18 accounts): Pools with tick_array_bitmap_extension PDA initialized
//! - WITHOUT exBitmap (17 accounts): Pools without exBitmap - tick arrays shift down by 1

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{instruction::Instruction, program::invoke};

use crate::error::ArbRouterError;

/// Number of accounts WITH exBitmap (18 accounts: 17 to Raydium + 1 program ID)
pub const ACCOUNTS_NEEDED: usize = 18;

/// Number of accounts WITHOUT exBitmap (17 accounts: 16 to Raydium + 1 program ID)
pub const ACCOUNTS_NEEDED_NO_EXBITMAP: usize = 17;

/// Raydium CLMM swap_v2 instruction discriminator
/// Note: The SDK calls this "swap" but it uses the swap_v2 discriminator
/// sha256("global:swap_v2")[0..8] = [43, 4, 237, 11, 26, 201, 30, 98]
const SWAP_V2_DISCRIMINATOR: [u8; 8] = [43, 4, 237, 11, 26, 201, 30, 98];

/// Raydium CLMM swap parameters
#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct SwapParams {
    /// Amount to swap
    pub amount: u64,
    /// Minimum output amount (slippage protection)
    pub other_amount_threshold: u64,
    /// Sqrt price limit (0 for no limit)
    pub sqrt_price_limit_x64: u128,
    /// Whether amount is the input (true) or output (false)
    pub is_base_input: bool,
}

/// Execute a swap on Raydium CLMM
///
/// Supports two account layouts based on whether exBitmap (tick_array_bitmap_extension) exists:
///
/// WITH exBitmap (18 accounts total, 17 to Raydium):
/// 0. `[signer]` Payer
/// 1. `[]` AMM Config
/// 2. `[writable]` Pool State
/// 3. `[writable]` Input Token Account (user)
/// 4. `[writable]` Output Token Account (user)
/// 5. `[writable]` Input Vault
/// 6. `[writable]` Output Vault
/// 7. `[writable]` Observation State
/// 8. `[]` Token Program
/// 9. `[]` Token-2022 Program
/// 10. `[]` Memo Program
/// 11. `[]` Input Token Mint
/// 12. `[]` Output Token Mint
/// 13. `[writable]` Tick Array Bitmap Extension (exBitmap)
/// 14. `[writable]` Tick Array 0 (center)
/// 15. `[writable]` Tick Array 1 (directional)
/// 16. `[writable]` Tick Array 2 (directional)
/// 17. `[]` Raydium CLMM Program ID
///
/// WITHOUT exBitmap (17 accounts total, 16 to Raydium):
/// 0. `[signer]` Payer
/// 1. `[]` AMM Config
/// 2. `[writable]` Pool State
/// 3. `[writable]` Input Token Account (user)
/// 4. `[writable]` Output Token Account (user)
/// 5. `[writable]` Input Vault
/// 6. `[writable]` Output Vault
/// 7. `[writable]` Observation State
/// 8. `[]` Token Program
/// 9. `[]` Token-2022 Program
/// 10. `[]` Memo Program
/// 11. `[]` Input Token Mint
/// 12. `[]` Output Token Mint
/// 13. `[writable]` Tick Array 0 (center)
/// 14. `[writable]` Tick Array 1 (directional)
/// 15. `[writable]` Tick Array 2 (directional)
/// 16. `[]` Raydium CLMM Program ID
pub fn swap(
    accounts: &[AccountInfo],
    amount_in: u64,
    min_amount_out: u64,
    _a_to_b: bool, // Direction is encoded in account ordering (input/output ATAs and vaults)
) -> Result<()> {
    // Detect layout based on account count
    let has_exbitmap = accounts.len() >= ACCOUNTS_NEEDED;
    let required = if has_exbitmap { ACCOUNTS_NEEDED } else { ACCOUNTS_NEEDED_NO_EXBITMAP };
    
    if accounts.len() < required {
        msg!("Raydium: Insufficient accounts. Expected {} (exBitmap={}), got {}", 
             required, has_exbitmap, accounts.len());
        return Err(ArbRouterError::InvalidAccount.into());
    }

    // Build the swap instruction data
    // Note: is_base_input = true means amount is the INPUT amount (what we're swapping in)
    let params = SwapParams {
        amount: amount_in,
        other_amount_threshold: min_amount_out,
        sqrt_price_limit_x64: 0,
        is_base_input: true, // Always true - we're specifying input amount
    };

    let mut data = Vec::with_capacity(8 + 8 + 8 + 16 + 1);
    data.extend_from_slice(&SWAP_V2_DISCRIMINATOR);
    params.serialize(&mut data)?;

    // Get the DEX program ID from the last account
    let program_idx = required - 1;
    let dex_program_id = *accounts[program_idx].key;

    // Build account metas - accounts to send to Raydium (exclude our program ID)
    // Writable accounts:
    // - WITH exBitmap: 2, 3, 4, 5, 6, 7, 13, 14, 15, 16
    // - WITHOUT exBitmap: 2, 3, 4, 5, 6, 7, 13, 14, 15
    let account_metas: Vec<AccountMeta> = accounts[..program_idx]
        .iter()
        .enumerate()
        .map(|(i, acc)| {
            let is_signer = i == 0; // Only first account (payer) is signer
            
            // Determine writable accounts based on layout
            let is_writable = if has_exbitmap {
                // WITH exBitmap: 2-7 (pool state, ATAs, vaults, observation), 13-16 (exBitmap + tickArrays)
                matches!(i, 2 | 3 | 4 | 5 | 6 | 7 | 13 | 14 | 15 | 16)
            } else {
                // WITHOUT exBitmap: 2-7 (pool state, ATAs, vaults, observation), 13-15 (tickArrays only)
                matches!(i, 2 | 3 | 4 | 5 | 6 | 7 | 13 | 14 | 15)
            };
            
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

    // Invoke the swap - include all accounts for CPI
    let account_infos: Vec<AccountInfo> = accounts[..required].to_vec();
    invoke(&ix, &account_infos)?;

    msg!("Raydium CLMM swap executed: {} in, min {} out (exBitmap={})", 
         amount_in, min_amount_out, has_exbitmap);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_swap_params_serialize() {
        let params = SwapParams {
            amount: 1000000,
            other_amount_threshold: 990000,
            sqrt_price_limit_x64: 0,
            is_base_input: true,
        };
        
        let mut data = Vec::new();
        params.serialize(&mut data).unwrap();
        
        // Should be 8 + 8 + 16 + 1 = 33 bytes
        assert_eq!(data.len(), 33);
    }
}

