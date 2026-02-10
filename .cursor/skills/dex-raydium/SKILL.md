---
name: dex-raydium
description: Raydium DEX integration covering AMM v4, CLMM, and CPMM pool types with their distinct program IDs, account layouts, instruction formats, and swap math. Use when working on Raydium pool integration, swap instructions, or understanding Raydium's different pool architectures.
---

# Raydium DEX Integration

Raydium offers three distinct pool types, each with different program IDs, architectures, and use cases.

## Pool Type Comparison

| Feature | AMM v4 | CLMM | CPMM |
|---------|--------|------|------|
| **Program ID** | `675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8` | `CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK` | `CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C` |
| **Model** | Constant product + OpenBook | Concentrated liquidity (ticks) | Constant product |
| **Token-2022** | No | Yes (swap_v2) | Yes |
| **Account Count** | 19 | 11-18 | 14 |
| **Complexity** | High (Serum accounts) | Medium (tick arrays) | Low |
| **Best For** | Legacy meme coins | Stablecoins, high volume | Utility tokens |

---

## AMM v4 (Legacy)

### Overview
Constant product AMM integrated with OpenBook (formerly Serum) order book. Requires market ID creation (0.55-3 SOL cost).

### Program ID
```
675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8
```

### Swap Instruction: `swap_base_in`

**Discriminator:** `9` (single byte)

**Instruction Data Format:**
```
[0]     discriminator (1 byte) = 9
[1-8]   amount_in (u64 LE)
[9-16]  min_amount_out (u64 LE)
Total: 17 bytes
```

### Account Layout (19 accounts)

```
Index | Account                    | Writable | Signer | Description
------|----------------------------|----------|--------|-------------
0     | Token Program              | No       | No     | SPL Token
1     | AMM ID                     | Yes      | No     | Pool state
2     | AMM Authority              | No       | No     | PDA authority
3     | AMM Open Orders            | Yes      | No     | Serum open orders
4     | AMM Target Orders          | Yes      | No     | Can be same as pool
5     | Pool Coin Token Account    | Yes      | No     | Base vault
6     | Pool PC Token Account      | Yes      | No     | Quote vault
7     | Serum Program ID           | No       | No     | OpenBook program
8     | Serum Market               | Yes      | No     | Market account
9     | Serum Bids                 | Yes      | No     | Bids account
10    | Serum Asks                 | Yes      | No     | Asks account
11    | Serum Event Queue          | Yes      | No     | Event queue
12    | Serum Coin Vault           | Yes      | No     | Market base vault
13    | Serum PC Vault             | Yes      | No     | Market quote vault
14    | Serum Vault Signer         | No       | No     | Market vault authority
15    | User Source Token          | Yes      | No     | User input ATA
16    | User Destination Token     | Yes      | No     | User output ATA
17    | User Owner                 | Yes      | Yes    | User wallet (signer)
18    | Raydium AMM Program        | No       | No     | For CPI
```

### PDA Derivation

```rust
// AMM Authority
seeds = [amm_id.as_ref(), b"amm authority"]
```

### Swap Math (Constant Product)

```
price = reserve_quote / reserve_base
output = (reserve_out * amount_in * (1 - fee)) / (reserve_in + amount_in * (1 - fee))
```

---

## CLMM (Concentrated Liquidity)

### Overview
Concentrated liquidity similar to Uniswap V3. Liquidity concentrated in tick ranges for capital efficiency.

### Program ID
```
Mainnet: CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK
Devnet:  DRayAUgENGQBKVaX8owNhgzkEDyoHTGVEGHVJT1E9pfH
```

### Swap Variants

| Variant | Accounts | Token Support | When to Use |
|---------|----------|---------------|-------------|
| `swap` | 11-12 | SPL Token only | Standard tokens |
| `swap_v2` | 17-18 | SPL + Token-2022 | Token-2022 tokens |

### Instruction Discriminators

```rust
swap:    [248, 198, 158, 145, 225, 117, 135, 200]  // sha256("global:swap")[0..8]
swap_v2: [43, 4, 237, 11, 26, 201, 30, 98]         // sha256("global:swap_v2")[0..8]
```

### Swap Parameters

```rust
pub struct SwapParams {
    pub amount: u64,                  // Input amount
    pub other_amount_threshold: u64,  // Min output (slippage)
    pub sqrt_price_limit_x64: u128,   // 0 for no limit
    pub is_base_input: bool,          // true for exact-in
}
```

### Account Layout: `swap` (11-12 accounts)

**Without exBitmap (11 accounts):**
```
Index | Account              | Writable | Description
------|----------------------|----------|-------------
0     | Payer                | Yes      | Signer
1     | AMM Config           | No       | Pool config
2     | Pool State           | Yes      | Pool account
3     | Input Token Account  | Yes      | User input ATA
4     | Output Token Account | Yes      | User output ATA
5     | Input Vault          | Yes      | Pool input vault
6     | Output Vault         | Yes      | Pool output vault
7     | Observation State    | Yes      | Oracle/observation
8     | Token Program        | No       | SPL Token
9     | Tick Array           | Yes      | Single tick array
10    | Raydium CLMM Program | No       | For CPI
```

**With exBitmap (12 accounts):**
- Add `Tick Array Bitmap Extension` at index 10
- Program moves to index 11

### Account Layout: `swap_v2` (17-18 accounts)

**Without exBitmap (17 accounts):**
```
Index | Account              | Writable | Description
------|----------------------|----------|-------------
0     | Payer                | Yes      | Signer
1     | AMM Config           | No       | Pool config
2     | Pool State           | Yes      | Pool account
3     | Input Token Account  | Yes      | User input ATA
4     | Output Token Account | Yes      | User output ATA
5     | Input Vault          | Yes      | Pool input vault
6     | Output Vault         | Yes      | Pool output vault
7     | Observation State    | Yes      | Oracle
8     | Token Program        | No       | SPL Token
9     | Token-2022 Program   | No       | Token-2022
10    | Memo Program         | No       | Memo program
11    | Input Token Mint     | No       | Input mint
12    | Output Token Mint    | No       | Output mint
13    | Tick Array 0         | Yes      | Center tick array
14    | Tick Array 1         | Yes      | Directional
15    | Tick Array 2         | Yes      | Directional
16    | Raydium CLMM Program | No       | For CPI
```

**With exBitmap (18 accounts):**
- Add `Tick Array Bitmap Extension` at index 13
- Tick arrays shift to 14-16
- Program moves to index 17

### Tick Array Calculation

Tick arrays must cover the price range of the swap:
- Tick spacing determines granularity
- Each tick array covers `tick_spacing * 88` ticks
- Need arrays in swap direction

### Swap Math (CLMM)

```
// Sqrt price representation
sqrt_price_x64 = sqrt(price) * 2^64

// Tick to price
price = 1.0001^tick
sqrt_price = 1.0001^(tick/2)

// Within single tick range
delta_sqrt_price = amount_in * sqrt_price / liquidity  (for A→B)
amount_out = liquidity * (sqrt_price_old - sqrt_price_new)
```

---

## CPMM (Constant Product)

### Overview
Simpler constant product pools with Token-2022 support and lower creation cost.

### Program ID
```
CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C
```

### Swap Instruction: `swap_base_input`

**Discriminator:** `[143, 190, 90, 218, 196, 30, 51, 222]`

### Swap Parameters

```rust
pub struct SwapBaseInputParams {
    pub amount_in: u64,
    pub minimum_amount_out: u64,
}
```

### Account Layout (14 accounts)

```
Index | Account              | Writable | Description
------|----------------------|----------|-------------
0     | Payer                | Yes      | Signer
1     | Authority            | No       | PDA authority
2     | AMM Config           | No       | Pool config
3     | Pool State           | Yes      | Pool account
4     | User Input Token     | Yes      | User input ATA
5     | User Output Token    | Yes      | User output ATA
6     | Input Vault          | Yes      | Pool input vault
7     | Output Vault         | Yes      | Pool output vault
8     | Input Token Program  | No       | Token program for input
9     | Output Token Program | No       | Token program for output
10    | Input Mint           | No       | Input token mint
11    | Output Mint          | No       | Output token mint
12    | Observation State    | Yes      | Oracle/observation
13    | CPMM Program         | No       | For CPI
```

### Swap Math

Same constant product formula as AMM v4:
```
output = (reserve_out * amount_in * (1 - fee)) / (reserve_in + amount_in * (1 - fee))
```

---

## Implementation Patterns

### Variant Detection

```rust
// Detect CLMM variant by account count
let use_swap_v2 = accounts.len() >= 17;

if use_swap_v2 {
    // Token-2022 compatible path
} else {
    // Standard SPL token path
}
```

### Direction Encoding

Direction (A→B vs B→A) is encoded in account ordering:
- Input/output token accounts swapped
- Input/output vaults swapped
- No explicit `a_to_b` flag needed in some variants

### Common Gotchas

1. **AMM v4 requires OpenBook**: Need market ID and all Serum accounts
2. **CLMM tick arrays**: Must derive correct tick arrays for price range
3. **CPMM dual token programs**: Input and output can have different token programs
4. **exBitmap optional**: Only needed for pools with extended tick range

### Fee Tiers

| Pool Type | Common Fees |
|-----------|-------------|
| AMM v4 | 0.25% |
| CLMM | 0.01%, 0.05%, 0.25%, 1% |
| CPMM | 0.01% - 1% (configurable) |
