# Decimal Swap Investigation

## Issue Report

User reports seeing `graph.decimals.mismatch` logs with `swapped=true` for specific tokens:

```
poolDecA=11, poolDecB=9, expectedA=9, expectedB=11, swapped=true
```

Example tokens:
- `oreoU2P8bN6jkk3jbaiVxYnG1dCXcYxwhwyK9jSybcp` (OREO, 11 decimals)
- `oobQ3oX6ubRYMNMahG7VSCe8Z73uaQbAWFn6f22XTgo` (OOB, 6 decimals)

## Current Understanding

### What The Logs Mean

The `graph.decimals.mismatch` log with `swapped=true` indicates:

1. **Pool has**: `decimals_a=11, decimals_b=9`
2. **Graph expects** (from Jupiter): `decimals_a=9, decimals_b=11`
3. **`swapped=true`**: The pool's decimals match if you swap them (`poolDecA === expectedB && poolDecB === expectedA`)

### Is This Actually a Problem?

**The graph DOES fix the price** using `rescalePriceByDecimals`:

```typescript
// Formula: price * 10^((globalA - poolA) - (globalB - poolB))
// For OREO/SOL: price * 10^((9-11) - (11-9)) = price * 10^-4
```

So the graph is **compensating** for the decimal mismatch by rescaling the price.

### Why Are The Decimals "Wrong"?

After canonicalization, if SOL/OREO is swapped to OREO/SOL:

**Expected after swap:**
- `mint_a` = SOL (9 decimals)
- `mint_b` = OREO (11 decimals)
- `decimals_a` = 9 ✅
- `decimals_b` = 11 ✅

**But the logs show:**
- `mint_a` = SOL
- `mint_b` = OREO
- `decimals_a` = 11 ❌ (OREO's decimals in wrong position!)
- `decimals_b` = 9 ❌ (SOL's decimals in wrong position!)

## Investigation Steps

### 1. Verified `swapPoolFields` Works Correctly

Test confirmed that `swapPoolFields` DOES swap both mints AND decimals:

```javascript
// BEFORE
{
  mint_a: "oreoU2...",
  mint_b: "So1111...",
  decimals_a: 11,
  decimals_b: 9
}

// AFTER swapPoolFields
{
  mint_a: "So1111...",
  mint_b: "oreoU2...",
  decimals_a: 9,  // ✅ SWAPPED
  decimals_b: 11  // ✅ SWAPPED
}
```

### 2. Canonicalization IS Being Called

All normalizers call `canonicalizePools()` which uses `swapPoolFields()` internally.

### 3. Possible Issues

The decimals being "wrong" after canonicalization could mean:

#### Option A: Pools Are Being Modified After Canonicalization
- Something is overwriting `decimals_a` and `decimals_b` after canonicalization
- Cache might be storing pre-canonical values
- WebSocket updates might be resetting decimals

#### Option B: Graph Is Using Stale Data
- Graph's `decimalsByMint` comes from Jupiter token map
- Pool's stored `decimals_a`/`decimals_b` come from normalization
- These might be out of sync

#### Option C: The Logs Are Misleading (Most Likely)
- The decimals ARE correctly swapped in the pools
- The graph IS rescaling prices correctly
- The logs are just **informational**, not errors
- Prices might still be wrong for OTHER reasons (e.g., sqrt price calc bugs)

## Diagnostic Logging Added

### Orca (`orca.ts`)

Added logging for pools containing problematic mints after canonicalization:

```typescript
logger.info('orca.post_canon.sol_exotic', {
  id, mint_a, mint_b, decimals_a, decimals_b, 
  expected_decimals_a: 9, price_a_per_b
});
```

### What To Look For

Run the system and check logs for:

1. **`orca.post_canon.sol_exotic`** - Shows decimals after canonicalization for SOL/OREO pools
2. **`meteora.after_canon.ore_sol`** - Shows decimals after canonicalization for specific Meteora pool
3. **`graph.decimals.mismatch`** - Compare with post-canon logs to see if they match

### Expected Results

If canonicalization is working:
- `orca.post_canon.sol_exotic` should show `decimals_a: 9, decimals_b: 11`
- `graph.decimals.mismatch` should show `poolDecA: 9, poolDecB: 11`

If there's a bug:
- `orca.post_canon.sol_exotic` might show `decimals_a: 11, decimals_b: 9` (wrong!)
- `graph.decimals.mismatch` would show `poolDecA: 11, poolDecB: 9, swapped: true`

## Next Steps

1. **Run the system** and collect logs
2. **Compare** `orca.post_canon.sol_exotic` with `graph.decimals.mismatch` logs
3. **If decimals ARE swapped correctly** in normalizer but graph still sees wrong decimals:
   - Check execution cache (might be stale)
   - Check if WebSocket updates are overwriting decimals
   - Check if graph is reading from a different source
4. **If decimals are NOT swapped** in normalizer output:
   - Bug in `canonicalizePools` (unlikely, test passed)
   - Pools being modified after canonicalization
   - Different code path bypassing canonicalization

## Key Files

- `backend/src/server/pools/orca.ts` - Orca normalizer with diagnostic logging
- `backend/src/server/pools/meteora.ts` - Meteora normalizer with existing logging  
- `backend/src/server/pools/canonical.ts` - Canonicalization logic
- `backend/src/server/graph.ts` - Graph builder with decimal validation
- `backend/src/server/pools.ts` - Pool caching and distribution

## Hypothesis

**Most likely**: The canonicalization IS working correctly, decimals ARE being swapped, and the graph IS rescaling prices. The `graph.decimals.mismatch` logs are just **informational diagnostics**, not errors. If prices are still wrong, the bug is elsewhere (e.g., in price derivation formulas, not decimal handling).

**To verify**: Check if the new `orca.post_canon.sol_exotic` logs show correct decimals (9 for SOL, 11 for OREO).

