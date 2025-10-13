import { logger } from '../utils/logger.js';

export type V6Quote = any;

export async function getV6Quote(inputMint: string, outputMint: string, amount: number, slippageBps: number): Promise<V6Quote> {
  const url = new URL('https://quote-api.jup.ag/v6/quote');
  url.searchParams.set('inputMint', inputMint);
  url.searchParams.set('outputMint', outputMint);
  url.searchParams.set('amount', String(amount));
  url.searchParams.set('slippageBps', String(slippageBps));
  url.searchParams.set('restrictIntermediateTokens', 'true');
  const started = Date.now();
  logger.debug(`api.request GET ${url.pathname}`, { url: url.toString(), cat: 'api' });
  const res = await fetch(url.toString(), { headers: { accept: 'application/json' } });
  const dur = Date.now() - started;
  logger.debug(`api.response GET ${url.pathname} ${res.status} ${dur}ms`, { status: res.status, durationMs: dur, url: url.toString(), cat: 'api' });
  if (res.status === 429) {
    try { const { emit } = await import('../server/realtime.js'); emit('log', { level: 'warn', message: `arb:429 source=jupiter kind=v6_quote in=${inputMint} out=${outputMint}`, timestamp: new Date().toISOString(), context: { cat: 'arb' } }); } catch {}
    logger.warn('jup.v6.quote 429', { in: inputMint, out: outputMint });
    throw new Error('429');
  }
  if (!res.ok) throw new Error(`v6 quote failed ${res.status}`);
  return await res.json();
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
  const { blockhash } = await connection.getLatestBlockhash('finalized');
  const msg = new web3.TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: allIxs }).compileToV0Message(alts);
  return new web3.VersionedTransaction(msg);
}


