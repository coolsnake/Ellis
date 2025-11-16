# 🔍 ORCA PRICE INVESTIGATION

## User's Observation

Orca pools still showing massively incorrect prices despite our fixes:

```
USDC:SOL - Orca: 0.007, Raydium/Meteora: ~143 (off by 20,000x!)
oreoU2:SOL - Orca: 0.75-2.49, inconsistent
```

## Our Fixes So Far

1. ✅ **Meteora DLMM**: Removed `* Math.pow(10, decA - decB)` from price formula
2. ✅ **Orca `populateOrcaPoolStates`**: Re-resolve decimals based on current mints (lines 880-881)
3. ✅ **Raydium TX builders**: Re-resolve decimals based on cached mints

## Why Orca Prices Are Still Wrong

### The Flow

1. **Initial Normalization** (lines 329-363):
   ```typescript
   const scale = Math.pow(10, decB - decA);  // Bakes in decimals BEFORE canonicalization
   const aPerB = scale / (ratio * ratio);
   priceFromSqrt = aPerB;  // e.g., 0.007 USDC per 1 SOL (WRONG orientation)
   ```

2. **Canonicalization** (line 632):
   ```typescript
   const clmmCanon = canonicalizePools(clmm);
   // Swaps mints, decimals, inverts price
   // price_a_per_b = 1 / 0.007 = 142.85 ✅ CORRECT!
   ```

3. **`populateOrcaPoolStates`** (line 711):
   ```typescript
   await populateOrcaPoolStates(clmmCanon);
   // Should re-derive price with correct decimals
   // BUT: Only updates IF RPC call succeeds!
   ```

### The Problem

**`populateOrcaPoolStates` might be FAILING or SKIPPING pools!**

Possible reasons:
1. **RPC Rate Limits**: Batch RPC calls timing out or failing
2. **Account Decode Errors**: Whirlpool account parsing failures
3. **Silent Failures**: Errors caught but pools not updated

If `populateOrcaPoolStates` fails to update a pool's price, it keeps the canonicalized price, which could be wrong if:
- The initial price used the wrong decimal scale
- The price inversion during canonicalization compounds the error

### Example: USDC/SOL Pool

**Step 1: Initial (BEFORE canonicalization)**
```typescript
mint_a: EPjF... (USDC, 6 decimals)
mint_b: So11... (SOL, 9 decimals)
decA: 6
decB: 9

scale = 10^(9-6) = 1000
ratio = sqrt_price_x64 / 2^64 = (assume 0.08415)
aPerB = 1000 / (0.08415^2) = 1000 / 0.00708 = 141,242 ❌ WRONG!
// Should be ~143 USDC per 1 SOL, not 141,000!
```

Wait, that doesn't match the logs either. Let me think...

Actually, the logs show `price=0.007`, which suggests the OPPOSITE problem - the price is too small, not too large!

**Alternative Scenario**:

**Step 1: Initial (USDC/SOL in API response)**
```typescript
// API might have them as:
mint_a: So11... (SOL, 9 decimals)
mint_b: EPjF... (USDC, 6 decimals)
decA: 9
decB: 6

scale = 10^(6-9) = 0.001
ratio = sqrt_price_x64 / 2^64 = (assume value gives B/A)
aPerB = 0.001 / (ratio^2)
```

If `ratio^2` is around 0.14, then:
```
aPerB = 0.001 / 0.14 = 0.007 ✅ Matches the log!
```

**Step 2: Canonicalization (USDC higher priority)**
```typescript
// Swap to put USDC on B side:
mint_a: So11... (SOL)
mint_b: EPjF... (USDC)
price_a_per_b: 1 / 0.007 = 142.85 ✅ CORRECT!
```

**Step 3: `populateOrcaPoolStates` FAILS**
```typescript
// RPC call fails or pool not found
// Price is NOT updated
// Pool keeps the INVERTED price: 142.85 ✅ (actually correct!)
```

But the user is seeing `price=0.007` in the logs, which means the price is NOT being inverted!

## Hypothesis

**Canonicalization is NOT inverting the price correctly for these pools!**

Let me check the `swapPoolFields` function to see if there's a bug in price inversion.

