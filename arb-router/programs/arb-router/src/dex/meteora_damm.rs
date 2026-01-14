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
//! - v2: `swap` instruction with simpler CP-AMM structure (11 accounts)
//!
//! The DEX program ID is passed as the last account to support both v1 and v2.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{instruction::Instruction, program::invoke};

use crate::error::ArbRouterError;

// =============================================================================
// Account Counts
// =============================================================================

/// Minimum number of accounts needed for Meteora DAMM v1 swap
/// v1 uses Mercurial Vault architecture requiring 15 accounts + 1 program ID = 16 total
/// For stable/depeg pools, additional remaining accounts may be passed after position 15
pub const ACCOUNTS_NEEDED_V1: usize = 16;

/// Number of accounts needed for Meteora DAMM v2 swap  
/// v2 CP-AMM swap2: 12 accounts + 1 program ID = 13 total (no referral)
/// Account layout matches @meteora-ag/cp-amm-sdk swap2 instruction
pub const ACCOUNTS_NEEDED_V2: usize = 13;

/// Default accounts needed (v1 - the more complex one)
pub const ACCOUNTS_NEEDED: usize = ACCOUNTS_NEEDED_V1;

// =============================================================================
// Instruction Discriminators
// =============================================================================

/// Meteora DAMM v1 `swap` instruction discriminator
/// Anchor: sha256("global:swap")[0..8]
const SWAP_V1_DISCRIMINATOR: [u8; 8] = [248, 198, 158, 145, 225, 117, 135, 200];

/// Meteora DAMM v2 `swap2` instruction discriminator
/// Anchor: sha256("global:swap2")[0..8]
/// CP-AMM uses swap2 instruction, not swap
const SWAP_V2_DISCRIMINATOR: [u8; 8] = [65, 75, 63, 76, 235, 91, 91, 136];

// =============================================================================
// Swap Parameters
// =============================================================================

/// Meteora DAMM v1 swap parameters
#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct SwapParams {
    /// Amount to swap (in or out depending on swap type)
    pub amount_in: u64,
    /// Minimum output amount (slippage protection)
    pub minimum_amount_out: u64,
}

/// Meteora DAMM v2 (CP-AMM) swap2 parameters
/// Matches swapParameters2 from @meteora-ag/cp-amm-sdk IDL
#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct SwapParams2 {
    /// Amount in (for ExactIn/PartialFill) or amount out (for ExactOut)
    pub amount0: u64,
    /// Minimum amount out (for ExactIn/PartialFill) or maximum amount in (for ExactOut)
    pub amount1: u64,
    /// Swap mode: 0=ExactIn, 1=PartialFill, 2=ExactOut
    pub swap_mode: u8,
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
        msg!("Meteora DAMM v1: Insufficient accounts. Expected at least {}, got {}", 
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

    let program_idx = ACCOUNTS_NEEDED_V1 - 1; // 15 (fixed position of program ID)
    let dex_program_id = *accounts[program_idx].key;
    
    // Calculate remaining accounts count (accounts after position 15)
    let remaining_accounts_count = accounts.len().saturating_sub(ACCOUNTS_NEEDED_V1);
    
    msg!("Meteora DAMM v1: {} total accounts, {} remaining accounts", 
         accounts.len(), remaining_accounts_count);

    // Build account metas for Meteora Dynamic AMM swap
    // Account order matches Meteora IDL (idl.d.ts lines 687-807):
    //
    // Fixed accounts (indices 0-14):
    //   Writable: pool(0), userSourceToken(1), userDestToken(2), aVault(3), bVault(4),
    //             aTokenVault(5), bTokenVault(6), aVaultLpMint(7), bVaultLpMint(8),
    //             aVaultLp(9), bVaultLp(10), protocolTokenFee(11)
    //   Signer: user(12)
    //   Read-only: vaultProgram(13), tokenProgram(14)
    // 
    // Remaining accounts (indices 16+) for stable/depeg pools:
    //   These are read-only accounts used for price calculations (marinade, lido, splStake)
    let mut account_metas: Vec<AccountMeta> = accounts[..program_idx]
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
    
    // Add remaining accounts (for stable/depeg pools)
    // These come after the program ID (position 15) in our account array
    for i in ACCOUNTS_NEEDED_V1..accounts.len() {
        account_metas.push(AccountMeta::new_readonly(*accounts[i].key, false));
    }

    let ix = Instruction {
        program_id: dex_program_id,
        accounts: account_metas,
        data,
    };

    // Pass all accounts to invoke (including remaining accounts)
    invoke(&ix, accounts)?;

    msg!("Meteora DAMM v1 swap executed: {} in, min {} out, {} remaining accounts", 
         amount_in, min_amount_out, remaining_accounts_count);
    Ok(())
}

/// Execute a swap on Meteora DAMM v2 (CP-AMM) using swap2 instruction
///
/// ## Account Layout (13 accounts total):
///
/// Matches @meteora-ag/cp-amm-sdk swap2 instruction layout (without optional referral):
///
/// 0. `[]` Pool Authority (fixed: HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC)
/// 1. `[writable]` Pool
/// 2. `[writable]` Input Token Account (user's source ATA)
/// 3. `[writable]` Output Token Account (user's dest ATA)
/// 4. `[writable]` Token A Vault
/// 5. `[writable]` Token B Vault
/// 6. `[]` Token A Mint
/// 7. `[]` Token B Mint
/// 8. `[signer]` Payer (user)
/// 9. `[]` Token A Program
/// 10. `[]` Token B Program
/// 11. `[]` Event Authority (PDA)
/// 12. `[]` Meteora DAMM v2 Program (for CPI)
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

    // Use SwapParams2 for v2 swap2 instruction (includes swap_mode)
    let params = SwapParams2 {
        amount0: amount_in,
        amount1: min_amount_out,
        swap_mode: 0, // ExactIn mode
    };

    // Build instruction data: 8 (discriminator) + 8 + 8 + 1 = 25 bytes
    let mut data = Vec::with_capacity(25);
    data.extend_from_slice(&SWAP_V2_DISCRIMINATOR);
    params.serialize(&mut data)?;

    let program_idx = ACCOUNTS_NEEDED_V2 - 1; // 13 (last account is program ID)
    let dex_program_id = *accounts[program_idx].key;

    // Build account metas for v2 CP-AMM swap2 instruction (without optional referral)
    // Fixed layout from @meteora-ag/cp-amm-sdk IDL:
    // Writable: Pool(1), InputToken(2), OutputToken(3), VaultA(4), VaultB(5)
    // Signer: Payer(8)
    // Read-only: PoolAuthority(0), MintA(6), MintB(7), TokenProgA(9), TokenProgB(10), EventAuth(11)
    let account_metas: Vec<AccountMeta> = accounts[..program_idx]
        .iter()
        .enumerate()
        .map(|(i, acc)| {
            let is_signer = i == 8;  // Payer at index 8
            let is_writable = matches!(i, 1 | 2 | 3 | 4 | 5);  // Pool, user tokens, vaults (NOT referral - using placeholder)
            
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
/// v2 (CP-AMM swap2) requires 13 accounts (no referral)
/// We detect the version by account count rather than a flag.
pub fn swap(
    accounts: &[AccountInfo],
    amount_in: u64,
    min_amount_out: u64,
    _a_to_b: bool,
) -> Result<()> {
    // Detect version by account count: v1=16 (Mercurial Vaults), v2=13 (CP-AMM swap2)
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
    fn test_swap_params2_serialize() {
        let params = SwapParams2 {
            amount0: 1_000_000,
            amount1: 990_000,
            swap_mode: 0, // ExactIn
        };
        
        let mut data = Vec::new();
        params.serialize(&mut data).unwrap();
        
        // Should be 8 + 8 + 1 = 17 bytes
        assert_eq!(data.len(), 17);
    }

    #[test]
    fn test_v1_discriminator() {
        // Verify discriminator matches expected Anchor pattern for "global:swap"
        let expected: [u8; 8] = [248, 198, 158, 145, 225, 117, 135, 200];
        assert_eq!(SWAP_V1_DISCRIMINATOR, expected);
    }

    #[test]
    fn test_v2_discriminator() {
        // Verify discriminator matches expected Anchor pattern for "global:swap2"
        let expected: [u8; 8] = [65, 75, 63, 76, 235, 91, 91, 136];
        assert_eq!(SWAP_V2_DISCRIMINATOR, expected);
    }
}
