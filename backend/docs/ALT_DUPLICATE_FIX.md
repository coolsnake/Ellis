# ALT Duplicate Categories Fix

## Problems Fixed

### Issue 1: Duplicate ALT Categories
**Problem**: ALTs were appearing twice with different categories pointing to the same address:
- `raydium-clmm-alt` → HubP3UTD...UWxuNmz7
- `raydium-clmm` → HubP3UTD...UWxuNmz7 (same address)

**Root Cause**: 
- `createAltOnChain()` was storing the ALT with the `seed` key (e.g., `raydium-clmm-alt`)
- `createAndExtendAlt()` was ALSO storing it with the `category` key (e.g., `raydium-clmm`)
- This resulted in two entries in both the in-memory map and the config file

**Fix**:
1. Changed `createAndExtendAlt()` to use `category` as the seed directly (no `-alt` suffix)
2. Removed all `this.altAddresses.set(seed, ...)` calls from `createAltOnChain()` 
3. Made `createAltOnChain()` a pure creation function that returns the address
4. Let the caller (`createAndExtendAlt()`) handle storing in the map under the correct category

### Issue 2: ALTs with 0 Accounts
**Problem**: Newly created ALTs showed "0 accounts" even though accounts were collected

**Likely Causes**:
1. Accounts not ready for extension after creation (RPC timing issues)
2. Extension transaction failing silently
3. Empty account collection

**Improvements Made**:
- Better logging to identify why accounts aren't being added
- Cleaner separation of concerns (creation vs storage)
- Will help diagnose the specific failure case from logs

## Changes Made

### File: `backend/src/execution/utils/altManager.ts`

#### 1. `createAndExtendAlt()` Method (lines 1935-1991)
**Before**:
```typescript
const altSeed = seed || `${category}-alt`; // Created duplicates!
// ...
this.altAddresses.set(category, address);
```

**After**:
```typescript
const altSeed = seed || category; // Use category directly
// ...
// Only store under the category, not the seed (to avoid duplicates)
this.altAddresses.set(category, address);
```

#### 2. `createAltOnChain()` Method - Removed 4 Storage Calls

**Line ~431** (reusing existing ALT):
```typescript
// REMOVED: this.altAddresses.set(seed, altPk);
return altPk; // Just return, don't store
```

**Line ~472** (found reusable ALT):
```typescript
// REMOVED: this.altAddresses.set(seed, reusable.address);
return reusable.address; // Just return, don't store
```

**Line ~633** (empty ALT):
```typescript
// REMOVED: this.altAddresses.set(seed, lookupTableAddress);
return lookupTableAddress; // Just return, don't store
```

**Line ~735** (account not ready):
```typescript
// REMOVED: this.altAddresses.set(seed, lookupTableAddress);
return lookupTableAddress; // Just return, don't store
```

**Line ~799** (extend failed):
```typescript
// REMOVED: this.altAddresses.set(seed, lookupTableAddress);
return lookupTableAddress; // Just return, don't store
```

## Expected Behavior After Fix

### Before (with duplicates):
```
Total ALTs: 7
Categories: common, raydium-clmm-alt, raydium-clmm, orca-whirlpool-alt, orca-whirlpool, meteora-dlmm-alt, meteora-dlmm

raydium-clmm-alt: HubP3UTD...UWxuNmz7 (0 accounts)
raydium-clmm:     HubP3UTD...UWxuNmz7 (0 accounts) ← DUPLICATE!
```

### After (no duplicates):
```
Total ALTs: 4
Categories: common, raydium-clmm, orca-whirlpool, meteora-dlmm

raydium-clmm:     HubP3UTD...UWxuNmz7 (X accounts)
```

## Cleanup Required

**Existing Duplicate ALTs**: You'll need to delete the duplicate `-alt` categories:
1. Open ALT Management modal
2. Click "🔄 Refresh ALT Cache" to reload current state
3. Delete duplicate entries (e.g., `raydium-clmm-alt`, `orca-whirlpool-alt`, `meteora-dlmm-alt`)
4. Keep the clean categories (e.g., `raydium-clmm`, `orca-whirlpool`, `meteora-dlmm`)

**Or** delete all and recreate fresh ALTs with the new code.

## Investigating "0 Accounts" Issue

If newly created ALTs still show 0 accounts after this fix, check the backend logs for:

1. **Empty collection**:
   ```
   alt.manager.created.empty: No accounts to add
   ```
   → Fix: Check why `collectDexPoolAccounts()` returns 0 accounts

2. **Account not ready**:
   ```
   alt.manager.account.not_ready: Account not ready for extension after retries
   ```
   → Fix: Increase retry delays or use confirmed commitment

3. **Extension failed**:
   ```
   alt.manager.extend.failed: ALT created but extend failed
   ```
   → Fix: Check RPC rate limits or transaction errors

## Testing

1. Delete all existing ALTs (they're duplicates with 0 accounts anyway)
2. Click "🔄 Refresh ALT Cache"
3. Create new ALTs for each DEX
4. Verify:
   - Only ONE category per DEX (no `-alt` duplicates)
   - Accounts are actually added (not 0)
   - Check backend logs for any errors

## Related Files

- `backend/src/execution/utils/altManager.ts` - Core fix
- `backend/docs/ALT_AUTO_CLEANUP.md` - Auto-cleanup docs
- `backend/docs/ALT_OPTIMIZATION_SUMMARY.md` - Reverse edge filtering

## Future Improvements

1. **Better error handling** for account collection failures
2. **Retry logic** for extension with exponential backoff
3. **Pre-flight checks** to validate accounts before creating ALT
4. **Atomic operations** to ensure ALT + accounts are created together

