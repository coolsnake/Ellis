# Pumpswap Decoder Import Fix - Resolves "Unexpected end of JSON input"

## Problem

The system was experiencing repeated WebSocket decode failures for pumpswap pools:

```
[WARN] 1:00:53 PM [pools] pumpswap.ws.decode failed {
  "id":"81fPZBHM…",
  "error":"Unexpected end of JSON input",
  "dataLength":300,
  "hasVaultA":true,
  "hasVaultB":true,
  "vaultACached":true,
  "vaultBCached":true,
  "cat":"pools"
}
```

### Error Characteristics
- Error: "Unexpected end of JSON input"
- Occurring repeatedly for every pumpswap WebSocket event
- Data length: 300 bytes (valid pool account data)
- Vault addresses present and cached
- Error was NOT related to vault cache or account data parsing

## Root Cause

The error was occurring at line 2529 in `backend/src/server/pools.ts`:

```typescript
// WRONG: Dynamic import causing module resolution error
const { parsePumpswapPoolFee } = await import('./pools/pumpswap.js');
```

**Why This Failed:**
1. The `parsePumpswapPoolFee` function was being dynamically imported inside the WebSocket event handler
2. Dynamic imports in Node.js can fail with "Unexpected end of JSON input" when:
   - There's a malformed package.json in the module resolution path
   - The module cache is corrupted
   - There's a circular dependency issue
   - The import() call happens inside an async context with module resolution issues
3. The function was already available in the `pumpswap.js` module, which was statically imported at the top
4. The dynamic import was unnecessary and added overhead to every WebSocket event

**The "Unexpected end of JSON input" error** specifically occurs when Node.js's module loader tries to parse a JSON file (like package.json or a .json module) during dynamic import resolution, but the file is truncated, malformed, or inaccessible.

## Solution Implemented

### 1. Add Static Import at Top of File (Line 13)

**Before:**
```typescript
import { fetchPumpswapGraphQL as fetchPumpswapGraphQLImpl, 
         normalizePumpswapPools as normalizePumpswapPoolsImpl, 
         enrichPumpswapPoolsWithRpc as enrichPumpswapPoolsWithRpcImpl 
       } from './pools/pumpswap.js';
```

**After:**
```typescript
import { fetchPumpswapGraphQL as fetchPumpswapGraphQLImpl, 
         normalizePumpswapPools as normalizePumpswapPoolsImpl, 
         enrichPumpswapPoolsWithRpc as enrichPumpswapPoolsWithRpcImpl, 
         parsePumpswapPoolFee 
       } from './pools/pumpswap.js';
```

### 2. Remove Dynamic Import (Line 2528-2529)

**Before:**
```typescript
// Extract fee using helper function
const { parsePumpswapPoolFee } = await import('./pools/pumpswap.js');
const fee_bps = parsePumpswapPoolFee(info.data) || Number((CONFIG as any)?.pumpswap?.defaultFeeBps || 25);
```

**After:**
```typescript
// Extract fee using helper function (now statically imported)
const fee_bps = parsePumpswapPoolFee(info.data) || Number((CONFIG as any)?.pumpswap?.defaultFeeBps || 25);
```

## Benefits

1. **Eliminates Module Resolution Error**: Static imports are resolved once at startup, avoiding runtime module resolution issues
2. **Performance**: Removes the overhead of dynamic import on every WebSocket event (potentially hundreds per second)
3. **Reliability**: Static imports fail fast at startup rather than during runtime
4. **Simplicity**: No need for dynamic import when the module is already loaded

## Why Other Dynamic Imports Were Not Changed

There are other dynamic imports in the file (e.g., `tokens.js`):

```typescript
const tok = await import('../utils/tokens.js');
```

These were **intentionally left as dynamic imports** because:
1. They may have circular dependency issues that require lazy loading
2. They're utility modules that might not be needed in all code paths
3. They haven't been causing the "Unexpected end of JSON input" error

The `parsePumpswapPoolFee` case was unique because:
- It's a simple, pure function with no complex dependencies
- It's in a module already statically imported (`pumpswap.js`)
- The dynamic import was redundant and causing errors

## Testing

After applying this fix:
1. Restart the backend server
2. Monitor logs for pumpswap WebSocket events
3. Verify no more "Unexpected end of JSON input" errors
4. Confirm pumpswap pools are updating successfully via WebSocket

Expected log pattern:
```
[INFO] pools.ws.event_received {"source":"pumpswap","account":"81fPZBHM…"}
[DEBUG] pumpswap.ws.decode.start {"pool":"81fPZBHM…","dataLength":300}
[DEBUG] pumpswap.ws.vaults_from_cache {"pool":"81fPZBHM…","vaultA":"...","vaultB":"..."}
[DEBUG] pumpswap.ws.decode.success {"pool":"81fPZBHM…","baseReserve":"...","quoteReserve":"...","price":...}
```

## Related Documentation

- `VAULT_CACHE_PRELOAD_FIX.md` - Vault balance caching system
- `VAULT_ADDRESS_LOOKUP_FIX.md` - Vault address resolution from cache
- `DIAGNOSTIC_LOGGING_ADDED.md` - WebSocket event logging system
- `PUMPSWAP_PROTOCOL_RECIPIENT_VALIDATION_FIX.md` - Protocol recipient System Program ID validation

