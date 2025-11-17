# Phase 2 Decoder Extraction - Implementation Guide

## Current Status

✅ **Phase 1 Complete**: All infrastructure modules created and tested (zero errors)  
🚧 **Phase 2 In Progress**: Decoder extraction from `pools.websockets.ts`

## Challenge

The original file contains a massive `handle` function (lines ~749-end) where all decoder logic is embedded. The handle function routes WebSocket events to inline decoder blocks based on:
- Account owner (program ID)
- Explicitly mapped accounts (`targetedSourceByAccount`)
- Derived accounts (vaults, tick arrays, etc.)

## Decoder Logic Locations in Original File

### Pumpswap Decoder (~300 lines)
**Location**: Embedded in handle function, routed via `mapped === 'pumpswap'`

**Key sections**:
1. **Subscription setup** (lines ~3240-3322): Subscribes to pool + vault accounts
2. **Vault handling** (lines ~775-853): Processes vault balance updates
3. **Pool decoding** (lines ~894-???): Main Pumpswap pool account decoding

**Dependencies**:
- `vaultBalanceCache` - Cached vault balances
- `pumpswapCache` - Pool cache
- `findPoolInCache()` - Pool lookup utility
- Layout/decoder from pumpswap module

**Extraction steps**:
1. Find Pumpswap pool account decoding logic in handle function
2. Extract to `decoders/pumpswap.ts`
3. Export `decodePumpswapPool(accountData, poolId)`
4. Export `handlePumpswapAccountUpdate(account, poolId)` 
5. Import and use validation, metrics, apply modules
6. Test independently

### Meteora Balanced Decoder (~200 lines)
**Location**: Similar routing via `mapped === 'meteora_balanced'`

**Key sections**:
1. **Subscription setup** (lines ~3335-3430)
2. **Vault handling** (lines ~777-853)
3. **Pool decoding** (inline in handle)

### Orca Decoder (~400 lines)
**Location**: Routed via `owner === ownerOrca`

**Key sections**:
1. **Subscription setup** (lines ~2700-2900)
2. **CLMM pool decoding** (lines ~1550-1650)
3. Uses Orca Whirlpool layout

### Meteora DLMM Decoder (~600 lines)
**Location**: Routed via Meteora program ID or `isMeteoraTarget`

**Key sections**:
1. **Subscription setup** (lines ~2400-2650)
2. **Pool decoding** (lines ~1667-2045)
3. **Bin array handling** (embedded with pool logic)
4. **Bin subscriptions** (dynamic based on bitmap)

### Raydium Decoder (~800 lines)
**Location**: Routed via `owner === ownerRayAmm || owner === ownerRayClmm`

**Key sections**:
1. **Subscription setup** (lines ~2900-3200)
2. **AMM pool decoding** (lines ~1100-1400)
3. **CLMM pool decoding** (lines ~923-1100)
4. **Derived account subscriptions** (vaults, tick arrays, oracles)

## Recommended Extraction Approach

### Option A: Manual Line-by-Line Extraction (Time-intensive)
1. Read handle function section for one DEX
2. Copy decoder logic to new module
3. Extract dependencies
4. Refactor to use infrastructure modules
5. Test independently
6. Repeat for each DEX

**Estimated time**: 12-16 hours

### Option B: Incremental Parallel Approach (Recommended)
1. Keep original file working
2. Create new orchestrator that uses extracted decoders when available
3. Fall back to original for non-extracted DEXes
4. Extract one decoder at a time
5. Test each extraction before moving to next
6. Gradually migrate all DEXes

**Benefits**:
- Lower risk (original always works)
- Incremental testing
- Can deploy partially

**Estimated time**: 16-20 hours (but safer)

### Option C: Hybrid Approach (Fastest, acceptable risk)
1. Create new orchestrator that replicates handle function logic
2. But uses extracted utility modules (validation, metrics, etc.)
3. Inline decoder logic initially (matching original)
4. Extract decoders incrementally after orchestrator works
5. Replace inline logic with decoder calls one at a time

**Benefits**:
- Fastest path to working refactored code
- Tests orchestrator separately from decoders
- Can refine decoder extraction iteratively

**Estimated time**: 10-14 hours

## Next Immediate Steps

Given the complexity, I recommend **Option C** (Hybrid Approach):

### Step 1: Create New Orchestrator (4-6 hours)
Create `pools.websockets.refactored.ts` that:
- Uses all extracted infrastructure modules
- Replicates handle function logic
- Maintains same public API
- Initially keeps decoder logic inline (copied from original)

### Step 2: Test Orchestrator (2-3 hours)
- Unit tests for public API functions
- Integration test with real WebSocket data
- Verify metrics match original
- Load test

### Step 3: Extract Decoders Incrementally (1-2 hours each)
Once orchestrator works:
- Extract Pumpswap decoder first (smallest)
- Replace inline logic with decoder call
- Test
- Repeat for other DEXes

### Step 4: Deprecate Original (1 hour)
- Switch imports to use refactored version
- Keep original as backup
- Monitor production

## Code Pattern for Extraction

Each decoder should follow this pattern:

```typescript
// decoders/pumpswap.ts
import { validateDecodedPool } from '../validation.js';
import { recordDecodeSuccess, recordDecodeFailure, recordDelta } from '../metrics.js';
import { scheduleDexApply } from '../apply.js';
import { pumpswapCache } from '../../../pools.cache.js';

export async function handlePumpswapAccountUpdate(
  account: any,
  poolId: string
): Promise<void> {
  try {
    // 1. Decode account data
    const pool = decodePumpswapPool(account.data, poolId);
    if (!pool) {
      recordDecodeFailure('pumpswap');
      return;
    }

    // 2. Validate
    const validation = validateDecodedPool('pumpswap', pool, poolId);
    if (!validation.valid) {
      recordDecodeFailure('pumpswap');
      return;
    }

    // 3. Update cache
    const prev = pumpswapCache.data || { amm: [], clmm: [] };
    const next = { ...prev };
    const idx = next.amm.findIndex(p => p.id === poolId);
    if (idx >= 0) {
      next.amm[idx] = { ...next.amm[idx], ...pool };
    } else {
      next.amm.push(pool);
    }
    pumpswapCache.data = next;

    // 4. Record metrics
    recordDecodeSuccess('pumpswap');
    recordDelta('pumpswap');

    // 5. Schedule graph update
    await scheduleDexApply('pumpswap', prev);

  } catch (err) {
    recordDecodeFailure('pumpswap');
    logger.error('pumpswap.decode.error', {
      poolId,
      error: String(err),
      cat: 'pools'
    });
  }
}

export function decodePumpswapPool(
  accountData: Buffer,
  poolId: string
): any | null {
  // Pumpswap-specific layout decoding
  // Extract from original handle function
  return null;
}
```

## Decision Point

Would you like me to:

**A)** Create the new orchestrator first (Option C - fastest, recommended)  
**B)** Extract Pumpswap decoder completely before proceeding (Option A - thorough)  
**C)** Provide more detailed mapping of where each decoder is in the original file

Choose your preferred approach and I'll proceed accordingly.

