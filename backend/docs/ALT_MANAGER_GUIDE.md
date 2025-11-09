# ALT Manager System - Comprehensive Account Collection

## Overview

The ALT (Address Lookup Table) manager has been enhanced to properly collect all pool-related accounts for each DEX. This significantly reduces transaction size by pre-loading frequently used accounts into ALTs.

## What Was Fixed

### 1. Pool Account Parsing
Previously, only pool addresses were collected. Now we parse pool state to extract:

#### Meteora DLMM
- Pool address
- ReserveX and ReserveY (token vaults)
- Oracle account
- TokenX and TokenY mints
- BitmapExtension (if exists)
- Note: Bin arrays are dynamic and calculated per-transaction

#### Raydium CLMM
- Pool address
- VaultA and VaultB (token vaults)
- Oracle account
- AmmConfig
- ObservationId
- MintA and MintB
- Note: Tick arrays are dynamic and calculated per-transaction

#### Raydium AMM
- Pool address
- BaseVault and QuoteVault
- LP mint
- Base and Quote mints
- Authority
- TargetOrders
- OpenOrders
- MarketId (Serum market)

#### Orca Whirlpool
- Pool address
- TokenVaultA and TokenVaultB
- TokenMintA and TokenMintB
- Oracle
- WhirlpoolsConfig
- Reward vaults and mints (if any)
- Note: Tick arrays are dynamic and calculated per-transaction

### 2. Separated ALT Categories

ALTs are now properly separated:

- **`common`** - Only system programs, common tokens, DEX program IDs
  - Token Program, System Program, ATA Program, Compute Budget Program
  - SOL, USDC, USDT mints
  - Raydium/Orca/Meteora program IDs
  - Meteora Event Authority PDA (appears in every Meteora swap)
  
- **`meteora-dlmm`** - Meteora DLMM pool accounts only
- **`orca-whirlpool`** - Orca Whirlpool pool accounts only
- **`raydium-clmm`** - Raydium CLMM pool accounts only
- **`raydium-amm`** - Raydium AMM pool accounts only

Pool-specific accounts (vaults, reserves, etc.) are NO LONGER in the common ALT.

## Usage

### Creating DEX-Specific ALTs

Use the API endpoint to create ALTs for each DEX:

```bash
# Create Meteora DLMM ALT with top 30 pools
curl -X POST http://localhost:3040/api/arb/alts/create-dex-alt \
  -H "Content-Type: application/json" \
  -d '{"dex": "meteora", "poolType": "clmm", "maxPools": 30}'

# Create Orca Whirlpool ALT with top 30 pools
curl -X POST http://localhost:3040/api/arb/alts/create-dex-alt \
  -H "Content-Type: application/json" \
  -d '{"dex": "orca", "poolType": "clmm", "maxPools": 30}'

# Create Raydium CLMM ALT with top 30 pools
curl -X POST http://localhost:3040/api/arb/alts/create-dex-alt \
  -H "Content-Type: application/json" \
  -d '{"dex": "raydium", "poolType": "clmm", "maxPools": 30}'
```

Response:
```json
{
  "address": "ALT_ADDRESS_HERE",
  "accountCount": 150,
  "dex": "meteora",
  "poolType": "clmm",
  "maxPools": 30,
  "category": "meteora-dlmm",
  "poolCount": 30
}
```

### Refreshing/Extending Existing ALTs

Update an existing ALT with fresh pool data:

```bash
curl -X POST http://localhost:3040/api/arb/alts/refresh-dex-alt \
  -H "Content-Type: application/json" \
  -d '{"category": "meteora-dlmm", "maxPools": 30}'
```

### Checking ALT Status

```bash
curl http://localhost:3040/api/arb/alts/status
```

Response:
```json
{
  "initialized": true,
  "altCount": 4,
  "categories": ["common", "meteora-dlmm", "orca-whirlpool", "raydium-clmm"],
  "addresses": {
    "common": "...",
    "meteora-dlmm": "...",
    "orca-whirlpool": "...",
    "raydium-clmm": "..."
  }
}
```

## Expected Results

### Before Enhancement
- Transaction had 78 accounts with 2 ALTs
- ALTs contained only ~20-30 actual accounts used by transaction
- **Result: "Transaction too large: encoding overruns Uint8Array"**

### After Enhancement
- Transaction still has 78 accounts with 2 ALTs
- But ALTs now contain vaults, reserves, oracles, etc.
- For Meteora: ~5-7 accounts per pool (pool, reserveX, reserveY, oracle, mints, bitmapExt)
- For Raydium CLMM: ~7-9 accounts per pool (pool, vaultA, vaultB, oracle, ammConfig, mints, etc.)
- For Orca: ~6-8 accounts per pool (pool, vaultA, vaultB, oracle, config, mints, etc.)
- **Expected Result: Transaction fits within size limits**

### Example Account Count
With 30 pools per DEX:
- Meteora DLMM ALT: ~180-210 accounts (30 pools × 6-7 accounts)
- Raydium CLMM ALT: ~210-270 accounts (30 pools × 7-9 accounts)
- Orca Whirlpool ALT: ~180-240 accounts (30 pools × 6-8 accounts)
- Common ALT: ~15-20 accounts (system programs + common tokens)

Total: ~585-740 accounts across ALTs

## Testing

Run the test script:

```bash
cd backend
npx tsx scripts/test-alt-collection.ts
```

This will:
1. Test account collection for each DEX
2. Parse specific pool accounts to verify extraction
3. Display account counts and samples
4. Check current ALT status

## Transaction Building

The transaction builder (`backend/src/execution/builder/tx.ts`) automatically:
1. Detects which DEXes are used in the route
2. Loads corresponding ALTs (e.g., if route uses Meteora + Orca, loads both ALTs)
3. Always includes common ALT for system programs
4. Uses ALTs to compress account references

Example for a 3-hop route (Raydium → Meteora → Orca):
- Loads ALTs: `common`, `raydium-clmm`, `meteora-dlmm`, `orca-whirlpool`
- Transaction accounts are compressed via ALT lookups
- Should fit within Solana's transaction size limit

## Notes

### Dynamic Accounts
Some accounts cannot be pre-loaded into ALTs because they change based on current state:
- **Tick Arrays** (Raydium CLMM, Orca): Calculated based on current tick position
- **Bin Arrays** (Meteora DLMM): Calculated based on active bin

These dynamic accounts will still be in the transaction but static accounts (vaults, reserves, oracles) will be in ALTs.

### Pool Selection
The `collectDexPoolAccounts` method:
1. Loads all pools from the graph
2. Filters by DEX and pool type
3. Sorts by TVL/liquidity (highest first)
4. Takes top N pools
5. For each pool, parses state to extract all accounts
6. Deduplicates accounts

This ensures the most frequently traded pools have their accounts in ALTs.

## Troubleshooting

### "Transaction too large" still occurs
1. Check ALT status to ensure accounts are loaded
2. Verify ALTs contain pool-specific accounts (vaults, reserves)
3. May need to increase maxPools to cover more pools
4. Check if route uses pools not in ALTs (will need to extend ALT)

### SDK parsing errors
- Raydium/Orca/Meteora SDKs may change their exported layout structures
- Check logs for parse failures: `alt.manager.*.parse.failed`
- May need to update layout accessors in `altManager.ts`

### Account mismatch
- Ensure pool data is fresh (pools may have migrated)
- Refresh ALTs periodically to keep accounts current
- Use `/arb/alts/refresh-dex-alt` endpoint

## Future Enhancements

1. **Automatic ALT refresh**: Periodically update ALTs with latest pool data
2. **Usage-based optimization**: Track which pools are actually used and prioritize those
3. **Bin/Tick array pre-calculation**: For common price ranges, pre-calculate and include in ALTs
4. **Multi-pool optimization**: Detect commonly used pool combinations and optimize ALTs accordingly

