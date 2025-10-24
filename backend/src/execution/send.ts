import { logger } from '../utils/logger.js';
export type SendResult = { signature?: string; ok: boolean; err?: string };

export async function sendWithRetry(wireTxBase64: string, rpcUrl: string, opts?: { maxMs?: number }): Promise<SendResult> {
  const maxMs = Math.max(1000, Number(opts?.maxMs || 90_000));
  const start = Date.now();
  let attempt = 0;
  try { logger.info('tx.rpc.send.start', { cat: 'tx', url: rpcUrl, maxMs }); } catch {}
  while (Date.now() - start < maxMs) {
    attempt += 1;
    try {
      // eslint-disable-next-line no-undef
      const resp = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method: 'sendTransaction', params: [wireTxBase64, { skipPreflight: true, maxRetries: 0, encoding: 'base64' }], jsonrpc: '2.0', id: `arb-${start}-${attempt}` }) });
      const json = await resp.json().catch(() => ({}));
      const sig = json?.result as string | undefined;
      if (sig) { try { logger.info('tx.rpc.send.ok', { cat: 'tx', url: rpcUrl, attempt, ms: Date.now() - start }); } catch {}; return { ok: true, signature: sig }; }
      const errStr = String(json?.error?.message || 'unknown');
      // Backoff taxonomy
      if (/BlockhashNotFound|TransactionExpired/i.test(errStr)) {
        try { logger.info('tx.rpc.send.retry', { cat: 'tx', url: rpcUrl, attempt, err: errStr }); } catch {}
        await new Promise(r => setTimeout(r, 1200));
      } else if (/AccountInUse|Node is behind/i.test(errStr)) {
        try { logger.info('tx.rpc.send.retry', { cat: 'tx', url: rpcUrl, attempt, err: errStr }); } catch {}
        await new Promise(r => setTimeout(r, 250));
      } else if (/ComputeBudgetExceeded|ExceedsMaxInstructions/i.test(errStr)) {
        return { ok: false, err: errStr };
      } else {
        try { logger.info('tx.rpc.send.retry', { cat: 'tx', url: rpcUrl, attempt, err: errStr }); } catch {}
        await new Promise(r => setTimeout(r, 500));
      }
    } catch (e: any) {
      const msg = String(e?.message || e);
      try { logger.info('tx.rpc.send.retry', { cat: 'tx', url: rpcUrl, attempt, err: msg }); } catch {}
      if (/aborted|timeout/i.test(msg)) await new Promise(r => setTimeout(r, 500)); else await new Promise(r => setTimeout(r, 250));
    }
  }
  try { logger.info('tx.rpc.send.timeout', { cat: 'tx', url: rpcUrl, attempts: attempt, ms: Date.now() - start }); } catch {}
  return { ok: false, err: 'timeout' };
}
