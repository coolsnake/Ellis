# Meteora DLMM Bitmap Extension Caching Implementation

## Problem

Meteora DLMM swaps were failing with error 6036 "Bitmap extension account is not provided" for some pools (e.g., cbBTC-WSOL) while succeeding for others (e.g., JLP-USDC).

## Root Cause

The code was hardcoded to always pass the DLMM program ID as the `binArrayBitmapExtension` account. However:
- **Some pools** (with many active bins/wide price ranges) have an initialized bitmap extension PDA on-chain and **require** it
- **Other pools** (with fewer active bins/tighter liquidity) don't have a bitmap extension and work fine with just the program ID

## Solution

Implemented a caching system that:
1. Checks for bitmap extension existence **during pool normalization** (once per pool update)
2. Stores the correct account (PDA or program ID) in pool data
3. Uses the cached value during instruction building (no RPC latency)

## Changes Made

### 1. Pool Data Structure (`backend/src/server/pools/types.ts`)
- Field already existed: `bin_array_bitmap_extension?: string;`

### 2. Pool Normalization (`backend/src/server/pools/meteora.ts`)
Added bitmap extension derivation and checking logic at lines 306-369:
- Derives the PDA using seeds: `['bitmap_extension', pool_address]`
- Checks if it exists on-chain with `getAccountInfo()`
- Stores PDA if it exists, program ID otherwise
- Logs the decision with `logger.info()`

### 3. DirectHop Type (`backend/src/execution/types.ts`)
Added field at line 63:
```typescript
bitmapExtension?: string;  // Meteora DLMM bitmap extension (PDA or program ID)
```

### 4. Resolver (`backend/src/execution/resolver/meteora.ts`)
Updated at lines 40-61:
- Passes `bin_array_bitmap_extension` from pool data to hop
- Logs the bitmap extension status

### 5. Instruction Builder (`backend/src/execution/builder/ix.ts`)
Updated at lines 1358-1375:
- Uses cached `hop.bitmapExtension` if available
- Falls back to program ID if not cached
- Logs whether using cache or fallback

## Benefits

✅ **No RPC latency** during instruction building (critical for arb)  
✅ **One-time check** per pool update (not per swap)  
✅ **Automatic detection** - no manual pool configuration needed  
✅ **Backward compatible** - falls back to program ID if cache miss  
✅ **Works for all pool types** - handles both scenarios dynamically  

## PDA Derivation

The bitmap extension PDA is derived using:
```typescript
const [bitmapExtPda] = PublicKey.findProgramAddressSync(
  [Buffer.from('bitmap_extension'), poolPk.toBuffer()],
  programId
);
```

Where:
- `poolPk` = the pool's public key
- `programId` = `LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo` (Meteora DLMM program)

## Testing

To verify the implementation works:
1. Wait for pool refresh to cache bitmap extensions
2. Check logs for `meteora.bitmap_ext.found` (pools with PDA) or `meteora.bitmap_ext.not_found_using_programid` (pools without)
3. Execute swaps on both pool types:
   - JLP-USDC (likely no bitmap ext)
   - cbBTC-WSOL (likely has bitmap ext)
4. Verify both succeed and logs show `meteora.dlmm.bitmap_ext.from_pool_cache`

## Future Considerations

- The bitmap extension might need to be re-checked if pools are upgraded/modified
- Currently checked on every pool refresh, which should catch any changes
- Monitor logs for `bitmap_ext.check_failed` which indicates RPC issues during caching

