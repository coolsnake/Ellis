# Meteora DLMM Bitmap Extension Tuple Fix

## Issue Summary

**Date**: 2025-11-11  
**Error Code**: TX.BUILD.HOP.ERR  
**Component**: Meteora DLMM Swap Instruction Builder

### Problem

Meteora DLMM swap instruction building was failing with the error:

```
Wrong input type for account "binArrayBitmapExtension" in the instruction accounts object 
for instruction "swap". Expected PublicKey or string.
```

The logs showed that `binArrayBitmapExtension` was being set to a value like:
```
"3rmT9Pek6BmyNcoqfww3ia1HK4Vo1rTZLVHqHV9u1oyT,254"
```

This is the string representation of a tuple `[PublicKey, number]` from `PublicKey.findProgramAddressSync()`.

### Root Cause

In `backend/src/execution/builder/ix.ts` at line 1121, the SDK function `deriveBinArrayBitmapExtension` was returning the full tuple `[PublicKey, number]` (similar to `findProgramAddressSync`'s return value), but the code was treating it as a single `PublicKey`.

The tuple `[address: PublicKey, bumpSeed: number]` was being passed to the SDK's accounts object, which only accepts a `PublicKey` or string address. When logged with `String()`, the tuple became `"address,bumpSeed"`.

### Solution

Modified the bitmap extension derivation logic to handle both return types:

**File**: `backend/src/execution/builder/ix.ts` (lines 1117-1154)

**Changes**:
1. Store the result of `deriveFn()` in a temporary variable
2. Check if the result is an array (tuple)
3. If it's an array, extract only the first element (the PublicKey)
4. Otherwise, use the result directly if it's already a PublicKey
5. Added debug logging when tuple extraction occurs

```typescript
const derived = deriveFn(poolPk, programId);
// Handle both PublicKey and [PublicKey, number] tuple returns
// Some SDK versions return the full findProgramAddressSync tuple
if (Array.isArray(derived)) {
  binArrayBitmapExtension = derived[0];
  logger.debug('meteora.dlmm.bitmap_ext.tuple_extracted', { ... });
} else if (derived instanceof PublicKey) {
  binArrayBitmapExtension = derived;
} else if (derived && typeof derived.toBase58 === 'function') {
  binArrayBitmapExtension = derived;
}
```

### Testing

After the fix:
1. The `binArrayBitmapExtension` will be correctly extracted from tuples
2. The account will be a proper `PublicKey` instance when passed to the SDK
3. Meteora DLMM swaps should build successfully
4. Debug logs will indicate when tuple extraction occurs

### Impact

- **Severity**: High (blocking all Meteora DLMM swaps)
- **Affected Component**: Transaction building for Meteora DLMM pools
- **Fix Type**: Defensive programming - handles SDK behavior variations
- **Backward Compatible**: Yes - works with both tuple and direct PublicKey returns

### Related Files

- `backend/src/execution/builder/ix.ts` - Main fix location
- `backend/src/server/pools/meteora.ts` - Correct tuple handling already present (line 313)
- `backend/src/execution/cache.ts` - Cache type definition (expects string)

### Verification

Monitor logs for:
- `meteora.dlmm.bitmap_ext.tuple_extracted` - Confirms tuple was handled
- `meteora.dlmm.swap.ok` - Confirms successful swap instruction building
- Absence of `TX.BUILD.HOP.ERR` with "Wrong input type" message

### Notes

The SDK function `deriveBinArrayBitmapExtension` behavior may vary across versions. This fix ensures compatibility regardless of whether the SDK returns:
- A tuple `[PublicKey, number]` (like `findProgramAddressSync`)
- A direct `PublicKey` instance
- Any object with a `toBase58()` method

