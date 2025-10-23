// @ts-nocheck
import { Connection } from '@solana/web3.js';
import { withRpcLimit } from '../utils/rpcLimiter.js';
import { logger } from '../utils/logger.js';
import { logFillerTx } from '../utils/tradeSummary.js';
import * as path from 'path';
import { promises as fs } from 'fs';

export type DriftAttemptIn = {
  sig: string;
  action: 'fill' | 'trigger';
  marketIndex?: number;
  taker?: string;
  makers?: string[];
  orderId?: string | number;
  priorityFeeMicroLamports?: number;
  cuLimit?: number;
  bot?: string; // registry key e.g. fil#name or trg#name
};

export type DriftAttemptOut = {
  success: boolean;
  feeLamports: number;
  priorityLamports: number;
  lamportsPaid: number;
  cuConsumed?: number;
  fillerRewardQuote?: number; // quote precision units
  baseFilled?: number;
  quoteFilled?: number;
};

export async function trackDriftAttempt(conn: Connection, a: DriftAttemptIn): Promise<DriftAttemptOut | null> {
  try {
    const tx = await withRpcLimit(() => conn.getTransaction(a.sig, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' }));
    if (!tx || !tx.meta) return null;
    const logs: string[] = tx.meta.logMessages || [];
    const feeLamports = Number(tx.meta.fee || 0);
    const cuConsumed = Number((tx.meta as any)?.computeUnitsConsumed || extractCuFromLogs(logs) || 0);
    const cuPriceMicro = Number(a.priorityFeeMicroLamports || 0);
    const priorityLamports = Math.floor((cuConsumed * cuPriceMicro) / 1_000_000);
    const lamportsPaid = feeLamports + priorityLamports;

    const parsed = extractDriftFillStats(logs);
    const success = parsed.success;
    const out: DriftAttemptOut = {
      success,
      feeLamports,
      priorityLamports,
      lamportsPaid,
      cuConsumed: Number.isFinite(cuConsumed) ? cuConsumed : undefined,
      fillerRewardQuote: parsed.fillerRewardQuote,
      baseFilled: parsed.baseFilled,
      quoteFilled: parsed.quoteFilled,
    };

    try {
      logger.info('drift.tx.tracked', {
        cat: 'drift',
        action: a.action,
        sig: a.sig,
        bot: a.bot,
        marketIndex: a.marketIndex,
        taker: a.taker,
        makers: a.makers,
        orderId: a.orderId,
        cuConsumed: out.cuConsumed,
        feeLamports,
        priorityLamports,
        lamportsPaid,
        success,
        baseFilled: out.baseFilled,
        quoteFilled: out.quoteFilled,
        fillerRewardQuote: out.fillerRewardQuote,
      });
    } catch {}

    try { recordAttempt({ ts: Date.now(), ...a, ...out }); } catch {}

    // Persist a filler tx record for easy post-hoc analysis
    try {
      await logFillerTx({
        ts: new Date().toISOString(),
        action: a.action,
        sig: a.sig,
        marketIndex: a.marketIndex,
        taker: a.taker,
        makers: a.makers,
        orderId: a.orderId,
        success: out.success,
        baseFilled: out.baseFilled ?? null,
        quoteFilled: out.quoteFilled ?? null,
        fillerRewardQuote: out.fillerRewardQuote ?? null,
        feeLamports: out.feeLamports,
        priorityLamports: out.priorityLamports,
        lamportsPaid: out.lamportsPaid,
        cuConsumed: out.cuConsumed ?? null,
        bot: a.bot,
      });
    } catch {}

    return out;
  } catch (e: any) {
    try { logger.warn('drift.tx.track_error', { cat: 'drift', sig: a.sig, err: String(e?.message || e) }); } catch {}
    return null;
  }
}

function extractCuFromLogs(logs: string[]): number | undefined {
  for (const l of logs || []) {
    const m = l.match(/consumed\s+(\d+)\s+of/i);
    if (m) return Number(m[1]);
  }
  return undefined;
}

function extractDriftFillStats(logs: string[]): { baseFilled?: number; quoteFilled?: number; fillerRewardQuote?: number; success: boolean } {
  const joined = (logs || []).join('\n');
  // Heuristic: presence of FillPerpOrder or FillRecord implies success. Placeholder for richer parsing.
  const success = /FillPerpOrder|FillRecord/i.test(joined);
  // Attempt to scrape a simple filler reward number if present in plain logs
  let fillerRewardQuote: number | undefined = undefined;
  try {
    const m = joined.match(/filler.*reward[^\d]*(\d+)/i);
    if (m) fillerRewardQuote = Number(m[1]);
  } catch {}
  return { success, fillerRewardQuote };
}

// Persistence / aggregation
type AttemptRecord = DriftAttemptIn & DriftAttemptOut & { ts: number };
const attemptsStore: AttemptRecord[] = [];
const fsPath = path.resolve(process.cwd(), 'logs', 'keeper_attempts.jsonl');

async function appendJsonl(obj: any) {
  try {
    const dir = path.dirname(fsPath);
    await fs.mkdir(dir, { recursive: true } as any).catch(() => {});
    await fs.appendFile(fsPath, JSON.stringify(obj) + '\n');
  } catch {}
}

export function recordAttempt(rec: AttemptRecord): void {
  try { attemptsStore.push(rec); } catch {}
  try { appendJsonl(rec).catch(() => {}); } catch {}
}

export function getMetrics(params: { windowMs: number; action?: 'fill' | 'trigger'; bot?: string }): {
  attempts: number;
  successes: number;
  failures: number;
  failureRate: number;
  costLamports: number;
  costSol: number;
  revenueQuote: number; // only for fills
} {
  const now = Date.now();
  const cutoff = now - Math.max(1000, Number(params.windowMs || 60000));
  const slice = attemptsStore.filter((r) => r.ts >= cutoff && (!params.action || r.action === params.action) && (!params.bot || r.bot === params.bot));
  let attempts = slice.length;
  let successes = 0;
  let costLamports = 0;
  let revenueQuote = 0;
  for (const r of slice) {
    if (r.success) successes += 1;
    costLamports += Number(r.lamportsPaid || 0);
    if (r.action === 'fill') revenueQuote += Number(r.fillerRewardQuote || 0);
  }
  const failures = Math.max(0, attempts - successes);
  const failureRate = attempts > 0 ? failures / attempts : 0;
  const costSol = costLamports / 1_000_000_000;
  return { attempts, successes, failures, failureRate, costLamports, costSol, revenueQuote };
}


