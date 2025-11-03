import { logger } from '../utils/logger.js';
import { CONFIG } from '../utils/config.js';
import type { GraphDiff, GraphSnapshot } from './graph.types.js';
import { fetch } from 'undici';

type GraphPushKind = 'snapshot' | 'diff';

type ArbJob = {
  kind: GraphPushKind;
  payload: any;
  resolve: () => void;
  reject: (e: any) => void;
};

type Waiter = { resolve: () => void; reject: (e: any) => void };

type GraphPushStats = {
  ackMs: number[];
  success: number;
  failed: number;
};

const pushStats: GraphPushStats = {
  ackMs: [],
  success: 0,
  failed: 0,
};

const pushBounded = (arr: number[], v: number, cap = 200) => {
  if (!Number.isFinite(v)) return;
  arr.push(v);
  if (arr.length > cap) arr.shift();
};

const percentile = (arr: number[], p: number): number | null => {
  if (!arr.length) return null;
  const sorted = arr.slice().sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(((p / 100) * (sorted.length - 1)))));
  return sorted[idx] ?? null;
};

const coalesceEdgeList = <T>(base: T[] | undefined, next: T[] | undefined, keyFn: (x: T) => string): T[] => {
  const map = new Map<string, T>();
  for (const item of base || []) {
    map.set(keyFn(item), item);
  }
  for (const item of next || []) {
    map.set(keyFn(item), item);
  }
  return Array.from(map.values());
};

const coalesceDiff = (current: GraphDiff | null, incoming: GraphDiff): GraphDiff => {
  if (!current) return { ...incoming };
  const keyEdge = (e: any) => String((e?.pool_id) || `${e?.source}|${e?.target}|${e?.dex}`);
  return {
    version: Math.max(Number(current.version || 0), Number(incoming.version || 0)),
    timestamp: Math.max(Number(current.timestamp || 0), Number(incoming.timestamp || 0), Date.now()),
    addedNodes: [],
    updatedNodes: [],
    removedNodeIds: [],
    addedEdges: coalesceEdgeList(current.addedEdges, incoming.addedEdges, keyEdge),
    updatedEdges: coalesceEdgeList(current.updatedEdges, incoming.updatedEdges, keyEdge),
    removedEdgeIds: Array.from(new Set([...(current.removedEdgeIds || []), ...(incoming.removedEdgeIds || [])].map((s) => String(s)))),
  } as GraphDiff;
};

const getDiffCoalesceMs = (): number => {
  try {
    const raw = Number(((globalThis as any)?.process?.env?.ARB_DIFF_COALESCE_MS) || 50);
    return Number.isFinite(raw) ? Math.max(0, raw) : 0;
  } catch {
    return 0;
  }
};

const getDetectDrivenPushCoalesceMs = (): number => {
  try {
    const raw = Number(((globalThis as any)?.process?.env?.DETECT_DRIVEN_PUSH_COALESCE_MS) || 75);
    return Number.isFinite(raw) ? Math.max(0, raw) : 0;
  } catch {
    return 0;
  }
};

const fetchArbMetrics = async (): Promise<{ last_detection_ms: number }> => {
  try {
    if (String((globalThis as any)?.process?.env?.NODE_ENV || '').toLowerCase() === 'test') {
      return { last_detection_ms: 0 };
    }
    const host = ((globalThis as any)?.process?.env?.ARB_SERVICE_URL) || 'http://127.0.0.1:4010';
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort('timeout'), 3000);
    const r = await fetch(`${host}/metrics/json`, { headers: { accept: 'application/json' }, signal: ac.signal }).finally(() => clearTimeout(t));
    const j: any = await r.json().catch(() => ({}));
    return { last_detection_ms: Number(j?.last_detection_ms || 0) };
  } catch {
    return { last_detection_ms: 0 };
  }
};

const notifyArbServiceRefreshImpl = async (): Promise<void> => {
  try {
    const host = ((globalThis as any)?.process?.env?.ARB_SERVICE_URL) || 'http://127.0.0.1:4010';
    await fetch(`${host}/arb/graph/version`, { method: 'GET', headers: { accept: 'application/json' } });
  } catch {}
};

class GraphPushOrchestrator {
  private arbStreamEnabled = false;
  private pendingSnapshot: GraphSnapshot | null = null;
  private pendingDiff: GraphDiff | null = null;
  private queue: ArbJob[] = [];
  private inFlight = false;
  private diffTimer: NodeJS.Timeout | null = null;
  private readonly diffCoalesceMs: number;
  private readonly detectCoalesceMs: number;
  private waiters: Waiter[] = [];
  private flushHandle: NodeJS.Timeout | null = null;
  private flushInProgress = false;
  private lastDetectSeen = 0;
  private detectDirty = false;

  constructor() {
    this.diffCoalesceMs = getDiffCoalesceMs();
    this.detectCoalesceMs = getDetectDrivenPushCoalesceMs();
  }

  setStreamEnabled(enabled: boolean): void {
    this.arbStreamEnabled = !!enabled;
    try {
      logger.info('arb:stream state', { enabled: this.arbStreamEnabled });
    } catch {}
    if (this.arbStreamEnabled) {
      this.scheduleFlush();
    }
  }

  isStreamEnabled(): boolean {
    return this.arbStreamEnabled;
  }

  async enqueueSnapshot(snapshot: GraphSnapshot): Promise<void> {
    if (!this.arbStreamEnabled) {
      try { logger.debug('arb.push gated', { kind: 'snapshot' }); } catch {}
      return;
    }
    if (!snapshot || !Array.isArray((snapshot as any).edges) || (snapshot as any).edges.length === 0) {
      try { logger.debug('arb.push skip empty snapshot'); } catch {}
      return;
    }
    try {
      logger.info('graph.push enqueue', {
        kind: 'snapshot',
        version: snapshot.version,
        nodes: Array.isArray(snapshot.nodes) ? snapshot.nodes.length : undefined,
        edges: Array.isArray(snapshot.edges) ? snapshot.edges.length : undefined,
        detect_mode: this.shouldWaitForDetect(),
      });
    } catch {}
    this.pendingSnapshot = snapshot;
    this.pendingDiff = null;
    if (this.diffTimer) {
      clearTimeout(this.diffTimer);
      this.diffTimer = null;
    }
    this.detectDirty = true;
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
      this.scheduleFlush();
    });
  }

  async enqueueDiff(diff: GraphDiff): Promise<void> {
    if (!diff) return;
    if (!this.arbStreamEnabled) {
      try { logger.debug('arb.push gated', { kind: 'diff' }); } catch {}
      return;
    }
    try {
      logger.info('graph.push enqueue', {
        kind: 'diff',
        version: diff.version,
        added: diff.addedEdges?.length,
        updated: diff.updatedEdges?.length,
        removed: diff.removedEdgeIds?.length,
        detect_mode: this.shouldWaitForDetect(),
      });
    } catch {}
    this.detectDirty = true;
    const apply = () => {
      this.pendingDiff = coalesceDiff(this.pendingDiff, diff);
      this.scheduleFlush();
    };

    if (this.diffCoalesceMs > 0) {
      if (this.diffTimer) {
        clearTimeout(this.diffTimer);
      }
      this.diffTimer = setTimeout(() => {
        this.diffTimer = null;
        apply();
      }, this.diffCoalesceMs);
    } else {
      apply();
    }

    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  getStats(): { count: number; p50: number | null; p95: number | null; success: number; failed: number } {
    return {
      count: pushStats.ackMs.length,
      p50: percentile(pushStats.ackMs, 50),
      p95: percentile(pushStats.ackMs, 95),
      success: pushStats.success,
      failed: pushStats.failed,
    };
  }

  getStatsRaw(): GraphPushStats {
    return { ackMs: pushStats.ackMs.slice(), success: pushStats.success, failed: pushStats.failed };
  }

  private scheduleFlush(force = false): void {
    if (this.flushInProgress) return;
    if (!this.arbStreamEnabled) return;
    if (!this.pendingSnapshot && !this.pendingDiff) return;
    const detectMode = this.shouldWaitForDetect();
    if (!force && detectMode) {
      this.detectDirty = true;
      try {
        logger.info('graph.push wait_for_detect', {
          pending_snapshot: !!this.pendingSnapshot,
          pending_diff: !!this.pendingDiff,
          diff_version: this.pendingDiff?.version,
          queue_depth: this.queue.length,
        });
      } catch {}
      return;
    }
    if (this.flushHandle) return;
    const delay = force ? 0 : this.detectCoalesceMs;
    this.flushHandle = setTimeout(() => {
      this.flushHandle = null;
      this.flushPending().catch((e) => {
        try { logger.debug('arb.push flush failed', { error: String(e?.message || e) }); } catch {}
        this.rejectWaiters(e);
      });
    }, delay);
    try {
      logger.info('graph.push flush_scheduled', {
        force,
        pending_snapshot: !!this.pendingSnapshot,
        pending_diff: !!this.pendingDiff,
        diff_version: this.pendingDiff?.version,
        delay_ms: delay,
      });
    } catch {}
  }

  private async flushPending(): Promise<void> {
    if (!this.arbStreamEnabled) return;
    if (this.flushInProgress) return;
    const snapshot = this.pendingSnapshot;
    const diff = !snapshot ? this.pendingDiff : null;
    if (!snapshot && !diff) return;

    this.flushInProgress = true;
    this.pendingSnapshot = null;
    if (!snapshot) {
      this.pendingDiff = null;
    }

    try {
      if (this.detectDirty) this.detectDirty = false;
      try {
        logger.info('graph.push flush_start', {
          kind: snapshot ? 'snapshot' : 'diff',
          version: snapshot ? snapshot.version : diff?.version,
          added: diff?.addedEdges?.length,
          updated: diff?.updatedEdges?.length,
          removed: diff?.removedEdgeIds?.length,
        });
      } catch {}
      if (snapshot) {
        await this.enqueueJob('snapshot', snapshot);
      } else if (diff) {
        await this.enqueueJob('diff', diff);
      }
    } finally {
      this.flushInProgress = false;
      if (this.pendingSnapshot || this.pendingDiff) {
        this.scheduleFlush();
      }
    }
  }

  private async enqueueJob(kind: GraphPushKind, payload: any): Promise<void> {
    return new Promise((resolve, reject) => {
      this.queue.push({ kind, payload, resolve, reject });
      this.processQueue().catch((e) => {
        try { logger.debug('arb.push queue process failed', { error: String(e?.message || e) }); } catch {}
      });
    });
  }

  private async processQueue(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      while (this.queue.length) {
        const job = this.queue.shift()!;
        if (!this.arbStreamEnabled) {
          job.resolve();
          this.resolveWaiters();
          continue;
        }

        const host = ((globalThis as any)?.process?.env?.ARB_SERVICE_URL) || 'http://127.0.0.1:4010';
        const auth = String(((globalThis as any)?.process?.env?.ARB_SHARED_SECRET) || '');
        const headers: Record<string, string> = { 'content-type': 'application/json' };
        if (auth) headers.authorization = `Bearer ${auth}`;

        const url = job.kind === 'snapshot' ? `${host}/arb/graph/snapshot` : `${host}/arb/graph/update`;
        const body = job.kind === 'snapshot' ? JSON.stringify({ graph: job.payload }) : JSON.stringify(job.payload);

        const before = await fetchArbMetrics();
        let attempt = 0;
        const maxAttempts = 5;
        let sent = false;
        while (!sent && attempt < maxAttempts) {
          try {
            const res = await fetch(url, { method: 'POST', headers, body });
            if (!res || !res.ok) throw new Error(`status ${res && (res as any).status}`);
            sent = true;
          } catch (err: any) {
            attempt += 1;
            const wait = Math.min(2000 * Math.pow(2, attempt - 1), 15000);
            try { logger.warn('arb.push retry', { kind: job.kind, attempt, wait_ms: wait, error: String(err?.message || err) }); } catch {}
            await new Promise((r) => setTimeout(r, wait));
          }
        }
        if (!sent) {
          try { logger.error('arb.push giveup', { kind: job.kind, attempts: attempt }); } catch {}
        }

        const wantVersion = Number(job.kind === 'snapshot' ? job.payload?.version : job.payload?.version) || 0;
        const start = Date.now();
        const timeoutMs = Number((((globalThis as any)?.process?.env?.ARB_ACK_TIMEOUT_MS) || 2500));
        let acked = false;
        if (wantVersion > 0) {
          try {
            const ac = new AbortController();
            const t = setTimeout(() => ac.abort('timeout'), timeoutMs + 500);
            const res = await fetch(`${host}/arb/graph/ack`, {
              method: 'POST',
              headers,
              body: JSON.stringify({ version: wantVersion, timeout_ms: timeoutMs }),
              signal: ac.signal,
            }).finally(() => clearTimeout(t));
            if (res?.ok) {
              const j: any = await res.json().catch(() => ({}));
              acked = j?.acked === true;
            }
          } catch (err: any) {
            try { logger.debug('arb.push ack failed', { kind: job.kind, error: String(err?.message || err) }); } catch {}
          }
        } else {
          acked = true;
        }

        const waited = Date.now() - start;
        if (acked) pushStats.success += 1; else pushStats.failed += 1;
        pushBounded(pushStats.ackMs, waited);
        try {
          logger.info('arb.push ack', { kind: job.kind, acked, waited_ms: waited, wantVersion, queue_depth: this.queue.length, push_success: pushStats.success, push_failed: pushStats.failed });
        } catch {}

        const waitForDetect = this.shouldWaitForDetect();
        if (waitForDetect) {
          const deadline = Date.now() + 8000;
          while (Date.now() < deadline) {
            const cur = await fetchArbMetrics();
            this.lastDetectSeen = Math.max(this.lastDetectSeen, Number(cur.last_detection_ms || 0));
            if (cur.last_detection_ms > before.last_detection_ms) break;
            await new Promise((r) => setTimeout(r, 100));
          }
        } else {
          this.lastDetectSeen = Math.max(this.lastDetectSeen, Number(before.last_detection_ms || 0));
        }

        await notifyArbServiceRefreshImpl();

        job.resolve();
        this.resolveWaiters();

        if (job.kind === 'snapshot' && this.queue.length) {
          this.queue = this.queue.filter((j) => j.kind === 'snapshot');
        }
      }
    } finally {
      this.inFlight = false;
    }
  }

  private resolveWaiters(): void {
    const waiters = this.waiters.splice(0, this.waiters.length);
    for (const w of waiters) {
      try { w.resolve(); } catch {}
    }
  }

  private rejectWaiters(err: any): void {
    const waiters = this.waiters.splice(0, this.waiters.length);
    for (const w of waiters) {
      try { w.reject(err); } catch {}
    }
  }

  private shouldWaitForDetect(): boolean {
    const cfg = (CONFIG.system as any) || {};
    const detectDriven = !!cfg.detectDrivenGraphPush;
    const env = String((((globalThis as any)?.process?.env?.ARB_WAIT_FOR_DETECT) || '')).toLowerCase();
    if (env === 'true') return true;
    if (env === 'false') return false;
    return detectDriven;
  }

  peekDetectDirty(): boolean {
    return this.detectDirty || !!this.pendingSnapshot || !!this.pendingDiff;
  }

  async flushPendingFromDetector(): Promise<boolean> {
    if (!this.arbStreamEnabled) return false;
    if (this.flushInProgress) return false;
    const snapshot = this.pendingSnapshot;
    const diff = snapshot ? null : this.pendingDiff;
    if (!snapshot && !diff) {
      this.detectDirty = false;
      return false;
    }
    if (this.flushHandle) {
      clearTimeout(this.flushHandle);
      this.flushHandle = null;
    }
    if (this.diffTimer) {
      clearTimeout(this.diffTimer);
      this.diffTimer = null;
    }
    this.pendingSnapshot = null;
    if (!snapshot) this.pendingDiff = null;
    this.detectDirty = false;
    try {
      logger.info('graph.push flush_detector', {
        kind: snapshot ? 'snapshot' : 'diff',
        version: snapshot ? snapshot.version : diff?.version,
        added: diff?.addedEdges?.length,
        updated: diff?.updatedEdges?.length,
        queue_depth: this.queue.length,
      });
    } catch {}
    if (snapshot) {
      await this.enqueueJob('snapshot', snapshot);
      return true;
    }
    if (diff) {
      await this.enqueueJob('diff', diff);
      return true;
    }
    return false;
  }
}

export const graphPushOrchestrator = new GraphPushOrchestrator();

export const pushArbGraphSnapshot = (snapshot: GraphSnapshot) => graphPushOrchestrator.enqueueSnapshot(snapshot);

export const pushArbGraphDiff = (diff: GraphDiff) => graphPushOrchestrator.enqueueDiff(diff);

export const setArbStreamEnabled = (enabled: boolean) => graphPushOrchestrator.setStreamEnabled(enabled);

export const isArbStreamEnabled = () => graphPushOrchestrator.isStreamEnabled();

export const notifyArbServiceRefresh = () => notifyArbServiceRefreshImpl();

export const getGraphPushStats = () => graphPushOrchestrator.getStats();

export const getGraphPushStatsRaw = () => graphPushOrchestrator.getStatsRaw();

export const hasDetectDrivenDirty = () => graphPushOrchestrator.peekDetectDirty();

export const flushPendingFromDetector = () => graphPushOrchestrator.flushPendingFromDetector();

