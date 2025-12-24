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
import { buildRouteSwapIx, dexNameToType, buildExecuteIx } from './sdk.js';
import { DexType, RouteStep } from './types.js';

// ============================================================================
// Constants
// ============================================================================

const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');

// Note: When using the on-chain router, we build DEX accounts manually.
// When calling DEX directly, we use the Raydium SDK for correct account ordering.

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
  /** Router program ID - if provided, swap goes through the on-chain router */
  routerProgramId?: string;
  // Multi-hop parameters
  hops?: number; // 1 or 2
  secondPoolId?: string;
  secondDex?: string;
  secondVariant?: string;
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
    routerProgramId,
    hops = 1,
    secondPoolId,
    secondDex,
    secondVariant,
  } = params;

  try {
    // Fetch first pool
    const poolResult = await fetchPoolAccounts({ connection, poolId, dex, variant });
    if (!poolResult.success || !poolResult.pool) {
      return { success: false, simulated: false, error: poolResult.error || 'Failed to fetch pool' };
    }
    const pool = poolResult.pool;

    // Determine mints for first hop
    const inMint = inputMint ? new PublicKey(inputMint) : new PublicKey(pool.mintA);
    const outMint = outputMint ? new PublicKey(outputMint) : new PublicKey(pool.mintB);
    const isAtoB = inMint.toBase58() === pool.mintA;

    let swapIxs: TransactionInstruction[] = [];

    if (routerProgramId) {
      const routerProgram = new PublicKey(routerProgramId);
      const dexType = dexNameToType(dex, variant);

      if (hops === 1) {
        // Single hop: use route_swap
        const dexAccounts = await buildDexAccountsForRouter(
          wallet.publicKey,
          pool,
          new PublicKey(poolId),
          inMint,
          outMint,
          dexType
        );

        const userInAta = getAssociatedTokenAddressSync(inMint, wallet.publicKey);
        const routerSwapIx = buildRouteSwapIx(
          wallet.publicKey,
          userInAta,
          {
            dexType,
            amountIn,
            minAmountOut,
            aToB: isAtoB,
          },
          dexAccounts,
          routerProgram
        );
        swapIxs = [routerSwapIx];
      } else if (hops === 2 && secondPoolId) {
        // Two hops: use execute instruction
        const secondPoolResult = await fetchPoolAccounts({ 
          connection, 
          poolId: secondPoolId, 
          dex: secondDex || dex, 
          variant: secondVariant || variant 
        });
        
        if (!secondPoolResult.success || !secondPoolResult.pool) {
          return { success: false, simulated: false, error: 'Failed to fetch second pool' };
        }
        const secondPool = secondPoolResult.pool;

        // Determine intermediate mint (output of first hop = input of second hop)
        const intermediateMint = outMint;
        const finalMint = inMint; // For round trip: SOL -> USDC -> SOL
        
        // Build steps for execute instruction
        
        const firstStep: RouteStep = {
          dexType: dexType,
          amountIn: amountIn, // Use specified amount for first hop
          minAmountOut: minAmountOut,
          aToB: isAtoB,
        };

        const secondIsAtoB = intermediateMint.toBase58() === secondPool.mintA;
        const secondDexType = dexNameToType(secondDex || dex, secondVariant || variant);
        
        const secondStep: RouteStep = {
          dexType: secondDexType,
          amountIn: 0n, // 0 = use all from previous step (amount propagation)
          minAmountOut: 1n, // Minimum output for second hop
          aToB: secondIsAtoB,
        };

        // Build DEX accounts for both hops
        const firstDexAccounts = await buildDexAccountsForRouter(
          wallet.publicKey,
          pool,
          new PublicKey(poolId),
          inMint,
          intermediateMint,
          dexType
        );

        const secondDexAccounts = await buildDexAccountsForRouter(
          wallet.publicKey,
          secondPool,
          new PublicKey(secondPoolId),
          intermediateMint,
          finalMint,
          secondDexType
        );

        // Combine all DEX accounts - each step needs its own complete set including program ID
        // The execute function expects: [step1_accounts (18), step2_accounts (18), ...]
        const allDexAccounts = [
          ...firstDexAccounts,  // All 18 accounts for first hop (including program ID)
          ...secondDexAccounts, // All 18 accounts for second hop (including program ID)
        ];

        const userInAta = getAssociatedTokenAddressSync(inMint, wallet.publicKey);
        const executeIx = buildExecuteIx(
          wallet.publicKey,
          userInAta,
          {
            steps: [firstStep, secondStep],
            minProfit: 0n, // No minimum profit requirement for testing
          },
          allDexAccounts,
          routerProgram
        );
        swapIxs = [executeIx];
      } else {
        return { success: false, simulated: false, error: 'Invalid hops configuration' };
      }
    } else {
      // Direct mode (not using router) - single hop only for now
      if (hops !== 1) {
        return { success: false, simulated: false, error: 'Multi-hop only supported with router' };
      }
      
      if (dex === 'raydium' && variant === 'clmm') {
        swapIxs = await buildRaydiumClmmSwapIxWithSdk(
          wallet.publicKey,
          pool,
          new PublicKey(poolId),
          inMint,
          outMint,
          amountIn,
          minAmountOut
        );
        
        if (!swapIxs.length) {
          return { success: false, simulated: false, error: 'SDK failed to generate swap instructions' };
        }
      } else {
        return { success: false, simulated: false, error: `Unsupported DEX: ${dex}/${variant}` };
      }
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
    }
    
    // If input is SOL, always wrap the required amount (even if account exists)
    if (inMint.equals(NATIVE_MINT)) {
      tx.add(
        SystemProgram.transfer({
          fromPubkey: wallet.publicKey,
          toPubkey: userInAta,
          lamports: Number(amountIn) + 10000, // Add extra for fees
        }),
        createSyncNativeInstruction(userInAta, inMintTokenProgram)
      );
    }
    
    if (!outAtaInfo) {
      tx.add(createAssociatedTokenAccountInstruction(
        wallet.publicKey, userOutAta, wallet.publicKey, outMint, outMintTokenProgram
      ));
    }
    
    // Add swap instructions from SDK
    for (const ix of swapIxs) {
      tx.add(ix);
    }
    
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

async function buildRaydiumClmmSwapIxWithSdk(
  payer: PublicKey,
  pool: RaydiumClmmPoolState,
  poolPubkey: PublicKey,
  inputMint: PublicKey,
  outputMint: PublicKey,
  amountIn: bigint,
  minAmountOut: bigint
): Promise<TransactionInstruction[]> {
  const isAtoB = inputMint.toBase58() === pool.mintA;
  
  const userInAta = getAssociatedTokenAddressSync(inputMint, payer);
  const userOutAta = getAssociatedTokenAddressSync(outputMint, payer);
  
  // Use Raydium SDK to build swap instruction with correct account order
  // The SDK handles different program versions (devnet vs mainnet) automatically
  const sdk = await import('@raydium-io/raydium-sdk-v2');
  const { ClmmInstrument } = sdk;
  
  const amountInBn = new BN(amountIn.toString());
  const minOutBn = new BN(minAmountOut.toString());
  
  // Construct pool info for SDK
  const mintAInfo = {
    address: pool.mintA,
    decimals: 9, // SOL decimals (will be ignored for swap calculation)
    programId: pool.tokenProgram,
  };
  const mintBInfo = {
    address: pool.mintB,
    decimals: 6, // USDC decimals (will be ignored for swap calculation)
    programId: pool.tokenProgram,
  };
  
  const poolInfo = {
    id: poolPubkey.toBase58(),
    programId: pool.programId,
    mintA: mintAInfo,
    mintB: mintBInfo,
    config: {
      id: pool.ammConfig,
      index: 0,
      protocolFeeRate: 0,
      tradeFeeRate: 0,
      tickSpacing: pool.tickSpacing,
      fundFeeRate: 0,
      defaultRange: 0,
      defaultRangePoint: [],
    },
  };
  
  const poolKeys = {
    id: poolPubkey.toBase58(),
    programId: pool.programId,
    mintA: mintAInfo,
    mintB: mintBInfo,
    vault: {
      A: pool.vaultA,
      B: pool.vaultB,
    },
    observationId: pool.observationId,
    config: poolInfo.config,
    rewardInfos: [],
  };
  
  const ownerInfo = {
    wallet: payer,
    tokenAccountA: isAtoB ? userInAta : userOutAta,
    tokenAccountB: isAtoB ? userOutAta : userInAta,
  };
  
  // Get tick array PDAs - center first (most likely needed)
  const tickArrayKeys = [
    new PublicKey(pool.tickArrays.center),
    new PublicKey(pool.tickArrays.lower),
    new PublicKey(pool.tickArrays.upper),
  ];
  
  const observationId = new PublicKey(pool.observationId);
  
  // Use SDK to generate instructions with correct account order
  // The SDK knows the correct structure for each program version
  const res = (ClmmInstrument as any).makeSwapBaseInInstructions({
    poolInfo,
    poolKeys,
    observationId,
    ownerInfo,
    inputMint,
    amountIn: amountInBn,
    amountOutMin: minOutBn,
    sqrtPriceLimitX64: new BN(0),
    remainingAccounts: tickArrayKeys,
  });
  
  const ixs = Array.isArray(res?.instructions) 
    ? res.instructions 
    : (res?.innerTransaction?.instructions || []);
  
  logger.info('router.test.sdk.instructions', { 
    cat: 'router', 
    poolId: poolPubkey.toBase58(),
    instructionCount: ixs.length,
    programId: pool.programId,
  });
  
  return ixs;
}

async function getRaydiumSdkAccountOrder(
  payer: PublicKey,
  pool: RaydiumClmmPoolState,
  poolPubkey: PublicKey,
  inputMint: PublicKey,
  outputMint: PublicKey,
  amountIn: bigint,
  minAmountOut: bigint
): Promise<PublicKey[]> {
  // Generate instruction using SDK to see the correct order
  const sdkIxs = await buildRaydiumClmmSwapIxWithSdk(
    payer,
    pool,
    poolPubkey,
    inputMint,
    outputMint,
    amountIn,
    minAmountOut
  );
  
  if (!sdkIxs || sdkIxs.length === 0) {
    throw new Error('Failed to generate SDK instruction');
  }
  
  // Get the swap instruction (usually the first one)
  const swapIx = sdkIxs.find(ix => 
    ix.programId.toBase58() === pool.programId
  ) || sdkIxs[0];
  
  // Extract account order (excluding the program ID)
  const accountOrder = swapIx.keys.map(key => key.pubkey);
  
  logger.info('router.test.sdk.account_order', {
    cat: 'router',
    accountCount: accountOrder.length,
    accounts: accountOrder.map((acc, idx) => ({
      index: idx,
      address: acc.toBase58(),
      isSigner: swapIx.keys[idx].isSigner,
      isWritable: swapIx.keys[idx].isWritable,
    })),
  });
  
  return accountOrder;
}

/**
 * Build DEX accounts in the order expected by the on-chain arb-router
 * 
 * For Raydium CLMM, the router expects 17 accounts:
 * 0. Payer (signer)
 * 1. AMM Config
 * 2. Pool State
 * 3. Input Token Account (user)
 * 4. Output Token Account (user)
 * 5. Input Vault
 * 6. Output Vault
 * 7. Observation State
 * 8. Token Program
 * 9. Tick Array Lower
 * 10. Tick Array Center
 * 11. Tick Array Upper
 * 12. Oracle (System Program if not used)
 * 13. Input Token Mint
 * 14. Output Token Mint
 * 15. Memo Program
 * 16. Raydium CLMM Program
 */
async function buildDexAccountsForRouter(
  payer: PublicKey,
  pool: RaydiumClmmPoolState,
  poolPubkey: PublicKey,
  inputMint: PublicKey,
  outputMint: PublicKey,
  dexType: DexType
): Promise<PublicKey[]> {
  if (dexType !== DexType.Raydium) {
    throw new Error(`DEX type ${dexType} not yet supported for router test`);
  }
  
  // Use SDK to get the correct account order
  const sdkAccountOrder = await getRaydiumSdkAccountOrder(
    payer,
    pool,
    poolPubkey,
    inputMint,
    outputMint,
    BigInt(1000000),
    BigInt(900000)
  );
  
  // Add the Raydium program ID as the last account (needed for CPI)
  const dexProgramId = new PublicKey(pool.programId);
  const accounts = [...sdkAccountOrder, dexProgramId];
  
  logger.info('router.test.dex_accounts', { 
    cat: 'router', 
    accountCount: accounts.length,
    dexType: 'raydium_clmm',
    isAtoB: inputMint.toBase58() === pool.mintA,
  });
  
  return accounts;
}

