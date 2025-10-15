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
    if (!ix) return null;
    if (ix instanceof TransactionInstruction) return ix;
    const keysLike = (ix as any)?.keys;
    const hasShape = typeof (ix as any)?.programId !== 'undefined' && (Array.isArray(keysLike) || (keysLike && typeof keysLike.length === 'number')) && typeof ix === 'object';
    if (!hasShape) return null;
    // Attempt to coerce plain object shapes into a real TransactionInstruction
    const coercePk = (v: any): PublicKey => {
      try {
        if (v instanceof PublicKey) return v;
        // Some SDKs wrap PublicKey under .address
        const inner = (v && (v.address || v.pubkey || v.pubKey)) || v;
        if (inner instanceof PublicKey) return inner;
        if (inner && typeof inner.toBase58 === 'function') return new PublicKey(inner.toBase58());
        if (typeof inner === 'string') return new PublicKey(inner);
        // Last resort: stringify
        return new PublicKey(String(inner));
      } catch (e) {
        // Throw through to caller; upstream will catch and drop this ix
        throw e;
      }
    };
    const programId = coercePk((ix as any).programId);
    const keyArr: any[] = Array.isArray(keysLike) ? keysLike : Array.from(keysLike as any);
    const keys = keyArr.map((k: any) => ({
      pubkey: coercePk(k?.pubkey ?? k?.pubKey ?? k?.address),
      isSigner: !!k?.isSigner,
      isWritable: !!k?.isWritable,
    }));
    let data: Buffer = Buffer.alloc(0);
    try {
      const raw = (ix as any).data;
      if (Buffer.isBuffer(raw)) data = raw as Buffer;
      else if (raw && typeof raw === 'object' && typeof (raw as any).length === 'number') data = Buffer.from(raw as any);
      else if (typeof raw === 'string') {
        try { data = Buffer.from(raw, 'base64'); } catch { data = Buffer.from([]); }
      }
    } catch {}
    return new TransactionInstruction({ programId, keys, data });
  } catch {}
  return null;
}

function sanitizeInstructionKeys(ix: TransactionInstruction): void {
  try {
    // Ensure programId is a PublicKey
    if (!(ix.programId instanceof PublicKey)) {
      ix.programId = new PublicKey((ix as any).programId);
    }
  } catch {}
  try {
    if (Array.isArray(ix.keys)) {
      for (let i = 0; i < ix.keys.length; i += 1) {
        const k = ix.keys[i] as any;
        try {
          if (!(k.pubkey instanceof PublicKey)) {
            ix.keys[i] = { pubkey: new PublicKey(k.pubkey), isSigner: !!k.isSigner, isWritable: !!k.isWritable } as any;
          }
        } catch {}
      }
    }
  } catch {}
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

export async function assembleAndSimulate(instructions: any[], opts?: SendOptions): Promise<{ logs?: string[]; err?: any; wireBase64?: string }> {
  const connection = getConnection();
  const kp = await ensureWallet((await import('../utils/config.js')).CONFIG.walletPath);
  const realIxs: TransactionInstruction[] = [];
  // Compute budget ixs
  if (opts?.computeUnitLimit && opts.computeUnitLimit > 0) realIxs.push(ComputeBudgetProgram.setComputeUnitLimit({ units: Math.floor(opts.computeUnitLimit) }));
  if (opts?.computeUnitPriceMicroLamports && opts.computeUnitPriceMicroLamports > 0) realIxs.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: Math.floor(opts.computeUnitPriceMicroLamports) }));
  let skipped = 0;
  for (const ix of instructions) {
    try {
      const t = toInstruction(ix);
      if (t) { try { sanitizeInstructionKeys(t); } catch {} realIxs.push(t); }
      else { skipped += 1; try { logger.info('tx.ix.coerce.skip', { cat: 'tx', ctx: { reason: 'bad_shape', shape: (ix && typeof ix === 'object' ? Object.keys(ix) : typeof ix) } as any }); } catch {} }
    } catch (e: any) {
      skipped += 1;
      try { logger.info('tx.ix.coerce.err', { cat: 'tx', ctx: { error: String(e?.message || e), shape: (ix && typeof ix === 'object' ? Object.keys(ix) : typeof ix) } as any }); } catch {}
    }
  }
  try {
    for (let i = 0; i < realIxs.length; i += 1) {
      const it = realIxs[i] as any;
      const pid = (it?.programId && typeof it.programId.toBase58 === 'function') ? it.programId.toBase58() : String(it?.programId);
      const dataKind = Buffer.isBuffer(it?.data) ? `buffer:${(it?.data as Buffer).length}` : (it?.data ? typeof it.data : 'none');
      const keyKinds = Array.isArray(it?.keys) ? (it.keys as any[]).map(k => (k?.pubkey && typeof k.pubkey.toBase58 === 'function') ? 'pk' : typeof k?.pubkey) : [];
      try { logger.info('tx.preflight.ix', { idx: i, pid, data: dataKind, keys: keyKinds }); } catch {}
    }
  } catch {}
  const { blockhash } = await connection.getLatestBlockhash('finalized');
  try {
    logger.info('tx.preflight.detail', { cat: 'tx', ctx: { ixCount: realIxs.length, origCount: (instructions || []).length, skipped, programs: realIxs.map(ix => (ix.programId && (ix.programId as any).toBase58 ? (ix.programId as any).toBase58() : String(ix.programId))) } as any });
  } catch {}
  const lookupTables = await loadLookupTables(connection, (opts?.lookupTableAddresses || []));
  const msg = new TransactionMessage({ payerKey: kp.publicKey, recentBlockhash: blockhash, instructions: realIxs }).compileToV0Message(lookupTables);
  const tx = new VersionedTransaction(msg);
  tx.sign([kp]);
  const wireBase64 = Buffer.from(tx.serialize()).toString('base64');
  const sim = await connection.simulateTransaction(tx, { sigVerify: true });
  return { logs: sim.value?.logs, err: sim.value?.err, wireBase64 };
}

export async function assembleAndSend(instructions: any[], opts?: SendOptions): Promise<{ signature: string; wireBase64: string }> {
  const connection = getConnection();
  const kp = await ensureWallet((await import('../utils/config.js')).CONFIG.walletPath);
  const realIxs: TransactionInstruction[] = [];
  if (opts?.computeUnitLimit && opts.computeUnitLimit > 0) realIxs.push(ComputeBudgetProgram.setComputeUnitLimit({ units: Math.floor(opts.computeUnitLimit) }));
  if (opts?.computeUnitPriceMicroLamports && opts.computeUnitPriceMicroLamports > 0) realIxs.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: Math.floor(opts.computeUnitPriceMicroLamports) }));
  for (const ix of instructions) {
    const t = toInstruction(ix);
    if (t) { try { sanitizeInstructionKeys(t); } catch {} realIxs.push(t); }
  }
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('finalized');
  try {
    logger.info('tx.send.detail', { cat: 'tx', ctx: { ixCount: realIxs.length, programs: realIxs.map(ix => (ix.programId && (ix.programId as any).toBase58 ? (ix.programId as any).toBase58() : String(ix.programId))) } as any });
  } catch {}
  const lookupTables = await loadLookupTables(connection, (opts?.lookupTableAddresses || []));
  const msg = new TransactionMessage({ payerKey: kp.publicKey, recentBlockhash: blockhash, instructions: realIxs }).compileToV0Message(lookupTables);
  const tx = new VersionedTransaction(msg);
  tx.sign([kp]);
  const wireBase64 = Buffer.from(tx.serialize()).toString('base64');
  const sig = await connection.sendTransaction(tx, { skipPreflight: false, preflightCommitment: 'confirmed' });
  await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
  return { signature: sig, wireBase64 };
}


