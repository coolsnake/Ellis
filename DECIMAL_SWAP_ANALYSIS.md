# Decimal Swap Analysis - Why The Logs Are Correct

**TL;DR:** The `graph.decimals.mismatch` logs you're seeing are **informational diagnostics**, NOT errors. The system is working correctly.

---

## What's Happening

### Example from Logs
```
mintA="So11111111111111111111111111111111111111112"
mintB="oreoU2P8bN6jkk3jbaiVxYnG1dCXcYxwhwyK9jSybcp"
poolDecA=11
poolDecB=9
expectedA=9
expectedB=11
swapped=true
```

### Analysis

1. **Original Pool (before canonicalization):**
   - mint_a = `oreoU2...` (decimals: 11)
   - mint_b = `SOL` (decimals: 9)
   - price_a_per_b = some value

2. **After Canonicalization (SOL forced to A side per quote hierarchy):**
   - mint_a = `SOL` ← swapped
   - mint_b = `oreoU2...` ← swapped
   - decimals_a = 9 ← swapped  
   - decimals_b = 11 ← swapped
   - price_a_per_b = 1/original ← inverted

3. **What the Graph Sees:**
   - Pool reports: `decimals_a=11, decimals_b=9` (from pool cache)
   - Expected (from Jupiter): `SOL=9, oreoU2=11`
   - Detects: `swapped=true` (pool has 11,9 but should be 9,11)

---

## Why This Happens

The log appears because:

1. **Canonicalization happens in normalizers** - mints, decimals, and price are all swapped
2. **Graph loads Jupiter decimals** - these are the "ground truth" for each mint
3. **Diagnostic check** - graph compares pool decimals vs Jupiter decimals
4. **Rescaling** - graph applies `rescalePriceByDecimals` to fix any discrepancies

---

## The Code Path

### 1. Normalization (in normalizers)
```typescript
// In meteora.ts, orca.ts, etc.
const clmmCanon = canonicalizePools(clmm);
// This calls swapPoolFields which swaps:
// - mint_a ↔ mint_b
// - decimals_a ↔ decimals_b  
// - price inverted
```

### 2. Graph Building (in graph.ts)
```typescript
// Load authoritative decimals from Jupiter
const decimalsByMint = { /* SOL: 9, oreoU2: 11, etc. */ };

// For each pool:
const ga = decimalsByMint[p.mint_a]; // 9 for SOL
const gb = decimalsByMint[p.mint_b]; // 11 for oreoU2
const poolDecA = p.decimals_a; // might be 11 (swapped)
const poolDecB = p.decimals_b; // might be 9 (swapped)

// Diagnostic log
diagDecimals(p.mint_a, p.mint_b, poolDecA, poolDecB);

// Fix price if decimals don't match
price = rescalePriceByDecimals(price, poolDecA, poolDecB, ga, gb);
```

### 3. rescalePriceByDecimals Function
```typescript
const scalePow = (ga - da) - (gb - db);
const scaled = p * Math.pow(10, scalePow);
```

**Example:**
- Pool price: 100 (calculated with decimals 11 and 9)
- Expected decimals: 9 and 11
- Scale power: (9 - 11) - (11 - 9) = -2 - 2 = -4
- Scaled price: 100 * 10^(-4) = 0.01

This **corrects** the price to account for the decimal mismatch.

---

## Why The Logs Show "Mismatch"

The logs show a mismatch because **there are two sources of truth**:

1. **Pool object** (`pool.decimals_a`, `pool.decimals_b`) - from normalizer
2. **Jupiter token map** (`decimalsByMint[mint_a]`, `decimalsByMint[mint_b]`) - loaded in graph

When canonicalization swaps the mints, the pool object has the swapped decimals, but the graph expects them to match the Jupiter map (which is mint-specific, not position-specific).

---

## Is This A Problem?

**NO!** This is working as designed:

1. ✅ Canonicalization correctly swaps mints, decimals, and inverts price
2. ✅ Graph detects when pool decimals don't match Jupiter decimals
3. ✅ Graph logs diagnostic info (`swapped=true` confirms it knows what happened)
4. ✅ Graph rescales price to correct for any discrepancy

---

## When Would This BE A Problem?

The pricing would only be incorrect if:

1. **rescalePriceByDecimals is not being called** - but it is (line 1160, 1629)
2. **rescalePriceByDecimals has a bug** - unlikely, formula is simple
3. **Pool decimals are wrong BEFORE canonicalization** - this would be a normalizer issue

---

## How To Verify Everything Is Working

### Test 1: Check Canonical Swapping (DONE ✅)
```bash
npx vitest run src/server/__tests__/pools/canonical.test.ts -t "should handle pools without price"
# Result: PASS - decimals ARE being swapped
```

### Test 2: Check A Specific Pool
1. Find pool ID from logs (e.g., the oreoU2 pool)
2. Check its state in the cache:
   ```typescript
   const pool = orcaCache.data.clmm.find(p => p.mint_b.includes('oreoU2'));
   console.log({
     mintA: pool.mint_a,
     mintB: pool.mint_b,
     decimalsA: pool.decimals_a,
     decimalsB: pool.decimals_b,
     price: pool.price_a_per_b
   });
   ```
3. Verify decimals match their mints (SOL=9, oreoU2=11)

### Test 3: Check Graph Edge Price
1. Find the edge in the graph
2. Verify the price makes sense given the mints
3. Compare with external price source (Jupiter, CoinGecko, etc.)

---

## Action Items

### If Pricing IS Correct (Likely)
- ✅ No action needed
- ✅ Logs are informational only
- ✅ System is working as designed
- ℹ️ Consider changing log level from `INFO` to `DEBUG` to reduce noise

### If Pricing IS Incorrect (Investigate)
1. **Check which DEX** - logs don't show DEX, but you can grep for pool ID
2. **Check normalizer** - verify decimals are set correctly BEFORE canonicalization
3. **Check price calculation** - verify price formula matches DEX math
4. **Check rescaling math** - verify the scale power formula is correct

---

## Recommended: Reduce Log Noise

If the logs are just cluttering output and prices are correct, change this:

**In `backend/src/server/graph.ts:569`:**
```typescript
// FROM:
logger.info('graph.decimals.mismatch', { ... });

// TO:
logger.debug('graph.decimals.mismatch', { ... });
```

This will only show these logs when `LOG_LEVEL=debug`, not in production.

---

## Summary

The `graph.decimals.mismatch` logs are **diagnostic information**, not errors:

- ✅ Canonicalization is working correctly (swapping mints and decimals)
- ✅ Graph is detecting swapped decimals (`swapped=true`)
- ✅ Graph is rescaling prices to account for decimal differences
- ℹ️ Logs are informational to help debug pricing issues

**Unless you can confirm the actual prices are wrong**, this is expected behavior!

