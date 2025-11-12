# Meteora Balanced & Pumpswap Integration Analysis
## From Fetch → Graph → Detector → Execution

## Overview

This document traces the complete flow for **Meteora Balanced (DAMM)** and **Pumpswap** pools through the entire system, identifying what's working and what needs to be built.

---

## 🟢 WORKING: Meteora Balanced (DAMM v1 & v2)

### 1. Fetch & Normalize ✅

**Files**: `backend/src/server/pools/meteoraBalanced.ts`

```typescript
// V1 API Fetch
fetchMeteoraBalancedV1Http()
  → Returns pools from damm-api.meteora.ag/pools
  → Filters by anchor tokens (SOL/USDC) if enabled
  → Applies API-level quality filters (hideLowTvl, hideLowApr)

// V2 API Fetch  
fetchMeteoraBalancedV2Http()
  → Returns pools from dammv2-api.meteora.ag/pools
  → RPC enrichment to get vault balances
  
// Normalization
normalizeMeteoraBalancedV1()
  → Extracts pool_version from API
  → Sets dex: 'MeteoraBalanced_v1' or 'MeteoraBalanced_v2'
  → Populates: decimals, reserves, pool_liquidity_raw, tvl_usd, price_a_per_b
  
normalizeMeteoraBalancedHttp()
  → Same as V1 normalizer
  → Handles V2 enriched data
```

**Output**: `AmmPool[]` with complete fields
- ✅ `id`, `mint_a`, `mint_b`
- ✅ `dex`: `'MeteoraBalanced_v1'` or `'MeteoraBalanced_v2'`
- ✅ `fee_bps`, `price_a_per_b`
- ✅ `decimals_a`, `decimals_b`
- ✅ `amount_a_whole`, `amount_b_whole`
- ✅ `reserve_a_raw`, `reserve_b_raw`
- ✅ `pool_liquidity_raw`, `tvl_usd`

### 2. Graph Integration ✅

**File**: `backend/src/server/graph.ts`

```typescript
// Meteora Balanced AMM section (lines 1304-1335)
for (const p of (mblValid.amm || [])) {
  const dexName = (p as any)?.dex || 'MeteoraBalanced';  // ✅ Uses version
  const rawLiqMbal = Number(pool_liquidity_raw || liquidity_base || 0);
  
  addEdge(mint_a, mint_b, dexName, fee_bps, liqDisplay, fwd, usd, pid, 
          account_a, account_b, 'amm', 'forward', rawLiqMbal);
  addEdge(mint_b, mint_a, dexName, fee_bps, liqDisplay, rev, usd, pidRev, 
          account_b, account_a, 'amm', 'reverse', rawLiqMbal);
}
```

**Graph Edges Created**: ✅
- `source`: mint_a
- `target`: mint_b  
- `dex`: `'MeteoraBalanced_v1'` or `'MeteoraBalanced_v2'` (version-aware)
- `pool_kind`: `'amm'`
- `fee_bps`: fee in basis points
- `price_a_per_b`: exchange rate
- `pool_liquidity_raw`: raw liquidity value
- `pool_id`: pool address
- `direction`: 'forward' | 'reverse'

### 3. Detector/Arbfinder ✅

**File**: `backend/src/arb/` (Rust arb-rs binary)

The arbfinder receives the graph snapshot and:
- ✅ Reads all edges including `MeteoraBalanced_v1` and `MeteoraBalanced_v2`
- ✅ Detects arbitrage cycles through these edges
- ✅ Returns opportunities with `hop_dexes` array

**Output Example**:
```json
{
  "path": ["SOL", "USDC", "SOL"],
  "dexes": ["MeteoraBalanced_v1"],
  "hop_dexes": ["MeteoraBalanced_v1", "MeteoraBalanced_v1"],
  "hop_pool_ids": ["abc123", "def456"],
  "profit_bps": 150
}
```

---

## 🔴 MISSING: Meteora Balanced Execution

### 4. Resolver ❌ PARTIAL

**File**: `backend/src/execution/resolver/index.ts` (lines 19-49)

```typescript
// Current logic (lines 20-21)
const dexv = String(dexes[i] || '').toLowerCase();
const dex = (dexv.includes('raydium') ? 'raydium' : 
             (dexv.includes('orca') ? 'orca' : 
             (dexv.includes('pumpswap') ? 'pumpswap' : 'meteora')));

// ❌ PROBLEM: 'MeteoraBalanced_v1' → dex='meteora', variant='dlmm'
// This will try to use DLMM logic for DAMM pools!
```

**What Happens**:
1. `'MeteoraBalanced_v1'` doesn't match any specific check
2. Falls through to `else` → `dex = 'meteora'`
3. Line 48: `variant = 'dlmm'` (WRONG!)
4. Lines 127-128: Calls `resolveMeteoraDlmm(hop)` (WRONG RESOLVER!)

**What's Needed**:
```typescript
// ✅ FIX: Detect Meteora Balanced specifically
const dex = (
  dexv.includes('raydium') ? 'raydium' : 
  dexv.includes('orca') ? 'orca' : 
  dexv.includes('pumpswap') ? 'pumpswap' :
  dexv.includes('meteorabalanced') ? 'meteora_balanced' :  // NEW
  'meteora'
) as DirectHop['dex'];

// Variant assignment
if (dex === 'meteora_balanced') {
  if (dexv.includes('_v1')) variant = 'damm_v1';
  else if (dexv.includes('_v2')) variant = 'damm_v2';
  else variant = 'damm_v1';  // Default
} else if (dex === 'meteora') {
  variant = 'dlmm';
}

// Resolver dispatch
if (hop.dex === 'meteora_balanced') {
  const { resolveMeteoraDamm } = await import('./meteoraDamm.js');
  return await resolveMeteoraDamm(hop);
}
```

### 5. Meteora DAMM Resolver ❌ MISSING

**File**: `backend/src/execution/resolver/meteoraDamm.ts` (DOESN'T EXIST)

**Needs to be created**:
```typescript
export async function resolveMeteoraDamm(hop: DirectHop): Promise<DirectHop> {
  // 1. Get program ID based on version
  if (hop.variant === 'damm_v1') {
    hop.programId = CONFIG.meteora?.dammV1ProgramId || '<v1-program-id>';
  } else {
    hop.programId = CONFIG.meteora?.dammV2ProgramId || '<v2-program-id>';
  }
  
  // 2. Lookup pool from cache
  const { peekMeteoraBalancedPools } = await import('../../server/pools.js');
  const pools = peekMeteoraBalancedPools();
  const id = hop.poolId.replace(/-rev$/, '');
  const p = (pools.amm || []).find((x: any) => String(x?.id || '') === id);
  
  if (p) {
    // 3. Set vault accounts (token A and B vaults)
    hop.vaultA = String((p as any)?.account_a || '');
    hop.vaultB = String((p as any)?.account_b || '');
    
    // 4. Set LP mint and other DAMM-specific accounts
    hop.lpMint = String((p as any)?.lp_mint || '');
    
    // 5. DAMM pools may have additional accounts (yield vaults, etc.)
    // Need to research DAMM program structure
  }
  
  return hop;
}
```

### 6. Quote Function ❌ MISSING

**File**: `backend/src/execution/resolver/quotes.ts` (lines 7-299)

Currently handles: Orca, Raydium, Pumpswap, Meteora DLMM

**Needs to be added**:
```typescript
// In quoteHopOut() function, add new branch
else if (hop.dex === 'meteora_balanced') {
  // DAMM constant product formula: x * y = k
  // Similar to Raydium AMM or Pumpswap
  
  const pools = peekMeteoraBalancedPools();
  const id = hop.poolId.replace(/-rev$/, '');
  const p = (pools.amm || []).find((x: any) => String(x?.id || '') === id);
  
  if (p) {
    const isReverse = /-rev$/.test(hop.poolId);
    const reserveIn = isReverse ? 
      BigInt(p.reserve_b_raw || 0) : BigInt(p.reserve_a_raw || 0);
    const reserveOut = isReverse ? 
      BigInt(p.reserve_a_raw || 0) : BigInt(p.reserve_b_raw || 0);
    const feeBps = BigInt(p.fee_bps || 0);
    
    if (reserveIn > 0n && reserveOut > 0n) {
      // Constant product: amountOut = (reserveOut * amountIn * (10000 - fee)) / 
      //                                (reserveIn * 10000 + amountIn * (10000 - fee))
      const amountInWithFee = amountInRaw * (10000n - feeBps);
      const numerator = reserveOut * amountInWithFee;
      const denominator = reserveIn * 10000n + amountInWithFee;
      return numerator / denominator;
    }
  }
}
```

### 7. Instruction Builder ❌ MISSING

**File**: `backend/src/execution/builder/ix.ts`

Currently has:
- `buildRaydiumAmmSwapIxReal()` ✅
- `buildRaydiumClmmSwapIxReal()` ✅
- `buildOrcaSwapIx()` ✅
- `buildPumpswapSwapIxReal()` ✅
- `buildMeteoraDlmmSwapIxReal()` ✅

**Needs to be created**:
```typescript
export async function buildMeteoraDammV1SwapIx(hop: DirectHop): Promise<any[]> {
  // 1. Import DAMM v1 SDK/IDL
  // 2. Build swap instruction with:
  //    - Pool account
  //    - Vault accounts (A & B)
  //    - User token accounts
  //    - LP mint
  //    - Amount in/out
  // 3. Return instruction array
}

export async function buildMeteoraDammV2SwapIx(hop: DirectHop): Promise<any[]> {
  // Similar to v1 but with v2 program structure
  // v2 has additional features (dynamic fees, NFT positions, etc.)
}
```

**Called from**: `backend/src/execution/builder/tx.ts` (lines 551-563)
```typescript
// Need to add new branches
if (hop.dex === 'meteora_balanced' && hop.variant === 'damm_v1') {
  ixs = await buildMeteoraDammV1SwapIx(hop);
} else if (hop.dex === 'meteora_balanced' && hop.variant === 'damm_v2') {
  ixs = await buildMeteoraDammV2SwapIx(hop);
}
```

### 8. Type Definitions ❌ MISSING

**File**: `backend/src/execution/types.ts`

Need to update:
```typescript
export interface DirectHop {
  dex: 'raydium' | 'orca' | 'pumpswap' | 'meteora' | 'meteora_balanced';  // Add this
  variant: 'amm' | 'clmm' | 'dlmm' | 'damm_v1' | 'damm_v2';  // Add these
  // ... rest
}
```

---

## 🟢 WORKING: Pumpswap

### 1. Fetch & Normalize ✅

**File**: `backend/src/server/pools/pumpswap.ts`

```typescript
fetchPumpswapPoolsHttp()
  → GraphQL query to Shyft API
  → Gets bonding curve pools from pump.fun
  
enrichPumpswapPoolsWithRpc()
  → Fetches vault balances via RPC
  → Calculates reserves and prices
  
normalizePumpswapHttp()
  → Sets dex: 'Pumpswap'
  → Populates all required fields
```

**Output**: `AmmPool[]` with:
- ✅ `dex`: `'Pumpswap'`
- ✅ All standard AMM fields populated

### 2. Graph Integration ✅

**File**: `backend/src/server/graph.ts` (lines 1336-1355)

```typescript
for (const p of (pumpValid.amm || [])) {
  const rawLiqPump = Number(pool_liquidity_raw || liquidity_base || 0);
  addEdge(mint_a, mint_b, 'Pumpswap', fee_bps, liqDisplay, fwd, usd, pid,
          account_a, account_b, 'amm', 'forward', rawLiqPump);
  addEdge(mint_b, mint_a, 'Pumpswap', fee_bps, liqDisplay, rev, usd, pidRev,
          account_b, account_a, 'amm', 'reverse', rawLiqPump);
}
```

✅ Creates proper graph edges

### 3. Detector ✅

✅ Arbfinder detects opportunities through Pumpswap edges

### 4. Resolver ✅

**File**: `backend/src/execution/resolver/index.ts` (lines 45-46)

```typescript
else if (dex === 'pumpswap') {
  variant = 'amm';
}
```

**File**: `backend/src/execution/resolver/pumpswap.ts`

```typescript
export async function resolvePumpswap(hop: DirectHop): Promise<DirectHop> {
  // Sets program ID, vault accounts, etc.
  ✅ COMPLETE
}
```

### 5. Quote Function ✅

**File**: `backend/src/execution/resolver/quotes.ts` (lines 205-251)

```typescript
else if (hop.dex === 'pumpswap') {
  // Constant product AMM formula
  ✅ COMPLETE - uses reserves and fee to calculate output
}
```

### 6. Instruction Builder ✅

**File**: `backend/src/execution/builder/ix.ts`

```typescript
export async function buildPumpswapSwapIxReal(hop: DirectHop): Promise<any[]> {
  ✅ COMPLETE - builds swap instruction for pAMM program
}
```

**Called from**: `backend/src/execution/builder/tx.ts` (lines 557-559)
```typescript
else if (hop.dex === 'pumpswap') {
  ixs = await buildPumpswapSwapIxReal(hop);
}
```

---

## Summary Table

| Component | Meteora Balanced | Pumpswap | Notes |
|-----------|------------------|----------|-------|
| **Fetch** | ✅ Complete | ✅ Complete | Both working |
| **Normalize** | ✅ Complete | ✅ Complete | Both working |
| **Graph Edges** | ✅ Complete | ✅ Complete | Both create proper edges |
| **Detector** | ✅ Works | ✅ Works | Arbfinder sees both |
| **Resolver Detection** | ❌ Broken | ✅ Works | DAMM → DLMM (wrong!) |
| **Resolver Logic** | ❌ Missing | ✅ Works | Need meteoraDamm.ts |
| **Quote Function** | ❌ Missing | ✅ Works | Need DAMM quoting |
| **Instruction Builder** | ❌ Missing | ✅ Works | Need v1 & v2 builders |
| **Type Definitions** | ❌ Missing | ✅ Works | Need damm_v1/v2 variants |

---

## Critical Gaps

### For Meteora Balanced (Priority: HIGH)

1. **Resolver Detection** (URGENT)
   - Fix line 21 in `resolver/index.ts` to detect `'meteorabalanced'` substring
   - Map to `dex: 'meteora_balanced'` and `variant: 'damm_v1'` or `'damm_v2'`

2. **Create meteoraDamm.ts Resolver**
   - Lookup pools from cache
   - Set program ID (v1 vs v2)
   - Set vault accounts, LP mint

3. **Add Quote Function**
   - Constant product formula like Raydium AMM
   - Use `reserve_a_raw`, `reserve_b_raw`, `fee_bps`

4. **Create Instruction Builders**
   - `buildMeteoraDammV1SwapIx()` - for v1 program
   - `buildMeteoraDammV2SwapIx()` - for v2 program
   - Research program structure/IDL

5. **Update Type Definitions**
   - Add `'meteora_balanced'` to DirectHop.dex union
   - Add `'damm_v1'` and `'damm_v2'` to variant union

6. **Config**
   - Add DAMM v1 program ID
   - Add DAMM v2 program ID

### For Pumpswap (Priority: LOW)

✅ **COMPLETE** - Fully integrated from fetch to execution

---

## Next Steps

1. ✅ Fix resolver to detect Meteora Balanced
2. ✅ Create DAMM resolver (meteoraDamm.ts)
3. ✅ Add DAMM quote function
4. ⚠️ Research DAMM v1/v2 program structure
5. ⚠️ Create instruction builders (requires SDK/IDL)
6. ✅ Update type definitions

**Note**: Pumpswap is fully functional. Meteora Balanced pools will appear in graph and be detected by arbfinder, but execution will FAIL until steps 1-6 are complete.

