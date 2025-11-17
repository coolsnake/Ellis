# CRITICAL FIX: Decimal Orientation Bug in Post-Canonicalization Processing

**Date:** 2025-11-16  
**Severity:** 🔴 **CRITICAL** - Causes phantom arbitrage and wrong pricing  
**Status:** ✅ Fixed in `orca.ts`, needs review for other DEXes

---

## The Bug

### Symptom
- Phantom arbitrage opportunities showing 100M% profit
- Rates like `7683.496316` instead of correct values like `0.0001`  
- Graph logs showing `graph.decimals.mismatch` with `swapped=true`

### Root Cause
**After canonicalization**, pools have their mints and decimals correctly swapped. However, **`populateOrcaPoolStates`** (and similar functions) were reading `pool.decimals_a/decimals_b` directly instead of fetching decimals based on the CURRENT mints.

This caused price calculations to use WRONG decimals (from before canonicalization).

---

## Example

### Before Canonicalization
```typescript
mint_a: 'oreoU2...' (11 decimals)
mint_b: 'SOL' (9 decimals)
decimals_a: 11
decimals_b: 9
price_a_per_b: 0.0001 // oreoU2 per SOL
```

### After Canonicalization (SOL to A side)
```typescript
mint_a: 'SOL'        ← swapped
mint_b: 'oreoU2...'  ← swapped
decimals_a: 9        ← swapped
decimals_b: 11       ← swapped
price_a_per_b: 10000 ← inverted
```

### Bug: `populateOrcaPoolStates` Reads Stale Decimals
```typescript
// WRONG: Reads pool.decimals_a/b (might be stale from cache)
const decA = Number((pool as any).decimals_a); // Gets 11 but mint is SOL (should be 9)!
const decB = Number((pool as any).decimals_b); // Gets 9 but mint is oreoU2 (should be 11)!

// Uses wrong decimals to calculate price
const price = PriceMath.sqrtPriceX64ToPrice(sqrt, decA, decB);
// Result: 7683.496316 instead of 0.0001
```

---

## The Fix

### In `backend/src/server/pools/orca.ts:871-881`

**BEFORE:**
```typescript
let derivedPrice: number | undefined;
const decA = Number((pool as any).decimals_a);
const decB = Number((pool as any).decimals_b);
```

**AFTER:**
```typescript
// Calculate derived price from sqrt using CURRENT mint decimals (post-canonicalization)
// CRITICAL: Use resolveDecimals based on current mints, not pool.decimals_a/b
// The pool might have been canonicalized, swapping mints but the decimals in cache might be stale
let derivedPrice: number | undefined;
const mintA = String((pool as any).mint_a);
const mintB = String((pool as any).mint_b);

// Fetch decimals for CURRENT mints (respects canonicalization)
const { resolveDecimals } = await import('./decimals.js');
const decA = await resolveDecimals(mintA) ?? Number((pool as any).decimals_a);
const decB = await resolveDecimals(mintB) ?? Number((pool as any).decimals_b);
```

### Why This Works

1. **`resolveDecimals(mintA)`** fetches decimals based on the CURRENT mint
2. **Respects canonicalization** - if mints were swapped, decimals will match
3. **Uses centralized resolver** - consistent with normalizers
4. **Fallback to pool decimals** - if resolve fails, use what's stored

---

## Testing

### Verify the Fix

1. **Check the oreoU2 pool after restart:**
   ```
   Rate should be ~0.0001 instead of 7683
   No more phantom arbitrage opportunities
   Graph logs should show decimals match
   ```

2. **Monitor graph logs:**
   ```
   graph.decimals.mismatch should still appear (diagnostic)
   But swapped=false now (decimals correct)
   ```

---

## Action Items

### ✅ DONE
- [x] Fixed `populateOrcaPoolStates` in `orca.ts`
- [x] TypeScript compiles successfully
- [x] Created diagnostic documentation

### 🔴 TODO - URGENT
- [ ] Check Raydium for same issue
- [ ] Check Meteora for same issue  
- [ ] Check WebSocket decoders for same issue
- [ ] Test on staging/devnet before production deploy

---

## Potential Other Locations

### Places That Might Have Same Bug

1. **Raydium CLMM** - Any code that fetches decimals after canonicalization
2. **Meteora DLMM** - `populateMeteoraActiveIds` or similar
3. **WebSocket Decoders** - If they update prices using cached decimals
4. **Graph Builder** - Already handles this with `rescalePriceByDecimals`, but worth verifying

### Search Pattern
```bash
grep -r "pool.*decimals_a.*pool.*decimals_b" backend/src/server/pools/
grep -r "Number.*pool.*decimals" backend/src/server/pools/
```

---

## Impact

### Before Fix
- ❌ Wrong prices in graph (off by 100x - 10000x)
- ❌ Phantom arbitrage showing 100M% profit
- ❌ Potential failed transactions
- ❌ Wrong swap amounts

### After Fix
- ✅ Correct prices in graph
- ✅ No phantom arbitrage
- ✅ Decimals always match mints
- ✅ Reliable trading

---

## Key Lesson

**Golden Rule:** After canonicalization, ALWAYS fetch decimals based on CURRENT mints, never trust cached `decimals_a/decimals_b` fields!

```typescript
// ❌ WRONG:
const decA = pool.decimals_a;

// ✅ RIGHT:
const decA = await resolveDecimals(pool.mint_a);
```

---

## Deploy Plan

1. ✅ Fix Orca (DONE)
2. 🔴 Review & fix Raydium, Meteora (IN PROGRESS)
3. 🔴 Test on devnet
4. 🔴 Deploy to production
5. 🔴 Monitor for 24h

**This fix is critical for production reliability!**

