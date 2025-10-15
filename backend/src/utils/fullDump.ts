import { dirname, resolve } from 'path';
import { mkdir, writeFile } from 'fs/promises';
import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import { CONFIG } from './config.js';

type DumpKind = 'raydium' | 'orca' | 'meteora';

function toPkString(v: any): string {
  try {
    if (!v) return '';
    if (v instanceof PublicKey) return v.toBase58();
    if (typeof v?.toBase58 === 'function') return String(v.toBase58());
    if (typeof v === 'string') return v;
    return String(v);
  } catch {
    return '';
  }
}

function coerceIx(ix: any): { programId: string; keys: Array<{ pubkey: string; isSigner: boolean; isWritable: boolean }>; dataLen: number } {
  try {
    if (ix instanceof TransactionInstruction) {
      return {
        programId: toPkString(ix.programId),
        keys: (ix.keys || []).map(k => ({ pubkey: toPkString((k as any)?.pubkey), isSigner: !!(k as any)?.isSigner, isWritable: !!(k as any)?.isWritable })),
        dataLen: (ix.data && (ix.data as any).length) ? Number((ix.data as any).length) : 0,
      };
    }
    const programId = toPkString((ix as any)?.programId);
    const keysLike: any = (ix as any)?.keys;
    const keyArr: any[] = Array.isArray(keysLike) ? keysLike : (keysLike && typeof keysLike.length === 'number' ? Array.from(keysLike) : []);
    const keys = keyArr.map(k => ({ pubkey: toPkString((k as any)?.pubkey ?? (k as any)?.pubKey ?? (k as any)?.address), isSigner: !!(k as any)?.isSigner, isWritable: !!(k as any)?.isWritable }));
    const raw = (ix as any)?.data;
    const dataLen = Buffer.isBuffer(raw) ? raw.length : (raw && typeof raw === 'object' && typeof (raw as any).length === 'number') ? Number((raw as any).length) : (typeof raw === 'string' ? Buffer.byteLength(raw, 'base64') : 0);
    return { programId, keys, dataLen };
  } catch {
    return { programId: '', keys: [], dataLen: 0 };
  }
}

export async function writeFullDump(kind: DumpKind, payload: Record<string, any>): Promise<void> {
  const file = resolve(CONFIG.logDir, `tx-full-${kind}.json`);
  const dir = dirname(file);
  try { await mkdir(dir, { recursive: true }); } catch {}
  const now = new Date();
  const base: any = {
    _kind: kind,
    _ts: now.toISOString(),
  };
  const toDump = { ...base, ...payload };
  const json = JSON.stringify(toDump, (_k, v) => {
    try {
      // PublicKey to base58
      if (v instanceof PublicKey) return v.toBase58();
      if (v && typeof v === 'object' && typeof v.toBase58 === 'function') return v.toBase58();
      // TransactionInstruction -> concise form
      if (v instanceof TransactionInstruction) return coerceIx(v);
      // Buffer -> summarized
      if (typeof Buffer !== 'undefined' && Buffer.isBuffer(v)) return `buffer:${v.length}`;
    } catch {}
    return v;
  }, 2);
  // Overwrite older logs on save
  await writeFile(file, json + '\n', { encoding: 'utf8', flag: 'w' });
}

export function mapIxsForDump(ixs: any[]): Array<{ programId: string; keys: Array<{ pubkey: string; isSigner: boolean; isWritable: boolean }>; dataLen: number }> {
  try { return (ixs || []).map(coerceIx); } catch { return []; }
}


