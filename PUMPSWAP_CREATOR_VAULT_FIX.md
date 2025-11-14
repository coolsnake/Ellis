# Pumpswap Creator Vault Derivation Fix

## Critical Issue Discovered

When the pool's `coin_creator` field is System Program (`11111111111111111111111111111111`), we were incorrectly using System Program as the creator vault addresses, causing a "Non-base58 character" error.

## Root Cause

The pool's `coin_creator` field at offset 211 being System Program does NOT mean we should use System Program for creator vault accounts. Instead, it means creator fees aren't configured in the pool, but the creator vault accounts must still be properly derived from the **meme token's actual creator**.

## Solution

Fetch the meme token's creator from its **Metaplex metadata** and derive the creator vault accounts from that:

### 1. Fetch Mint Metadata

```typescript
// Derive metadata PDA for the meme token (base mint)
const METADATA_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
const memeTokenMint = toPublicKey(poolBaseMint);

const [metadataPda] = PublicKey.findProgramAddressSync(
  [
    Buffer.from('metadata'),
    METADATA_PROGRAM_ID.toBuffer(),
    memeTokenMint.toBuffer(),
  ],
  METADATA_PROGRAM_ID
);

// Fetch metadata account
const metadataAccount = await connection.getAccountInfo(metadataPda);
// Extract update authority (bytes 1-33) as the creator
const updateAuthority = new PublicKey(metadataAccount.data.subarray(1, 33));
```

### 2. Fallback Logic

If metadata fetch fails or creator is still System Program:

```typescript
// Use bonding curve PDA as fallback
const [bondingCurvePda] = PublicKey.findProgramAddressSync(
  [Buffer.from('bonding-curve'), memeTokenMint.toBuffer()],
  PUMP_PROGRAM_ID
);
```

### 3. Derive Creator Vault Accounts

```typescript
const PUMP_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');

// Derive creator vault authority
const [vaultAuthority] = PublicKey.findProgramAddressSync(
  [
    Buffer.from('creator-vault-authority'),
    creatorPubkey.toBuffer(),
  ],
  PUMP_PROGRAM_ID
);

// Derive creator vault ATA (for quote token)
const creatorVaultAta = getAssociatedTokenAddressSync(
  toPublicKey(poolQuoteMint),
  vaultAuthority,
  true
);
```

## Why This Matters

For pool `Gf7sXMoP8iRw4iiXmJ1nq4vxcRycbGXy5RL8a8LnTd3v` (BANGERS-WSOL):
- Pool's `coin_creator`: System Program ❌
- **Actual creator** (from BANGERS mint metadata): Real address ✅
- **Derived Creator Vault Authority**: `8N3GDaZ2iwN65oxVatKTLPNooAVUJTbfiVJ1ahyqwjSk` ✅
- **Derived Creator Vault ATA**: `Ei6iux5MMYG8JxCTr58goADqFTtMroL9TXJityF3fAQc` ✅

## Key Insights

1. **Pool's `coin_creator` field ≠ Token creator**: The pool's `coin_creator` being System Program just means no creator fees are configured, but we still need proper creator vault accounts
2. **Meme token = Base mint**: For Pumpswap, the meme token (e.g., BANGERS) is always the base mint, not the quote (SOL/USDC)
3. **Metadata is source of truth**: The token's Metaplex metadata contains the actual creator
4. **All 21 accounts required**: Even with no creator fees, all 21 accounts must be present with valid addresses

## Files Modified

- `backend/src/execution/builder/ix.ts` - Lines 1344-1479: Complete rewrite of creator derivation logic

## Testing

After rebuild, test with:
```bash
arb singlehop sim pumpswap
```

Expected logs:
- `pumpswap.fetching_mint_metadata` - Shows metadata fetch attempt
- `pumpswap.metadata_creator_found` - Shows actual creator extracted
- `pumpswap.fallback.derived_accounts` - Shows correctly derived addresses

The transaction should now build successfully with proper creator vault accounts!

## References

- [Metaplex Token Metadata Program](https://docs.metaplex.com/programs/token-metadata/)
- [Pump.fun Program Documentation](https://github.com/pump-fun/pump-public-docs/blob/main/docs/PUMP_PROGRAM_README.md)
- [PumpSwap Creator Fee Documentation](https://github.com/pump-fun/pump-public-docs/blob/main/docs/PUMP_SWAP_CREATOR_FEE_README.md)

