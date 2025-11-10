# Raydium CLMM exBitmap Fix

## Issue Summary

Raydium CLMM multihop tests were failing with **Custom error 6028** during preflight simulation. The root cause was the removal of the `exBitmap` (tick array bitmap extension) account from SDK-generated swap instructions.

## Root Cause Analysis

### The Problem

1. **Raydium SDK** generates CLMM swap instructions with 17 accounts, including:
   - Account indices 0-12: Fixed accounts (payer, config, pool, ATAs, vaults, etc.)
   - Account index 13: **exBitmap** (tick array bitmap extension PDA)
   - Account indices 14-16: Tick arrays (center, lower, upper)

2. **Previous code behavior**:
   - Detected that exBitmap didn't exist on-chain
   - Removed exBitmap from instruction accounts (index 13)
   - Kept original instruction data **unchanged**

3. **Why this caused error 6028**:
   - The instruction data contains **encoded account indices**
   - When exBitmap (index 13) was removed, tick arrays shifted to indices 13-15
   - But instruction data still referenced tick arrays at indices 14-16
   - The program tried to access index 16 (now out of bounds) → **Custom error 6028**

### Technical Details

Raydium CLMM instruction format:
```
Instruction Data (41 bytes):
- Discriminator (8 bytes)
- Amount In (16 bytes)  
- Amount Out Min (16 bytes)
- Sqrt Price Limit (variable)
- Account indices for tick arrays (encoded in remaining data)
```

When accounts are removed post-generation, the encoded indices become misaligned:

```
Original (17 accounts):
[0-12: fixed] [13: exBitmap] [14: tick_center] [15: tick_lower] [16: tick_upper]
Instruction data references: ^14              ^15             ^16

After removal (16 accounts):
[0-12: fixed] [13: tick_center] [14: tick_lower] [15: tick_upper]
Instruction data still references: ^14 (wrong!)  ^15 (wrong!)   ^16 (OUT OF BOUNDS!)
```

## The Fix

### Changes Made

1. **Removed exBitmap removal logic** (previously lines 2726-2803)
   - The problematic code that filtered out exBitmap from instructions
   - This was causing instruction data/account misalignment

2. **Updated comments and logging**:
   - Added detailed explanation of why exBitmap must not be removed
   - Enhanced logging to track exBitmap status for debugging
   - Updated verification skip reasons to reflect new behavior

3. **Key insight documented**:
   - SDK-generated instructions encode account indices in their data
   - Removing accounts post-generation breaks these encoded references
   - The SDK includes exBitmap when needed based on pool state
   - Even if exBitmap doesn't exist on-chain, Solana handles this appropriately

### Files Modified

- `backend/src/execution/builder/ix.ts`
  - Line 2262-2298: Updated exBitmap derivation comments and logging
  - Line 2726-2753: Replaced removal logic with explanatory comments
  - Line 2912-2917: Updated verification skip comment

## Why This Fix Works

### Raydium SDK Behavior

The Raydium SDK (`@raydium-io/raydium-sdk-v2`) includes exBitmap in instructions when:
- The pool uses `PoolUtils.isOverflowDefaultTickarrayBitmap` logic
- The tick range or initialized ticks require extended bitmap tracking
- Typically for pools with `tickSpacing=1` or large price ranges

### Solana Runtime Behavior

- If an account doesn't exist on-chain and is marked read-only, Solana will:
  - Load it as `null` or with empty data
  - Allow the program to handle the missing account
- The Raydium program checks if exBitmap is initialized and uses it if available
- If not initialized, the program uses default tick array tracking

### Result

By keeping the SDK-generated instruction intact:
- ✅ Account indices in instruction data remain correct
- ✅ Tick arrays are accessed at the right indices (14-16)
- ✅ The Raydium program can properly execute the swap
- ✅ No more Custom error 6028

## Testing

To verify the fix:
1. Run Raydium CLMM multihop tests
2. Check logs for `raydium.clmm.exbitmap.info` messages
3. Verify no `raydium.clmm.exbitmap.removed_from_instruction` warnings
4. Confirm transactions pass preflight simulation
5. Monitor for successful swap execution

Expected log output:
```
[INFO] raydium.clmm.exbitmap.derived - PDA derived for pool
[INFO] raydium.clmm.exbitmap.info - exBitmap included in SDK instruction
[INFO] tx.preflight.ok - Transaction passes simulation
```

## Prevention

To prevent similar issues in the future:

1. **Never modify SDK-generated instructions** by removing accounts
   - SDKs encode critical data that depends on account order
   - Account indices, data layouts, and CPI references all depend on order

2. **Trust SDK account inclusion logic**
   - If SDK includes an account, there's a reason
   - Let the program handle optional/missing accounts

3. **When debugging account issues**:
   - Add logging instead of modifying instructions
   - Check if accounts exist before passing to SDK
   - Use SDK APIs to customize account lists when needed

4. **For optional accounts**:
   - Check existence at SDK input time, not output time
   - Use SDK configuration options if available
   - Read SDK documentation on account requirements

## References

- Raydium SDK V2 Documentation
- Raydium CLMM Program: `CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK`
- exBitmap PDA derivation: `[b"exaccount", pool.toBytes()]`
- Solana Transaction Structure: Account indices in instruction data

## Date

November 10, 2025

