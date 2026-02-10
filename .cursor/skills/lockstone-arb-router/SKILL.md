---
name: lockstone-arb-router
description: Lockstone arb-router Anchor program for on-chain atomic multi-hop arbitrage with flash loans. Use when working on the Anchor program, vault system, DEX CPIs, transaction building, or understanding the on-chain execution flow.
---

# Lockstone arb-router

Anchor program for atomic multi-hop arbitrage execution on Solana with flash loan support.

## Program Overview

**Program ID:** `2Jgxnj7GGgR1EpwsfNKQhcFhmxAAhDoHmaiaDt2z9Fnw`

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      arb-router Program                          │
├─────────────────────────────────────────────────────────────────┤
│  Vault System                                                    │
│  ├── vault_init     - Create vault for user/mint                │
│  ├── vault_deposit  - Add tokens to vault                       │
│  ├── vault_withdraw - Remove tokens from vault                  │
│  └── vault_close    - Close and reclaim rent                    │
├─────────────────────────────────────────────────────────────────┤
│  Flash Loans                                                     │
│  ├── flash_borrow   - Borrow (verifies repay exists)            │
│  └── flash_repay    - Repay + 0.09% fee                         │
├─────────────────────────────────────────────────────────────────┤
│  Execution                                                       │
│  ├── execute           - Multi-hop with full params             │
│  ├── execute_compact   - Size-optimized variant                 │
│  └── execute_compact_v2 - Account deduplication                 │
├─────────────────────────────────────────────────────────────────┤
│  DEX Integration (CPIs)                                          │
│  ├── Raydium CLMM    - CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7g     │
│  ├── Raydium AMM v4  - 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24w     │
│  ├── Raydium CPMM    - CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKx     │
│  ├── Orca Whirlpool  - whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff     │
│  ├── Meteora DLMM    - LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9Y     │
│  ├── Meteora DAMM    - Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5     │
│  └── PumpSwap        - pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn5     │
└─────────────────────────────────────────────────────────────────┘
```

## Key Files

| File | Purpose |
|------|---------|
| `lib.rs` | Program entry, instruction handlers |
| `state.rs` | Account structures (Vault, Config, RouteStep) |
| `error.rs` | Error codes |
| `dex/*.rs` | DEX-specific CPI builders |

## Account Structures

### Vault

**PDA Seeds:** `[b"vault", owner, mint]`

```rust
pub struct Vault {
    pub owner: Pubkey,           // Vault owner
    pub mint: Pubkey,            // Token mint
    pub token_account: Pubkey,   // Vault's ATA
    pub token_program: Pubkey,   // SPL Token or Token-2022
    pub balance: u64,            // Cached balance
    pub borrowed_amount: u64,    // Active flash loan
    pub flash_loan_active: bool,
    pub bump: u8,
}
```

### RouteStep

```rust
pub struct RouteStep {
    pub dex_type: DexType,
    pub amount_in: u64,      // 0 = use all available
    pub min_amount_out: u64, // Slippage protection
    pub a_to_b: bool,        // Direction
}
```

### RouteStepCompact (9 bytes vs 18)

```rust
pub struct RouteStepCompact {
    pub dex_and_flags: u8,  // bits 0-3: dex_type, bit 4: a_to_b
    pub amount_in: u64,
}
```

### DexType Enum

```rust
pub enum DexType {
    RaydiumClmm = 0,
    RaydiumAmm = 1,
    RaydiumCpmm = 2,
    OrcaWhirlpool = 3,
    MeteoraDlmm = 4,
    MeteoraDamm = 5,
    PumpSwap = 6,
}
```

## Instructions

### Vault Operations

```rust
// Initialize vault
vault_init(ctx: Context<VaultInit>) -> Result<()>

// Deposit tokens
vault_deposit(ctx: Context<VaultDeposit>, amount: u64) -> Result<()>

// Withdraw tokens (checks available = balance - borrowed)
vault_withdraw(ctx: Context<VaultWithdraw>, amount: u64) -> Result<()>

// Close vault (requires no active flash loan)
vault_close(ctx: Context<VaultClose>) -> Result<()>
```

### Flash Loans

```rust
// Borrow - verifies flash_repay exists later in tx
flash_borrow(ctx: Context<FlashBorrow>, params: FlashBorrowParams) -> Result<()>

// Repay - must repay borrowed + 0.09% fee
flash_repay(ctx: Context<FlashRepay>, params: FlashRepayParams) -> Result<()>
```

**Flash Loan Fee:** 0.09% (9 bps), minimum 1 token

```rust
fn calculate_flash_loan_fee(amount: u64) -> u64 {
    std::cmp::max((amount * 9) / 10000, 1)
}
```

### Execution

```rust
// Full execution with all parameters
execute(ctx: Context<Execute>, params: ExecuteParams) -> Result<()>

pub struct ExecuteParams {
    pub steps: Vec<RouteStep>,
    pub accounts_per_step: Option<Vec<u8>>,  // Variable account counts
    pub min_profit: i64,                      // Can be negative for testing
    pub initial_balances: Vec<u64>,          // Pre-existing to exclude
    pub verbose: bool,
}

// Size-optimized (no per-hop slippage)
execute_compact(ctx: Context<Execute>, params: ExecuteCompactParams) -> Result<()>

// Account deduplication via indices
execute_compact_v2(ctx: Context<Execute>, params: ExecuteCompactParamsV2) -> Result<()>
```

## DEX Integration

### Account Counts by DEX

| DEX | Standard | Token-2022 | Notes |
|-----|----------|------------|-------|
| Raydium CLMM | 11-12 | 17-18 | Auto-detect variant |
| Raydium AMM v4 | 19 | - | Includes Serum accounts |
| Raydium CPMM | 14 | - | |
| Orca Whirlpool | 12 | 16 | |
| Meteora DLMM | 17+ | 18+ | Variable bin arrays (2-5) |
| Meteora DAMM | 14-16 | - | v1: 16, v2: 14 |
| PumpSwap | 21-23 | - | Buy: 23, Sell: 21 |

### DEX CPI Pattern

Each DEX module (`dex/*.rs`) follows:

```rust
// Constants
pub const ACCOUNT_COUNT: usize = 12;
pub const SWAP_IX_DISCRIMINATOR: [u8; 8] = [...];

// Swap function
pub fn swap(
    accounts: &[AccountInfo],
    amount_in: u64,
    min_amount_out: u64,
    a_to_b: bool,
) -> Result<()> {
    // 1. Build instruction data
    // 2. Build account metas
    // 3. Invoke CPI
    invoke(&instruction, account_infos)?;
    Ok(())
}
```

### User Token Account Indices

```rust
// Get index of user's input token account in remaining_accounts
fn get_user_token_in_index(dex: DexType, a_to_b: bool) -> usize;

// Get index of user's output token account
fn get_user_token_out_index(dex: DexType, a_to_b: bool) -> usize;
```

## Dynamic Amount Propagation

When `step.amount_in == 0`:

```rust
// Read current balance of input token
let balance = token_account.amount;
// Subtract pre-existing balance
let amount = balance - initial_balances[step_idx];
// Use this amount for swap
```

This enables "use all available" chaining between hops.

## Error Codes

```rust
pub enum ArbRouterError {
    InsufficientFunds,         // Vault lacks funds
    FlashLoanNotRepaid,        // No repay instruction found
    FlashLoanAlreadyActive,    // Vault has active loan
    NoActiveFlashLoan,         // Repay without borrow
    RepayAmountInsufficient,   // Repay < borrowed + fee
    SlippageExceeded,          // Output below minimum
    InvalidDexType,            // Unknown DEX
    NoProfitFromRoute,         // profit < min_profit
    TooManyRouteSteps,         // > 8 steps
    EmptyRoute,                // No steps
    Unauthorized,              // Not owner
    MathOverflow,
    InvalidAccount,
    DexCpiFailed,
}
```

## Transaction Structure

### Flash Loan Arbitrage

```
Transaction {
  instructions: [
    flash_borrow(vault, amount),
    execute([
      { dex: RaydiumClmm, amount_in: 0, ... },  // Uses borrowed
      { dex: OrcaWhirlpool, amount_in: 0, ... },
      { dex: MeteoraDlmm, amount_in: 0, ... },
    ]),
    flash_repay(vault),
  ]
}
```

### Direct Execution (No Flash Loan)

```
Transaction {
  instructions: [
    execute([
      { dex: RaydiumClmm, amount_in: 1000000, ... },
      { dex: OrcaWhirlpool, amount_in: 0, ... },
    ]),
  ]
}
```

## Common Tasks

### Adding a New DEX

1. Create `dex/new_dex.rs`
2. Define constants: `PROGRAM_ID`, `ACCOUNT_COUNT`, discriminator
3. Implement `swap()` function
4. Add to `DexType` enum in `state.rs`
5. Update account index functions
6. Wire into `route_swap()` and `execute()` in `lib.rs`

### Modifying Flash Loan Fee

1. Update `FLASH_LOAN_FEE_BPS` in `state.rs`
2. Update `calculate_flash_loan_fee()` method

### Adding Execute Variant

1. Define new params struct in `state.rs`
2. Add instruction handler in `lib.rs`
3. Implement account slicing logic
4. Update backend transaction builder

## Build Commands

```bash
# Build program
cd arb-router
anchor build

# Deploy to devnet
anchor deploy --provider.cluster devnet

# Run tests
anchor test
```

## Account Derivation

### Vault PDA

```typescript
const [vaultPda] = PublicKey.findProgramAddressSync(
  [Buffer.from("vault"), owner.toBuffer(), mint.toBuffer()],
  PROGRAM_ID
);
```

### Config PDA

```typescript
const [configPda] = PublicKey.findProgramAddressSync(
  [Buffer.from("config")],
  PROGRAM_ID
);
```
