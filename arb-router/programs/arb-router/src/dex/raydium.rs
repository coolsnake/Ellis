//! Raydium CLMM (Concentrated Liquidity Market Maker) CPI integration
//!
//! Mainnet Program ID: CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK
//! Devnet Program ID: DRayAUgENGQBKVaX8owNhgzkEDyoHTGVEGHVJT1E9pfH
//!
//! Raydium CLMM is a concentrated liquidity DEX similar to Uniswap V3.
//! The DEX program ID is passed as the last account to support both devnet and mainnet.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{instruction::Instruction, program::invoke};

use crate::error::ArbRouterError;

/// Number of accounts needed for a Raydium CLMM swap
pub const ACCOUNTS_NEEDED: usize = 18; // 17 SDK accounts + 1 Raydium program ID

/// Raydium CLMM Swap instruction discriminator
/// swap instruction: [43, 4, 237, 11, 26, 201, 30, 98]
const SWAP_DISCRIMINATOR: [u8; 8] = [43, 4, 237, 11, 26, 201, 30, 98];

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
/// Expected accounts (in order) - matching Raydium SDK order:
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
/// 11. `[]` Input Token Mint (NOT writable)
/// 12. `[]` Output Token Mint (NOT writable)
/// 13. `[writable]` Oracle/exBitmap (optional account)
/// 14. `[writable]` Tick Array Center
/// 15. `[writable]` Tick Array Lower
/// 16. `[writable]` Tick Array Upper
/// 
/// Note: Raydium CLMM Program ID is passed separately as the instruction's program_id
pub fn swap(
    accounts: &[AccountInfo],
    amount_in: u64,
    min_amount_out: u64,
    _a_to_b: bool, // Direction is encoded in account ordering (input/output ATAs and vaults)
) -> Result<()> {
    if accounts.len() < ACCOUNTS_NEEDED {
        msg!("Raydium: Insufficient accounts. Expected {}, got {}", ACCOUNTS_NEEDED, accounts.len());
        return Err(ArbRouterError::InvalidAccount.into());
    }

    // Build the swap instruction data
    // Note: is_base_input = true means amount is the INPUT amount (what we're swapping in)
    // This should always be true since we specify amount_in, regardless of swap direction
    let params = SwapParams {
        amount: amount_in,
        other_amount_threshold: min_amount_out,
        sqrt_price_limit_x64: 0,
        is_base_input: true, // Always true - we're specifying input amount
    };

    let mut data = Vec::with_capacity(8 + 8 + 8 + 16 + 1);
    data.extend_from_slice(&SWAP_DISCRIMINATOR);
    params.serialize(&mut data)?;

    // Get the DEX program ID from the last account (index 17)
    let dex_program_id = *accounts[ACCOUNTS_NEEDED - 1].key;

    // Build account metas - only first 17 accounts go to Raydium (exclude program ID at index 17)
    // Writable accounts based on SDK: 2, 3, 4, 5, 6, 7, 13, 14, 15, 16
    let account_metas: Vec<AccountMeta> = accounts[..ACCOUNTS_NEEDED - 1]
        .iter()
        .enumerate()
        .map(|(i, acc)| {
            let is_signer = i == 0; // Only first account (payer) is signer
            // Writable indices: 2, 3, 4, 5, 6, 7, 13, 14, 15, 16
            let is_writable = matches!(i, 2 | 3 | 4 | 5 | 6 | 7 | 13 | 14 | 15 | 16);
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

    // Invoke the swap - include all accounts for CPI (including the program account)
    let account_infos: Vec<AccountInfo> = accounts[..ACCOUNTS_NEEDED].to_vec();
    invoke(&ix, &account_infos)?;

    msg!("Raydium CLMM swap executed: {} in, min {} out", amount_in, min_amount_out);
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

