# Complete Fix Summary: Invalid Rate Detection and Diagnosis

## Applied Changes

### 1. Magnitude Calibration Fix (`backend/src/server/graph.pricing.ts`)

**Problem**: Reverse edges were experiencing 10^8-10^10 magnitude explosions due to overly aggressive calibration.

**Fix**: Added `isReverseEdge` parameter and reduced calibration bounds:
- Forward edges: `MAX_APPLIED_DEV = 100` (allows up to 100x deviation)
- Reverse edges: `MAX_APPLIED_DEV = 3` (only allows up to 3x deviation)

**Code Changes**:
```typescript
const MAX_APPLIED_DEV = isReverseEdge ? 3 : 100;
```

### 2. Diagnostic Logging for Canonicalization (`backend/src/server/pools/canonical.ts`)

**Purpose**: Track price inversions when mints are swapped during canonicalization.

**Triggers**:
- Price deviation > 1% from expected inverse
- OR original or new price > 100,000

**Logs**:
```typescript
logger.info('canonical.swap.price_check', {
  dex, pool_id,
  orig_mint_a, orig_mint_b,
  new_mint_a, new_mint_b,
  orig_price, new_price,
  expected_inverse, deviation_pct,
  orig_decimals_a, orig_decimals_b,
  new_decimals_a, new_decimals_b,
})
```

**What to look for**:
- `deviation_pct` should be near 0% (exact price inversion)
- Decimals should be properly swapped
- Large prices (> 100k) indicate issues

### 3. Diagnostic Logging for Reverse Edges (`backend/src/server/graph.edges.ts`)

**Purpose**: Detect suspicious reverse edge calculations.

**Triggers**:
- Reverse price > 100,000
- OR forward × reverse product > 2
- OR forward × reverse product < 0.5

**Logs**:
```typescript
logger.warn('graph.edge.suspicious_reverse', {
  dex, pool_id,
  mint_a, mint_b,
  fwdRaw, fwd, rev,
  product,  // Should be ~1.0
  decimals_a, decimals_b,
  usd_a, usd_b,
})
```

**What to look for**:
- `product` should be close to 1.0
- If way off, indicates decimal mismatch or incorrect inversion

### 4. Meteora Reverse Edge Fix (`backend/src/server/graph.ts`)

**Purpose**: Apply stricter calibration to Meteora's manual reverse edge calculation.

**Code Change**:
```typescript
revMet = computePriceForward(
  p.mint_b, p.mint_a, revPriceRaw,
  decB_met, decA_met,
  gb_met, ga_met,
  getUsd, undefined,
  true, // CRITICAL: Mark as reverse edge
);
```

## User's Key Observation

**"The rates are likely linked to canonicalization, as often the pools we have incorrect rates for have had their mints swapped."**

This is a CRITICAL insight. The issue pattern suggests:
1. Original pool from DEX is correct
2. Canonicalization swaps mints and inverts price
3. Something goes wrong either during or after canonicalization
4. Results in 100x-1000x magnitude errors

## Examples of Invalid Rates

### Example 1: JLP->SOL
```
Rate: 34,148.66 JLP per SOL (pool marked as -rev)
Expected: ~70 JLP per SOL (if JLP=$2, SOL=$140)
Error: ~488x too high
```

### Example 2: SOL->Unknown Token
```
Rate: 225,374.82
Error: Magnitude explosion
```

### Example 3: USDC->JitoSOL (original issue)
```
Rate: 5,889,572,203 JitoSOL per USDC
Expected: ~0.0058 JitoSOL per USDC
Error: ~10^12 too high
```

## Hypothesis: Double-Inversion or Decimal Confusion

The fact that issues occur on swapped pools suggests:

**Scenario A: Double Inversion**
1. Canonicalization inverts price (correct)
2. Reverse edge calculation inverts again (incorrect double inversion)
3. Results in original price instead of reciprocal

**Scenario B: Decimal Confusion**
1. Canonicalization swaps mints and inverts price
2. But decimals aren't used correctly after swap
3. Price calculations use wrong decimal scale

**Scenario C: Magnitude Calibration on Swapped Pools**
1. Canonicalization inverts price correctly
2. But magnitude calibration then "corrects" it based on USD reference
3. Applies wrong power-of-10 multiplier because it doesn't know the price was already inverted

## Next Steps for Diagnosis

1. **Restart backend** with new logging
2. **Find a problematic pool** (e.g., JLP/SOL at 6a3m...rev with rate 34148)
3. **Trace through logs**:
   - Was it canonicalized? Check `canonical.swap.price_check`
   - What was orig_price vs new_price?
   - Are decimals properly swapped?
   - Does reverse edge show up in `graph.edge.suspicious_reverse`?
   - What is the fwd×rev product?

4. **Identify exact failure point**:
   - If deviation_pct is high: Canonicalization price inversion is wrong
   - If decimals aren't swapped: `swapPoolFields` has a bug
   - If product ≠ 1: Reverse edge calculation has wrong decimals
   - If product = 1 but price is still wrong: Magnitude calibration is still too aggressive

## Files Modified

1. `backend/src/server/graph.pricing.ts`
   - Added `isReverseEdge` parameter
   - Reduced MAX_APPLIED_DEV for reverse edges
   - Updated `computePriceReverse` to pass flag

2. `backend/src/server/pools/canonical.ts`
   - Added detailed logging for canonicalization swaps
   - Logs price inversions, decimal swaps, deviations

3. `backend/src/server/graph.edges.ts`
   - Added logger import
   - Added diagnostic logging for suspicious reverse edges

4. `backend/src/server/graph.ts`
   - Updated Meteora reverse edge to pass `isReverseEdge=true`

## Build Status

✅ **TypeScript compilation successful**

## Deployment Status

✅ **Ready to deploy** - All changes compile and are backward compatible

## Expected Outcome

With these changes deployed:
1. Invalid rates should be significantly reduced (magnitude calibration fix)
2. Logs will identify exactly where remaining issues originate
3. Can apply targeted fix based on diagnostic data

## Related Documentation

- `MAGNITUDE_CALIBRATION_BUG_ANALYSIS.md` - Initial root cause analysis
- `REVERSE_EDGE_MAGNITUDE_CALIBRATION_FIX.md` - Magnitude calibration fix details
- `DIAGNOSTIC_LOGGING_FOR_RATE_ISSUES.md` - Diagnostic logging guide
- `FIX_SUMMARY.md` - Initial fix summary (now superseded by this document)

