# ALT Deletion System

## Overview

The ALT (Address Lookup Table) deletion system allows you to safely close ALTs and recover the rent (typically ~0.01-0.02 SOL per ALT). The process involves two steps with a mandatory waiting period.

## How It Works

### Step 1: Deactivate
When you deactivate an ALT, it's marked for closure but cannot be immediately closed. This is a Solana security feature to prevent race conditions.

**Requirements:**
- Must be the authority (creator) of the ALT
- ALT must not be currently deactivated

**Result:**
- ALT is marked as deactivated
- A deactivation slot is recorded
- Must wait 513 slots (~4-5 minutes) before closing

### Step 2: Close
After the waiting period, you can close the ALT and recover the rent.

**Requirements:**
- ALT must be deactivated
- At least 513 slots must have passed since deactivation

**Result:**
- ALT is permanently closed
- Rent is recovered to your wallet
- ALT is removed from tracking

## Rent Amounts

- **Base ALT**: ~0.00144 SOL (empty ALT)
- **With accounts**: ~0.0003 SOL per 30 accounts
- **Typical ALT** (180-270 accounts): ~0.015-0.02 SOL

## Usage

### Via API

#### Deactivate an ALT
```bash
curl -X POST http://localhost:3040/api/arb/alts/deactivate \
  -H "Content-Type: application/json" \
  -d '{"category": "meteora-dlmm"}'
```

Response:
```json
{
  "success": true,
  "signature": "2x3y4z...",
  "altAddress": "ABC123...",
  "message": "ALT deactivated. Wait ~5 minutes (513 slots) before closing to recover rent."
}
```

#### Check ALT Status
```bash
curl http://localhost:3040/api/arb/alts/info/meteora-dlmm
```

Response:
```json
{
  "address": "ABC123...",
  "accountCount": 180,
  "isDeactivated": true,
  "deactivationSlot": 250000000,
  "canClose": false,
  "slotsUntilCloseable": 312,
  "minutesUntilCloseable": 3,
  "rentAmount": 15000000,
  "rentAmountSOL": "0.015000"
}
```

#### Close an ALT
```bash
curl -X POST http://localhost:3040/api/arb/alts/close \
  -H "Content-Type: application/json" \
  -d '{"category": "meteora-dlmm"}'
```

Response:
```json
{
  "success": true,
  "signature": "5a6b7c...",
  "altAddress": "ABC123...",
  "rentRecovered": 15000000,
  "rentRecoveredSOL": "0.015000",
  "message": "ALT closed. Recovered 0.015000 SOL"
}
```

### Via UI

1. **Open ALT Management**
   - Click "Manage ALTs" button in the UI
   - View all current ALTs with their status

2. **Deactivate an ALT**
   - Find the ALT you want to delete
   - Click "Deactivate (Step 1)" button
   - Confirm the action
   - ALT will be marked as deactivated

3. **Wait ~5 Minutes**
   - UI will show countdown: "⏳ Wait 3 more minutes to close"
   - Refresh the page to update the countdown

4. **Close and Recover Rent**
   - Once countdown reaches 0, button changes to "Close & Recover X SOL"
   - Click the button
   - Confirm the action
   - Rent is recovered to your wallet

## UI Features

### ALT Information Display
Each ALT shows:
- Category name (e.g., "meteora-dlmm")
- Address (truncated)
- Account count (e.g., "180 accounts")
- Rent amount (e.g., "0.015000 SOL rent")
- Current status (Active/Deactivated/Can Close)

### Delete Buttons
- **Before deactivation**: Shows "Deactivate (Step 1)" in orange
- **Deactivated (waiting)**: Shows countdown "⏳ Wait X minutes to close" in yellow
- **Ready to close**: Shows "Close & Recover X SOL" in red

### Confirmation Dialogs
- **Deactivate**: "Deactivate [category] ALT? You'll need to wait ~5 minutes before you can close it."
- **Close**: "Close [category] ALT and recover X SOL rent? This action cannot be undone."

## Error Handling

### Common Errors

**"ALT has not been deactivated yet"**
- You tried to close an ALT that wasn't deactivated first
- Solution: Click "Deactivate (Step 1)" first

**"ALT cannot be closed yet. Wait N more slots"**
- You tried to close before the 513-slot waiting period
- Solution: Wait the displayed time and try again

**"No ALT found for category"**
- The specified category doesn't exist
- Solution: Check the category name and available ALTs

## Safety Features

1. **Two-step process**: Prevents accidental deletion
2. **Confirmation dialogs**: Double-check before action
3. **Waiting period**: 513 slots (~4-5 minutes) enforced by Solana
4. **Status tracking**: UI shows current state and countdown
5. **Config cleanup**: Automatically removes ALT from config after closing

## Important Notes

- **Irreversible**: Once closed, the ALT cannot be recovered
- **Authority required**: Only the ALT creator can deactivate/close it
- **Active transactions**: Don't close ALTs that are currently being used
- **Common ALT**: Be careful not to delete the "common" ALT if in use
- **Recreation cost**: Creating a new ALT costs more than keeping an existing one

## When to Delete ALTs

### Good reasons:
- Testing ALTs that are no longer needed
- Old pool selections that need updating
- Migrating to new ALT structure
- Recovering rent from unused ALTs

### Bad reasons:
- ALT is actively being used in transactions
- Trying to save minimal rent (<0.02 SOL)
- Common/shared ALT used by multiple features

## Recovery Process

If you accidentally deactivate an ALT:
- **Can't undo**: Deactivation cannot be reversed
- **Must close**: After 513 slots, you must close it
- **Recreate**: Create a new ALT with the same category if needed

## Technical Details

### Deactivation
- Creates a `deactivateLookupTable` instruction
- Records deactivation slot on-chain
- ALT remains readable but cannot be extended

### Closing
- Creates a `closeLookupTable` instruction
- Validates 513-slot waiting period
- Transfers rent to recipient (authority by default)
- Account is permanently deleted

### Rent Calculation
```
Rent = Base Rent + (Account Count / 30) * Per-Batch Rent
Base Rent ≈ 0.00144 SOL
Per-Batch Rent ≈ 0.0003 SOL per 30 accounts
```

Example:
- ALT with 180 accounts = 0.00144 + (180/30) * 0.0003 = 0.00324 SOL

## API Endpoints

- `GET /api/arb/alts/info/:category` - Get ALT detailed info
- `POST /api/arb/alts/deactivate` - Deactivate an ALT (Step 1)
- `POST /api/arb/alts/close` - Close an ALT and recover rent (Step 2)

## Backend Methods

- `dexAltManager.getAltInfo(category)` - Get ALT status
- `dexAltManager.deactivateAlt(category)` - Deactivate
- `dexAltManager.closeAlt(category, recipient?)` - Close and recover

## Frontend Components

- `AltManagementModal.tsx` - Main UI with delete buttons
- Shows real-time status, countdown, and action buttons
- Handles confirmation dialogs and error display

