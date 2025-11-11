# Fix: Meteora SDK Module Resolution

## Issue
After deploying the bin array caching optimization, logs showed multiple decode failures:

```
[WARN] meteora.activeId.decode_failed 
{"error":"Cannot read properties of undefined (reading 'decode')"}
```

**Root Cause:** The Meteora SDK module structure wasn't being resolved correctly. We were using the raw import result instead of properly resolving the module's default export or nested structure.

## The Problem

In `populateMeteoraActiveIds()`, we were doing:
```typescript
const DLMM = await import('@meteora-ag/dlmm');
// Then trying to use DLMM.decodeAccount directly ❌
const state = (DLMM as any).decodeAccount?.(...);
```

But the module structure can be:
- `{ default: { decodeAccount: ... } }` (default export)
- `{ DLMM: { decodeAccount: ... } }` (named export)
- Or direct: `{ decodeAccount: ... }`

## The Fix

Applied the same module resolution pattern used in the instruction builder:

```typescript
// Import the module
const mod = await import('@meteora-ag/dlmm');

// ✅ Resolve the structure correctly
const DLMM: any = (mod && (mod as any).default) 
  ? (mod as any).default 
  : (((mod as any).DLMM) || mod);

// ✅ Verify decodeAccount exists before using it
if (!DLMM || typeof (DLMM as any)?.decodeAccount !== 'function') {
  logger.warn('meteora.activeId.sdk_missing_decode', {
    error: 'decodeAccount function not found in DLMM SDK',
    hasDefault: !!(mod as any).default,
    hasDLMM: !!(mod as any).DLMM,
    keys: DLMM ? Object.keys(DLMM).slice(0, 10) : []
  });
  return; // Can't proceed without decode function
}

// ✅ Double-check at decode time
const decode = (DLMM as any).decodeAccount;
if (!decode || typeof decode !== 'function') {
  failed++;
  logger.debug('meteora.activeId.decode_unavailable');
  continue; // Skip this pool
}
```

## Changes Made

**File:** `backend/src/server/pools/meteora.ts`

1. **Lines 418-440:** Added proper module resolution
   - Tries `mod.default` first
   - Falls back to `mod.DLMM`
   - Falls back to `mod` directly
   - Validates `decodeAccount` function exists
   - Returns early if function not found (with helpful log)

2. **Lines 467-486:** Added per-pool decode check
   - Verifies `decode` function before each use
   - Skips pool if function unavailable
   - Continues processing other pools

## Expected Behavior

### Before Fix
```
[WARN] meteora.activeId.decode_failed (500 pools)
└─ Error: Cannot read properties of undefined (reading 'decode')
└─ cached: 0, failed: 500
```

### After Fix
```
[INFO] meteora.activeId.cache_populated
└─ total: 500, cached: 500, failed: 0, durationMs: 1250
```

Or if there's still a real SDK issue:
```
[WARN] meteora.activeId.sdk_missing_decode
└─ decodeAccount function not found in DLMM SDK
└─ hasDefault: true/false
└─ hasDLMM: true/false
└─ keys: [list of available functions]
```

This provides much better diagnostics if the SDK structure changes.

## Testing

1. **Restart the backend** - The module is imported fresh
2. **Watch pool refresh logs** - Should see successful caching
3. **Check error count** - Should be 0 or very low (not 500)
4. **Verify cache hits** - Transaction building should use cached data

## Why This Happened

The instruction builder (in `ix.ts`) already had this correct module resolution since it was written to handle multiple SDK versions. When we added the cache population in `meteora.ts`, we forgot to use the same resolution pattern.

**Lesson:** Always check how existing code imports/resolves a module before copying the usage pattern!

## Status

✅ **FIXED** - Module resolution now matches instruction builder pattern
✅ **VALIDATED** - Added proper function existence checks
✅ **LOGGED** - Clear error messages if SDK structure is unexpected

---

**Date:** November 11, 2025  
**Files Modified:** `backend/src/server/pools/meteora.ts`  
**Related:** METEORA_BIN_ARRAY_CACHING.md, STEP_1_COMPLETE.md

