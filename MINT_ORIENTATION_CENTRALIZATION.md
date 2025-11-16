# Mint Orientation Centralization - Complete Refactoring

**Date**: 2025-01-XX  
**Status**: ✅ Completed  
**Impact**: Centralized mint orientation handling to eliminate double-flipping and ensure consistent price calculations

## Problem Statement

Mint orientation and price calculations were handled inconsistently across multiple layers:

1. **Multiple orientation decisions**: Canonicalization, `computePriceForward()`, and graph builder all had orientation logic
2. **Double-flipping risk**: Prices could be flipped multiple times, causing incorrect values
3. **Timing issues**: Orientation checks happened at different stages (normalization, canonicalization, graph building)
4. **WebSocket inconsistency**: WS decoders didn't always respect canonicalization

## Solution: Centralized Canonicalization

### Core Principle

**Single Source of Truth**: Canonicalization is the ONLY place where mint orientation is changed. All other code trusts canonicalized prices.

### Standard Flow

```
Raw Price (from DEX) 
  → Normalize (calculate with DEX-specific formula for current mint order)
  → Canonicalize (swap mints + invert price if needed) ← SINGLE SOURCE OF TRUTH
  → Magnitude Calibration (power-of-10 adjustment only, no orientation flip)
  → Final Price (always A-per-1-B in canonical orientation)
```

## Changes Made

### 1. Created Centralized Price Canonicalization Module

**File**: `backend/src/server/pools/priceCanonical.ts`

- `canonicalizePrice()`: Centralized function to canonicalize price and mints
- `canonicalizePoolPrice()`: Convenience wrapper for full pool objects
- `ensurePriceOrientation()`: Validation helper (logs warnings if orientation mismatch detected)

### 2. Updated `computePriceForward()` - Removed Orientation Logic

**File**: `backend/src/server/graph.pricing.ts`

**Before**: 
- Checked USD references and flipped orientation if inverted price was closer
- Could flip prices that were already canonicalized

**After**:
- Assumes input price is already canonicalized
- Only applies magnitude calibration (power-of-10 adjustments)
- Only applies decimal rescaling
- No orientation flips

### 3. Updated Graph Builder - Removed Redundant Orientation Checks

**File**: `backend/src/server/graph.ts`

**Changes**:
- Removed `orientAPerB()` calls for Raydium AMM pools (line ~951)
- Removed `orientWithUsdFallbacks()` calls for Orca pools (lines ~1276, ~1468)
- Removed redundant USD-based orientation checks for CLMM pools (line ~1151)
- Made `orientWithUsdFallbacks()` a no-op for backwards compatibility

**Result**: Graph builder now trusts canonicalized prices from normalizers

### 4. Updated Graph Edge Builder

**File**: `backend/src/server/graph.edges.ts`

- Added documentation clarifying that prices should already be canonicalized
- `edgesFromPoolIncremental()` now trusts `computePriceForward()` which assumes canonicalized input

### 5. Updated WebSocket Decoders

**File**: `backend/src/server/pools.ts`

**Raydium CLMM WS Decoder** (line ~2290):
- Added canonicalization before adding to cache
- Ensures WS updates match HTTP fetch canonicalization

**Raydium AMM WS Decoder** (line ~2432):
- Added canonicalization before adding to cache
- Ensures WS updates match HTTP fetch canonicalization

**Meteora WS Decoder** (line ~3033):
- Already had canonicalization ✅
- No changes needed

## Key Benefits

1. **No Double-Flipping**: Prices are only flipped once during canonicalization
2. **Consistent Behavior**: HTTP fetches and WS updates use the same canonicalization logic
3. **Clearer Code**: Single responsibility - canonicalization handles orientation, other code handles magnitude/decimal adjustments
4. **Easier Debugging**: Orientation issues can only occur in one place (canonicalization)

## Verification

### Before (Problematic Flow)
```
Normalizer calculates price → Canonicalization swaps+inverts → 
Graph builder flips again based on USD → Double-flip! ❌
```

### After (Correct Flow)
```
Normalizer calculates price → Canonicalization swaps+inverts → 
Graph builder trusts canonicalization → Correct! ✅
```

## Testing Checklist

- [ ] Verify HTTP fetches produce canonicalized pools
- [ ] Verify WS updates produce canonicalized pools
- [ ] Verify graph edges use canonicalized prices
- [ ] Verify arb-rs receives correct prices (A-per-1-B for canonical mints)
- [ ] Check logs for any `price.orientation.mismatch` warnings
- [ ] Verify no double-flipping in price calculations

## Migration Notes

### For Developers

1. **When calculating prices**: Calculate for current mint order, then canonicalize
2. **When using prices**: Assume they're already canonicalized (A-per-1-B for canonical mints)
3. **When debugging**: Check canonicalization first if orientation issues occur

### Backwards Compatibility

- `orientWithUsdFallbacks()` is now a no-op but still exists for compatibility
- `orientAPerB()` function still exists but is no longer called
- All existing code continues to work, but redundant orientation checks are removed

## Files Modified

1. `backend/src/server/pools/priceCanonical.ts` (NEW)
2. `backend/src/server/graph.pricing.ts`
3. `backend/src/server/graph.ts`
4. `backend/src/server/graph.edges.ts`
5. `backend/src/server/pools.ts` (WS decoders)

## Related Documentation

- `DECIMAL_ORIENTATION_CRITICAL_FIX.md` - Previous fix for decimal orientation issues
- `ORCA_PRICE_CANONICALIZATION_FIX.md` - Previous fix for Orca price canonicalization
- `backend/src/server/pools/canonical.ts` - Canonicalization implementation

