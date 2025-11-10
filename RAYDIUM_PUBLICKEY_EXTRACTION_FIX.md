# Raydium AMM Foreign PublicKey Extraction Fix

## Issue Summary
Raydium AMM swap transactions were succeeding but not executing actual swaps. The swap instruction was being built but then silently dropped during transaction serialization.

## Root Cause
The `@raydium-io/raydium-sdk-v2` package uses a different version of `@solana/web3.js` than the main application. When `makeSwapFixedInInstruction` returns a `TransactionInstruction`, the PublicKey objects inside it are from the foreign web3.js instance and cannot be properly serialized by the application's web3.js instance.

### Symptoms
1. Transaction logs showed: `{"pid":"[object Object]","accounts":[{"pk":"[object Object]",...}]}`
2. Sender coercion errors: `"Non-base58 character"` when trying to normalize PublicKeys
3. Instruction silently dropped: 6 instructions sent instead of 7 (missing the Raydium swap)
4. Transaction succeeded but performed no swap (only ATA creation and SOL wrapping)

## Solution Applied

### File: `backend/src/execution/builder/ix.ts`

Added two layers of defense:

#### Layer 1: Enhanced Coercion Error Logging (Line 3512)
Changed silent error swallowing to explicit logging:
```typescript
} catch (coerceErr) {
  logger.error('raydium.amm.coerce.err', {
    cat: 'tx',
    ctx: {
      pool: hop.poolId,
      error: String((coerceErr as any)?.message || coerceErr),
      outLength: Array.isArray(out) ? out.length : 0
    }
  });
}
```

#### Layer 2: Instruction Validation & Aggressive Rebuild (Lines 3526-3635)

Added validation that checks if PublicKeys can be converted to base58. If not, triggers aggressive extraction using multiple methods:

**Method 1: Validated toBase58()**
- Calls `.toBase58()` but verifies result is a valid base58 string
- Checks length > 20 and doesn't contain 'object'

**Method 2: toBytes()**
- Extracts raw 32-byte array via `.toBytes()`
- Creates fresh PublicKey from bytes

**Method 3: toBuffer()**
- Extracts Buffer via `.toBuffer()`
- Creates fresh PublicKey from buffer

**Method 4: Internal BN Property**
- Accesses internal `._bn` or `.bn` property
- Uses `.toArrayLike(Uint8Array, 'be', 32)` to get raw bytes
- Fallback to `.toArray('be', 32)` if toArrayLike unavailable

**Method 5: String Fallback**
- Checks if already a valid base58 string
- Creates PublicKey directly

**Method 6: Diagnostic Logging**
- If all methods fail, logs detailed diagnostics about the object structure
- Shows which methods are available on the foreign PublicKey
- Lists object keys for debugging

### Key Features
- **Early Return on Success**: Each method returns immediately when successful, avoiding unnecessary attempts
- **Comprehensive Logging**: Tracks rebuild attempts and failures for debugging
- **Graceful Degradation**: Tries increasingly aggressive extraction methods
- **Detailed Error Messages**: Shows exactly which key index failed and why

## Testing
Run a Raydium AMM swap transaction and verify:
1. ✅ 7 instructions built (not 6)
2. ✅ No `[object Object]` in transaction logs
3. ✅ Raydium program ID (`675kPX9...`) appears in sent instructions
4. ✅ Actual swap executes on-chain
5. ✅ Token balances change appropriately

## Expected Log Messages

### Success Case
```
[INFO] raydium.amm.ix.rebuild {"pool":"58oQ...","ixIndex":0,"error":"Invalid programId"}
[INFO] raydium.amm.ix.rebuild.ok {"pool":"58oQ...","ixIndex":0,"keyCount":18}
[INFO] tx.build.ok {"ixCount":7,...}
```

### Failure Case (for further debugging)
```
[ERROR] raydium.amm.key.extraction.failed {
  "keyIdx": 1,
  "hasToBase58": true,
  "hasToBytes": false,
  "hasToBuffer": true,
  "hasBN": false,
  "typeof": "object",
  "keys": ["_bn","toBase58","toBuffer",...]
}
```

## Related Files
- `backend/src/execution/builder/ix.ts` - Main fix
- `backend/src/execution/builder/utils.ts` - Contains `normalizePublicKey()` helper
- `backend/src/execution/sender.ts` - Contains `toInstruction()` coercion logic

## Date
November 10, 2025

