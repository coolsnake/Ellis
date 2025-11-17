# Price Pipeline Simplification - Complete Summary

**Date**: 2024
**Goal**: Remove all calibration, verification, and rescaling systems to rely entirely on pure mathematical price computations.

---

## **Changes Made**

### **1. Simplified Price Pipeline** (`backend/src/server/pools/pricePipeline.ts`)

**Removed**:
- ❌ `calibrateMagnitude()` function - no more power-of-10 corrections
- ❌ `validatePriceAgainstUSD()` function - no more USD validation
- ❌ `getUsd` parameter from `PriceProcessingOptions`
- ❌ `globalDecimals` parameter from `PriceProcessingOptions`
- ❌ `skipMagnitudeCalibration` parameter from `PriceProcessingOptions`
- ❌ All magnitude calibration logic (checking USD reference and trying different powers of 10)
- ❌ All decimal rescaling logic

**Kept**:
- ✅ Canonicalization (swap mints based on quote hierarchy)
- ✅ Price inversion (when swapping)
- ✅ Basic validation (non-zero, finite, positive)
- ✅ Diagnostic logging (optional)

**New Flow**:
```
Raw Price → Canonicalize Orientation → Return (Forward & Reverse)
```

**Old Flow** (removed):
```
Raw Price → Canonicalize → Calibrate Magnitude (USD) → Rescale Decimals → Return
```

---

### **2. Simplified CLMM Price Formula** (`backend/src/server/pools/priceFormulas.ts`)

**Removed**:
- ❌ USD-based auto-correction for inverted sqrtPriceX64
- ❌ `getUsd` parameter from `calculateClmmPrice()`
- ❌ Logic that flipped prices when they deviated >100x from USD reference

**Kept**:
- ✅ High-precision BigInt calculation via `sqrtPriceX64ToPriceRatio()`
- ✅ Decimal adjustment for whole token units
- ✅ Basic validation

**Impact**:
- Prices now come purely from the mathematical formula
- No external USD reference can alter the computed price
- If a DEX encodes sqrt prices differently, it will show in the raw price (not auto-corrected)

---

### **3. Simplified Graph Edge Building** (`backend/src/server/graph.edges.ts`)

**Removed**:
- ❌ `rescalePriceByDecimals()` function
- ❌ All decimal rescaling logic
- ❌ `decimalsMap` from `EdgeBuildOptions`
- ❌ Complex conditional logic for pipeline-processed vs non-pipeline pools
- ❌ Suspicious price diagnostics

**Kept**:
- ✅ Price clamping (1e-12 to 1e12 by default)
- ✅ Simple inversion for reverse edges
- ✅ Pipeline validation warning

**New Logic**:
```typescript
const fwd = clampPriceInc(fwdRaw, clampMin, clampMax);
const rev = fwd && fwd > 0 ? 1 / fwd : undefined;
```

**Old Logic** (removed):
```typescript
if (pipelineProcessed) {
  if (globalDecA !== poolDecA || globalDecB !== poolDecB) {
    const scalePow = (globalDecA - poolDecA) - (globalDecB - poolDecB);
    fwd = fRaw * Math.pow(10, scalePow);
  } else {
    fwd = fRaw;
  }
} else {
  fwd = rescalePriceByDecimals(...);
}
```

---

### **4. Updated All Normalizers**

**Files Modified**:
- `backend/src/server/pools/raydium.ts`
- `backend/src/server/pools/orca.ts`
- `backend/src/server/pools/meteora.ts`
- `backend/src/server/pools/pumpswap.ts`

**Changes**:
- ❌ Removed `getPriceByMint` import and calls
- ❌ Removed `getUsd` parameter from all `processPriceThroughPipeline()` calls
- ✅ Simplified to pure pipeline calls with no options

**Before**:
```typescript
const processed = processPriceThroughPipeline({
  mintA, mintB, decimalsA, decimalsB, ...
}, {
  getUsd: (m) => getPriceByMint(m)?.usdc,
});
```

**After**:
```typescript
const processed = processPriceThroughPipeline({
  mintA, mintB, decimalsA, decimalsB, ...
});
```

---

## **What We Gained**

### ✅ **Simplicity**
- Pure mathematical computation
- No external dependencies (USD prices)
- Easy to verify and debug
- Clear data flow

### ✅ **Transparency**
- Prices directly reflect on-chain data
- No hidden corrections or adjustments
- What you see is what's computed

### ✅ **Consistency**
- Same formula always produces same result
- No stale USD data causing issues
- Deterministic behavior

---

## **What We Lost**

### ⚠️ **Auto-Correction**
- No power-of-10 magnitude fixes
- No detection of inverted sqrt conventions
- No USD-based validation

### ⚠️ **Decimal Normalization**
- Pool decimals used as-is
- No global decimal map applied
- No rescaling for display

---

## **Philosophy**

**Old Approach**: "Fix bad data with smart corrections"
- Used USD prices as source of truth
- Applied magnitude calibration
- Rescaled decimals for consistency

**New Approach**: "Trust the math, fix the source"
- Pure mathematical computation
- Handle bad data at the source (better normalizers)
- No post-processing corrections

---

## **Next Steps**

If prices are incorrect, investigate and fix at these levels:
1. **DEX API** - Is the raw data correct?
2. **Normalizer Field Mapping** - Are we reading the right fields?
3. **Price Formula** - Is our math correct for this pool type?
4. **Decimal Handling** - Are we using the right decimals?

**DO NOT** add back corrections. Fix the root cause instead.

---

## **Testing**

All changes compile with no linter errors:
- ✅ `backend/src/server/pools/pricePipeline.ts`
- ✅ `backend/src/server/pools/priceFormulas.ts`
- ✅ `backend/src/server/graph.edges.ts`
- ✅ `backend/src/server/pools/raydium.ts`
- ✅ `backend/src/server/pools/orca.ts`
- ✅ `backend/src/server/pools/meteora.ts`
- ✅ `backend/src/server/pools/pumpswap.ts`

---

## **Code Size Reduction**

**Lines Removed**: ~150+ lines of complex correction logic
**Lines Added**: ~20 lines of simplified logic
**Net Reduction**: ~130 lines

**Functions Removed**: 2
- `calibrateMagnitude()`
- `validatePriceAgainstUSD()`

**Parameters Removed**: 3
- `getUsd` from pipeline options
- `globalDecimals` from pipeline options
- `decimalsMap` from edge build options

---

## **Summary**

We've successfully stripped the price system down to its pure mathematical core. All prices now flow through a simple, transparent pipeline:

1. **Calculate** price from DEX-specific formula (reserves, sqrt, bins)
2. **Canonicalize** orientation (apply quote hierarchy)
3. **Return** forward and reverse prices

No calibration. No rescaling. No USD corrections. Just pure math.

If prices are wrong, we fix the formula or the input data - not the output.

