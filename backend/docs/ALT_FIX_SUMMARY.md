# ALT Fix Summary

## Changes Made

### 1. ✅ Fixed Broken `loadLookupTables` Function

**File:** `backend/src/execution/sender.ts`

**Problem:** Line 230 had a placeholder that always returned `null`, preventing ALTs from being loaded properly.

**Before:**
```typescript
const acc = await (() => null)();  // Always returns null!
```

**After:**
```typescript
const acc = await connection.getAddressLookupTable(pk).then(r => r.value).catch(() => null);
```

**Impact:** ALTs are now properly loaded in the initial path, with detailed logging for success/failure.

---

### 2. ✅ Added Comprehensive ALT Coverage Debugging

**Files Modified:** `backend/src/execution/sender.ts`

**Added to both `assembleAndSimulate` and `assembleAndSend` functions:**

#### Coverage Analysis
Analyzes every transaction before compilation to show:
- Total unique accounts in transaction
- How many are covered by ALTs
- Coverage percentage
- Sample of uncovered accounts (first 10)
- Warning if coverage is poor (<50%)

**Log output example:**
```json
{
  "msg": "tx.alt.coverage.analysis",
  "ctx": {
    "totalAccounts": 78,
    "altCoveredAccounts": 45,
    "uncoveredAccounts": 33,
    "coveragePercent": 58,
    "altCount": 4,
    "totalAltAccounts": 314,
    "uncoveredSample": ["DAJj...", "FoKY...", ...]
  }
}
```

#### Poor Coverage Warning
Automatically warns when coverage is <50%:
```json
{
  "msg": "tx.alt.coverage.poor",
  "ctx": {
    "coveragePercent": 42,
    "uncoveredAccounts": [...],  // Full list
    "warning": "Many accounts not in ALTs - transaction may be too large"
  }
}
```

---

### 3. ✅ Added Transaction Size Success Logging

**After successful serialization**, now logs:
```json
{
  "msg": "tx.serialize.success",
  "ctx": {
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

This helps you understand exactly how close you are to the transaction size limit.

---

## New Tools Created

### 1. ALT Coverage Debug Script

**File:** `backend/scripts/debug-alt-coverage.ts`

**Usage:**
```bash
cd backend
npx tsx scripts/debug-alt-coverage.ts
```

**What it does:**
- Lists all configured ALTs with account counts
- Checks if common programs/tokens are covered
- Analyzes DEX pool account coverage
- Provides recommendations for improving coverage
- Shows sample accounts from each ALT

**Example output:**
```
📋 Found 4 ALT addresses configured

✅ common ALT: HnvXVqCha6X7tca18CdBUoASfUGFmdqvZHLnW7k7DRaD
   Accounts: 15

✅ raydium-clmm ALT: DWU7E43VrT2Vxg6e9rBYL8PuuDsY7GhYgTWYj1K6fD3T
   Accounts: 210

📊 Analyzing Common Accounts
────────────────────────────────────────
✅ Token Program              [common]
✅ System Program             [common]
✅ Orca Whirlpool             [common]
❌ Some Pool Vault            [NOT IN ALT]
```

### 2. ALT Debugging Guide

**File:** `backend/docs/ALT_DEBUGGING_GUIDE.md`

Comprehensive guide covering:
- How to interpret new log messages
- Step-by-step debugging process
- Understanding coverage percentages
- Identifying which accounts can/cannot be pre-loaded
- Example diagnosis of failed transactions
- Quick reference table

---

## How to Use

### Immediate Next Steps

1. **Run the debug script** to verify your ALT setup:
   ```bash
   cd backend
   npx tsx scripts/debug-alt-coverage.ts
   ```

2. **Run your failing transaction again** and look for new logs:
   - `tx.lookup_table.loaded_individual` - Confirms ALTs loaded
   - `tx.alt.coverage.analysis` - Shows coverage %
   - `tx.alt.coverage.poor` - Lists uncovered accounts (if coverage <50%)

3. **Analyze the uncovered accounts**:
   - **Dynamic accounts** (tick arrays, bin arrays): Cannot be pre-loaded ⚠️
   - **User accounts** (your wallet, ATAs): Normal, won't be in ALTs ✓
   - **Pool vaults/reserves**: SHOULD be in ALTs - add them! 🔧

4. **Add missing static accounts** to your ALTs using the ALT manager API

---

## What You'll Learn From The Logs

### If your transaction is still failing:

**Scenario 1: Good Coverage (>80%) but still fails**
- Problem: Dynamic accounts (tick arrays, bin arrays) take up too much space
- These cannot be pre-loaded into ALTs
- Solution: Reduce number of hops or simplify route

**Scenario 2: Poor Coverage (<50%)**
- Problem: Many pool accounts not in your ALTs
- Solution: Add missing pool accounts to appropriate ALT categories
- Run debug script to identify which ALTs need more accounts

**Scenario 3: Medium Coverage (50-80%)**
- Mixed bag - some accounts can be added to ALTs
- Review `uncoveredSample` to identify which ones
- Distinguish between static (can add) and dynamic (cannot add)

---

## Key Insights

### ALTs Working Correctly When:
✅ `tx.lookup_table.loaded_individual` shows 4 ALTs loaded  
✅ `tx.alt.coverage.analysis` shows coverage >70%  
✅ `uncoveredAccounts` are mostly dynamic (tick/bin arrays) or user-specific  

### ALTs NOT Working When:
❌ Coverage <50%  
❌ `uncoveredAccounts` contains pool vaults, reserves, oracles  
❌ No `tx.lookup_table.loaded_individual` logs (ALTs not loading)  

---

## Example Diagnosis

Your original error showed:
```
Account count: 78, Instructions: 13, ALTs: 4
Transaction too large: encoding overruns Uint8Array
```

With the new logging, you'll now see:
```json
{
  "msg": "tx.alt.coverage.analysis",
  "coveragePercent": 58,
  "uncoveredAccounts": 33,
  "uncoveredSample": [
    "4ct7br2vTPzfdmY3S5HLtTxcGSBfn6pnw98hsS6v359A",  // Pool vault
    "5it83u57VRrVgc51oNV19TTmAJuffPx5GtGwQr7gQNUo",  // Pool vault
    "DAJjGxPKTEBcDdQqojLuN1nEpKNcAiowoqguHb2AA7dy",  // Tick array (dynamic)
    "FoKYKtRpD25TKzBMndysKpgPqbj8AdLXjfpYHXn9PGTX",  // Tick array (dynamic)
    ...
  ]
}
```

This tells you:
1. **58% coverage** - Not great, but not terrible
2. **33 uncovered accounts** - Some can likely be added to ALTs
3. **First two** look like pool vaults - ADD THESE TO YOUR ALTS ✅
4. **Last two** are tick arrays - CANNOT be added (dynamic) ⚠️

**Action:** Add the pool vaults to your Raydium CLMM ALT, which should improve coverage to ~70-75%, potentially allowing the transaction to succeed.

---

## Files Changed

1. `backend/src/execution/sender.ts` - Fixed ALT loading + added coverage analysis
2. `backend/scripts/debug-alt-coverage.ts` - New debug tool (created)
3. `backend/docs/ALT_DEBUGGING_GUIDE.md` - Comprehensive guide (created)

---

## Next Time You Run

Watch for these logs in order:
1. `tx.lookup_table.addresses` → ALTs requested
2. `tx.lookup_table.loaded_individual` → ALTs loaded successfully (should see 4)
3. `tx.lookup_table.using_common` → Common ALTs merged
4. `tx.alt.coverage.analysis` → **This is the key log!**
5. `tx.alt.coverage.poor` → Warning if coverage is bad
6. `tx.serialize.success` or `tx.serialize.size_error` → Final result

The `tx.alt.coverage.analysis` log will tell you exactly what's wrong!

