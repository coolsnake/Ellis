# Orca Price Decimal Consistency Fix

## Issue

Two Orca CLMM pools for the same SOL/USDC pair were showing different prices after canonicalization:

- **Pool 21gTfxAnhUDjJGZJDkTXctGFKT8TeiXx6pN1CEg9K1uW**: 
  - Source: SOL, Target: USDC
  - Price A/B: ~0.014 (implying 1 SOL ≈ 71 USDC) ❌ WRONG

- **Pool FpCMFDFGYotvufJ7HrFHsWEiiQCGbkLCtwHiDnh7o28Q**: 
  - Source: USDC, Target: SOL  
  - Price A/B: ~141 (implying 1 SOL ≈ 141 USDC) ✓ CORRECT

The issue was a **factor of ~2x difference** in the calculated prices.

## Root Cause

The Orca normalizer had an **inconsistency in the order of operations**:

1. **Original Code Flow**:
   ```
   Extract decimals (decA, decB) from API
   ↓
   Calculate priceRatio using original decimals  ← EARLY CALCULATION
   ↓
   Attempt to enrich/update decimals on-chain (cDecA, cDecB)
   ↓
   Calculate priceFromSqrt manually using updated decimals  ← LATER CALCULATION
   ↓
   Store pool with:
     - price_a_per_b: priceDerived (from updated decimals)
     - price_a_per_b_num/den: priceRatio (from ORIGINAL decimals)
   ```

2. **The Problem**:
   - If decimals were updated after the initial `priceRatio` calculation, the float price (`price_a_per_b`) would be calculated with **different decimals** than the ratio (`price_a_per_b_num/den`)
   - This caused **inconsistent price values** that would manifest differently depending on how the pool was oriented during canonicalization

## Solution

### 1. Moved priceRatio Calculation

```typescript
// BEFORE: priceRatio calculated early with potentially incomplete decimals
let priceRatio = sqrtRaw && Number.isFinite(decA) && Number.isFinite(decB)
  ? sqrtPriceX64ToPriceRatio(sqrtRaw, decA as number, decB as number)
  : null;

// ... decimal enrichment happens here ...

// AFTER: priceRatio calculated AFTER decimals are finalized
// (moved to line 341, after all decimal enrichment is complete)
let priceRatio = sqrtRaw && Number.isFinite(cDecA) && Number.isFinite(cDecB)
  ? sqrtPriceX64ToPriceRatio(sqrtRaw, cDecA as number, cDecB as number)
  : null;
```

### 2. Added Consistency Check

```typescript
// Compare manual calculation with precise priceRatio.float
if (priceRatio?.float && Number.isFinite(priceRatio.float) && priceRatio.float > 0) {
  const priceFromRatio = priceRatio.float;
  const priceDiff = Math.abs(priceFromSqrt - priceFromRatio);
  const priceRatio_pct = priceFromRatio > 0 ? (priceDiff / priceFromRatio) * 100 : 0;
  
  if (priceRatio_pct > 1) {  // More than 1% difference
    logger.warn('orca.price.calculation.mismatch', ...);
    // Prefer the precise bigint-based calculation
    priceFromSqrt = priceFromRatio;
  }
}
```

### 3. Added Diagnostic Logging

- **Decimal changes**: Log when decimals are updated during normalization
- **Price calculation**: Log sqrt_price_x64, ratio, scale, and computed price for tracked pools
- **Pre/Post canonicalization**: Log pool state before and after canonicalization for tracked pools
- **Mismatch detection**: Log when manual and precise price calculations differ significantly

## Impact

- **Consistency**: Both float and ratio-based prices now use the same decimals
- **Accuracy**: The precise bigint-based calculation is preferred when available
- **Debugging**: Comprehensive logging helps identify similar issues in the future
- **Correctness**: Both SOL/USDC pools should now show consistent prices after canonicalization

## Testing

To verify the fix:

1. Restart the backend to trigger pool normalization
2. Check logs for `orca.pre-canonicalization.tracked` and `orca.canonicalized.tracked` entries for the specific pools
3. Verify both pools show consistent SOL/USDC prices (~141 USDC per SOL)
4. Check for any `orca.price.calculation.mismatch` warnings

## Related DEX Normalizers

### Raydium ✓ OK
Raydium enriches decimals (lines 703-731 in `raydium.ts`) BEFORE calculating prices (line 753+), so it does not have this issue.

### Meteora ✓ OK  
Meteora enriches decimals upfront (lines 169-183 in `meteora.ts`) BEFORE the main processing loop, so it does not have this issue.

### Orca ❌ FIXED
Orca was calculating `priceRatio` BEFORE enriching decimals, leading to inconsistent price calculations. This has been fixed in this PR.

## Related Files

- `backend/src/server/pools/orca.ts` - Main fix location
- `backend/src/server/pools/precision.ts` - Price ratio calculation utilities
- `backend/src/server/pools/common.ts` - Canonicalization logic

