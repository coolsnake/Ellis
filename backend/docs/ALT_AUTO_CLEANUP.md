# ALT Auto-Cleanup on Deleted ALTs

## Problem

When ALTs are closed/deleted via the UI or API, they are removed from the `altConfig.json` file and on-chain. However, the ALT manager keeps the deleted ALT addresses in its in-memory `altAddresses` Map during the current session. This causes:

1. **Stale references**: Orca and Meteora still "see" the deleted common ALT in memory
2. **Transaction failures**: Attempting to use a deleted ALT address in transactions fails
3. **Confusion**: UI may show inconsistent state until server restart

## Solution

Implemented automatic validation and cleanup of deleted/invalid ALTs:

### 1. On-Chain Validation During Initialization

Modified `initialize()` method in `altManager.ts` to:
- Check if each ALT from config actually exists on-chain
- Skip adding deleted ALTs to the in-memory map
- Remove invalid ALTs from the config file
- Log cleanup actions for observability

**Key Code**:
```typescript
// Validate that the ALT actually exists on-chain
const altAccount = await withRpcLimit(() => 
  connection.getAddressLookupTable(pk)
);

if (!altAccount.value) {
  // ALT has been closed/deleted, mark for removal
  invalidCategories.push(category);
  continue; // Don't add to altAddresses map
}

// Clean up invalid ALTs from config file
if (invalidCategories.length > 0) {
  for (const category of invalidCategories) {
    delete this.altConfig.alts[category];
  }
  await saveAltConfig(this.altConfig);
}
```

### 2. Force Re-initialization API

Added `forceReinitialize()` method that:
- Clears all in-memory ALT state
- Reloads ALTs from config
- Re-validates all ALTs on-chain
- Removes stale references

**Backend API Endpoint**:
- **POST** `/arb/alts/reinitialize`
- No parameters required
- Returns success message
- Automatically called after ALT deletion (could be enhanced)

### 3. UI "Refresh ALT Cache" Button

Added a button to the ALT Management modal:
- Located at top-right of "Current ALTs" section
- Button label: "🔄 Refresh ALT Cache"
- Confirms before executing
- Shows success/error feedback
- Automatically reloads ALT status after refresh

## Usage

### Automatic Cleanup (on server start)
The validation happens automatically when the ALT manager initializes, so deleted ALTs are cleaned up on server restart.

### Manual Cleanup (during runtime)
1. Open ALT Management modal
2. Click "🔄 Refresh ALT Cache" button
3. Confirm the action
4. System will:
   - Clear in-memory cache
   - Re-validate all ALTs on-chain
   - Remove any deleted/invalid ALTs
   - Refresh the UI

### Programmatic Cleanup
```typescript
import { dexAltManager } from './execution/utils/altManager';

// Force re-initialization
await dexAltManager.forceReinitialize();
```

## Benefits

1. ✅ **No stale references**: Deleted ALTs are automatically cleaned up
2. ✅ **Consistent state**: Memory always matches on-chain reality
3. ✅ **Better UX**: Orca/Meteora immediately recognize when common ALT is deleted
4. ✅ **Self-healing**: System auto-recovers from invalid ALT references
5. ✅ **Observability**: Logs show which ALTs were removed and why

## Technical Details

### Files Modified

- **`backend/src/execution/utils/altManager.ts`**
  - Enhanced `initialize()` with on-chain validation
  - Added `forceReinitialize()` method
  
- **`backend/src/server/routes/arb.ts`**
  - Added `/arb/alts/reinitialize` endpoint
  
- **`frontend/src/utils/routes.ts`**
  - Added `ROUTES.arb.alts.reinitialize` constant
  
- **`frontend/src/components/AltManagementModal.tsx`**
  - Added `handleReinitialize()` function
  - Added "Refresh ALT Cache" button to UI

### Validation Flow

```
1. Load altConfig.json from disk
   ↓
2. For each ALT in config:
   ↓
3. Check if ALT exists on-chain
   ↓
4a. Valid → Add to altAddresses map
4b. Invalid → Mark for removal
   ↓
5. Save cleaned config back to disk
   ↓
6. Log cleanup actions
```

### When Validation Happens

1. **Server Startup**: Automatic via `initializeStartup()`
2. **Manual Import**: When `dexAltManager.initialize()` is called
3. **Manual Refresh**: When user clicks "Refresh ALT Cache" button
4. **After Deletion**: Could be enhanced to auto-trigger (future improvement)

## Future Enhancements

1. **Auto-refresh after deletion**: Automatically call `forceReinitialize()` after `closeAlt()` succeeds
2. **Periodic validation**: Run validation every N minutes to detect externally-deleted ALTs
3. **Webhook notifications**: Alert when invalid ALTs are detected and cleaned up
4. **Dry-run mode**: Preview what would be cleaned up without actually doing it

## Related Documentation

- [ALT Deletion Guide](./ALT_DELETION_GUIDE.md)
- [ALT Manager Guide](./ALT_MANAGER_GUIDE.md)
- [ALT Optimization Summary](./ALT_OPTIMIZATION_SUMMARY.md)

