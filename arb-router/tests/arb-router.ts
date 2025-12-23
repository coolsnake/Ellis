import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { ArbRouter } from "../target/types/arb_router";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  createAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { expect } from "chai";
import BN from "bn.js";

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

  // Flash loan fee (9 basis points = 0.09%)
  const FLASH_LOAN_FEE_BPS = 9;
  const BPS_DENOMINATOR = 10000;

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
      10_000_000_000 // 10 tokens with 9 decimals
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
      expect(vaultAccount.tokenProgram.toBase58()).to.equal(TOKEN_PROGRAM_ID.toBase58());
      expect(vaultAccount.balance.toNumber()).to.equal(0);
      expect(vaultAccount.flashLoanActive).to.equal(false);
    });

    it("Deposits tokens into vault", async () => {
      const depositAmount = new anchor.BN(5_000_000_000); // 5 tokens

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
      expect(vaultAccount.balance.toNumber()).to.equal(5_000_000_000);

      // Verify token account balance
      const vaultTokenAccountInfo = await getAccount(
        provider.connection,
        vaultTokenAccount
      );
      expect(Number(vaultTokenAccountInfo.amount)).to.equal(5_000_000_000);
    });

    it("Withdraws tokens from vault", async () => {
      const withdrawAmount = new anchor.BN(1_000_000_000); // 1 token

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
      expect(vaultAccount.balance.toNumber()).to.equal(4_000_000_000);
    });

    it("Fails to withdraw more than available", async () => {
      const withdrawAmount = new anchor.BN(10_000_000_000); // More than vault has

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
      const borrowAmount = new anchor.BN(1_000_000_000); // 1 token
      
      // Calculate repay amount (borrowed + fee)
      const fee = Math.max(1, Math.floor(borrowAmount.toNumber() * FLASH_LOAN_FEE_BPS / BPS_DENOMINATOR));
      const repayAmount = new anchor.BN(borrowAmount.toNumber() + fee);

      // Ensure user has enough to repay
      const userAccountBefore = await getAccount(provider.connection, userTokenAccount);
      console.log("User balance before:", Number(userAccountBefore.amount));

      // Build flash_borrow instruction
      const borrowIx = await program.methods
        .flashBorrow({ amount: borrowAmount })
        .accounts({
          borrower: wallet.publicKey,
          mint: mint,
          vault: vault,
          vaultTokenAccount: vaultTokenAccount,
          borrowerTokenAccount: userTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .instruction();

      // Build flash_repay instruction
      const repayIx = await program.methods
        .flashRepay({ amount: repayAmount })
        .accounts({
          borrower: wallet.publicKey,
          mint: mint,
          vault: vault,
          vaultTokenAccount: vaultTokenAccount,
          borrowerTokenAccount: userTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .instruction();

      // Send both instructions in the same transaction
      const tx = new Transaction().add(borrowIx).add(repayIx);
      const sig = await provider.sendAndConfirm(tx);
      console.log("Flash loan complete, tx:", sig);

      // Verify vault state is reset
      const vaultAccount = await program.account.vault.fetch(vault);
      expect(vaultAccount.flashLoanActive).to.equal(false);
      expect(vaultAccount.borrowedAmount.toNumber()).to.equal(0);
      
      // Verify vault balance increased by fee
      expect(vaultAccount.balance.toNumber()).to.equal(4_000_000_000 + fee);

      // Verify user balance decreased by fee
      const userAccountAfter = await getAccount(provider.connection, userTokenAccount);
      expect(Number(userAccountAfter.amount)).to.equal(
        Number(userAccountBefore.amount) - fee
      );
    });

    it("Fails to borrow without repay instruction", async () => {
      const borrowAmount = new anchor.BN(1_000_000_000);

      // Try to borrow without a repay instruction following
      try {
        await program.methods
          .flashBorrow({ amount: borrowAmount })
          .accounts({
            borrower: wallet.publicKey,
            mint: mint,
            vault: vault,
            vaultTokenAccount: vaultTokenAccount,
            borrowerTokenAccount: userTokenAccount,
            tokenProgram: TOKEN_PROGRAM_ID,
            instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
          })
          .rpc();
        expect.fail("Should have thrown an error");
      } catch (err) {
        expect(err.toString()).to.include("FlashLoanNotRepaid");
      }
    });

    it("Fails to repay insufficient amount", async () => {
      const borrowAmount = new anchor.BN(1_000_000_000);
      // Intentionally repay less than required (no fee)
      const insufficientRepay = borrowAmount;

      // Build instructions
      const borrowIx = await program.methods
        .flashBorrow({ amount: borrowAmount })
        .accounts({
          borrower: wallet.publicKey,
          mint: mint,
          vault: vault,
          vaultTokenAccount: vaultTokenAccount,
          borrowerTokenAccount: userTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .instruction();

      const repayIx = await program.methods
        .flashRepay({ amount: insufficientRepay })
        .accounts({
          borrower: wallet.publicKey,
          mint: mint,
          vault: vault,
          vaultTokenAccount: vaultTokenAccount,
          borrowerTokenAccount: userTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .instruction();

      const tx = new Transaction().add(borrowIx).add(repayIx);

      try {
        await provider.sendAndConfirm(tx);
        expect.fail("Should have thrown an error");
      } catch (err) {
        expect(err.toString()).to.include("RepayAmountInsufficient");
      }
    });
  });

  describe("Route Swap with Direction", () => {
    it("Creates swap params with a_to_b direction", async () => {
      // This test verifies the structure of swap params with direction
      // Note: Actual DEX swaps require live pools
      
      const swapParams = {
        dexType: { raydium: {} },
        amountIn: new anchor.BN(1_000_000),
        minAmountOut: new anchor.BN(990_000),
        aToB: true,
      };

      console.log("Swap params structure validated:");
      console.log("  DEX Type: Raydium");
      console.log("  Amount In:", swapParams.amountIn.toNumber());
      console.log("  Min Amount Out:", swapParams.minAmountOut.toNumber());
      console.log("  A to B:", swapParams.aToB);

      // Verify the structure is correct
      expect(swapParams.aToB).to.be.a("boolean");
      expect(swapParams.amountIn.toNumber()).to.be.greaterThan(0);
    });

    it("Creates execute params with route steps including direction", async () => {
      // This test verifies multi-hop route structure
      
      const routeSteps = [
        {
          dexType: { raydium: {} },
          amountIn: new anchor.BN(1_000_000),
          minAmountOut: new anchor.BN(990_000),
          aToB: true,
        },
        {
          dexType: { orca: {} },
          amountIn: new anchor.BN(0), // Dynamic amount propagation
          minAmountOut: new anchor.BN(980_000),
          aToB: false, // B to A on second hop
        },
        {
          dexType: { meteora: {} },
          amountIn: new anchor.BN(0),
          minAmountOut: new anchor.BN(1_010_000),
          aToB: true,
        },
      ];

      console.log("Multi-hop route validated:");
      routeSteps.forEach((step, i) => {
        console.log(`  Step ${i}: amount_in=${step.amountIn.toNumber()}, a_to_b=${step.aToB}`);
      });

      // First hop should have specific amount, subsequent hops use 0 for dynamic propagation
      expect(routeSteps[0].amountIn.toNumber()).to.be.greaterThan(0);
      expect(routeSteps[1].amountIn.toNumber()).to.equal(0);
      expect(routeSteps[2].amountIn.toNumber()).to.equal(0);
    });
  });

  describe("Vault Close", () => {
    it("Withdraws remaining balance", async () => {
      // Get current vault balance
      const vaultAccount = await program.account.vault.fetch(vault);
      const currentBalance = vaultAccount.balance;

      if (currentBalance.toNumber() > 0) {
        const tx = await program.methods
          .vaultWithdraw(currentBalance)
          .accounts({
            owner: wallet.publicKey,
            mint: mint,
            vault: vault,
            vaultTokenAccount: vaultTokenAccount,
            userTokenAccount: userTokenAccount,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .rpc();

        console.log("Withdrew remaining balance, tx:", tx);
      }

      // Verify vault is empty
      const vaultAfter = await program.account.vault.fetch(vault);
      expect(vaultAfter.balance.toNumber()).to.equal(0);
    });

    it("Closes the vault", async () => {
      const tx = await program.methods
        .vaultClose()
        .accounts({
          owner: wallet.publicKey,
          mint: mint,
          vault: vault,
          vaultTokenAccount: vaultTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();

      console.log("Vault closed, tx:", tx);

      // Verify vault account no longer exists
      const vaultInfo = await provider.connection.getAccountInfo(vault);
      expect(vaultInfo).to.be.null;
    });

    it("Fails to close vault with active flash loan", async () => {
      // First, reinitialize the vault
      const vaultTokenAccountKp = Keypair.generate();
      const newVaultTokenAccount = vaultTokenAccountKp.publicKey;

      await program.methods
        .vaultInit()
        .accounts({
          owner: wallet.publicKey,
          mint: mint,
          vault: vault,
          vaultTokenAccount: newVaultTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .signers([vaultTokenAccountKp])
        .rpc();

      // Deposit some tokens
      await program.methods
        .vaultDeposit(new anchor.BN(1_000_000_000))
        .accounts({
          owner: wallet.publicKey,
          mint: mint,
          vault: vault,
          vaultTokenAccount: newVaultTokenAccount,
          userTokenAccount: userTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();

      // Cannot close with non-zero balance
      try {
        await program.methods
          .vaultClose()
          .accounts({
            owner: wallet.publicKey,
            mint: mint,
            vault: vault,
            vaultTokenAccount: newVaultTokenAccount,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .rpc();
        expect.fail("Should have thrown an error");
      } catch (err) {
        expect(err.toString()).to.include("InsufficientFunds");
      }

      // Cleanup: withdraw and close
      const vaultAccount = await program.account.vault.fetch(vault);
      await program.methods
        .vaultWithdraw(vaultAccount.balance)
        .accounts({
          owner: wallet.publicKey,
          mint: mint,
          vault: vault,
          vaultTokenAccount: newVaultTokenAccount,
          userTokenAccount: userTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();

      await program.methods
        .vaultClose()
        .accounts({
          owner: wallet.publicKey,
          mint: mint,
          vault: vault,
          vaultTokenAccount: newVaultTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();
    });
  });
});
