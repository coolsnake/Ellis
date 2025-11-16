# Code Cleanup: Standardization of Edge Building Methods

**Date:** 2025-11-16  
**Goal:** Remove deprecated patterns and standardize all edge building to use consistent methods

## Summary of Changes

We've completed a comprehensive cleanup of the graph building code to eliminate deprecated patterns and ensure consistent behavior across all DEX integrations.

---

## ✅ **Completed Changes**

### 1. **Standardized Global Decimals Everywhere**

**Files Modified:**
- `backend/src/workers/graphDiff.types.ts` - Added `decimalsMap` to `GraphIncrementalRequest`
- `backend/src/server/graph.edges.ts` - Added `decimalsMap` to `EdgeBuildOptions` and `edgesFromPoolIncremental`
- `backend/src/server/graph.worker.compute.ts` - Extract and pass `decimalsMap`
- `backend/src/server/graph.ts` - Build and provide `decimalsMap` to worker
- `backend/src/server/__tests__/graph.worker.compute.test.ts` - Updated tests

**Impact:**
- ✅ Both main graph building and incremental updates now have access to global decimals
- ✅ `rescaleByDecimals()` can now properly rescale when pool decimals ≠ global decimals
- ✅ Consistent decimal handling across all code paths

---

### 2. **Removed Simple Inversion Pattern**

**Before (Deprecated):**
```typescript
const rev = fwd && fwd > 0 ? (1 / fwd) : undefined;
```

**After (Standardized):**
```typescript
const rev = computePriceReverse(
  p.mint_a,
  p.mint_b,
  fwd,
  price,
  poolDecA,
  poolDecB,
  globalDecA,
  globalDecB,
  getUsd,
);
```

**Affected Pools:**
- ✅ **Meteora Balanced AMM** (line 1398 → 1402-1412)
- ✅ **Pumpswap AMM** (line 1419 → 1440-1450)

**Why This Matters:**
- Simple inversion (`1/fwd`) doesn't handle decimal rescaling
- Can cause precision issues when pool decimals ≠ global decimals
- `computePriceReverse` applies proper:
  - Decimal rescaling with swapped decimals
  - Skips magnitude calibration (as per our recent fix)
  - Ensures `fwd × rev ≈ 1.0`

---

### 3. **Removed Deprecated Functions**

**Removed:**
```typescript
// DEPRECATED: Prices should already be canonicalized - no orientation needed
// Keeping as no-op for backwards compatibility
const orientWithUsdFallbacks = (mintA: string, mintB: string, px: number | undefined): number | undefined => px;
```

**Location:** `backend/src/server/graph.ts` line 711-713

**Why Removed:**
- Was a no-op function (just returned the input)
- Marked as deprecated
- No longer referenced anywhere in the codebase
- Prices are already canonicalized by normalizers

---

## 📊 **Current State: All DEXs Standardized**

| DEX | Pool Type | Reverse Method | Global Decimals | Status |
|-----|-----------|----------------|-----------------|--------|
| Raydium | AMM | `computePriceReverse` | ✅ Yes | ✅ Standardized |
| Raydium | CLMM | `computePriceReverse` | ✅ Yes | ✅ Standardized |
| Orca | AMM | `computePriceReverse` | ✅ Yes | ✅ Standardized |
| Orca | CLMM | `computePriceReverse` | ✅ Yes | ✅ Standardized |
| Meteora | Balanced | `computePriceReverse` | ✅ Yes | ✅ **FIXED** |
| Meteora | DLMM | `computePriceReverse` | ✅ Yes | ✅ Standardized |
| Pumpswap | AMM | `computePriceReverse` | ✅ Yes | ✅ **FIXED** |

---

## 🎯 **Benefits of Standardization**

### 1. **Consistency**
- All pools now use the exact same method for reverse edge calculation
- No special cases or different code paths per DEX
- Easier to reason about and debug

### 2. **Correctness**
- Proper decimal rescaling for all pools
- Magnitude calibration skipped for reverse edges (prevents the bugs we just fixed)
- Ensures `forward_price × reverse_price ≈ 1.0`

### 3. **Maintainability**
- Single source of truth for edge building logic
- Bug fixes in `computePriceReverse` benefit all DEXs
- Cleaner, more readable code

### 4. **Performance**
- Removed unnecessary code
- More efficient by avoiding duplicate logic
- Worker and main graph use same standardized approach

---

## 🔍 **Testing & Validation**

### Build Status
✅ **TypeScript compilation: PASSED**
✅ **No linter errors**
✅ **Tests updated and passing**

### Expected Behavior
After deployment, all edges should:
1. Have consistent `fwd × rev ≈ 1.0` (within 2% tolerance)
2. Properly handle decimal differences between pool and global decimals
3. Not trigger `graph.edge.suspicious_reverse` warnings
4. Show no magnitude calibration errors on reverse edges

---

## 📝 **Migration Notes**

### Breaking Changes
**None** - This is a refactor that maintains the same external behavior

### Behavioral Changes
**Improved:** Meteora Balanced and Pumpswap reverse edges now:
- Properly rescale decimals (if pool decimals ≠ global decimals)
- Have more accurate prices due to proper calculation method

### Rollback Plan
If issues arise, the changes can be rolled back by:
1. Reverting the `computePriceReverse` calls back to `1/fwd` for Meteora Balanced and Pumpswap
2. However, this would lose the decimal rescaling benefits

---

## 🚀 **Next Steps (Optional Future Work)**

While not required, future improvements could include:

1. **Refactor inline edge building to use `edgesFromPoolIncremental`**
   - Replace 500+ lines of inline edge building in `graph.ts`
   - Use the standardized `edgesFromPoolIncremental` function
   - Would further reduce code duplication

2. **Remove legacy orientation code**
   - Functions like `orientAPerB` could be simplified
   - Further cleanup of triangulation helpers

3. **Consolidate decimal resolution**
   - Single unified function for getting global decimals
   - Cache decimals map at module level to avoid repeated loading

---

## ✨ **Summary**

We've successfully:
- ✅ Standardized global decimals across all code paths
- ✅ Removed simple inversion pattern in favor of `computePriceReverse`
- ✅ Removed deprecated `orientWithUsdFallbacks` function
- ✅ Ensured all 7 DEX/pool-type combinations use consistent methods
- ✅ Verified build and tests pass

The codebase is now cleaner, more maintainable, and more correct!

---

**Files Modified:**
1. `backend/src/workers/graphDiff.types.ts` - Added decimalsMap
2. `backend/src/server/graph.edges.ts` - Standardized with global decimals
3. `backend/src/server/graph.worker.compute.ts` - Pass decimalsMap
4. `backend/src/server/graph.ts` - Load and provide decimalsMap, standardize reverse edges, remove deprecated code
5. `backend/src/server/__tests__/graph.worker.compute.test.ts` - Updated tests

**Build Status:** ✅ All successful

