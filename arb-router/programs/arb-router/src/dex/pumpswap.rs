//! PumpSwap (Pump.fun AMM) CPI integration
//!
//! Program ID: 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P
//!
//! PumpSwap is the AMM used by Pump.fun for token trading.
//! It's a simpler constant product AMM.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{instruction::Instruction, program::invoke};

use crate::constants::dex_programs::PUMPSWAP;
use crate::error::ArbRouterError;

/// Number of accounts needed for a PumpSwap swap
pub const ACCOUNTS_NEEDED: usize = 12;

/// PumpSwap buy instruction discriminator
const BUY_DISCRIMINATOR: [u8; 8] = [102, 6, 61, 18, 1, 218, 235, 234];

/// PumpSwap sell instruction discriminator  
const SELL_DISCRIMINATOR: [u8; 8] = [51, 230, 133, 164, 1, 127, 131, 173];

/// PumpSwap swap parameters
#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct BuyParams {
    /// Amount of SOL to spend
    pub amount: u64,
    /// Minimum tokens to receive
    pub min_tokens_out: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct SellParams {
    /// Amount of tokens to sell
    pub amount: u64,
    /// Minimum SOL to receive
    pub min_sol_out: u64,
}

/// Execute a swap on PumpSwap
///
/// Expected accounts (in order):
/// 0. `[]` Global Config
/// 1. `[writable]` Fee Recipient
/// 2. `[]` Mint (the pump.fun token)
/// 3. `[writable]` Bonding Curve
/// 4. `[writable]` Bonding Curve Token Account
/// 5. `[writable]` Associated Bonding Curve
/// 6. `[writable]` User Token Account
/// 7. `[signer, writable]` User
/// 8. `[]` System Program
/// 9. `[]` Token Program
/// 10. `[]` Rent
/// 11. `[]` PumpSwap Program
///
/// # Arguments
/// * `accounts` - DEX-specific accounts in the order above
/// * `amount_in` - Amount of input tokens to swap
/// * `min_amount_out` - Minimum output tokens (slippage protection)
/// * `is_buy` - Direction: true = buy (SOL->Token), false = sell (Token->SOL)
pub fn swap(
    accounts: &[AccountInfo],
    amount_in: u64,
    min_amount_out: u64,
    is_buy: bool,
) -> Result<()> {
    if accounts.len() < ACCOUNTS_NEEDED {
        msg!("PumpSwap: Insufficient accounts. Expected {}, got {}", ACCOUNTS_NEEDED, accounts.len());
        return Err(ArbRouterError::InvalidAccount.into());
    }

    // Build instruction data based on direction
    let mut data = Vec::with_capacity(8 + 8 + 8);
    
    if is_buy {
        let params = BuyParams {
            amount: amount_in,
            min_tokens_out: min_amount_out,
        };
        data.extend_from_slice(&BUY_DISCRIMINATOR);
        params.serialize(&mut data)?;
    } else {
        let params = SellParams {
            amount: amount_in,
            min_sol_out: min_amount_out,
        };
        data.extend_from_slice(&SELL_DISCRIMINATOR);
        params.serialize(&mut data)?;
    }

    // Build account metas
    let account_metas: Vec<AccountMeta> = accounts[..ACCOUNTS_NEEDED - 1]
        .iter()
        .enumerate()
        .map(|(i, acc)| {
            let is_signer = i == 7; // User is signer
            let is_writable = matches!(i, 1 | 3 | 4 | 5 | 6 | 7);
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
        program_id: PUMPSWAP,
        accounts: account_metas,
        data,
    };

    // Invoke the swap
    let account_infos: Vec<AccountInfo> = accounts[..ACCOUNTS_NEEDED].to_vec();
    invoke(&ix, &account_infos)?;

    msg!("PumpSwap swap executed: {} in, min {} out, is_buy: {}", amount_in, min_amount_out, is_buy);
    Ok(())
}

/// Execute a sell on PumpSwap (Token -> SOL)
pub fn sell(
    accounts: &[AccountInfo],
    amount_in: u64,
    min_amount_out: u64,
) -> Result<()> {
    if accounts.len() < ACCOUNTS_NEEDED {
        msg!("PumpSwap: Insufficient accounts. Expected {}, got {}", ACCOUNTS_NEEDED, accounts.len());
        return Err(ArbRouterError::InvalidAccount.into());
    }

    let params = SellParams {
        amount: amount_in,
        min_sol_out: min_amount_out,
    };

    let mut data = Vec::with_capacity(8 + 8 + 8);
    data.extend_from_slice(&SELL_DISCRIMINATOR);
    params.serialize(&mut data)?;

    // Build account metas (same structure as buy)
    let account_metas: Vec<AccountMeta> = accounts[..ACCOUNTS_NEEDED - 1]
        .iter()
        .enumerate()
        .map(|(i, acc)| {
            let is_signer = i == 7;
            let is_writable = matches!(i, 1 | 3 | 4 | 5 | 6 | 7);
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
        program_id: PUMPSWAP,
        accounts: account_metas,
        data,
    };

    let account_infos: Vec<AccountInfo> = accounts[..ACCOUNTS_NEEDED].to_vec();
    invoke(&ix, &account_infos)?;

    msg!("PumpSwap sell executed: {} in, min {} out", amount_in, min_amount_out);
    Ok(())
}

/// Derive bonding curve PDA for a token
pub fn derive_bonding_curve(mint: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[b"bonding-curve", mint.as_ref()],
        &PUMPSWAP,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_buy_params_serialize() {
        let params = BuyParams {
            amount: 1000000,
            min_tokens_out: 990000,
        };
        
        let mut data = Vec::new();
        params.serialize(&mut data).unwrap();
        
        assert_eq!(data.len(), 16);
    }

    #[test]
    fn test_sell_params_serialize() {
        let params = SellParams {
            amount: 1000000,
            min_sol_out: 990000,
        };
        
        let mut data = Vec::new();
        params.serialize(&mut data).unwrap();
        
        assert_eq!(data.len(), 16);
    }
}

