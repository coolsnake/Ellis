# Vault Cache Preload Fix - Resolves Unhealthy WebSocket Loop

## Problem Identified

The system was experiencing a loop of "unhealthy" WebSocket subscriptions for pumpswap and meteora_balanced pools:

```
[WARN] pools.ws unhealthy {"idleMs":21349,"timeoutMs":30000}
[INFO] pools.ws unsubscribed
[INFO] pools.ws retarget.cooldown {"ms":3000}
```

### Root Cause

The pool decoder required vault balances to be in the `vaultBalanceCache` before it could process pool events:

```typescript
// backend/src/server/pools.ts:2326
if (!baseReserve || !quoteReserve) {
  throw new Error(`vault balances not in cache`);
}
```

**The Issue:**
1. WebSocket subscriptions were established for pools AND vaults ✅
2. Vault events arrived and updated `lastWsEventMs` ✅ (keeping system "healthy")
3. Pool events arrived but decoder threw an error because vault balances weren't cached yet ❌
4. Vault handler returned early without triggering pool updates (line 1605)
5. System appeared "healthy" due to vault events, but **no pool updates were being processed**

The vault balances were only cached when vault events arrived (line 1555), but pool events might arrive BEFORE vault events, causing decode failures.

## Solution Implemented

### 1. Pre-populate Vault Balance Cache Functions

Added two new functions to pre-load vault balances before WebSocket subscriptions start:

#### `preloadPumpswapVaultCache()` (lines 470-546)
- Collects all vault addresses from pumpswap pool cache
- Fetches vault balances via RPC in batches of 100
- Populates `vaultBalanceCache` before pool subscriptions
- Logs success/failure metrics

#### `preloadMeteoraBalancedVaultCache()` (lines 548-624)
- Same approach for meteora_balanced pools
- Ensures vault balances are available when pool events arrive

### 2. Call Preload Functions Before Subscription Loops

**Pumpswap** (line 3867):
```typescript
// CRITICAL: Pre-populate vault balance cache before subscribing to WebSocket
// This ensures pool events can decode immediately without waiting for vault events
if (uniquePump.length > 0) {
  await preloadPumpswapVaultCache();
}
```

**Meteora Balanced** (line 4006):
```typescript
// CRITICAL: Pre-populate vault balance cache before subscribing to WebSocket
// This ensures pool events can decode immediately without waiting for vault events
if (uniqueMbal.length > 0) {
  await preloadMeteoraBalancedVaultCache();
}
```

## Expected Behavior After Fix

### Startup Logs
```
[INFO] pumpswap.vault_cache.preload.start {"vaultCount":132}
[INFO] pumpswap.vault_cache.preload.complete {"cached":132,"failed":0,"total":132}
[INFO] meteora_balanced.vault_cache.preload.start {"vaultCount":48}
[INFO] meteora_balanced.vault_cache.preload.complete {"cached":48,"failed":0,"total":48}
```

### Pool Events Processing
- Pool events will decode successfully on first arrival
- No more "vault balances not in cache" errors
- `wsDeltaStats.pumpswap.decoded` will increment
- `wsDecodeStats.pumpswap.successes` will increment (not failures)
- WebSocket health check will correctly detect pool updates

### Health Status
- `lastWsEventMs` will update from both vault AND pool events
- Pool price updates will be applied to graph
- No more unhealthy reconnection loops

## Cache Verification Summary

### Pool Caches ✅
- **Raydium**: Populated via `getRaydiumPoolsNormalized()` → `raydiumCache.data`
- **Orca**: Populated via `getOrcaPoolsNormalized()` → `orcaCache.data`
- **Meteora**: Populated via `getMeteoraPoolsNormalized()` → `meteoraCache.data`
- **Meteora Balanced**: Populated via `getMeteoraBalancedPools()` → `metbalCache.data`
- **Pumpswap**: Populated via `getPumpswapPoolsCached()` → `pumpswapCache.data`

All caches are populated during `refreshAllSources()` at startup (line 1340-1350).

### Execution Cache ✅
- **Static Data**: Populated from pool metadata (programId, vaults, authorities, etc.)
- **Hot Data**: Populated from RPC for CLMM pools (sqrtPriceX64, tickIndex, etc.)
- **Orca Pools**: `populateOrcaPoolStates()` reads pool state directly from account data (lines 524-693)
- **Usage**: Resolvers fetch from execution cache to avoid RPC calls during tx building

### Vault Balance Cache ✅ (NEW)
- **Now pre-populated** before WebSocket subscriptions
- Updated in real-time when vault events arrive (line 1555)
- Used by pumpswap and meteora_balanced decoders for instant price calculation
- Eliminates RPC calls during pool updates

## Files Modified

- `backend/src/server/pools.ts`:
  - Added `preloadPumpswapVaultCache()` function (lines 470-546)
  - Added `preloadMeteoraBalancedVaultCache()` function (lines 548-624)
  - Call preload functions before pumpswap subscriptions (line 3867)
  - Call preload functions before meteora_balanced subscriptions (line 4006)

## Testing Recommendations

1. **Monitor startup logs** for vault cache preload success messages
2. **Check WebSocket aggregate logs** for pumpswap decode successes (not failures)
3. **Verify no more unhealthy reconnection loops** in production logs
4. **Confirm pool prices are updating** via frontend or graph snapshot API

## Related Issues

- Addresses: "unhealthy ws subscriptions loop since adding pump decoder"
- Prevents: Silent pool decode failures due to missing vault balance data
- Improves: WebSocket reliability and pool update latency

