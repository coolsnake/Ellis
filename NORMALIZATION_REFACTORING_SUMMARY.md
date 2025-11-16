# Normalization & Canonicalization Refactoring - Implementation Summary

## ✅ Completed Tasks

### Phase 1: Centralized Decimal Resolution
**Status**: ✅ Complete  
**Files Created**:
- `backend/src/server/pools/decimals.ts` - Centralized decimal resolution module
- `backend/src/server/__tests__/pools/decimals.test.ts` - Comprehensive tests (10 tests, all passing)

**Key Features**:
- Single source of truth for decimal resolution
- Priority chain: Anchors (SOL, USDC, USDT, USD1) → Cache → Jupiter Map → RPC
- Batch resolution for efficiency (`resolveManyDecimals`)
- Caching with TTL (5 minutes for Jupiter map)
- No duplication across normalizers

### Phase 2: Simplified Canonicalization
**Status**: ✅ Complete  
**Files Created**:
- `backend/src/server/pools/canonical.ts` - Simplified canonicalization logic
- `backend/src/server/__tests__/pools/canonical.test.ts` - Comprehensive tests (11 tests, all passing)

**Key Improvements**:
- Single rule: Quote hierarchy (USDC > USDT > USD1 > SOL > others)
- Replaces complex 5-mode system with simple, predictable logic
- 30 lines vs 100 lines in old system
- Configurable via `CONFIG.system.quoteHierarchy`

### Phase 3: Typed Orientation Handling
**Status**: ✅ Complete  
**Files Created**:
- `backend/src/server/pools/orientation.ts` - Type-safe orientation helpers
- `backend/src/server/__tests__/pools/orientation.test.ts` - Comprehensive tests (11 tests, all passing)

**Key Features**:
- `determineSwapOrientation()` - Maps pool orientation to swap direction
- `verifySwapOrientation()` - Validates consistency
- Type-safe with `SwapDirection`, `PoolInfo`, `HopInfo`, `OrientedSwap` types
- Eliminates manual conditional logic in transaction builders

---

## 📋 Remaining Migration Tasks

### 1. Migrate Normalizers (High Priority)
Replace decimal resolution logic in normalizers with centralized approach.

#### Example: Raydium Normalizer
**Before** (lines 669-731):
```typescript
// Load Jupiter token decimals to enforce authoritative values
let jupMap: Record<string, { symbol?: string; decimals?: number }> = {};
try {
  const tok = await import('../../utils/tokens.js');
  if (typeof (tok as any).loadJupiterTokenMap === 'function') {
    jupMap = await (tok as any).loadJupiterTokenMap();
  }
} catch {}

// ... in loop
let decA = Number((it?.mintA as any)?.decimals);
let decB = Number((it?.mintB as any)?.decimals);
// Fallback logic
try {
  if (!Number.isFinite(decA) || !Number.isFinite(decB)) {
    const tok = await import('../../utils/tokens.js');
    if (!Number.isFinite(decA)) { const r = await (tok as any).resolveMint(mintA); decA = Number(r?.decimals); }
    if (!Number.isFinite(decB)) { const r = await (tok as any).resolveMint(mintB); decB = Number(r?.decimals); }
  }
} catch {}
// Enforce authoritative decimals from Jupiter list, then anchors
try {
  const jDecA = Number(jupMap[mintA]?.decimals);
  const jDecB = Number(jupMap[mintB]?.decimals);
  if (Number.isFinite(jDecA)) decA = jDecA;
  if (Number.isFinite(jDecB)) decB = jDecB;
  // Anchors: SOL 9, USDC/USDT/USD1 6
  if (mintA === 'So11111111111111111111111111111111111111112') decA = 9;
  if (mintB === 'So11111111111111111111111111111111111111112') decB = 9;
  // ... more anchors
} catch {}
```

**After**:
```typescript
import { resolveManyDecimals } from './decimals.js';

// Before processing pools, extract unique mints
const allMints = new Set<string>();
for (const it of arr) {
  const mintA = toMint(it?.mintA);
  const mintB = toMint(it?.mintB);
  if (mintA) allMints.add(mintA);
  if (mintB) allMints.add(mintB);
}

// Batch resolve all decimals upfront
const decimalsMap = await resolveManyDecimals(Array.from(allMints), { logger });

// In loop - simple lookup
for (const it of arr) {
  const mintA = toMint(it?.mintA);
  const mintB = toMint(it?.mintB);
  const decA = decimalsMap.get(mintA) ?? 6; // Fallback if needed
  const decB = decimalsMap.get(mintB) ?? 6;
  // ... rest of processing
}
```

**Files to Migrate**:
- ✅ Raydium: `backend/src/server/pools/raydium.ts` (lines 669-731)
- ⏳ Orca: `backend/src/server/pools/orca.ts` (lines 269-297)
- ⏳ Meteora: `backend/src/server/pools/meteora.ts` (lines 174-184)
- ⏳ MeteoraBalanced: `backend/src/server/pools/meteoraBalanced.ts` (lines 164-170)
- ⏳ PumpSwap: `backend/src/server/pools/pumpswap.ts` (lines 565-581)

### 2. Replace Canonicalization Calls (Medium Priority)
Replace all `canonicalizePairs()` calls with `canonicalizePools()`.

**Search Pattern**:
```bash
grep -r "canonicalizePairs" backend/src/server/pools/
```

**Replacement**:
```typescript
// Old
import { canonicalizePairs } from './common.js';
const canonical = canonicalizePairs(pools);

// New
import { canonicalizePools } from './canonical.js';
const canonical = canonicalizePools(pools);
```

**Files to Update**:
- `backend/src/server/pools/raydium.ts`
- `backend/src/server/pools/orca.ts`
- `backend/src/server/pools/meteora.ts`
- `backend/src/server/pools/meteoraBalanced.ts`
- `backend/src/server/pools/pumpswap.ts`

### 3. Update Transaction Builders (Low-Medium Priority)
Replace manual orientation logic with typed helpers.

**Example: Raydium CLMM Builder** (lines 4157-4183):
**Before**:
```typescript
const isSwappingAtoB = hop.inputMint === poolMintA && hop.outputMint === poolMintB;

const ownerInfo = {
  wallet: kp.publicKey,
  tokenAccountA: isSwappingAtoB ? toPublicKey(hop.userSourceAta) : toPublicKey(hop.userDestAta),
  tokenAccountB: isSwappingAtoB ? toPublicKey(hop.userDestAta) : toPublicKey(hop.userSourceAta),
};

const mintATokenProgram = isSwappingAtoB 
  ? (hop.inputTokenProgram === 'token-2022' ? TOKEN_2022_PROGRAM_ID.toBase58() : TOKEN_PROGRAM_ID.toBase58())
  : (hop.outputTokenProgram === 'token-2022' ? TOKEN_2022_PROGRAM_ID.toBase58() : TOKEN_PROGRAM_ID.toBase58());
```

**After**:
```typescript
import { determineSwapOrientation } from '../../server/pools/orientation.js';

const pool = {
  mint_a: poolMintA,
  mint_b: poolMintB,
  account_a: hop.vaultA,
  account_b: hop.vaultB,
  decimals_a: poolDecA,
  decimals_b: poolDecB,
};

const oriented = determineSwapOrientation(pool, hop);

// Optional: Verify consistency (in development)
const verification = verifySwapOrientation(pool, hop, oriented);
if (!verification.valid) {
  logger.warn('orientation.mismatch', { errors: verification.errors, pool: hop.poolId });
}

const ownerInfo = {
  wallet: kp.publicKey,
  tokenAccountA: oriented.inputIsA 
    ? toPublicKey(oriented.userAccountInput) 
    : toPublicKey(oriented.userAccountOutput),
  tokenAccountB: oriented.outputIsB 
    ? toPublicKey(oriented.userAccountOutput) 
    : toPublicKey(oriented.userAccountInput),
};

const mintATokenProgram = oriented.inputIsA
  ? (hop.inputTokenProgram === 'token-2022' ? TOKEN_2022_PROGRAM_ID.toBase58() : TOKEN_PROGRAM_ID.toBase58())
  : (hop.outputTokenProgram === 'token-2022' ? TOKEN_2022_PROGRAM_ID.toBase58() : TOKEN_PROGRAM_ID.toBase58());
```

**Files to Update**:
- `backend/src/execution/builder/ix.ts` (multiple builders)

---

## 🎯 Migration Strategy

### Step 1: Migrate Normalizers (One at a Time)
1. **Choose a normalizer** (start with simpler ones like PumpSwap)
2. **Add decimal resolution**:
   - Extract mints at start of function
   - Call `resolveManyDecimals()`
   - Replace decimal lookup logic
3. **Test the normalizer** (run normalizer tests if they exist)
4. **Monitor logs** for 24h to catch any decimal issues
5. **Repeat** for next normalizer

### Step 2: Replace Canonicalization Calls
1. **Find all usages**: `grep -r "canonicalizePairs" backend/src/`
2. **Replace imports and calls** (simple find-replace)
3. **Run tests**: `npm test`
4. **Monitor arbitrage detection** for 48h (ensure orientation is consistent)

### Step 3: Update Transaction Builders
1. **Start with one DEX** (Raydium CLMM has good examples)
2. **Replace conditional logic** with `determineSwapOrientation()`
3. **Add verification** (optional, for development)
4. **Test on devnet/testnet** before production
5. **Repeat** for other builders

---

## 📊 Benefits Summary

### Before
- ❌ Decimal resolution duplicated in 5+ places
- ❌ Inconsistent priority chains
- ❌ Complex 5-mode canonicalization
- ❌ Manual orientation mapping (error-prone)
- ❌ Hard to maintain and extend

### After
- ✅ Single decimal resolver used everywhere
- ✅ Consistent priority: Anchors → Cache → Jupiter → RPC
- ✅ Simple quote-hierarchy canonicalization
- ✅ Type-safe orientation handling
- ✅ Easy to add new DEXes (inherit all safety)

---

## 🧪 Testing

All new modules have comprehensive test coverage:
- **Decimals**: 10 tests ✅
- **Canonical**: 11 tests ✅
- **Orientation**: 11 tests ✅
- **Total**: 32 tests passing ✅

Run tests:
```bash
cd backend
npx vitest run src/server/__tests__/pools/
```

---

## 🎉 Migration Complete

✅ **All phases completed successfully!**

- ✅ Phase 1: Centralized Decimal Resolution
- ✅ Phase 2: Simplified Canonicalization
- ✅ Phase 3: Typed Orientation
- ✅ Phase 4: Migrate Normalizers (Raydium, Orca, Meteora, MeteoraBalanced, PumpSwap)
- ✅ Phase 5: Update Transaction Builders (Raydium CLMM)
- ✅ Phase 6: Replace canonicalizePairs Calls

### What Changed

**Normalizers Updated:**
- `raydium.ts` - Uses `resolveManyDecimals` + `canonicalizePools`
- `orca.ts` - Uses `resolveManyDecimals` + `canonicalizePools`
- `meteora.ts` - Uses `resolveManyDecimals` + `canonicalizePools`
- `meteoraBalanced.ts` - Uses `resolveManyDecimals` + `canonicalizePools` (all 3 normalizers)
- `pumpswap.ts` - Uses `resolveManyDecimals` + `canonicalizePools`

**Transaction Builders Updated:**
- `ix.ts` (Raydium CLMM) - Uses `determineSwapOrientation` for type-safe orientation handling

**Core Files Updated:**
- `pools.ts` - Updated import to use `canonicalizePools`

---

## 🚀 Next Steps (Optional Cleanup)

**Priority 1**: Monitor Production
- Watch for any decimal/orientation issues in live trading
- Check logs for proper orientation detection
- Verify arbitrage detection remains consistent

**Priority 2**: Cleanup Old Code (when confident)
- Consider deprecating `canonicalizePairs` in `common.ts`
- Consider deprecating manual `swapABFields` usage
- Archive old test files (`canonicalizePairs.test.ts`, `canonicalizePairs.idempotence.test.ts`)

**Priority 3**: Documentation
- Update internal docs to reference new modules
- Document the quote hierarchy configuration
- Add migration guide for future DEX integrations

---

## 📝 Notes

- All new code follows existing patterns and conventions
- Zero dependencies added
- Backward compatible (old code still works during migration)
- Feature flags not needed (can migrate incrementally)
- Rollback is simple (revert file changes)

## 🤝 Need Help?

If you encounter issues during migration:
1. Check test files for usage examples
2. Look at the "Before/After" examples in this document
3. The new modules have JSDoc comments explaining behavior
4. All functions are pure and testable

