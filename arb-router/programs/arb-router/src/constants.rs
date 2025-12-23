use anchor_lang::prelude::*;

// PDA Seeds
pub const VAULT_SEED: &[u8] = b"vault";
pub const CONFIG_SEED: &[u8] = b"config";

// DEX Program IDs
pub mod dex_programs {
    use super::*;
    
    // Raydium CLMM
    pub const RAYDIUM_CLMM: Pubkey = pubkey!("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK");
    
    // Meteora DLMM
    pub const METEORA_DLMM: Pubkey = pubkey!("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");
    
    // Orca Whirlpool
    pub const ORCA_WHIRLPOOL: Pubkey = pubkey!("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc");
    
    // PumpSwap (Pump.fun AMM)
    pub const PUMPSWAP: Pubkey = pubkey!("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
}

// SPL Token Program
pub const TOKEN_PROGRAM_ID: Pubkey = pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

// SPL Token-2022 Program
pub const TOKEN_2022_PROGRAM_ID: Pubkey = pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

// Flash loan fee in basis points (0.09% = 9 bps)
pub const FLASH_LOAN_FEE_BPS: u64 = 9;
pub const BPS_DENOMINATOR: u64 = 10000;

// Maximum number of route steps in a single execute
pub const MAX_ROUTE_STEPS: usize = 8;

