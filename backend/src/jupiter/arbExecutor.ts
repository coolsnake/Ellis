import { getConnection, ensureWallet, signAndSendSerializedTransaction } from '../wallet/wallet.js';
import { resolveMint } from '../utils/tokens.js';
import { getV6Quote, getSwapInstructions, buildCombinedTransaction } from './v6.js';
import { CONFIG } from '../utils/config.js';
import { logger } from '../utils/logger.js';

type PlanLike = { path: string[] };
type ExecuteArgs = {
  plan: PlanLike;
  sizeAtoms?: number;
  sizeUsd?: number;
  slippageBps?: number;
  hopDexes?: string[];
  hopRatesUi?: number[];
  hopMinOutsAtoms?: number[];
  strictMinOut?: boolean;
};

function mapDexToJupIncludes(label: string): string[] {
  const v = String(label || '').toLowerCase();
  if (v.includes('orca')) return ['Orca'];
  if (v.includes('meteora')) return ['MeteoraDLMM'];
  if (v.includes('ray')) return ['Raydium', 'RaydiumCLMM'];
  return [];
}

async function deriveSizeAtomsFromUsd(path: string[], sizeUsd: number): Promise<number> {
  const { getPriceByMint } = await import('../server/priceStore.js');
  const dec0 = (await resolveMint(path[0])).decimals ?? 6;
  const px = Number(getPriceByMint(path[0])?.usdc ?? 0);
  if (px <= 0) return 0;
  return Math.floor((sizeUsd / px) * Math.pow(10, dec0));
}

async function computeHopMinOutsFromRates(plan: PlanLike, sizeAtoms: number, hopRatesUi: number[]): Promise<number[]> {
  const out: number[] = [];
  const dec0 = (await resolveMint(plan.path[0])).decimals ?? 6;
  let curUi = sizeAtoms / Math.pow(10, dec0);
  for (let i = 0; i < plan.path.length - 1; i += 1) {
    const rate = Number(hopRatesUi[i] ?? 0);
    const outUi = rate > 0 ? curUi * rate : curUi;
    const dec = (await resolveMint(plan.path[i + 1])).decimals ?? 6;
    const outAtoms = Math.max(0, Math.floor(outUi * Math.pow(10, dec)));
    out.push(outAtoms);
    curUi = outUi;
  }
  return out;
}

export async function executeRoundtripWithJupiter(params: { sizeSol?: number; slippageBps?: number }): Promise<{ signature: string }> {
  const sizeSol = Math.max(0, Number(params.sizeSol ?? 0.01));
  const slippageBps = Math.max(1, Number(params.slippageBps ?? (CONFIG.fees?.jupiterSlippageBps ?? 50)));
  const conn = getConnection();
  const kp = await ensureWallet(CONFIG.walletPath);
  try { logger.info('jupiter.trade.roundtrip.start', { cat: 'jupiter', sizeSol, slippageBps }); } catch {}

  const sol = (await resolveMint('SOL')).mint;
  const usdc = (await resolveMint('USDC')).mint;
  const amtLamports = Math.round(sizeSol * 1e9);

  const q1 = await getV6Quote(sol, usdc, amtLamports, slippageBps, { onlyDirectRoutes: true, includeDexes: [] });
  try {
    const out1 = Number(q1?.outAmount || 0);
    logger.info('jupiter.trade.roundtrip.leg1.quote', { cat: 'jupiter', inMint: sol, outMint: usdc, inAmount: amtLamports, outAmount: out1, routePlanLen: Array.isArray(q1?.routePlan) ? q1.routePlan.length : 0 });
  } catch {}
  const i1 = await getSwapInstructions(q1, kp.publicKey.toBase58(), (CONFIG as any)?.system?.wrapAndUnwrapSol !== false);

  const amtUsdc = Math.max(0, Math.floor(Number(q1?.outAmount || 0)));
  const q2 = await getV6Quote(usdc, sol, amtUsdc, slippageBps, { onlyDirectRoutes: true, includeDexes: [] });
  try {
    const out2 = Number(q2?.outAmount || 0);
    logger.info('jupiter.trade.roundtrip.leg2.quote', { cat: 'jupiter', inMint: usdc, outMint: sol, inAmount: amtUsdc, outAmount: out2, routePlanLen: Array.isArray(q2?.routePlan) ? q2.routePlan.length : 0 });
  } catch {}
  const i2 = await getSwapInstructions(q2, kp.publicKey.toBase58(), (CONFIG as any)?.system?.wrapAndUnwrapSol !== false);

  const ixCount = ((i1?.setupInstructions?.length || 0) + (i1?.swapInstruction ? 1 : 0) + (i1?.cleanupInstructions?.length || 0))
    + ((i2?.setupInstructions?.length || 0) + (i2?.swapInstruction ? 1 : 0) + (i2?.cleanupInstructions?.length || 0));

  const tx = await buildCombinedTransaction(
    conn,
    kp.publicKey,
    [{ instructions: i1 }, { instructions: i2 }],
    (CONFIG.fees?.jupiterPriorityFee as any) || undefined,
    []
  );
  const wire = Buffer.from(tx.serialize()).toString('base64');
  try { logger.info('jupiter.trade.roundtrip.tx.built', { cat: 'jupiter', ixCount }); } catch {}
  const signature = await (async () => {
    try {
      const sig = await signAndSendSerializedTransaction(wire, kp, undefined, 'swap');
      try { logger.info('jupiter.trade.roundtrip.send.ok', { cat: 'jupiter', signature: sig }); } catch {}
      return sig;
    } catch (e: any) {
      try { logger.info('jupiter.trade.roundtrip.send.err', { cat: 'jupiter', error: String(e?.message || e) }); } catch {}
      throw e;
    }
  })();
  return { signature };
}

export async function executePlanWithJupiterStrict(args: ExecuteArgs): Promise<{ signature: string }> {
  const conn = getConnection();
  const kp = await ensureWallet(CONFIG.walletPath);
  const slippageBps = Math.max(1, Number(args.slippageBps ?? (CONFIG.fees?.jupiterSlippageBps ?? 50)));
  const plan = args.plan;
  if (!Array.isArray(plan?.path) || plan.path.length < 2) throw new Error('invalid_plan');
  try {
    logger.info('jupiter.trade.strict.start', {
      cat: 'jupiter',
      pathLen: plan.path.length,
      sizeAtoms: Number(args.sizeAtoms || 0),
      sizeUsd: Number(args.sizeUsd || 0),
      slippageBps,
      strictMinOut: args.strictMinOut !== false,
      hopDexes: Array.isArray(args.hopDexes) ? args.hopDexes : undefined,
    });
  } catch {}

  let sizeAtoms = Math.max(0, Math.floor(Number(args.sizeAtoms || 0)));
  if (!sizeAtoms && args.sizeUsd && args.sizeUsd > 0) sizeAtoms = await deriveSizeAtomsFromUsd(plan.path, args.sizeUsd);
  if (!sizeAtoms) throw new Error('missing_input_amount');

  let strictMinOuts: number[] | undefined;
  if (args.strictMinOut) {
    if (Array.isArray(args.hopMinOutsAtoms) && args.hopMinOutsAtoms.length === plan.path.length - 1) {
      strictMinOuts = args.hopMinOutsAtoms.slice();
    } else if (Array.isArray(args.hopRatesUi) && args.hopRatesUi.length >= (plan.path.length - 1)) {
      strictMinOuts = await computeHopMinOutsFromRates(plan, sizeAtoms, args.hopRatesUi);
    }
    if (strictMinOuts) {
      const marginBps = Math.max(0, Math.min(200, Math.floor(slippageBps)));
      strictMinOuts = strictMinOuts.map((v) => Math.max(0, Math.floor(v * (1 - marginBps / 10_000))));
    }
  }

  const legs: any[] = [];
  let curIn = sizeAtoms;
  for (let i = 0; i < plan.path.length - 1; i += 1) {
    const inputMint = plan.path[i];
    const outputMint = plan.path[i + 1];
    const includeDexes = Array.isArray(args.hopDexes) ? mapDexToJupIncludes(args.hopDexes[i] || '') : [];
    try { logger.info('jupiter.trade.hop.start', { cat: 'jupiter', hop: i, inputMint, outputMint, inAmount: curIn, includeDexes }); } catch {}
    let q: any;
    try {
      q = await getV6Quote(inputMint, outputMint, curIn, slippageBps, { onlyDirectRoutes: true, includeDexes });
    } catch (e: any) {
      const msg = String(e?.message || e);
      if (msg === 'NO_DIRECT_ROUTE') {
        try { logger.info('jupiter.trade.hop.no_direct_route', { cat: 'jupiter', hop: i, inputMint, outputMint, includeDexes }); } catch {}
      } else {
        try { logger.info('jupiter.trade.hop.quote.err', { cat: 'jupiter', hop: i, error: msg }); } catch {}
      }
      throw e;
    }
    // DEX enforcement: strict only when v6 was used; warn-only when legacy lite was used
    try {
      if (includeDexes && includeDexes.length) {
        const plan = Array.isArray((q as any)?.routePlan) ? (q as any).routePlan : [];
        const labels: string[] = plan.map((p: any) => String(p?.swapInfo?.label || '').toLowerCase()).filter(Boolean);
        const allowed = includeDexes.map(s => String(s).toLowerCase());
        const matched = labels.length === 0 || labels.every(l => allowed.some(a => l.includes(a)));
        const src = String((q as any).__source || 'unknown');
        if (!matched) {
          if (src === 'v6') {
            try { logger.info('jupiter.trade.hop.dex_mismatch', { cat: 'jupiter', hop: i, labels, includeDexes, source: src }); } catch {}
            throw new Error('dex_mismatch');
          } else {
            try { logger.info('jupiter.trade.hop.dex_mismatch_legacy', { cat: 'jupiter', hop: i, labels, includeDexes, source: src }); } catch {}
          }
        }
      }
    } catch (e) { throw e; }
    try {
      const outAmt = Number(q?.outAmount || 0);
      logger.info('jupiter.trade.hop.quote', { cat: 'jupiter', hop: i, routePlanLen: Array.isArray(q?.routePlan) ? q.routePlan.length : 0, inAmount: curIn, outAmount: outAmt });
      if (args.strictMinOut) {
        const marginBps = Math.max(0, Math.min(Number(slippageBps), 200));
        const proposed = Math.max(0, Math.floor(outAmt * (1 - marginBps / 10_000)));
        const minOutRaw = Math.min(proposed, outAmt);
        try { (q as any).otherAmountThreshold = String(minOutRaw); } catch {}
        try { logger.info('jupiter.trade.hop.minout.set', { cat: 'jupiter', hop: i, outRaw: outAmt, minOutRaw, marginBps }); } catch {}
      }
    } catch {}
    const instr = await getSwapInstructions(q, kp.publicKey.toBase58(), (CONFIG as any)?.system?.wrapAndUnwrapSol !== false);
    try {
      const ixCount = (instr?.setupInstructions?.length || 0) + (instr?.cleanupInstructions?.length || 0) + (instr?.swapInstruction ? 1 : 0);
      logger.info('jupiter.trade.hop.instructions', { cat: 'jupiter', hop: i, ixCount });
    } catch {}
    legs.push({ instructions: instr });
    curIn = Math.max(0, Math.floor(Number(q?.outAmount || 0)));
  }

  const tx = await buildCombinedTransaction(
    conn,
    kp.publicKey,
    legs,
    (CONFIG.fees?.jupiterPriorityFee as any) || undefined,
    []
  );
  const wire = Buffer.from(tx.serialize()).toString('base64');
  try {
    const totalIxCount = legs.reduce((a, leg) => a + ((leg?.instructions?.setupInstructions?.length || 0) + (leg?.instructions?.cleanupInstructions?.length || 0) + (leg?.instructions?.swapInstruction ? 1 : 0)), 0);
    logger.info('jupiter.trade.tx.built', { cat: 'jupiter', legs: legs.length, ixCount: totalIxCount });
  } catch {}
  const signature = await (async () => {
    try {
      const sig = await signAndSendSerializedTransaction(wire, kp, undefined, 'swap');
      try { logger.info('jupiter.trade.send.ok', { cat: 'jupiter', signature: sig }); } catch {}
      return sig;
    } catch (e: any) {
      try { logger.info('jupiter.trade.send.err', { cat: 'jupiter', error: String(e?.message || e) }); } catch {}
      throw e;
    }
  })();
  return { signature };
}


export async function executeAggregateWithJupiter(args: {
  inputMint: string;
  outputMint: string;
  sizeAtoms?: number;
  sizeUsd?: number;
  slippageBps?: number;
  dexWhitelist?: string[];
  wrapAndUnwrapSol?: boolean;
}): Promise<{ signature: string }> {
  const conn = getConnection();
  const kp = await ensureWallet(CONFIG.walletPath);
  const slippageBps = Math.max(1, Number(args.slippageBps ?? (CONFIG.fees?.jupiterSlippageBps ?? 50)));

  // Determine input atoms
  let sizeAtoms = Math.max(0, Math.floor(Number(args.sizeAtoms || 0)));
  if (!sizeAtoms && args.sizeUsd && args.sizeUsd > 0) {
    const { getPriceByMint } = await import('../server/priceStore.js');
    const dec0 = (await resolveMint(args.inputMint)).decimals ?? 6;
    const px = Number(getPriceByMint(args.inputMint)?.usdc ?? 0);
    if (px > 0) sizeAtoms = Math.floor((args.sizeUsd / px) * Math.pow(10, dec0));
  }
  if (!sizeAtoms) throw new Error('missing_input_amount');

  // One end-to-end quote using lite (default), with optional dex whitelist and multi-pool allowed
  const quote = await getV6Quote(
    args.inputMint,
    args.outputMint,
    sizeAtoms,
    slippageBps,
    { includeDexes: (args.dexWhitelist || []).slice(), onlyDirectRoutes: false }
  );
  try {
    const outRaw = Number(quote?.outAmount || 0);
    const marginBps = Math.max(0, Math.min(slippageBps, 200));
    const minOutRaw = Math.min(outRaw, Math.floor(outRaw * (1 - marginBps / 10_000)));
    (quote as any).otherAmountThreshold = String(minOutRaw);
    try { logger.info('jupiter.trade.aggregate.minout.set', { cat: 'jupiter', outRaw, minOutRaw, marginBps }); } catch {}
  } catch {}

  const instr = await getSwapInstructions(
    quote,
    kp.publicKey.toBase58(),
    (CONFIG as any)?.system?.wrapAndUnwrapSol !== false
  );

  const tx = await buildCombinedTransaction(
    conn,
    kp.publicKey,
    [{ instructions: instr }],
    (CONFIG.fees?.jupiterPriorityFee as any) || undefined,
    []
  );
  const wire = Buffer.from(tx.serialize()).toString('base64');
  const signature = await signAndSendSerializedTransaction(wire, kp, undefined, 'swap');
  try { logger.info('jupiter.trade.aggregate.send.ok', { cat: 'jupiter', signature }); } catch {}
  return { signature };
}


