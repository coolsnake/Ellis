import { Connection, PublicKey, TransactionInstruction, AddressLookupTableAccount, TransactionMessage, VersionedTransaction, ComputeBudgetProgram } from '@solana/web3.js';
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
  logger.info(`api.request GET ${url.pathname}`, { url: url.toString(), cat: 'api' });
  const res = await fetch(url.toString(), { headers: { accept: 'application/json' } });
  const dur = Date.now() - started;
  logger.info(`api.response GET ${url.pathname} ${res.status} ${dur}ms`, { status: res.status, durationMs: dur, url: url.toString(), cat: 'api' });
  if (!res.ok) throw new Error(`v6 quote failed ${res.status}`);
  return await res.json();
}

export async function getSwapInstructions(quoteResponse: any, userPublicKey: string, wrapAndUnwrapSol: boolean = true) {
  const url = 'https://quote-api.jup.ag/v6/swap-instructions';
  const started = Date.now();
  logger.info(`api.request POST /v6/swap-instructions`, { url, cat: 'api' });
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
  logger.info(`api.response POST /v6/swap-instructions ${res.status} ${dur}ms`, { status: res.status, durationMs: dur, url, cat: 'api' });
  if (!res.ok) throw new Error(`v6 swap-instructions failed ${res.status}`);
  return await res.json();
}

function decodeInstruction(ix: any): TransactionInstruction | null {
  const programId = new PublicKey(ix.programId);
  const keyList = (ix.keys || ix.accounts || []) as any[];
  const keys = keyList.map((k: any) => ({ pubkey: new PublicKey(k.pubkey), isSigner: !!k.isSigner, isWritable: !!k.isWritable }));
  return new TransactionInstruction({ programId, keys, data: Buffer.from(ix.data, 'base64') });
}

export async function buildCombinedTransaction(
  connection: Connection,
  payer: PublicKey,
  legs: Array<{ instructions: any }>,
  computeUnitPriceMicroLamports?: number,
  extraSetupIxs: TransactionInstruction[] = []
): Promise<VersionedTransaction> {
  const allIxs: TransactionInstruction[] = [];
  const altAddresses = new Set<string>();
  // Optional: compute budget first
  if (computeUnitPriceMicroLamports && computeUnitPriceMicroLamports > 0) {
    allIxs.push(ComputeBudgetProgram.setComputeUnitLimit({ units: 800000 }));
    allIxs.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: computeUnitPriceMicroLamports }));
  }
  // Proactive setup (e.g., ATAs)
  for (const ix of extraSetupIxs) allIxs.push(ix);
  for (const leg of legs) {
    const obj = leg.instructions;
    // setup
    for (const s of (obj.setupInstructions || [])) { const ix = decodeInstruction(s); if (ix) allIxs.push(ix); }
    // swap
    if (obj.swapInstruction) { const ix = decodeInstruction(obj.swapInstruction); if (ix) allIxs.push(ix); }
    // cleanup
    for (const c of (obj.cleanupInstructions || [])) { const ix = decodeInstruction(c); if (ix) allIxs.push(ix); }
    for (const addr of (obj.addressLookupTableAddresses || [])) altAddresses.add(String(addr));
  }
  const alts: AddressLookupTableAccount[] = [];
  for (const addr of altAddresses) {
    const { value } = await connection.getAddressLookupTable(new PublicKey(addr));
    if (value) alts.push(value);
  }
  const { blockhash } = await connection.getLatestBlockhash('finalized');
  const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: allIxs }).compileToV0Message(alts);
  return new VersionedTransaction(msg);
}


