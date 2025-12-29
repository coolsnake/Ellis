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

/// Minimum number of bin arrays to provide to Meteora DLMM `swap2`.
/// For execute (multi-hop), we use 3 bin arrays directionally:
/// - Active bin array (where current price is)
/// - 2 more bin arrays in the direction of price movement
/// Off-chain builder selects these based on swap direction (X→Y = lower, Y→X = upper)
pub const MIN_BIN_ARRAYS: usize = 3;

/// Number of accounts needed for a Meteora DLMM swap
/// 14 fixed accounts + 1 program + MIN_BIN_ARRAYS bin arrays
/// NOTE: Memo Program is NOT included - Meteora swap2 doesn't use it!
pub const ACCOUNTS_NEEDED: usize = 15 + MIN_BIN_ARRAYS; // 18 total

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
/// Expected accounts (in order) - matches Meteora swap2 instruction layout:
/// 0. `[writable]` LB Pair
/// 1. `[]` Bin Array Bitmap Extension (optional, use program ID as placeholder)
/// 2. `[writable]` Reserve X (token vault)
/// 3. `[writable]` Reserve Y (token vault)
/// 4. `[writable]` User Token X (user's token X account - NOT "token in"!)
/// 5. `[writable]` User Token Y (user's token Y account - NOT "token out"!)
/// 6. `[]` Token X Mint
/// 7. `[]` Token Y Mint
/// 
/// CRITICAL: User token accounts must be in X/Y order, not input/output order!
/// The program infers swap direction from amounts and which account has funds.
/// 8. `[writable]` Oracle
/// 9. `[]` Host Fee In (program ID as placeholder)
/// 10. `[signer, writable]` User (authority)
/// 11. `[]` Token X Program
/// 12. `[]` Token Y Program
/// 13. `[]` Event Authority
/// 14. `[]` Meteora DLMM Program (for CPI invoke)
/// 15+. `[writable]` Bin Arrays (remaining accounts, variable count)
/// 
/// NOTE: Memo Program is NOT included - Meteora swap2 doesn't use it!
pub fn swap(
    accounts: &[AccountInfo],
    amount_in: u64,
    min_amount_out: u64,
) -> Result<()> {
    if accounts.len() < ACCOUNTS_NEEDED {
        msg!("Meteora: Insufficient accounts. Expected at least {}, got {}", ACCOUNTS_NEEDED, accounts.len());
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

    // Account structure (matches Meteora swap2 - NO Memo Program!):
    // 0-13: Fixed accounts (14 accounts)
    // 14: Meteora DLMM Program (for CPI)
    // 15+: Bin arrays (remaining accounts, writable)
    
    // For the instruction, we need: fixed accounts (0-13) + bin arrays (15+)
    // The program at index 14 is used as program_id, not in account_metas
    
    let mut account_metas: Vec<AccountMeta> = Vec::new();
    
    // Add fixed accounts (0-13)
    for (i, acc) in accounts[..14].iter().enumerate() {
        let is_signer = i == 10; // User is signer
        // Writable: lbPair(0), reserves(2,3), userTokens(4,5), oracle(8), user(10)
        // Note: hostFeeIn(9), eventAuth(13) are NOT writable
        let is_writable = matches!(i, 0 | 2 | 3 | 4 | 5 | 8 | 10);
        if is_signer {
            account_metas.push(AccountMeta::new(*acc.key, true));
        } else if is_writable {
            account_metas.push(AccountMeta::new(*acc.key, false));
        } else {
            account_metas.push(AccountMeta::new_readonly(*acc.key, false));
        }
    }
    
    // Add bin arrays (15+) - all are writable
    for acc in accounts[15..].iter() {
        account_metas.push(AccountMeta::new(*acc.key, false));
    }

    let ix = Instruction {
        program_id: METEORA_DLMM,
        accounts: account_metas,
        data,
    };

    // Invoke the swap - include all accounts for the CPI
    invoke(&ix, accounts)?;

    msg!("Meteora DLMM swap2 executed: {} in, min {} out, {} bin arrays", 
         amount_in, min_amount_out, accounts.len() - 15);
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

