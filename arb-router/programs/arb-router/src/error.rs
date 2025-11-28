use anchor_lang::prelude::*;

#[error_code]
pub enum ArbRouterError {
    #[msg("Insufficient funds in vault")]
    InsufficientFunds,
    
    #[msg("Flash loan not repaid - repay instruction must follow borrow")]
    FlashLoanNotRepaid,
    
    #[msg("Flash loan already active on this vault")]
    FlashLoanAlreadyActive,
    
    #[msg("No active flash loan to repay")]
    NoActiveFlashLoan,
    
    #[msg("Repay amount insufficient - must repay borrowed amount plus fee")]
    RepayAmountInsufficient,
    
    #[msg("Slippage tolerance exceeded")]
    SlippageExceeded,
    
    #[msg("Invalid DEX type specified")]
    InvalidDexType,
    
    #[msg("Route execution failed - no profit")]
    NoProfitFromRoute,
    
    #[msg("Invalid route - too many steps")]
    TooManyRouteSteps,
    
    #[msg("Invalid route - empty route")]
    EmptyRoute,
    
    #[msg("Unauthorized - not vault owner")]
    Unauthorized,
    
    #[msg("Math overflow")]
    MathOverflow,
    
    #[msg("Invalid account provided")]
    InvalidAccount,
    
    #[msg("CPI to DEX failed")]
    DexCpiFailed,
}

