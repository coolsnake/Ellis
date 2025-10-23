// @ts-nocheck
import { PublicKey } from '@solana/web3.js';
import { fetchTipAccount, fetchTipFloorLamports } from './jitoTip.js';
import { CONFIG } from '../utils/config.js';

type TipState = { tipAccount?: PublicKey; tipFloorLamports?: number; ts?: number };
const state: TipState = {};
let timer: any | null = null;

export function startTipFeed(intervalMs = 15000): void {
  if (timer) return;
  const every = Math.max(5000, Number(intervalMs));
  const step = async () => {
    try {
      if (!state.tipAccount) {
        const cfg = (CONFIG as any)?.jito || {};
        const explicit = String(cfg?.tipAccount || '');
        let accStr = explicit;
        if (!accStr) {
          try { accStr = await fetchTipAccount(cfg?.blockEngineUrl) || ''; } catch { accStr = ''; }
        }
        if (accStr) {
          try { state.tipAccount = new PublicKey(accStr); } catch {}
        }
      }
      try {
        const floor = await fetchTipFloorLamports();
        if (Number.isFinite(Number(floor))) state.tipFloorLamports = Number(floor);
      } catch {}
      state.ts = Date.now();
    } catch {}
  };
  step().catch(() => {});
  timer = setInterval(() => { step().catch(() => {}); }, every);
}

export function getCachedTipInfo(): { tipAccount?: PublicKey; tipFloorLamports?: number } {
  return { tipAccount: state.tipAccount, tipFloorLamports: state.tipFloorLamports };
}


