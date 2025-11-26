// @ts-nocheck
import { SystemProgram, PublicKey } from '@solana/web3.js';
import { CONFIG } from '../utils/config.js';
import { logger } from '../utils/logger.js';

// Official Jito tip accounts as hardcoded fallback
const JITO_TIP_ACCOUNTS_FALLBACK = [
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
  'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
  'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
  'HFqU5x63VTqvQss8hp11i4bVoTfXDRiU9LbvgU5h57cE',
  '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
];

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
  // First check config tipAccounts (from env or defaults)
  const configAccounts = (CONFIG as any)?.jito?.tipAccounts;
  if (Array.isArray(configAccounts) && configAccounts.length > 0) {
    const chosen = configAccounts[Math.floor(Math.random() * configAccounts.length)];
    try {
      logger.debug('jito.tip.from_config', { cat: 'tx', account: String(chosen).slice(0, 8), source: 'config' });
    } catch {}
    return chosen;
  }
  
  // Then try explicit tipAccount from config
  const explicitAccount = String((CONFIG as any)?.jito?.tipAccount || '');
  if (explicitAccount && explicitAccount.length > 30) {
    try {
      logger.debug('jito.tip.from_explicit', { cat: 'tx', account: explicitAccount.slice(0, 8), source: 'explicit' });
    } catch {}
    return explicitAccount;
  }

  // Then try API fetch
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
      if (first && first.length > 0) {
        try {
          logger.debug('jito.tip.from_api', { cat: 'tx', account: first.slice(0, 8), source: 'api', url });
        } catch {}
        return first;
      }
    } catch { continue; }
  }
  
  // Fallback to hardcoded accounts - ALWAYS return something
  const fallback = JITO_TIP_ACCOUNTS_FALLBACK[Math.floor(Math.random() * JITO_TIP_ACCOUNTS_FALLBACK.length)];
  try {
    logger.warn('jito.tip.using_fallback', { cat: 'tx', account: fallback.slice(0, 8), source: 'hardcoded_fallback' });
  } catch {}
  return fallback;
}


