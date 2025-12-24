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
/// 16 fixed accounts + 2 bin arrays = 18 total
pub const ACCOUNTS_NEEDED: usize = 18;

/// Meteora DLMM swap2 instruction discriminator
/// swap2 is preferred over swap - handles bitmap extension edge cases better
/// SHA256("global:swap2")[0..8] = [65, 75, 63, 76, 235, 91, 91, 136]
const SWAP2_DISCRIMINATOR: [u8; 8] = [65, 75, 63, 76, 235, 91, 91, 136];

/// Meteora DLMM swap2 parameters
#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct Swap2Params {
    /// Amount to swap
    pub amount_in: u64,
    /// Minimum output amount
    pub min_amount_out: u64,
    // Note: slices Vec is serialized separately as empty (4 bytes of zeros)
}

/// Execute a swap on Meteora DLMM
///
/// Expected accounts (in order):
/// 0. `[writable]` LB Pair
/// 1. `[]` Bin Array Bitmap Extension (optional, use program ID as placeholder)
/// 2. `[writable]` Reserve X (token vault)
/// 3. `[writable]` Reserve Y (token vault)
/// 4. `[writable]` User Token In
/// 5. `[writable]` User Token Out
/// 6. `[]` Token X Mint
/// 7. `[]` Token Y Mint
/// 8. `[writable]` Oracle
/// 9. `[]` Host Fee In (use program ID as placeholder)
/// 10. `[signer, writable]` User (authority)
/// 11. `[]` Token X Program
/// 12. `[]` Token Y Program
/// 13. `[]` Memo Program
/// 14. `[]` Event Authority
/// 15. `[writable]` Bin Array Lower (remaining account)
/// 16. `[writable]` Bin Array Upper (remaining account)
/// 17. `[]` Meteora DLMM Program (for CPI invoke, must be last)
pub fn swap(
    accounts: &[AccountInfo],
    amount_in: u64,
    min_amount_out: u64,
) -> Result<()> {
    if accounts.len() < ACCOUNTS_NEEDED {
        msg!("Meteora: Insufficient accounts. Expected {}, got {}", ACCOUNTS_NEEDED, accounts.len());
        return Err(ArbRouterError::InvalidAccount.into());
    }

    // Build the swap2 instruction data
    let params = Swap2Params {
        amount_in,
        min_amount_out,
    };

    // swap2 data format: [discriminator(8), amount_in(8), min_amount_out(8), slices_len(4)]
    // slices is an empty Vec, so we just write 4 bytes of zeros for the length
    let mut data = Vec::with_capacity(8 + 8 + 8 + 4);
    data.extend_from_slice(&SWAP2_DISCRIMINATOR);
    params.serialize(&mut data)?;
    data.extend_from_slice(&[0u8; 4]); // Empty slices Vec (length = 0)

    // Build account metas for Meteora swap instruction
    // Accounts 0-14 are fixed, 15-16 are bin arrays, 17 is the program for CPI
    // Take accounts 0-16 (17 accounts) for the instruction, account 17 is for CPI invoke
    let account_metas: Vec<AccountMeta> = accounts[..ACCOUNTS_NEEDED - 1]
        .iter()
        .enumerate()
        .map(|(i, acc)| {
            let is_signer = i == 10; // User is signer
            // Writable: lbPair(0), reserves(2,3), userTokens(4,5), oracle(8), user(10), binArrays(15,16)
            let is_writable = matches!(i, 0 | 2 | 3 | 4 | 5 | 8 | 10 | 15 | 16);
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

    msg!("Meteora DLMM swap2 executed: {} in, min {} out", amount_in, min_amount_out);
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
    fn test_swap2_params_serialize() {
        let params = Swap2Params {
            amount_in: 1000000,
            min_amount_out: 990000,
        };
        
        let mut data = Vec::new();
        params.serialize(&mut data).unwrap();
        
        // Should be 8 + 8 = 16 bytes (slices added separately)
        assert_eq!(data.len(), 16);
    }
}

