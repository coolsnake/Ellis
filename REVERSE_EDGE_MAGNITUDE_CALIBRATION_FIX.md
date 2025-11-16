# Reverse Edge Magnitude Calibration Fix

## Problem

Invalid arbitrage rates appearing such as:
```
USDC->JitoSOL: 5889572203.145 JitoSOL per 1 USDC
```

Expected: ~0.0058 JitoSOL per 1 USDC (given JitoSOL ~$170, USDC $1)

The rate is off by approximately 10^9-10^10.

## Root Cause

The magnitude calibration algorithm in `computePriceForward()` was applying overly aggressive power-of-10 adjustments to reverse edges. 

**Key Issue**: 
- Forward edges are calibrated with `MAX_APPLIED_DEV = 100` (allows up to 100x deviation from USD reference)
- Reverse edges are calculated by inverting forward edges and calling `computePriceForward` again
- This second calibration can apply massive power-of-10 multipliers (10^8, 10^9, etc.) if they happen to reduce the deviation metric
- Since reverse edges are derived from already-calibrated forward edges, they shouldn't need large magnitude adjustments

## Solution Applied

### 1. Added `isReverseEdge` parameter to `computePriceForward()`

```typescript
export function computePriceForward(
  mintA: string,
  mintB: string,
  rawPrice: number | undefined,
  poolDecA?: number,
  poolDecB?: number,
  globalDecA?: number,
  globalDecB?: number,
  getUsd?: GetUsd,
  getEdgeRate?: GetEdgeRate,
  isReverseEdge?: boolean,  // NEW PARAMETER
): number | undefined
```

### 2. Stricter bounds for reverse edges

Changed magnitude calibration threshold:
```typescript
// CRITICAL FIX: Use much stricter bounds for reverse edges to prevent magnitude explosions
// Reverse edges are derived from forward edges that have already been calibrated,
// so they should only need minor adjustments at most
const MAX_APPLIED_DEV = isReverseEdge ? 3 : 100;
```

**Rationale**:
- Forward edges: `MAX_APPLIED_DEV = 100` (aggressive, to fix genuine decimal mismatches)
- Reverse edges: `MAX_APPLIED_DEV = 3` (conservative, only allow 3x deviation)

With a 3x limit:
- If forward edge is correct within 100x, reverse will be correct within 3x
- Prevents catastrophic 10^9 magnitude errors
- Still allows minor adjustments for floating-point precision issues

### 3. Updated `computePriceReverse()` to pass flag

```typescript
export function computePriceReverse(
  // ... parameters ...
): number | undefined {
  const revRaw = 1 / rawPrice;
  return computePriceForward(
    mintB,
    mintA,
    revRaw,
    poolDecB,
    poolDecA,
    globalDecB,
    globalDecA,
    getUsd,
    undefined,
    true,  // CRITICAL: Mark as reverse edge for stricter magnitude calibration
  );
}
```

## Impact

### Before Fix
- Reverse edges could have magnitude errors of 10^8 or more
- False positive arbitrage opportunities with "impossible" rates
- Example: USDC->JitoSOL showing 5.8 billion JitoSOL per 1 USDC

### After Fix
- Reverse edges limited to 3x maximum deviation from USD reference
- Should eliminate magnitude explosion errors
- Still allows minor floating-point precision corrections

## Testing Recommendations

1. **Monitor logs** for the specific path that was showing errors:
   ```
   J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn->So11111111111111111111111111111111111111112->EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
   ```

2. **Check rates** for common pairs:
   - USDC/JitoSOL should be ~170 USDC per JitoSOL, ~0.0058 JitoSOL per USDC
   - SOL/USDC should be ~135-145 USDC per SOL, ~0.007-0.0074 SOL per USDC
   - Any reverse edge rates should be reciprocal of forward edge rates

3. **Validate arbitrage opportunities**:
   - Profit_bps should be reasonable (< 10,000 bps = 100%)
   - Rate products should be close to 1.0 (slightly above due to fees)
   - No rates should exceed 10^6 in magnitude

4. **Edge cases to watch**:
   - Very low liquidity pools
   - Newly added tokens without USD price references
   - Extreme decimal differences (e.g., 18 decimals vs 0 decimals)

## Backwards Compatibility

✅ **Fully compatible**: The `isReverseEdge` parameter is optional and defaults to `false`, so all existing code continues to work without modification.

## Files Modified

- `backend/src/server/graph.pricing.ts`:
  - Added `isReverseEdge` parameter to `computePriceForward()`
  - Implemented stricter MAX_APPLIED_DEV (3 instead of 100) for reverse edges
  - Updated `computePriceReverse()` to pass `isReverseEdge=true`

## Related Documentation

- `MAGNITUDE_CALIBRATION_BUG_ANALYSIS.md`: Detailed analysis of the issue
- Analysis shows the complete data flow from pool fetching through arb-rs detection

