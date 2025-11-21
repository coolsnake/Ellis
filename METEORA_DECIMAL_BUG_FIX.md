# Meteora DLMM Decimal Handling Bug Fix

## Issue Summary

**Date:** 2024-11-21  
**Pool:** `6wJ7W3oHj7ex6MVFp2o26NSof3aey7U8Brs8E371WCXA` (Meteora DLMM)  
**Tokens:** Fartcoin (9BB6NFE...) / SOL (So11111...)

### Symptoms

Arbitrage opportunity showed incorrect rate:
- **Reported Rate:** 1880.182490 (reverse edge rate)
- **Correct Rate:** ~0.0018877 SOL per Fartcoin
- **Error Factor:** ~1,000,000x off

The first rate calculation (reverse edge) was dramatically incorrect, suggesting a decimal handling error.

## Root Cause

### The Bug

During **websocket pool updates**, the code had a critical mismatch between:
1. **Native mints** extracted from on-chain state (tokenX, tokenY)
2. **Canonical decimals** retrieved from cache (decimals_a, decimals_b)

### How It Happened

1. **Initial Normalization (HTTP fetch):**
   - Pool: tokenX = Fartcoin (6 decimals), tokenY = SOL (9 decimals)
   - During canonicalization, the pool is **swapped** to put SOL first
   - Cached as: `mint_a = SOL, mint_b = Fartcoin, decimals_a = 9, decimals_b = 6`
   - Native fields preserved: `native_mint_a = Fartcoin, native_decimals_a = 6, native_mint_b = SOL, native_decimals_b = 9`

2. **Websocket Update:**
   - Code reads tokenX (Fartcoin) and tokenY (SOL) from chain state
   - Looks up decimals from cache: `decA = existing?.decimals_a` (gets 9 - wrong!)
   - Looks up decimals from cache: `decB = existing?.decimals_b` (gets 6 - wrong!)
   - **BUG:** Uses canonical decimals (9, 6) with native mints (Fartcoin, SOL)
   - Result: Thinks Fartcoin has 9 decimals and SOL has 6 decimals
   - Price calculation becomes completely wrong

### Code Location

**File:** `backend/src/server/pools.websockets.ts`

**Lines 1748-1762 (Meteora):**
```typescript
// BEFORE (BUGGY):
const existing = cachedMetPools.clmm.find(p => p.id === poolId);
let decA = existing?.decimals_a;  // ❌ Gets canonical decimals
let decB = existing?.decimals_b;  // ❌ Gets canonical decimals
```

**Lines 1237-1251 (Raydium AMM):**
```typescript
// BEFORE (BUGGY):
const existing = cachedRayPools.amm.find(p => p.id === pk58);
decA = existing?.decimals_a;  // ❌ Gets canonical decimals
decB = existing?.decimals_b;  // ❌ Gets canonical decimals
```

## The Fix

### Changes Applied

Updated websocket handlers to use **native decimals** instead of canonical decimals:

**Meteora DLMM (lines 1748-1768):**
```typescript
// AFTER (FIXED):
const existing = cachedMetPools.clmm.find(p => p.id === poolId);
// Use native_decimals_a/b which match the native tokenX/tokenY order
let decA = existing?.native_decimals_a ?? existing?.decimals_a;  // ✅
let decB = existing?.native_decimals_b ?? existing?.decimals_b;  // ✅

// Execution cache fallback also fixed:
if (!decA && cached?.native_decimals_a) decA = cached.native_decimals_a;
if (!decA && cached?.decimals_a) decA = cached.decimals_a;
if (!decB && cached?.native_decimals_b) decB = cached.native_decimals_b;
if (!decB && cached?.decimals_b) decB = cached.decimals_b;
```

**Raydium AMM (lines 1237-1251):**
```typescript
// AFTER (FIXED):
const existing = cachedRayPools.amm.find(p => p.id === pk58);
decA = existing?.native_decimals_a ?? existing?.decimals_a;  // ✅
decB = existing?.native_decimals_b ?? existing?.decimals_b;  // ✅

// Execution cache fallback also fixed:
if (!decA && cached?.native_decimals_a) decA = cached.native_decimals_a;
if (!decA && cached?.decimals_a) decA = cached.decimals_a;
if (!decB && cached?.native_decimals_b) decB = cached.native_decimals_b;
if (!decB && cached?.decimals_b) decB = cached.decimals_b;
```

### Why This Works

1. **Native fields are always in original order:** `native_decimals_a` matches `tokenX`, `native_decimals_b` matches `tokenY`
2. **Canonical fields may be swapped:** `decimals_a` and `decimals_b` match the canonical `mint_a` and `mint_b`
3. **Websocket reads native mints from chain:** tokenX and tokenY are always in native order
4. **Therefore:** Must use `native_decimals_a/b` to match native mints from chain

### Safety Fallback

The fix uses `??` (nullish coalescing) to fall back to canonical decimals if native decimals aren't available:
```typescript
let decA = existing?.native_decimals_a ?? existing?.decimals_a;
```

This ensures backward compatibility if older cached pools don't have native decimal fields.

## Verification

### Other DEXes Checked

- **Orca CLMM:** ✅ Already calls `resolveDecimals()` directly for native mints - no bug
- **Raydium CLMM:** ✅ Already calls `resolveDecimals()` directly for native mints - no bug
- **Raydium AMM:** ✅ Fixed (same issue as Meteora)
- **Pumpswap:** ✅ No websocket updates, uses HTTP polling only

### Expected Outcome

After this fix, websocket updates for Meteora DLMM pools will:
1. Read tokenX and tokenY from chain state (native order)
2. Look up decimals using `native_decimals_a` and `native_decimals_b` (native order)
3. Pass correctly matched mints and decimals to `processPriceThroughPipeline()`
4. Calculate correct prices
5. Apply canonicalization correctly
6. Produce accurate rates for arbitrage

## Testing Recommendations

1. **Monitor logs** for pool `6wJ7W3oHj7ex6MVFp2o26NSof3aey7U8Brs8E371WCXA`:
   - Look for `price.pipeline.canonicalization` entries
   - Verify `input_decimalsA` and `input_decimalsB` match actual token decimals
   - For Fartcoin/SOL: should see decimalsA=6 (Fartcoin) and decimalsB=9 (SOL) in native order

2. **Check arbitrage rates:**
   - Rates should now be reasonable (not 1000x off)
   - Forward and reverse rates should multiply to ~1.0

3. **Watch for similar issues:**
   - Any other pools with swapped canonicalization
   - Especially low-decimal tokens paired with high-decimal tokens

## Files Modified

- `backend/src/server/pools.websockets.ts`
  - Lines 1748-1768: Meteora DLMM websocket handler
  - Lines 1237-1251: Raydium AMM websocket handler

## Related Documentation

- See `priceFormulas.ts` for Meteora price calculation formula
- See `pricePipeline.ts` for canonicalization logic
- See `canonical.ts` for token pair orientation rules

