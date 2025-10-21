// @ts-nocheck
import { SystemProgram, PublicKey } from '@solana/web3.js';
import { CONFIG } from '../utils/config.js';

export async function fetchTipFloorLamports(): Promise<number | null> {
  try {
    const r = await fetch('https://bundles.jito.wtf/api/v1/bundles/tip_floor', { method: 'GET' });
    const arr = await r.json();
    const ema50 = Number(arr?.[0]?.ema_landed_tips_50th_percentile || 0);
    return Number.isFinite(ema50) ? Math.floor(ema50 * 1_000_000_000) : null;
  } catch { return null; }
}

export async function selectTipLamports(jitoCfg: any, priorityLamportsEst: number): Promise<number> {
  const minTip = 1000;
  if (jitoCfg?.tipMode === 'fixed') return Math.max(minTip, Number(jitoCfg.fixedTipLamports || 0));
  const floor = await fetchTipFloorLamports();
  const share = Number(jitoCfg?.tipShare ?? 0.3);
  const target = Math.floor((priorityLamportsEst * share) / Math.max(1 - share, 0.01));
  return Math.max(minTip, floor ?? target);
}

export function buildTipIx(from: PublicKey, to: PublicKey, lamports: number) {
  return SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports: Math.max(0, Math.floor(lamports)) });
}

export async function fetchTipAccount(beUrl?: string): Promise<string | null> {
  const base = String(beUrl || (CONFIG as any)?.jito?.blockEngineUrl || 'https://mainnet.block-engine.jito.wtf');
  const urls = [
    `${base}/api/v1/bundles/tip_accounts`,
    // fallback path variants if BE changes
    `${base}/api/v1/tip_accounts`,
  ];
  for (const url of urls) {
    try {
      const r = await fetch(url, { method: 'GET' });
      if (!r.ok) continue;
      const j = await r.json().catch(() => ({} as any));
      // Accept common shapes
      const arr: string[] = Array.isArray(j) ? j : (Array.isArray(j?.accounts) ? j.accounts : (Array.isArray(j?.tip_accounts) ? j.tip_accounts : []));
      const first = Array.isArray(arr) && arr.length > 0 ? String(arr[0]) : '';
      if (first && first.length > 0) return first;
    } catch { continue; }
  }
  return null;
}


