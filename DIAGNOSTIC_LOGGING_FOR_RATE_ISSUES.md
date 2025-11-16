# Diagnostic Logging for Rate Issues

## Problem

Seeing invalid arbitrage rates, especially on pools where mints have been swapped during canonicalization:

```
JLP->SOL: 34,148.66 JLP per SOL (should be ~70)
SOL->USDC: 137.85 USDC per SOL (correct)
Various rates: 225374, 5889572203, etc. (wildly incorrect)
```

## Hypothesis

The issue appears when:
1. Pools have their mints swapped during canonicalization
2. Reverse edges are calculated from these canonicalized pools
3. Decimal handling or price semantics get confused in the process

## Diagnostic Logging Added

### 1. Canonicalization Price Tracking (`backend/src/server/pools/canonical.ts`)

Logs when pools are canonicalized and mints are swapped:

```typescript
logger.info('canonical.swap.price_check', {
  dex: 'Orca',
  pool_id: 'HktfL...',
  orig_mint_a: 'So111...',  // Original mints before swap
  orig_mint_b: '27G8M...',  // 
  new_mint_a: '27G8M...',   // After swap (flipped)
  new_mint_b: 'So111...',   //
  orig_price: 0.029,        // Original price_a_per_b
  new_price: 34.48,         // New price (should be 1/orig_price)
  expected_inverse: 34.48,  // Calculated 1/orig_price
  deviation_pct: '0.0000',  // How much new differs from expected
  orig_decimals_a: 6,       // Decimals before swap
  orig_decimals_b: 9,       //
  new_decimals_a: 9,        // Decimals after swap (should be flipped)
  new_decimals_b: 6,        //
})
```

**Triggers**: 
- Price deviation > 1% from expected inverse
- OR original or new price > 100,000

**What to look for**:
- `deviation_pct` should be near 0% (price inversion is exact)
- Decimals should be properly swapped (orig_a → new_b, orig_b → new_a)
- Large prices (> 100k) indicate potential issues

### 2. Reverse Edge Calculation Tracking (`backend/src/server/graph.edges.ts`)

Logs when reverse edges have suspicious characteristics:

```typescript
logger.warn('graph.edge.suspicious_reverse', {
  dex: 'Orca',
  pool_id: 'HktfL...',
  mint_a: '27G8M...',       // Canonical mint_a
  mint_b: 'So111...',       // Canonical mint_b
  fwdRaw: 0.029,            // Raw forward price from pool
  fwd: 0.029,               // Forward price after magnitude calibration
  rev: 34.48,               // Reverse price calculated
  product: '1.000',         // fwd * rev (should be ~1.0)
  decimals_a: 6,            // Decimals for mint_a
  decimals_b: 9,            // Decimals for mint_b
  usd_a: 0.03,              // USD price of mint_a
  usd_b: 140.0,             // USD price of mint_b
})
```

**Triggers**:
- Reverse price > 100,000
- OR forward × reverse product > 2
- OR forward × reverse product < 0.5

**What to look for**:
- `product` should be close to 1.0 (ideally 0.99-1.01)
- If product is way off, indicates decimal mismatch or incorrect inversion
- Compare `usd_a`/`usd_b` ratio to `fwd` to verify price makes sense

## How to Use This Logging

### Step 1: Restart the backend
The logging is now in place. Restart to begin capturing data.

### Step 2: Monitor for suspicious pools
Watch for logs with:
- `canonical.swap.price_check` where `deviation_pct` > 1%
- `graph.edge.suspicious_reverse` for any pools

### Step 3: Trace specific problematic pools
For the pools mentioned in your logs:
- `HktfL7iwGKT5QHjywQkcDnZXScoh811k7akrMZJkCcEF` (JLP/SOL with rate 225374)
- `6a3m...` (JLP/SOL with rate 34148)

Find them in the logs and check:
1. What were the original mints before canonicalization?
2. Was the price inverted correctly during canonicalization?
3. Are decimals properly swapped?
4. What happens during reverse edge calculation?

### Step 4: Identify the pattern
Look for common characteristics:
- Specific DEX (Orca, Meteora, etc.)?
- Specific decimal combinations (e.g., 6→9, 9→6)?
- Always on swapped pools vs non-swapped pools?

## Expected Findings

Based on the pattern (issues on swapped pools), likely scenarios:

### Scenario A: Decimals Not Properly Swapped
- Canonicalization swaps mints but forgets to swap decimals
- Results in using wrong decimals for price calculations
- Would show in `canonical.swap.price_check` logs

### Scenario B: Magnitude Calibration Still Too Aggressive
- Even with MAX_APPLIED_DEV=3 for reverse edges, still finding bad power-of-10 adjustments
- Would show in `graph.edge.suspicious_reverse` with product ≠ 1
- May need to disable magnitude calibration entirely for reverse edges

### Scenario C: Price Semantic Confusion
- The meaning of `price_a_per_b` gets confused somewhere
- After swap, code treats it as if mints weren't swapped
- Would show as inconsistent prices across the pipeline

## Files Modified

- `backend/src/server/pools/canonical.ts` - Added canonicalization diagnostics
- `backend/src/server/graph.edges.ts` - Added reverse edge diagnostics

## Next Steps

1. ✅ **Deploy and monitor** - Let the system run and collect diagnostic data
2. **Analyze logs** - Look for patterns in the problematic pools
3. **Identify root cause** - Based on log data, pinpoint exact failure point
4. **Apply targeted fix** - Once root cause is clear, fix specifically that issue

## Related Files

- `MAGNITUDE_CALIBRATION_BUG_ANALYSIS.md` - Initial analysis of magnitude issues
- `REVERSE_EDGE_MAGNITUDE_CALIBRATION_FIX.md` - Applied fix (may not be sufficient)
- `FIX_SUMMARY.md` - Summary of magnitude calibration fix

