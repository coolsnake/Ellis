export type SendResult = { signature?: string; ok: boolean; err?: string };

export async function sendWithRetry(wireTxBase64: string, rpcUrl: string, opts?: { maxMs?: number }): Promise<SendResult> {
  const maxMs = Math.max(1000, Number(opts?.maxMs || 90_000));
  const start = Date.now();
  let attempt = 0;
  while (Date.now() - start < maxMs) {
    attempt += 1;
    try {
      // eslint-disable-next-line no-undef
      const resp = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method: 'sendTransaction', params: [wireTxBase64, { skipPreflight: true, maxRetries: 0, encoding: 'base64' }], jsonrpc: '2.0', id: `arb-${start}-${attempt}` }) });
      const json = await resp.json().catch(() => ({}));
      const sig = json?.result as string | undefined;
      if (sig) return { ok: true, signature: sig };
      const errStr = String(json?.error?.message || 'unknown');
      // Backoff taxonomy
      if (/BlockhashNotFound|TransactionExpired/i.test(errStr)) {
        await new Promise(r => setTimeout(r, 1200));
      } else if (/AccountInUse|Node is behind/i.test(errStr)) {
        await new Promise(r => setTimeout(r, 250));
      } else if (/ComputeBudgetExceeded|ExceedsMaxInstructions/i.test(errStr)) {
        return { ok: false, err: errStr };
      } else {
        await new Promise(r => setTimeout(r, 500));
      }
    } catch (e: any) {
      const msg = String(e?.message || e);
      if (/aborted|timeout/i.test(msg)) await new Promise(r => setTimeout(r, 500)); else await new Promise(r => setTimeout(r, 250));
    }
  }
  return { ok: false, err: 'timeout' };
}
