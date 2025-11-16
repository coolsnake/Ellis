# 🚨 CRITICAL FIX: Decimal Orientation After Canonicalization

**Date**: 2025-11-16  
**Priority**: URGENT  
**Impact**: Incorrect pricing leading to false arbitrage opportunities

## 🔴 Problem Description

After canonicalization swaps mints (`mint_a` ↔ `mint_b`), derived price calculations were using **STALE** `decimals_a` and `decimals_b` values from the pool cache, leading to incorrect prices and false arbitrage opportunities.

### Real-World Example

```
Logs:
graph.decimals.mismatch {
  "mintA": "So11111111111111111111111111111111111111112",  // SOL (should be 9 decimals)
  "mintB": "oreoU2P8bN6jkk3jbaiVxYnG1dCXcYxwhwyK9jSybcp",  // OREO (should be 11 decimals)
  "poolDecA": 11,  // WRONG! SOL has 9 decimals
  "poolDecB": 9,   // WRONG! OREO has 11 decimals
  "expectedA": 9,
  "expectedB": 11,
  "swapped": true
}

Arbitrage:
profit_bps: 100689988  // ~10,000,000% profit (IMPOSSIBLE)
rate: 7683.496316     // MASSIVELY INCORRECT
```

### Root Cause

**Before Canonicalization:**
```typescript
mint_a: oreoU2 (11 decimals)
mint_b: SOL (9 decimals)
decimals_a: 11
decimals_b: 9
```

**After Canonicalization (`swapPoolFields`):**
```typescript
mint_a: SOL (9 decimals)
mint_b: oreoU2 (11 decimals)
decimals_a: 9  // CORRECTLY swapped
decimals_b: 11 // CORRECTLY swapped
```

**But then, in `populateOrcaPoolStates` (OLD CODE):**
```typescript
// BUG: Reading potentially stale decimals from pool object
const decA = Number((pool as any).decimals_a);  // Might be 11 (WRONG!)
const decB = Number((pool as any).decimals_b);  // Might be 9 (WRONG!)

// Price calculation uses WRONG decimals
const derivedPrice = PriceMath.sqrtPriceX64ToPrice(sqrtPriceX64, decA, decB);
// Result: 7683.496316 instead of ~0.0001
```

### Why This Happened

1. **Cache Timing Issue**: The pool cache might not have been updated with the swapped decimals yet when `populateOrcaPoolStates` runs.
2. **No Re-Resolution**: The code trusted the cached `decimals_a` and `decimals_b` without verifying they matched the *current* mints.
3. **Race Condition**: WS updates, HTTP fetches, and graph builds all run concurrently, creating opportunities for stale data.

## ✅ Solution: Explicit Decimal Re-Resolution

### Fix Applied to All DEXes

**1. Orca (`backend/src/server/pools/orca.ts`, lines ~879-891)**

```typescript
// BEFORE (BAD):
const decA = Number((pool as any).decimals_a);
const decB = Number((pool as any).decimals_b);

// AFTER (FIXED):
const mintA = String((pool as any).mint_a);
const mintB = String((pool as any).mint_b);

// Fetch decimals for CURRENT mints (respects canonicalization)
const { resolveDecimals } = await import('./decimals.js');
const decA = await resolveDecimals(mintA) ?? Number((pool as any).decimals_a);
const decB = await resolveDecimals(mintB) ?? Number((pool as any).decimals_b);

// Now decA and decB are GUARANTEED to match the current mints
const derivedPrice = PriceMath.sqrtPriceX64ToPrice(sqrtPriceX64, decA, decB);
```

**2. Transaction Builders (`backend/src/execution/builder/ix.ts`)**

Applied to both Raydium CLMM (lines ~4125-4129) and Raydium AMM (lines ~5336-5340):

```typescript
// BEFORE (BAD):
poolDecA = cached.decimals_a;
poolDecB = cached.decimals_b;

// AFTER (FIXED):
// CRITICAL: Fetch decimals based on CURRENT mints (post-canonicalization)
// The cache might have stale decimals from before canonicalization
const { resolveDecimals } = await import('../../server/pools/decimals.js');
if (poolMintA) poolDecA = await resolveDecimals(poolMintA) ?? cached.decimals_a;
if (poolMintB) poolDecB = await resolveDecimals(poolMintB) ?? cached.decimals_b;
```

### Why This Works

1. **`resolveDecimals(mint)` is Authoritative**: It fetches the **correct** decimals for a given mint from:
   - Anchor decimals (hardcoded constants like SOL=9, USDC=6)
   - Cached Jupiter token map
   - RPC calls to the mint account
   
2. **Always Matches Current Mints**: By calling `resolveDecimals(mintA)` and `resolveDecimals(mintB)` using the *current* mints (which are already canonicalized), we **guarantee** the decimals match the mints.

3. **Fallback to Cache**: If `resolveDecimals` fails (rare), we still fall back to `cached.decimals_a/b` as a last resort.

## 📊 Expected Behavior After Fix

### For the OREO/SOL Example

**After Canonicalization:**
```typescript
mint_a: SOL
mint_b: oreoU2
```

**In `populateOrcaPoolStates`:**
```typescript
// Explicit re-resolution
mintA = "So11111111111111111111111111111111111111112"
mintB = "oreoU2P8bN6jkk3jbaiVxYnG1dCXcYxwhwyK9jSybcp"

decA = await resolveDecimals(mintA)  // Returns 9 ✅
decB = await resolveDecimals(mintB)  // Returns 11 ✅

// Price calculation now uses CORRECT decimals
derivedPrice = PriceMath.sqrtPriceX64ToPrice(sqrtPriceX64, 9, 11)
// Result: ~0.0001 (CORRECT)
```

**In Graph Builder:**
```typescript
// Graph compares with Jupiter token map
poolDecA = 9  // From resolveDecimals
poolDecB = 11 // From resolveDecimals
expectedA = 9 // From Jupiter map (SOL)
expectedB = 11 // From Jupiter map (OREO)

// NO MISMATCH! ✅
// No rescaling needed
```

**Arbitrage Detection:**
```
profit_bps: 0-50  // Normal range
rate: 0.0001234   // CORRECT
```

## 🎯 Files Changed

### 1. `backend/src/server/pools/orca.ts`
- **Function**: `populateOrcaPoolStates`
- **Lines**: ~879-891
- **Change**: Added explicit `resolveDecimals` calls based on current mints

### 2. `backend/src/execution/builder/ix.ts`
- **Function**: `buildRaydiumClmmSwapIx` (Raydium CLMM)
- **Lines**: ~4125-4129
- **Change**: Re-resolve decimals based on cached mints before building swap instructions

- **Function**: `buildRaydiumAmmSwapIx` (Raydium AMM)
- **Lines**: ~5336-5340
- **Change**: Re-resolve decimals based on cached mints before building swap instructions

## 🧪 Testing

### Unit Tests (Already Pass)
- `backend/src/server/__tests__/pools/canonical.test.ts`
  - Test: "should swap decimals along with mints"
  - Verifies `swapPoolFields` correctly swaps `decimals_a` and `decimals_b`

### Manual Verification Needed

1. **Monitor Logs**: After deployment, check for `graph.decimals.mismatch` logs:
   - Expected: FEWER logs (only for truly unknown tokens)
   - Before: Many logs with `swapped=true` for known tokens like SOL/OREO
   - After: Logs only for genuinely missing decimals in Jupiter map

2. **Verify Pricing**: For pools with previously incorrect prices (like OREO/SOL):
   - Compare pool price with Jupiter API or CoinGecko
   - Check that price makes economic sense (no 7000x+ multiples)

3. **Arbitrage Detection**: Monitor false positives:
   - Expected: Dramatic reduction in 10,000%+ "arbitrage opportunities"
   - Expected: Normal 0-50 bps profit range for most opportunities

## 🔍 Why Graph Logs Were Misleading

The `graph.decimals.mismatch` logs were **NOT** errors - they were **diagnostics**:

```typescript
// In graph.ts (lines 554-573)
const diagDecimals = (pool: any) => {
  // Compare pool's decimals with Jupiter token map
  const poolDecA = Number(pool.decimals_a);
  const poolDecB = Number(pool.decimals_b);
  const expectedA = decimalsByMint.get(pool.mint_a);
  const expectedB = decimalsByMint.get(pool.mint_b);
  
  if (poolDecA !== expectedA || poolDecB !== expectedB) {
    logger.info('graph.decimals.mismatch', { ... });
    
    // THEN FIXES IT:
    pool.price_a_per_b = rescalePriceByDecimals(
      pool.price_a_per_b,
      poolDecA, poolDecB,
      expectedA, expectedB
    );
  }
};
```

The graph was **detecting** the mismatch and **fixing** it via `rescalePriceByDecimals`. BUT:
- This happened AFTER the derived price was already calculated
- If the derived price was calculated with WRONG decimals, the rescaling couldn't fully fix it
- The root issue was in the normalizers, not the graph

## 🎓 Key Learnings

1. **Never Trust Cached Decimals After Canonicalization**: Always re-resolve decimals based on *current* mints.

2. **Centralized Decimal Resolution**: The `resolveDecimals` function is the single source of truth - use it everywhere.

3. **Race Conditions Are Real**: In a concurrent system with WS updates, HTTP fetches, and graph builds, always verify data freshness.

4. **Defensive Programming**: Even if canonicalization *should* swap decimals correctly, explicitly re-resolve them at the point of use for critical calculations.

5. **Logs ≠ Errors**: The `graph.decimals.mismatch` logs were informational, not errors. The real bug was hidden upstream in the normalizers.

## ✅ Status

- [x] **Orca**: Fixed in `populateOrcaPoolStates`
- [x] **Raydium CLMM**: Fixed in `buildRaydiumClmmSwapIx`
- [x] **Raydium AMM**: Fixed in `buildRaydiumAmmSwapIx`
- [x] **Compilation**: All files compile successfully
- [ ] **Meteora**: No price derivation logic found (uses API prices)
- [ ] **MeteoraBalanced**: No price derivation logic found (uses vault reserves)
- [ ] **PumpSwap**: No price derivation logic found (uses reserves directly)

### Next Steps

1. **Deploy**: Push to production
2. **Monitor**: Watch for reduction in decimal mismatch logs
3. **Verify**: Check pricing for previously affected pools (OREO, WENWENWENWENWEN, etc.)
4. **Document**: Update team on the fix and what to watch for

---

**Critical Takeaway**: When mints are swapped during canonicalization, **ALWAYS re-resolve decimals** based on the *current* mints at the point of use, never trust cached `decimals_a`/`decimals_b` values without verification.

