# Orca Price Canonicalization Fix

## Issue Summary

Orca CLMM pools were showing massive price mismatches (magnitude errors of -6, -5, -4, -2, -1) compared to other DEXes (Raydium, Meteora), causing pools to be filtered out as anomalies during cross-DEX validation.

### Example Errors from Logs

```
Pool: Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE (USDC/SOL)
- Orca price: 0.0071467 
- Other DEXes: ~140
- Deviation: 1,957,978% (magnitude error: -4)
- Root cause: orientation_or_formula_error

Pool: 6a3m2EgFFKfsFuQtP4LJJXPcAe3TQYXNyHUjjZpUxYgd  
- Orca price: 0.000029513
- Meteora price: 3.3095
- Deviation: 5,606,775% (magnitude error: -5)
- Root cause: decimal_swap_5_places

Pool: B5EwJVDuAauzUEEdwvbuXzbFFgEYnUqqS37TUM1c4PQA
- Orca price: 0.000014653
- Meteora price: 0.001465
- Deviation: 4,950% (magnitude error: -2)
- Root cause: decimal_swap_2_places
```

## Root Cause

The issue was a **timing problem** between canonicalization and price recalculation in `populateOrcaPoolStates()`:

### The Bug Flow

1. **Initial Normalization** (`normalizeOrcaHttp`, lines 329-364):
   - Calculates price from on-chain `sqrtPriceX64` using original mint order
   - Formula: `price_a_per_b = 10^(decB - decA) / (sqrtRatio)²`
   - Price is correct for the original mint orientation

2. **Canonicalization** (after normalization):
   - Applies `canonicalizePools()` which may swap `mint_a ↔ mint_b`
   - Also swaps `decimals_a ↔ decimals_b`
   - Inverts price: `price_a_per_b = 1 / price_a_per_b`
   - Price is now correct for the canonical orientation

3. **Pool State Population** (`populateOrcaPoolStates`, lines 904-967) - **BUG HERE**:
   - Reads **canonicalized** `mint_a` and `mint_b` from pool object
   - Resolves decimals for these **post-canonicalization** mints
   - But uses **original on-chain** `sqrtPriceX64` (which is orientation-specific!)
   - Recalculates price using Orca SDK: `PriceMath.sqrtPriceX64ToPrice(sqrt, decA, decB)`
   - **This overwrites the correct canonicalized price with a wrong one**

### Why This Produces Magnitude Errors

The on-chain `sqrtPriceX64` encodes `sqrt(B/A)` for the **original** token order in the pool account. It's fundamentally orientation-dependent.

When canonicalization swaps the mints:
- The price formula uses swapped decimals: `10^(decB' - decA')` where `decA' = origDecB` and `decB' = origDecA`
- But the `sqrtPriceX64` still represents the original orientation
- This creates a double-decimal-swap error: `10^(2 × decimal_diff)`

Example with SOL (9 decimals) and USDC (6 decimals):
- Original: `10^(6-9) = 10^(-3)` with correct sqrt → correct price
- After swap: `10^(9-6) = 10^(3)` with **original** sqrt → price off by `10^(3-(-3)) = 10^6` (magnitude error: -6)

## The Fix

**Preserve the canonicalized price instead of recalculating it.**

### Changes Made

In `populateOrcaPoolStates()` (lines 904-967):

```typescript
// BUGFIX: Don't recalculate price if it was already set during normalization + canonicalization
// The on-chain sqrtPriceX64 is orientation-specific and doesn't automatically adjust
// when mints are swapped by canonicalization. Recalculating with swapped mints but
// original sqrt produces wrong prices (magnitude errors of 10^(2*decimal_diff))
const hasExistingPrice = (pool as any).price_a_per_b && (pool as any).price_a_per_b > 0;

let derivedPrice: number | undefined;
if (!hasExistingPrice) {
  // Only calculate price if not already set (shouldn't happen in normal flow)
  // ... existing price calculation code ...
} else {
  // Preserve existing price from canonicalization
  derivedPrice = (pool as any).price_a_per_b;
}
```

### Why This Works

1. ✅ Price is calculated correctly during initial normalization with original mint order
2. ✅ Price is inverted correctly during canonicalization when mints swap
3. ✅ Price is preserved during pool state population (not recalculated with wrong orientation)
4. ✅ Other on-chain data (liquidity, tick, fee rate) is still updated from live state

### Diagnostic Logging

Added `price_source` to the log output to track which path was used:
- `'preserved_from_normalization'`: Price kept from initial calculation + canonicalization (normal path)
- `'recalculated_from_onchain'`: Price recalculated from on-chain data (fallback, shouldn't happen)

## Expected Impact

This fix should eliminate **all** Orca price anomalies with magnitude errors, including:
- ❌ `magnitude_error: -6` (Dz9mQ9Nz... pool: 159M% deviation)
- ❌ `magnitude_error: -5` (27G8MtK7... pool: 5.6M% deviation)  
- ❌ `magnitude_error: -4` (EPjFWdd5... pool: 1.9M% deviation)
- ❌ `magnitude_error: -2` (3NZ9JMVB... pool: 4,950% deviation)
- ❌ `magnitude_error: -1` (7vfCXTUX... pool: 2,004% deviation)

All 8 Orca pools that were previously excluded as anomalies should now have correct prices that match other DEXes within normal tolerance (<10% deviation).

## Testing Recommendations

1. **Restart the backend** and monitor logs for:
   - `orca.poolState.cached` entries with `price_source: 'preserved_from_normalization'` (should be all of them)
   - Reduced `pools.crossdex.price.anomaly.excluded` warnings for Orca
   - `pools.crossdex.price.anomalies.filtered` should show much lower `by_dex.orca` counts

2. **Compare prices** for previously problematic pools:
   - `Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE` (USDC/SOL)
   - `6a3m2EgFFKfsFuQtP4LJJXPcAe3TQYXNyHUjjZpUxYgd` (27G8.../SOL)
   - `B5EwJVDuAauzUEEdwvbuXzbFFgEYnUqqS37TUM1c4PQA` (3NZ9.../SOL)

3. **Graph integrity**: Verify that Orca pools are no longer being filtered out, increasing available arbitrage paths.

## Files Modified

- `backend/src/server/pools/orca.ts` (lines 904-982)

## Related Issues

This fix addresses the same class of bugs that were previously fixed for:
- Meteora DLMM pools (METEORA_DECIMAL_JOURNEY.md)
- Decimal orientation issues (DECIMAL_ORIENTATION_CRITICAL_FIX.md)
- Cross-DEX validation anomalies (COMPLETE_DECIMAL_FIX_SUMMARY.md)

## Date

November 16, 2025

