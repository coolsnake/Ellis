# Option A Implementation: Pipeline in Normalizers - COMPLETE

## ✅ Completed: All Normalizers Updated

All normalizers now use `processPriceThroughPipeline()` to process prices ONCE at the source:

### 1. **Pumpswap** ✅
- Calculates reserves-based price with `priceFromReserves()`
- Processes through pipeline with USD lookup
- Handles mint swapping when canonicalization occurs
- Stores canonical `mint_a`, `mint_b`, `decimals_a`, `decimals_b`, `price_a_per_b`

### 2. **Raydium CLMM** ✅
- Calculates sqrt-based price with `calculateClmmPrice()`
- Simplified candidate selection (no more USD-based picking)
- Processes through pipeline
- Stores canonical fields with `finalMintA/B/DecA/B`

### 3. **Orca CLMM** ✅
- Calculates sqrt-based price with `calculateClmmPrice()` 
- Removed duplicate `calibrateMagnitude()` call
- Processes through pipeline
- Stores canonical fields with `finalMintA/B/DecA/B/Price`

### 4. **Meteora DLMM** ✅
- Calculates bin-based price with `calculateMeteoraPrice()`
- Removed complex candidate selection logic
- Removed duplicate `calibrateMagnitude()` call
- Processes through pipeline
- Stores canonical fields with `finalMintA/B/DecA/B`

## 🔄 Next Steps: Simplify Graph Building

Now that normalizers output fully-processed prices, we need to **remove duplicate processing** in graph.ts and graph.edges.ts.

### Changes Needed in `graph.ts`

Currently graph.ts RE-PROCESSES normalized prices:

```typescript
// ❌ CURRENT (lines 1173, 1321, 1470, etc)
let price = pool.price_a_per_b;
price = calibratePrice(pool.mint_a, pool.mint_b, price);  // DUPLICATE!
price = rescalePriceByDecimals(price, ...);                // DUPLICATE!
const rev = computePriceReverse(...);                      // REDUNDANT!

addEdge(pool.mint_a, pool.mint_b, ..., price, ...);
addEdge(pool.mint_b, pool.mint_a, ..., rev, ...);
```

**Should Be:**

```typescript
// ✅ SIMPLIFIED (trust normalized prices)
const price = pool.price_a_per_b;  // Already canonical, calibrated, rescaled
const reversePrice = 1 / price;     // Simple inversion

addEdge(pool.mint_a, pool.mint_b, ..., price, ...);
addEdge(pool.mint_b, pool.mint_a, ..., reversePrice, ...);
```

### Specific Sections to Update in `graph.ts`

1. **Raydium CLMM** (lines ~1171-1230)
   - Remove `calibratePrice()` call (line 1173)
   - Remove `rescalePriceByDecimals()` call (line 1181)
   - Remove `computePriceReverse()` call (lines 1206-1216)
   - Use simple `1 / price` for reverse

2. **Orca AMM** (lines ~1317-1366)
   - Remove `calibratePrice()` call (line 1321)
   - Remove `computePriceReverse()` call (lines 1350-1360)
   - Use simple `1 / price` for reverse

3. **Meteora Balanced** (lines ~1369-1415)
   - Remove `computePriceReverse()` call (lines 1399-1409)
   - Use simple `1 / price` for reverse

4. **Pumpswap** (lines ~1417-1453)
   - Remove `computePriceReverse()` call (lines 1437-1447)
   - Use simple `1 / price` for reverse

5. **Orca CLMM** (lines ~1454+)
   - Remove `calibratePrice()` call (line 1470)
   - Remove sqrt fallback logic (already handled in normalizer)
   - Use simple reverse calculation

### Changes Needed in `graph.edges.ts`

The `edgesFromPoolIncremental()` function is used by incremental updates and currently ALSO re-processes:

```typescript
// ❌ CURRENT (lines 73-96)
const fwd = computePriceForward(
  a, b, fRaw,
  poolDecA, poolDecB, globalDecA, globalDecB,
  getUsd, undefined
);  // DUPLICATE!

const rev = computePriceReverse(
  a, b, fwd, fRaw,
  poolDecA, poolDecB, globalDecA, globalDecB,
  getUsd
);  // REDUNDANT!
```

**Should Be:**

```typescript
// ✅ SIMPLIFIED (trust normalized prices)
const fwd = fRaw;  // Already processed by normalizer
const rev = fwd > 0 ? 1 / fwd : undefined;  // Simple inversion
```

## 🎯 Benefits of This Architecture

### Before (Problematic)
```
Normalizer → Calculate + Canonicalize
    ↓
Pool Cache (canonical price)
    ↓
graph.ts → Calibrate AGAIN + Rescale AGAIN + Compute Reverse
    ↓
graph.edges.ts → Calibrate AGAIN + Compute Reverse AGAIN
    ↓
Graph Edges (2-3x processed!)
```

### After (Clean)
```
Normalizer → Calculate + Pipeline (canonical + calibrated + rescaled)
    ↓
Pool Cache (fully processed price)
    ↓
graph.ts → Trust price + Simple reverse (1/price)
    ↓
graph.edges.ts → Trust price + Simple reverse (1/price)
    ↓
Graph Edges (processed exactly once!)
```

## 🧪 Testing Recommendations

1. **Compare prices before/after**:
   - Should be same or slightly different (better!)
   - No 10^n magnitude errors
   - Forward * reverse should equal 1.0

2. **Check logs for**:
   - `*.pipeline.failed` - should be rare
   - `*.pipeline.applied` - shows when significant changes occur
   - `graph.edge.suspicious_reverse` - should decrease

3. **Verify canonicalization**:
   - All pools should have consistent mint order
   - Quote tokens (USDC, SOL) should be on `mint_b` side
   - Prices should match USD references

4. **Check edge consistency**:
   - Forward price * reverse price ≈ 1.0
   - No edges with prices > 1e12 or < 1e-12
   - TVL calculations match

## 📊 Expected Improvements

1. **Accuracy**:
   - ✅ No double-calibration (was causing compounding errors)
   - ✅ No double-rescaling (was multiplying adjustments)
   - ✅ Consistent orientation across all DEXes

2. **Performance**:
   - ✅ Faster graph building (less processing)
   - ✅ Simpler code paths (easier to debug)

3. **Maintainability**:
   - ✅ Single source of truth (pricePipeline.ts)
   - ✅ Clear separation: formula → pipeline → cache → graph
   - ✅ Each transformation happens exactly once

## 🔍 What Still Needs Doing

**You're in ASK MODE** - to complete implementation:

1. Switch to **AGENT MODE**
2. Update `graph.ts` to remove duplicate processing
3. Update `graph.edges.ts` to trust normalized prices  
4. Test with real data
5. Monitor logs for any issues

The normalizers are complete and correct. The graph building just needs to be simplified to trust them!

## 🎓 Key Insight

**The problem was**: Prices were being processed 2-3 times through DIFFERENT code paths, causing:
- Magnitude calibration to run multiple times (compounding adjustments)
- Decimal rescaling to run multiple times (multiplying adjustments)
- Different results for full rebuild vs incremental updates

**The solution**: Process prices ONCE in normalizers, then trust those processed prices everywhere else.

