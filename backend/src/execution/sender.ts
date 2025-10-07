import { Connection, PublicKey, TransactionMessage, VersionedTransaction, ComputeBudgetProgram, AddressLookupTableAccount, TransactionInstruction } from '@solana/web3.js';
import { ensureWallet, getConnection } from '../wallet/wallet.js';
import { logger } from '../utils/logger.js';

export type SendOptions = {
  computeUnitLimit?: number;
  computeUnitPriceMicroLamports?: number;
  lookupTableAddresses?: string[];
};

function toInstruction(ix: any): TransactionInstruction | null {
  try {
    if (ix && typeof ix.programId !== 'undefined' && typeof ix.keys !== 'undefined') {
      // Assume already a TransactionInstruction
      if (ix instanceof TransactionInstruction) return ix;
      // Best-effort: ignore plain objects; builders should return real ixs
    }
  } catch {}
  return null;
}

async function loadLookupTables(connection: Connection, addrs: string[]): Promise<AddressLookupTableAccount[]> {
  const out: AddressLookupTableAccount[] = [];
  for (const a of addrs) {
    try {
      const pk = new PublicKey(a);
      const acc = await connection.getAddressLookupTable(pk).then(r => r.value).catch(() => null);
      if (acc) out.push(acc);
    } catch {}
  }
  return out;
}

export async function assembleAndSimulate(instructions: any[], opts?: SendOptions): Promise<{ logs?: string[]; err?: any }> {
  const connection = getConnection();
  const kp = await ensureWallet((await import('../utils/config.js')).CONFIG.walletPath);
  const realIxs: TransactionInstruction[] = [];
  // Compute budget ixs
  if (opts?.computeUnitLimit && opts.computeUnitLimit > 0) realIxs.push(ComputeBudgetProgram.setComputeUnitLimit({ units: Math.floor(opts.computeUnitLimit) }));
  if (opts?.computeUnitPriceMicroLamports && opts.computeUnitPriceMicroLamports > 0) realIxs.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: Math.floor(opts.computeUnitPriceMicroLamports) }));
  for (const ix of instructions) {
    const t = toInstruction(ix);
    if (t) realIxs.push(t);
  }
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('finalized');
  const lookupTables = await loadLookupTables(connection, (opts?.lookupTableAddresses || []));
  const msg = new TransactionMessage({ payerKey: kp.publicKey, recentBlockhash: blockhash, instructions: realIxs }).compileToV0Message(lookupTables);
  const tx = new VersionedTransaction(msg);
  tx.sign([kp]);
  const sim = await connection.simulateTransaction(tx, { sigVerify: true });
  return { logs: sim.value?.logs, err: sim.value?.err };
}

export async function assembleAndSend(instructions: any[], opts?: SendOptions): Promise<{ signature: string }> {
  const connection = getConnection();
  const kp = await ensureWallet((await import('../utils/config.js')).CONFIG.walletPath);
  const realIxs: TransactionInstruction[] = [];
  if (opts?.computeUnitLimit && opts.computeUnitLimit > 0) realIxs.push(ComputeBudgetProgram.setComputeUnitLimit({ units: Math.floor(opts.computeUnitLimit) }));
  if (opts?.computeUnitPriceMicroLamports && opts.computeUnitPriceMicroLamports > 0) realIxs.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: Math.floor(opts.computeUnitPriceMicroLamports) }));
  for (const ix of instructions) {
    const t = toInstruction(ix);
    if (t) realIxs.push(t);
  }
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('finalized');
  const lookupTables = await loadLookupTables(connection, (opts?.lookupTableAddresses || []));
  const msg = new TransactionMessage({ payerKey: kp.publicKey, recentBlockhash: blockhash, instructions: realIxs }).compileToV0Message(lookupTables);
  const tx = new VersionedTransaction(msg);
  tx.sign([kp]);
  const sig = await connection.sendTransaction(tx, { skipPreflight: false, preflightCommitment: 'confirmed' });
  await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
  return { signature: sig };
}


