# CRITICAL: Meteora Balanced V1 vs V2 Separation

## 🚨 MAJOR FIX IMPLEMENTED

**Problem Discovered:** We were incorrectly treating Meteora DAMM v1 and v2 as the same pool type, when they are actually **different on-chain programs** requiring different swap logic.

## Why This Matters

According to [Meteora's official documentation](https://docs.meteora.ag):

### DAMM v1 Pools
- **Program**: Original DAMM program
- **Architecture**: Similar to constant-product AMMs (x * y = k)
- **Fee Structure**: Off-chain fee scheduler, linear decay (50% → 0.25%)
- **Liquidity**: Integrated with yield layer (lending protocols)
- **Features**: Basic AMM functionality

### DAMM v2 Pools  
- **Program**: NEW separate program (not an upgrade)
- **Architecture**: Enhanced multi-token support
- **Fee Structure**: On-chain fee scheduler, linear/exponential decay (50% → 0.01%)
- **Liquidity**: More cost-efficient (0.022 SOL vs 0.25 SOL)
- **Features**: Token 2022 support, dynamic fees, position NFTs, transferrable positions

**Key Point**: These are **DIFFERENT PROGRAMS** with **DIFFERENT SWAP INSTRUCTIONS**.

## What Was Wrong

### Before (Incorrect Behavior)
```typescript
// ❌ WRONG: Merged v1 and v2 as if they're the same
fetchMeteoraBalancedAll() {
  v1 = fetchV1(); // Different program!
  v2 = fetchV2(); // Different program!
  merged = mergeBalancedPools(v2, v1); // V2 overwrites V1
  // Result: Lost v1 pools where v2 exists
  // Result: All labeled 'MeteoraBalanced' (no version distinction)
}

// ❌ WRONG: Graph couldn't distinguish versions
addEdge(..., 'MeteoraBalanced', ...);
// Result: Execution layer doesn't know which program to use
```

### Issues This Caused
1. ❌ **Duplicates removed**: If same pair exists on both v1 and v2, we'd only keep v2
2. ❌ **Wrong program IDs**: No way to tell which swap instruction to use
3. ❌ **Failed transactions**: Trying to use v2 logic on v1 pools (or vice versa)
4. ❌ **Incomplete coverage**: Missing v1 pools that had different characteristics than v2

## What We Fixed

### 1. Extract `pool_version` from API ✅

**V2 Normalizer** (`normalizeMeteoraBalancedHttp`):
```typescript
// Extract pool version to determine which program this pool uses
const poolVersion = Number(it?.pool_version ?? 2); // Default to v2 for V2 API
const dex = poolVersion === 1 ? 'MeteoraBalanced_v1' : 'MeteoraBalanced_v2';

amm.push({
  id,
  dex,  // ✅ 'MeteoraBalanced_v1' or 'MeteoraBalanced_v2'
  // ... rest of fields
});
```

**V1 Normalizer** (`normalizeMeteoraBalancedV1`):
```typescript
// Extract pool version - V1 API provides this field
const poolVersion = Number(it?.pool_version ?? 1); // Default to v1 for V1 API
const dex = poolVersion === 1 ? 'MeteoraBalanced_v1' : 'MeteoraBalanced_v2';

amm.push({
  id,
  dex,  // ✅ Correctly labeled based on on-chain program
  // ... rest of fields
});
```

### 2. Stop Merging - Concatenate Instead ✅

```typescript
// ✅ CORRECT: Keep both v1 and v2 pools separate
export async function fetchMeteoraBalancedAll(): Promise<PoolsPayload> {
  const v2 = await fetchMeteoraBalancedV2Http();
  const v1 = await fetchMeteoraBalancedV1Http();
  
  const enrichedV2 = await enrichMeteoraBalancedWithRpc(v2);
  const normV2 = await normalizeMeteoraBalancedHttp(enrichedV2);
  const normV1 = await normalizeMeteoraBalancedV1(v1);
  
  // IMPORTANT: Do NOT merge - v1 and v2 are different pool types
  const combinedAmm = [...normV2.amm, ...normV1.amm];  // Simple concat
  const ammCanon = canonicalizePairs(combinedAmm);
  return { amm: ammCanon, clmm: [] };
}
```

**Result:**
- ✅ Both v1 and v2 pools preserved
- ✅ Same pair can exist on both programs (different liquidity, fees, etc.)
- ✅ Each pool correctly labeled with its version

### 3. Update Graph to Respect Version ✅

```typescript
// ✅ CORRECT: Use pool's dex field dynamically
const dexName = (p as any)?.dex || 'MeteoraBalanced';  // v1 or v2

addEdge(p.mint_a, p.mint_b, dexName, p.fee_bps, liqDisplay, fwd, usd, pid, 
        (p as any).account_a, (p as any).account_b, 'amm', 'forward', rawLiqMbal);
addEdge(p.mint_b, p.mint_a, dexName, p.fee_bps, liqDisplay, rev, usd, pidRev, 
        (p as any).account_b, (p as any).account_a, 'amm', 'reverse', rawLiqMbal);
```

**Result:**
- ✅ Edges labeled `'MeteoraBalanced_v1'` or `'MeteoraBalanced_v2'`
- ✅ Execution layer can identify which program to use
- ✅ Correct swap instructions for each version

## Graph Edge Differentiation

### Before
```typescript
{
  source: "SOL",
  target: "USDC",
  dex: "MeteoraBalanced",  // ❌ Which program?
  pool_id: "abc123..."
}
```

### After
```typescript
// V1 Pool
{
  source: "SOL",
  target: "USDC",
  dex: "MeteoraBalanced_v1",  // ✅ Original DAMM program
  pool_id: "abc123..."
}

// V2 Pool (same pair, different program)
{
  source: "SOL",
  target: "USDC",
  dex: "MeteoraBalanced_v2",  // ✅ New DAMM v2 program
  pool_id: "xyz789..."
}
```

## Execution Layer Impact

### Current State
The execution layer currently only has logic for **Meteora DLMM** (not DAMM):
- `buildMeteoraDlmmSwapIxReal()` - handles DLMM swaps only

### TODO: Add DAMM Support
```typescript
// ⚠️ NEEDED: Version-specific swap builders
async function buildMeteoraDammV1SwapIx(hop: DirectHop): Promise<any[]> {
  // Use DAMM v1 program ID and instructions
}

async function buildMeteoraDammV2SwapIx(hop: DirectHop): Promise<any[]> {
  // Use DAMM v2 program ID and instructions
}

// Update resolver to detect DAMM vs DLMM
if (dex.includes('MeteoraBalanced_v1')) {
  variant = 'damm_v1';
} else if (dex.includes('MeteoraBalanced_v2')) {
  variant = 'damm_v2';
} else if (dex === 'meteora') {
  variant = 'dlmm';
}
```

## Breaking Changes

### For Existing Pools
- ✅ **Backward Compatible**: Old data will default correctly
  - V2 API pools without `pool_version` → defaults to `2`
  - V1 API pools without `pool_version` → defaults to `1`

### For Graph
- ⚠️ **Edge DEX Names Changed**:
  - Old: `'MeteoraBalanced'`
  - New: `'MeteoraBalanced_v1'` or `'MeteoraBalanced_v2'`
- ⚠️ **More Edges**: Same pairs may now appear twice (once per version)

### For Execution
- 🚨 **Swap Logic Needed**: Currently we don't have DAMM swap builders
- 🚨 **Will Fail**: Trying to route through these pools will fail until swap logic is added

## Files Modified

1. **`backend/src/server/pools/meteoraBalanced.ts`**
   - Updated `normalizeMeteoraBalancedHttp()` to extract `pool_version` and set `dex` field
   - Updated `normalizeMeteoraBalancedV1()` to extract `pool_version` and set `dex` field
   - Changed `fetchMeteoraBalancedAll()` to concatenate instead of merge

2. **`backend/src/server/graph.ts`**
   - Updated edge creation to use dynamic `dexName` from pool object
   - Now creates edges with version-specific labels

## Testing

### Verify Version Detection
```bash
# Check logs for pool version extraction
grep "MeteoraBalanced_v1\|MeteoraBalanced_v2" logs/
```

### Verify Graph Edges
```bash
# Query graph snapshot
curl http://localhost:3000/api/graph | jq '.edges[] | select(.dex | contains("MeteoraBalanced"))'

# Should see both:
# {"dex": "MeteoraBalanced_v1", ...}
# {"dex": "MeteoraBalanced_v2", ...}
```

### Check for Duplicates
```bash
# Same pair on both versions is EXPECTED and CORRECT
# They are different pools on different programs
```

## Next Steps (TODO)

1. ✅ **Pool Separation**: Complete
2. ✅ **Graph Labels**: Complete
3. ⚠️ **Execution Logic**: **NEEDED** - Add DAMM v1 and v2 swap builders
4. ⚠️ **Program IDs**: **NEEDED** - Add v1 and v2 program addresses to config
5. ⚠️ **Resolver Logic**: **NEEDED** - Detect DAMM vs DLMM and version
6. ⚠️ **UI Updates**: Consider showing version in pool display

## References

- [Meteora DAMM v1 Documentation](https://docs.meteora.ag/overview/products/damm-v1/what-is-damm-v1)
- [Meteora DAMM v2 Documentation](https://docs.meteora.ag/overview/products/damm-v2/what-is-damm-v2)
- [Meteora V2 vs V1 Comparison](https://medium.com/@webrin/meteora-v2-vs-v1-everything-new-improved-9ead0992777a)
- [V1 API Documentation](https://docs.meteora.ag/api-reference/pools/get_pools)

## Summary

**This was a critical bug fix.** We were treating different on-chain programs as the same pool type, which would have caused:
- Failed transactions (wrong swap instructions)
- Missing liquidity (v1 pools dropped when v2 exists)
- Routing errors (couldn't distinguish programs)

**Now fixed:** V1 and V2 pools are correctly separated with distinct labels (`MeteoraBalanced_v1` vs `MeteoraBalanced_v2`), allowing the system to route through both versions and (eventually) build correct swap instructions for each.

**Next Priority:** Implement DAMM v1 and v2 swap builders in the execution layer to actually execute swaps through these pools.

