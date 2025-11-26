// @ts-nocheck
import { logger } from '../utils/logger.js';
import { CONFIG } from '../utils/config.js';
import bs58 from 'bs58';

export async function sendToBlockEngine(base64Tx: string, opts?: { beUrl?: string; timeoutMs?: number }): Promise<string> {
  const primary = String(opts?.beUrl || (CONFIG as any)?.jito?.blockEngineUrl || 'https://mainnet.block-engine.jito.wtf');
  const regions = [
    'https://amsterdam.mainnet.block-engine.jito.wtf',
    'https://dublin.mainnet.block-engine.jito.wtf',
    'https://frankfurt.mainnet.block-engine.jito.wtf',
  ];
  const beList = [primary, ...regions.filter(u => u !== primary)];
  const timeoutMs = Math.max(500, Number(opts?.timeoutMs ?? (CONFIG as any)?.jito?.sendTimeoutMs ?? 2000));

  // Convert base64 to base58 (Jito expects base58-encoded transactions)
  const txBytes = Buffer.from(base64Tx, 'base64');
  const base58Tx = bs58.encode(txBytes);

  const sendOnce = async (url: string): Promise<string> => {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort('timeout'), timeoutMs);
    try {
      // Jito block engine expects JSON-RPC 2.0 format for sendTransaction
      const jsonRpcBody = {
        jsonrpc: '2.0',
        id: Date.now(),
        method: 'sendTransaction',
        params: [base58Tx, { encoding: 'base58' }],
      };
      
      const r = await fetch(`${url}/api/v1/transactions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(jsonRpcBody),
        signal: ac.signal,
      });
      if (!r.ok) {
        const txt = await r.text().catch(() => '');
        throw new Error(`BE_${r.status}: ${txt.slice(0, 200)}`);
      }
      const out = await r.json().catch(() => ({}));
      // JSON-RPC response has result field (signature), or error field
      if (out?.error) {
        throw new Error(`BE_RPC_ERR: ${JSON.stringify(out.error).slice(0, 150)}`);
      }
      const sig = String(out?.result || '');
      if (!sig) throw new Error('BE_NO_SIG');
      try { logger.info('tx.jito.sent', { cat: 'tx', url, signature: sig.slice(0, 16) }); } catch {}
      return sig;
    } finally {
      clearTimeout(t);
    }
  };

  // Fire to all regions in parallel; return first success
  const attempts = beList.map((u) => sendOnce(u).catch((e: any) => { try { logger.warn('tx.jito.fail', { cat: 'tx', url: u, err: String(e?.message || e) }); } catch {}; throw e; }));
  return await Promise.any(attempts);
}


