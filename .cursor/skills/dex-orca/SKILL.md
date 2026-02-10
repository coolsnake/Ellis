---
name: dex-orca
description: Orca Whirlpool DEX integration covering the concentrated liquidity protocol with swap and swap_v2 variants, tick array mechanics, and sqrt price math. Use when working on Orca pool integration, Whirlpool swaps, or understanding concentrated liquidity on Solana.
---

# Orca Whirlpool Integration

Orca Whirlpool is a concentrated liquidity AMM (CLMM) on Solana, similar to Uniswap V3.

## Program ID

```
whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc
```

## Swap Variants

| Variant | Accounts | Token Support | Description |
|---------|----------|---------------|-------------|
| `swap` | 12 | SPL Token only | Standard tokens |
| `swap_v2` | 16 | SPL + Token-2022 | Includes memo program |

## Instruction Discriminators

```rust
swap:    [0xf8, 0xc6, 0x9e, 0x91, 0xe1, 0x75, 0x87, 0xc8]  // sha256("global:swap")[0..8]
swap_v2: [0x2b, 0x04, 0xed, 0x0b, 0x1a, 0xc9, 0x1e, 0x62]  // sha256("global:swap_v2")[0..8]
```

## Swap Parameters

```rust
pub struct SwapParams {
    pub amount: u64,                    // Amount to swap
    pub other_amount_threshold: u64,    // Min/max for other token
    pub sqrt_price_limit: u128,         // Price limit (direction-dependent)
    pub amount_specified_is_input: bool, // true = exact-in
    pub a_to_b: bool,                   // Swap direction
}
```

### Sqrt Price Limits

```rust
// A→B: price decreases, use MIN limit
const MIN_SQRT_PRICE_LIMIT: u128 = 4295048017;

// B→A: price increases, use MAX limit  
const MAX_SQRT_PRICE_LIMIT: u128 = 79226673515401279992447579055;
```

---

## Account Layout: `swap` (12 accounts)

```
Index | Account              | Writable | Signer | Description
------|----------------------|----------|--------|-------------
0     | Token Program        | No       | No     | SPL Token program
1     | Token Authority      | No       | Yes    | User wallet (signer)
2     | Whirlpool            | Yes      | No     | Pool account
3     | Token Owner Account A| Yes      | No     | User's token A ATA
4     | Token Vault A        | Yes      | No     | Pool's token A vault
5     | Token Owner Account B| Yes      | No     | User's token B ATA
6     | Token Vault B        | Yes      | No     | Pool's token B vault
7     | Tick Array 0         | Yes      | No     | Current/center tick array
8     | Tick Array 1         | Yes      | No     | Adjacent tick array
9     | Tick Array 2         | Yes      | No     | Adjacent tick array
10    | Oracle               | Yes      | No     | Oracle account
11    | Whirlpool Program    | No       | No     | For CPI
```

---

## Account Layout: `swap_v2` (16 accounts)

```
Index | Account              | Writable | Signer | Description
------|----------------------|----------|--------|-------------
0     | Token Program A      | No       | No     | Token program for A
1     | Token Program B      | No       | No     | Token program for B
2     | Memo Program         | No       | No     | REQUIRED for swap_v2
3     | Token Authority      | No       | Yes    | User wallet (signer)
4     | Whirlpool            | Yes      | No     | Pool account
5     | Token Mint A         | No       | No     | Mint for token A
6     | Token Mint B         | No       | No     | Mint for token B
7     | Token Owner Account A| Yes      | No     | User's token A ATA
8     | Token Vault A        | Yes      | No     | Pool's token A vault
9     | Token Owner Account B| Yes      | No     | User's token B ATA
10    | Token Vault B        | Yes      | No     | Pool's token B vault
11    | Tick Array 0         | Yes      | No     | Current tick array
12    | Tick Array 1         | Yes      | No     | Adjacent tick array
13    | Tick Array 2         | Yes      | No     | Adjacent tick array
14    | Oracle               | Yes      | No     | Oracle account
15    | Whirlpool Program    | No       | No     | For CPI
```

### swap_v2 Instruction Data

```
[0-7]   discriminator (8 bytes)
[8-15]  amount (u64)
[16-23] other_amount_threshold (u64)
[24-39] sqrt_price_limit (u128)
[40]    amount_specified_is_input (bool)
[41]    a_to_b (bool)
[42-45] remaining_accounts_info (Vec length = 0)
Total: 46 bytes
```

---

## Tick Array System

### Tick Basics

- **Tick**: Discrete price point, each tick = 1 basis point (0.01%) change
- **Tick formula**: `sqrt_price(i) = 1.0001^(i/2)`
- **Tick range**: -443,636 to +443,636

### Tick Spacing

Pool creators set tick spacing, which determines:
- Which ticks are initializable
- Granularity of liquidity positions
- Gas costs (smaller spacing = more tick crossings)

Common tick spacings:
- **1**: Very fine (stablecoins)
- **8**: Standard
- **64**: Coarse (volatile pairs)
- **128**: Very coarse

### Tick Arrays

Tick arrays store 88 ticks each in on-chain accounts (~10KB each).

**Tick array index calculation:**
```rust
tick_array_start = (tick / tick_spacing / 88) * 88 * tick_spacing
```

### Tick Array PDA Derivation

**CRITICAL**: Orca uses ASCII string encoding for tick index, NOT binary!

```rust
pub fn derive_tick_array_address(
    whirlpool: &Pubkey,
    start_tick_index: i32,
) -> (Pubkey, u8) {
    // Convert to string - matches Orca SDK
    let index_str = start_tick_index.to_string();
    Pubkey::find_program_address(
        &[
            b"tick_array",
            whirlpool.as_ref(),
            index_str.as_bytes(),  // ASCII string, NOT i32 bytes!
        ],
        &ORCA_WHIRLPOOL,
    )
}
```

**Example**: For tick index -9856:
- Seed is `b"-9856"` (5 bytes)
- NOT `(-9856i32).to_le_bytes()` (4 bytes)

### Oracle PDA

```rust
pub fn derive_oracle_address(whirlpool: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[b"oracle", whirlpool.as_ref()],
        &ORCA_WHIRLPOOL,
    )
}
```

---

## Swap Math

### Price Representation

```
sqrt_price_x64 = sqrt(price) * 2^64
price = (sqrt_price_x64 / 2^64)^2
```

### Within Single Tick Range

For swap A→B (price decreases):
```
// Delta in sqrt price
Δ√P = Δx × √P / L

// Output amount
Δy = L × (√P_old - √P_new)

where:
  L = liquidity in range
  √P = current sqrt price
  Δx = input amount
```

For swap B→A (price increases):
```
// Delta in sqrt price  
Δ√P = Δy / L

// Output amount
Δx = L × (1/√P_new - 1/√P_old)
```

### Cross-Tick Swaps

When swap crosses tick boundaries:
1. Consume liquidity in current tick up to boundary
2. Cross tick: add/remove liquidity from positions at that tick
3. Continue in new tick range
4. Repeat until swap complete

---

## Implementation Patterns

### Variant Detection

```rust
let use_swap_v2 = accounts.len() >= 16;

if use_swap_v2 {
    // Token-2022 compatible
    // Memo program at index 2
} else {
    // Standard SPL tokens
}
```

### Direction-Based Price Limit

```rust
let sqrt_price_limit = if a_to_b {
    MIN_SQRT_PRICE_LIMIT  // Price decreasing
} else {
    MAX_SQRT_PRICE_LIMIT  // Price increasing
};
```

### Selecting Tick Arrays

Need 3 tick arrays covering the swap range:
1. **Tick Array 0**: Contains current tick
2. **Tick Array 1**: In swap direction (lower for A→B)
3. **Tick Array 2**: Further in swap direction

```typescript
function getTickArrays(currentTick: number, aToB: boolean, tickSpacing: number) {
    const ticksPerArray = 88 * tickSpacing;
    const currentArrayStart = Math.floor(currentTick / ticksPerArray) * ticksPerArray;
    
    if (aToB) {
        // Price decreasing, need lower tick arrays
        return [
            currentArrayStart,
            currentArrayStart - ticksPerArray,
            currentArrayStart - 2 * ticksPerArray,
        ];
    } else {
        // Price increasing, need higher tick arrays
        return [
            currentArrayStart,
            currentArrayStart + ticksPerArray,
            currentArrayStart + 2 * ticksPerArray,
        ];
    }
}
```

---

## Common Gotchas

1. **Tick array string encoding**: PDA seeds use ASCII string, not binary
2. **Three tick arrays required**: Even if swap doesn't cross ticks
3. **Oracle is writable**: Updated on every swap
4. **Memo program required for swap_v2**: Cannot omit even if not using memo
5. **A/B ordering**: Token A has lower mint address (canonical ordering)

## Fee Tiers

Orca Whirlpools support multiple fee tiers:
- 0.01% (1 bps) - Stablecoins
- 0.05% (5 bps) - Standard
- 0.30% (30 bps) - Medium volatility
- 1.00% (100 bps) - High volatility
