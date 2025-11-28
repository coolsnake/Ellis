# Arbitrage Router

A Solana program for routing arbitrage swaps through multiple DEXes with flash loan capability.

## Features

- **Multi-DEX Support**: Route swaps through Raydium CLMM, Meteora DLMM, Orca Whirlpool, and PumpSwap
- **Flash Loans**: Borrow from vaults and repay in the same transaction
- **Vault System**: Deposit and manage funds for flash loan liquidity
- **Multi-Hop Routing**: Execute complex arbitrage routes across multiple DEXes

## Architecture

### Instructions

| Discriminator | Instruction | Purpose |
|---------------|-------------|---------|
| vault_init | Initialize a new vault for a user/mint pair |
| vault_deposit | Deposit tokens into a vault |
| vault_withdraw | Withdraw tokens from a vault |
| vault_close | Close a vault and reclaim rent |
| flash_borrow | Borrow tokens (must repay in same tx) |
| flash_repay | Repay flash loan with fee |
| route_swap | Execute a single swap on a DEX |
| execute | Execute a multi-hop arbitrage route |

### Supported DEXes

| DEX | Program ID |
|-----|------------|
| Raydium CLMM | `CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK` |
| Meteora DLMM | `LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo` |
| Orca Whirlpool | `whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc` |
| PumpSwap | `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P` |

## Flash Loan Flow

```
1. flash_borrow(vault, amount)
   - Verify repay instruction exists in transaction
   - Transfer tokens to borrower
   - Mark vault as borrowed

2. [Execute arbitrage swaps]

3. flash_repay(vault, amount + fee)
   - Transfer tokens back to vault
   - Fee: 0.09% (9 basis points)
   - Clear borrowed state
```

## Building

```bash
# Build the program
anchor build

# Run tests
anchor test

# Deploy to devnet
anchor deploy --provider.cluster devnet
```

## Project Structure

```
arb-router/
├── Anchor.toml
├── Cargo.toml
├── programs/arb-router/
│   ├── Cargo.toml
│   └── src/
│       ├── lib.rs           # Program entrypoint & instructions
│       ├── state.rs         # Account structures
│       ├── error.rs         # Custom errors
│       ├── constants.rs     # Program IDs, seeds
│       └── dex/
│           ├── mod.rs       # DEX trait
│           ├── raydium.rs   # Raydium CLMM CPI
│           ├── meteora.rs   # Meteora DLMM CPI
│           ├── orca.rs      # Orca Whirlpool CPI
│           └── pumpswap.rs  # PumpSwap CPI
└── tests/
    └── arb-router.ts        # Integration tests
```

## Usage Example

### Initialize a Vault

```typescript
await program.methods
  .vaultInit()
  .accounts({
    owner: wallet.publicKey,
    mint: tokenMint,
    vault: vaultPda,
    vaultTokenAccount: vaultTokenAccount,
    tokenProgram: TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
    rent: SYSVAR_RENT_PUBKEY,
  })
  .rpc();
```

### Execute Flash Loan Arbitrage

```typescript
// Build transaction with borrow, swaps, and repay
const tx = new Transaction();

// 1. Borrow from vault
tx.add(
  await program.methods
    .flashBorrow({ amount: new BN(1000000) })
    .accounts({ /* ... */ })
    .instruction()
);

// 2. Execute swaps
tx.add(
  await program.methods
    .routeSwap({ dexType: { raydium: {} }, amountIn: new BN(1000000), minAmountOut: new BN(990000) })
    .accounts({ /* ... */ })
    .remainingAccounts(raydiumAccounts)
    .instruction()
);

// 3. Repay with fee
tx.add(
  await program.methods
    .flashRepay({ amount: new BN(1000900) }) // 0.09% fee
    .accounts({ /* ... */ })
    .instruction()
);

await sendAndConfirmTransaction(connection, tx, [wallet.payer]);
```

## Security Considerations

1. **Flash Loan Validation**: The program verifies a repay instruction exists before transferring borrowed funds
2. **Slippage Protection**: All swaps include minimum output amount checks
3. **Vault Ownership**: Only vault owners can withdraw funds
4. **PDA Security**: Vault accounts are PDAs derived from owner and mint

## License

MIT

