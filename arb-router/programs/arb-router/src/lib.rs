use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar::instructions as ix_sysvar;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use anchor_spl::token_interface::{TokenInterface, TokenAccount as InterfaceTokenAccount, Mint as InterfaceMint};

pub mod constants;
pub mod error;
pub mod state;
pub mod dex;

use constants::*;
use error::*;
use state::*;

declare_id!("2Jgxnj7GGgR1EpwsfNKQhcFhmxAAhDoHmaiaDt2z9Fnw");

#[program]
pub mod arb_router {
    use super::*;

    /// Initialize a new vault for a user and token mint
    /// Supports both SPL Token and Token-2022 programs
    pub fn vault_init(ctx: Context<VaultInit>) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        vault.owner = ctx.accounts.owner.key();
        vault.mint = ctx.accounts.mint.key();
        vault.token_account = ctx.accounts.vault_token_account.key();
        vault.token_program = ctx.accounts.token_program.key();
        vault.balance = 0;
        vault.borrowed_amount = 0;
        vault.flash_loan_active = false;
        vault.bump = ctx.bumps.vault;
        
        msg!("Vault initialized for owner: {}, token_program: {}", vault.owner, vault.token_program);
        Ok(())
    }

    /// Deposit tokens into the vault
    pub fn vault_deposit(ctx: Context<VaultDeposit>, amount: u64) -> Result<()> {
        // Transfer tokens from user to vault
        let cpi_accounts = Transfer {
            from: ctx.accounts.user_token_account.to_account_info(),
            to: ctx.accounts.vault_token_account.to_account_info(),
            authority: ctx.accounts.owner.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);
        token::transfer(cpi_ctx, amount)?;

        // Update vault balance
        let vault = &mut ctx.accounts.vault;
        vault.balance = vault.balance.checked_add(amount)
            .ok_or(ArbRouterError::MathOverflow)?;

        msg!("Deposited {} tokens to vault", amount);
        Ok(())
    }

    /// Withdraw tokens from the vault
    pub fn vault_withdraw(ctx: Context<VaultWithdraw>, amount: u64) -> Result<()> {
        // Check sufficient balance (excluding borrowed amount)
        let available = ctx.accounts.vault.balance.checked_sub(ctx.accounts.vault.borrowed_amount)
            .ok_or(ArbRouterError::InsufficientFunds)?;
        require!(amount <= available, ArbRouterError::InsufficientFunds);

        // Transfer tokens from vault to user
        let owner_key = ctx.accounts.owner.key();
        let mint_key = ctx.accounts.mint.key();
        let bump = ctx.accounts.vault.bump;
        let seeds = &[
            VAULT_SEED,
            owner_key.as_ref(),
            mint_key.as_ref(),
            &[bump],
        ];
        let signer_seeds = &[&seeds[..]];

        let cpi_accounts = Transfer {
            from: ctx.accounts.vault_token_account.to_account_info(),
            to: ctx.accounts.user_token_account.to_account_info(),
            authority: ctx.accounts.vault.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer_seeds);
        token::transfer(cpi_ctx, amount)?;

        // Update vault balance
        let vault = &mut ctx.accounts.vault;
        vault.balance = vault.balance.checked_sub(amount)
            .ok_or(ArbRouterError::MathOverflow)?;

        msg!("Withdrawn {} tokens from vault", amount);
        Ok(())
    }

    /// Close the vault and reclaim rent
    pub fn vault_close(ctx: Context<VaultClose>) -> Result<()> {
        let vault = &ctx.accounts.vault;
        
        // Cannot close if flash loan is active
        require!(!vault.flash_loan_active, ArbRouterError::FlashLoanAlreadyActive);
        
        // Cannot close if balance > 0 (must withdraw first)
        require!(vault.balance == 0, ArbRouterError::InsufficientFunds);

        msg!("Vault closed for owner: {}", vault.owner);
        Ok(())
    }

    /// Borrow tokens from vault via flash loan
    /// IMPORTANT: A flash_repay instruction MUST follow in the same transaction
    pub fn flash_borrow(ctx: Context<FlashBorrow>, params: FlashBorrowParams) -> Result<()> {
        // Check no active flash loan
        require!(!ctx.accounts.vault.flash_loan_active, ArbRouterError::FlashLoanAlreadyActive);
        
        // Check sufficient balance
        require!(params.amount <= ctx.accounts.vault.balance, ArbRouterError::InsufficientFunds);

        // Verify that a repay instruction exists later in this transaction
        let vault_key = ctx.accounts.vault.key();
        verify_repay_instruction_exists(&ctx.accounts.instructions_sysvar, params.amount, vault_key)?;

        // Transfer tokens to borrower
        let owner_key = ctx.accounts.vault.owner;
        let mint_key = ctx.accounts.vault.mint;
        let bump = ctx.accounts.vault.bump;
        let seeds = &[
            VAULT_SEED,
            owner_key.as_ref(),
            mint_key.as_ref(),
            &[bump],
        ];
        let signer_seeds = &[&seeds[..]];

        let cpi_accounts = Transfer {
            from: ctx.accounts.vault_token_account.to_account_info(),
            to: ctx.accounts.borrower_token_account.to_account_info(),
            authority: ctx.accounts.vault.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer_seeds);
        token::transfer(cpi_ctx, params.amount)?;

        // Mark flash loan as active
        let vault = &mut ctx.accounts.vault;
        vault.flash_loan_active = true;
        vault.borrowed_amount = params.amount;

        msg!("Flash borrowed {} tokens", params.amount);
        Ok(())
    }

    /// Repay flash loan
    pub fn flash_repay(ctx: Context<FlashRepay>, params: FlashRepayParams) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        
        // Check flash loan is active
        require!(vault.flash_loan_active, ArbRouterError::NoActiveFlashLoan);
        
        // Calculate required repayment (borrowed + fee)
        let fee = vault.calculate_flash_loan_fee(vault.borrowed_amount)?;
        let required_repay = vault.borrowed_amount.checked_add(fee)
            .ok_or(ArbRouterError::MathOverflow)?;
        
        // Check repay amount is sufficient
        require!(params.amount >= required_repay, ArbRouterError::RepayAmountInsufficient);

        // Transfer tokens back to vault
        let cpi_accounts = Transfer {
            from: ctx.accounts.borrower_token_account.to_account_info(),
            to: ctx.accounts.vault_token_account.to_account_info(),
            authority: ctx.accounts.borrower.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);
        token::transfer(cpi_ctx, params.amount)?;

        // Update vault state
        vault.balance = vault.balance
            .checked_add(fee) // Only the fee is profit, principal was already counted
            .ok_or(ArbRouterError::MathOverflow)?;
        vault.flash_loan_active = false;
        vault.borrowed_amount = 0;

        msg!("Flash loan repaid: {} (fee: {})", params.amount, fee);
        Ok(())
    }

    /// Execute a single swap through a specified DEX
    pub fn route_swap<'info>(
        ctx: Context<'_, '_, '_, 'info, RouteSwap<'info>>,
        params: SwapParams,
    ) -> Result<()> {
        msg!("Executing swap on DEX type: {:?}, a_to_b: {}", params.dex_type as u8, params.a_to_b);
        
        // Route to appropriate DEX
        match params.dex_type {
            DexType::Raydium => {
                dex::raydium::swap(
                    &ctx.remaining_accounts,
                    params.amount_in,
                    params.min_amount_out,
                    params.a_to_b,
                )?;
            }
            DexType::Meteora => {
                dex::meteora::swap(
                    &ctx.remaining_accounts,
                    params.amount_in,
                    params.min_amount_out,
                )?;
            }
            DexType::Orca => {
                // Orca requires direction for sqrt_price_limit
                dex::orca::swap(
                    &ctx.remaining_accounts,
                    params.amount_in,
                    params.min_amount_out,
                    params.a_to_b,
                )?;
            }
            DexType::PumpSwap => {
                // PumpSwap: a_to_b = true means buy (SOL->Token), false means sell (Token->SOL)
                dex::pumpswap::swap(
                    &ctx.remaining_accounts,
                    params.amount_in,
                    params.min_amount_out,
                    params.a_to_b,
                )?;
            }
            DexType::RaydiumAmm => {
                // Raydium AMM v4 (constant product with Serum/OpenBook)
                dex::raydium_amm::swap(
                    &ctx.remaining_accounts,
                    params.amount_in,
                    params.min_amount_out,
                )?;
            }
            DexType::MeteoraDAMM => {
                // Meteora DAMM: a_to_b = true means v2, false means v1
                dex::meteora_damm::swap(
                    &ctx.remaining_accounts,
                    params.amount_in,
                    params.min_amount_out,
                    params.a_to_b,
                )?;
            }
        }

        msg!("Swap completed: {} in, min {} out", params.amount_in, params.min_amount_out);
        Ok(())
    }

    /// Execute a multi-hop arbitrage route
    /// 
    /// Supports dynamic amount propagation: if step.amount_in == 0, uses the
    /// entire balance of the input token account (output from previous swap).
    /// 
    /// Variable account counts: If `accounts_per_step` is provided (non-empty),
    /// each step uses the specified number of accounts instead of fixed DEX defaults.
    /// This enables Meteora hops to use more bin arrays for low-TVL pools.
    pub fn execute<'info>(
        ctx: Context<'_, '_, '_, 'info, Execute<'info>>,
        params: ExecuteParams,
    ) -> Result<()> {
        require!(!params.steps.is_empty(), ArbRouterError::EmptyRoute);
        require!(params.steps.len() <= MAX_ROUTE_STEPS, ArbRouterError::TooManyRouteSteps);
        
        // Validate accounts_per_step if provided
        let use_variable_accounts = !params.accounts_per_step.is_empty();
        if use_variable_accounts {
            require!(
                params.accounts_per_step.len() == params.steps.len(),
                ArbRouterError::InvalidAccount
            );
        }

        // Get initial balance
        let initial_balance = ctx.accounts.user_token_account.amount;

        // Execute each step
        // Note: remaining_accounts should contain all DEX accounts for all steps
        // The accounts are packed sequentially for each DEX
        let mut account_offset = 0;
        
        for (i, step) in params.steps.iter().enumerate() {
            msg!("Executing step {} on DEX {:?}", i, step.dex_type as u8);
            
            // Use per-step account count if provided, otherwise fall back to fixed DEX defaults
            let accounts_needed = if use_variable_accounts {
                params.accounts_per_step[i] as usize
            } else {
                get_accounts_needed_for_dex(&step.dex_type)
            };
            
            // Validate we have enough accounts
            require!(
                account_offset + accounts_needed <= ctx.remaining_accounts.len(),
                ArbRouterError::InvalidAccount
            );
            
            let step_accounts = &ctx.remaining_accounts[account_offset..account_offset + accounts_needed];
            msg!("Step {}: using {} accounts (offset: {})", i, accounts_needed, account_offset);
            
            // Determine actual amount to swap
            // If amount_in == 0, read the current balance of the input token account
            // This enables dynamic amount propagation between hops
            let actual_amount_in = if step.amount_in == 0 {
                let input_token_idx = get_user_token_in_index(&step.dex_type, step.a_to_b, accounts_needed);
                let input_token_account = &step_accounts[input_token_idx];
                let balance = read_token_account_balance(input_token_account)?;
                
                // Subtract pre-existing balance to avoid swapping at-rest funds
                // This prevents accidentally including wallet balances that were there before the swap
                let initial_balance = params.initial_balances.get(i).copied().unwrap_or(0);
                let swap_amount = balance.saturating_sub(initial_balance);
                
                msg!("Step {}: balance={}, initial={}, swap_amount={} (idx: {})", 
                    i, balance, initial_balance, swap_amount, input_token_idx);
                swap_amount
            } else {
                step.amount_in
            };
            
            require!(actual_amount_in > 0, ArbRouterError::InsufficientFunds);
            
            match step.dex_type {
                DexType::Raydium => {
                    dex::raydium::swap(step_accounts, actual_amount_in, step.min_amount_out, step.a_to_b)?;
                }
                DexType::Meteora => {
                    dex::meteora::swap(step_accounts, actual_amount_in, step.min_amount_out)?;
                }
                DexType::Orca => {
                    // Orca requires direction for sqrt_price_limit
                    dex::orca::swap(step_accounts, actual_amount_in, step.min_amount_out, step.a_to_b)?;
                }
                DexType::PumpSwap => {
                    // PumpSwap: a_to_b = true means buy (SOL->Token), false means sell (Token->SOL)
                    dex::pumpswap::swap(step_accounts, actual_amount_in, step.min_amount_out, step.a_to_b)?;
                }
                DexType::RaydiumAmm => {
                    // Raydium AMM v4 (constant product with Serum/OpenBook)
                    dex::raydium_amm::swap(step_accounts, actual_amount_in, step.min_amount_out)?;
                }
                DexType::MeteoraDAMM => {
                    // Meteora DAMM: a_to_b = true means v2, false means v1
                    dex::meteora_damm::swap(step_accounts, actual_amount_in, step.min_amount_out, step.a_to_b)?;
                }
            }
            
            account_offset += accounts_needed;
        }

        // Reload token account to check final balance
        ctx.accounts.user_token_account.reload()?;
        let final_balance = ctx.accounts.user_token_account.amount;

        // Verify profit (can be negative for losing trades)
        // Use signed arithmetic to handle losses
        let profit: i64 = (final_balance as i64).checked_sub(initial_balance as i64)
            .ok_or(ArbRouterError::MathOverflow)?;
        require!(profit >= params.min_profit, ArbRouterError::NoProfitFromRoute);

        msg!("Route executed successfully. Profit: {}", profit);
        Ok(())
    }
}

// ============================================================================
// Account Contexts
// ============================================================================

#[derive(Accounts)]
pub struct VaultInit<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    /// The mint - supports both Token and Token-2022
    pub mint: InterfaceAccount<'info, InterfaceMint>,

    #[account(
        init,
        payer = owner,
        space = Vault::LEN,
        seeds = [VAULT_SEED, owner.key().as_ref(), mint.key().as_ref()],
        bump
    )]
    pub vault: Account<'info, Vault>,

    /// The vault's token account - supports both Token and Token-2022
    #[account(
        init,
        payer = owner,
        token::mint = mint,
        token::authority = vault,
        token::token_program = token_program,
    )]
    pub vault_token_account: InterfaceAccount<'info, InterfaceTokenAccount>,

    /// Token program - can be Token or Token-2022
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct VaultDeposit<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    pub mint: InterfaceAccount<'info, InterfaceMint>,

    #[account(
        mut,
        seeds = [VAULT_SEED, owner.key().as_ref(), mint.key().as_ref()],
        bump = vault.bump,
        has_one = owner,
        has_one = mint,
    )]
    pub vault: Account<'info, Vault>,

    #[account(
        mut,
        constraint = vault_token_account.key() == vault.token_account,
    )]
    pub vault_token_account: InterfaceAccount<'info, InterfaceTokenAccount>,

    #[account(
        mut,
        constraint = user_token_account.mint == mint.key(),
        constraint = user_token_account.owner == owner.key(),
    )]
    pub user_token_account: InterfaceAccount<'info, InterfaceTokenAccount>,

    /// Token program - must match the vault's stored token_program
    #[account(
        constraint = token_program.key() == vault.token_program @ ArbRouterError::InvalidAccount
    )]
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct VaultWithdraw<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    pub mint: InterfaceAccount<'info, InterfaceMint>,

    #[account(
        mut,
        seeds = [VAULT_SEED, owner.key().as_ref(), mint.key().as_ref()],
        bump = vault.bump,
        has_one = owner,
        has_one = mint,
    )]
    pub vault: Account<'info, Vault>,

    #[account(
        mut,
        constraint = vault_token_account.key() == vault.token_account,
    )]
    pub vault_token_account: InterfaceAccount<'info, InterfaceTokenAccount>,

    #[account(
        mut,
        constraint = user_token_account.mint == mint.key(),
        constraint = user_token_account.owner == owner.key(),
    )]
    pub user_token_account: InterfaceAccount<'info, InterfaceTokenAccount>,

    /// Token program - must match the vault's stored token_program
    #[account(
        constraint = token_program.key() == vault.token_program @ ArbRouterError::InvalidAccount
    )]
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct VaultClose<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    pub mint: InterfaceAccount<'info, InterfaceMint>,

    #[account(
        mut,
        seeds = [VAULT_SEED, owner.key().as_ref(), mint.key().as_ref()],
        bump = vault.bump,
        has_one = owner,
        close = owner,
    )]
    pub vault: Account<'info, Vault>,

    #[account(
        mut,
        constraint = vault_token_account.key() == vault.token_account,
    )]
    pub vault_token_account: InterfaceAccount<'info, InterfaceTokenAccount>,

    /// Token program - must match the vault's stored token_program
    #[account(
        constraint = token_program.key() == vault.token_program @ ArbRouterError::InvalidAccount
    )]
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct FlashBorrow<'info> {
    /// The borrower (can be anyone, will repay with interest)
    pub borrower: Signer<'info>,

    pub mint: InterfaceAccount<'info, InterfaceMint>,

    #[account(
        mut,
        seeds = [VAULT_SEED, vault.owner.as_ref(), mint.key().as_ref()],
        bump = vault.bump,
        has_one = mint,
    )]
    pub vault: Account<'info, Vault>,

    #[account(
        mut,
        constraint = vault_token_account.key() == vault.token_account,
    )]
    pub vault_token_account: InterfaceAccount<'info, InterfaceTokenAccount>,

    #[account(
        mut,
        constraint = borrower_token_account.mint == mint.key(),
    )]
    pub borrower_token_account: InterfaceAccount<'info, InterfaceTokenAccount>,

    /// Token program - must match the vault's stored token_program
    #[account(
        constraint = token_program.key() == vault.token_program @ ArbRouterError::InvalidAccount
    )]
    pub token_program: Interface<'info, TokenInterface>,

    /// CHECK: Instructions sysvar for verifying repay instruction exists
    #[account(address = ix_sysvar::ID)]
    pub instructions_sysvar: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct FlashRepay<'info> {
    /// The borrower repaying the loan
    pub borrower: Signer<'info>,

    pub mint: InterfaceAccount<'info, InterfaceMint>,

    #[account(
        mut,
        seeds = [VAULT_SEED, vault.owner.as_ref(), mint.key().as_ref()],
        bump = vault.bump,
        has_one = mint,
    )]
    pub vault: Account<'info, Vault>,

    #[account(
        mut,
        constraint = vault_token_account.key() == vault.token_account,
    )]
    pub vault_token_account: InterfaceAccount<'info, InterfaceTokenAccount>,

    #[account(
        mut,
        constraint = borrower_token_account.mint == mint.key(),
    )]
    pub borrower_token_account: InterfaceAccount<'info, InterfaceTokenAccount>,

    /// Token program - must match the vault's stored token_program
    #[account(
        constraint = token_program.key() == vault.token_program @ ArbRouterError::InvalidAccount
    )]
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct RouteSwap<'info> {
    pub user: Signer<'info>,

    #[account(mut)]
    pub user_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    // Remaining accounts are DEX-specific
}

#[derive(Accounts)]
pub struct Execute<'info> {
    pub user: Signer<'info>,

    #[account(mut)]
    pub user_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    // Remaining accounts contain all DEX accounts for all steps
}

// ============================================================================
// Helper Functions
// ============================================================================

/// flash_repay instruction discriminator
/// Computed as: sha256("global:flash_repay")[0..8]
const FLASH_REPAY_DISCRIMINATOR: [u8; 8] = [56, 28, 91, 52, 106, 68, 56, 134];

/// Verify that a flash_repay instruction exists later in the current transaction
fn verify_repay_instruction_exists(
    instructions_sysvar: &AccountInfo,
    _borrowed_amount: u64,
    vault_key: Pubkey,
) -> Result<()> {
    use ix_sysvar::{
        get_instruction_relative,
        load_current_index_checked,
    };

    let current_index = load_current_index_checked(instructions_sysvar)?;
    
    // Look for a repay instruction after this one
    let mut found_repay = false;
    let mut idx = current_index + 1;
    
    loop {
        match get_instruction_relative(idx as i64 - current_index as i64, instructions_sysvar) {
            Ok(ix) => {
                // Check if this is our program
                if ix.program_id == crate::id() {
                    // Check if it's a flash_repay instruction (discriminator check)
                    // Anchor uses first 8 bytes as discriminator
                    if ix.data.len() >= 8 {
                        let discriminator: [u8; 8] = ix.data[..8]
                            .try_into()
                            .map_err(|_| ArbRouterError::InvalidAccount)?;
                        
                        // Verify this is actually a flash_repay instruction
                        if discriminator == FLASH_REPAY_DISCRIMINATOR {
                            // Also verify the vault account matches
                            for acc in &ix.accounts {
                                if acc.pubkey == vault_key {
                                    found_repay = true;
                                    msg!("Found valid flash_repay instruction at index {}", idx);
                                    break;
                                }
                            }
                        }
                    }
                }
                
                if found_repay {
                    break;
                }
                idx += 1;
            }
            Err(_) => break, // No more instructions
        }
    }

    require!(found_repay, ArbRouterError::FlashLoanNotRepaid);
    Ok(())
}

/// Get the number of accounts needed for a DEX swap
fn get_accounts_needed_for_dex(dex_type: &DexType) -> usize {
    match dex_type {
        DexType::Raydium => dex::raydium::ACCOUNTS_NEEDED,
        DexType::Meteora => dex::meteora::ACCOUNTS_NEEDED,
        DexType::Orca => dex::orca::ACCOUNTS_NEEDED,
        DexType::PumpSwap => dex::pumpswap::ACCOUNTS_NEEDED,
        DexType::RaydiumAmm => dex::raydium_amm::ACCOUNTS_NEEDED,
        DexType::MeteoraDAMM => dex::meteora_damm::ACCOUNTS_NEEDED,
    }
}

/// Get the index of the user's input token account within the DEX accounts array
/// This is needed for dynamic amount propagation (reading balance when amount_in == 0)
/// 
/// The `a_to_b` parameter indicates swap direction to pick the correct account for DEXes
/// that use A/B ordering. The `accounts_count` helps distinguish instruction variants.
fn get_user_token_in_index(dex_type: &DexType, a_to_b: bool, accounts_count: usize) -> usize {
    match dex_type {
        // Raydium CLMM: position 3 (Input Token Account)
        DexType::Raydium => 3,
        // Meteora DLMM: accounts are in Input/Output order!
        // Position 4 = User Token In (INPUT - always the source of swapped tokens)
        // Position 5 = User Token Out (OUTPUT - always the destination)
        // The transaction builder places the correct token at each position based on direction.
        // We always read from position 4 regardless of a_to_b.
        DexType::Meteora => 4,
        // Orca Whirlpool: accounts are in A/B order
        // - swap (12 accounts): Token Owner Account A is at position 3
        // - swap_v2 (16 accounts): Token Owner Account A is at position 7
        // A→B: input is A, B→A: input is B (offset by 2 for user token B)
        DexType::Orca => {
            let base_idx = if accounts_count >= dex::orca::SWAP_V2_ACCOUNTS_NEEDED { 7 } else { 3 };
            if a_to_b { base_idx } else { base_idx + 2 }
        },
        // PumpSwap: position 6 (User Token Account)
        DexType::PumpSwap => 6,
        // Raydium AMM v4: position 15 (User Source Token Account)
        DexType::RaydiumAmm => 15,
        // Meteora DAMM: position 1 (User Source Token Account)
        DexType::MeteoraDAMM => 1,
    }
}

/// Read the balance from a token account without deserializing the full account
/// Token account layout: ... balance at offset 64 (8 bytes, little endian)
fn read_token_account_balance(account: &AccountInfo) -> Result<u64> {
    let data = account.try_borrow_data()
        .map_err(|_| ArbRouterError::InvalidAccount)?;
    
    // Token account balance is at offset 64, 8 bytes
    if data.len() < 72 {
        msg!("Token account data too short: {} bytes", data.len());
        return Err(ArbRouterError::InvalidAccount.into());
    }
    
    let balance_bytes: [u8; 8] = data[64..72]
        .try_into()
        .map_err(|_| ArbRouterError::InvalidAccount)?;
    
    Ok(u64::from_le_bytes(balance_bytes))
}

