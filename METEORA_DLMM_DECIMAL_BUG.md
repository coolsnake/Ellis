# 🚨 METEORA DLMM DECIMAL SWAP BUG

## Problem

The Meteora DLMM price calculation uses `decA` and `decB` values that are determined **BEFORE** canonicalization, but the formula bakes these decimal differences into the price. After canonicalization swaps `mint_a` ↔ `mint_b` and `decimals_a` ↔ `decimals_b`, the stored price becomes incorrect.

### The Buggy Flow

**Step 1: Price Calculation (BEFORE canonicalization)**
```typescript
// meteora.ts lines 247-265
const activeId = Number(it?.active_id);  // e.g., -50000
const binStep = Number(it?.bin_step);    // e.g., 10
const decA = 11;  // oreoU2 decimals
const decB = 9;   // SOL decimals

const f = Math.pow(1.0001, binStep);  // 1.001
// BUG: This bakes in the decimal difference (11 - 9 = 2)
const bPerA = Math.pow(f, activeId) * Math.pow(10, decA - decB);
// bPerA = 1.001^(-50000) * 10^(2) = 0.00672 * 100 = 0.672

// Price stored as:
price_a_per_b = 0.672;  // oreoU2 per 1 SOL
```

**Step 2: Canonicalization (SWAPS mints and decimals)**
```typescript
// canonical.ts swapPoolFields()
// SOL is higher priority than oreoU2, so swap to put SOL on the A side
mint_a: oreoU2  →  mint_a: SOL
mint_b: SOL     →  mint_b: oreoU2
decimals_a: 11  →  decimals_a: 9
decimals_b: 9   →  decimals_b: 11
price_a_per_b: 0.672  →  price_a_per_b: 1 / 0.672 = 1.488  // INVERTED
```

**Step 3: Graph Uses Swapped Pool**
```typescript
// Graph sees:
mint_a: SOL (9 decimals)
mint_b: oreoU2 (11 decimals)
price_a_per_b: 1.488  // SOL per 1 oreoU2

// BUT the decimal adjustment in the original formula was WRONG!
// The formula used (decA - decB) = (11 - 9) = 2
// After swap, the graph sees (decA - decB) = (9 - 11) = -2
// The price has a 10^4 error (10^2 from original calc, then inverted = 10^-2 effective)
```

### Real Example: oreoU2/SOL Pool

**API Response**:
```json
{
  "address": "FMhuUk4EDLBykp5S6gw14fMbvKsFoFVg5YuuSvMn3fWh",
  "active_id": -50000,  // Very negative = oreoU2 is much cheaper than SOL
  "bin_step": 10,
  "mint_x": "oreoU2P8bN6jkk3jbaiVxYnG1dCXcYxwhwyK9jSybcp",  // Token X = oreoU2
  "mint_y": "So11111111111111111111111111111111111111112",   // Token Y = SOL
  "current_price": 0.000013  // oreoU2 per SOL (correct magnitude)
}
```

**Our Calculation**:
```typescript
decA = 11;  // oreoU2 decimals (from resolveDEcimals)
decB = 9;   // SOL decimals (from resolveDecimals)

const f = Math.pow(1.0001, 10);  // 1.0010005...
const bPerA = Math.pow(1.001, -50000) * Math.pow(10, 11 - 9);
// = 0.00672 * 100 = 0.672  ❌ WRONG!

// Should be:
// Math.pow(1.001, -50000) = 0.00672
// With NO decimal adjustment here!
```

**After Canonicalization**:
```typescript
mint_a: SOL
mint_b: oreoU2
decimals_a: 9
decimals_b: 11
price_a_per_b: 1 / 0.672 = 1.488  // SOL per oreoU2 ❌ WRONG!

// Should be:
price_a_per_b: 1 / 0.00672 = 148.8  // SOL per oreoU2
// Which means 1 oreoU2 = 0.0067 SOL (correct!)
```

**Arbitrage Detection**:
```
Rate: 75094547.268353  // MASSIVELY INFLATED
Profit: 997072474048 bps  // 10 billion % profit ❌
```

## Root Cause

The Meteora DLMM price formula **MUST NOT include decimal adjustment**. The formula is:

```
priceYperX = (1 + binStep/10000)^activeId
```

The decimal adjustment should be **0** or done separately based on **CURRENT** (post-canonicalization) mints.

## Why This Happened

1. **Misunderstanding of Formula**: The `* Math.pow(10, decA - decB)` was added thinking it would help with orientation, but it's incorrect.

2. **Decimal Baking**: By baking decimal differences into the price BEFORE canonicalization, we lose the ability to correctly adjust after swapping.

3. **No Re-Resolution**: Unlike Orca (which we just fixed), Meteora doesn't re-derive price after canonicalization.

## Solution

**Option 1: Remove Decimal Adjustment (CORRECT)**
```typescript
// BEFORE (WRONG):
const bPerA = Math.pow(f, activeId) * Math.pow(10, decA - decB);

// AFTER (CORRECT):
const priceYperX = Math.pow(f, activeId);
// priceYperX is Y per 1 X (in native units, no decimal adjustment)

// Then use this as the base price without decimal scaling
```

**Option 2: Re-Resolve Decimals After Canonicalization (DEFENSIVE)**
```typescript
// After canonicalization, re-derive price using CURRENT mints
for (const pool of clmmCanon) {
  if (pool.price_a_per_b && pool.tick_spacing) {
    // Re-resolve decimals for current mints
    const decA = await resolveDecimals(pool.mint_a) ?? pool.decimals_a;
    const decB = await resolveDecimals(pool.mint_b) ?? pool.decimals_b;
    
    // Re-calculate price with correct decimals
    // ... (but this is complex)
  }
}
```

**RECOMMENDED: Option 1** - Remove the decimal adjustment entirely. The Meteora DLMM formula should be:

```typescript
price = (1 + binStep/10000)^activeId
```

Without any `* Math.pow(10, decA - decB)` term.

## Files to Fix

- `backend/src/server/pools/meteora.ts` (line 253)

## Next Steps

1. Remove decimal adjustment from price formula
2. Verify against API `current_price` values
3. Test with known pools (oreoU2/SOL)
4. Monitor arbitrage detection for realistic profit_bps

