// @ts-nocheck
import { PublicKey } from '@solana/web3.js';
import { CONFIG } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import { fetchTipFloorLamports, fetchTipAccount, buildTipIx } from './jitoTip.js';
import { getPriceByMint } from '../server/priceStore.js';
import { loadJitoConfig, getJitoConfigSync, type JitoConfig } from '../server/jitoConfigStore.js';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const LAMPORTS_PER_SOL = 1_000_000_000;

// Get Jito config with fallback to CONFIG (env vars)
async function getJitoConfig(): Promise<JitoConfig> {
  try {
    return await loadJitoConfig();
  } catch {
    // Fallback to CONFIG if store fails
    const jitoCfg = (CONFIG as any)?.jito || {};
    return {
      enabled: jitoCfg.enabled !== false,
      tipMode: jitoCfg.tipMode || 'dynamic',
      tipShare: typeof jitoCfg.tipShare === 'number' ? jitoCfg.tipShare : 0.35,
      minTipLamports: typeof jitoCfg.minTipLamports === 'number' ? jitoCfg.minTipLamports : 10000,
      maxTipLamports: typeof jitoCfg.maxTipLamports === 'number' ? jitoCfg.maxTipLamports : 5_000_000,
      fixedTipLamports: typeof jitoCfg.fixedTipLamports === 'number' ? jitoCfg.fixedTipLamports : 10000,
    };
  }
}

// Cache tip floor to avoid fetching on every tx
let cachedTipFloor: { value: number; fetchedAt: number } | null = null;
const TIP_FLOOR_CACHE_MS = 30000; // 30 seconds

async function getCachedTipFloor(): Promise<number> {
  const now = Date.now();
  if (cachedTipFloor && (now - cachedTipFloor.fetchedAt) < TIP_FLOOR_CACHE_MS) {
    return cachedTipFloor.value;
  }
  const floor = await fetchTipFloorLamports();
  cachedTipFloor = { value: floor ?? 10000, fetchedAt: now };
  return cachedTipFloor.value;
}

// Cache tip account
let cachedTipAccount: { value: string; fetchedAt: number } | null = null;
const TIP_ACCOUNT_CACHE_MS = 300000; // 5 minutes

async function getCachedTipAccount(): Promise<string | null> {
  const now = Date.now();
  if (cachedTipAccount && (now - cachedTipAccount.fetchedAt) < TIP_ACCOUNT_CACHE_MS) {
    return cachedTipAccount.value;
  }
  const account = await fetchTipAccount();
  if (account) {
    cachedTipAccount = { value: account, fetchedAt: now };
  }
  return account;
}

export interface ProfitBasedTipParams {
  inputMint: string;
  inputAmountRaw: string | bigint;
  inputDecimals: number;
  profitBps: number;
  tipShare?: number;      // Default: 0.35 (35% of profit)
  minTipLamports?: number; // Default: 10000 (0.00001 SOL)
  maxTipLamports?: number; // Default: 5_000_000 (0.005 SOL)
}

export interface TipResult {
  tipLamports: number;
  tipAccount: string;
  tipIx: any; // TransactionInstruction
  expectedProfitLamports: number;
  breakdown: {
    inputValueSol: number;
    profitBps: number;
    expectedProfitSol: number;
    tipShare: number;
    rawTipLamports: number;
    floorLamports: number;
    finalTipLamports: number;
  };
}

/**
 * Calculate Jito tip based on expected arbitrage profit.
 * 
 * Formula:
 * 1. Convert input amount to SOL value
 * 2. Calculate expected profit = inputSOL × (profitBps / 10000)
 * 3. Tip = max(floor, min(maxTip, expectedProfit × tipShare))
 */
export async function calculateProfitBasedTip(
  walletPubkey: PublicKey,
  params: ProfitBasedTipParams
): Promise<TipResult | null> {
  const jitoCfg = await getJitoConfig();
  if (!jitoCfg.enabled) {
    try {
      logger.debug('arb.tip.skipped', { 
        cat: 'tx', 
        reason: 'jito_disabled',
        config: { enabled: jitoCfg.enabled, tipMode: jitoCfg.tipMode },
      });
    } catch {}
    return null;
  }

  const tipShare = params.tipShare ?? jitoCfg.tipShare ?? 0.35;
  const minTip = params.minTipLamports ?? jitoCfg.minTipLamports ?? 10000;
  const maxTip = params.maxTipLamports ?? jitoCfg.maxTipLamports ?? 5_000_000;

  try {
    // Get tip account
    const tipAccountStr = await getCachedTipAccount();
    if (!tipAccountStr) {
      logger.warn('arb.tip.no_account', { cat: 'tx' });
      return null;
    }

    // Don't tip yourself
    if (tipAccountStr === walletPubkey.toBase58()) {
      return null;
    }

    // Get SOL price for conversion
    const solPrice = getPriceByMint(SOL_MINT);
    const solUsd = solPrice?.usdc ?? 0;

    // Get input token price
    const inputPrice = getPriceByMint(params.inputMint);
    const inputUsd = inputPrice?.usdc ?? 0;

    if (solUsd <= 0 || inputUsd <= 0) {
      logger.warn('arb.tip.no_price', { 
        cat: 'tx', 
        inputMint: params.inputMint.slice(0, 8),
        solUsd,
        inputUsd,
      });
      // Fall back to tip floor if prices unavailable
      const floor = await getCachedTipFloor();
      const tipAccount = new PublicKey(tipAccountStr);
      return {
        tipLamports: Math.max(minTip, floor),
        tipAccount: tipAccountStr,
        tipIx: buildTipIx(walletPubkey, tipAccount, Math.max(minTip, floor)),
        expectedProfitLamports: 0,
        breakdown: {
          inputValueSol: 0,
          profitBps: params.profitBps,
          expectedProfitSol: 0,
          tipShare,
          rawTipLamports: 0,
          floorLamports: floor,
          finalTipLamports: Math.max(minTip, floor),
        },
      };
    }

    // Calculate input value in SOL
    const inputAmountWhole = Number(BigInt(params.inputAmountRaw)) / Math.pow(10, params.inputDecimals);
    const inputValueUsd = inputAmountWhole * inputUsd;
    const inputValueSol = inputValueUsd / solUsd;

    // Calculate expected profit in SOL
    const expectedProfitSol = inputValueSol * (params.profitBps / 10000);
    const expectedProfitLamports = Math.floor(expectedProfitSol * LAMPORTS_PER_SOL);

    // Calculate tip
    const floor = await getCachedTipFloor();
    const rawTipLamports = Math.floor(expectedProfitLamports * tipShare);
    const finalTipLamports = Math.max(minTip, Math.min(maxTip, Math.max(floor, rawTipLamports)));

    const tipAccount = new PublicKey(tipAccountStr);

    logger.info('arb.tip.calculated', {
      cat: 'tx',
      ctx: {
        inputMint: params.inputMint.slice(0, 8),
        inputAmountWhole,
        inputValueSol: inputValueSol.toFixed(6),
        profitBps: params.profitBps,
        expectedProfitSol: expectedProfitSol.toFixed(6),
        expectedProfitLamports,
        tipShare,
        floorLamports: floor,
        rawTipLamports,
        finalTipLamports,
        tipAccount: tipAccountStr.slice(0, 8),
      },
    });

    return {
      tipLamports: finalTipLamports,
      tipAccount: tipAccountStr,
      tipIx: buildTipIx(walletPubkey, tipAccount, finalTipLamports),
      expectedProfitLamports,
      breakdown: {
        inputValueSol,
        profitBps: params.profitBps,
        expectedProfitSol,
        tipShare,
        rawTipLamports,
        floorLamports: floor,
        finalTipLamports,
      },
    };
  } catch (e: any) {
    logger.error('arb.tip.error', { cat: 'tx', error: String(e?.message || e) });
    return null;
  }
}

