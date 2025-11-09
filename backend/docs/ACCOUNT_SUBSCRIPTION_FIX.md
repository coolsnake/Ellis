# Account Subscription Fix - Implementation Summary

## Overview

Fixed critical issues with WebSocket account subscriptions for DEX pools. Previously, the system was only subscribing to pool accounts, missing critical derived accounts (vaults, oracles, tick arrays) that contain price-sensitive data.

## Issues Identified

### 1. Orca Whirlpool - INCOMPLETE SUBSCRIPTIONS ❌
**Before:**
- ✅ Pool account only
- ❌ Missing: vaults, oracle, tick arrays
- ❌ **BUG**: Was incorrectly calling `attachRaydiumAmmVaults()` for Orca pools!

**After:**
- ✅ Pool account
- ✅ tokenVaultA and tokenVaultB
- ✅ Oracle account
- ✅ 3 tick arrays (lower, center, upper) derived based on current tick

### 2. Raydium CLMM - MISSING CRITICAL ACCOUNTS ❌
**Before:**
- ✅ Pool account only
- ❌ Missing: vaults, observationId, oracle, tick arrays

**After:**
- ✅ Pool account
- ✅ vaultA and vaultB
- ✅ observationId (TWAP/oracle data)
- ✅ Oracle account
- ✅ 3 tick arrays (lower, center, upper) derived based on current tick

### 3. Raydium AMM - PARTIAL ⚠️
**Before:**
- ✅ Pool account
- ✅ baseVault and quoteVault

**After:**
- ✅ No changes needed (already correct)

### 4. Meteora DLMM - BEST BUT INCOMPLETE ⚠️
**Before:**
- ✅ Pool account
- ✅ Dynamic bin arrays (excellent implementation!)
- ❌ Missing: reserveX, reserveY, oracle

**After:**
- ✅ Pool account
- ✅ Dynamic bin arrays (kept existing excellent implementation)
- ✅ reserveX and reserveY
- ✅ Oracle account

## Implementation Details

### New Functions Added

#### 1. `attachRaydiumClmmAccounts(poolAddr: string)`
**Location:** `backend/src/server/pools.ts` (lines 1577-1668)

Subscribes to:
- vaultA and vaultB (token reserves)
- observationId (TWAP oracle)
- Oracle account
- 3 tick arrays (derived using PDA: `[b"tick_array", pool_id, start_index]`)

**Tick Array Derivation:**
```typescript
// Calculate start tick index for each offset (-1, 0, +1)
const startTickIndex = Math.floor(currentTick / (tickSpacing * 60)) + offset;
const actualStartTick = startTickIndex * tickSpacing * 60;

// Derive PDA
const [tickArrayPda] = web3.PublicKey.findProgramAddressSync(
  [Buffer.from('tick_array'), poolPk.toBuffer(), startIndexBuffer],
  clmmProgramId
);
```

#### 2. `attachOrcaWhirlpoolAccounts(poolAddr: string)`
**Location:** `backend/src/server/pools.ts` (lines 1670-1742)

Subscribes to:
- tokenVaultA and tokenVaultB
- Oracle account
- 3 tick arrays (using Orca SDK's `PDAUtil.getTickArray()`)

**Uses:**
- `ParsableWhirlpool.parse()` to decode pool state
- `TickUtil.getStartTickIndex()` to calculate tick array positions
- `PDAUtil.getTickArray()` to derive tick array PDAs

#### 3. `attachMeteoraReserves(poolAddr: string)`
**Location:** `backend/src/server/pools.ts` (lines 1744-1807)

Subscribes to:
- reserveX (derived using Meteora SDK)
- reserveY (derived using Meteora SDK)
- Oracle account (derived using Meteora SDK)

**Uses:**
- `DLMM.deriveReserve(programId, poolPk, isX)` for reserves
- `DLMM.deriveOracle(programId, poolPk)` for oracle

### Subscription Logic Changes

#### 1. Orca Subscription (line 1811)
**Before:**
```typescript
await attachRaydiumAmmVaults(addr).catch(() => {}); // WRONG!
```

**After:**
```typescript
await attachOrcaWhirlpoolAccounts(addr).catch(() => {});
```

#### 2. Raydium Subscription (lines 1873-1897)
**Before:**
```typescript
await attachRaydiumAmmVaults(addr).catch(() => {}); // Only AMM
```

**After:**
```typescript
// Detect pool type (AMM vs CLMM) by checking account owner
const poolAcc = await conn.getAccountInfo(pk);
const owner = poolAcc.owner?.toBase58?.();

if (owner === rayClmmOwner) {
  await attachRaydiumClmmAccounts(addr).catch(() => {});
} else if (owner === rayAmmOwner) {
  await attachRaydiumAmmVaults(addr).catch(() => {});
} else {
  await attachRaydiumAmmVaults(addr).catch(() => {}); // fallback
}
```

#### 3. Meteora Subscription (line 2022)
**Before:**
```typescript
// Only pool account, bin arrays handled separately
```

**After:**
```typescript
await attachMeteoraReserves(addr).catch(() => {});
```

## Why This Matters

### Price Updates
CLMM/concentrated liquidity pools store liquidity distribution in **tick arrays** (Orca/Raydium) or **bin arrays** (Meteora). Without subscribing to these accounts, the system cannot detect:
- Liquidity shifts within the pool
- Price impact changes from LP additions/removals
- Active liquidity range updates

### Token Reserves
Vault/reserve accounts contain the actual token balances. Subscribing to these ensures:
- Real-time price updates when swaps occur
- Accurate reserve ratios for pricing
- Detection of large liquidity events

### Oracle Data
Oracle accounts provide:
- TWAP (Time-Weighted Average Price) data
- External price feeds for certain pools
- Critical for MEV and arbitrage opportunities

## Testing Recommendations

1. **Monitor subscription counts:** Check logs for increased subscription counts per DEX
   - Orca: Should see ~4-7 subscriptions per pool (pool + 2 vaults + oracle + 3 tick arrays)
   - Raydium CLMM: Should see ~6-9 subscriptions per pool
   - Raydium AMM: Should see ~3 subscriptions per pool
   - Meteora: Should see ~5+ subscriptions per pool (pool + 2 reserves + oracle + dynamic bins)

2. **Verify account types:** Check debug logs with `debugLogTargeted()` calls:
   ```
   pools.ws targets.orca: { kind: 'pool' }
   pools.ws targets.orca: { kind: 'vault' }
   pools.ws targets.orca: { kind: 'oracle' }
   pools.ws targets.orca: { kind: 'tick_array', offset: -1 }
   ```

3. **Monitor update frequency:** Should see more frequent updates now that vaults/reserves are subscribed

4. **Check for errors:** Watch for:
   - `orca.whirlpool.tickarray.subscribe.fail`
   - `raydium.clmm.tickarray.subscribe.fail`
   - `meteora.reserve.x.subscribe.fail`

## Performance Considerations

### Increased WebSocket Slots
Each pool now subscribes to multiple accounts:
- **Before:** 1-2 accounts per pool
- **After:** 4-9 accounts per pool

**Mitigation:**
- Rate limiting already in place (`wsAttachPerSec` config)
- Targeted subscriptions (only active pools from graph)
- Retry logic with backoff

### RPC Load
The `getAccountInfo()` calls for detecting pool types add RPC load.

**Mitigation:**
- Already wrapped in `withRpcLimit()`
- Results are cached in pool state
- Only happens once per pool at subscription time

## Configuration

No config changes required. Existing settings apply:
- `system.wsAttachPerSec`: Rate limit for subscriptions (default: 10/sec)
- `system.wsSubscribeMaxAttempts`: Retry attempts (default: 10)
- `system.wsSubscribeBackoffMs`: Backoff delay (default: 250ms)

## Rollback

If issues arise, revert `backend/src/server/pools.ts` to commit before this change. The system will fall back to pool-only subscriptions (pre-fix behavior).

## Future Improvements

1. **Dynamic tick/bin array tracking:** Like Meteora's bin array tracking, implement dynamic resubscription when price moves into new tick arrays
2. **Subscription health monitoring:** Track which accounts are successfully subscribed vs failed
3. **Account update metrics:** Measure update frequency per account type to optimize subscriptions
4. **Smarter pool type detection:** Cache pool types to avoid repeated RPC calls

## Related Files

- `backend/src/server/pools.ts` - Main implementation
- `backend/src/execution/builder/ix.ts` - Instruction builders that use these accounts
- `backend/src/execution/utils/altManager.ts` - ALT manager (already aware of these accounts)

