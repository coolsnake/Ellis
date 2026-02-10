# Flash Loans

## Overview

Flash loans are uncollateralized loans that exist only within a single atomic blockchain transaction. The loan must be repaid (plus fee) before the transaction ends, or the entire transaction reverts.

### Key Properties

| Property | Description |
|----------|-------------|
| **No collateral** | Borrow any amount without posting collateral |
| **No default risk** | Transaction reverts if repayment fails |
| **Atomic** | Borrow + use + repay in single transaction |
| **Capital-free arbitrage** | Execute large trades without capital |

### Implications for Arbitrage

Flash loans democratize arbitrage—anyone can execute large trades without holding capital. This increases competition and compresses profit margins.

Research shows attackers achieved >500,000% returns using flash loans [Qin 2021].

---

## Flash Loan Providers

### Ethereum
- **Aave**: 0.09% fee, largest liquidity
- **dYdX**: 0 fee (but higher gas)
- **Uniswap V2/V3**: Flash swaps (receive tokens first, pay later)

### Solana
- Flash loans less common due to different transaction model
- Custom vault implementations (like arb-router) provide similar functionality
- Some protocols offer flash loan-like primitives

---

## Flash Loan Transaction Structure

### Basic Pattern

```
1. Borrow X tokens from flash loan provider
2. Execute arbitrage trades with borrowed tokens
3. End with X + fee tokens
4. Repay flash loan
5. Keep profit
```

### Ethereum Example (Aave V3)

```solidity
contract FlashArbitrage is IFlashLoanSimpleReceiver {
    function executeArbitrage(
        address asset,
        uint256 amount,
        bytes calldata params
    ) external {
        // Request flash loan
        POOL.flashLoanSimple(
            address(this),
            asset,
            amount,
            params,
            0  // referral code
        );
    }
    
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external override returns (bool) {
        // Decode arbitrage path from params
        (address[] memory path, address[] memory pools) = abi.decode(
            params, (address[], address[])
        );
        
        // Execute arbitrage swaps
        uint256 currentAmount = amount;
        for (uint i = 0; i < pools.length; i++) {
            currentAmount = executeSwap(pools[i], path[i], path[i+1], currentAmount);
        }
        
        // Verify profit
        uint256 amountOwed = amount + premium;
        require(currentAmount >= amountOwed, "Unprofitable");
        
        // Approve repayment
        IERC20(asset).approve(address(POOL), amountOwed);
        
        return true;
    }
}
```

---

## Solana Flash Loan Patterns

Solana's transaction model differs from Ethereum—no native flash loans, but similar patterns possible.

### Vault-Based Flash Loans

Pattern used by arb-router and similar programs:

```
Instruction 1: flash_borrow
  - Transfer tokens from vault to borrower
  - Set "borrowed" flag in vault state
  
Instruction 2-N: Execute swaps
  - Use borrowed tokens for arbitrage
  - Accumulate output tokens
  
Instruction N+1: flash_repay  
  - Transfer tokens back to vault (amount + fee)
  - Verify sufficient repayment
  - Clear "borrowed" flag
```

### Anchor Implementation Pattern

```rust
#[program]
pub mod flash_vault {
    pub fn flash_borrow(ctx: Context<FlashBorrow>, amount: u64) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        
        require!(!vault.is_borrowed, ErrorCode::AlreadyBorrowed);
        require!(amount <= vault.balance, ErrorCode::InsufficientBalance);
        
        // Transfer to borrower
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault_token.to_account_info(),
                    to: ctx.accounts.borrower_token.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
                &[&vault.seeds()],
            ),
            amount,
        )?;
        
        vault.is_borrowed = true;
        vault.borrowed_amount = amount;
        vault.borrower = ctx.accounts.borrower.key();
        
        Ok(())
    }
    
    pub fn flash_repay(ctx: Context<FlashRepay>) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        
        require!(vault.is_borrowed, ErrorCode::NotBorrowed);
        require!(
            ctx.accounts.borrower.key() == vault.borrower,
            ErrorCode::WrongBorrower
        );
        
        // Calculate required repayment
        let fee = vault.borrowed_amount * vault.fee_bps / 10000;
        let required = vault.borrowed_amount + fee;
        
        // Verify vault received enough
        let vault_balance = ctx.accounts.vault_token.amount;
        require!(vault_balance >= vault.balance + fee, ErrorCode::InsufficientRepayment);
        
        // Clear borrowed state
        vault.is_borrowed = false;
        vault.borrowed_amount = 0;
        vault.balance = vault_balance;
        
        Ok(())
    }
}
```

### Single-Transaction Atomicity

On Solana, all instructions in a transaction succeed or fail together. Structure arbitrage as:

```
Transaction {
    instructions: [
        flash_borrow(vault, amount),
        swap_1(dex_a, token_a, token_b, ...),
        swap_2(dex_b, token_b, token_c, ...),
        swap_3(dex_c, token_c, token_a, ...),
        flash_repay(vault),
    ]
}
```

If any instruction fails (including insufficient repayment), entire transaction reverts.

---

## Flash Swap Pattern

Alternative to dedicated flash loan—borrow output tokens from AMM swap, pay input later.

### Uniswap V2 Flash Swap

```solidity
// In Uniswap pair callback
function uniswapV2Call(
    address sender,
    uint amount0,
    uint amount1,
    bytes calldata data
) external {
    // Received tokens (borrowed)
    uint amountBorrowed = amount0 > 0 ? amount0 : amount1;
    
    // Execute arbitrage with borrowed tokens
    uint profit = executeArbitrage(amountBorrowed);
    
    // Calculate repayment (0.3% fee)
    uint amountRequired = (amountBorrowed * 1000 / 997) + 1;
    
    // Repay
    IERC20(tokenToRepay).transfer(msg.sender, amountRequired);
}
```

---

## Profit Calculation

### Gross vs Net Profit

```
gross_profit = output_amount - input_amount
net_profit = gross_profit - flash_loan_fee - gas_cost
```

### Minimum Viable Profit

Only execute if:

```python
def should_execute(opportunity, gas_price, flash_fee_bps):
    gross_profit = opportunity.output - opportunity.input
    flash_fee = opportunity.input * flash_fee_bps / 10000
    gas_cost = estimate_gas(opportunity) * gas_price
    
    net_profit = gross_profit - flash_fee - gas_cost
    
    # Include safety margin for price movement
    return net_profit > MIN_PROFIT_THRESHOLD
```

---

## Security Considerations

### Reentrancy

Flash loan callbacks are reentrancy vectors:

```solidity
// Vulnerable
function executeOperation(...) {
    // Attacker can call back into this contract
    externalCall();  
    // State may be corrupted
}

// Safe
function executeOperation(...) {
    require(!locked, "Reentrant");
    locked = true;
    
    externalCall();
    
    locked = false;
}
```

### Price Oracle Manipulation

Flash loans enable single-block price manipulation:

1. Borrow large amount
2. Manipulate pool price with large trade
3. Exploit protocol using manipulated price
4. Reverse trade
5. Repay loan

**Mitigation**: Use TWAP oracles, not spot prices.

### Validation

Always verify:
- Caller is the expected flash loan provider
- Amount received matches requested
- Sufficient profit after all fees
- No unexpected state changes

---

## Gas Optimization

Flash loan arbitrage is gas-intensive. Optimize:

### Solana CU Optimization
- Minimize account lookups
- Use PDAs efficiently
- Batch similar operations
- Avoid unnecessary deserialization

### Ethereum Gas Optimization
- Use assembly for hot paths
- Pack storage variables
- Minimize external calls
- Use calldata instead of memory where possible

---

## Common Patterns

### Multi-Pool Arbitrage

```
Borrow USDC → Swap USDC→SOL on Raydium → Swap SOL→USDC on Orca → Repay
```

### Triangular Arbitrage

```
Borrow A → Swap A→B → Swap B→C → Swap C→A → Repay (with profit)
```

### Liquidation + Arbitrage

```
Borrow collateral asset → Liquidate position → Swap received asset → Repay
```
