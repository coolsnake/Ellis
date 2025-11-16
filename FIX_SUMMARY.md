# Fix Summary: Magnitude Calibration Bug for Reverse Edges

## Issue
Seeing invalid arbitrage rates with magnitudes 10^9-10^10 times larger than expected:
```
USDC->JitoSOL: 5889572203.145 JitoSOL per 1 USDC (expected ~0.0058)
```

## Root Cause
The magnitude calibration algorithm in `computePriceForward()` was applying overly aggressive power-of-10 adjustments (up to 100x deviation) to reverse edges. Since reverse edges are derived from already-calibrated forward edges, they should not need large magnitude adjustments.

## Fix Applied

### Changes Made

1. **`backend/src/server/graph.pricing.ts`**:
   - Added optional `isReverseEdge` parameter to `computePriceForward()`
   - Reduced `MAX_APPLIED_DEV` from 100 to 3 for reverse edges
   - Updated `computePriceReverse()` to pass `isReverseEdge=true`

2. **`backend/src/server/graph.ts`**:
   - Updated Meteora reverse edge calculation to pass `isReverseEdge=true`

### Key Changes

```typescript
// In computePriceForward():
const MAX_APPLIED_DEV = isReverseEdge ? 3 : 100;

// In computePriceReverse():
return computePriceForward(
  mintB, mintA, revRaw,
  poolDecB, poolDecA,
  globalDecB, globalDecA,
  getUsd, undefined,
  true  // Mark as reverse edge
);
```

## Impact

### Before
- Reverse edges could have 10^8-10^10 magnitude errors
- False positive arbitrage opportunities
- Example: 5.8 billion JitoSOL per USDC (should be 0.0058)

### After
- Reverse edges limited to 3x maximum deviation
- Eliminates magnitude explosion errors
- Still allows minor floating-point corrections

## Backwards Compatibility
✅ Fully compatible - new parameter is optional (defaults to `false`)

## Testing Recommendations

1. Monitor rates for common pairs:
   - USDC/JitoSOL: ~170 USDC per JitoSOL, ~0.0058 JitoSOL per USDC
   - SOL/USDC: ~135-145 USDC per SOL, ~0.007 SOL per USDC

2. Validate reverse edges are reciprocal of forward edges

3. Check arbitrage opportunities:
   - Profit_bps should be reasonable (< 10,000 bps)
   - Rate products should be close to 1.0
   - No rates should exceed 10^6 in magnitude

## Documentation
- `MAGNITUDE_CALIBRATION_BUG_ANALYSIS.md` - Detailed root cause analysis
- `REVERSE_EDGE_MAGNITUDE_CALIBRATION_FIX.md` - Complete fix documentation

## Files Modified
- `backend/src/server/graph.pricing.ts` (2 functions updated)
- `backend/src/server/graph.ts` (1 call site updated)

## Status
✅ **Fix Applied** - Ready for testing

