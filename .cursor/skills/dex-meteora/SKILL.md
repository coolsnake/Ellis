---
name: dex-meteora
description: Meteora DEX integration covering DLMM (Dynamic Liquidity Market Maker) and DAMM (Dynamic AMM) with their variants including swap/swap2 for DLMM and v1/v2 for DAMM. Use when working on Meteora pool integration, bin arrays, or understanding Meteora's unique liquidity models.
---

# Meteora DEX Integration

Meteora offers two distinct pool architectures: DLMM (bin-based concentrated liquidity) and DAMM (dynamic AMM with vault integration).

## Pool Type Comparison

| Feature | DLMM | DAMM v1 | DAMM v2 (CP-AMM) |
|---------|------|---------|------------------|
| **Program ID** | `LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo` | `Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB` | `cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG` |
| **Model** | Discrete bins | Constant product + Mercurial Vaults | Simple constant product |
| **Accounts** | 17-21 (variable bins) | 16+ | 14 |
| **Token-2022** | Yes (swap2) | No | No |
| **Dynamic Fees** | Yes | Yes | No |

---

## DLMM (Dynamic Liquidity Market Maker)

### Overview
Bin-based concentrated liquidity where each bin represents a discrete price point with zero slippage within the bin.

### Program ID
```
LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo
```

### Swap Variants

| Variant | Accounts | Token Support | Detection |
|---------|----------|---------------|-----------|
| `swap` | 17+ (15 fixed + bins) | SPL Token | No Memo at index 13 |
| `swap2` | 18+ (16 fixed + bins) | SPL + Token-2022 | Memo Program at index 13 |

### Instruction Discriminators

```rust
swap:  [248, 198, 158, 145, 225, 117, 135, 200]  // sha256("global:swap")[0..8]
swap2: [65, 75, 63, 76, 235, 91, 91, 136]        // sha256("global:swap2")[0..8]
```

### Swap Parameters

```rust
pub struct SwapParams {
    pub amount_in: u64,
    pub min_amount_out: u64,
}
```

### Account Layout: `swap` (17+ accounts)

```
Index | Account                    | Writable | Description
------|----------------------------|----------|-------------
0     | LB Pair                    | Yes      | Pool account
1     | Bin Array Bitmap Extension | No       | Optional (program ID placeholder)
2     | Reserve X                  | Yes      | Token X vault
3     | Reserve Y                  | Yes      | Token Y vault
4     | User Token In              | Yes      | User INPUT token ATA
5     | User Token Out             | Yes      | User OUTPUT token ATA
6     | Token X Mint               | No       | Mint for token X
7     | Token Y Mint               | No       | Mint for token Y
8     | Oracle                     | Yes      | Oracle account
9     | Host Fee In                | No       | Fee account (program ID placeholder)
10    | User                       | Yes      | Signer
11    | Token X Program            | No       | Token program for X
12    | Token Y Program            | No       | Token program for Y
13    | Event Authority            | No       | Event authority PDA
14    | Meteora DLMM Program       | No       | For CPI
15+   | Bin Arrays                 | Yes      | Variable (2-5 bin arrays)
```

### Account Layout: `swap2` (18+ accounts)

```
Index | Account                    | Writable | Description
------|----------------------------|----------|-------------
0     | LB Pair                    | Yes      | Pool account
1     | Bin Array Bitmap Extension | No       | Optional
2     | Reserve X                  | Yes      | Token X vault
3     | Reserve Y                  | Yes      | Token Y vault
4     | User Token In              | Yes      | User INPUT token ATA
5     | User Token Out             | Yes      | User OUTPUT token ATA
6     | Token X Mint               | No       | Mint for token X
7     | Token Y Mint               | No       | Mint for token Y
8     | Oracle                     | Yes      | Oracle account
9     | Host Fee In                | No       | Fee account
10    | User                       | Yes      | Signer
11    | Token X Program            | No       | Token program for X
12    | Token Y Program            | No       | Token program for Y
13    | Memo Program               | No       | REQUIRED for swap2
14    | Event Authority            | No       | Event authority PDA
15    | Meteora DLMM Program       | No       | For CPI
16+   | Bin Arrays                 | Yes      | Variable (2-5 bin arrays)
```

### Variant Detection

```rust
// Detect by checking if Memo Program is at index 13
const MEMO_PROGRAM_ID: Pubkey = /* MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr */;

let use_swap2 = accounts.len() > 13 && accounts[13].key == &MEMO_PROGRAM_ID;
```

### Bin Array System

Each bin array holds 70 bins covering a price range determined by bin step:

| Bin Step | Price per Bin | Range per Array |
|----------|---------------|-----------------|
| 1 | ~0.01% | ~0.7% |
| 2 | ~0.02% | ~1.4% |
| 5 | ~0.05% | ~3.5% |
| 15 | ~0.15% | ~10.5% |
| 100 | ~1% | ~70% |

### Bin Array PDA

```rust
pub fn derive_bin_array_address(
    lb_pair: &Pubkey,
    bin_array_index: i32,
) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[
            b"bin_array",
            lb_pair.as_ref(),
            &bin_array_index.to_le_bytes(),  // Binary, not string!
        ],
        &METEORA_DLMM,
    )
}
```

### Variable Bin Array Counts

For pools with small bin_step (≤5), need more bin arrays:
- **Minimum**: 2 bin arrays
- **Maximum**: 5 bin arrays
- Backend determines based on swap size and bin_step

---

## DAMM v1 (Dynamic AMM with Mercurial Vaults)

### Overview
Constant product AMM integrated with Mercurial Vaults for yield generation on idle liquidity.

### Program ID
```
Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB
```

### Instruction Discriminator

```rust
swap: [248, 198, 158, 145, 225, 117, 135, 200]  // sha256("global:swap")[0..8]
```

### Account Layout (16+ accounts)

```
Index | Account              | Writable | Description
------|----------------------|----------|-------------
0     | Pool                 | Yes      | DAMM pool account
1     | User Source Token    | Yes      | User input ATA
2     | User Dest Token      | Yes      | User output ATA
3     | A Vault              | Yes      | Mercurial vault for token A
4     | B Vault              | Yes      | Mercurial vault for token B
5     | A Token Vault        | Yes      | SPL token account in vault A
6     | B Token Vault        | Yes      | SPL token account in vault B
7     | A Vault LP Mint      | Yes      | LP mint for vault A
8     | B Vault LP Mint      | Yes      | LP mint for vault B
9     | A Vault LP           | Yes      | Pool's LP tokens for vault A
10    | B Vault LP           | Yes      | Pool's LP tokens for vault B
11    | Protocol Token Fee   | Yes      | Protocol fee account
12    | User                 | No       | Signer
13    | Vault Program        | No       | Mercurial Vault program
14    | Token Program        | No       | SPL Token program
15    | DAMM v1 Program      | No       | For CPI
16+   | Remaining Accounts   | No       | For stable/depeg pools
```

### PDA Derivation

```rust
// Pool authority v1
pub fn derive_pool_authority_v1(pool: &Pubkey, program_id: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[b"vault_and_lp_mint_auth_pda", pool.as_ref()],
        program_id,
    )
}
```

---

## DAMM v2 (CP-AMM)

### Overview
Simpler constant product AMM without Mercurial Vault integration.

### Program ID
```
cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG
```

### Instruction: `swap2`

**Discriminator:** `[65, 75, 63, 76, 235, 91, 91, 136]`

### Swap Parameters

```rust
pub struct SwapParams2 {
    pub amount0: u64,     // Input amount (ExactIn) or output (ExactOut)
    pub amount1: u64,     // Min output (ExactIn) or max input (ExactOut)
    pub swap_mode: u8,    // 0=ExactIn, 1=PartialFill, 2=ExactOut
}
```

### Account Layout (14 accounts)

```
Index | Account                  | Writable | Description
------|--------------------------|----------|-------------
0     | Pool Authority           | No       | Fixed PDA
1     | Pool                     | Yes      | Pool account
2     | Input Token Account      | Yes      | User input ATA
3     | Output Token Account     | Yes      | User output ATA
4     | Token A Vault            | Yes      | Pool vault A
5     | Token B Vault            | Yes      | Pool vault B
6     | Token A Mint             | No       | Mint A
7     | Token B Mint             | No       | Mint B
8     | Payer                    | No       | Signer
9     | Token A Program          | No       | Token program for A
10    | Token B Program          | No       | Token program for B
11    | Referral Token Account   | No       | Optional (program ID as None)
12    | Event Authority          | No       | Event authority PDA
13    | DAMM v2 Program          | No       | For CPI (in accounts list!)
```

### PDA Derivation

```rust
// Pool authority v2
pub fn derive_pool_authority_v2(pool: &Pubkey, program_id: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[b"pool_authority", pool.as_ref()],
        program_id,
    )
}
```

---

## Version Detection

```rust
pub fn swap(accounts: &[AccountInfo], amount_in: u64, min_out: u64, _a_to_b: bool) -> Result<()> {
    // Detect by account count
    if accounts.len() >= 16 {
        swap_v1(accounts, amount_in, min_out)  // Mercurial Vaults
    } else if accounts.len() >= 14 {
        swap_v2(accounts, amount_in, min_out)  // CP-AMM
    } else {
        Err(ArbRouterError::InvalidAccount.into())
    }
}
```

---

## DLMM Swap Math

### Bin Price Formula

```
price_at_bin(id) = (1 + bin_step/10000)^(id - 8388608)
```

Where 8388608 is the "zero bin" (price = 1.0).

### Zero-Slippage Bins

Within a single bin, swaps execute at the bin price with no slippage:
```
output = input * bin_price  (for X→Y)
output = input / bin_price  (for Y→X)
```

### Cross-Bin Swaps

When swap exhausts a bin:
1. Consume liquidity in current bin at bin price
2. Move to next bin in direction
3. Continue until swap complete

### Dynamic Fees

DLMM fees adjust based on volatility:
- Base fee + variable component
- Higher volatility → higher fees
- Protects LPs during high-volatility periods

---

## Common Gotchas

1. **DLMM bin arrays are variable**: Need 2-5 based on pool and swap size
2. **DLMM swap2 detection**: Check Memo Program at index 13, not account count
3. **DAMM v1 has Mercurial accounts**: Many more accounts for vault integration
4. **DAMM v2 program in accounts**: Unlike v1, program ID must be in account list
5. **User token ordering**: DLMM uses INPUT/OUTPUT order, not X/Y order
6. **Referral as None**: For DAMM v2, pass program ID as "None" sentinel
