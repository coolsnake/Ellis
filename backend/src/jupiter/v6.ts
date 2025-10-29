import { logger } from '../utils/logger.js';
import { jupiterLimiter, onApiResult } from './rateLimiter.js';

export type V6Quote = any;

export async function getV6Quote(
  inputMint: string,
  outputMint: string,
  amount: number,
  slippageBps: number,
  opts?: { onlyDirectRoutes?: boolean; includeDexes?: string[]; excludeDexes?: string[] }
): Promise<V6Quote> {
  const url = new URL('https://quote-api.jup.ag/v6/quote');
  url.searchParams.set('inputMint', inputMint);
  url.searchParams.set('outputMint', outputMint);
  url.searchParams.set('amount', String(amount));
  url.searchParams.set('slippageBps', String(slippageBps));
  url.searchParams.set('restrictIntermediateTokens', 'true');
  if (opts?.onlyDirectRoutes) url.searchParams.set('onlyDirectRoutes', 'true');
  if (opts?.includeDexes && opts.includeDexes.length) url.searchParams.set('includeDexes', opts.includeDexes.join(','));
  if (opts?.excludeDexes && opts.excludeDexes.length) url.searchParams.set('excludeDexes', opts.excludeDexes.join(','));
  const attempt = async (i: number) => {
    await jupiterLimiter.acquire(false);
    const started = Date.now();
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort('timeout'), 7000);
    try {
      logger.debug(`api.request GET ${url.pathname}`, { url: url.toString(), cat: 'api' });
      const res = await fetch(url.toString(), { headers: { accept: 'application/json' }, signal: ac.signal as any });
      const dur = Date.now() - started;
      try { onApiResult(res.status ?? 0, dur); } catch {}
      logger.debug(`api.response GET ${url.pathname} ${res.status} ${dur}ms`, { status: res.status, durationMs: dur, url: url.toString(), cat: 'api' });
      if (res.status === 429) {
        try { const { emit } = await import('../server/realtime.js'); emit('log', { level: 'warn', message: `arb:429 source=jupiter kind=v6_quote in=${inputMint} out=${outputMint}`, timestamp: new Date().toISOString(), context: { cat: 'arb' } }); } catch {}
        throw new Error('429');
      }
      if (!res.ok) throw new Error(`v6 quote failed ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(t);
    }
  };
  let lastErr: any;
  for (let i = 0; i < 3; i += 1) {
    try { return await attempt(i); }
    catch (e: any) {
      lastErr = e;
      const msg = String(e?.message || e);
      if (msg.includes('429')) { await new Promise(r => setTimeout(r, 400 * (i + 1))); continue; }
      if (msg.includes('timeout') || msg.includes('fetch failed')) { await new Promise(r => setTimeout(r, 500 * (i + 1))); continue; }
      break;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export async function getSwapInstructions(quoteResponse: any, userPublicKey: string, wrapAndUnwrapSol: boolean = true) {
  const url = 'https://quote-api.jup.ag/v6/swap-instructions';
  const started = Date.now();
  logger.debug(`api.request POST /v6/swap-instructions`, { url, cat: 'api' });
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quoteResponse,
      userPublicKey,
      wrapAndUnwrapSol,
      createAndCloseWrappedSolAccount: true,
      // Ensure ATAs are created idempotently for all required mints
      asLegacyTransaction: true,
      useSharedAccounts: true,
    })
  });
  const dur = Date.now() - started;
  logger.debug(`api.response POST /v6/swap-instructions ${res.status} ${dur}ms`, { status: res.status, durationMs: dur, url, cat: 'api' });
  if (res.status === 429) {
    try { const { emit } = await import('../server/realtime.js'); emit('log', { level: 'warn', message: 'arb:429 source=jupiter kind=v6_swap_instructions', timestamp: new Date().toISOString(), context: { cat: 'arb' } }); } catch {}
    logger.warn('jup.v6.swap_instructions 429');
    throw new Error('429');
  }
  if (!res.ok) throw new Error(`v6 swap-instructions failed ${res.status}`);
  return await res.json();
}

export async function buildCombinedTransaction(
  connection: any,
  payer: any,
  legs: Array<{ instructions: any }>,
  computeUnitPriceMicroLamports?: number,
  extraSetupIxs: any[] = []
): Promise<any> {
  const modName = '@solana/web3.js';
  const web3: any = await import(modName);
  const allIxs: any[] = [];
  const altAddresses = new Set<string>();
  // Optional: compute budget first
  if (computeUnitPriceMicroLamports && computeUnitPriceMicroLamports > 0) {
    allIxs.push(web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 800000 }));
    allIxs.push(web3.ComputeBudgetProgram.setComputeUnitPrice({ microLamports: computeUnitPriceMicroLamports }));
  }
  // Proactive setup (e.g., ATAs)
  for (const ix of extraSetupIxs) allIxs.push(ix);
  const toIx = (ix: any): any | null => {
    try {
      const programId = new web3.PublicKey(ix.programId);
      const keyList = (ix.keys || ix.accounts || []) as any[];
      const keys = keyList.map((k: any) => ({ pubkey: new web3.PublicKey(k.pubkey), isSigner: !!k.isSigner, isWritable: !!k.isWritable }));
      const data: any = ((globalThis as any).Buffer?.from(ix.data, 'base64')) || new Uint8Array();
      return new web3.TransactionInstruction({ programId, keys, data });
    } catch {
      return null;
    }
  };
  for (const leg of legs) {
    const obj = leg.instructions;
    // setup
    for (const s of (obj.setupInstructions || [])) { const ix = toIx(s); if (ix) allIxs.push(ix); }
    // swap
    if (obj.swapInstruction) { const ix = toIx(obj.swapInstruction); if (ix) allIxs.push(ix); }
    // cleanup
    for (const c of (obj.cleanupInstructions || [])) { const ix = toIx(c); if (ix) allIxs.push(ix); }
    for (const addr of (obj.addressLookupTableAddresses || [])) altAddresses.add(String(addr));
  }
  const alts: any[] = [];
  for (const addr of altAddresses) {
    const { value } = await connection.getAddressLookupTable(new web3.PublicKey(addr));
    if (value) alts.push(value);
  }
  const { withRpcLimit } = await import('../utils/rpcLimiter.js');
  const bh: any = await withRpcLimit(() => connection.getLatestBlockhash('finalized'));
  const blockhash = (bh as any)?.blockhash as string;
  const msg = new web3.TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: allIxs }).compileToV0Message(alts);
  return new web3.VersionedTransaction(msg);
}


