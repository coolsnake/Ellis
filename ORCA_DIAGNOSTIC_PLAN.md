# 🎯 DIAGNOSTIC LOGGING ADDED FOR ORCA PRICE INVESTIGATION

## Summary of Fixes Applied

### 1. ✅ **Meteora DLMM Price Formula** (FIXED)
- **File**: `backend/src/server/pools/meteora.ts` (lines 249-271)
- **Change**: Removed incorrect `* Math.pow(10, decA - decB)` from price formula
- **Impact**: Should fix ~100x-10,000x errors in Meteora DLMM pools

### 2. ✅ **Orca `populateOrcaPoolStates`** (FIXED)
- **File**: `backend/src/server/pools/orca.ts` (lines 880-881)
- **Change**: Re-resolve decimals using `resolveDecimals(mintA/B)` based on current mints
- **Impact**: Should fix stale decimal issues in Orca CLMM pools

### 3. ✅ **Raydium Transaction Builders** (FIXED)
- **File**: `backend/src/execution/builder/ix.ts` (2 locations)
- **Change**: Re-resolve decimals before building swap instructions
- **Impact**: Prevents execution failures due to decimal mismatches

### 4. 📊 **Diagnostic Logging Added** (NEW)
- **File**: `backend/src/server/pools/orca.ts` (lines 652-684)
- **What**: Logs USDC/SOL pool (`Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE`) before AND after canonicalization
- **Purpose**: Identify if the issue is with initial price calculation or canonicalization

## What to Look For in Logs

After deploying this build, check for these log lines:

### Expected Flow

**1. Before Canonicalization**:
```json
{
  "msg": "orca.before_canon.usdc_sol",
  "id": "Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE",
  "mint_a": "EPjFWdd5..." (USDC or SOL),
  "mint_b": "So11111..." (SOL or USDC),
  "decimals_a": 6 or 9,
  "decimals_b": 9 or 6,
  "price_a_per_b": ???  // <-- KEY: What is this value?
}
```

**2. After Canonicalization**:
```json
{
  "msg": "orca.after_canon.usdc_sol",
  "id": "Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE",
  "mint_a": "So11111..." (SOL - higher priority),
  "mint_b": "EPjFWdd5..." (USDC),
  "decimals_a": 9,
  "decimals_b": 6,
  "price_a_per_b": ???  // <-- KEY: Should be ~143 SOL per 1 USDC
}
```

**3. After `populateOrcaPoolStates`**:
```json
{
  "msg": "orca.poolState.cached",
  "ctx": {
    "pool": "Czfq3x...",
    "price": ???  // <-- KEY: Should match canonical price or be re-derived
  }
}
```

### Diagnostic Scenarios

#### Scenario A: Initial Price is Wrong
```json
// BEFORE canonicalization:
"mint_a": "So11111..." (SOL, 9 dec)
"mint_b": "EPjFWdd5..." (USDC, 6 dec)
"price_a_per_b": 0.007  // ❌ WRONG! Should be ~143

// This means the sqrt calculation is broken
```

**Root Cause**: Lines 340-341 in `orca.ts` - the decimal scale formula is incorrect

#### Scenario B: Canon fails to Invert Price
```json
// BEFORE:
"mint_a": "EPjFWdd5..." (USDC, 6 dec)
"mint_b": "So11111..." (SOL, 9 dec)
"price_a_per_b": 0.007  // USDC per SOL

// AFTER (should swap to SOL/USDC):
"mint_a": "So11111..." (SOL, 9 dec)
"mint_b": "EPjFWdd5..." (USDC, 6 dec)
"price_a_per_b": 0.007  // ❌ STILL WRONG! Should be 1/0.007 = 143
```

**Root Cause**: `swapPoolFields` in `canonical.ts` (line 86) price inversion is not working

#### Scenario C: `populateOrcaPoolStates` Fails
```json
// AFTER canonicalization:
"price_a_per_b": 143  // ✅ CORRECT

// But no "orca.poolState.cached" log appears
// OR
"orca.poolState.cache_populated": {
  "cached": 50,
  "failed": 100  // ❌ Many failures!
}
```

**Root Cause**: RPC rate limits, account decode errors, or other failures in `populateOrcaPoolStates`

## Next Steps

1. **Deploy** this build with diagnostic logging
2. **Tail logs** and search for `orca.before_canon.usdc_sol` and `orca.after_canon.usdc_sol`
3. **Compare prices** at each stage
4. **Identify** which stage introduces the error

## Most Likely Hypothesis

Based on the user's logs showing `price=0.007` for USDC/SOL, I suspect **Scenario A or B**:

- The initial price calculation (lines 329-363) is using the wrong decimal adjustment
- OR canonicalization is not inverting the price correctly

The fix for Scenario A would be similar to Meteora - remove the decimal adjustment from the initial calculation and let `populateOrcaPoolStates` handle it.

The fix for Scenario B would be to debug the `swapPoolFields` function in `canonical.ts`.

Let's wait for the diagnostic logs to confirm! 🔍

