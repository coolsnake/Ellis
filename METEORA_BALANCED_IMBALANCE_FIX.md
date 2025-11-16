# Price Calculation Fixes - Comprehensive Summary

**Date:** 2025-11-16  
**Issues:** 
1. Extreme prices in Meteora Balanced pools causing invalid arbitrage opportunities
2. Magnitude calibration applying incorrect power-of-10 adjustments to reverse edges

## Problem Discovery

From production logs, we observed multiple types of extreme pricing errors:

### Issue 1: Meteora Balanced Pool Imbalance
```
price_a_per_b: 5,203,829 (5.2 million!)
price_a_per_b: 46,690,771,934 (46.6 BILLION!)
price_a_per_b: 124,986,867 (124.9 million!)
```

### Issue 2: Reverse Edge Magnitude Explosions
```
arb.opportunity: 989,604 bps profit (98,960%!)
  wETH→SOL: rate 2254.55 (expected ~22.56) - 100x error
  
arb.opportunity: 987,410,889,350 bps profit (insane!)
  SOL→ORE: rate 72,895,777 (expected ~0.73) - 99 million x error
  
arb.opportunity: 1,000,000 bps profit (100,000%!)
  JLP→SOL: rate 34144.08 (expected ~0.034) - 1000x error
```

## Root Cause Analysis

### Issue 1: Meteora Balanced Imbalance (FIXED)

Meteora Balanced pools with **extreme vault imbalances** were passing through:
- One vault had significant token amounts
- The other vault was nearly empty (< 0.01 tokens)
- This created mathematically correct but economically meaningless prices
- Existing rugpull detection only checked LP supply, not vault balance ratios

### Issue 2: Magnitude Calibration on Reverse Edges (FIXED)

**The Critical Bug:**

In `computePriceForward`, magnitude calibration compares:
- `price` parameter: "A per B" (e.g., 29.29 SOL per JLP)
- `ref` (calculated from USD): "A per B" = `USD(B) / USD(A)`

When `computePriceReverse` calls `computePriceForward` with **swapped mints**:
```typescript
computePriceForward(
  mintB,     // Now this becomes mintA in the recursive call
  mintA,     // Now this becomes mintB in the recursive call
  1/price,   // Inverted price
  ...
)
```

Inside the recursive call:
- `price` = "original_mintB per original_mintA" (e.g., 29.29 SOL per JLP)
- `pa` = USD(original_mintB) (e.g., $137 for SOL)
- `pb` = USD(original_mintA) (e.g., $4 for JLP)
- `ref` = `pb / pa` = $4 / $137 = 0.029 JLP per SOL

**The prices are INVERTED relative to each other!**

This causes magnitude calibration to find that `price × 10^-3` (0.029) is closer to `ref` (0.029) than the original `price` (29.29), leading to **1000x errors**.

## Fixes Applied

### Fix 1: Meteora Balanced Imbalance Detection

**File:** `backend/src/server/pools/meteoraBalanced.ts` (Lines 1229-1237)

```typescript
// CRITICAL: Check for extreme vault imbalance (e.g., 1M tokens vs 0.001 SOL)
// This indicates a drained/rugpulled pool even if LP supply exists
if (wholeA > 0 && wholeB > 0) {
  const ratio = wholeA > wholeB ? wholeA / wholeB : wholeB / wholeA;
  // If ratio > 100,000, one vault is essentially empty
  if (ratio > 100_000) {
    return true;  // Mark as rugpulled
  }
}
```

### Fix 2: Skip Magnitude Calibration for Reverse Edges

**File:** `backend/src/server/graph.pricing.ts` (Line 69)

```typescript
// CRITICAL FIX: Skip for reverse edges - they're derived from already-calibrated forward edges
// Running magnitude calibration on reverse edges causes the algorithm to compare inverted prices,
// leading to incorrect power-of-10 adjustments (e.g., 1000x errors)
if (typeof getUsd === 'function' && price && price > 0 && !isReverseEdge) {
  // ... magnitude calibration logic only runs for forward edges now
}
```

**Rationale:**
- Forward edges are calibrated using USD reference prices
- Reverse edges are mathematical inverses of forward edges (1/price)
- Running magnitude calibration on inverted prices causes the algorithm to compare inverted references
- Since forward edges are already calibrated, reverse edges don't need (and shouldn't receive) magnitude adjustment

## Expected Outcomes

### After Fix 1 (Meteora Balanced):
1. Many `meteora.balanced.rpc.rugpull_detected` warnings with high ratios
2. Elimination of extreme prices (> 100,000 or < 0.00001) from Meteora Balanced pools
3. No more invalid arbitrage opportunities from drained pools

### After Fix 2 (Magnitude Calibration):
1. **Elimination of 1000x reverse edge errors** (e.g., JLP→SOL: 34144 → 0.034)
2. **Elimination of 100x reverse edge errors** (e.g., wETH→SOL: 2254 → 22.56)
3. **Correct reverse edge pricing** with product of fwd × rev ≈ 1.0
4. No more invalid arbitrage opportunities from magnitude calibration errors

## Verification

Build successful ✅

### Expected Log Patterns After Deployment:

**Good:**
```
graph.edge.suspicious_reverse: SHOULD NOT APPEAR (or very rarely)
canonical.swap.price_check: deviation_pct should remain ~0.0000%
```

**Expected:**
```
meteora.balanced.rpc.rugpull_detected {
  ratio: "645518.89",
  vaultA: "41955.185834",
  vaultB: "0.008062",
  ...
}
```

### Validation Tests:

1. **JLP → SOL → JLP**: Should show ~0% profit (was 100,000%)
2. **wETH → SOL → wETH**: Should show ~0% profit (was 98,960%)
3. **SOL → ORE → SOL**: Should show ~0% profit (was 98,741,088,935%)

## Files Modified

1. `backend/src/server/pools/meteoraBalanced.ts`:
   - Lines 1212-1240: Added vault imbalance detection
   - Lines 1248-1266: Enhanced logging to include ratio

2. `backend/src/server/graph.pricing.ts`:
   - Line 69: Added `&& !isReverseEdge` condition to skip magnitude calibration
   - Line 81: Removed dynamic `MAX_APPLIED_DEV` (now always 100 for forward edges)
   - Lines 66-68: Enhanced comments explaining the fix

## Technical Details

### Magnitude Calibration Algorithm

For **forward edges only**:
1. Calculate reference price from USD: `ref = USD(target) / USD(source)`
2. Try multiplying price by 10^k for k ∈ [-8, 8]
3. Find k where deviation is minimized: `dev = max(price×10^k / ref, ref / (price×10^k))`
4. Apply adjustment if `dev ≤ 100` and improvement is significant

For **reverse edges**:
- Skip magnitude calibration entirely
- Use simple inversion: `reverse_price = 1 / forward_price`
- Apply decimal rescaling only (if global decimals provided)

### Mathematical Proof of Fix

Forward edge: `F = calibrate(p_forward)`
Reverse edge: `R = 1 / F` (no further calibration)
Product: `F × R = F × (1/F) = 1` ✓

Previously (broken):
Reverse edge: `R = calibrate(1 / p_forward, swapped_mints)`
- Compares inverted prices → applies wrong magnitude
Product: `F × R ≠ 1` (could be 1000, 0.001, etc.)

