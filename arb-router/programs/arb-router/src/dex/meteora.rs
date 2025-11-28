//! Meteora DLMM (Dynamic Liquidity Market Maker) CPI integration
//!
//! Program ID: LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo
//!
//! Meteora DLMM uses a discrete liquidity distribution model with "bins"
//! for efficient capital usage.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{instruction::Instruction, program::invoke};

use crate::constants::dex_programs::METEORA_DLMM;
use crate::error::ArbRouterError;

/// Number of accounts needed for a Meteora DLMM swap
pub const ACCOUNTS_NEEDED: usize = 16;

/// Meteora DLMM swap instruction discriminator
/// swap instruction: [248, 198, 158, 145, 225, 117, 135, 200]
const SWAP_DISCRIMINATOR: [u8; 8] = [248, 198, 158, 145, 225, 117, 135, 200];

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
/// Expected accounts (in order):
/// 0. `[writable]` LB Pair
/// 1. `[writable]` Bin Array Bitmap Extension (optional, can be system program)
/// 2. `[writable]` Reserve X (token vault)
/// 3. `[writable]` Reserve Y (token vault)
/// 4. `[writable]` User Token In
/// 5. `[writable]` User Token Out
/// 6. `[]` Token X Mint
/// 7. `[]` Token Y Mint
/// 8. `[writable]` Oracle
/// 9. `[writable]` Host Fee In
/// 10. `[signer]` User (authority)
/// 11. `[]` Token Program
/// 12. `[]` Event Authority
/// 13. `[]` Program (Meteora DLMM)
/// 14. `[writable]` Bin Array Lower
/// 15. `[writable]` Bin Array Upper
pub fn swap(
    accounts: &[AccountInfo],
    amount_in: u64,
    min_amount_out: u64,
) -> Result<()> {
    if accounts.len() < ACCOUNTS_NEEDED {
        msg!("Meteora: Insufficient accounts. Expected {}, got {}", ACCOUNTS_NEEDED, accounts.len());
        return Err(ArbRouterError::InvalidAccount.into());
    }

    // Build the swap instruction data
    let params = SwapParams {
        amount_in,
        min_amount_out,
    };

    let mut data = Vec::with_capacity(8 + 8 + 8);
    data.extend_from_slice(&SWAP_DISCRIMINATOR);
    params.serialize(&mut data)?;

    // Build account metas
    let account_metas: Vec<AccountMeta> = accounts[..ACCOUNTS_NEEDED - 1]
        .iter()
        .enumerate()
        .map(|(i, acc)| {
            let is_signer = i == 10; // User is signer
            let is_writable = matches!(i, 0 | 1 | 2 | 3 | 4 | 5 | 8 | 9 | 14 | 15);
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
        program_id: METEORA_DLMM,
        accounts: account_metas,
        data,
    };

    // Invoke the swap
    let account_infos: Vec<AccountInfo> = accounts[..ACCOUNTS_NEEDED].to_vec();
    invoke(&ix, &account_infos)?;

    msg!("Meteora DLMM swap executed: {} in, min {} out", amount_in, min_amount_out);
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

