import { Connection, PublicKey, TransactionMessage, VersionedTransaction, ComputeBudgetProgram, AddressLookupTableAccount, TransactionInstruction } from '@solana/web3.js';
import { ensureWallet, getConnection } from '../wallet/wallet.js';
import { withRpcLimit } from '../utils/rpcLimiter.js';
import { writeDexFullDump } from '../utils/txTrace.js';
import { CONFIG } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import { LogCode } from '../utils/logging.js';
import { getTxRelatedLogs } from '../utils/sessionLogs.js';
import { optimizeAccountOrder } from '../execution/utils/accountOrdering.js';
const TX_DEBUG_COERCION = !!((CONFIG as any)?.tx?.debugIxCoercion);

export type SendOptions = {
  computeUnitLimit?: number;
  computeUnitPriceMicroLamports?: number;
  lookupTableAddresses?: string[];
};
function detectDexesFromPrograms(programIds: string[]): Array<'raydium' | 'orca' | 'meteora'> {
  const set = new Set<'raydium' | 'orca' | 'meteora'>();
  const rayAmmV4 = String((CONFIG as any)?.raydium?.ammV4Program || '').trim();
  const rayAmmV5 = String((CONFIG as any)?.raydium?.ammV5Program || '').trim();
  const rayClmm = String((CONFIG as any)?.raydium?.clmmProgram || '').trim();
  const orcaPid = String((CONFIG as any)?.orca?.programId || '').trim();
  const metPid = String((CONFIG as any)?.meteora?.programId || '').trim();
  for (const pid of programIds) {
    if (!pid) continue;
    if (pid === rayAmmV4 || (rayAmmV5 && pid === rayAmmV5) || (rayClmm && pid === rayClmm)) set.add('raydium');
    if (orcaPid && pid === orcaPid) set.add('orca');
    if (metPid && pid === metPid) set.add('meteora');
  }
  return Array.from(set);
}


function toInstruction(ix: any): TransactionInstruction | null {
  try {
    if (!ix) return null;
    // Helper to normalize any PublicKey-like input (including foreign web3 copies)
    const normalizePk = (v: any): PublicKey => {
        if (v instanceof PublicKey) return v;
      const inner = (v && (v.address || v.pubkey || v.pubKey || v.publicKey)) || v;
        if (inner instanceof PublicKey) return inner;
      // Try extracting raw bytes from BN-like internals first (avoid calling foreign toBase58/toBuffer)
      try {
        const maybeBn = (inner && (inner._bn || inner.bn || inner.value)) as any;
        if (maybeBn && typeof maybeBn === 'object') {
          if (typeof maybeBn.toArrayLike === 'function') {
            const bytes = maybeBn.toArrayLike(Uint8Array, 'be', 32);
            return new PublicKey(bytes);
          }
          if (typeof maybeBn.toArray === 'function') {
            const arr = maybeBn.toArray('be', 32);
            return new PublicKey(Uint8Array.from(arr));
          }
        }
      } catch {}
      // Try direct byte accessors
      try { if (inner && typeof inner.toBytes === 'function') { return new PublicKey(inner.toBytes()); } } catch {}
      try { if (inner && typeof inner.toBuffer === 'function') { return new PublicKey(inner.toBuffer()); } } catch {}
      // Handle array-like 32-byte input
      try { if (Array.isArray(inner) && inner.length === 32) { return new PublicKey(Uint8Array.from(inner)); } } catch {}
      // Handle common wrapped shapes: { value | bytes | data }
      try {
        const wrapped: any = (inner && ((inner as any).value ?? (inner as any).bytes ?? (inner as any).data)) as any;
        if (wrapped) {
          if (typeof wrapped === 'string') return new PublicKey(wrapped);
          if (wrapped instanceof Uint8Array) return new PublicKey(wrapped);
          if (Array.isArray(wrapped) && wrapped.length === 32) return new PublicKey(Uint8Array.from(wrapped));
        }
      } catch {}
      // Fallbacks
        if (typeof inner === 'string') return new PublicKey(inner);
      try { if (typeof (inner as any)?.toBase58 === 'function') return new PublicKey((inner as any).toBase58()); } catch {}
      // As a last resort, throw so caller treats this as uncoercible
      throw new Error('UNCOERCIBLE_PUBKEY');
    };
    // If it's already a TransactionInstruction (possibly even from our web3), clone into our TI with normalized keys
    if (ix instanceof TransactionInstruction) {
      try { if (TX_DEBUG_COERCION) logger.debug('tx.ix.coerce.path', { path: 'same_TI' }); } catch {}
      const src: any = ix;
      const keysSrc: any[] = Array.isArray(src.keys) ? src.keys : Array.from(src.keys || []);
      return new TransactionInstruction({
        programId: normalizePk(src.programId),
        keys: keysSrc.map((k: any) => ({ pubkey: normalizePk(k?.pubkey ?? k?.pubKey ?? k?.address), isSigner: !!k?.isSigner, isWritable: !!k?.isWritable })),
        data: Buffer.isBuffer(src.data) ? src.data : (src.data instanceof Uint8Array ? Buffer.from(src.data) : Buffer.from([])),
      });
    }
    const ctorName: string | undefined = (ix && ix.constructor && ix.constructor.name) ? ix.constructor.name : undefined;
    // If it's a TI from a different web3.js copy, coerce by shape
    if (ctorName === 'TransactionInstruction' && typeof (ix as any).programId !== 'undefined') {
      try { if (TX_DEBUG_COERCION) logger.debug('tx.ix.coerce.path', { path: 'foreign_TI', ctorName }); } catch {}
      const foreign = ix as any;
      const programId = normalizePk(foreign.programId);
      const keysSrc: any[] = Array.isArray(foreign.keys)
        ? foreign.keys
        : ((foreign.keys && typeof (foreign.keys as any)[Symbol.iterator] === 'function')
            ? Array.from(foreign.keys as any)
            : ((foreign.keys && typeof (foreign.keys as any).length === 'number')
                ? Array.from({ length: Number((foreign.keys as any).length) }, (_, i) => (foreign.keys as any)[i])
                : []));
      const keys = keysSrc.map((k: any) => ({
        pubkey: normalizePk(k?.pubkey ?? k?.pubKey ?? k?.address),
        isSigner: !!k?.isSigner,
        isWritable: !!k?.isWritable,
      }));
      const data: Buffer = Buffer.isBuffer(foreign.data)
        ? foreign.data
        : (foreign.data && typeof (foreign.data as any).length === 'number'
            ? Buffer.from(foreign.data as any)
            : (typeof foreign.data === 'string' ? Buffer.from(foreign.data, 'base64') : Buffer.alloc(0)));
      return new TransactionInstruction({ programId, keys, data });
    }
    const keysLike = (ix as any)?.keys;
    // Attempt to coerce plain object shapes into a real TransactionInstruction (very permissive)
    if (typeof ix !== 'object') return null;
    // Support alternative pid fields seen in various SDKs: programAddress, program.address, program
    const pidLike = (ix as any)?.programId
      ?? (ix as any)?.programAddress
      ?? (((ix as any)?.program && (((ix as any).program as any).address || (ix as any).program)) as any)
      ?? undefined;
    if (!pidLike) return null;
    const programId = normalizePk(pidLike);
    let keyArr: any[] = [];
    try {
      if (Array.isArray(keysLike)) keyArr = keysLike;
      else if (keysLike && typeof (keysLike as any)[Symbol.iterator] === 'function') keyArr = Array.from(keysLike as any);
      else if (keysLike && typeof (keysLike as any).length === 'number') keyArr = Array.from({ length: Number((keysLike as any).length) }, (_, i) => (keysLike as any)[i]);
      else if (keysLike && typeof keysLike === 'object') {
        const vals = Object.values(keysLike as any);
        if (vals.length && (vals[0] as any) && ((vals[0] as any).pubkey || (vals[0] as any).pubKey || (vals[0] as any).address)) keyArr = vals as any[];
      }
    } catch {}
    const keys = keyArr.map((k: any) => ({
      pubkey: normalizePk(k?.pubkey ?? k?.pubKey ?? k?.address),
      isSigner: !!k?.isSigner,
      isWritable: !!k?.isWritable,
    }));
    let data: Buffer = Buffer.alloc(0);
    try {
      const raw = (ix as any).data;
      if (Buffer.isBuffer(raw)) data = raw as Buffer;
      else if (raw instanceof Uint8Array) data = Buffer.from(raw);
      else if (raw && typeof raw === 'object' && typeof (raw as any).length === 'number') data = Buffer.from(Array.from(raw as any));
      else if (typeof raw === 'string') {
        try { data = Buffer.from(raw, 'base64'); } catch { data = Buffer.from([]); }
      }
    } catch {}
    try { if (TX_DEBUG_COERCION) logger.debug('tx.ix.coerce.path', { path: 'plain_object', keys: keys.length, dataLen: data.length }); } catch {}
    return new TransactionInstruction({ programId, keys, data });
  } catch (e: any) {
    try { logger.info('tx.ix.coerce.err', { cat: 'tx', ctx: { error: String(e?.message || e), shape: (ix && typeof ix === 'object' ? Object.keys(ix) : typeof ix) } as any }); } catch {}
  }
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
    
    // Skip account ordering optimization for DEX programs that require strict account ordering
    // DEX programs have account order as part of their instruction interface contract
    const programIdStr = ix.programId.toBase58();
    
    // Hardcoded mainnet program IDs (fallbacks if config not set)
    const dexProgramIds = new Set([
      // Orca Whirlpool
      'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
      // Raydium AMM V4
      '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
      // Raydium AMM V5
      'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C',
      // Raydium CLMM
      'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
      // Meteora DLMM
      'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',
      // Meteora AMM V1
      'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB',
      // Meteora AMM V2
      'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG',
    ]);
    
    // Also check config-based program IDs
    const configProgramIds = [
      (CONFIG as any)?.orca?.programId,
      (CONFIG as any)?.raydium?.ammV4Program,
      (CONFIG as any)?.raydium?.ammV5Program,
      (CONFIG as any)?.raydium?.clmmProgram,
      (CONFIG as any)?.meteora?.programId,
      (CONFIG as any)?.meteora?.amm?.v1ProgramId,
      (CONFIG as any)?.meteora?.amm?.v2ProgramId,
    ].filter(Boolean).map(String);
    
    for (const pid of configProgramIds) {
      if (pid) dexProgramIds.add(pid);
    }
    
    const isDexProgram = dexProgramIds.has(programIdStr);
    
    // Only optimize account ordering for non-DEX programs
    if (!isDexProgram) {
      try {
        const optimized = optimizeAccountOrder(ix);
        ix.keys = optimized.keys;
      } catch {
        // If optimization fails, continue with original keys
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
      if (acc) {
        out.push(acc);
        try {
          logger.debug('tx.lookup_table.loaded_individual', {
            cat: 'tx',
            ctx: {
              address: a,
              accountCount: acc.state.addresses.length,
            },
          });
        } catch {}
      } else {
        try {
          logger.warn('tx.lookup_table.load_failed', {
            cat: 'tx',
            ctx: {
              address: a,
              error: 'Failed to load ALT account',
            },
          });
        } catch {}
      }
    } catch (err) {
      try {
        logger.warn('tx.lookup_table.load_error', {
          cat: 'tx',
          ctx: {
            address: a,
            error: String((err as any)?.message || err),
          },
        });
      } catch {}
    }
  }
  return out;
}

// Get common lookup table addresses from ALT manager
async function getCommonLookupTables(connection: Connection): Promise<AddressLookupTableAccount[]> {
  try {
    const { dexAltManager } = await import('./utils/altManager.js');
    const altAddresses = dexAltManager.getAllAltAddresses();
    
    if (altAddresses.length === 0) {
      return [];
    }
    
    const accounts: AddressLookupTableAccount[] = [];
    for (const addr of altAddresses) {
      try {
        const pk = new PublicKey(addr);
        const acc = await connection.getAddressLookupTable(pk).then(r => r.value).catch(() => null);
        if (acc) {
          accounts.push(acc);
          try { 
            logger.debug('tx.lookup_table.loaded', { 
              cat: 'tx', 
              ctx: { address: addr, accountCount: acc.state.addresses.length } 
            }); 
          } catch {}
        }
      } catch {}
    }
    
    return accounts;
  } catch (error) {
    try {
      logger.warn('tx.lookup_table.manager.load.failed', {
        cat: 'tx',
        ctx: { error: String((error as any)?.message || error) },
      });
    } catch {}
    return [];
  }
}

function summarizeSimError(logs?: string[], err?: any): { ix?: number; custom?: number; hint?: string; account?: string; errorType?: string } {
  try {
    if (err && err.InstructionError && Array.isArray(err.InstructionError)) {
      const ix = Number(err.InstructionError[0]);
      const detail = err.InstructionError[1];
      
      // Check for ProgramAccountNotFound specifically
      if (detail?.ProgramAccountNotFound !== undefined) {
        return { 
        ix, 
        errorType: 'ProgramAccountNotFound',
        hint: `ProgramAccountNotFound at instruction ${ix}`,
        account: detail.ProgramAccountNotFound ? String(detail.ProgramAccountNotFound) : undefined
      };
      }
      
      // Check for other common errors
      if (detail?.Custom !== undefined) {
        const custom = Number(detail.Custom);
        return { ix, custom, errorType: 'Custom', hint: custom ? `custom=${custom}` : undefined };
      }
      
      // Check for other error types
      const errorKeys = Object.keys(detail || {});
      if (errorKeys.length > 0) {
        const errorType = errorKeys[0];
        return { ix, errorType, hint: `${errorType} at instruction ${ix}`, account: detail[errorType] ? String(detail[errorType]) : undefined };
      }
      
      return { ix, hint: `instruction ${ix} error` };
    }
    
    // Try to extract error from logs
    const last = Array.isArray(logs) ? [...logs].reverse().find(l => /error|failed|custom program error|ProgramAccountNotFound/i.test(l)) : undefined;
    
    // Try to extract account address from logs if ProgramAccountNotFound
    let account: string | undefined;
    if (last && /ProgramAccountNotFound/i.test(last)) {
      // Try to extract account address from log (format may vary)
      const accountMatch = last.match(/([A-Za-z0-9]{32,44})/);
      if (accountMatch) {
        account = accountMatch[1];
      }
    }
    
    return { hint: last, errorType: last && /ProgramAccountNotFound/i.test(last) ? 'ProgramAccountNotFound' : undefined, account };
  } catch { return {}; }
}

export async function assembleAndSimulate(instructions: any[], opts?: SendOptions): Promise<{ logs?: string[]; err?: any; wireBase64?: string }> {
  const connection = getConnection();
  const kp = await ensureWallet((await import('../utils/config.js')).CONFIG.walletPath);
  const realIxs: TransactionInstruction[] = [];
  
  // Check if compute budget instructions already exist in the incoming instructions
  const COMPUTE_BUDGET_PROGRAM_ID = 'ComputeBudget111111111111111111111111111111';
  let hasComputeUnitLimit = false;
  let hasComputeUnitPrice = false;
  
  // First pass: check for existing compute budget instructions
  for (const ix of instructions) {
    try {
      // Check for type field first (from computeBudgetIxs format)
      const type = (ix as any)?.type;
      if (type === 'set_compute_unit_limit') hasComputeUnitLimit = true;
      else if (type === 'set_compute_unit_price') hasComputeUnitPrice = true;
      
      // Also check converted instruction format
      const t = toInstruction(ix);
      if (t) {
        const pid = t.programId?.toBase58?.() || String(t.programId);
        if (pid === COMPUTE_BUDGET_PROGRAM_ID) {
          // Check instruction data to determine which compute budget instruction it is
          const data = t.data;
          if (Buffer.isBuffer(data) || data instanceof Uint8Array) {
            // ComputeBudgetProgram.setComputeUnitLimit has discriminator 2
            // ComputeBudgetProgram.setComputeUnitPrice has discriminator 3
            if (data.length > 0) {
              const discriminator = data[0];
              if (discriminator === 2) hasComputeUnitLimit = true;
              else if (discriminator === 3) hasComputeUnitPrice = true;
            }
          }
        }
      }
    } catch {}
  }
  
  // Only add compute budget instructions if they don't already exist
  if (opts?.computeUnitLimit && opts.computeUnitLimit > 0 && !hasComputeUnitLimit) {
    realIxs.push(ComputeBudgetProgram.setComputeUnitLimit({ units: Math.floor(opts.computeUnitLimit) }));
  }
  if (opts?.computeUnitPriceMicroLamports && opts.computeUnitPriceMicroLamports > 0 && !hasComputeUnitPrice) {
    realIxs.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: Math.floor(opts.computeUnitPriceMicroLamports) }));
  }
  
  let skipped = 0;
  for (const ix of instructions) {
    try {
      const t = toInstruction(ix);
      if (t) {
        // Skip obviously empty instructions (no keys and no data)
        try {
          const noKeys = !Array.isArray((t as any).keys) || (t as any).keys.length === 0;
          const noData = !(t as any).data || ((t as any).data as Buffer).length === 0;
          if (noKeys && noData) { skipped += 1; try { logger.info('tx.ix.coerce.skip', { cat: 'tx', ctx: { reason: 'empty_ix' } }); } catch {} ; continue; }
        } catch {}
        try { sanitizeInstructionKeys(t); } catch {}
        realIxs.push(t);
      }
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
  const { blockhash } = await withRpcLimit(() => connection.getLatestBlockhash('finalized'));
  const txId = Math.random().toString(36).slice(2, 10);
  try {
    logger.info('tx.preflight.start', { cat: 'tx', ctx: { txId, ixCount: realIxs.length } as any });
  } catch {}
  try {
    logger.info('tx.preflight.detail', { cat: 'tx', ctx: { txId, ixCount: realIxs.length, origCount: (instructions || []).length, skipped, programs: realIxs.map(ix => (ix.programId && (ix.programId as any).toBase58 ? (ix.programId as any).toBase58() : String(ix.programId))) } as any });
  } catch {}
  let lookupTables = await loadLookupTables(connection, (opts?.lookupTableAddresses || []));
  
  // Calculate total accounts to detect large transactions
  const totalAccounts = realIxs.reduce((sum, ix) => sum + (ix.keys?.length || 0), 0);
  const isLargeTransaction = totalAccounts > 30 || realIxs.length > 5;
  
  // Log ALT addresses received
  try {
    logger.info('tx.lookup_table.addresses', {
      cat: 'tx',
      ctx: {
        txId,
        addresses: opts?.lookupTableAddresses || [],
        loadedCount: lookupTables.length,
        instructionCount: realIxs.length,
        accountCount: totalAccounts,
        isLargeTransaction,
      },
    });
  } catch {}
  
  // CRITICAL: Always try to load common ALTs for large or multi-hop transactions
  // This prevents "encoding overruns Uint8Array" errors
  if (lookupTables.length === 0 || isLargeTransaction) {
    const commonTables = await getCommonLookupTables(connection);
    if (commonTables.length > 0) {
      // Merge common tables, avoiding duplicates
      const existingAddrs = new Set(lookupTables.map(lt => lt.key.toBase58()));
      for (const table of commonTables) {
        if (!existingAddrs.has(table.key.toBase58())) {
          lookupTables.push(table);
        }
      }
      try { 
        logger.info('tx.lookup_table.using_common', { 
          cat: 'tx', 
          ctx: { 
            txId,
            count: commonTables.length,
            totalAccounts: commonTables.reduce((sum, lt) => sum + (lt.state?.addresses?.length || 0), 0),
            instructionCount: realIxs.length,
            accountCount: totalAccounts,
            wasLargeTransaction: isLargeTransaction,
          } 
        }); 
      } catch {}
    } else {
      // Log warning if no ALTs available, especially for large transactions
      try {
        logger.warn('tx.lookup_table.none_available', {
          cat: 'tx',
          ctx: {
            txId,
            instructionCount: realIxs.length,
            accountCount: totalAccounts,
            providedAddresses: opts?.lookupTableAddresses || [],
            isLargeTransaction,
            warning: isLargeTransaction ? 'Large transaction without ALTs may fail serialization' : undefined,
          },
        });
      } catch {}
    }
  }
  
  // Analyze ALT coverage before attempting compilation
  try {
    const allTxAccounts = new Set<string>();
    const altAccountSet = new Set<string>();
    
    // Collect all accounts from instructions
    for (const ix of realIxs) {
      if (ix.programId) {
        allTxAccounts.add(ix.programId.toBase58());
      }
      if (ix.keys) {
        for (const key of ix.keys) {
          if (key.pubkey) {
            allTxAccounts.add(key.pubkey.toBase58());
          }
        }
      }
    }
    
    // Collect all accounts available in ALTs
    for (const alt of lookupTables) {
      if (alt.state?.addresses) {
        for (const addr of alt.state.addresses) {
          altAccountSet.add(addr.toBase58());
        }
      }
    }
    
    // Find accounts NOT covered by ALTs
    const uncoveredAccounts: string[] = [];
    for (const account of allTxAccounts) {
      if (!altAccountSet.has(account)) {
        uncoveredAccounts.push(account);
      }
    }
    
    const coveredCount = allTxAccounts.size - uncoveredAccounts.length;
    const coveragePercent = allTxAccounts.size > 0 
      ? Math.round((coveredCount / allTxAccounts.size) * 100) 
      : 0;
    
    logger.info('tx.alt.coverage.analysis', {
      cat: 'tx',
      ctx: {
        txId,
        totalAccounts: allTxAccounts.size,
        altCoveredAccounts: coveredCount,
        uncoveredAccounts: uncoveredAccounts.length,
        coveragePercent,
        altCount: lookupTables.length,
        totalAltAccounts: altAccountSet.size,
        // Sample of uncovered accounts (first 10)
        uncoveredSample: uncoveredAccounts.slice(0, 10),
      },
    });
    
    // If coverage is poor, log more details
    if (coveragePercent < 50 && uncoveredAccounts.length > 5) {
      logger.warn('tx.alt.coverage.poor', {
        cat: 'tx',
        ctx: {
          txId,
          coveragePercent,
          uncoveredAccounts: uncoveredAccounts,
          warning: 'Many accounts not in ALTs - transaction may be too large',
        },
      });
    }
  } catch (analysisErr) {
    try {
      logger.warn('tx.alt.coverage.analysis.error', {
        cat: 'tx',
        ctx: {
          txId,
          error: String((analysisErr as any)?.message || analysisErr),
        },
      });
    } catch {}
  }
  
  // Try to compile and serialize with error handling for "encoding overruns" errors
  let msg: any;
  let tx: VersionedTransaction;
  let wireBase64: string;
  
  try {
    msg = new TransactionMessage({ payerKey: kp.publicKey, recentBlockhash: blockhash, instructions: realIxs }).compileToV0Message(lookupTables);
    tx = new VersionedTransaction(msg);
    tx.sign([kp]);
    wireBase64 = Buffer.from(tx.serialize()).toString('base64');
  } catch (error: any) {
    const errorMsg = String(error?.message || error);
    // Check if it's a size/encoding-related error
    if (errorMsg.includes('encoding') || errorMsg.includes('overrun') || errorMsg.includes('Uint8Array') || errorMsg.includes('size')) {
      try {
        logger.error('tx.serialize.size_error', {
          cat: 'tx',
          code: LogCode.TX_PREFLIGHT_ERR,
          ctx: {
            txId,
            error: errorMsg,
            instructionCount: realIxs.length,
            accountCount: totalAccounts,
            lookupTableCount: lookupTables.length,
            suggestion: lookupTables.length === 0 
              ? 'No ALTs available - transaction too large. Consider configuring Address Lookup Tables.' 
              : 'Transaction may still be too large even with ALTs. Consider splitting into multiple transactions.',
          } as any,
        });
      } catch {}
      return { logs: [], err: { SerializationError: `Transaction too large: ${errorMsg}. Account count: ${totalAccounts}, Instructions: ${realIxs.length}, ALTs: ${lookupTables.length}` }, wireBase64: '' };
    }
    // Re-throw other errors
    throw error;
  }
  
  // CRITICAL: Check actual serialized size before simulation
  // Solana v0 transaction size limit: 1232 bytes (raw) or 1644 bytes (base64 encoded)
  // The error message format suggests checking base64 encoded size
  const rawSizeBytes = Buffer.from(wireBase64, 'base64').length;
  const base64SizeBytes = wireBase64.length; // Base64 encoded size
  const MAX_TX_SIZE_RAW = 1232; // Raw transaction size limit
  const MAX_TX_SIZE_BASE64 = 1644; // Base64 encoded size limit
  
  // Check both raw and base64 sizes (base64 is what Solana reports in errors)
  if (rawSizeBytes > MAX_TX_SIZE_RAW || base64SizeBytes > MAX_TX_SIZE_BASE64) {
    const errorMsg = `Transaction too large: ${base64SizeBytes} bytes base64 encoded / ${rawSizeBytes} bytes raw (max: ${MAX_TX_SIZE_BASE64} bytes encoded / ${MAX_TX_SIZE_RAW} bytes raw). Instruction count: ${realIxs.length}, Lookup tables: ${lookupTables.length}`;
    try {
      logger.error('tx.size.exceeded', {
        cat: 'tx',
        code: LogCode.TX_PREFLIGHT_ERR,
        ctx: {
          txId,
          base64SizeBytes,
          rawSizeBytes,
          maxSizeRaw: MAX_TX_SIZE_RAW,
          maxSizeBase64: MAX_TX_SIZE_BASE64,
          ixCount: realIxs.length,
          lookupTableCount: lookupTables.length,
          error: errorMsg,
        } as any,
      });
    } catch {}
    return { logs: [], err: { TransactionTooLarge: errorMsg }, wireBase64 };
  }
  
  // Log successful serialization with size details
  try {
    logger.info('tx.serialize.success', {
      cat: 'tx',
      ctx: {
        txId,
        rawSizeBytes,
        base64SizeBytes,
        maxSizeRaw: MAX_TX_SIZE_RAW,
        maxSizeBase64: MAX_TX_SIZE_BASE64,
        sizePctUsedRaw: Math.round((rawSizeBytes / MAX_TX_SIZE_RAW) * 100),
        sizePctUsedBase64: Math.round((base64SizeBytes / MAX_TX_SIZE_BASE64) * 100),
        ixCount: realIxs.length,
        lookupTableCount: lookupTables.length,
        accountCount: totalAccounts,
      },
    });
  } catch {}
  
  const sim = await connection.simulateTransaction(tx, { sigVerify: true });
  if (sim.value?.err) {
    const errorDetails = summarizeSimError(sim.value?.logs, sim.value?.err);
    try { 
      logger.error('tx.preflight.summary', { 
        cat: 'tx', 
        ctx: { 
          txId, 
          ...errorDetails,
          // Add full error details for debugging
          fullError: sim.value?.err,
          instructionCount: realIxs.length,
          // If ProgramAccountNotFound, log which instruction and account
          failingInstruction: errorDetails.ix !== undefined ? {
            index: errorDetails.ix,
            programId: realIxs[errorDetails.ix]?.programId?.toBase58?.() || 'unknown',
            accountCount: realIxs[errorDetails.ix]?.keys?.length || 0,
            accounts: realIxs[errorDetails.ix]?.keys?.map((k: any, idx: number) => ({
              index: idx,
              address: k?.pubkey?.toBase58?.() || String(k?.pubkey || ''),
              isSigner: !!k?.isSigner,
              isWritable: !!k?.isWritable,
            })) || [],
          } : undefined,
        } as any 
      }); 
    } catch {}
  }
  try {
    const programs = realIxs.map(ix => (ix.programId && (ix.programId as any).toBase58 ? (ix.programId as any).toBase58() : String(ix.programId)));
    const dexes = detectDexesFromPrograms(programs);
    const txLogs = getTxRelatedLogs(txId, Date.now() - 10000, Date.now(), 200);
    for (const d of dexes) {
      await writeDexFullDump(d, 'preflight', {
        kind: 'sender.preflight',
        ixCount: realIxs.length,
        skipped,
        programs,
        opts,
        wireBase64,
        logs: sim.value?.logs,
        err: sim.value?.err || null,
        txLogs,
      });
    }
  } catch {}
  return { logs: sim.value?.logs, err: sim.value?.err, wireBase64 };
}

export async function assembleAndSend(instructions: any[], opts?: SendOptions): Promise<{ signature: string; wireBase64: string }> {
  const connection = getConnection();
  const kp = await ensureWallet((await import('../utils/config.js')).CONFIG.walletPath);
  const realIxs: TransactionInstruction[] = [];
  
  // Check if compute budget instructions already exist in the incoming instructions
  const COMPUTE_BUDGET_PROGRAM_ID = 'ComputeBudget111111111111111111111111111111';
  let hasComputeUnitLimit = false;
  let hasComputeUnitPrice = false;
  
  // First pass: check for existing compute budget instructions
  for (const ix of instructions) {
    try {
      // Check for type field first (from computeBudgetIxs format)
      const type = (ix as any)?.type;
      if (type === 'set_compute_unit_limit') hasComputeUnitLimit = true;
      else if (type === 'set_compute_unit_price') hasComputeUnitPrice = true;
      
      // Also check converted instruction format
      const t = toInstruction(ix);
      if (t) {
        const pid = t.programId?.toBase58?.() || String(t.programId);
        if (pid === COMPUTE_BUDGET_PROGRAM_ID) {
          // Check instruction data to determine which compute budget instruction it is
          const data = t.data;
          if (Buffer.isBuffer(data) || data instanceof Uint8Array) {
            // ComputeBudgetProgram.setComputeUnitLimit has discriminator 2
            // ComputeBudgetProgram.setComputeUnitPrice has discriminator 3
            if (data.length > 0) {
              const discriminator = data[0];
              if (discriminator === 2) hasComputeUnitLimit = true;
              else if (discriminator === 3) hasComputeUnitPrice = true;
            }
          }
        }
      }
    } catch {}
  }
  
  // Only add compute budget instructions if they don't already exist
  if (opts?.computeUnitLimit && opts.computeUnitLimit > 0 && !hasComputeUnitLimit) {
    realIxs.push(ComputeBudgetProgram.setComputeUnitLimit({ units: Math.floor(opts.computeUnitLimit) }));
  }
  if (opts?.computeUnitPriceMicroLamports && opts.computeUnitPriceMicroLamports > 0 && !hasComputeUnitPrice) {
    realIxs.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: Math.floor(opts.computeUnitPriceMicroLamports) }));
  }
  
  for (const ix of instructions) {
    const t = toInstruction(ix);
    if (!t) {
      try {
        const pidRaw: any = (ix && ((ix as any).programId || (ix as any).programAddress)) || '';
        const typ: string = String(((ix as any)?.type) || '').toLowerCase();
        const pidStr: string = (typeof pidRaw === 'string') ? pidRaw : (pidRaw?.toBase58?.() || '');
        const looksDex = /raydium|orca|meteora/.test(typ) || (typeof pidStr === 'string' && pidStr.length >= 32);
        if (looksDex) {
          try { logger.error('tx.ix.coerce.fatal', { cat: 'tx', ctx: { type: typ || 'unknown', pid: pidStr || '(unknown)' } }); } catch {}
          throw new Error(`TX_ASSEMBLY_FAILED: cannot coerce DEX ix (type=${typ || 'unknown'})`);
        }
      } catch (fatal) { throw fatal; }
      continue;
    }
    // Skip obviously empty instructions (no keys and no data)
    try {
      const noKeys = !Array.isArray((t as any).keys) || (t as any).keys.length === 0;
      const noData = !(t as any).data || ((t as any).data as Buffer).length === 0;
      if (noKeys && noData) { try { logger.info('tx.ix.coerce.skip', { cat: 'tx', ctx: { reason: 'empty_ix' } }); } catch {}; continue; }
    } catch {}
    try { sanitizeInstructionKeys(t); } catch {}
    realIxs.push(t);
  }
  const { blockhash, lastValidBlockHeight } = await withRpcLimit(() => connection.getLatestBlockhash('finalized'));
  const txId = Math.random().toString(36).slice(2, 10);
  try {
    logger.info('tx.send.start', { cat: 'tx', ctx: { txId, ixCount: realIxs.length } as any });
    logger.info('tx.send.detail', { cat: 'tx', ctx: { txId, ixCount: realIxs.length, programs: realIxs.map(ix => (ix.programId && (ix.programId as any).toBase58 ? (ix.programId as any).toBase58() : String(ix.programId))) } as any });
  } catch {}
  // Use ALT addresses from options, or try to extract from instructions if available
  const altAddresses = opts?.lookupTableAddresses || [];
  let lookupTables = await loadLookupTables(connection, altAddresses);
  
  // Calculate total accounts to detect large transactions
  const totalAccounts = realIxs.reduce((sum, ix) => sum + (ix.keys?.length || 0), 0);
  const isLargeTransaction = totalAccounts > 30 || realIxs.length > 5;
  
  // Log ALT addresses received
  try {
    logger.info('tx.lookup_table.addresses', {
      cat: 'tx',
      ctx: {
        txId,
        addresses: altAddresses,
        loadedCount: lookupTables.length,
        instructionCount: realIxs.length,
        accountCount: totalAccounts,
        isLargeTransaction,
      },
    });
  } catch {}
  
  // CRITICAL: Always try to load common ALTs for large or multi-hop transactions
  // This prevents "encoding overruns Uint8Array" errors
  if (lookupTables.length === 0 || isLargeTransaction) {
    const commonTables = await getCommonLookupTables(connection);
    if (commonTables.length > 0) {
      // Merge common tables, avoiding duplicates
      const existingAddrs = new Set(lookupTables.map(lt => lt.key.toBase58()));
      for (const table of commonTables) {
        if (!existingAddrs.has(table.key.toBase58())) {
          lookupTables.push(table);
        }
      }
      try { 
        logger.info('tx.lookup_table.using_common', { 
          cat: 'tx', 
          ctx: { 
            txId,
            count: commonTables.length,
            totalAccounts: commonTables.reduce((sum, lt) => sum + (lt.state?.addresses?.length || 0), 0),
            instructionCount: realIxs.length,
            accountCount: totalAccounts,
            wasLargeTransaction: isLargeTransaction,
          } 
        }); 
      } catch {}
    } else {
      // Log warning if no ALTs available, especially for large transactions
      try {
        logger.warn('tx.lookup_table.none_available', {
          cat: 'tx',
          ctx: {
            txId,
            instructionCount: realIxs.length,
            accountCount: totalAccounts,
            providedAddresses: altAddresses,
            isLargeTransaction,
            warning: isLargeTransaction ? 'Large transaction without ALTs may fail serialization' : undefined,
          },
        });
      } catch {}
    }
  }
  
  // Analyze ALT coverage before attempting compilation
  try {
    const allTxAccounts = new Set<string>();
    const altAccountSet = new Set<string>();
    
    // Collect all accounts from instructions
    for (const ix of realIxs) {
      if (ix.programId) {
        allTxAccounts.add(ix.programId.toBase58());
      }
      if (ix.keys) {
        for (const key of ix.keys) {
          if (key.pubkey) {
            allTxAccounts.add(key.pubkey.toBase58());
          }
        }
      }
    }
    
    // Collect all accounts available in ALTs
    for (const alt of lookupTables) {
      if (alt.state?.addresses) {
        for (const addr of alt.state.addresses) {
          altAccountSet.add(addr.toBase58());
        }
      }
    }
    
    // Find accounts NOT covered by ALTs
    const uncoveredAccounts: string[] = [];
    for (const account of allTxAccounts) {
      if (!altAccountSet.has(account)) {
        uncoveredAccounts.push(account);
      }
    }
    
    const coveredCount = allTxAccounts.size - uncoveredAccounts.length;
    const coveragePercent = allTxAccounts.size > 0 
      ? Math.round((coveredCount / allTxAccounts.size) * 100) 
      : 0;
    
    logger.info('tx.alt.coverage.analysis', {
      cat: 'tx',
      ctx: {
        txId,
        totalAccounts: allTxAccounts.size,
        altCoveredAccounts: coveredCount,
        uncoveredAccounts: uncoveredAccounts.length,
        coveragePercent,
        altCount: lookupTables.length,
        totalAltAccounts: altAccountSet.size,
        // Sample of uncovered accounts (first 10)
        uncoveredSample: uncoveredAccounts.slice(0, 10),
      },
    });
    
    // If coverage is poor, log more details
    if (coveragePercent < 50 && uncoveredAccounts.length > 5) {
      logger.warn('tx.alt.coverage.poor', {
        cat: 'tx',
        ctx: {
          txId,
          coveragePercent,
          uncoveredAccounts: uncoveredAccounts,
          warning: 'Many accounts not in ALTs - transaction may be too large',
        },
      });
    }
  } catch (analysisErr) {
    try {
      logger.warn('tx.alt.coverage.analysis.error', {
        cat: 'tx',
        ctx: {
          txId,
          error: String((analysisErr as any)?.message || analysisErr),
        },
      });
    } catch {}
  }
  
  // Try to compile and serialize with error handling for "encoding overruns" errors
  let msg: any;
  let tx: VersionedTransaction;
  let wireBase64: string;
  
  try {
    msg = new TransactionMessage({ payerKey: kp.publicKey, recentBlockhash: blockhash, instructions: realIxs }).compileToV0Message(lookupTables);
    tx = new VersionedTransaction(msg);
    tx.sign([kp]);
    wireBase64 = Buffer.from(tx.serialize()).toString('base64');
  } catch (error: any) {
    const errorMsg = String(error?.message || error);
    // Check if it's a size/encoding-related error
    if (errorMsg.includes('encoding') || errorMsg.includes('overrun') || errorMsg.includes('Uint8Array') || errorMsg.includes('size')) {
      try {
        logger.error('tx.serialize.size_error', {
          cat: 'tx',
          code: LogCode.TX_PREFLIGHT_ERR,
          ctx: {
            txId,
            error: errorMsg,
            instructionCount: realIxs.length,
            accountCount: totalAccounts,
            lookupTableCount: lookupTables.length,
            suggestion: lookupTables.length === 0 
              ? 'No ALTs available - transaction too large. Consider configuring Address Lookup Tables.' 
              : 'Transaction may still be too large even with ALTs. Consider splitting into multiple transactions.',
          } as any,
        });
      } catch {}
      throw new Error(`Transaction too large: ${errorMsg}. Account count: ${totalAccounts}, Instructions: ${realIxs.length}, ALTs: ${lookupTables.length}`);
    }
    // Re-throw other errors
    throw error;
  }
  const sig = await withRpcLimit(() => connection.sendTransaction(tx, { skipPreflight: true, preflightCommitment: 'confirmed' }));
  await withRpcLimit(() => connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed'));
  try {
    const programs = realIxs.map(ix => (ix.programId && (ix.programId as any).toBase58 ? (ix.programId as any).toBase58() : String(ix.programId)));
    const dexes = detectDexesFromPrograms(programs);
    const txLogs = getTxRelatedLogs(txId, Date.now() - 20000, Date.now(), 300);
    for (const d of dexes) {
      await writeDexFullDump(d, 'execute', {
        kind: 'sender.execute',
        ixCount: realIxs.length,
        programs,
        opts,
        wireBase64,
        signature: sig,
        txLogs,
      });
    }
  } catch {}
  return { signature: sig, wireBase64 };
}


