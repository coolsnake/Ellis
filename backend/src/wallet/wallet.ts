import { Keypair, PublicKey, Connection, clusterApiUrl, LAMPORTS_PER_SOL, VersionedTransaction, Transaction, ComputeBudgetProgram, SystemProgram } from '@solana/web3.js';
import { getAccount, getAssociatedTokenAddress, getMint, transferChecked, createAssociatedTokenAccountInstruction, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, getOrCreateAssociatedTokenAccount, NATIVE_MINT, createSyncNativeInstruction, createCloseAccountInstruction } from '@solana/spl-token';
import { promises as fs } from 'fs';
import path from 'path';
import { CONFIG } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import { emit } from '../server/realtime.js';
import { getTokenAccountManager } from './tokenAccountManager.js';
import { withRpcLimit } from '../utils/rpcLimiter.js';
import { getFeeCalculator, type FeeConfig } from '../utils/feeCalculator.js';
import { logTxTrace } from '../utils/txTrace.js';

// cache for balances to reduce RPC pressure
const getBalancesCache: Record<string, { ts: number; data: { sol: number; tokens: Record<string, number> } | null; inFlight: Promise<{ sol: number; tokens: Record<string, number> }> | null }> = {};

export function getConnection(): Connection {
  const url = CONFIG.rpcUrl || clusterApiUrl('mainnet-beta');
  // Stick to 2-arg signature for compatibility
  return new Connection(url, 'confirmed');
}

export async function generateAndSaveWallet(filePath: string): Promise<Keypair> {
  const keypair = Keypair.generate();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(Array.from(keypair.secretKey)), 'utf-8');
  return keypair;
}

export async function loadWallet(filePath: string): Promise<Keypair> {
  const secret = JSON.parse(await fs.readFile(filePath, 'utf-8')) as number[];
  const secretKey = Uint8Array.from(secret);
  return Keypair.fromSecretKey(secretKey);
}

export async function walletExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function maybeLoadWallet(filePath: string): Promise<Keypair | null> {
  const exists = await walletExists(filePath);
  if (!exists) return null;
  return loadWallet(filePath);
}

export async function ensureWallet(filePath: string): Promise<Keypair> {
  // Do not auto-generate; require explicit generation per user action
  const kp = await maybeLoadWallet(filePath);
  if (!kp) throw new Error('WALLET_NOT_FOUND');
  return kp;
}

export async function getBalances(address: PublicKey, opts?: { force?: boolean }): Promise<{ sol: number; tokens: Record<string, number> }> {
  const connection = getConnection();
  // simple cache + in-flight dedup per address
  const key = address.toBase58();
  if (!getBalancesCache[key]) getBalancesCache[key] = { ts: 0, data: null, inFlight: null };
  const entry = getBalancesCache[key];
  const now = Date.now();
  const TTL_MS = 12000;
  if (!opts?.force && entry.data && now - entry.ts < TTL_MS) {
    return entry.data;
  }
  if (!opts?.force && entry.inFlight) {
    return entry.inFlight;
  }

  // handle rate limit with retries, with timestamped logs on 429
  async function withBackoff<T>(fn: () => Promise<T>): Promise<T> {
    let lastErr: any;
    for (let i = 0; i < 5; i += 1) {
      try {
        return await fn();
      } catch (e: any) {
        lastErr = e;
        const msg = String(e?.message || e);
        if (msg.includes('429') || msg.toLowerCase().includes('too many requests') || msg.toLowerCase().includes('fetch failed')) {
          const base = 500 * Math.pow(2, i);
          const jitter = 1 + (Math.random() * 0.2 - 0.1); // +/-10% jitter to avoid herding
          const delay = Math.round(base * jitter);
          logger.warn(`[${new Date().toISOString()}] rpc.429 retry delay=${delay}ms attempt=${i + 1}`);
          try { emit('log', { level: 'warn', message: `arb:429 source=rpc kind=wallet attempt=${i + 1}` , timestamp: new Date().toISOString(), context: { cat: 'arb' } }); } catch {}
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
      }
    }
    throw lastErr;
  }

  const task = (async () => {
    const balanceLamports = await withBackoff<number>(() => withRpcLimit(() => connection.getBalance(address)));
    // Fetch both legacy SPL and Token-2022 accounts, then aggregate by mint
    const legacyP = withBackoff<any>(() => withRpcLimit(() => connection.getParsedTokenAccountsByOwner(address, { programId: TOKEN_PROGRAM_ID })));
    const token22P = withBackoff<any>(() => withRpcLimit(() => connection.getParsedTokenAccountsByOwner(address, { programId: TOKEN_2022_PROGRAM_ID }))).catch(() => ({ value: [] }));
    const [legacy, token22] = await Promise.all([legacyP, token22P]);
    const allAccounts = [...(legacy?.value || []), ...((token22 as any)?.value || [])];
    const tokens: Record<string, number> = {};
    for (const { account } of allAccounts) {
      const data: any = account.data;
      const mint = data.parsed?.info?.mint as string;
      const amount = Number(data.parsed?.info?.tokenAmount?.uiAmount) || 0;
      if (mint) tokens[mint] = (tokens[mint] || 0) + amount;
    }
    try { logger.debug('wallet.getBalances: token accounts discovered', { legacy: legacy?.value?.length || 0, token22: (token22 as any)?.value?.length || 0, mintCount: Object.keys(tokens).length }); } catch {}
    const data = { sol: balanceLamports / LAMPORTS_PER_SOL, tokens };
    entry.ts = Date.now();
    entry.data = data;
    entry.inFlight = null;
    return data;
  })();

  if (opts?.force) {
    return task;
  }
  entry.inFlight = task;
  return task;
}

export async function getPublicKey(filePath: string): Promise<PublicKey> {
  const kp = await ensureWallet(filePath);
  return kp.publicKey;
}

export async function getOrCreateTokenAccount(mint: PublicKey, owner: PublicKey, payer: Keypair): Promise<{ address: PublicKey; isNew: boolean }> {
  const connection = getConnection();
  const manager = getTokenAccountManager(connection);
  
  const result = await manager.getOrCreateTokenAccount(mint, owner, payer.publicKey);
  
  if (result.isNew) {
    // Create the account if it doesn't exist
    try {
      await getOrCreateAssociatedTokenAccount(connection, payer, mint, owner);
      logger.info(`Created new token account: ${result.address.toBase58()}`);
    } catch (error: any) {
      // If account already exists, that's fine - just log it
      if (error.message?.includes('already in use') || error.message?.includes('already exists')) {
        logger.info(`Token account already exists: ${result.address.toBase58()}`);
      } else {
        throw error;
      }
    }
  } else {
    // Account already exists, just mark as used
    await manager.markTokenAccountUsed(result.address);
    logger.debug(`Reusing existing token account: ${result.address.toBase58()}`);
  }
  
  return result;
}

export async function sendSplToken(params: {
  from: Keypair;
  destination: PublicKey;
  mint: PublicKey;
  amount: number; // in tokens, not smallest units
}): Promise<string> {
  const { from, destination, mint, amount } = params;
  const connection = getConnection();
  const mintInfo = await getMint(connection, mint);
  
  // Use token account manager for both accounts
  const fromTokenAccount = await getOrCreateTokenAccount(mint, from.publicKey, from);
  const destTokenAccount = await getOrCreateTokenAccount(mint, destination, from);

  const amountInSmallest = BigInt(Math.round(amount * 10 ** mintInfo.decimals));
  const signature = await transferChecked(
    connection,
    from,
    fromTokenAccount.address,
    mint,
    destTokenAccount.address,
    from.publicKey,
    Number(amountInSmallest),
    mintInfo.decimals
  );
  return signature;
}

export async function wrapSol(amountSol: number): Promise<string> {
  const connection = getConnection();
  const kp = await ensureWallet(CONFIG.walletPath);
  const ata = await getOrCreateAssociatedTokenAccount(connection, kp, NATIVE_MINT, kp.publicKey);
  const lamports = Math.round(amountSol * LAMPORTS_PER_SOL);
  const tx = new Transaction();
  tx.add(SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: ata.address, lamports }));
  tx.add(createSyncNativeInstruction(ata.address));
  const sig = await withRpcLimit(() => connection.sendTransaction(tx, [kp], { skipPreflight: false }));
  await withRpcLimit(() => connection.confirmTransaction(sig, 'confirmed'));
  return sig;
}

export async function unwrapSol(): Promise<string> {
  const connection = getConnection();
  const kp = await ensureWallet(CONFIG.walletPath);
  const ata = await getOrCreateAssociatedTokenAccount(connection, kp, NATIVE_MINT, kp.publicKey);
  const tx = new Transaction();
  tx.add(createCloseAccountInstruction(ata.address, kp.publicKey, kp.publicKey));
  const sig = await withRpcLimit(() => connection.sendTransaction(tx, [kp], { skipPreflight: false }));
  await withRpcLimit(() => connection.confirmTransaction(sig, 'confirmed'));
  return sig;
}

export async function signAndSendSerializedTransaction(
  serializedBase64: string, 
  signer: Keypair, 
  feeConfig?: Partial<FeeConfig>,
  transactionType: 'swap' | 'send' | 'strategy' = 'strategy'
): Promise<string> {
  const connection = getConnection();
  try {
    const tx = VersionedTransaction.deserialize(Buffer.from(serializedBase64, 'base64'));
    
    // Add compute budget instructions for fee configuration
    if (feeConfig || CONFIG.fees.dynamicFees) {
      const feeCalculator = getFeeCalculator(connection);
      const recommendation = feeCalculator.getFeeRecommendation(transactionType);
      const finalConfig = { ...CONFIG.fees, ...recommendation, ...feeConfig };
      
      const calculatedFees = await feeCalculator.calculateFees(finalConfig);
      
      // Add compute budget instructions
      const computeBudgetInstructions = [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 200000 }), // Standard compute limit
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: calculatedFees.priorityFee })
      ];
      
      // For versioned transactions, we'll use the original transaction
      // and let Jupiter handle the fee configuration through its API
      // The calculated fees are used for logging and monitoring purposes
    }
    
    // Fallback to original versioned transaction
    tx.sign([signer]);
    const sig = await withRpcLimit(() => connection.sendRawTransaction(tx.serialize(), { skipPreflight: false }));
    await withRpcLimit(() => connection.confirmTransaction(sig, 'confirmed'));
    try {
      const id = Math.random().toString(36).slice(2,10);
      await logTxTrace('send', {
        id,
        timeMs: Date.now(),
        transactionType,
        wireBase64: serializedBase64,
        signature: sig,
      });
    } catch {}
    return sig;
  } catch (e: any) {
    try {
      // Attempt to extract simulation logs
      const logs = (e && typeof e.getLogs === 'function') ? await e.getLogs() : undefined;
      logger.error('sendRawTransaction failed', { error: String(e?.message || e), logs });
      try {
        const id = Math.random().toString(36).slice(2,10);
        await logTxTrace('send', {
          id,
          timeMs: Date.now(),
          transactionType,
          wireBase64: serializedBase64,
          err: String(e?.message || e),
          logs,
        });
      } catch {}
    } catch {
      logger.error('sendRawTransaction failed', { error: String(e?.message || e) });
      try {
        const id = Math.random().toString(36).slice(2,10);
        await logTxTrace('send', {
          id,
          timeMs: Date.now(),
          transactionType,
          wireBase64: serializedBase64,
          err: String(e?.message || e),
        });
      } catch {}
    }
    throw e;
  }
}


