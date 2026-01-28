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
    
    /// Token program ID (SPL Token or Token-2022)
    pub token_program: Pubkey,
    
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
        32 + // token_program
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
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u8)]
pub enum DexType {
    Raydium = 0,      // Raydium CLMM (Concentrated Liquidity)
    Meteora = 1,      // Meteora DLMM (Discrete Liquidity)
    Orca = 2,         // Orca Whirlpool
    PumpSwap = 3,     // PumpSwap AMM
    RaydiumAmm = 4,   // Raydium AMM v4 (Constant Product)
    MeteoraDAMM = 5,  // Meteora Balanced DAMM v1/v2 (Dynamic AMM)
    RaydiumCpmm = 6,  // Raydium CPMM (Constant Product Market Maker)
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
    
    /// Swap direction: true = A to B, false = B to A
    /// Used by Orca Whirlpool and other directional DEXs
    pub a_to_b: bool,
}

/// Parameters for the execute instruction
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ExecuteParams {
    /// The route steps to execute
    pub steps: Vec<RouteStep>,
    
    /// Number of accounts for each step (enables variable bin arrays per hop)
    /// If empty, falls back to fixed account counts per DEX type.
    /// This allows Meteora hops to use more bin arrays when needed for low-TVL pools.
    pub accounts_per_step: Vec<u8>,
    
    /// Minimum profit required (in output token)
    /// Can be negative to allow losses (useful for testing)
    pub min_profit: i64,
    
    /// Pre-existing wallet balances for intermediate token accounts.
    /// Used to exclude at-rest balances from dynamic amount propagation.
    /// When amount_in == 0 for a step, we read the token account balance and
    /// subtract the corresponding initial_balance to get only the swap output.
    /// If empty or shorter than steps, missing entries default to 0.
    pub initial_balances: Vec<u64>,
    
    /// Enable verbose logging (for simulation/debugging only).
    /// When true, logs detailed input/output amounts for each hop.
    /// Set to false for production to avoid revealing trade details in public logs.
    pub verbose: bool,
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
    
    /// Swap direction: true = A to B, false = B to A
    pub a_to_b: bool,
}

// ============================================================================
// Compact Instruction Types (for reduced transaction size)
// ============================================================================

/// Compact route step - no per-hop slippage (9 bytes vs 18 bytes)
/// 
/// Relies on final min_profit check for protection instead of per-hop slippage.
/// This reduces transaction size by ~50% per step, enabling larger multi-hop routes.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Default)]
pub struct RouteStepCompact {
    /// Packed: bits 0-3 = dex_type (0-15), bit 4 = a_to_b, bits 5-7 = reserved
    pub dex_and_flags: u8,
    /// Amount to swap (0 = use all available from previous step)
    pub amount_in: u64,
}

impl RouteStepCompact {
    /// Extract DEX type from packed byte (bits 0-3)
    pub fn dex_type(&self) -> DexType {
        match self.dex_and_flags & 0x0F {
            0 => DexType::Raydium,
            1 => DexType::Meteora,
            2 => DexType::Orca,
            3 => DexType::PumpSwap,
            4 => DexType::RaydiumAmm,
            5 => DexType::MeteoraDAMM,
            6 => DexType::RaydiumCpmm,
            _ => DexType::Raydium, // fallback for unknown values
        }
    }
    
    /// Extract swap direction from packed byte (bit 4)
    /// true = A to B, false = B to A
    pub fn a_to_b(&self) -> bool {
        (self.dex_and_flags & 0x10) != 0
    }
    
    /// Create a new compact step from components
    pub fn new(dex_type: DexType, a_to_b: bool, amount_in: u64) -> Self {
        let dex_and_flags = (dex_type as u8 & 0x0F) | if a_to_b { 0x10 } else { 0x00 };
        Self { dex_and_flags, amount_in }
    }
}

/// Parameters for execute_compact instruction
/// 
/// This is a size-optimized version of ExecuteParams that removes per-hop
/// slippage protection (min_amount_out) in favor of the final min_profit check.
/// 
/// Byte savings for 4-hop route:
/// - Standard ExecuteParams: ~128 bytes
/// - ExecuteCompactParams: ~54 bytes
/// - Savings: ~74 bytes (enough to fit within 1232-byte tx limit)
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ExecuteCompactParams {
    /// The compact route steps to execute
    pub steps: Vec<RouteStepCompact>,
    
    /// Number of accounts for each step (enables variable bin arrays per hop)
    /// If empty, falls back to fixed account counts per DEX type.
    pub accounts_per_step: Vec<u8>,
    
    /// Minimum profit required (in output token)
    /// This is the ONLY slippage protection - no per-hop min_amount_out
    pub min_profit: i64,
    
    /// Pre-existing wallet balances for intermediate token accounts.
    /// Used to exclude at-rest balances from dynamic amount propagation.
    pub initial_balances: Vec<u64>,
    
    /// Enable verbose logging (for simulation/debugging).
    /// When true, logs detailed input/output amounts for each hop.
    pub verbose: bool,
}

/// V2 Parameters with index-based account referencing
/// 
/// Enables account deduplication across hops for smaller transactions.
/// Instead of slicing remaining_accounts by contiguous ranges, V2 uses
/// indices to reference accounts, allowing the same account to be used
/// by multiple hops without duplication.
/// 
/// Example savings for 4-hop Meteora route:
/// - V1: ~74 accounts (with duplicates like TOKEN_PROGRAM_ID 4x)
/// - V2: ~50 unique accounts + ~74 byte indices = net savings
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ExecuteCompactParamsV2 {
    /// The compact route steps to execute
    pub steps: Vec<RouteStepCompact>,
    
    /// Flattened account indices into remaining_accounts
    /// Each hop's indices are concatenated: [hop0_indices..., hop1_indices..., ...]
    /// Max 255 unique accounts (u8 indices)
    pub account_indices: Vec<u8>,
    
    /// Number of indices per step (to know where each hop's indices start)
    /// Sum of indices_per_step must equal account_indices.len()
    pub indices_per_step: Vec<u8>,
    
    /// Minimum profit required (in output token)
    /// This is the ONLY slippage protection - no per-hop min_amount_out
    pub min_profit: i64,
    
    /// Pre-existing wallet balances for intermediate token accounts.
    /// Used to exclude at-rest balances from dynamic amount propagation.
    pub initial_balances: Vec<u64>,
    
    /// Enable verbose logging (for simulation/debugging).
    /// When true, logs detailed input/output amounts for each hop.
    pub verbose: bool,
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

