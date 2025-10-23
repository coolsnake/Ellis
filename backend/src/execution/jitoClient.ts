// @ts-nocheck
import { logger } from '../utils/logger.js';
import { CONFIG } from '../utils/config.js';

export async function sendToBlockEngine(base64Tx: string, opts?: { beUrl?: string; timeoutMs?: number }): Promise<string> {
  const primary = String(opts?.beUrl || (CONFIG as any)?.jito?.blockEngineUrl || 'https://mainnet.block-engine.jito.wtf');
  const regions = [
    'https://amsterdam.mainnet.block-engine.jito.wtf',
    'https://dublin.mainnet.block-engine.jito.wtf',
    'https://frankfurt.mainnet.block-engine.jito.wtf',
  ];
  const beList = [primary, ...regions.filter(u => u !== primary)];
  const timeoutMs = Math.max(500, Number(opts?.timeoutMs ?? (CONFIG as any)?.jito?.bundleTimeoutMs ?? 1200));

  const sendOnce = async (url: string): Promise<string> => {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort('timeout'), timeoutMs);
    try {
      const r = await fetch(`${url}/api/v1/transactions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ transaction: base64Tx }),
        signal: ac.signal,
      });
      if (!r.ok) {
        const txt = await r.text().catch(() => '');
        throw new Error(`BE_${r.status}: ${txt.slice(0, 200)}`);
      }
      const out = await r.json().catch(() => ({}));
      const sig = String(out?.signature || out?.result || '');
      if (!sig) throw new Error('BE_NO_SIG');
      try { logger.info('tx.jito.sent', { cat: 'tx', url }); } catch {}
      return sig;
    } finally {
      clearTimeout(t);
    }
  };

  // Fire to all regions in parallel; return first success
  const attempts = beList.map((u) => sendOnce(u).catch((e: any) => { try { logger.warn('tx.jito.fail', { cat: 'tx', url: u, err: String(e?.message || e) }); } catch {}; throw e; }));
  return await Promise.any(attempts);
}


