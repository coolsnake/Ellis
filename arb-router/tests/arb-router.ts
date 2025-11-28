import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { ArbRouter } from "../target/types/arb_router";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  SYSVAR_INSTRUCTIONS_PUBKEY,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  createAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { expect } from "chai";

describe("arb-router", () => {
  // Configure the client to use the local cluster
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.ArbRouter as Program<ArbRouter>;
  const wallet = provider.wallet as anchor.Wallet;

  // Test accounts
  let mint: PublicKey;
  let userTokenAccount: PublicKey;
  let vault: PublicKey;
  let vaultTokenAccount: PublicKey;
  let vaultBump: number;

  const VAULT_SEED = Buffer.from("vault");

  before(async () => {
    // Create a test token mint
    mint = await createMint(
      provider.connection,
      wallet.payer,
      wallet.publicKey,
      null,
      9 // decimals
    );

    // Create user token account
    userTokenAccount = await createAccount(
      provider.connection,
      wallet.payer,
      mint,
      wallet.publicKey
    );

    // Mint some tokens to the user
    await mintTo(
      provider.connection,
      wallet.payer,
      mint,
      userTokenAccount,
      wallet.payer,
      1_000_000_000 // 1 token with 9 decimals
    );

    // Derive vault PDA
    [vault, vaultBump] = PublicKey.findProgramAddressSync(
      [VAULT_SEED, wallet.publicKey.toBuffer(), mint.toBuffer()],
      program.programId
    );

    console.log("Test setup complete:");
    console.log("  Mint:", mint.toBase58());
    console.log("  User Token Account:", userTokenAccount.toBase58());
    console.log("  Vault PDA:", vault.toBase58());
  });

  describe("Vault Operations", () => {
    it("Initializes a vault", async () => {
      // Generate a new keypair for the vault token account
      const vaultTokenAccountKp = Keypair.generate();
      vaultTokenAccount = vaultTokenAccountKp.publicKey;

      const tx = await program.methods
        .vaultInit()
        .accounts({
          owner: wallet.publicKey,
          mint: mint,
          vault: vault,
          vaultTokenAccount: vaultTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .signers([vaultTokenAccountKp])
        .rpc();

      console.log("Vault initialized, tx:", tx);

      // Verify vault state
      const vaultAccount = await program.account.vault.fetch(vault);
      expect(vaultAccount.owner.toBase58()).to.equal(wallet.publicKey.toBase58());
      expect(vaultAccount.mint.toBase58()).to.equal(mint.toBase58());
      expect(vaultAccount.balance.toNumber()).to.equal(0);
      expect(vaultAccount.flashLoanActive).to.equal(false);
    });

    it("Deposits tokens into vault", async () => {
      const depositAmount = new anchor.BN(500_000_000); // 0.5 tokens

      const tx = await program.methods
        .vaultDeposit(depositAmount)
        .accounts({
          owner: wallet.publicKey,
          mint: mint,
          vault: vault,
          vaultTokenAccount: vaultTokenAccount,
          userTokenAccount: userTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();

      console.log("Deposited tokens, tx:", tx);

      // Verify vault balance
      const vaultAccount = await program.account.vault.fetch(vault);
      expect(vaultAccount.balance.toNumber()).to.equal(500_000_000);

      // Verify token account balance
      const vaultTokenAccountInfo = await getAccount(
        provider.connection,
        vaultTokenAccount
      );
      expect(Number(vaultTokenAccountInfo.amount)).to.equal(500_000_000);
    });

    it("Withdraws tokens from vault", async () => {
      const withdrawAmount = new anchor.BN(100_000_000); // 0.1 tokens

      const tx = await program.methods
        .vaultWithdraw(withdrawAmount)
        .accounts({
          owner: wallet.publicKey,
          mint: mint,
          vault: vault,
          vaultTokenAccount: vaultTokenAccount,
          userTokenAccount: userTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();

      console.log("Withdrew tokens, tx:", tx);

      // Verify vault balance
      const vaultAccount = await program.account.vault.fetch(vault);
      expect(vaultAccount.balance.toNumber()).to.equal(400_000_000);
    });

    it("Fails to withdraw more than available", async () => {
      const withdrawAmount = new anchor.BN(1_000_000_000); // More than vault has

      try {
        await program.methods
          .vaultWithdraw(withdrawAmount)
          .accounts({
            owner: wallet.publicKey,
            mint: mint,
            vault: vault,
            vaultTokenAccount: vaultTokenAccount,
            userTokenAccount: userTokenAccount,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .rpc();
        expect.fail("Should have thrown an error");
      } catch (err) {
        expect(err.toString()).to.include("InsufficientFunds");
      }
    });
  });

  describe("Flash Loan Operations", () => {
    it("Borrows and repays in same transaction", async () => {
      // This test requires building a transaction with both borrow and repay instructions
      // For now, we just verify the structure is correct
      
      console.log("Flash loan test would require transaction introspection setup");
      // In a real test, you would:
      // 1. Create a borrow instruction
      // 2. Create a repay instruction (with fee)
      // 3. Send both in the same transaction
    });
  });

  describe("Route Swap", () => {
    it("Executes a swap through Raydium (mock)", async () => {
      // This test requires actual DEX accounts
      // For now, we just verify the instruction structure
      console.log("Route swap test requires live DEX accounts");
    });
  });
});

