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
  private awaitingDetect = false;
  // Version tracking to prevent duplicate pushes
  private lastAckedVersion: number = 0;
  private inFlightVersion: number | null = null;
  private queuedVersions: Set<number> = new Set();

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
    const version = Number(snapshot.version || 0);
    // Skip if version already acknowledged, in-flight, or queued
    if (version > 0 && version <= this.lastAckedVersion) {
      try { logger.debug('arb.push skip duplicate snapshot', { version, last_acked: this.lastAckedVersion, reason: 'already_acked' }); } catch {}
      return;
    }
    if (version > 0 && version === this.inFlightVersion) {
      try { logger.debug('arb.push skip duplicate snapshot', { version, reason: 'in_flight' }); } catch {}
      return;
    }
    if (version > 0 && this.queuedVersions.has(version)) {
      try { logger.debug('arb.push skip duplicate snapshot', { version, reason: 'already_queued' }); } catch {}
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
    const version = Number(diff.version || 0);
    // Skip if version already acknowledged, in-flight, or queued
    if (version > 0 && version <= this.lastAckedVersion) {
      try { logger.debug('arb.push skip duplicate diff', { version, last_acked: this.lastAckedVersion, reason: 'already_acked' }); } catch {}
      return;
    }
    if (version > 0 && version === this.inFlightVersion) {
      try { logger.debug('arb.push skip duplicate diff', { version, reason: 'in_flight' }); } catch {}
      return;
    }
    if (version > 0 && this.queuedVersions.has(version)) {
      try { logger.debug('arb.push skip duplicate diff', { version, reason: 'already_queued' }); } catch {}
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
      const coalesced = coalesceDiff(this.pendingDiff, diff);
      const coalescedVersion = Number(coalesced.version || 0);
      // Check again after coalescing - might have merged with pending diff that has a higher version
      if (coalescedVersion > 0 && coalescedVersion <= this.lastAckedVersion) {
        try { logger.debug('arb.push skip coalesced diff', { coalesced_version: coalescedVersion, last_acked: this.lastAckedVersion, reason: 'already_acked' }); } catch {}
        this.pendingDiff = null;
        return;
      }
      if (coalescedVersion > 0 && coalescedVersion === this.inFlightVersion) {
        try { logger.debug('arb.push skip coalesced diff', { coalesced_version: coalescedVersion, reason: 'in_flight' }); } catch {}
        // Keep pending diff if it's different from in-flight version
        if (this.pendingDiff && Number(this.pendingDiff.version || 0) !== coalescedVersion) {
          // Keep existing pending
        } else {
          this.pendingDiff = null;
        }
        return;
      }
      if (coalescedVersion > 0 && this.queuedVersions.has(coalescedVersion)) {
        try { logger.debug('arb.push skip coalesced diff', { coalesced_version: coalescedVersion, reason: 'already_queued' }); } catch {}
        // Keep pending diff if it's different
        if (this.pendingDiff && Number(this.pendingDiff.version || 0) !== coalescedVersion) {
          // Keep existing pending
        } else {
          this.pendingDiff = null;
        }
        return;
      }
      this.pendingDiff = coalesced;
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
    if (!force && detectMode && (this.awaitingDetect || this.inFlight || this.flushInProgress)) {
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
      const detectMode = this.shouldWaitForDetect();
      this.awaitingDetect = detectMode;
      try {
        logger.info('graph.push flush_start', {
          kind: snapshot ? 'snapshot' : 'diff',
          version: snapshot ? snapshot.version : diff?.version,
          added: diff?.addedEdges?.length,
          updated: diff?.updatedEdges?.length,
          removed: diff?.removedEdgeIds?.length,
          detect_mode: detectMode,
        });
      } catch {}
      if (snapshot) {
        await this.enqueueJob('snapshot', snapshot);
      } else if (diff) {
        await this.enqueueJob('diff', diff);
      }
    } finally {
      this.awaitingDetect = false;
      this.flushInProgress = false;
      if (this.pendingSnapshot || this.pendingDiff) {
        this.scheduleFlush();
      }
    }
  }

  private async enqueueJob(kind: GraphPushKind, payload: any): Promise<void> {
    return new Promise((resolve, reject) => {
      const version = Number(payload?.version || 0);
      // Track version when added to queue
      if (version > 0) {
        this.queuedVersions.add(version);
      }
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
        const wantVersion = Number(job.kind === 'snapshot' ? job.payload?.version : job.payload?.version) || 0;
        
        // Remove from queuedVersions since we're now processing it
        if (wantVersion > 0) {
          this.queuedVersions.delete(wantVersion);
          this.inFlightVersion = wantVersion;
        }
        
        if (!this.arbStreamEnabled) {
          // Clear in-flight tracking since we're not actually sending
          if (wantVersion > 0) {
            this.inFlightVersion = null;
            // If not sent, we should update lastAckedVersion to prevent re-queuing
            // But actually, if stream is disabled, we shouldn't track it
          }
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
          // Clear in-flight tracking on failure
          if (wantVersion > 0 && this.inFlightVersion === wantVersion) {
            this.inFlightVersion = null;
          }
        }

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
              // Update lastAckedVersion when ACK succeeds
              if (acked && wantVersion > this.lastAckedVersion) {
                this.lastAckedVersion = wantVersion;
                try { logger.debug('arb.push version acked', { version: wantVersion, last_acked: this.lastAckedVersion }); } catch {}
              }
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

        // Clear in-flight tracking after job completes
        if (wantVersion > 0 && this.inFlightVersion === wantVersion) {
          this.inFlightVersion = null;
        }

        job.resolve();
        this.resolveWaiters();

        if (job.kind === 'snapshot' && this.queue.length) {
          // When a snapshot is processed, remove all non-snapshot jobs (snapshots supersede diffs)
          // Also clean up versions for removed jobs
          const beforeCleanup = this.queue.length;
          this.queue = this.queue.filter((j) => {
            if (j.kind === 'snapshot') {
              // Keep snapshot jobs
              return true;
            }
            // Remove non-snapshot jobs and clean up their version tracking
            const v = Number(j.payload?.version || 0);
            if (v > 0) {
              this.queuedVersions.delete(v);
            }
            return false;
          });
          if (beforeCleanup > this.queue.length) {
            try { logger.debug('arb.push snapshot cleanup', { removed: beforeCleanup - this.queue.length, remaining: this.queue.length }); } catch {}
          }
        }
      }
    } finally {
      this.inFlight = false;
      this.inFlightVersion = null;
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
    if (!this.pendingSnapshot && !this.pendingDiff) {
      this.detectDirty = false;
      return false;
    }
    if (this.flushInProgress || this.inFlight || this.awaitingDetect) {
      this.detectDirty = true;
      return false;
    }
    
    // Check for duplicates before flushing
    const snapshot = this.pendingSnapshot;
    const diff = snapshot ? null : this.pendingDiff;
    const version = snapshot ? Number(snapshot.version || 0) : (diff ? Number(diff.version || 0) : 0);
    
    if (version > 0) {
      // Skip if already acknowledged, in-flight, or queued
      if (version <= this.lastAckedVersion) {
        try { logger.debug('arb.push detector_flush skip duplicate', { version, last_acked: this.lastAckedVersion, reason: 'already_acked' }); } catch {}
        this.pendingSnapshot = null;
        this.pendingDiff = null;
        this.detectDirty = false;
        return false;
      }
      if (version === this.inFlightVersion) {
        try { logger.debug('arb.push detector_flush skip duplicate', { version, reason: 'in_flight' }); } catch {}
        this.detectDirty = true; // Keep dirty so we retry later
        return false;
      }
      if (this.queuedVersions.has(version)) {
        try { logger.debug('arb.push detector_flush skip duplicate', { version, reason: 'already_queued' }); } catch {}
        this.detectDirty = true; // Keep dirty so we retry later
        return false;
      }
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
    const detectMode = this.shouldWaitForDetect();
    this.awaitingDetect = detectMode;
    this.detectDirty = false;
    try {
      logger.info('graph.push detector_trigger_flush', {
        kind: snapshot ? 'snapshot' : 'diff',
        version: snapshot ? snapshot.version : diff?.version,
        added: diff?.addedEdges?.length,
        updated: diff?.updatedEdges?.length,
        detect_mode: detectMode,
        queue_depth: this.queue.length,
      });
    } catch {}
    try {
      if (snapshot) {
        await this.enqueueJob('snapshot', snapshot);
        return true;
      }
      if (diff) {
        await this.enqueueJob('diff', diff);
        return true;
      }
      return false;
    } finally {
      this.awaitingDetect = false;
    }
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

export async function flushPendingFromDetector(): Promise<boolean> {
  return graphPushOrchestrator.flushPendingFromDetector();
}

