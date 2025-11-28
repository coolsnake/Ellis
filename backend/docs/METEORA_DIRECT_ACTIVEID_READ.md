# Meteora DLMM Account Decoding

## Current Status (Updated November 28, 2025)

**⚠️ IMPORTANT: Direct binary reading at fixed offsets is UNRELIABLE.**

Testing has confirmed that the SDK's `program.coder.accounts.decode('lbPair', data)` is the **only reliable method** for reading Meteora DLMM account data.

## Why Direct Binary Offsets Don't Work

Diagnostic logging revealed that documented binary offsets return garbage values:

```
sdk_activeId: 35149          ← Correct (from SDK decode)
binary_activeId_240: 980298058  ← WRONG (constant garbage across all pools)
binary_activeId_180: -866161189 ← WRONG (varies but clearly incorrect)
```

The SDK-decoded value (35149) produces correct prices (~$0.034), while the binary offsets return nonsensical values.

### Offset 240 Returns Constant Garbage
The same value (980298058) appears for different pools with different actual activeIds - this proves offset 240 is reading from the wrong memory location.

### Offset 180 Returns Variable Garbage
Different values per pool, but none match the SDK-decoded values.

## The Correct Approach: SDK Decode

```typescript
import { createProgram } from '@meteora-ag/dlmm';

const program = createProgram(connection);
const state = program.coder.accounts.decode('lbPair', accountData);

// Access fields directly from decoded state
const activeId = state.activeId;      // Correct!
const binStep = state.binStep;        // Correct!
const tokenXMint = state.tokenXMint;  // Correct!
const tokenYMint = state.tokenYMint;  // Correct!
```

### SDK Returns These Fields

From diagnostic logging, the SDK returns these keys:
```
["parameters", "vParameters", "bumpSeed", "binStepSeed", "pairType", 
 "activeId", "binStep", "status", "requireBaseFactorSeed", "baseFactorSeed",
 "activationType", "creatorPoolOnOffControl", "tokenXMint", "tokenYMint", 
 "reserveX", ...]
```

## Historical Context

### Original Problem (November 11, 2025)
The SDK's `decodeAccount` function had initialization issues:
```
[WARN] meteora.activeId.decode_failed 
{"error":"Cannot read properties of undefined (reading 'decode')"}
```

### Original "Solution" (Now Deprecated)
Direct binary reading was attempted as a workaround:
```typescript
// ❌ DEPRECATED - This doesn't work reliably!
const ACTIVE_ID_OFFSET = 240;
const activeId = Buffer.from(acc.data).readInt32LE(ACTIVE_ID_OFFSET);
```

### Actual Solution (Current)
Use `createProgram()` from `@meteora-ag/dlmm` which properly initializes the Anchor coder:
```typescript
// ✅ CORRECT - Use SDK decode
const program = createProgram(connection);
const state = program.coder.accounts.decode('lbPair', data);
const activeId = state.activeId;
```

## Why the Offsets Were Wrong

The documented offset table was likely:
1. Based on an older version of the Meteora program
2. Not accounting for Anchor's 8-byte discriminator handling
3. Derived from incomplete reverse-engineering

Solana/Anchor account layouts can vary based on:
- Program version
- Account type discriminators
- Padding/alignment
- Optional fields

## Current Implementation

The WebSocket decoder in `backend/src/server/pools/websockets/decoders/meteora.ts`:
1. Uses `program.coder.accounts.decode('lbPair', data)` - ✅ Correct
2. Extracts `activeId`, `binStep`, `tokenXMint`, `tokenYMint` from decoded state
3. Produces correct prices via the price pipeline

## Deprecated Code Locations

The following locations have incorrect binary offset reads that should NOT be relied upon:

1. **`backend/src/execution/utils/altManager.ts`** - Uses offset 180 for activeId
   - This is only used for ALT population, not price calculation
   - Should be updated to use SDK decode

2. **`backend/scripts/analyze-meteora-pool.ts`** - Reference script with offset 240
   - For analysis/debugging only
   - Shows both approaches for comparison

## Verification

Prices calculated from SDK-decoded values match expected market prices:
- `activeId: 35149, binStep: 1` → `priceForward: 0.0336` ✓
- `activeId: 15595, binStep: 1` → `priceForward: 0.2102` ✓

The formula `(1 + binStep/10000)^activeId` with SDK values produces correct results.

---

**Last Updated:** November 28, 2025  
**Conclusion:** Always use SDK decode for Meteora DLMM accounts. Direct binary offsets are unreliable.
