# Orca -rev Suffix Fix

**Date**: 2025-11-10  
**Status**: ✅ Fixed  
**Category**: Transaction Building / Quote Resolution

## Problem

When attempting to execute arbitrage opportunities involving Orca Whirlpool pools with reversed direction (indicated by `-rev` suffix), the system was failing with:

```
Error: Non-base58 character
Error: Expected base58-encoded address string of length in the range [32, 44]. Actual length: 48.
```

**Root Cause**: The `-rev` suffix was not being stripped from Orca pool IDs before passing them to Solana `PublicKey` constructors and Orca SDK functions.

### Example Error Log

```
poolId="27ExzqiGapKFd6NhffapRfdSkuykTVUqY5qeuNnrzBNm-rev"
[ERROR] Non-base58 character
[ERROR] ORCA_BUILD_FAILED: build failed: Non-base58 character
```

The `-rev` suffix is a routing system convention to indicate reversed swap direction (B→A instead of A→B), but Solana PublicKeys must be valid base58-encoded addresses without any suffix.

## Solution

Similar to the previous Raydium fix, strip the `-rev` suffix before creating `PublicKey` objects or passing pool IDs to SDK functions. This matches the pattern already used in the Orca and Meteora resolver modules.

### Changes Made

#### 1. Quote Resolution (`backend/src/execution/resolver/quotes.ts`)

**Location**: Line 52-55

```typescript
const client = (buildWhirlpoolClient as any)(ctx);
// Strip -rev suffix before creating PublicKey (similar to Raydium/Meteora)
const poolIdStripped = hop.poolId.replace(/-rev$/, '');
const pool = await client.getPool(new PublicKey(poolIdStripped));
```

#### 2. SDK Swap Builder (`backend/src/execution/builder/ix.ts`)

**Location**: `buildOrcaSwapViaSdk()` function (lines 496-499)

```typescript
await ensureOrcaSdkConfig();
const rpc = getOrcaRpc();
const signer = await getOrcaSdkSigner(kp);
// Strip -rev suffix before creating address (similar to Raydium/Meteora)
const poolIdStripped = String(hop.poolId).replace(/-rev$/, '');
const poolAddr = address(poolIdStripped);
const inputMintAddr = address(String(hop.inputMint));
```

#### 3. Main Swap Builder (`backend/src/execution/builder/ix.ts`)

**Location**: `buildOrcaSwapIx()` function (lines 662-665)

```typescript
const connection = getConnection();
const kp = await ensureWallet(CONFIG.walletPath);
// Strip -rev suffix before using poolId (similar to Raydium/Meteora)
const poolIdStripped = String(hop.poolId).replace(/-rev$/, '');
const poolAddr = poolIdStripped;
const inputMint = String(hop.inputMint);
```

**Location**: Precheck validation (line 676)

```typescript
const { PublicKey } = await import('@solana/web3.js');
// Use stripped poolId for PublicKey creation
const pk = new PublicKey(poolIdStripped);
```

The fallback path at line 804 automatically uses the correct `poolAddr` variable which already contains the stripped value.

## Pattern Consistency

This fix brings Orca handling in line with the existing patterns:

1. **Orca Resolver** (`backend/src/execution/resolver/orca.ts:10`):
   ```typescript
   const id = hop.poolId.replace(/-rev$/, '');
   ```

2. **Meteora Resolver** (`backend/src/execution/resolver/meteora.ts:13`):
   ```typescript
   const id = hop.poolId.replace(/-rev$/, '');
   ```

3. **Raydium Quote Logic** (`backend/src/execution/resolver/quotes.ts:152`):
   ```typescript
   const isRev = /-rev$/.test(hop.poolId || '');
   const id = hop.poolId.replace(/-rev$/, '');
   ```

Now all DEX handlers consistently strip the `-rev` suffix before creating Solana `PublicKey` objects.

## Testing

The fix should be tested by:

1. Running the system with arbitrage opportunities that include Orca pools in reversed direction
2. Verifying that quotes are successfully obtained for Orca `-rev` pools
3. Confirming that transaction building completes without "Non-base58 character" errors
4. Checking that the correct swap direction is maintained (the `-rev` indicator is preserved in `hop.poolId` throughout the pipeline, only stripped when creating PublicKeys)

## Impact

- ✅ Fixes quote resolution for Orca reversed-direction pools
- ✅ Fixes transaction building for Orca reversed-direction pools  
- ✅ Maintains consistent pattern across all DEX implementations
- ✅ No changes to routing logic or direction handling
- ✅ Zero impact on non-reversed Orca pools

## Related Fixes

- `RAYDIUM_AMM_KEY_FALLBACK_FIX.md` - Similar fix for Raydium AMM pools
- `RAYDIUM_PUBLICKEY_EXTRACTION_FIX.md` - Raydium PublicKey handling improvements

## Files Modified

- `backend/src/execution/resolver/quotes.ts`
- `backend/src/execution/builder/ix.ts`

---

**Note**: The `-rev` suffix convention is a system-level routing indicator and should remain in the pool ID throughout the execution pipeline. It should only be stripped at the point where we need to create Solana `PublicKey` objects or call DEX SDK functions that expect clean base58 addresses.

