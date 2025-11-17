# URGENT: Decimal Swap Bug Investigation

## The Problem

You're seeing massive phantom arbitrage opportunities (100,000,000% profit) and incorrect pricing. The graph logs show:

```
poolDecA=11, poolDecB=9
expectedA=9 (SOL), expectedB=11 (oreoU2)
swapped=true
```

**This means decimals are in WRONG positions after canonicalization!**

---

## Root Cause Analysis

### What SHOULD Happen

**Before Canon:**
- mint_a = `oreoU2...`, decimals_a = 11
- mint_b = `SOL`, decimals_b = 9

**After Canon (SOL forced to A side, stables to B):**
- mint_a = `SOL`, decimals_a = 9 ← swapped
- mint_b = `oreoU2...`, decimals_b = 11 ← swapped

### What IS Happening

**After Canon:**
- mint_a = `SOL`, decimals_a = 11 ← WRONG!
- mint_b = `oreoU2...`, decimals_b = 9 ← WRONG!

The mints are swapped but decimals are NOT!

---

## Hypothesis: Decimal Enrichment After Canonicalization

I suspect there's code that's **overwriting** the decimals after canonicalization. Possible culprits:

### 1. `populateOrcaPoolStates` (orca.ts:711)
This function runs AFTER canonicalization and might be enriching pools with RPC data, potentially overwriting the swapped decimals.

### 2. WebSocket Decoder Updates  
WS decoders might be updating pools without respecting canonical orientation.

### 3. Execution Cache
The execution cache might have stale decimal data that's being written back.

---

## Immediate Fix: Add Diagnostic Logging

### Step 1: Log Pool State After Canonicalization

**In `orca.ts` around line 651:**

```typescript
const clmmCanon = canonicalizePools(clmm);

// DIAGNOSTIC: Log oreoU2 pools after canonicalization
try {
  const oreoPool = clmmCanon.find(p => 
    p.mint_a.includes('oreoU2') || p.mint_b.includes('oreoU2')
  );
  if (oreoPool) {
    logger.info('orca.post-canon.oreo', {
      id: oreoPool.id.slice(0, 8),
      mint_a: oreoPool.mint_a.slice(0, 8),
      mint_b: oreoPool.mint_b.slice(0, 8),
      decimals_a: oreoPool.decimals_a,
      decimals_b: oreoPool.decimals_b,
      price: oreoPool.price_a_per_b,
      cat: 'orca'
    });
  }
} catch {}
```

### Step 2: Log Pool State Before Returning

**In `orca.ts` around line 713:**

```typescript
// DIAGNOSTIC: Re-check after populateOrcaPoolStates
try {
  const oreoPool = clmmCanon.find(p => 
    p.mint_a.includes('oreoU2') || p.mint_b.includes('oreoU2')
  );
  if (oreoPool) {
    logger.info('orca.pre-return.oreo', {
      id: oreoPool.id.slice(0, 8),
      mint_a: oreoPool.mint_a.slice(0, 8),
      mint_b: oreoPool.mint_b.slice(0, 8),
      decimals_a: oreoPool.decimals_a,
      decimals_b: oreoPool.decimals_b,
      price: oreoPool.price_a_per_b,
      cat: 'orca'
    });
  }
} catch {}

return { amm: [], clmm: clmmCanon };
```

This will tell us if `populateOrcaPoolStates` is the culprit.

---

## Likely Bug: `populateOrcaPoolStates` Overwrites Decimals

Looking at `populateOrcaPoolStates` (line 721+), I see at line 872-873:

```typescript
const decA = Number((pool as any).decimals_a);
const decB = Number((pool as any).decimals_b);
```

Then at line 886, it uses these to calculate price with `PriceMath.sqrtPriceX64ToPrice`.

**If the pool state from RPC has the original (pre-canonical) orientation, and we're reading those decimals, they'd be WRONG for the canonical mints!**

---

## The Fix

### Option 1: Don't Overwrite Decimals in `populateOrcaPoolStates`

The decimals should already be correct after canonicalization. Don't let RPC data overwrite them.

### Option 2: Fetch Decimals from Centralized Resolver

Instead of trusting pool decimals, fetch them based on the CURRENT mints:

```typescript
// BEFORE (line 872-873):
const decA = Number((pool as any).decimals_a);
const decB = Number((pool as any).decimals_b);

// AFTER:
const { resolveDecimals } = await import('./decimals.js');
const decA = await resolveDecimals(pool.mint_a) ?? Number((pool as any).decimals_a);
const decB = await resolveDecimals(pool.mint_b) ?? Number((pool as any).decimals_b);
```

This ensures decimals always match the current mint orientation.

---

## Quick Test

Run this query to check a specific pool:

```typescript
// Find the oreoU2 pool
const pool = orcaCache.data.clmm.find(p => 
  p.mint_a.includes('oreoU2') || p.mint_b.includes('oreoU2')
);

console.log({
  mint_a: pool.mint_a,
  mint_b: pool.mint_b,
  decimals_a: pool.decimals_a,
  decimals_b: pool.decimals_b,
  
  // Expected based on Jupiter
  expectedDecA: pool.mint_a === 'So11111111111111111111111111111111111111112' ? 9 : 11,
  expectedDecB: pool.mint_b === 'So11111111111111111111111111111111111111112' ? 9 : 11,
  
  // Are they correct?
  correct: (
    (pool.mint_a === 'So11111111111111111111111111111111111111112' && pool.decimals_a === 9) ||
    (pool.mint_a.includes('oreoU2') && pool.decimals_a === 11)
  )
});
```

---

## Next Steps

1. **Add the diagnostic logging above**
2. **Deploy and check logs** - see if decimals change after `populateOrcaPoolStates`
3. **Apply fix** - use centralized `resolveDecimals` based on current mints
4. **Same fix for all DEXes** - Raydium, Meteora might have same issue

---

## Impact

This bug causes:
- ❌ Wrong prices in graph edges
- ❌ Phantom arbitrage opportunities (100M% profit)
- ❌ Wrong swap amounts in execution
- ❌ Potential failed transactions or bad trades

**This is a critical bug that needs immediate attention!**

