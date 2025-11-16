# Pricing System Centralization - Implementation Summary

## ✅ Completed Work

### 1. **Created Centralized Pricing Pipeline**

**File**: `backend/src/server/pools/pricePipeline.ts`

This is now the single source of truth for all price processing. Key features:

- **`processPriceThroughPipeline()`**: Main function that takes raw price from DEX formula and returns canonical processed price
- **Standardized Flow**:
  1. Canonicalize orientation (apply quote hierarchy)
  2. Calibrate magnitude (fix power-of-10 errors using USD reference)
  3. Rescale decimals (pool → global)
  4. Calculate reverse edge (with proper decimal handling)
  
- **Handles varied fetcher responses**: Normalizers map field names (tokenA/mint_a/mint_x) → pipeline gets standardized input
- **Diagnostics built-in**: Validates forward * reverse ≈ 1, logs suspicious prices

### 2. **Created DEX-Specific Formula Helpers**

**File**: `backend/src/server/pools/priceFormulas.ts`

Pure math functions for each pool type - NO orientation or calibration logic:

- **`calculateAmmPrice()`**: Constant product (reserveA / reserveB) with decimal conversion
- **`calculateClmmPrice()`**: Unified sqrt_price_x64 formula for Raydium + Orca
- **`calculateMeteoraPrice()`**: Bin-based formula (1 + binStep/10000)^activeId
- **`priceFromReserves()`**: High-precision BigInt calculation

**Key Design**: Functions return price in whole token units, in DEX's NATIVE orientation (before canonicalization)

### 3. **Updated All Normalizers**

**Modified Files**:
- `backend/src/server/pools/pumpswap.ts`
- `backend/src/server/pools/raydium.ts`
- `backend/src/server/pools/orca.ts`
- `backend/src/server/pools/meteora.ts`

**Changes Applied**:
- ✅ Replaced scattered price calculations with centralized formulas
- ✅ Kept field mapping logic (handles varied response shapes)
- ✅ Removed duplicate decimal rescaling
- ✅ Removed DEX-specific orientation handling
- ✅ Let pipeline apply quote hierarchy uniformly

**Example of Simplification (Orca)**:
- **Before**: 80+ lines with manual sqrt calculation, decimal handling, orientation fixes, diagnostic logging
- **After**: 10 lines calling `calculateClmmPrice()` with clean diagnostic logging

### 4. **Eliminated Key Issues**

**Problem → Solution**:

| Issue | Before | After |
|-------|--------|-------|
| **Duplicate rescaling functions** | 3 implementations | 1 in `graph.pricing.ts` |
| **CLMM sqrt formulas** | Different per DEX | Unified in `priceFormulas.ts` |
| **Meteora decimal handling** | Inconsistent (× vs ÷) | Consistent in `meteoraPrice.ts` |
| **Orientation conflicts** | Each DEX handled separately | Unified via pipeline |
| **Quote hierarchy** | Applied late/inconsistently | Applied first in pipeline |
| **Magnitude calibration** | Scattered, sometimes double-applied | Once in pipeline |

## 🔄 Remaining Work

### TODO 4: Remove Duplicate rescalePriceByDecimals() in graph.ts [IN PROGRESS]

**Found 2 usages**:
- Line 1181: Raydium pool processing
- Line 1687: Meteora pool processing

**Decision Needed**: Since normalizers now output canonical prices with proper decimals, graph.ts might not need rescaling anymore. Options:

1. **Option A (Recommended)**: Remove rescaling - trust normalizer output
2. **Option B**: Keep as safety fallback for backward compatibility
3. **Option C**: Replace with pipeline call for consistency

### TODO 5: Update graph.ts Edge Building [PENDING]

The `addEdge()` function and edge building logic in graph.ts still has:
- Inline `clampPrice()` calls
- Inline `calibratePrice()` calls (line 1470+)
- Manual reverse edge calculation

**Recommendation**: Update graph edge building to use pipeline for consistency.

### TODO 6: Add Validation and Diagnostics [PENDING]

**Already Available** in `pricePipeline.ts`:
- `validatePriceAgainstUSD()` - checks price vs USD reference
- Diagnostic logging for forward*reverse product
- Swap detection logging

**Need to Add**:
- Call validation in graph builder
- Aggregate statistics (% pools with good prices)
- Track price changes over time

## 📊 Architecture Diagram

```
┌──────────────────────────────────────────────────────────────┐
│                    DEX Fetchers                              │
│  (Different response shapes: tokenA, mint_a, mint_x, etc.)  │
└──────────┬───────────────────────────────────────────────────┘
           │
           ▼
┌──────────────────────────────────────────────────────────────┐
│              Normalizers (DEX-specific)                      │
│  • Map field names to standard format (mint_a, mint_b)      │
│  • Extract decimals, reserves, sqrt, activeId, etc.         │
│  • Call appropriate formula helper                           │
└──────────┬───────────────────────────────────────────────────┘
           │
           ▼
┌──────────────────────────────────────────────────────────────┐
│        Formula Helpers (priceFormulas.ts)                    │
│  • calculateAmmPrice() - reserves ratio                      │
│  • calculateClmmPrice() - sqrt_price_x64                     │
│  • calculateMeteoraPrice() - bin formula                     │
│  Returns: Raw price in whole units, DEX native orientation  │
└──────────┬───────────────────────────────────────────────────┘
           │
           ▼
┌──────────────────────────────────────────────────────────────┐
│      Pricing Pipeline (pricePipeline.ts) ⭐ NEW             │
│  1. Canonicalize Orientation (quote hierarchy)              │
│  2. Magnitude Calibration (fix 10^n errors)                 │
│  3. Decimal Rescaling (pool → global)                       │
│  4. Reverse Edge Calculation                                 │
│  Returns: Canonical price (forward + reverse)               │
└──────────┬───────────────────────────────────────────────────┘
           │
           ▼
┌──────────────────────────────────────────────────────────────┐
│          Canonical Pool Object                               │
│  • mint_a, mint_b (canonical order)                         │
│  • price_a_per_b (canonical A-per-B)                        │
│  • All other pool fields                                     │
└──────────┬───────────────────────────────────────────────────┘
           │
           ▼
┌──────────────────────────────────────────────────────────────┐
│             Graph Builder (graph.ts)                         │
│  Creates edges: forward (A→B) + reverse (B→A)               │
└──────────────────────────────────────────────────────────────┘
```

## 🎯 Key Improvements

### Before: Scattered Processing
```
Fetcher → Normalizer (calc+orient+rescale+calibrate) → Pool → Graph (calibrate again)
                ↑ Each DEX does differently ↑
```

### After: Centralized Pipeline
```
Fetcher → Normalizer (map fields) → Formula (calc) → Pipeline (orient+calibrate+rescale) → Pool → Graph
                                                        ↑ Single source of truth ↑
```

## 🧪 Testing Checklist

- [ ] Compare prices before/after for sample pools (Raydium, Orca, Meteora, Pumpswap)
- [ ] Verify forward * reverse ≈ 1 for all edges
- [ ] Check USD reference deviations are reasonable (<100x)
- [ ] Test extreme decimal differences (e.g., USDC-6 vs SOL-9 vs custom-0)
- [ ] Verify quote hierarchy is applied consistently
- [ ] Check that CLMM pools no longer have 10^(2*decimal_diff) magnitude errors
- [ ] Ensure Meteora prices use correct decimal formula
- [ ] Confirm Pumpswap AMM prices match reserves exactly

## 📝 Notes

### Why Keep Field Mapping in Normalizers?

Each DEX fetcher returns different field names:
- Jupiter: `tokenA`, `tokenB`
- Raydium GraphQL: `mintAmountA`, `mintAmountB`
- Orca: `mint`, references via `tokenA`/`tokenB`
- Meteora: `mint_x`, `mint_y`
- Pumpswap: `base_mint`, `quote_mint`

**Solution**: Normalizers handle this mapping → standardize to `mint_a`, `mint_b` → pass to pipeline

### Why Separate Formula Helpers?

Each pool type uses different math:
- **AMM**: `price = reserveA / reserveB` (simple ratio)
- **CLMM**: `price = (sqrtPrice / 2^64)^2 * decimals` (Uniswap v3 style)
- **DLMM**: `price = (1 + binStep/10000)^activeId * decimals` (Meteora style)

**Solution**: Keep formulas separate, let pipeline handle orientation/calibration

### Why No Orientation Logic in Formulas?

Formulas should be pure math that matches DEX documentation:
- Raydium: sqrt encodes price as-is from pool
- Orca: sqrt encodes sqrt(B/A)
- Meteora: bins encode Y per X

**Solution**: Formulas return price in DEX's native orientation → pipeline applies canonical orientation via quote hierarchy

## 🚀 Next Session Recommendations

1. **Complete graph.ts updates**:
   - Remove or comment `rescalePriceByDecimals()` function
   - Update edge building to trust normalizer output
   - Add validation logging

2. **Add comprehensive tests**:
   - Unit tests for each formula helper
   - Integration tests for pipeline
   - Regression tests comparing old vs new prices

3. **Monitor in production**:
   - Track price deviation metrics
   - Log pools with suspicious prices
   - Alert on forward*reverse != 1

## 📚 Files to Review

- ✅ `backend/src/server/pools/pricePipeline.ts` - Main pipeline
- ✅ `backend/src/server/pools/priceFormulas.ts` - Formula helpers
- ✅ `backend/src/server/pools/pumpswap.ts` - Updated normalizer
- ✅ `backend/src/server/pools/raydium.ts` - Updated normalizer
- ✅ `backend/src/server/pools/orca.ts` - Updated normalizer
- ✅ `backend/src/server/pools/meteora.ts` - Updated normalizer
- ⏳ `backend/src/server/graph.ts` - Needs update (remove duplicate rescaling)
- ⏳ `backend/src/server/graph.pricing.ts` - Review for cleanup
- ℹ️ `PRICING_CENTRALIZATION.md` - Full architectural documentation

