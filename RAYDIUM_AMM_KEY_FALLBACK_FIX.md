# Raydium AMM Instruction Rebuild Fix - Fallback to Cached Keys

## Date
November 10, 2025

## Problem
After implementing execution cache population with market accounts, the transaction was still failing with `Custom Error 27`. Investigation revealed that:

1. ✅ Execution cache had all correct market account addresses
2. ✅ `poolKeys` was populated from execution cache
3. ❌ Raydium SDK returned instruction with keys as `[object Object]`
4. ❌ Instruction rebuild attempted to extract PublicKeys but failed
5. ❌ Failed keys were converted to placeholder addresses starting with "11111"
6. ❌ Transaction failed on-chain due to invalid accounts

### Evidence

From logs:
```
[ERROR] raydium.amm.coerce.err {"error":"Invalid PublicKey: primary=[object Object]"}
[WARN] raydium.amm.ix.rebuild
[INFO] raydium.amm.ix.rebuild.ok {"keyCount":18}
```

Failing instruction accounts:
```
Index 9: "1111171KA2hYSSXCcKeSgGAh9fUhcG71eCdxTacXs6"  ❌ placeholder
Index 10: "111112SsuhgYMPSYmKshrt7coi6cVEjxhqY1zMx6wR"  ❌ placeholder
Index 11: "111113b9XNimAaQZgGbxPdET1MYBKVWPERKcTsBcH3"  ❌ placeholder
```

Expected (from poolCache):
```
Index 9: "CxoLXAkNEexLHK5ukudpfTdojbeQAmevYP68542TZx8S"  ✅ market_bids
Index 10: "3t5LLKXMnsCAgQnCusEgLR7f4qMDJQf9v6Z3mxBemdfd"  ✅ market_asks
Index 11: "6A5NHCj1yF6urc9wZNe6Bcjj4LVszQNj5DwAWG97yzMu"  ✅ market_event_queue
```

## Root Cause

The instruction rebuild code (around line 3770) tried multiple methods to extract PublicKeys from the foreign SDK objects:
- `toBase58()` - returned `"[object Object]"`
- `toBytes()` - failed
- `toBuffer()` - failed
- BN extraction - failed

When all extraction methods failed, the code either:
- Returned `null` (filtered out later)
- Threw an error
- Created placeholder keys somehow

**But the correct values were already in `poolKeys`** from the execution cache!

## Solution

Modified the instruction rebuild logic to use cached `poolKeys` values as fallback when SDK key extraction fails.

### Implementation

**File**: `backend/src/execution/builder/ix.ts` (Lines 3770-4000)

#### 1. Created Fallback Function

Added `buildKeyFromPoolKeys()` function that maps key indices to poolKeys fields:

```typescript
const buildKeyFromPoolKeys = (keyIdx: number): PublicKey | null => {
  switch (keyIdx) {
    case 0: return TOKEN_PROGRAM_ID;
    case 1: return poolKeys?.id;
    case 2: return poolKeys?.authority;
    case 3: return poolKeys?.openOrders;
    case 4: return poolKeys?.targetOrders;
    case 5: return poolKeys?.vault?.A;
    case 6: return poolKeys?.vault?.B;
    case 7: return poolKeys?.marketProgramId;
    case 8: return poolKeys?.marketId;
    case 9: return poolKeys?.marketBids;         // ← Critical!
    case 10: return poolKeys?.marketAsks;        // ← Critical!
    case 11: return poolKeys?.marketEventQueue;  // ← Critical!
    case 12: return poolKeys?.marketBaseVault;
    case 13: return poolKeys?.marketQuoteVault;
    case 14: return poolKeys?.marketAuthority;
    case 15: return toPublicKey(hop.userSourceAta);
    case 16: return toPublicKey(hop.userDestAta);
    case 17: return kp.publicKey;
    default: return null;
  }
};
```

#### 2. Added Fallback for Undefined Keys

When a key is undefined/null, immediately use fallback:

```typescript
if (!rawKey || rawKey === undefined || rawKey === null) {
  const fallback = buildKeyFromPoolKeys(keyIdx);
  if (fallback) {
    return { pubkey: fallback, isSigner: !!k?.isSigner, isWritable: !!k?.isWritable };
  }
  return null; // Skip if no fallback available
}
```

#### 3. Added Fallback for Extraction Failures

When all extraction methods fail, use fallback before throwing error:

```typescript
} catch (keyErr) {
  // Final fallback: use poolKeys mapping
  try {
    const fallback = buildKeyFromPoolKeys(keyIdx);
    if (fallback) {
      logger.info('raydium.amm.key.fallback_used', {
        keyIdx,
        fallbackAddress: fallback.toBase58().slice(0, 8) + '...',
        originalError: String(keyErr?.message)
      });
      return { pubkey: fallback, isSigner: !!k?.isSigner, isWritable: !!k?.isWritable };
    }
  } catch {}
  
  throw new Error(`Failed to normalize key at index ${keyIdx}: ${keyErr?.message}`);
}
```

## Expected Behavior After Fix

### Build Phase
1. SDK returns instruction with `[object Object]` keys
2. Rebuild triggered due to invalid programId
3. For each key, attempt extraction methods
4. When extraction fails → Use `buildKeyFromPoolKeys()` fallback
5. Fallback returns correct address from `poolKeys` (from execution cache)
6. Instruction built with all correct accounts

### Log Messages
```
[INFO] raydium.amm.key.fallback_used (for indices 9, 10, 11, etc.)
[INFO] raydium.amm.ix.rebuild.ok {"keyCount":18}
```

### Transaction
```
Index 9: "CxoLXAkNEexLHK5ukudpfTdojbeQAmevYP68542TZx8S"  ✅ market_bids
Index 10: "3t5LLKXMnsCAgQnCusEgLR7f4qMDJQf9v6Z3mxBemdfd"  ✅ market_asks
Index 11: "6A5NHCj1yF6urc9wZNe6Bcjj4LVszQNQ5DwAWG97yzMu"  ✅ market_event_queue
```

Transaction should now succeed on-chain!

## Benefits

1. ✅ **Resilient**: Doesn't depend on SDK key format
2. ✅ **Fast**: No additional RPC calls (uses cache)
3. ✅ **Accurate**: Uses authoritative data from chain
4. ✅ **Observable**: Logs when fallback is used
5. ✅ **Maintainable**: Clear mapping of indices to accounts

## Testing

### Immediate Test
Restart backend and attempt the failing swap:
- SOL → USDC via pool `58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2`

### Expected Logs
```
[INFO] raydium.amm.key.fallback_used {"keyIdx":9,"fallbackAddress":"CxoLXAkN..."}
[INFO] raydium.amm.key.fallback_used {"keyIdx":10,"fallbackAddress":"3t5LLKXM..."}
[INFO] raydium.amm.key.fallback_used {"keyIdx":11,"fallbackAddress":"6A5NHCj1..."}
[INFO] raydium.amm.ix.rebuild.ok {"keyCount":18}
[INFO] tx.preflight.ok
```

### Success Criteria
- ✅ No placeholder addresses in instruction
- ✅ All 18 accounts are valid base58 PublicKeys
- ✅ Transaction preflight succeeds
- ✅ Transaction executes on-chain successfully

## Related Changes

This fix completes the chain of fixes:

1. **Market Account Fetching** (`raydium.ts`) - Fetch Serum market accounts from chain
2. **Execution Cache Population** (`pools.ts`, `cache.ts`) - Store market accounts in cache
3. **PoolKeys Population** (`ix.ts` line 3465) - Read from cache into poolKeys
4. **Fallback Mechanism** (`ix.ts` line 3770) - **This fix** - Use poolKeys when SDK fails

## Files Modified

- **backend/src/execution/builder/ix.ts** (Lines 3770-4000)
  - Added `buildKeyFromPoolKeys()` function
  - Added fallback for undefined keys
  - Added fallback for extraction failures
  - Added logging for fallback usage

## Why This Fix is Needed

The Raydium SDK is returning instruction structures with keys in a foreign format that our PublicKey extraction logic can't handle. Rather than trying to fix the extraction logic for every possible SDK version and format, we use a more robust approach:

**Use the SDK for structure, use our cache for data.**

The SDK tells us "you need 18 accounts in this order", and our cache provides the actual correct addresses for those accounts.

## Next Steps

1. Test the swap transaction
2. If successful, consider removing some of the aggressive extraction methods (Methods 4d, 4e) since we now have a robust fallback
3. Monitor logs for `raydium.amm.key.fallback_used` to understand which keys consistently fail extraction


