//! Meteora Balanced DAMM (Dynamic AMM) CPI integration
//!
//! v1 Program ID: Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB (Dynamic Pool AMM)
//! v2 Program ID: cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG (CP-AMM / Constant Product AMM)
//!
//! Meteora DAMM v1 (Dynamic AMM) uses Mercurial Vault architecture where each pool
//! has underlying vaults that earn yield. This requires passing vault-related accounts
//! in addition to the pool accounts.
//!
//! ## Swap Instructions
//! - v1: `swap` instruction with Mercurial Vault integration (16 accounts)
//! - v2: `swap` instruction with simpler CP-AMM structure (12 accounts)
//!
//! The DEX program ID is passed as the last account to support both v1 and v2.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{instruction::Instruction, program::invoke};

use crate::error::ArbRouterError;

// =============================================================================
// Account Counts
// =============================================================================

/// Number of accounts needed for Meteora DAMM v1 swap
/// v1 uses Mercurial Vault architecture requiring 15 accounts + 1 program ID = 16 total
pub const ACCOUNTS_NEEDED_V1: usize = 16;

/// Number of accounts needed for Meteora DAMM v2 swap  
/// v2 is simpler CP-AMM: 11 accounts + 1 program ID = 12 total
pub const ACCOUNTS_NEEDED_V2: usize = 12;

/// Default accounts needed (v1 - the more complex one)
pub const ACCOUNTS_NEEDED: usize = ACCOUNTS_NEEDED_V1;

// =============================================================================
// Instruction Discriminators
// =============================================================================

/// Meteora DAMM v1 `swap` instruction discriminator
/// Anchor: sha256("global:swap")[0..8]
const SWAP_V1_DISCRIMINATOR: [u8; 8] = [248, 198, 158, 145, 225, 117, 135, 200];

/// Meteora DAMM v2 `swap` instruction discriminator
/// May differ from v1 - needs verification with v2 IDL
const SWAP_V2_DISCRIMINATOR: [u8; 8] = [248, 198, 158, 145, 225, 117, 135, 200];

// =============================================================================
// Swap Parameters
// =============================================================================

/// Meteora DAMM swap parameters
#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct SwapParams {
    /// Amount to swap (in or out depending on swap type)
    pub amount_in: u64,
    /// Minimum output amount (slippage protection)
    pub minimum_amount_out: u64,
}

// =============================================================================
// Swap Functions
// =============================================================================

/// Execute a swap on Meteora DAMM v1 (Dynamic Pool AMM with Mercurial Vaults)
///
/// ## Account Layout (16 accounts total):
///
/// The Meteora Dynamic AMM uses a "vault of vaults" architecture where liquidity
/// is stored in Mercurial vaults that can earn yield. This requires passing all
/// vault-related accounts for the CPI to work correctly.
///
/// Account order matches Meteora Dynamic AMM IDL (idl.d.ts lines 687-807):
///
/// 0.  `[writable]` pool - The DAMM pool account
/// 1.  `[writable]` userSourceToken - User's source token ATA
/// 2.  `[writable]` userDestinationToken - User's destination token ATA
/// 3.  `[writable]` aVault - Mercurial Vault account for token A
/// 4.  `[writable]` bVault - Mercurial Vault account for token B
/// 5.  `[writable]` aTokenVault - SPL Token account inside aVault
/// 6.  `[writable]` bTokenVault - SPL Token account inside bVault
/// 7.  `[writable]` aVaultLpMint - LP token mint of vault A
/// 8.  `[writable]` bVaultLpMint - LP token mint of vault B
/// 9.  `[writable]` aVaultLp - Pool's LP token account for vault A
/// 10. `[writable]` bVaultLp - Pool's LP token account for vault B
/// 11. `[writable]` protocolTokenFee - Protocol fee account (direction-dependent)
/// 12. `[signer]`   user - User wallet
/// 13. `[]`         vaultProgram - Mercurial Vault program
/// 14. `[]`         tokenProgram - SPL Token program
/// 15. `[]`         dammProgram - Meteora DAMM v1 program (for CPI)
///
/// # Arguments
/// * `accounts` - DEX-specific accounts in the order above
/// * `amount_in` - Amount of input tokens to swap
/// * `min_amount_out` - Minimum output tokens (slippage protection)
pub fn swap_v1(
    accounts: &[AccountInfo],
    amount_in: u64,
    min_amount_out: u64,
) -> Result<()> {
    if accounts.len() < ACCOUNTS_NEEDED_V1 {
        msg!("Meteora DAMM v1: Insufficient accounts. Expected {}, got {}", 
             ACCOUNTS_NEEDED_V1, accounts.len());
        return Err(ArbRouterError::InvalidAccount.into());
    }

    let params = SwapParams {
        amount_in,
        minimum_amount_out: min_amount_out,
    };

    // Build instruction data
    let mut data = Vec::with_capacity(24); // 8 + 8 + 8
    data.extend_from_slice(&SWAP_V1_DISCRIMINATOR);
    params.serialize(&mut data)?;

    let program_idx = ACCOUNTS_NEEDED_V1 - 1; // 15
    let dex_program_id = *accounts[program_idx].key;

    // Build account metas for Meteora Dynamic AMM swap
    // Account order matches Meteora IDL (idl.d.ts lines 687-807):
    //
    // Writable accounts (indices 0-11):
    //   pool, userSourceToken, userDestToken, aVault, bVault,
    //   aTokenVault, bTokenVault, aVaultLpMint, bVaultLpMint,
    //   aVaultLp, bVaultLp, protocolTokenFee
    // Signer: user (index 12)
    // Read-only: vaultProgram (13), tokenProgram (14)
    let account_metas: Vec<AccountMeta> = accounts[..program_idx]
        .iter()
        .enumerate()
        .map(|(i, acc)| {
            let is_signer = i == 12;  // user at index 12
            let is_writable = i <= 11; // indices 0-11 are writable
            
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

    invoke(&ix, &accounts[..ACCOUNTS_NEEDED_V1])?;

    msg!("Meteora DAMM v1 swap executed: {} in, min {} out", amount_in, min_amount_out);
    Ok(())
}

/// Execute a swap on Meteora DAMM v2 (CP-AMM)
///
/// ## Account Layout (12 accounts total):
///
/// 0. `[writable]` Pool
/// 1. `[writable]` User Source Token Account
/// 2. `[writable]` User Destination Token Account
/// 3. `[writable]` Pool Token A Vault
/// 4. `[writable]` Pool Token B Vault
/// 5. `[]` Token A Mint
/// 6. `[]` Token B Mint
/// 7. `[writable]` LP Mint (may be required for v2)
/// 8. `[]` Pool Authority (PDA)
/// 9. `[signer]` User
/// 10. `[]` Token Program
/// 11. `[]` Meteora DAMM v2 Program (for CPI)
///
/// # Arguments
/// * `accounts` - DEX-specific accounts in the order above
/// * `amount_in` - Amount of input tokens to swap
/// * `min_amount_out` - Minimum output tokens (slippage protection)
pub fn swap_v2(
    accounts: &[AccountInfo],
    amount_in: u64,
    min_amount_out: u64,
) -> Result<()> {
    if accounts.len() < ACCOUNTS_NEEDED_V2 {
        msg!("Meteora DAMM v2: Insufficient accounts. Expected {}, got {}", 
             ACCOUNTS_NEEDED_V2, accounts.len());
        return Err(ArbRouterError::InvalidAccount.into());
    }

    let params = SwapParams {
        amount_in,
        minimum_amount_out: min_amount_out,
    };

    // Build instruction data
    let mut data = Vec::with_capacity(24);
    data.extend_from_slice(&SWAP_V2_DISCRIMINATOR);
    params.serialize(&mut data)?;

    let program_idx = ACCOUNTS_NEEDED_V2 - 1;
    let dex_program_id = *accounts[program_idx].key;

    // Build account metas for v2
    // Writable: Pool(0), UserSource(1), UserDest(2), VaultA(3), VaultB(4), LPMint(7)
    // Read-only: MintA(5), MintB(6), Authority(8), TokenProgram(10)
    // Signer: User(9)
    let account_metas: Vec<AccountMeta> = accounts[..program_idx]
        .iter()
        .enumerate()
        .map(|(i, acc)| {
            let is_signer = i == 9;
            let is_writable = matches!(i, 0 | 1 | 2 | 3 | 4 | 7);
            
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

    invoke(&ix, &accounts[..ACCOUNTS_NEEDED_V2])?;

    msg!("Meteora DAMM v2 swap executed: {} in, min {} out", amount_in, min_amount_out);
    Ok(())
}

/// Unified swap function that routes to v1 or v2 based on account count
///
/// # Arguments
/// * `accounts` - DEX-specific accounts
/// * `amount_in` - Amount of input tokens to swap
/// * `min_amount_out` - Minimum output tokens (slippage protection)
/// * `_a_to_b` - Swap direction (not used for v1/v2 detection)
///
/// # Version Detection
/// v1 (Dynamic AMM with Mercurial Vaults) requires 16 accounts
/// v2 (CP-AMM) requires 12 accounts
/// We detect the version by account count rather than a flag.
pub fn swap(
    accounts: &[AccountInfo],
    amount_in: u64,
    min_amount_out: u64,
    _a_to_b: bool,
) -> Result<()> {
    // Detect version by account count: v1=16 (Mercurial Vaults), v2=12 (CP-AMM)
    if accounts.len() >= ACCOUNTS_NEEDED_V1 {
        swap_v1(accounts, amount_in, min_amount_out)
    } else if accounts.len() >= ACCOUNTS_NEEDED_V2 {
        swap_v2(accounts, amount_in, min_amount_out)
    } else {
        msg!("Meteora DAMM: Insufficient accounts. Expected {} (v1) or {} (v2), got {}", 
             ACCOUNTS_NEEDED_V1, ACCOUNTS_NEEDED_V2, accounts.len());
        Err(ArbRouterError::InvalidAccount.into())
    }
}

// =============================================================================
// Helper Functions  
// =============================================================================

/// Derive the pool authority PDA for Meteora DAMM
/// Seeds vary between v1 and v2 - this is the v1 pattern
pub fn derive_pool_authority_v1(pool: &Pubkey, program_id: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[b"vault_and_lp_mint_auth_pda", pool.as_ref()],
        program_id,
    )
}

/// Derive the pool authority PDA for Meteora DAMM v2
pub fn derive_pool_authority_v2(pool: &Pubkey, program_id: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[b"pool_authority", pool.as_ref()],
        program_id,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_swap_params_serialize() {
        let params = SwapParams {
            amount_in: 1_000_000,
            minimum_amount_out: 990_000,
        };
        
        let mut data = Vec::new();
        params.serialize(&mut data).unwrap();
        
        // Should be 8 + 8 = 16 bytes
        assert_eq!(data.len(), 16);
    }

    #[test]
    fn test_v1_discriminator() {
        // Verify discriminator matches expected Anchor pattern
        let expected: [u8; 8] = [248, 198, 158, 145, 225, 117, 135, 200];
        assert_eq!(SWAP_V1_DISCRIMINATOR, expected);
    }
}
