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

### Diagnostic Evidence
```json
{
  "keyIdx": 1,
  "hasToBase58": false,
  "hasToBytes": false,
  "hasToBuffer": false,
  "hasBN": true,
  "typeof": "object",
  "keys": ["_bn"]
}
```

The foreign PublicKey objects only contained a `_bn` property with no standard accessor methods.

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

#### Layer 2: Instruction Validation & Aggressive Rebuild (Lines 3526-3725)

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

**Method 4: Internal BN Property (ENHANCED)**
- **4a: toArrayLike()** - Uses `bn.toArrayLike(Uint8Array, 'be', 32)`
- **4b: toArray()** - Uses `bn.toArray('be', 32)`
- **4c: Direct words array access** - Reads BN.js internal `words` array and reconstructs 32-byte buffer
- **4d: toString(16) hex conversion** - Converts BN to hex string, then parses to bytes
- **4e: Diagnostic logging** - Logs detailed BN structure if all methods fail

**Method 5: String Fallback**
- Checks if already a valid base58 string
- Creates PublicKey directly

**Method 6: Diagnostic Logging**
- If all methods fail, logs detailed diagnostics about the object structure
- Shows which methods are available on the foreign PublicKey
- Lists object keys for debugging

### Key Features
- **Early Return on Success**: Each method returns immediately when successful, avoiding unnecessary attempts
- **Individual Error Handling**: Each BN extraction method has its own try-catch and logging
- **Low-Level BN Access**: Direct access to BN.js `words` array for cases where methods don't exist
- **Comprehensive Logging**: Tracks rebuild attempts and failures for debugging
- **Graceful Degradation**: Tries increasingly aggressive extraction methods
- **Detailed Error Messages**: Shows exactly which key index failed and why

## Testing
Run a Raydium AMM swap transaction and verify:
1. ✅ 7 instructions built (not 6)
2. ✅ No `[object Object]` in transaction logs
3. ✅ Raydium program ID (`675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8`) appears in sent instructions
4. ✅ Actual swap executes on-chain
5. ✅ Token balances change appropriately

## Expected Log Messages

### Success Case
```
[INFO] raydium.amm.ix.rebuild {"pool":"58oQ...","ixIndex":0,"error":"Invalid programId"}
[INFO] raydium.amm.ix.rebuild.ok {"pool":"58oQ...","ixIndex":0,"keyCount":18}
[INFO] tx.build.ok {"ixCount":7,...}
```

### Intermediate Debugging (BN extraction attempts)
```
[DEBUG] bn.toArrayLike.failed {"keyIdx":1,"error":"..."}
[DEBUG] bn.toArray.failed {"keyIdx":1,"error":"..."}
[DEBUG] bn.words.failed {"keyIdx":1,"error":"..."}
[DEBUG] bn.toString.failed {"keyIdx":1,"error":"..."}
```

### Failure Case (for further debugging)
```
[ERROR] raydium.amm.bn.structure {
  "keyIdx": 1,
  "bnType": "object",
  "bnConstructor": "BN",
  "bnKeys": ["negative","words","length","red"],
  "hasToArrayLike": "function",
  "hasToArray": "function",
  "hasWords": true,
  "hasToString": "function"
}
```

## Related Files
- `backend/src/execution/builder/ix.ts` - Main fix (lines 3512-3725)
- `backend/src/execution/builder/utils.ts` - Contains `normalizePublicKey()` helper
- `backend/src/execution/sender.ts` - Contains `toInstruction()` coercion logic

## Technical Details

### BN.js Words Array Structure
The low-level `words` array extraction (Method 4c) works by:
1. Accessing the internal BN.js `words` array which stores the number as 26-bit limbs
2. Converting each word to a 32-bit unsigned integer
3. Writing them into a 32-byte buffer in big-endian order
4. Creating a PublicKey from the resulting buffer

This is a last-resort method when standard BN methods don't exist on the foreign BN object.

## Date
November 10, 2025

## Updates
- **v1**: Initial fix with basic BN extraction
- **v2**: Enhanced BN extraction with 4 sub-methods and detailed diagnostics

