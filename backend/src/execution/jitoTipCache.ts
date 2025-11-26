// @ts-nocheck
import { PublicKey } from '@solana/web3.js';
import { fetchTipAccount, fetchTipFloorLamports } from './jitoTip.js';
import { CONFIG } from '../utils/config.js';
import { logger } from '../utils/logger.js';

type TipState = { tipAccount?: PublicKey; tipFloorLamports?: number; ts?: number };
const state: TipState = {};
let timer: any | null = null;

export function startTipFeed(intervalMs = 15000): void {
  if (timer) return;
  const every = Math.max(5000, Number(intervalMs));
  const step = async () => {
    try {
      // Always try to get tip account (fetchTipAccount now has fallback)
      if (!state.tipAccount) {
        const cfg = (CONFIG as any)?.jito || {};
        // fetchTipAccount now checks config, API, and has hardcoded fallback
        const accStr = await fetchTipAccount(cfg?.blockEngineUrl);
        if (accStr) {
          try { 
            state.tipAccount = new PublicKey(accStr); 
            logger.info('jito.tip_cache.initialized', { 
              cat: 'tx', 
              account: accStr.slice(0, 8),
            });
          } catch {}
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


