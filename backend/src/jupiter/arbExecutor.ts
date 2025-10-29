import { getConnection, ensureWallet, signAndSendSerializedTransaction } from '../wallet/wallet.js';
import { resolveMint } from '../utils/tokens.js';
import { getV6Quote, getSwapInstructions, buildCombinedTransaction } from './v6.js';
import { CONFIG } from '../utils/config.js';

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

  const sol = (await resolveMint('SOL')).mint;
  const usdc = (await resolveMint('USDC')).mint;
  const amtLamports = Math.round(sizeSol * 1e9);

  const q1 = await getV6Quote(sol, usdc, amtLamports, slippageBps, { onlyDirectRoutes: true, includeDexes: [] });
  const i1 = await getSwapInstructions(q1, kp.publicKey.toBase58(), (CONFIG as any)?.system?.wrapAndUnwrapSol !== false);

  const amtUsdc = Math.max(0, Math.floor(Number(q1?.outAmount || 0)));
  const q2 = await getV6Quote(usdc, sol, amtUsdc, slippageBps, { onlyDirectRoutes: true, includeDexes: [] });
  const i2 = await getSwapInstructions(q2, kp.publicKey.toBase58(), (CONFIG as any)?.system?.wrapAndUnwrapSol !== false);

  const tx = await buildCombinedTransaction(
    conn,
    kp.publicKey,
    [{ instructions: i1 }, { instructions: i2 }],
    (CONFIG.fees?.jupiterPriorityFee as any) || undefined,
    []
  );
  const wire = Buffer.from(tx.serialize()).toString('base64');
  const signature = await signAndSendSerializedTransaction(wire, kp, undefined, 'swap');
  return { signature };
}

export async function executePlanWithJupiterStrict(args: ExecuteArgs): Promise<{ signature: string }> {
  const conn = getConnection();
  const kp = await ensureWallet(CONFIG.walletPath);
  const slippageBps = Math.max(1, Number(args.slippageBps ?? (CONFIG.fees?.jupiterSlippageBps ?? 50)));
  const plan = args.plan;
  if (!Array.isArray(plan?.path) || plan.path.length < 2) throw new Error('invalid_plan');

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
    const q = await getV6Quote(inputMint, outputMint, curIn, slippageBps, { onlyDirectRoutes: true, includeDexes });
    if (args.strictMinOut && strictMinOuts && Number.isFinite(strictMinOuts[i] as any)) {
      const t = Math.max(0, Math.floor(Number(strictMinOuts[i])));
      try { (q as any).otherAmountThreshold = String(t); } catch {}
    }
    const instr = await getSwapInstructions(q, kp.publicKey.toBase58(), (CONFIG as any)?.system?.wrapAndUnwrapSol !== false);
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
  const signature = await signAndSendSerializedTransaction(wire, kp, undefined, 'swap');
  return { signature };
}


