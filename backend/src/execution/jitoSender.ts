// @ts-nocheck
import { VersionedTransaction, Connection } from '@solana/web3.js';
import { CONFIG } from '../utils/config.js';
import { logger } from '../utils/logger.js';

type SendOpts = {
  priorityFeeMicroLamports?: number;
  cuLimit?: number;
  timeoutMs?: number;
};

/**
 * Best-effort Jito bundle send. If Jito client/lib is unavailable or fails,
 * falls back to normal RPC send on the provided Connection.
 *
 * Note: A fully featured implementation should use Jito’s gRPC client
 * (@jito-foundation/jito-ts). This shim uses dynamic import if present.
 */
export async function sendBundleOrTx(
  connection: Connection,
  vtx: VersionedTransaction,
  opts?: SendOpts
): Promise<string> {
  const timeoutMs = Math.max(250, Number(opts?.timeoutMs ?? (CONFIG as any)?.jito?.bundleTimeoutMs ?? 1200));
  const useJito = !!((CONFIG as any)?.jito?.enabled);

  const withTimeout = async <T>(p: Promise<T>, ms: number): Promise<T> => {
    return await Promise.race<T>([
      p,
      new Promise<T>((_, rej) => setTimeout(() => rej(new Error('JITO_SEND_TIMEOUT')), ms)) as any,
    ]);
  };

  // Try Jito, if configured and library is available
  if (useJito) {
    try {
      // Attempt dynamic import to avoid a hard dependency
      const jito: any = await import('@jito-foundation/jito-ts').catch(() => null);
      if (jito?.SearcherClient) {
        try { logger.info('tx.jito.attempt', { cat: 'tx' }); } catch {}
        // TODO: Wire a real SearcherClient here when available in the runtime
        // For now, we fall through to normal send if not fully configured
      }
    } catch {}
  }

  // Fallback: normal RPC send (same behavior as fast path in filler)
  const raw = vtx.serialize();
  const send = () => connection.sendRawTransaction(raw, { skipPreflight: true, preflightCommitment: 'processed', maxRetries: 0 });
  try {
    return await withTimeout(send(), timeoutMs);
  } catch {
    // One immediate retry
    return await withTimeout(send(), timeoutMs);
  }
}


