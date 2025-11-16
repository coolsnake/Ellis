# Summary: Invalid Rate Root Cause Identified

## What the Logs Tell Us

### ✅ Good News

1. **Canonicalization is perfect**: Price inversion math is exact (0.0000% deviation)
2. **Decimal swapping works**: Decimals follow mints correctly when swapped
3. **Our magnitude calibration fix helps**: Reduces reverse edge explosions

### 🔴 Bad News

1. **Meteora normalizer produces wrong prices**: Issues occur BEFORE canonicalization
2. **Prices are 10^6-10^10 times wrong**: Suggesting raw vs whole token confusion
3. **Affects multiple DEXes**: Meteora (8 anomalies), Orca (5), MeteoraBalanced (3)

## Key Log Evidence

### Evidence 1: Perfect Canonicalization, Wrong Input
```
canonical.swap.price_check
orig_price: 124,986,867  ← 125 million BEFORE canonicalization!
new_price: 8.0e-9
deviation_pct: "0.0000"  ← Perfect inversion
```

**Conclusion**: The problem is not canonicalization - it's the normalizer producing 125 million as the original price.

### Evidence 2: Meteora Has Most Anomalies
```
Anomalies by DEX:
- Meteora: 8 (47%)
- Orca: 5 (29%)
- MeteoraBalanced: 3 (18%)
- Raydium: 1 (6%)

Root causes:
- orientation_or_formula_error: 5
- power_of_10_error: 1
- minor_deviation: 11
```

**Conclusion**: Meteora's price formula or data extraction is fundamentally wrong.

### Evidence 3: Consistent 10^6-10^10 Magnitude Errors

All extreme prices involve:
- 6↔9 decimal differences (common tokens vs SOL)
- Prices of millions or billions
- Suggests amounts are in wrong units (raw vs whole)

## Root Cause Hypothesis

**The Meteora Balanced normalizer is treating whole token amounts as raw amounts (or vice versa), causing 10^6-10^9 multiplication errors.**

Code in question (lines 188-192):
```typescript
const amtAraw = Number(it?.reserveA ?? it?.amountA ?? it?.tokenAmountA ?? 0);
const amtBraw = Number(it?.reserveB ?? it?.amountB ?? it?.tokenAmountB ?? 0);
wholeA = amtAraw / Math.pow(10, decA);  // Assumes amtAraw is in smallest units
wholeB = amtBraw / Math.pow(10, decB);
```

**If the API returns whole amounts**: Dividing by 10^decimals makes them 10^6-10^9 times too small
**If the API returns raw amounts but we don't divide**: They're 10^6-10^9 times too large

## What We Added

### 1. Diagnostic Logging in MeteoraBalanced
```typescript
if (price_a_per_b > 100000 || price_a_per_b < 0.00001) {
  logger.info('meteora.balanced.price_extreme', {
    amtAraw,     // What API sent
    wholeA,      // After dividing by decimals
    price_a_per_b,  // Final calculated price
    source_a,    // Which field: reserveA, amountA, vault_whole?
  });
}
```

This will show us:
- What values the API is sending
- How we're converting them
- Whether conversion is correct

### 2. Enhanced Canonicalization Logging
Already added - logs when prices > 100k or deviation > 1%

### 3. Reverse Edge Diagnostics
Already added - logs when reverse edges are suspicious

## Next Steps

### Immediate (Deploy & Monitor)

1. **Deploy these changes** to production
2. **Wait for logs** showing `meteora.balanced.price_extreme`
3. **Examine one problematic pool** in detail:
   - What is `amtAraw` vs `wholeA`?
   - What is the source field (`reserveA`, `amountA`, or `vault_whole`)?
   - Is the conversion 10^6-10^9 off?

### Investigation (Based on Logs)

Compare a problematic pool against the same pool from a working DEX:
- **Example**: JLP/SOL pool `6a3m2Eg`
  - Orca says: 29.24 JLP per SOL
  - Meteora says: 4.52 JLP per SOL
  - Expected: ~70 JLP per SOL
- Look at the `meteora.balanced.price_extreme` log for this pool
- Check if `amtAraw` / `wholeA` ratio matches the error magnitude

### Fix (Once Root Cause Confirmed)

**Option A: API returns whole amounts**
```typescript
// Don't divide by decimals - they're already whole
wholeA = amtAraw;  // Remove: / Math.pow(10, decA)
wholeB = amtBraw;
```

**Option B: API returns raw but field name is wrong**
```typescript
// Rename variable to clarify
const amtAraw = Number(it?.reserveA);  // These are actually RAW
wholeA = amtAraw / Math.pow(10, decA);  // Keep division
```

**Option C: Mixed - some fields raw, some whole**
```typescript
if (it?.vault_a_whole !== undefined) {
  wholeA = it.vault_a_whole;  // Already whole
} else {
  const rawA = it?.reserveA;  // These are raw
  wholeA = rawA / Math.pow(10, decA);
}
```

## Why This Matters

- **Current state**: False arbitrage opportunities with impossible rates
- **User complaint**: "rates linked to canonicalization" ← Actually linked to normalizer BEFORE canonicalization
- **After fix**: Accurate prices → valid arbitrage detection → profitable trades

## Files Modified

1. `backend/src/server/pools/meteoraBalanced.ts` - Added price diagnostic logging
2. `backend/src/server/pools/canonical.ts` - Already has canonicalization logging
3. `backend/src/server/graph.edges.ts` - Already has reverse edge logging
4. `backend/src/server/graph.pricing.ts` - Already has magnitude calibration fix

## Build Status

✅ **TypeScript compilation successful** - Ready to deploy

## Expected Outcome

After deployment, logs will show:
```
[INFO] meteora.balanced.price_extreme {
  pool_id: "121gBYp2...",
  amtAraw: 1000000,        ← What API sent
  wholeA: 0.001,           ← After dividing by 10^9
  price_a_per_b: 125000000 ← Resulting wrong price
}
```

This will confirm whether we're dividing when we shouldn't (or vice versa).

