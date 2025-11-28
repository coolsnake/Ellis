use anchor_lang::prelude::*;

/// Vault account that holds user funds and tracks flash loan state
#[account]
#[derive(Default)]
pub struct Vault {
    /// Owner of this vault
    pub owner: Pubkey,
    
    /// Mint of the token stored in this vault
    pub mint: Pubkey,
    
    /// Token account that holds the vault's funds
    pub token_account: Pubkey,
    
    /// Current balance (cached, actual balance is in token_account)
    pub balance: u64,
    
    /// Amount currently borrowed via flash loan
    pub borrowed_amount: u64,
    
    /// Whether a flash loan is currently active
    pub flash_loan_active: bool,
    
    /// PDA bump seed
    pub bump: u8,
    
    /// Padding for future use
    pub _padding: [u8; 6],
}

impl Vault {
    pub const LEN: usize = 8 + // discriminator
        32 + // owner
        32 + // mint  
        32 + // token_account
        8 +  // balance
        8 +  // borrowed_amount
        1 +  // flash_loan_active
        1 +  // bump
        6;   // padding
    
    /// Calculate the fee for a flash loan amount
    pub fn calculate_flash_loan_fee(&self, amount: u64) -> Result<u64> {
        // 0.09% fee (9 basis points)
        let fee = amount
            .checked_mul(crate::constants::FLASH_LOAN_FEE_BPS)
            .ok_or(crate::error::ArbRouterError::MathOverflow)?
            .checked_div(crate::constants::BPS_DENOMINATOR)
            .ok_or(crate::error::ArbRouterError::MathOverflow)?;
        
        // Minimum fee of 1 token
        Ok(fee.max(1))
    }
}

/// Global configuration (optional - for fee management)
#[account]
#[derive(Default)]
pub struct Config {
    /// Authority that can update config
    pub authority: Pubkey,
    
    /// Flash loan fee in basis points
    pub flash_loan_fee_bps: u16,
    
    /// Whether flash loans are enabled
    pub flash_loans_enabled: bool,
    
    /// Bump seed
    pub bump: u8,
    
    /// Padding
    pub _padding: [u8; 4],
}

impl Config {
    pub const LEN: usize = 8 + // discriminator
        32 + // authority
        2 +  // flash_loan_fee_bps
        1 +  // flash_loans_enabled
        1 +  // bump
        4;   // padding
}

/// DEX type enum for routing
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum DexType {
    Raydium = 0,
    Meteora = 1,
    Orca = 2,
    PumpSwap = 3,
}

impl Default for DexType {
    fn default() -> Self {
        DexType::Raydium
    }
}

/// A single swap step in a route
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Default)]
pub struct RouteStep {
    /// Which DEX to use
    pub dex_type: DexType,
    
    /// Amount to swap (0 = use all available from previous step)
    pub amount_in: u64,
    
    /// Minimum output amount (slippage protection)
    pub min_amount_out: u64,
}

/// Parameters for the execute instruction
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ExecuteParams {
    /// The route steps to execute
    pub steps: Vec<RouteStep>,
    
    /// Minimum profit required (in output token)
    pub min_profit: u64,
}

/// Parameters for a single swap
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct SwapParams {
    /// DEX to use
    pub dex_type: DexType,
    
    /// Amount to swap
    pub amount_in: u64,
    
    /// Minimum output
    pub min_amount_out: u64,
}

/// Flash loan borrow parameters
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct FlashBorrowParams {
    /// Amount to borrow
    pub amount: u64,
}

/// Flash loan repay parameters  
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct FlashRepayParams {
    /// Amount to repay (should be borrowed + fee)
    pub amount: u64,
}

