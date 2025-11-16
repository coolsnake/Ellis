# Meteora Balanced Pool Imbalance Detection Fix

**Date:** 2025-11-16  
**Issue:** Extreme prices in Meteora Balanced pools causing invalid arbitrage opportunities

## Problem Discovery

From production logs, we observed extreme prices in Meteora Balanced pools:

```
price_a_per_b: 5,203,829 (5.2 million!)
price_a_per_b: 46,690,771,934 (46.6 BILLION!)
price_a_per_b: 124,986,867 (124.9 million!)
```

### Log Analysis

1. **Canonicalization was working perfectly** (0.0000% deviation)
2. **The issue was the INPUT prices** being calculated from drained pools
3. **Pattern detected**: Pools with extreme vault imbalances:
   - VaultA: 41,955 tokens vs VaultB: 0.008 SOL → ratio: 5.2 million
   - VaultA: 329 million tokens vs VaultB: 0.007 SOL → ratio: 46.6 billion

## Root Cause

Meteora Balanced pools with **extreme vault imbalances** were passing through:
- One vault had significant token amounts
- The other vault was nearly empty (< 0.01 tokens)
- This created mathematically correct but economically meaningless prices
- Existing rugpull detection only checked LP supply, not vault balance ratios

## The Fix

Added **vault imbalance detection** to `backend/src/server/pools/meteoraBalanced.ts`:

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

### Detection Logic

Pools are marked as rugpulled/drained if:
1. **Existing checks**:
   - LP supply is zero or very low relative to vault balances
2. **NEW check**:
   - Vault ratio > 100,000 (one vault is 100,000x larger than the other)

### What Happens to Detected Pools

Marked pools have:
- `pool_liquidity_raw` set to 0.001 (excludes from routing)
- `is_rugpulled` flag set to true
- Warning logged with vault amounts and ratio

## Expected Outcome

After deployment, we should see:
1. **Many `meteora.balanced.rpc.rugpull_detected` warnings** with high ratios
2. **Elimination of extreme prices** (> 100,000 or < 0.00001)
3. **No more invalid arbitrage opportunities** from these drained pools

## Testing

Build successful ✅

Monitor logs for:
```
meteora.balanced.rpc.rugpull_detected {
  ratio: "645518.89",  // Example of caught imbalance
  vaultA: "41955.185834",
  vaultB: "0.008062",
  ...
}
```

## Related Issues

- Previously fixed: **Meteora DLMM decimal scaling bug** (dividing instead of multiplying)
- Previously fixed: **Magnitude calibration explosions** in reverse edges
- This fix: **Imbalanced pool filtering** to prevent drained pools from routing

## Files Modified

- `backend/src/server/pools/meteoraBalanced.ts`:
  - Lines 1229-1237: Added vault imbalance detection
  - Lines 1251-1253: Enhanced logging to include ratio

