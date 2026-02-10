---
name: dex-pumpswap
description: PumpSwap DEX integration for Pump.fun's post-graduation AMM, covering buy and sell instruction variants with their different account layouts. Use when working on PumpSwap integration, bonding curve graduation, or understanding the Pump.fun ecosystem.
---

# PumpSwap Integration

PumpSwap is Pump.fun's native AMM for tokens that have graduated from the bonding curve.

## Program ID

```
pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA
```

## Background

### Bonding Curve → PumpSwap

1. Token launches on Pump.fun with bonding curve (~800M tokens tradeable)
2. As buyers purchase, price increases non-linearly
3. At 100% completion (~$69K market cap), token graduates
4. Token automatically migrates to PumpSwap AMM
5. LP locked, trading continues on constant product AMM

### Graduation Formula

```
BondingCurveProgress = 100 - (((balance - 206900000) * 100) / 793100000)
```

Where `balance` is remaining tokens in bonding curve.

---

## Instruction Variants

**CRITICAL**: Buy and Sell have different account counts!

| Direction | Accounts | Description |
|-----------|----------|-------------|
| **Buy** | 23 | Quote→Base (SOL→Token), includes volume accumulators |
| **Sell** | 21 | Base→Quote (Token→SOL), no volume accumulators |

### Instruction Discriminators

```rust
buy:  [102, 6, 61, 18, 1, 218, 235, 234]
sell: [51, 230, 133, 164, 1, 127, 131, 173]
```

---

## Buy Instruction (23 accounts)

### Instruction Data

```
[0-7]   discriminator (8 bytes)
[8-15]  base_amount_out (u64) - Minimum tokens to receive
[16-23] max_quote_amount_in (u64) - Maximum SOL to spend
[24]    referral_option (1 byte) - 0 for None
Total: 25 bytes
```

### Account Layout

```
Index | Account                           | Writable | Signer | Description
------|-----------------------------------|----------|--------|-------------
0     | Pool                              | Yes      | No     | Pool account
1     | User                              | Yes      | Yes    | User wallet
2     | Global Config                     | No       | No     | Global config PDA
3     | Base Mint                         | No       | No     | Pump token mint
4     | Quote Mint                        | No       | No     | WSOL mint
5     | User Base Token Account           | Yes      | No     | User's token ATA
6     | User Quote Token Account          | Yes      | No     | User's WSOL ATA
7     | Pool Base Token Account           | Yes      | No     | Pool's token vault
8     | Pool Quote Token Account          | Yes      | No     | Pool's WSOL vault
9     | Protocol Fee Recipient            | No       | No     | Fee recipient wallet
10    | Protocol Fee Recipient Token Acct | Yes      | No     | Fee recipient's WSOL ATA
11    | Base Token Program                | No       | No     | Token program (SPL/Token-2022)
12    | Quote Token Program               | No       | No     | SPL Token (for WSOL)
13    | System Program                    | No       | No     | System program
14    | Associated Token Program          | No       | No     | ATA program
15    | Event Authority                   | No       | No     | Event authority PDA
16    | Program                           | No       | No     | PumpSwap program
17    | Coin Creator Vault ATA            | Yes      | No     | Creator fee vault
18    | Coin Creator Vault Authority      | No       | No     | Creator vault authority PDA
19    | Global Volume Accumulator         | No       | No     | Global volume PDA
20    | User Volume Accumulator           | Yes      | No     | User's volume PDA
21    | Fee Config                        | No       | No     | Fee config PDA
22    | Fee Program                       | No       | No     | Pump fee program
```

---

## Sell Instruction (21 accounts)

### Instruction Data

```
[0-7]   discriminator (8 bytes)
[8-15]  base_amount_in (u64) - Tokens to sell
[16-23] min_quote_amount_out (u64) - Minimum SOL to receive
Total: 24 bytes
```

### Account Layout

```
Index | Account                           | Writable | Signer | Description
------|-----------------------------------|----------|--------|-------------
0     | Pool                              | Yes      | No     | Pool account
1     | User                              | Yes      | Yes    | User wallet
2     | Global Config                     | No       | No     | Global config PDA
3     | Base Mint                         | No       | No     | Pump token mint
4     | Quote Mint                        | No       | No     | WSOL mint
5     | User Base Token Account           | Yes      | No     | User's token ATA
6     | User Quote Token Account          | Yes      | No     | User's WSOL ATA
7     | Pool Base Token Account           | Yes      | No     | Pool's token vault
8     | Pool Quote Token Account          | Yes      | No     | Pool's WSOL vault
9     | Protocol Fee Recipient            | No       | No     | Fee recipient wallet
10    | Protocol Fee Recipient Token Acct | Yes      | No     | Fee recipient's WSOL ATA
11    | Base Token Program                | No       | No     | Token program
12    | Quote Token Program               | No       | No     | SPL Token
13    | System Program                    | No       | No     | System program
14    | Associated Token Program          | No       | No     | ATA program
15    | Event Authority                   | No       | No     | Event authority PDA
16    | Program                           | No       | No     | PumpSwap program
17    | Coin Creator Vault ATA            | Yes      | No     | Creator fee vault
18    | Coin Creator Vault Authority      | No       | No     | Creator vault authority PDA
19    | Fee Config                        | No       | No     | Fee config PDA
20    | Fee Program                       | No       | No     | Pump fee program
```

---

## PDA Derivations

### Global Config

```rust
pub fn derive_global_config() -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[b"global_config"],
        &PUMPSWAP,
    )
}
```

### Event Authority

```rust
pub fn derive_event_authority() -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[b"__event_authority"],
        &PUMPSWAP,
    )
}
```

### Coin Creator Vault Authority

```rust
pub fn derive_coin_creator_vault_authority(coin_creator: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[b"coin_creator_vault_authority", coin_creator.as_ref()],
        &PUMPSWAP,
    )
}
```

---

## Implementation

### Direction Detection

```rust
pub fn swap(
    accounts: &[AccountInfo],
    amount_in: u64,
    min_amount_out: u64,
    is_buy: bool,  // true = SOL→Token, false = Token→SOL
) -> Result<()> {
    let required = if is_buy { 23 } else { 21 };
    
    if accounts.len() < required {
        return Err(ArbRouterError::InvalidAccount.into());
    }
    
    // Build instruction data based on direction
    if is_buy {
        // Buy: base_amount_out (min tokens), max_quote_amount_in (max SOL)
        data.extend_from_slice(&BUY_DISCRIMINATOR);
        data.extend_from_slice(&min_amount_out.to_le_bytes());  // base_amount_out
        data.extend_from_slice(&amount_in.to_le_bytes());       // max_quote_amount_in
        data.push(0);  // referral = None
    } else {
        // Sell: base_amount_in (tokens), min_quote_amount_out (min SOL)
        data.extend_from_slice(&SELL_DISCRIMINATOR);
        data.extend_from_slice(&amount_in.to_le_bytes());       // base_amount_in
        data.extend_from_slice(&min_amount_out.to_le_bytes());  // min_quote_amount_out
    }
    
    // ... build account metas and invoke
}
```

### Writable Accounts

**Buy (23 accounts):**
```rust
is_writable = matches!(i, 0 | 1 | 5 | 6 | 7 | 8 | 10 | 17 | 20)
// Pool, User, User ATAs, Pool vaults, Protocol fee ATA, Creator vault, User volume accumulator
```

**Sell (21 accounts):**
```rust
is_writable = matches!(i, 0 | 1 | 5 | 6 | 7 | 8 | 10 | 17)
// Pool, User, User ATAs, Pool vaults, Protocol fee ATA, Creator vault
```

---

## Swap Math

PumpSwap uses constant product formula after graduation:

```
x * y = k

output = (reserve_out * amount_in * (1 - fee)) / (reserve_in + amount_in * (1 - fee))
```

### Fees

- **Total fee**: 0.25%
- **LP share**: 0.20% (goes to locked liquidity)
- **Protocol share**: 0.05%
- **Creator fee**: Configurable per token

---

## Token Conventions

- **Base Token**: The Pump.fun graduated token
- **Quote Token**: Usually WSOL (wrapped SOL)
- **Buy**: Spending SOL to receive tokens
- **Sell**: Spending tokens to receive SOL

---

## Common Gotchas

1. **Buy vs Sell account counts**: 23 vs 21 - must match exactly
2. **Parameter ordering differs**:
   - Buy: `(min_tokens_out, max_sol_in, referral)`
   - Sell: `(tokens_in, min_sol_out)`
3. **Volume accumulators only for Buy**: Sell doesn't track volume
4. **Creator vault required**: Even if no creator fee, accounts must be provided
5. **Token-2022 support**: Base token may be Token-2022 (check program at index 11)
6. **WSOL wrapping**: Quote is always WSOL, may need wrap/unwrap

---

## Integration Notes

### Identifying PumpSwap Pools

- Pools created automatically on graduation
- Base token is the Pump.fun token
- Quote token is always WSOL
- Can query via Pump.fun API or Shyft GraphQL

### Arbitrage Considerations

- High volatility immediately after graduation
- Creator fees can vary (0-10%)
- Liquidity starts relatively low (~$12K at graduation)
- Often paired with other DEXs (Raydium) for larger pools
