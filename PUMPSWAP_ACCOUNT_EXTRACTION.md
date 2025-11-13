# Pumpswap Account Extraction Implementation

## Problem
The Pumpswap instruction builder was failing with error `Custom:3007` (AccountOwnedByWrongProgram) because it was missing several required accounts and was attempting to derive pool-specific PDA addresses using incorrect seeds.

Real Pumpswap transactions require 23 accounts (not 15), including:
- `coinCreatorVaultAta` - Creator's associated token account for the base mint
- `coinCreatorVaultAuthority` - PDA authority for the creator vault
- Additional constant accounts (Event Authority, Global Volume Accumulator, Fee Config, Fee Program)
- User-specific PDAs (User Volume Accumulator)

## Solution
Implemented a comprehensive account extraction and caching system during the RPC enrichment phase to:
1. **Extract pool-specific accounts from on-chain data** during pool normalization
2. **Store these addresses in the pool cache** to avoid RPC calls during transaction building
3. **Use cached addresses** instead of deriving PDAs with guessed seeds

## Implementation Details

### 1. Pool Account Structure Parsing (`pumpswap.ts`)

Added `parsePumpswapPoolAccounts()` function to extract addresses from pool account data:

```typescript
export function parsePumpswapPoolAccounts(data: Buffer | Uint8Array): { 
  coinCreatorVaultAta: string | null; 
  coinCreatorVaultAuthority: string | null;
}
```

**Pool Account Structure:**
```
Offset  | Size | Field
--------|------|----------------------------------
0       | 8    | discriminator
8       | 1    | bump
9       | 2    | index (u16)
11      | 32   | creator
43      | 32   | base_mint
75      | 32   | quote_mint
107     | 32   | lp_mint
139     | 32   | pool_base_token_account
171     | 32   | pool_quote_token_account
203     | ... (additional fields)
235     | 32   | coin_creator_vault_ata (extracted)
267     | 32   | coin_creator_vault_authority (extracted)
```

### 2. RPC Enrichment Enhancement (`pumpswap.ts`)

Modified `enrichPumpswapPoolsWithRpc()` to:
- Parse pool account data during the existing RPC batch fetch
- Extract `coinCreatorVaultAta` and `coinCreatorVaultAuthority` addresses
- Store these in the enriched pool data

**No additional RPC calls** - these addresses are extracted from the pool account data we're already fetching for reserves.

### 3. Pool Cache Enhancement (`pumpswap.ts`)

Updated `normalizePumpswapPools()` to store extracted accounts:

```typescript
{
  // ... existing pool fields ...
  coin_creator_vault_ata: pool.coin_creator_vault_ata,
  coin_creator_vault_authority: pool.coin_creator_vault_authority,
}
```

### 4. Instruction Builder Update (`ix.ts`)

Modified `buildPumpswapSwapIxReal()` to:
1. **Fetch addresses from cache:**
   ```typescript
   const coinCreatorVaultAta = String((poolData as any)?.coin_creator_vault_ata || '');
   const coinCreatorVaultAuthority = String((poolData as any)?.coin_creator_vault_authority || '');
   ```

2. **Validate cache data:**
   ```typescript
   if (!coinCreatorVaultAta || !coinCreatorVaultAuthority) {
     throw createBuilderError('PUMPSWAP', 'Pool missing coin creator vault addresses - pool may need re-enrichment', hop);
   }
   ```

3. **Use cached addresses directly:**
   ```typescript
   const creatorVaultAta = toPublicKey(coinCreatorVaultAta);
   const creatorVaultAuthority = toPublicKey(coinCreatorVaultAuthority);
   ```

4. **Derive only user-specific PDAs** (can't be cached):
   ```typescript
   const [userVolumeAccumulator] = PublicKey.findProgramAddressSync(
     [Buffer.from('user_volume_accumulator'), kp.publicKey.toBuffer()],
     programId
   );
   ```

### 5. Complete Account List (23 accounts)

```typescript
const keys = [
  { pubkey: poolId, isSigner: false, isWritable: true },                    // #0 Pool
  { pubkey: kp.publicKey, isSigner: true, isWritable: true },              // #1 User
  { pubkey: GLOBAL_CONFIG, isSigner: false, isWritable: false },           // #2 Global Config
  { pubkey: toPublicKey(poolBaseMint), isSigner: false, isWritable: false }, // #3 Base Mint
  { pubkey: toPublicKey(poolQuoteMint), isSigner: false, isWritable: false }, // #4 Quote Mint
  { pubkey: userBaseAta, isSigner: false, isWritable: true },              // #5 User Base Token Account
  { pubkey: userQuoteAta, isSigner: false, isWritable: true },             // #6 User Quote Token Account
  { pubkey: poolBaseVault, isSigner: false, isWritable: true },            // #7 Pool Base Token Account
  { pubkey: poolQuoteVault, isSigner: false, isWritable: true },           // #8 Pool Quote Token Account
  { pubkey: protocolFeeRecipient, isSigner: false, isWritable: false },    // #9 Protocol Fee Recipient
  { pubkey: protocolFeeRecipientTokenAccount, isSigner: false, isWritable: true }, // #10 Protocol Fee Token Account
  { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },        // #11 Base Token Program
  { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },        // #12 Quote Token Program
  { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // #13 System Program
  { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, // #14 Associated Token Program
  { pubkey: EVENT_AUTHORITY, isSigner: false, isWritable: false },         // #15 Event Authority
  { pubkey: programId, isSigner: false, isWritable: false },               // #16 Program
  { pubkey: creatorVaultAta, isSigner: false, isWritable: true },          // #17 Coin Creator Vault ATA (from cache)
  { pubkey: creatorVaultAuthority, isSigner: false, isWritable: false },   // #18 Coin Creator Vault Authority (from cache)
  { pubkey: GLOBAL_VOLUME_ACCUMULATOR, isSigner: false, isWritable: true }, // #19 Global Volume Accumulator
  { pubkey: userVolumeAccumulator, isSigner: false, isWritable: true },    // #20 User Volume Accumulator (derived)
  { pubkey: FEE_CONFIG, isSigner: false, isWritable: false },              // #21 Fee Config
  { pubkey: FEE_PROGRAM, isSigner: false, isWritable: false },             // #22 Fee Program
];
```

## Constant Addresses

| Account | Address | Purpose |
|---------|---------|---------|
| GLOBAL_CONFIG | `ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw` | Pumpswap global config |
| EVENT_AUTHORITY | `GS4CU59F31iL7aR2Q8zVS8DRrcRnXX1yjQ66TqNVQnaR` | Event authority for logs |
| GLOBAL_VOLUME_ACCUMULATOR | `C2aFPdENg4A2HQsmrd5rTw5TaYBX5Ku887cWjbFKtZpw` | Global volume tracking |
| FEE_CONFIG | `5PHirr8joyTMp9JMm6nW7hNDVyEYdkzDqazxPD7RaTjx` | Fee configuration |
| FEE_PROGRAM | `Pump9x3FRC86zy4T1N3V99RG9ejwokxgvXBfRRgxUoZ` | Pump fees program |

Protocol fee recipients (randomly selected):
- `62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV`
- `7VtfL8fvgNfhz17qKRMjzQEXgbdpnHHHQRh54R9jP2RJ`
- `7hTckgnGnLQR6sdH7YkqFTAA7VwTfYFaZ6EhEsU3saCX`
- `9rPYyANsfQZw3DnDmKE3YCQF5E8oD89UXoHn9JFEhJUz`
- `AVmoTthdrX6tKt4nDjco2D775W2YK3sDhxPcMmzUAmTY`
- `FWsW1xNtWscwNmKv6wVsU1iTzRN6wmmk3MjxRP5tT7hz`
- `G5UZAVbAf46s7cKWoyKu8kYTip9DGTpbLZ2qa9Aq69dP`
- `JCRGumoE9Qi5BBgULTgdgTLjSgkCMSbF62ZZfGs84JeU`

## Benefits

1. **Performance:** No RPC calls during transaction building
2. **Reliability:** Uses actual on-chain addresses instead of guessing PDA seeds
3. **Maintainability:** Centralized account extraction during pool normalization
4. **Scalability:** Works for all Pumpswap pools, not just specific pairs

## Testing

After backend restart:
1. Pool enrichment will extract and cache account addresses
2. Look for log: `pumpswap.pool.accounts.extracted.first` to verify extraction
3. Test transaction building with: `arb singlehop sim pumpswap`
4. Check that the logged addresses match expected values:
   - Expected `coinCreatorVaultAta`: `Ei6iux5MMYG8JxCTr58goADqFTtMroL9TXJityF3fAQc`
   - Expected `coinCreatorVaultAuthority`: `8N3GDaZ2iwN65oxVatKTLPNooAVUJTbfiVJ1ahyqwjSk`

## Potential Issues and Fixes

### Issue: Extracted addresses don't match expected values

**Cause:** Pool account structure offsets (235, 267) may be incorrect

**Fix:** 
1. Query the pool account directly using Solana CLI or explorer
2. Examine the binary data to find the correct offsets
3. Update `coinCreatorVaultAtaOffset` and `coinCreatorVaultAuthorityOffset` in `parsePumpswapPoolAccounts()`

**How to debug:**
```bash
# Query pool account
solana account Gf7sXMoP8iRw4iiXmJ1nq4vxcRycbGXy5RL8a8LnTd3v --output json

# Look for the addresses in the data field (base64 or hex)
# Count bytes to determine correct offsets
```

### Issue: Still getting `Custom:3007` error

**Causes:**
1. Account addresses not extracted (check logs for extraction success)
2. Account order is incorrect (compare with real transaction)
3. Accounts have wrong `isWritable` or `isSigner` flags

**Fix:**
1. Check backend logs for `pumpswap.pool.accounts.extracted.first`
2. Compare `fullAccountOrder` in logs with real transaction
3. Verify account flags match the Pumpswap program requirements

## Files Modified

- `backend/src/server/pools/pumpswap.ts` - Added parsing and enrichment logic
- `backend/src/execution/builder/ix.ts` - Updated instruction builder to use cached addresses

## References

- [Pumpswap Documentation](https://github.com/pump-fun/pump-public-docs/blob/main/docs/PUMP_SWAP_README.md)
- Example transaction: Solscan transaction analysis for USDC-WSOL swap
- Pumpswap Program ID: `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA`

