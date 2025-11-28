//! Raydium CLMM (Concentrated Liquidity Market Maker) CPI integration
//!
//! Program ID: CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK
//!
//! Raydium CLMM is a concentrated liquidity DEX similar to Uniswap V3.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{instruction::Instruction, program::invoke};

use crate::constants::dex_programs::RAYDIUM_CLMM;
use crate::error::ArbRouterError;

/// Number of accounts needed for a Raydium CLMM swap
pub const ACCOUNTS_NEEDED: usize = 17;

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
/// Expected accounts (in order):
/// 0. `[signer]` Payer
/// 1. `[]` AMM Config
/// 2. `[writable]` Pool State
/// 3. `[writable]` Input Token Account (user)
/// 4. `[writable]` Output Token Account (user)
/// 5. `[writable]` Input Vault
/// 6. `[writable]` Output Vault
/// 7. `[]` Observation State
/// 8. `[]` Token Program
/// 9. `[writable]` Tick Array Lower
/// 10. `[writable]` Tick Array Current
/// 11. `[writable]` Tick Array Upper
/// 12. `[]` Oracle (optional, can be system program if not used)
/// 13. `[writable]` Input Token Mint
/// 14. `[writable]` Output Token Mint
/// 15. `[]` Memo Program (optional)
/// 16. `[]` Raydium CLMM Program
pub fn swap(
    accounts: &[AccountInfo],
    amount_in: u64,
    min_amount_out: u64,
) -> Result<()> {
    if accounts.len() < ACCOUNTS_NEEDED {
        msg!("Raydium: Insufficient accounts. Expected {}, got {}", ACCOUNTS_NEEDED, accounts.len());
        return Err(ArbRouterError::InvalidAccount.into());
    }

    // Build the swap instruction data
    let params = SwapParams {
        amount: amount_in,
        other_amount_threshold: min_amount_out,
        sqrt_price_limit_x64: 0, // No price limit
        is_base_input: true,
    };

    let mut data = Vec::with_capacity(8 + 8 + 8 + 16 + 1);
    data.extend_from_slice(&SWAP_DISCRIMINATOR);
    params.serialize(&mut data)?;

    // Build account metas
    let account_metas: Vec<AccountMeta> = accounts[..ACCOUNTS_NEEDED - 1]
        .iter()
        .enumerate()
        .map(|(i, acc)| {
            let is_signer = i == 0; // Only first account (payer) is signer
            let is_writable = matches!(i, 2 | 3 | 4 | 5 | 6 | 9 | 10 | 11 | 13 | 14);
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
        program_id: RAYDIUM_CLMM,
        accounts: account_metas,
        data,
    };

    // Invoke the swap
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

