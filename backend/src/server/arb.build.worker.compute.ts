import { PublicKey } from '@solana/web3.js';
import { buildDirectArbTx } from '../execution/builder/tx.js';
import type { ExecutionPlan } from '../execution/types.js';
import type { SerializedInstruction, SerializedInstructionKey, ArbBuildResult } from '../workers/arbBuild.types.js';

function toBase58(value: any): string {
  if (!value) return '';
  try {
    if (typeof value === 'string') return value;
    if (value instanceof PublicKey) return value.toBase58();
    if (typeof value.toBase58 === 'function') return value.toBase58();
    if (Array.isArray(value) && value.length === 32) return new PublicKey(Uint8Array.from(value)).toBase58();
    if (value instanceof Uint8Array && value.length === 32) return new PublicKey(value).toBase58();
    if (typeof value.toBuffer === 'function') {
      const buf = value.toBuffer();
      if (Buffer.isBuffer(buf) || buf instanceof Uint8Array) {
        return new PublicKey(buf).toBase58();
      }
    }
  } catch {}
  try { return new PublicKey(value).toBase58(); } catch {}
  return String(value ?? '');
}

function serializeInstructionKey(key: any): SerializedInstructionKey {
  return {
    pubkey: toBase58(key?.pubkey ?? key?.pubKey ?? key?.address ?? key),
    isSigner: !!key?.isSigner,
    isWritable: !!key?.isWritable,
  };
}

function serializeInstruction(ix: any): SerializedInstruction {
  const programId = toBase58(ix?.programId ?? ix?.programAddress ?? ix?.program?.address ?? ix?.program);
  const keysSrc: any[] = Array.isArray(ix?.keys)
    ? ix.keys
    : (ix?.keys && typeof (ix.keys as any)[Symbol.iterator] === 'function')
      ? Array.from(ix.keys as any)
      : [];
  
  // DIAGNOSTIC: Log for router program to trace key serialization
  const routerProgramId = '2Jgxnj7GGgR1EpwsfNKQhcFhmxAAhDoHmaiaDt2z9Fnw';
  if (programId === routerProgramId) {
    console.log('[serializeInstruction] Router instruction:', {
      keysIsArray: Array.isArray(ix?.keys),
      keysSrcLength: keysSrc.length,
      rawKey0: ix?.keys?.[0],
      rawKey0Type: typeof ix?.keys?.[0],
      rawKey0Pubkey: ix?.keys?.[0]?.pubkey?.toBase58?.() || ix?.keys?.[0]?.pubkey || 'unknown',
      keysSrc0: keysSrc[0],
      keysSrc0Pubkey: keysSrc[0]?.pubkey?.toBase58?.() || keysSrc[0]?.pubkey || 'unknown',
    });
  }
  
  const dataBuf: Buffer = (() => {
    const raw = ix?.data;
    if (!raw) return Buffer.alloc(0);
    if (Buffer.isBuffer(raw)) return raw;
    if (raw instanceof Uint8Array) return Buffer.from(raw);
    if (Array.isArray(raw)) return Buffer.from(raw);
    if (typeof raw === 'string') {
      try { return Buffer.from(raw, 'base64'); } catch { return Buffer.from([]); }
    }
    if (typeof raw === 'object' && typeof raw.length === 'number') {
      try { return Buffer.from(Array.from(raw as any)); } catch {}
    }
    return Buffer.alloc(0);
  })();
  
  const serializedKeys = keysSrc.map(serializeInstructionKey);
  
  // DIAGNOSTIC: Verify serialized keys for router
  if (programId === routerProgramId) {
    console.log('[serializeInstruction] Router serialized keys:', {
      serializedKeysLength: serializedKeys.length,
      serializedKey0: serializedKeys[0],
      serializedKey1: serializedKeys[1],
      serializedKey2: serializedKeys[2],
    });
  }
  
  return {
    programId,
    keys: serializedKeys,
    data: Buffer.from(dataBuf).toString('base64'),
  };
}

export async function buildTransactionSummary(plan: ExecutionPlan, extraSetupIxs: SerializedInstruction[] | undefined, computeBudget?: { computeUnitLimit?: number; computeUnitPriceMicroLamports?: number; useRouter?: boolean; routerExecutionMode?: 'direct' | 'flash_loan' | 'auto' | 'sdk_quote' }, traceId?: string): Promise<ArbBuildResult> {
  const additionalIxs = Array.isArray(extraSetupIxs) ? extraSetupIxs : [];
  const extras = additionalIxs.map((ix) => ({
    programId: ix.programId,
    keys: ix.keys.map((k) => ({ pubkey: new PublicKey(k.pubkey), isSigner: k.isSigner, isWritable: k.isWritable })),
    data: Buffer.from(ix.data, 'base64'),
  }));

  // Pass traceId (from executor or plan) to builder for log correlation
  const effectiveTraceId = traceId || plan.traceId;
  const built = await buildDirectArbTx(plan, extras, computeBudget as any, effectiveTraceId);
  
  // DIAGNOSTIC: Log raw instruction keys before serialization
  const rawInstructions = Array.isArray((built as any)?.tx?.instructions) ? (built as any).tx.instructions : [];
  const routerProgramId = '2Jgxnj7GGgR1EpwsfNKQhcFhmxAAhDoHmaiaDt2z9Fnw';
  for (let i = 0; i < rawInstructions.length; i++) {
    const ix = rawInstructions[i];
    if (ix?.programId?.toBase58?.() === routerProgramId) {
      console.log('[buildTransactionSummary] BEFORE serialization - router ix keys:', {
        ixIndex: i,
        keyCount: ix?.keys?.length || 0,
        key0: ix?.keys?.[0]?.pubkey?.toBase58?.() || 'unknown',
        key0_isSigner: ix?.keys?.[0]?.isSigner,
        key0_isWritable: ix?.keys?.[0]?.isWritable,
        key1: ix?.keys?.[1]?.pubkey?.toBase58?.() || 'unknown',
        key1_isSigner: ix?.keys?.[1]?.isSigner,
        key2: ix?.keys?.[2]?.pubkey?.toBase58?.() || 'unknown',
      });
    }
  }
  
  const instructions = rawInstructions.map(serializeInstruction);
  
  // DIAGNOSTIC: Log serialized instruction keys after serialization
  for (let i = 0; i < instructions.length; i++) {
    const ix = instructions[i];
    if (ix?.programId === routerProgramId) {
      console.log('[buildTransactionSummary] AFTER serialization - router ix keys:', {
        ixIndex: i,
        keyCount: ix?.keys?.length || 0,
        key0: ix?.keys?.[0]?.pubkey || 'unknown',
        key0_isSigner: ix?.keys?.[0]?.isSigner,
        key0_isWritable: ix?.keys?.[0]?.isWritable,
        key1: ix?.keys?.[1]?.pubkey || 'unknown',
        key1_isSigner: ix?.keys?.[1]?.isSigner,
        key2: ix?.keys?.[2]?.pubkey || 'unknown',
      });
    }
  }
  
  const lookupTableAddresses = Array.isArray((built as any)?.tx?.lookupTableAddresses) 
    ? (built as any).tx.lookupTableAddresses 
    : undefined;
  return {
    instructions,
    ixCount: built.ixCount,
    sizeBytes: built.sizeBytes,
    lookupTableAddresses,
  };
}


