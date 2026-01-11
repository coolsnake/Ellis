//! PumpSwap (Pump.fun AMM) CPI integration
//!
//! Program ID: pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA (Post-graduation AMM)
//!
//! PumpSwap is the AMM used by Pump.fun for token trading after graduation.
//! Account layout updated to match official @pump-fun/pump-swap-sdk IDL v1.0.0.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{instruction::Instruction, program::invoke};

use crate::constants::dex_programs::PUMPSWAP;
use crate::error::ArbRouterError;

/// Number of accounts needed for a PumpSwap swap (matches SDK IDL v1.0.0)
pub const ACCOUNTS_NEEDED: usize = 23;

/// PumpSwap buy instruction discriminator (from IDL)
const BUY_DISCRIMINATOR: [u8; 8] = [102, 6, 61, 18, 1, 218, 235, 234];

/// PumpSwap sell instruction discriminator (from IDL)
const SELL_DISCRIMINATOR: [u8; 8] = [51, 230, 133, 164, 1, 127, 131, 173];

/// Execute a swap on PumpSwap
///
/// Expected accounts (in order, matching official SDK IDL v1.0.0):
/// 0.  `[writable]` pool - The pool account
/// 1.  `[signer, writable]` user - The user performing the swap
/// 2.  `[]` global_config - Global configuration PDA
/// 3.  `[]` base_mint - The base token mint (pump token)
/// 4.  `[]` quote_mint - The quote token mint (usually WSOL)
/// 5.  `[writable]` user_base_token_account - User's base token ATA
/// 6.  `[writable]` user_quote_token_account - User's quote token ATA
/// 7.  `[writable]` pool_base_token_account - Pool's base token vault
/// 8.  `[writable]` pool_quote_token_account - Pool's quote token vault
/// 9.  `[]` protocol_fee_recipient - Protocol fee recipient wallet
/// 10. `[writable]` protocol_fee_recipient_token_account - Protocol fee recipient's quote ATA
/// 11. `[]` base_token_program - Token program for base mint (SPL or Token-2022)
/// 12. `[]` quote_token_program - Token program for quote mint (usually SPL)
/// 13. `[]` system_program - System program
/// 14. `[]` associated_token_program - Associated token program
/// 15. `[]` event_authority - Event authority PDA
/// 16. `[]` program - PumpSwap program ID
/// 17. `[writable]` coin_creator_vault_ata - Coin creator's fee vault ATA
/// 18. `[]` coin_creator_vault_authority - Coin creator's vault authority PDA
/// 19. `[]` global_volume_accumulator - Global volume accumulator PDA
/// 20. `[writable]` user_volume_accumulator - User's volume accumulator PDA
/// 21. `[]` fee_config - Fee configuration PDA
/// 22. `[]` fee_program - Pump fee program ID
///
/// # Arguments
/// * `accounts` - DEX-specific accounts in the order above
/// * `amount_in` - Amount of input tokens to swap
/// * `min_amount_out` - Minimum output tokens (slippage protection)
/// * `is_buy` - Direction: true = buy (quote->base, SOL->Token), false = sell (base->quote, Token->SOL)
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
    // Buy: base_amount_out, max_quote_amount_in, referral_option
    // Sell: base_amount_in, min_quote_amount_out
    let mut data = Vec::with_capacity(32);
    
    if is_buy {
        // Buy instruction: buy(base_amount_out: u64, max_quote_amount_in: u64, referral: Option<...>)
        // For buy: amount_in is quote (SOL), min_amount_out is base (token)
        // So: base_amount_out = min_amount_out, max_quote_amount_in = amount_in
        data.extend_from_slice(&BUY_DISCRIMINATOR);
        data.extend_from_slice(&min_amount_out.to_le_bytes()); // base_amount_out (what we want)
        data.extend_from_slice(&amount_in.to_le_bytes());      // max_quote_amount_in (max we pay)
        // Referral option: None (0 byte for Option::None in Anchor)
        data.push(0);
    } else {
        // Sell instruction: sell(base_amount_in: u64, min_quote_amount_out: u64)
        // For sell: amount_in is base (token), min_amount_out is quote (SOL)
        data.extend_from_slice(&SELL_DISCRIMINATOR);
        data.extend_from_slice(&amount_in.to_le_bytes());      // base_amount_in (what we sell)
        data.extend_from_slice(&min_amount_out.to_le_bytes()); // min_quote_amount_out (min we receive)
    }

    // Build account metas matching SDK IDL order
    // Writable accounts: 0 (pool), 1 (user), 5-8 (token accounts), 10 (protocol fee ata), 17 (creator vault), 20 (user volume)
    // Signer: 1 (user)
    let account_metas: Vec<AccountMeta> = accounts[..ACCOUNTS_NEEDED]
        .iter()
        .enumerate()
        .map(|(i, acc)| {
            let is_signer = i == 1; // User at index 1 is the signer
            let is_writable = matches!(i, 0 | 1 | 5 | 6 | 7 | 8 | 10 | 17 | 20);
            
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

    // Invoke the swap - pass all accounts for CPI
    let account_infos: Vec<AccountInfo> = accounts[..ACCOUNTS_NEEDED].to_vec();
    invoke(&ix, &account_infos)?;

    msg!("PumpSwap swap executed: {} in, min {} out, is_buy: {}", amount_in, min_amount_out, is_buy);
    Ok(())
}

/// Execute a sell on PumpSwap (Token -> SOL)
/// Kept for backwards compatibility, delegates to swap()
pub fn sell(
    accounts: &[AccountInfo],
    amount_in: u64,
    min_amount_out: u64,
) -> Result<()> {
    swap(accounts, amount_in, min_amount_out, false)
}

/// Derive the global config PDA
pub fn derive_global_config() -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[b"global_config"],
        &PUMPSWAP,
    )
}

/// Derive the event authority PDA
pub fn derive_event_authority() -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[b"__event_authority"],
        &PUMPSWAP,
    )
}

/// Derive coin creator vault authority PDA
pub fn derive_coin_creator_vault_authority(coin_creator: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[b"coin_creator_vault_authority", coin_creator.as_ref()],
        &PUMPSWAP,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_accounts_needed() {
        assert_eq!(ACCOUNTS_NEEDED, 23);
    }

    #[test]
    fn test_buy_discriminator() {
        assert_eq!(BUY_DISCRIMINATOR, [102, 6, 61, 18, 1, 218, 235, 234]);
    }

    #[test]
    fn test_sell_discriminator() {
        assert_eq!(SELL_DISCRIMINATOR, [51, 230, 133, 164, 1, 127, 131, 173]);
    }
}
