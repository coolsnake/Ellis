# Vault Address Lookup Fix - Using Cache Instead of Raw Decoding

## Issue Discovered via Diagnostic Logging

The diagnostic logging immediately revealed the problem:

```
[INFO] pumpswap.vault_cache.preload.complete {"cached":128,"failed":0}  ✅
[INFO] pools.ws.event_received  ✅ Events arriving!
[WARN] pumpswap.ws.decode failed {"error":"vault balances not in cache (vaultA: CV8KpeYw=false, vaultB: 4BtkSt2M=false)"}  ❌
```

**The Problem:**
- Vault cache was successfully preloaded with 128 vault addresses
- WebSocket events were arriving (27 events in 10 seconds)
- But the decoder was looking for **DIFFERENT** vault addresses than what was cached!

## Root Cause

The original decoder tried to extract vault addresses from raw pool account data at fixed offsets:

```typescript
// WRONG: Trying to decode from raw data
const buf = Buffer.from(info.data);
account_a = new web3.PublicKey(buf.slice(72, 104)).toBase58();   // Offset 72
account_b = new web3.PublicKey(buf.slice(104, 136)).toBase58();  // Offset 104
```

**Why This Failed:**
1. Pumpswap pool account structure may vary by pool version
2. The offsets (72, 104) were guessed based on typical AMM layouts
3. The actual vault addresses decoded from these offsets didn't match what we preloaded from the HTTP API
4. Result: `vaultBalanceCache.get(account_a)` returned `undefined` because we cached different addresses

## The Solution

Instead of trying to decode vault addresses from raw account data, **look them up from the pool cache** (which was already fetched via HTTP/GraphQL):

```typescript
// CORRECT: Look up from cache
const pool = pumpswapCache.data?.amm?.find(p => p.id === pk58);
if (!pool) {
  throw new Error('pool not in cache');
}

account_a = (pool as any).account_a;  // Use cached vault addresses
account_b = (pool as any).account_b;
const mint_a = pool.mint_a;
const mint_b = pool.mint_b;

if (!account_a || !account_b) {
  throw new Error('pool missing vault addresses in cache');
}
```

**Benefits:**
1. ✅ Vault addresses are guaranteed to match what we preloaded
2. ✅ No guessing offsets or dealing with pool structure variations
3. ✅ Works for all pool versions (v1, v2, etc.)
4. ✅ Eliminates decoding errors

## How It Works Now

### 1. HTTP Fetch (Startup)
```
fetchPumpswapPools() → Gets pool data with vault addresses
↓
pumpswapCache.data = {
  amm: [
    { id: "8Sg8...", account_a: "CV8K...", account_b: "4Btk..." },
    ...
  ]
}
```

### 2. Vault Cache Preload (Before WebSocket)
```
preloadPumpswapVaultCache()
↓
For each pool in pumpswapCache.data:
  - Fetch vault balances via RPC
  - vaultBalanceCache.set("CV8K...", balance_a)
  - vaultBalanceCache.set("4Btk...", balance_b)
```

### 3. WebSocket Event (Pool Update)
```
Event arrives for pool "8Sg8..."
↓
Look up pool in pumpswapCache → Get vault addresses "CV8K...", "4Btk..."
↓
Look up vault balances in vaultBalanceCache → FOUND! ✅
↓
Calculate new price from vault balances
↓
Update pool cache and graph
```

## Expected Behavior After Fix

### Before (Failing)
```
[INFO] pumpswap.vault_cache.preload.complete {"cached":128}
[INFO] pools.ws.event_received
[WARN] pumpswap.ws.decode failed {"error":"vault balances not in cache (vaultA: CV8KpeYw=false, vaultB: 4BtkSt2M=false)"}
```

Vault addresses from raw decode ≠ Vault addresses in cache

### After (Working)
```
[INFO] pumpswap.vault_cache.preload.complete {"cached":128}
[INFO] pools.ws.event_received
[DEBUG] pumpswap.ws.vaults_from_cache {"vaultA":"CV8K...","vaultB":"4Btk..."}
[DEBUG] pumpswap.ws.vault_cache_hit {"baseReserve":"123456","quoteReserve":"789012"}
[DEBUG] pumpswap.ws.decode.success {"price":0.00123}
[INFO] pools.ws healthy
```

Vault addresses from cache = Vault addresses in preload ✅

## Why This Approach is Better

### ❌ Decoding from Raw Data
- **Fragile**: Depends on knowing exact account structure
- **Version-specific**: Different pool versions may have different layouts
- **Error-prone**: Easy to get offsets wrong
- **Maintenance**: Breaks when pool program updates

### ✅ Looking Up from Cache
- **Robust**: Uses data already validated by the pool fetcher
- **Version-agnostic**: Works regardless of pool structure
- **Reliable**: HTTP API provides correct addresses
- **Maintainable**: No hardcoded offsets to update

## Similar Pattern for Meteora Balanced

The same issue likely affects meteora_balanced pools. The decoder already uses this approach:

```typescript
// meteora_balanced decoder (line ~2658)
const pool = metbalCache.data?.amm?.find(p => p.id === pk58);
if (!pool) {
  throw new Error('pool not in cache');
}

const account_a = (pool as any).account_a;  // ✅ Lookup from cache
const account_b = (pool as any).account_b;
```

This is the correct approach!

## Files Modified

- `backend/src/server/pools.ts`:
  - Lines 2472-2500: Replace raw vault address decoding with cache lookup
  - Added debug logging for vault addresses retrieved from cache

## Testing Checklist

After this fix, verify:
1. ✅ Vault cache preload still completes successfully (128 vaults)
2. ✅ WebSocket events arrive for active pools
3. ✅ No more "vault balances not in cache" errors
4. ✅ `pumpswap.ws.decode.success` logs appear
5. ✅ Pool prices update in graph
6. ✅ System stays healthy (no more reconnection loops)

## Key Takeaway

**Don't reinvent the wheel!** We already fetch complete pool data via HTTP with all the correct vault addresses. Use that data instead of trying to reverse-engineer it from raw account data.

This is a common pattern:
- HTTP/REST API: Complete, validated data with all relationships
- WebSocket events: Partial updates to existing data
- Solution: Use WebSocket for "what changed", use cache for "what is"

