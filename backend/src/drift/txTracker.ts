// @ts-nocheck
import { Connection } from '@solana/web3.js';
import { withRpcLimit } from '../utils/rpcLimiter.js';
import { logger } from '../utils/logger.js';
import { logFillerTx } from '../utils/tradeSummary.js';
import * as path from 'path';
import { promises as fs } from 'fs';
import { emit } from '../server/realtime.js';

export type DriftAttemptIn = {
  sig: string;
  action: 'fill' | 'trigger' | 'liquidate';
  marketIndex?: number;
  taker?: string;
  makers?: string[];
  orderId?: string | number;
  priorityFeeMicroLamports?: number;
  cuLimit?: number;
  bot?: string; // registry key e.g. fil#name or trg#name
  buildMs?: number;
  sendMs?: number;
  sentAtMs?: number;
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
  confirmMs?: number;
  slot?: number;
  confirmationStatus?: string;
  err?: any;
};

/**
 * Track a drift transaction attempt. Records immediately on send, then
 * asynchronously polls for confirmation to update with final results.
 * This ensures metrics are visible even before confirmation.
 */
export async function trackDriftAttempt(conn: Connection, a: DriftAttemptIn): Promise<DriftAttemptOut | null> {
  const ts = Date.now();
  
  // Record immediately with input data (before confirmation)
  // This ensures the attempt shows up in metrics right away
  const initialRecord: AttemptRecord = {
    ts,
    ...a,
    success: false, // Unknown until confirmed
    feeLamports: 0,
    priorityLamports: 0,
    lamportsPaid: 0,
    confirmationStatus: 'pending',
  };
  
  try {
    recordAttempt(initialRecord);
    try {
      logger.info('drift.tx.attempt_recorded', {
        cat: 'drift',
        action: a.action,
        sig: a.sig,
        bot: a.bot,
        marketIndex: a.marketIndex,
        buildMs: a.buildMs,
        sendMs: a.sendMs,
      });
    } catch {}
  } catch {}

  // Now poll for confirmation asynchronously
  try {
    const tConfirm0 = Date.now();
    
    // Poll up to 30 seconds for confirmation
    const maxWaitMs = 30_000;
    const pollIntervalMs = 2_000;
    let tx: any = null;
    let attempts = 0;
    const maxAttempts = Math.ceil(maxWaitMs / pollIntervalMs);
    
    while (!tx && attempts < maxAttempts) {
      attempts += 1;
      try {
        tx = await withRpcLimit(() => conn.getTransaction(a.sig, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' }));
      } catch {}
      if (!tx && attempts < maxAttempts) {
        await new Promise((r) => setTimeout(r, pollIntervalMs));
      }
    }
    
    if (!tx || !tx.meta) {
      // Transaction not found after polling - update record as failed/expired
      try {
        updateAttemptRecord(a.sig, {
          success: false,
          confirmationStatus: 'not_found',
          confirmMs: Date.now() - (Number(a.sentAtMs) || tConfirm0),
        });
        logger.warn('drift.tx.not_confirmed', { cat: 'drift', sig: a.sig, attempts, maxWaitMs });
      } catch {}
      return null;
    }
    
    const logs: string[] = tx.meta.logMessages || [];
    const feeLamports = Number(tx.meta.fee || 0);
    const cuConsumed = Number((tx.meta as any)?.computeUnitsConsumed || extractCuFromLogs(logs) || 0);
    const cuPriceMicro = Number(a.priorityFeeMicroLamports || 0);
    const priorityLamports = Math.floor((cuConsumed * cuPriceMicro) / 1_000_000);
    const lamportsPaid = feeLamports + priorityLamports;

    const parsed = extractDriftFillStats(logs);
    const success = parsed.success;
    const confirmMs = Number.isFinite(Number(a.sentAtMs)) ? Math.max(0, Date.now() - Number(a.sentAtMs)) : Math.max(0, Date.now() - tConfirm0);
    const out: DriftAttemptOut = {
      success,
      feeLamports,
      priorityLamports,
      lamportsPaid,
      cuConsumed: Number.isFinite(cuConsumed) ? cuConsumed : undefined,
      fillerRewardQuote: parsed.fillerRewardQuote,
      baseFilled: parsed.baseFilled,
      quoteFilled: parsed.quoteFilled,
      confirmMs,
      slot: Number(tx?.slot || 0) || undefined,
      confirmationStatus: String((tx as any)?.confirmationStatus || (tx as any)?.meta?.confirmationStatus || 'confirmed'),
      err: (tx as any)?.meta?.err,
    };

    // Update the existing record with confirmation data
    try { updateAttemptRecord(a.sig, out); } catch {}

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
        buildMs: a.buildMs,
        sendMs: a.sendMs,
        confirmMs: out.confirmMs,
        slot: out.slot,
        confirmationStatus: out.confirmationStatus,
      });
    } catch {}

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
        buildMs: a.buildMs,
        sendMs: a.sendMs,
        confirmMs: out.confirmMs ?? null,
        slot: out.slot ?? null,
        confirmationStatus: out.confirmationStatus || null,
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
  // Emit real-time event for frontend
  try { emit('drift-tx', { type: 'new', record: rec }); } catch {}
}

/**
 * Update an existing attempt record by signature with confirmation data.
 * Updates both in-memory store and appends update to JSONL.
 */
export function updateAttemptRecord(sig: string, update: Partial<DriftAttemptOut>): void {
  try {
    // Find and update in-memory record (most recent match)
    for (let i = attemptsStore.length - 1; i >= 0; i--) {
      if (attemptsStore[i].sig === sig) {
        Object.assign(attemptsStore[i], update);
        // Append the updated record to JSONL for persistence
        try { appendJsonl({ ...attemptsStore[i], _updated: Date.now() }).catch(() => {}); } catch {}
        // Emit real-time event for frontend
        try { emit('drift-tx', { type: 'update', record: attemptsStore[i] }); } catch {}
        break;
      }
    }
  } catch {}
}

async function readJsonlTail(filePath: string, maxBytes: number): Promise<string[]> {
  try {
    const st = await fs.stat(filePath);
    const size = Number(st?.size || 0);
    if (!size) return [];
    const bytes = Math.max(1, Math.min(size, Math.max(1024, Number(maxBytes || 2_000_000))));
    const start = Math.max(0, size - bytes);
    const fh = await fs.open(filePath, 'r');
    try {
      const buf = Buffer.alloc(size - start);
      await fh.read(buf, 0, buf.length, start);
      const text = buf.toString('utf8');
      const lines = text.split('\n');
      if (start > 0) lines.shift(); // drop partial line
      return lines.filter((l) => l && l.trim().length > 0);
    } finally {
      try { await fh.close(); } catch {}
    }
  } catch {
    return [];
  }
}

export async function readAttemptHistory(params: { limit?: number; maxBytes?: number; sinceMs?: number; action?: 'fill' | 'trigger' | 'liquidate'; bot?: string }): Promise<AttemptRecord[]> {
  const maxBytes = Math.max(64 * 1024, Number(params.maxBytes || 2_000_000));
  const rawLines = await readJsonlTail(fsPath, maxBytes);
  const items: AttemptRecord[] = [];
  for (const line of rawLines) {
    try {
      const obj = JSON.parse(line);
      if (obj && typeof obj === 'object' && Number.isFinite(Number(obj.ts || 0))) {
        items.push(obj as AttemptRecord);
      }
    } catch {}
  }
  const sinceMs = Number(params.sinceMs || 0);
  let filtered = items;
  if (sinceMs > 0) filtered = filtered.filter((r) => Number(r.ts || 0) >= sinceMs);
  if (params.action) filtered = filtered.filter((r) => r.action === params.action);
  if (params.bot) filtered = filtered.filter((r) => String(r.bot || '') === String(params.bot));
  // Ensure chronological order
  filtered.sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0));
  const limit = Math.max(1, Number(params.limit || 200));
  if (filtered.length > limit) filtered = filtered.slice(filtered.length - limit);
  return filtered;
}

function pct(values: number[], q: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((q / 100) * (sorted.length - 1)));
  return Number(sorted[idx] || 0);
}

export function summarizeAttemptRecords(records: AttemptRecord[], windowMs: number, action?: 'fill' | 'trigger' | 'liquidate'): {
  attempts: number;
  successes: number;
  failures: number;
  failureRate: number;
  costLamports: number;
  costSol: number;
  revenueQuote: number;
  timings: { buildMs: { n: number; p50: number; p95: number }; sendMs: { n: number; p50: number; p95: number }; confirmMs: { n: number; p50: number; p95: number } };
} {
  const cutoff = Date.now() - Math.max(1000, Number(windowMs || 60000));
  const slice = records.filter((r) => Number(r.ts || 0) >= cutoff && (!action || r.action === action));
  let attempts = slice.length;
  let successes = 0;
  let costLamports = 0;
  let revenueQuote = 0;
  const buildVals: number[] = [];
  const sendVals: number[] = [];
  const confirmVals: number[] = [];
  for (const r of slice) {
    if (r.success) successes += 1;
    costLamports += Number((r as any).lamportsPaid || 0);
    if (r.action === 'fill') revenueQuote += Number((r as any).fillerRewardQuote || 0);
    if (Number.isFinite(Number((r as any).buildMs))) buildVals.push(Number((r as any).buildMs));
    if (Number.isFinite(Number((r as any).sendMs))) sendVals.push(Number((r as any).sendMs));
    if (Number.isFinite(Number((r as any).confirmMs))) confirmVals.push(Number((r as any).confirmMs));
  }
  const failures = Math.max(0, attempts - successes);
  const failureRate = attempts > 0 ? failures / attempts : 0;
  const costSol = costLamports / 1_000_000_000;
  return {
    attempts,
    successes,
    failures,
    failureRate,
    costLamports,
    costSol,
    revenueQuote,
    timings: {
      buildMs: { n: buildVals.length, p50: pct(buildVals, 50), p95: pct(buildVals, 95) },
      sendMs: { n: sendVals.length, p50: pct(sendVals, 50), p95: pct(sendVals, 95) },
      confirmMs: { n: confirmVals.length, p50: pct(confirmVals, 50), p95: pct(confirmVals, 95) },
    },
  };
}

export function getMetrics(params: { windowMs: number; action?: 'fill' | 'trigger'; bot?: string }): {
  attempts: number;
  successes: number;
  failures: number;
  failureRate: number;
  costLamports: number;
  costSol: number;
  revenueQuote: number; // only for fills
  avgBuildMs: number;
  avgLatencyMs: number; // sendMs + confirmMs
  avgSendMs: number;
  avgConfirmMs: number;
} {
  const now = Date.now();
  const cutoff = now - Math.max(1000, Number(params.windowMs || 60000));
  const slice = attemptsStore.filter((r) => r.ts >= cutoff && (!params.action || r.action === params.action) && (!params.bot || r.bot === params.bot));
  let attempts = slice.length;
  let successes = 0;
  let costLamports = 0;
  let revenueQuote = 0;
  const buildVals: number[] = [];
  const sendVals: number[] = [];
  const confirmVals: number[] = [];
  for (const r of slice) {
    if (r.success) successes += 1;
    costLamports += Number(r.lamportsPaid || 0);
    if (r.action === 'fill') revenueQuote += Number(r.fillerRewardQuote || 0);
    if (Number.isFinite(Number((r as any).buildMs))) buildVals.push(Number((r as any).buildMs));
    if (Number.isFinite(Number((r as any).sendMs))) sendVals.push(Number((r as any).sendMs));
    if (Number.isFinite(Number((r as any).confirmMs))) confirmVals.push(Number((r as any).confirmMs));
  }
  const failures = Math.max(0, attempts - successes);
  const failureRate = attempts > 0 ? failures / attempts : 0;
  const costSol = costLamports / 1_000_000_000;
  const avg = (arr: number[]) => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
  const avgBuildMs = avg(buildVals);
  const avgSendMs = avg(sendVals);
  const avgConfirmMs = avg(confirmVals);
  const avgLatencyMs = avgSendMs + avgConfirmMs; // Total latency from send to confirm
  return { 
    attempts, 
    successes, 
    failures, 
    failureRate, 
    costLamports, 
    costSol, 
    revenueQuote,
    avgBuildMs,
    avgLatencyMs,
    avgSendMs,
    avgConfirmMs,
  };
}


