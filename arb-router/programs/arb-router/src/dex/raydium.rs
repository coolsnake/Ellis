//! Raydium CLMM (Concentrated Liquidity Market Maker) CPI integration
//!
//! Mainnet Program ID: CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK
//! Devnet Program ID: DRayAUgENGQBKVaX8owNhgzkEDyoHTGVEGHVJT1E9pfH
//!
//! Raydium CLMM is a concentrated liquidity DEX similar to Uniswap V3.
//! The DEX program ID is passed as the last account to support both devnet and mainnet.
//!
//! ## Swap Instructions
//! - `swap`: Original instruction for standard SPL tokens (12-13 accounts)
//! - `swap_v2`: Token-2022 compatible instruction (17-18 accounts, includes Memo Program)
//!
//! The off-chain builder determines which variant to use based on token programs.
//!
//! ## Account Layouts
//! Each instruction supports two layouts based on exBitmap (tick_array_bitmap_extension) presence:
//! - WITH exBitmap: Pools with wide tick ranges need the bitmap extension
//! - WITHOUT exBitmap: Standard pools without bitmap extension - tick arrays shift down by 1

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{instruction::Instruction, program::invoke};

use crate::error::ArbRouterError;

// =============================================================================
// swap_v2 Account Counts (Token-2022 compatible)
// =============================================================================

/// Number of accounts for swap_v2 WITH exBitmap (18 accounts: 17 to Raydium + 1 program ID)
pub const SWAP_V2_ACCOUNTS_NEEDED: usize = 18;

/// Number of accounts for swap_v2 WITHOUT exBitmap (17 accounts: 16 to Raydium + 1 program ID)
pub const SWAP_V2_ACCOUNTS_NEEDED_NO_EXBITMAP: usize = 17;

// =============================================================================
// swap Account Counts (Standard SPL tokens only)
// =============================================================================

/// Number of accounts for swap WITH exBitmap (13 accounts: 12 to Raydium + 1 program ID)
pub const SWAP_ACCOUNTS_NEEDED: usize = 13;

/// Number of accounts for swap WITHOUT exBitmap (12 accounts: 11 to Raydium + 1 program ID)
pub const SWAP_ACCOUNTS_NEEDED_NO_EXBITMAP: usize = 12;

// Legacy aliases for backward compatibility
pub const ACCOUNTS_NEEDED: usize = SWAP_V2_ACCOUNTS_NEEDED;
pub const ACCOUNTS_NEEDED_NO_EXBITMAP: usize = SWAP_V2_ACCOUNTS_NEEDED_NO_EXBITMAP;

// =============================================================================
// Instruction Discriminators
// =============================================================================

/// Raydium CLMM `swap` instruction discriminator (standard SPL tokens)
/// sha256("global:swap")[0..8] = [248, 198, 158, 145, 225, 117, 135, 200]
const SWAP_DISCRIMINATOR: [u8; 8] = [248, 198, 158, 145, 225, 117, 135, 200];

/// Raydium CLMM `swap_v2` instruction discriminator (Token-2022 compatible)
/// sha256("global:swap_v2")[0..8] = [43, 4, 237, 11, 26, 201, 30, 98]
const SWAP_V2_DISCRIMINATOR: [u8; 8] = [43, 4, 237, 11, 26, 201, 30, 98];

/// Raydium CLMM swap parameters (same for both swap and swap_v2)
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
/// Automatically detects whether to use `swap` or `swap_v2` based on account count:
/// - 12-13 accounts: Use `swap` for standard SPL tokens
/// - 17-18 accounts: Use `swap_v2` for Token-2022 compatible swaps
///
/// ## `swap` instruction layout (standard SPL tokens):
///
/// WITH exBitmap (13 accounts total, 12 to Raydium):
/// 0. `[signer]` Payer
/// 1. `[]` AMM Config
/// 2. `[writable]` Pool State
/// 3. `[writable]` Input Token Account (user)
/// 4. `[writable]` Output Token Account (user)
/// 5. `[writable]` Input Vault
/// 6. `[writable]` Output Vault
/// 7. `[writable]` Observation State
/// 8. `[]` Token Program
/// 9. `[writable]` Tick Array Bitmap Extension (exBitmap)
/// 10. `[writable]` Tick Array 0 (center)
/// 11. `[writable]` Tick Array 1 (directional)
/// 12. `[]` Raydium CLMM Program ID
///
/// WITHOUT exBitmap (12 accounts total, 11 to Raydium):
/// 0. `[signer]` Payer
/// 1. `[]` AMM Config
/// 2. `[writable]` Pool State
/// 3. `[writable]` Input Token Account (user)
/// 4. `[writable]` Output Token Account (user)
/// 5. `[writable]` Input Vault
/// 6. `[writable]` Output Vault
/// 7. `[writable]` Observation State
/// 8. `[]` Token Program
/// 9. `[writable]` Tick Array 0 (center)
/// 10. `[writable]` Tick Array 1 (directional)
/// 11. `[]` Raydium CLMM Program ID
///
/// ## `swap_v2` instruction layout (Token-2022 compatible):
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
    // Detect which instruction variant to use based on account count
    // swap_v2: 17-18 accounts (Token-2022 compatible, includes memo/mints)
    // swap: 12-13 accounts (Standard SPL tokens only)
    let use_swap_v2 = accounts.len() >= SWAP_V2_ACCOUNTS_NEEDED_NO_EXBITMAP;

    if use_swap_v2 {
        // =========================================================================
        // swap_v2: Token-2022 compatible (17-18 accounts)
        // =========================================================================
        let has_exbitmap = accounts.len() >= SWAP_V2_ACCOUNTS_NEEDED;
        let required = if has_exbitmap { SWAP_V2_ACCOUNTS_NEEDED } else { SWAP_V2_ACCOUNTS_NEEDED_NO_EXBITMAP };
        
        if accounts.len() < required {
            msg!("Raydium swap_v2: Insufficient accounts. Expected {} (exBitmap={}), got {}", 
                 required, has_exbitmap, accounts.len());
            return Err(ArbRouterError::InvalidAccount.into());
        }

        let params = SwapParams {
            amount: amount_in,
            other_amount_threshold: min_amount_out,
            sqrt_price_limit_x64: 0,
            is_base_input: true,
        };

        let mut data = Vec::with_capacity(8 + 8 + 8 + 16 + 1);
        data.extend_from_slice(&SWAP_V2_DISCRIMINATOR);
        params.serialize(&mut data)?;

        let program_idx = required - 1;
        let dex_program_id = *accounts[program_idx].key;

        // Build account metas for swap_v2
        // Writable accounts:
        // - WITH exBitmap: 2-7 (pool, ATAs, vaults, observation), 13-16 (exBitmap + tickArrays)
        // - WITHOUT exBitmap: 2-7 (pool, ATAs, vaults, observation), 13-15 (tickArrays only)
        let account_metas: Vec<AccountMeta> = accounts[..program_idx]
            .iter()
            .enumerate()
            .map(|(i, acc)| {
                let is_signer = i == 0;
                let is_writable = if has_exbitmap {
                    matches!(i, 2 | 3 | 4 | 5 | 6 | 7 | 13 | 14 | 15 | 16)
                } else {
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

        let account_infos: Vec<AccountInfo> = accounts[..required].to_vec();
        invoke(&ix, &account_infos)?;

        msg!("Raydium CLMM swap_v2 executed: {} in, min {} out (exBitmap={})", 
             amount_in, min_amount_out, has_exbitmap);
    } else {
        // =========================================================================
        // swap: Standard SPL tokens (12-13 accounts)
        // =========================================================================
        let has_exbitmap = accounts.len() >= SWAP_ACCOUNTS_NEEDED;
        let required = if has_exbitmap { SWAP_ACCOUNTS_NEEDED } else { SWAP_ACCOUNTS_NEEDED_NO_EXBITMAP };
        
        if accounts.len() < required {
            msg!("Raydium swap: Insufficient accounts. Expected {} (exBitmap={}), got {}", 
                 required, has_exbitmap, accounts.len());
            return Err(ArbRouterError::InvalidAccount.into());
        }

        let params = SwapParams {
            amount: amount_in,
            other_amount_threshold: min_amount_out,
            sqrt_price_limit_x64: 0,
            is_base_input: true,
        };

        let mut data = Vec::with_capacity(8 + 8 + 8 + 16 + 1);
        data.extend_from_slice(&SWAP_DISCRIMINATOR);
        params.serialize(&mut data)?;

        let program_idx = required - 1;
        let dex_program_id = *accounts[program_idx].key;

        // Build account metas for swap
        // Writable accounts:
        // - WITH exBitmap: 2-7 (pool, ATAs, vaults, observation), 9-11 (exBitmap + tickArrays)
        // - WITHOUT exBitmap: 2-7 (pool, ATAs, vaults, observation), 9-10 (tickArrays only)
        let account_metas: Vec<AccountMeta> = accounts[..program_idx]
            .iter()
            .enumerate()
            .map(|(i, acc)| {
                let is_signer = i == 0;
                let is_writable = if has_exbitmap {
                    matches!(i, 2 | 3 | 4 | 5 | 6 | 7 | 9 | 10 | 11)
                } else {
                    matches!(i, 2 | 3 | 4 | 5 | 6 | 7 | 9 | 10)
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

        let account_infos: Vec<AccountInfo> = accounts[..required].to_vec();
        invoke(&ix, &account_infos)?;

        msg!("Raydium CLMM swap executed: {} in, min {} out (exBitmap={})", 
             amount_in, min_amount_out, has_exbitmap);
    }

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

    #[test]
    fn test_swap_discriminator() {
        // Verify the discriminator is correct
        // sha256("global:swap")[0..8]
        let expected: [u8; 8] = [248, 198, 158, 145, 225, 117, 135, 200];
        assert_eq!(SWAP_DISCRIMINATOR, expected, 
            "swap discriminator mismatch! Expected {:?}, got {:?}", expected, SWAP_DISCRIMINATOR);
    }

    #[test]
    fn test_swap_v2_discriminator() {
        // Verify the discriminator is correct
        // sha256("global:swap_v2")[0..8]
        let expected: [u8; 8] = [43, 4, 237, 11, 26, 201, 30, 98];
        assert_eq!(SWAP_V2_DISCRIMINATOR, expected, 
            "swap_v2 discriminator mismatch! Expected {:?}, got {:?}", expected, SWAP_V2_DISCRIMINATOR);
    }
}
