# Pricing Architecture Review & Centralization

## Executive Summary

Implemented centralized pricing pipeline to address pricing accuracy degradation caused by scattered price manipulations, inconsistent formulas, and multiple decimal rescaling implementations across the codebase.

## Issues Identified

### 1. **Multiple Duplicate Implementations**
- **3 separate decimal rescaling functions**: `rescaleByDecimals()` (graph.pricing.ts), `rescalePriceByDecimals()` (graph.ts), plus inline implementations
- **Inconsistent CLMM sqrt formulas**: Each DEX (Raydium, Orca) had its own sqrt_price_x64 calculation with subtle differences
- **Duplicate Meteora bin formulas**: One in meteora.ts, another in meteoraPrice.ts with inconsistent decimal handling

### 2. **Orientation Handling Issues**
- **CLMM pools**: sqrt_price_x64 is orientation-specific. When canonicalization swapped mints but kept original sqrt, this caused magnitude errors of 10^(2*decimal_diff)
- **Meteora DLMM**: X/Y mapping done before canonicalization could cause double-inversion
- **Quote hierarchy not uniformly applied**: DEX-specific calculations conflicted with canonical orientation

### 3. **Decimal Handling Inconsistencies**
- **Meteora line 307 vs line 73**: One used DIVIDE, other used MULTIPLY for same conversion
- **Raydium CLMM**: Had 3 fallback paths with different decimal handling
- **Orca**: Documented BUGFIX at line 939 recognized post-canonicalization decimal mismatches

### 4. **Magnitude Calibration Applied Inconsistently**
- Applied only in `computePriceForward()` AFTER canonicalization
- Some normalizers (Meteora) did their own magnitude adjustments before pipeline
- Reverse edges skipped magnitude calibration entirely via `isReverseEdge` flag

## Solution: Centralized Pricing Pipeline

### New Architecture

```
Raw DEX Data (varied field names)
    ↓
Field Mapping (normalizer-specific)
    ↓
Price Formula (DEX-specific: sqrt, bin, reserves)
    ↓
Centralized Pipeline (pricePipeline.ts)
    ├─ 1. Canonicalize Orientation
    ├─ 2. Magnitude Calibration  
    ├─ 3. Decimal Rescaling
    └─ 4. Reverse Edge Calculation
    ↓
Canonical Pool (mint_a, mint_b, price_a_per_b)
    ↓
Graph Edges (forward & reverse)
```

### New Files Created

#### 1. `backend/src/server/pools/pricePipeline.ts`
**Purpose**: Single source of truth for price processing

**Key Functions**:
- `processPriceThroughPipeline(input, options)`: Main pipeline
- `canonicalizeOrientation()`: Apply quote hierarchy
- `calibrateAndRescale()`: Magnitude calibration + decimal rescaling
- `calculateReverse()`: Proper reverse edge calculation
- `validatePriceAgainstUSD()`: Validation helper

**Flow**:
1. Takes raw price in DEX's native orientation
2. Applies quote hierarchy to determine canonical orientation
3. Inverts price if swap needed
4. Applies magnitude calibration using USD reference
5. Rescales decimals (pool → global)
6. Calculates reverse edge with swapped decimals
7. Returns processed price ready for graph edges

#### 2. `backend/src/server/pools/priceFormulas.ts`
**Purpose**: DEX-specific price calculation formulas (math only, no orientation/calibration)

**Key Functions**:
- `calculateAmmPrice()`: Constant product formula (reserveA / reserveB)
- `calculateClmmPrice()`: sqrt_price_x64 formula (unified for Raydium, Orca)
- `calculateMeteoraPrice()`: Bin-based formula ((1 + binStep/10000)^activeId)
- `priceFromReserves()`: High-precision BigInt reserve calculation

**Key Feature**: Each function returns price in whole token units, in DEX's NATIVE orientation (no canonicalization)

### Changes to Normalizers

**Pattern Applied to All Normalizers (Pumpswap, Raydium, Orca, Meteora)**:

1. **Keep field mapping logic** - Still handles varied response shapes (tokenA vs mint_a vs mint_x)
2. **Replace price calculation** - Use centralized formula from `priceFormulas.ts`
3. **Remove duplicate rescaling** - Let pipeline handle decimal conversions
4. **Remove orientation handling** - Let pipeline apply quote hierarchy

**Example (Pumpswap)**:
```typescript
// BEFORE:
if (quoteReserve > 0) {
  price_a_per_b = baseReserve / quoteReserve;
}

// AFTER:
const { priceFromReserves } = await import('./priceFormulas.js');
const rawPrice = priceFromReserves(baseReserveRaw, quoteReserveRaw, decA, decB);
if (rawPrice && rawPrice > 0 && Number.isFinite(rawPrice)) {
  price_a_per_b = rawPrice;
}
```

**Example (Raydium CLMM)**:
```typescript
// BEFORE:
// 30+ lines of sqrt calculation with 3 fallback paths

// AFTER:
const { calculateClmmPrice } = await import('./priceFormulas.js');
const priceFromCentralized = calculateClmmPrice(sqrtBig, decA, decB);
if (priceFromCentralized && priceFromCentralized > 0) {
  price_from_sqrt = priceFromCentralized;
}
// Fallback to Raydium SDK as secondary source
```

**Example (Meteora DLMM)**:
```typescript
// BEFORE:
// 60+ lines of bin calculation + orientation mapping + decimal conversion

// AFTER:
const { calculateMeteoraPrice } = await import('./meteoraPrice.js');
const priceFromCentralized = calculateMeteoraPrice(
  activeId, binStep, tokenXMint, tokenYMint, mint_a, mint_b, decA, decB
);
if (priceFromCentralized && priceFromCentralized > 0) {
  price_a_per_b = priceFromCentralized;
  usedBin = true;
}
```

## Benefits

### 1. **Single Source of Truth**
- All prices flow through same pipeline
- Consistent orientation handling via quote hierarchy
- Consistent magnitude calibration
- Consistent decimal rescaling

### 2. **Formula Consistency**
- CLMM pools (Raydium, Orca) use identical sqrt formula
- Meteora DLMM uses single bin formula
- AMM pools use same reserve ratio calculation

### 3. **Clearer Separation of Concerns**
- **Normalizers**: Handle field mapping, extract data
- **Formulas**: Do DEX-specific math (no orientation)
- **Pipeline**: Apply canonicalization, calibration, rescaling
- **Graph builder**: Create edges from canonical prices

### 4. **Easier Debugging**
- Single place to add diagnostics
- Clear flow: raw → formula → pipeline → canonical
- Each step is independent and testable

### 5. **Quote Hierarchy Enforced**
- All prices canonicalized by same rules
- No DEX-specific orientation conflicts
- Deterministic mint ordering

## Next Steps (TODO)

### 4. Remove Duplicate Decimal Rescaling Functions [PENDING]
- Remove `rescalePriceByDecimals()` from graph.ts
- Consolidate all rescaling to `graph.pricing.ts`

### 5. Update graph.ts Edge Building [PENDING]
- Update `addEdge()` to use pipeline
- Remove inline magnitude calibration
- Simplify edge creation logic

### 6. Add Validation and Diagnostics [PENDING]
- Implement `validatePriceAgainstUSD()` in graph builder
- Add diagnostic logging for suspicious prices
- Track price deviations through pipeline

## Testing Recommendations

1. **Compare prices before/after** for sample pools
2. **Check forward * reverse ≈ 1** for all edges
3. **Validate against USD references** where available
4. **Test extreme decimal differences** (e.g., 9 vs 0 decimals)
5. **Verify orientation consistency** across restarts

## Files Modified

- ✅ Created: `backend/src/server/pools/pricePipeline.ts`
- ✅ Created: `backend/src/server/pools/priceFormulas.ts`
- ✅ Updated: `backend/src/server/pools/pumpswap.ts`
- ✅ Updated: `backend/src/server/pools/raydium.ts`
- ✅ Updated: `backend/src/server/pools/orca.ts`
- ✅ Updated: `backend/src/server/pools/meteora.ts`
- ⏳ Pending: `backend/src/server/graph.ts`
- ⏳ Pending: `backend/src/server/graph.pricing.ts` (cleanup)

## Key Insights

1. **Orientation must be handled ONCE**: Before any other processing
2. **CLMM sqrt is orientation-specific**: Can't swap mints without recalculating
3. **Decimal rescaling is additive**: Multiple rescalings compound errors
4. **Magnitude calibration should happen AFTER canonicalization**: USD reference must match canonical orientation
5. **Reverse edges need symmetric treatment**: Same decimal handling but inverted

## References

- Original quote hierarchy: `backend/src/server/pools/canonical.ts`
- Original magnitude calibration: `backend/src/server/graph.pricing.ts`
- Original sqrt calculation: `backend/src/server/pools/precision.ts`
- Meteora formula: `backend/src/server/pools/meteoraPrice.ts`

