# ALT Debugging Guide

## What Was Fixed

### 1. Fixed Broken `loadLookupTables` Function

**Problem:** In `backend/src/execution/sender.ts` line 230, the function had a placeholder that always returned `null`:

```typescript
const acc = await (() => null)();  // ❌ This was broken!
```

**Fix:** Now properly loads ALT accounts:

```typescript
const acc = await connection.getAddressLookupTable(pk).then(r => r.value).catch(() => null);
```

This was causing ALTs to not be loaded in the initial path, though they were eventually loaded via `getCommonLookupTables()`.

### 2. Added Comprehensive ALT Coverage Analysis

Added detailed logging to both `assembleAndSimulate` and `assembleAndSend` functions that shows:

- **Total accounts** in the transaction
- **How many accounts are covered** by ALTs
- **Coverage percentage**
- **Sample of uncovered accounts** (accounts not in any ALT)
- **Warning if coverage is poor** (<50%)

### 3. Added Transaction Size Logging

Added logging after successful transaction serialization showing:

- Raw transaction size in bytes
- Base64 encoded size
- Percentage of max size used
- Number of instructions and ALTs

## New Log Messages

When you run a transaction, you'll now see these new log entries:

### ALT Loading Logs

```json
{
  "msg": "tx.lookup_table.loaded_individual",
  "ctx": {
    "address": "HnvXVqCha6X7tca18CdBUoASfUGFmdqvZHLnW7k7DRaD",
    "accountCount": 150
  }
}
```

### ALT Coverage Analysis

```json
{
  "msg": "tx.alt.coverage.analysis",
  "ctx": {
    "txId": "abc123",
    "totalAccounts": 78,
    "altCoveredAccounts": 45,
    "uncoveredAccounts": 33,
    "coveragePercent": 58,
    "altCount": 4,
    "totalAltAccounts": 314,
    "uncoveredSample": [
      "DAJjGxPKTEBcDdQqojLuN1nEpKNcAiowoqguHb2AA7dy",
      "FoKYKtRpD25TKzBMndysKpgPqbj8AdLXjfpYHXn9PGTX",
      // ... first 10 uncovered accounts
    ]
  }
}
```

### Poor Coverage Warning

```json
{
  "msg": "tx.alt.coverage.poor",
  "ctx": {
    "txId": "abc123",
    "coveragePercent": 42,
    "uncoveredAccounts": [...],  // Full list
    "warning": "Many accounts not in ALTs - transaction may be too large"
  }
}
```

### Transaction Size Success

```json
{
  "msg": "tx.serialize.success",
  "ctx": {
    "txId": "abc123",
    "rawSizeBytes": 1180,
    "base64SizeBytes": 1574,
    "maxSizeRaw": 1232,
    "maxSizeBase64": 1644,
    "sizePctUsedRaw": 96,
    "sizePctUsedBase64": 96,
    "ixCount": 13,
    "lookupTableCount": 4,
    "accountCount": 78
  }
}
```

## How to Debug ALT Issues

### Step 1: Run the ALT Coverage Debug Script

```bash
cd backend
npx tsx scripts/debug-alt-coverage.ts
```

This will show you:
- Which ALTs are configured
- How many accounts are in each ALT
- Whether common programs/tokens are covered
- Estimated number of pools per DEX
- Recommendations for improvement

### Step 2: Run Your Transaction

When you run a transaction that fails, look for these log messages:

1. **`tx.lookup_table.addresses`** - Shows which ALTs were requested
2. **`tx.lookup_table.loaded_individual`** - Shows which ALTs were successfully loaded
3. **`tx.alt.coverage.analysis`** - Shows coverage percentage
4. **`tx.alt.coverage.poor`** - Shows which accounts aren't covered (if coverage < 50%)
5. **`tx.serialize.size_error`** - Shows the error if transaction is too large

### Step 3: Identify Missing Accounts

Look at the `uncoveredSample` or `uncoveredAccounts` in the logs. These are accounts that need to be added to your ALTs.

**Common uncovered accounts:**

1. **Tick Arrays** (Raydium CLMM, Orca Whirlpool)
   - These are dynamic and calculated per transaction
   - Format: Often have pattern like `DAJj...`, `FoKY...`
   - **Cannot be pre-loaded** - they change based on current price
   
2. **Bin Arrays** (Meteora DLMM)
   - Dynamic, calculated based on active bin
   - **Cannot be pre-loaded**
   
3. **User Accounts**
   - Your wallet address
   - Your token accounts (ATAs)
   - These are user-specific, so shouldn't be in ALTs
   
4. **Pool Vaults/Reserves**
   - These SHOULD be in your DEX-specific ALTs
   - If they're not, you need to update your ALTs

### Step 4: Add Missing Accounts to ALTs

If you find static pool accounts that aren't in your ALTs:

1. Use the ALT manager to collect accounts:

```typescript
import { dexAltManager } from './src/execution/utils/altManager.js';

// Collect accounts for a specific pool
const accounts = await dexAltManager.parseRaydiumClmmAccounts(poolAddress);
// or
const accounts = await dexAltManager.parseMeteoraDlmmAccounts(poolAddress);
// or
const accounts = await dexAltManager.parseOrcaWhirlpoolAccounts(poolAddress);
```

2. Add them to the appropriate ALT category using the API:

```bash
curl -X POST http://localhost:3001/api/alt/extend \
  -H "Content-Type: application/json" \
  -d '{
    "category": "raydium-clmm",
    "accounts": ["account1", "account2", ...]
  }'
```

## Understanding Coverage Percentage

### Good Coverage (>80%)
- Transaction should succeed if it's within size limits
- Most static accounts are in ALTs
- Only dynamic accounts and user accounts are uncovered

### Medium Coverage (50-80%)
- Transaction may succeed but is at risk
- Some pool accounts are missing from ALTs
- Review uncovered accounts and add static ones to ALTs

### Poor Coverage (<50%)
- Transaction will likely fail
- Many pool accounts are missing
- ALTs may not be properly configured
- Run the debug script to verify ALT setup

## Example: Diagnosing a Failed Transaction

```
❌ Error: Transaction too large: encoding overruns Uint8Array
Account count: 78, Instructions: 13, ALTs: 4
```

**Step 1:** Check the coverage log:
```json
{
  "msg": "tx.alt.coverage.analysis",
  "coveragePercent": 58,  // ⚠️ Only 58% covered
  "totalAccounts": 78,
  "altCoveredAccounts": 45,
  "uncoveredAccounts": 33
}
```

**Step 2:** Look at uncovered accounts:
```json
{
  "uncoveredSample": [
    "4ct7br2vTPzfdmY3S5HLtTxcGSBfn6pnw98hsS6v359A",  // Raydium vault
    "5it83u57VRrVgc51oNV19TTmAJuffPx5GtGwQr7gQNUo",  // Raydium vault
    "DAJjGxPKTEBcDdQqojLuN1nEpKNcAiowoqguHb2AA7dy",  // Tick array (dynamic)
    ...
  ]
}
```

**Step 3:** Identify the issue:
- First two are Raydium vaults → Should be in `raydium-clmm` ALT
- Third is a tick array → Dynamic, cannot be pre-loaded

**Step 4:** Fix by adding vaults to ALT:
```bash
npx tsx scripts/update-alt-accounts.ts raydium-clmm \
  4ct7br2vTPzfdmY3S5HLtTxcGSBfn6pnw98hsS6v359A \
  5it83u57VRrVgc51oNV19TTmAJuffPx5GtGwQr7gQNUo
```

## Why Transactions Still Fail Even With ALTs

Even with perfect ALT coverage, transactions can still be too large due to:

1. **Dynamic Accounts**
   - Tick arrays (3-5 per CLMM hop)
   - Bin arrays (10-20 per DLMM hop)
   - These take ~32 bytes each and cannot be compressed

2. **Too Many Instructions**
   - Each instruction has overhead (program ID, data, account indices)
   - 13 instructions with compute budget = ~100-150 bytes base overhead

3. **Multi-hop Complexity**
   - 3-hop route = 3 DEX instructions + setup/cleanup
   - Each hop adds ~10-20 accounts
   - Even with ALTs, the indices take space

### Solutions When Coverage is Good but TX Still Fails:

1. **Reduce hops** - Use 2-hop instead of 3-hop routes
2. **Optimize instructions** - Remove unnecessary ATAs or compute budget instructions
3. **Split transaction** - Break into multiple transactions (not implemented yet)
4. **Use simpler DEXes** - Some DEXes require fewer accounts

## Quick Reference

| Log Message | What It Means |
|------------|---------------|
| `tx.lookup_table.loaded_individual` | ALT successfully loaded with N accounts |
| `tx.lookup_table.load_failed` | ALT address exists but couldn't load |
| `tx.alt.coverage.analysis` | Shows coverage % and uncovered accounts |
| `tx.alt.coverage.poor` | Warning: <50% coverage, likely to fail |
| `tx.serialize.success` | TX compiled successfully, shows size |
| `tx.serialize.size_error` | TX too large, couldn't serialize |

## Need Help?

1. Run `npx tsx scripts/debug-alt-coverage.ts` to check your ALT setup
2. Look for `tx.alt.coverage.analysis` in your transaction logs
3. Check if uncovered accounts are static (can be added to ALT) or dynamic (cannot)
4. Review `backend/docs/ALT_MANAGER_GUIDE.md` for ALT setup instructions

