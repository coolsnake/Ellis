pub mod raydium;
pub mod raydium_amm;
pub mod raydium_cpmm;
pub mod meteora;
pub mod meteora_damm;
pub mod orca;
pub mod pumpswap;

use anchor_lang::prelude::*;

/// Common trait for DEX swap operations
pub trait DexSwap {
    /// Execute a swap on this DEX
    fn swap(
        accounts: &[AccountInfo],
        amount_in: u64,
        min_amount_out: u64,
    ) -> Result<u64>;
}

