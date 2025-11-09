# Quick Start: Creating DEX-Specific ALTs

## Prerequisites
- Backend server running
- Wallet configured with SOL for ALT creation (~0.01 SOL per ALT)
- Graph populated with pool data

## Step 1: Create Common ALT (if not exists)

```bash
curl -X POST http://localhost:3040/api/arb/alts/create \
  -H "Content-Type: application/json" \
  -d '{"category": "common"}'
```

## Step 2: Create DEX-Specific ALTs

### Meteora DLMM ALT
```bash
curl -X POST http://localhost:3040/api/arb/alts/create-dex-alt \
  -H "Content-Type: application/json" \
  -d '{
    "dex": "meteora",
    "poolType": "clmm",
    "maxPools": 30,
    "category": "meteora-dlmm"
  }'
```

### Orca Whirlpool ALT
```bash
curl -X POST http://localhost:3040/api/arb/alts/create-dex-alt \
  -H "Content-Type: application/json" \
  -d '{
    "dex": "orca",
    "poolType": "clmm",
    "maxPools": 30,
    "category": "orca-whirlpool"
  }'
```

### Raydium CLMM ALT
```bash
curl -X POST http://localhost:3040/api/arb/alts/create-dex-alt \
  -H "Content-Type: application/json" \
  -d '{
    "dex": "raydium",
    "poolType": "clmm",
    "maxPools": 30,
    "category": "raydium-clmm"
  }'
```

### Raydium AMM ALT (optional)
```bash
curl -X POST http://localhost:3040/api/arb/alts/create-dex-alt \
  -H "Content-Type: application/json" \
  -d '{
    "dex": "raydium",
    "poolType": "amm",
    "maxPools": 30,
    "category": "raydium-amm"
  }'
```

## Step 3: Verify ALTs Created

```bash
curl http://localhost:3040/api/arb/alts/status
```

Expected output:
```json
{
  "initialized": true,
  "altCount": 4,
  "categories": ["common", "meteora-dlmm", "orca-whirlpool", "raydium-clmm"],
  "addresses": {
    "common": "ABC123...",
    "meteora-dlmm": "DEF456...",
    "orca-whirlpool": "GHI789...",
    "raydium-clmm": "JKL012..."
  }
}
```

## Step 4: Test with Multi-Hop Transaction

Try building a multi-hop transaction that uses multiple DEXes. The system will automatically:
1. Load all relevant ALTs
2. Compress account references
3. Build transaction within size limits

Example route: SOL → USDC (Raydium) → SOL (Meteora) → USDC (Orca)
- Uses 3 DEXes: Raydium, Meteora, Orca
- System loads: `common`, `raydium-clmm`, `meteora-dlmm`, `orca-whirlpool`
- Transaction should build successfully without size errors

## Maintenance: Refresh ALTs

Update ALTs periodically (e.g., daily) to keep pool data fresh:

```bash
# Refresh Meteora ALT
curl -X POST http://localhost:3040/api/arb/alts/refresh-dex-alt \
  -H "Content-Type: application/json" \
  -d '{"category": "meteora-dlmm", "maxPools": 30}'

# Refresh Orca ALT
curl -X POST http://localhost:3040/api/arb/alts/refresh-dex-alt \
  -H "Content-Type: application/json" \
  -d '{"category": "orca-whirlpool", "maxPools": 30}'

# Refresh Raydium ALT
curl -X POST http://localhost:3040/api/arb/alts/refresh-dex-alt \
  -H "Content-Type: application/json" \
  -d '{"category": "raydium-clmm", "maxPools": 30}'
```

## Troubleshooting

### Error: "No accounts collected"
- Graph is not populated with pool data
- Wait for pools to sync or trigger manual refresh

### Error: "Transaction too large" still occurs
- Increase `maxPools` to 40 or 50
- Verify ALTs were created successfully
- Check that route uses pools included in ALTs

### Error: "ALT with category already exists"
- ALT already created, use refresh endpoint instead
- Or delete existing ALT and recreate

## Configuration

Save ALT addresses to config for persistence:

```json
{
  "execution": {
    "lookupTableAddresses": [
      "ABC123...",  // common
      "DEF456...",  // meteora-dlmm
      "GHI789...",  // orca-whirlpool
      "JKL012..."   // raydium-clmm
    ]
  }
}
```

The system also auto-saves to `.alt-config.json`:
```json
{
  "alts": {
    "common": "ABC123...",
    "meteora-dlmm": "DEF456...",
    "orca-whirlpool": "GHI789...",
    "raydium-clmm": "JKL012..."
  },
  "walletPublicKey": "YourWalletAddress",
  "lastValidated": 1699564800000
}
```

