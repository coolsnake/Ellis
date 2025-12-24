/**
 * Test swap utilities for router integration testing
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  createSyncNativeInstruction,
  NATIVE_MINT,
} from '@solana/spl-token';
import BN from 'bn.js';
import { logger } from '../utils/logger.js';
import { getTickArrayStartIndexByTick, deriveTickArrayPda } from '../execution/raydiumTickArrays.js';

// ============================================================================
// Constants
// ============================================================================

const RAYDIUM_CLMM_PROGRAM = new PublicKey('CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK');
const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const RAYDIUM_SWAP_DISCRIMINATOR = Buffer.from([43, 4, 237, 11, 26, 201, 30, 98]);

// ============================================================================
// Types
// ============================================================================

export interface TestSwapParams {
  connection: Connection;
  wallet: Keypair;
  poolId: string;
  dex: string;
  variant?: string;
  inputMint?: string;
  outputMint?: string;
  amountIn: bigint;
  minAmountOut: bigint;
  simulateOnly: boolean;
}

export interface TestSwapResult {
  success: boolean;
  simulated: boolean;
  signature?: string;
  error?: string;
  logs?: string[];
  unitsConsumed?: number;
  poolAccounts?: Record<string, string>;
}

export interface RaydiumClmmPoolState {
  programId: string;
  ammConfig: string;
  vaultA: string;
  vaultB: string;
  mintA: string;
  mintB: string;
  observationId: string;
  tickCurrent: number;
  tickSpacing: number;
  tokenProgram: string; // Token program ID used by the vaults
  tickArrays: {
    lower: string;
    center: string;
    upper: string;
  };
}

// ============================================================================
// Pool Account Fetching
// ============================================================================

export async function fetchPoolAccounts(params: {
  connection: Connection;
  poolId: string;
  dex: string;
  variant?: string;
}): Promise<{ success: boolean; pool?: RaydiumClmmPoolState; error?: string }> {
  const { connection, poolId, dex, variant } = params;

  try {
    const poolPubkey = new PublicKey(poolId);
    
    if (dex === 'raydium' && variant === 'clmm') {
      return await fetchRaydiumClmmPool(connection, poolPubkey);
    }
    
    return { success: false, error: `Unsupported DEX: ${dex}/${variant}` };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

async function fetchRaydiumClmmPool(
  connection: Connection, 
  poolPubkey: PublicKey
): Promise<{ success: boolean; pool?: RaydiumClmmPoolState; error?: string }> {
  const accountInfo = await connection.getAccountInfo(poolPubkey);
  
  if (!accountInfo || !accountInfo.data) {
    return { success: false, error: 'Pool account not found' };
  }

  try {
    const sdk = await import('@raydium-io/raydium-sdk-v2');
    const layout = (sdk as any).PoolInfoLayout || 
                   (sdk as any).Clmm?.PoolInfoLayout ||
                   (sdk as any).CLMM?.POOL_STATE_LAYOUT;
    
    if (!layout?.decode) {
      return { success: false, error: 'Raydium SDK layout not found' };
    }

    const state = layout.decode(accountInfo.data);
    
    // Get the program ID from the account owner (works for both devnet and mainnet)
    const programId = accountInfo.owner;
    
    const tickCurrent = Number(state.tickCurrent ?? state.tick_current);
    const tickSpacing = Number(state.tickSpacing ?? state.tick_spacing);
    
    // Derive tick arrays using the pool's program ID
    const centerStart = getTickArrayStartIndexByTick(tickCurrent, tickSpacing);
    const delta = 60 * Math.max(1, tickSpacing);
    
    const [lower, center, upper] = await Promise.all([
      deriveTickArrayPda(programId, poolPubkey, centerStart - delta),
      deriveTickArrayPda(programId, poolPubkey, centerStart),
      deriveTickArrayPda(programId, poolPubkey, centerStart + delta),
    ]);

    // Determine token program by checking vault account owners
    const vaultA = new PublicKey(state.vaultA || state.tokenVault0 || state.tokenVaultA);
    const vaultB = new PublicKey(state.vaultB || state.tokenVault1 || state.tokenVaultB);
    
    const [vaultAInfo, vaultBInfo] = await Promise.all([
      connection.getAccountInfo(vaultA),
      connection.getAccountInfo(vaultB),
    ]);
    
    // Check which token program owns the vaults (use vaultA as primary, fallback to vaultB)
    let tokenProgramId = TOKEN_PROGRAM_ID;
    if (vaultAInfo) {
      const owner = vaultAInfo.owner.toBase58();
      if (owner === TOKEN_2022_PROGRAM_ID.toBase58()) {
        tokenProgramId = TOKEN_2022_PROGRAM_ID;
      }
    } else if (vaultBInfo) {
      const owner = vaultBInfo.owner.toBase58();
      if (owner === TOKEN_2022_PROGRAM_ID.toBase58()) {
        tokenProgramId = TOKEN_2022_PROGRAM_ID;
      }
    }

    const pool: RaydiumClmmPoolState = {
      programId: accountInfo.owner.toBase58(),
      ammConfig: new PublicKey(state.ammConfig || state.amm_config).toBase58(),
      vaultA: vaultA.toBase58(),
      vaultB: vaultB.toBase58(),
      mintA: new PublicKey(state.mintA || state.tokenMint0 || state.mint0).toBase58(),
      mintB: new PublicKey(state.mintB || state.tokenMint1 || state.mint1).toBase58(),
      observationId: new PublicKey(state.observationId || state.observation_id || state.observationAccount).toBase58(),
      tickCurrent,
      tickSpacing,
      tokenProgram: tokenProgramId.toBase58(),
      tickArrays: {
        lower: lower.toBase58(),
        center: center.toBase58(),
        upper: upper.toBase58(),
      },
    };

    logger.info('router.test.pool.decoded', { cat: 'router', poolId: poolPubkey.toBase58(), pool });

    return { success: true, pool };
  } catch (err: any) {
    logger.error('router.test.pool.decode.error', { cat: 'router', error: err.message });
    return { success: false, error: `Failed to decode pool: ${err.message}` };
  }
}

// ============================================================================
// Swap Testing
// ============================================================================

export async function runSwapTest(params: TestSwapParams): Promise<TestSwapResult> {
  const { 
    connection, 
    wallet, 
    poolId, 
    dex, 
    variant, 
    inputMint, 
    outputMint, 
    amountIn, 
    minAmountOut,
    simulateOnly,
  } = params;

  try {
    // Fetch pool accounts
    const poolResult = await fetchPoolAccounts({ connection, poolId, dex, variant });
    
    if (!poolResult.success || !poolResult.pool) {
      return { success: false, simulated: false, error: poolResult.error || 'Failed to fetch pool' };
    }

    const pool = poolResult.pool;
    
    // Determine mints
    const inMint = inputMint ? new PublicKey(inputMint) : new PublicKey(pool.mintA);
    const outMint = outputMint ? new PublicKey(outputMint) : new PublicKey(pool.mintB);
    
    // Build swap transaction based on DEX
    let swapIx: TransactionInstruction;
    
    if (dex === 'raydium' && variant === 'clmm') {
      swapIx = buildRaydiumClmmSwapIx(
        wallet.publicKey,
        pool,
        new PublicKey(poolId),
        inMint,
        outMint,
        amountIn,
        minAmountOut
      );
    } else {
      return { success: false, simulated: false, error: `Unsupported DEX: ${dex}/${variant}` };
    }

    // Build transaction with setup instructions
    const tx = new Transaction();
    
    // Detect token programs for mints (needed for ATA creation)
    const [inMintInfo, outMintInfo] = await Promise.all([
      connection.getAccountInfo(inMint),
      connection.getAccountInfo(outMint),
    ]);
    
    const inMintTokenProgram = inMintInfo?.owner.equals(TOKEN_2022_PROGRAM_ID) 
      ? TOKEN_2022_PROGRAM_ID 
      : TOKEN_PROGRAM_ID;
    const outMintTokenProgram = outMintInfo?.owner.equals(TOKEN_2022_PROGRAM_ID)
      ? TOKEN_2022_PROGRAM_ID
      : TOKEN_PROGRAM_ID;
    
    // Ensure user has ATAs (use correct token program for each mint)
    const userInAta = getAssociatedTokenAddressSync(inMint, wallet.publicKey, false, inMintTokenProgram);
    const userOutAta = getAssociatedTokenAddressSync(outMint, wallet.publicKey, false, outMintTokenProgram);
    
    const [inAtaInfo, outAtaInfo] = await Promise.all([
      connection.getAccountInfo(userInAta),
      connection.getAccountInfo(userOutAta),
    ]);
    
    if (!inAtaInfo) {
      tx.add(createAssociatedTokenAccountInstruction(
        wallet.publicKey, userInAta, wallet.publicKey, inMint, inMintTokenProgram
      ));
      // If input is SOL, wrap some
      if (inMint.equals(NATIVE_MINT)) {
        tx.add(
          SystemProgram.transfer({
            fromPubkey: wallet.publicKey,
            toPubkey: userInAta,
            lamports: Number(amountIn) + 10000, // Add extra for rent
          }),
          createSyncNativeInstruction(userInAta, inMintTokenProgram)
        );
      }
    }
    
    if (!outAtaInfo) {
      tx.add(createAssociatedTokenAccountInstruction(
        wallet.publicKey, userOutAta, wallet.publicKey, outMint, outMintTokenProgram
      ));
    }
    
    // Add swap instruction
    tx.add(swapIx);
    
    // Set recent blockhash and fee payer
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    tx.feePayer = wallet.publicKey;

    if (simulateOnly) {
      // Simulate transaction
      const simulation = await connection.simulateTransaction(tx, [wallet]);
      
      return {
        success: !simulation.value.err,
        simulated: true,
        error: simulation.value.err ? JSON.stringify(simulation.value.err) : undefined,
        logs: simulation.value.logs || [],
        unitsConsumed: simulation.value.unitsConsumed,
        poolAccounts: {
          pool: poolId,
          ammConfig: pool.ammConfig,
          vaultA: pool.vaultA,
          vaultB: pool.vaultB,
          mintA: pool.mintA,
          mintB: pool.mintB,
          observation: pool.observationId,
          tickArrayLower: pool.tickArrays.lower,
          tickArrayCenter: pool.tickArrays.center,
          tickArrayUpper: pool.tickArrays.upper,
        },
      };
    } else {
      // Execute transaction
      const signature = await sendAndConfirmTransaction(
        connection,
        tx,
        [wallet],
        { commitment: 'confirmed' }
      );
      
      return {
        success: true,
        simulated: false,
        signature,
        poolAccounts: {
          pool: poolId,
          ammConfig: pool.ammConfig,
          vaultA: pool.vaultA,
          vaultB: pool.vaultB,
        },
      };
    }
  } catch (err: any) {
    logger.error('router.test.swap.error', { cat: 'router', error: err.message, stack: err.stack });
    return { 
      success: false, 
      simulated: params.simulateOnly, 
      error: err.message,
      logs: err.logs || [],
    };
  }
}

function buildRaydiumClmmSwapIx(
  payer: PublicKey,
  pool: RaydiumClmmPoolState,
  poolPubkey: PublicKey,
  inputMint: PublicKey,
  outputMint: PublicKey,
  amountIn: bigint,
  minAmountOut: bigint
): TransactionInstruction {
  const isAtoB = inputMint.toBase58() === pool.mintA;
  
  const userInAta = getAssociatedTokenAddressSync(inputMint, payer);
  const userOutAta = getAssociatedTokenAddressSync(outputMint, payer);
  
  const inputVault = isAtoB ? pool.vaultA : pool.vaultB;
  const outputVault = isAtoB ? pool.vaultB : pool.vaultA;
  
  // Build swap data
  const data = Buffer.concat([
    RAYDIUM_SWAP_DISCRIMINATOR,
    new BN(amountIn.toString()).toArrayLike(Buffer, 'le', 8),
    new BN(minAmountOut.toString()).toArrayLike(Buffer, 'le', 8),
    Buffer.alloc(16), // sqrt_price_limit = 0
    Buffer.from([1]), // is_base_input = true
  ]);
  
  // Use the token program from pool state (detected from vault accounts)
  const tokenProgram = new PublicKey(pool.tokenProgram);
  
  // token_program_2022 must be included even when using standard token program
  // When using standard token program, set it to TOKEN_2022_PROGRAM_ID (the program will check but allow it)
  // When using Token 2022, set it to TOKEN_2022_PROGRAM_ID
  // The program validates this account exists, so we always include it
  const tokenProgram2022 = TOKEN_2022_PROGRAM_ID;
  
  const accounts = [
    { pubkey: payer, isSigner: true, isWritable: true },                    // 0: Payer
    { pubkey: new PublicKey(pool.ammConfig), isSigner: false, isWritable: false }, // 1: AMM Config
    { pubkey: poolPubkey, isSigner: false, isWritable: true },             // 2: Pool State
    { pubkey: userInAta, isSigner: false, isWritable: true },              // 3: Input Token Account (user)
    { pubkey: userOutAta, isSigner: false, isWritable: true },             // 4: Output Token Account (user)
    { pubkey: new PublicKey(inputVault), isSigner: false, isWritable: true }, // 5: Input Vault
    { pubkey: new PublicKey(outputVault), isSigner: false, isWritable: true }, // 6: Output Vault
    { pubkey: new PublicKey(pool.observationId), isSigner: false, isWritable: true }, // 7: Observation State
    { pubkey: tokenProgram, isSigner: false, isWritable: false },           // 8: Token Program
    { pubkey: tokenProgram2022, isSigner: false, isWritable: false },     // 9: Token Program 2022 (required even if not using Token 2022)
    { pubkey: new PublicKey(pool.tickArrays.lower), isSigner: false, isWritable: true }, // 10: Tick Array Lower
    { pubkey: new PublicKey(pool.tickArrays.center), isSigner: false, isWritable: true }, // 11: Tick Array Center
    { pubkey: new PublicKey(pool.tickArrays.upper), isSigner: false, isWritable: true }, // 12: Tick Array Upper
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // 13: Oracle (use System Program as placeholder)
    { pubkey: inputMint, isSigner: false, isWritable: false },             // 14: Input Token Mint
    { pubkey: outputMint, isSigner: false, isWritable: false },           // 15: Output Token Mint
    { pubkey: MEMO_PROGRAM_ID, isSigner: false, isWritable: false },       // 16: Memo Program
  ];
  
  return new TransactionInstruction({
    programId: new PublicKey(pool.programId),
    keys: accounts,
    data,
  });
}

