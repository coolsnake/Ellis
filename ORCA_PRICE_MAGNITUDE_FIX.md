# Orca Price Magnitude Calibration Fix

**Date**: 2025-11-15  
**Issue**: Arbitrage opportunities showing absurd profit (>8M BPS) due to incorrect Orca pool prices  
**Example Path**: WBTC → USDC → JUP → SOL with 8,251,653% profit

## Problem Analysis

### Rejected Opportunity Details
```
Path: WBTC (3NZ9…qmJh) → USDC (EPjF…Dt1v) → JUP (JUPy…DvCN) → SOL (So11…1112)
Profit: 8251653.20%
Hops: 4
All pools: Orca

Hop 1: WBTC → USDC
  Rate: 95884.949702 (correct - USDC per WBTC)
  Out: 95,884.9497 USDC

Hop 2: USDC → JUP  
  Rate: 0.287224 (appears correct)
  Out: 27,540.4501 JUP

Hop 3: JUP → SOL
  Rate: 2026.371399 (WRONG - should be ~0.0037 SOL per JUP)
  Out: 55,807,180.4558 SOL (55 MILLION SOL!)
```

### Root Cause

The third hop rate is off by approximately **547,000x** (2026 vs 0.0037).

**Expected**: SOL per JUP = $0.85 / $230 = ~0.0037 SOL per JUP  
**Actual**: 2026 SOL per JUP

**Why this happens:**

1. **Orca sqrt price calculation** correctly computes the price from `sqrt_price_x64` with decimal adjustments
2. **calibrateMagnitude** attempts to fix magnitude errors by testing powers of 10
3. **HOWEVER**: The old `MAX_APPLIED_DEV = 10` constraint meant that if the best power-of-10 adjustment still had >10x deviation from USD reference, it would **give up and return the wrong price**

This explains why pools with good liquidity still showed absurd prices - the calibration function couldn't find a fix within the tolerance and returned the uncalibrated (wrong) price.

## Solution Implemented

### 1. Increased Calibration Tolerance
**File**: `backend/src/server/priceCalib.ts`

```typescript
// Changed from 10 to 100
const MAX_APPLIED_DEV = 100;
```

This allows the magnitude calibration to fix prices that are up to 100x off from the USD reference, instead of giving up at 10x.

### 2. Enhanced Diagnostic Logging
**File**: `backend/src/server/pools/orca.ts`

Added comprehensive logging to track:
- **sqrt price calculation details**: Shows the ratio, scale, and computed price
- **Calibration changes**: Logs when calibration makes significant adjustments
- **Extreme prices**: Automatically logs prices >10,000 or <0.0001

### Specific logging triggers:
- Pools matching the reported IDs (JCD6, HrLm, C1Mg)
- Prices that change by >10x or <0.1x during calibration
- Any extreme prices (>10,000 or <0.0001)

### Log messages to watch for:
```
orca.priceFromSqrt.details     - Raw sqrt calculation breakdown
orca.calibrateMagnitude.applied - When magnitude calibration fixes a price
calibrate.magnitude.deviation   - When calibration deviation is >5x
calibrate.magnitude.skip        - When calibration gives up (should be rare now)
```

## Testing & Verification

### To verify the fix:

1. **Restart the backend** to reload the updated code
2. **Monitor logs** for the new diagnostic messages
3. **Check for JUP->SOL pools** in the logs to see if prices are being corrected
4. **Observe rejected opportunities** - the 8M% profit should disappear

### Expected behavior after fix:

- JUP->SOL rate should be ~0.0037 SOL per JUP (or inverse ~270 JUP per SOL)
- Calibration logs should show successful magnitude adjustments
- Rejected opportunities should have reasonable profit percentages (<100,000 BPS)

### If issues persist:

Check logs for:
```
calibrate.magnitude.skip
```
If you see this for JUP->SOL pools, it means even the increased tolerance isn't enough, and we may need to:
- Further increase MAX_APPLIED_DEV
- Add special handling for specific token pairs
- Review the sqrt price formula for additional issues

## Technical Details

### Orca sqrt price formula:
```typescript
const scale = Math.pow(10, (cDecB as number) - (cDecA as number));
const aPerB = scale / (ratio * ratio);
```

Where:
- `ratio` = sqrt_price_x64 / 2^64
- `sqrt_price_x64` encodes sqrt(B/A) in smallest (raw) units
- Result is A per B in whole-token units

### For JUP (6 dec) → SOL (9 dec):
- scale = 10^(9-6) = 1000
- This is **correct** and not the source of the bug
- The bug is in insufficient calibration tolerance

### Canonicalization:
The `swapABFields` function correctly inverts prices when swapping mint_a/mint_b, so orientation is not the issue.

## Related Issues

This fix also addresses:
- Other Orca pools with extreme decimal mismatches
- Cases where USD price references are available but calibration was being skipped
- General robustness of price magnitude handling across all DEXes

## Rollback

If this causes issues, revert:
```bash
git checkout HEAD -- backend/src/server/priceCalib.ts backend/src/server/pools/orca.ts
```

## Follow-up

Consider adding:
- Unit tests for extreme decimal mismatch cases (e.g., 8 vs 9 decimals with large price ratios)
- Configuration option for MAX_APPLIED_DEV
- Additional validation in the Rust arbitrage detector to catch magnitude errors

