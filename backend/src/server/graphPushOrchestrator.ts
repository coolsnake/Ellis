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
  private waiters: Waiter[] = [];
  private flushHandle: NodeJS.Timeout | null = null;
  private flushInProgress = false;
  // Version tracking to prevent duplicate pushes
  private lastAckedVersion: number = 0;
  private inFlightVersion: number | null = null;
  private queuedVersions: Set<number> = new Set();
  private cancelToken = 0;
  private lastCancelReason: string | null = null;

  constructor() {
    this.diffCoalesceMs = getDiffCoalesceMs();
  }

  setStreamEnabled(enabled: boolean): void {
    this.arbStreamEnabled = !!enabled;
    try {
      logger.info('arb:stream state', { enabled: this.arbStreamEnabled });
    } catch {}
    if (this.arbStreamEnabled) {
      this.lastCancelReason = null;
      this.scheduleFlush();
      return;
    }
    this.requestJobCancel('arb_stream_disabled');
    if (this.flushHandle) {
      clearTimeout(this.flushHandle);
      this.flushHandle = null;
    }
    this.clearPending();
    this.resolveWaiters();
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
    // Use < instead of <= to allow equal versions (valid retry after network failure)
    if (version > 0 && version < this.lastAckedVersion) {
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
      logger.debug('graph.push enqueue', {
        kind: 'snapshot',
        version: snapshot.version,
        nodes: Array.isArray(snapshot.nodes) ? snapshot.nodes.length : undefined,
        edges: Array.isArray(snapshot.edges) ? snapshot.edges.length : undefined,
      });
    } catch {}
    this.pendingSnapshot = snapshot;
    this.pendingDiff = null;
    if (this.diffTimer) {
      clearTimeout(this.diffTimer);
      this.diffTimer = null;
    }
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
    // Use < instead of <= to allow equal versions (valid retry after network failure)
    if (version > 0 && version < this.lastAckedVersion) {
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
      logger.debug('graph.push enqueue', {
        kind: 'diff',
        version: diff.version,
        added: diff.addedEdges?.length,
        updated: diff.updatedEdges?.length,
        removed: diff.removedEdgeIds?.length,
      });
    } catch {}
    const apply = () => {
      const coalesced = coalesceDiff(this.pendingDiff, diff);
      const coalescedVersion = Number(coalesced.version || 0);
      // Check again after coalescing - might have merged with pending diff that has a higher version
      // Use < instead of <= to allow equal versions (valid retry after network failure)
      if (coalescedVersion > 0 && coalescedVersion < this.lastAckedVersion) {
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

  clearPending(): void {
    this.pendingSnapshot = null;
    this.pendingDiff = null;
    this.queuedVersions.clear();
    if (this.diffTimer) {
      clearTimeout(this.diffTimer);
      this.diffTimer = null;
    }
    try { logger.info('arb.push.cleared_pending', { cat: 'arb' }); } catch {}
  }

  private scheduleFlush(force = false): void {
    if (!this.arbStreamEnabled) return;
    if (!this.pendingSnapshot && !this.pendingDiff) return;
    if (this.flushInProgress) return;
    if (this.flushHandle) return;
    
    const delay = force ? 0 : 0; // No coalescing delay - pool-level batching handles it
    this.flushHandle = setTimeout(() => {
      this.flushHandle = null;
      this.flushPending().catch((e) => {
        try { logger.debug('arb.push flush failed', { error: String(e?.message || e) }); } catch {}
        this.rejectWaiters(e);
      });
    }, delay);
    try {
      logger.debug('graph.push flush_scheduled', {
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
    if (!snapshot && !diff) {
      return;
    }

    this.flushInProgress = true;
    this.pendingSnapshot = null;
    if (!snapshot) {
      this.pendingDiff = null;
    }

    try {
      try {
        logger.debug('graph.push flush_start', {
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
        // Schedule flush for any new updates that arrived during processing
        this.scheduleFlush(true);
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
        const jobToken = this.cancelToken;
        const wantVersion = Number(job.kind === 'snapshot' ? job.payload?.version : job.payload?.version) || 0;
        
        // Remove from queuedVersions since we're now processing it
        if (wantVersion > 0) {
          this.queuedVersions.delete(wantVersion);
          this.inFlightVersion = wantVersion;
        }
        
        if (!this.arbStreamEnabled || this.hasJobCancellation(jobToken)) {
          this.handleCancelledJob(job, wantVersion, 'preflight');
          continue;
        }

        const host = ((globalThis as any)?.process?.env?.ARB_SERVICE_URL) || 'http://127.0.0.1:4010';
        const auth = String(((globalThis as any)?.process?.env?.ARB_SHARED_SECRET) || '');
        const headers: Record<string, string> = { 'content-type': 'application/json' };
        if (auth) headers.authorization = `Bearer ${auth}`;

        const url = job.kind === 'snapshot' ? `${host}/arb/graph/snapshot` : `${host}/arb/graph/update`;
        const body = job.kind === 'snapshot' ? JSON.stringify({ graph: job.payload }) : JSON.stringify(job.payload);

        let attempt = 0;
        const maxAttempts = 5;
        let sent = false;
        while (!sent && attempt < maxAttempts) {
          try {
            if (!this.arbStreamEnabled || this.hasJobCancellation(jobToken)) {
              break;
            }
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
          if (!this.arbStreamEnabled || this.hasJobCancellation(jobToken)) {
            this.handleCancelledJob(job, wantVersion, 'send');
            continue;
          }
          try { logger.error('arb.push giveup', { kind: job.kind, attempts: attempt }); } catch {}
          // Clear in-flight tracking on failure
          if (wantVersion > 0 && this.inFlightVersion === wantVersion) {
            this.inFlightVersion = null;
          }
        }

        const start = Date.now();
        // Calculate adaptive timeout based on version gap
        // Base timeout + extra time per version gap to allow processing time
        const baseTimeoutMs = Number((((globalThis as any)?.process?.env?.ARB_ACK_TIMEOUT_MS) || 2500));
        let versionGap = 0;
        try {
          // Use cached version from polling
          const { getCachedArbVersion } = require('./realtime.js');
          const cachedVersion = getCachedArbVersion();
          const arbVersion = cachedVersion.version;
          // Calculate gap for the version we're ACKing, not current backend version
          versionGap = Math.max(0, wantVersion - arbVersion);
          try {
            logger.debug('arb.push ack timeout calculation', {
              wantVersion,
              arbVersion,
              versionGap,
              baseTimeoutMs,
              adaptiveTimeoutMs: Math.min(baseTimeoutMs + (versionGap * 500), baseTimeoutMs * 3),
              cacheAgeMs: cachedVersion.ageMs,
            });
          } catch {}
        } catch {}
        // Add 500ms per version gap, capped at 3x base timeout
        const adaptiveTimeoutMs = Math.min(baseTimeoutMs + (versionGap * 500), baseTimeoutMs * 3);
        const timeoutMs = adaptiveTimeoutMs;

        let acked = false;
        let waited = 0;
        const ackDeadline = start + Math.max(timeoutMs * 2, timeoutMs + 1000);
        const ackBody = JSON.stringify({ version: wantVersion, timeout_ms: timeoutMs });

        if (wantVersion === 0) {
          acked = true;
        } else {
          while (!acked) {
            try {
              if (!this.arbStreamEnabled || this.hasJobCancellation(jobToken)) {
                break;
              }
              const ac = new AbortController();
              const timer = setTimeout(() => ac.abort('timeout'), timeoutMs + 500);
              const res = await fetch(`${host}/arb/graph/ack`, {
                method: 'POST',
                headers,
                body: ackBody,
                signal: ac.signal,
              }).finally(() => clearTimeout(timer));
              if (res?.ok) {
                const j: any = await res.json().catch(() => ({}));
                acked = j?.acked === true;
                if (acked && wantVersion > this.lastAckedVersion) {
                  this.lastAckedVersion = wantVersion;
                  try { logger.debug('arb.push version acked', { version: wantVersion, last_acked: this.lastAckedVersion }); } catch {}
                }
              }
            } catch (err: any) {
              try { logger.debug('arb.push ack attempt failed', { kind: job.kind, error: String(err?.message || err) }); } catch {}
            }

            waited = Date.now() - start;
            if (acked || Date.now() >= ackDeadline) {
              break;
            }
            if (!this.arbStreamEnabled || this.hasJobCancellation(jobToken)) {
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 150));
          }
        }

        if (!this.arbStreamEnabled || this.hasJobCancellation(jobToken)) {
          this.handleCancelledJob(job, wantVersion, 'ack');
          continue;
        }

        if (!acked && wantVersion > 0) {
          try { logger.warn('arb.push ack pending after deadline', { wantVersion, waited_ms: waited }); } catch {}
        }

        if (acked) pushStats.success += 1; else pushStats.failed += 1;
        
        // If we have too many consecutive failures (10+), force a snapshot resync
        if (!acked && pushStats.failed >= 10 && pushStats.success < 3) {
          try {
            logger.warn('arb.push excessive failures, triggering resync', { 
              failed: pushStats.failed, 
              success: pushStats.success 
            });
            
            // Clear the queue and send a fresh snapshot
            this.queue.length = 0;
            this.queuedVersions.clear();
            
            const { getGraphSnapshot } = await import('./graph.js');
            const snap = await getGraphSnapshot(true);
            if (snap && Array.isArray((snap as any).edges) && (snap as any).edges.length > 0) {
              // Reset stats before enqueueing
              pushStats.success = 0;
              pushStats.failed = 0;
              await this.enqueueSnapshot(snap);
            }
          } catch (e: any) {
            try {
              logger.error('arb.push resync failed', { error: String(e?.message || e) });
            } catch {}
          }
        }
        
        pushBounded(pushStats.ackMs, waited);
        try {
          logger.info('arb.push ack', { kind: job.kind, acked, waited_ms: waited, wantVersion, queue_depth: this.queue.length, push_success: pushStats.success, push_failed: pushStats.failed });
        } catch {}

        // Removed notifyArbServiceRefreshImpl() - it was causing duplicate detection cycles.
        // The ack mechanism already ensures arb-rs processes the update; no need to wake it again.

        // Clear in-flight tracking after job completes
        if (wantVersion > 0 && this.inFlightVersion === wantVersion) {
          this.inFlightVersion = null;
        }

        job.resolve();
        this.resolveWaiters();

        if (job.kind === 'snapshot' && this.queue.length) {
          // When a snapshot is processed, we need smarter cleanup:
          // - Remove OLDER diffs (version < snapshot version) - they're superseded
          // - Keep NEWER diffs (version > snapshot version) - they supersede the snapshot
          const beforeCleanup = this.queue.length;
          const snapshotVersion = Number(job.payload?.version || 0);
          
          this.queue = this.queue.filter((j) => {
            if (j.kind === 'snapshot') {
              // Keep snapshot jobs
              return true;
            }
            // For diff jobs: remove only if older than snapshot
            const diffVersion = Number(j.payload?.version || 0);
            if (diffVersion > 0 && diffVersion < snapshotVersion) {
              // Older diff - remove it (superseded by snapshot)
              if (diffVersion > 0) {
                this.queuedVersions.delete(diffVersion);
              }
              return false;
            }
            // Newer diff - keep it (will supersede snapshot when processed)
            return true;
          });
          
          if (beforeCleanup > this.queue.length) {
            try { 
              logger.debug('arb.push snapshot cleanup', { 
                removed: beforeCleanup - this.queue.length, 
                remaining: this.queue.length,
                snapshot_version: snapshotVersion
              }); 
            } catch {}
          }
        }
      }
    } finally {
      this.inFlight = false;
      this.inFlightVersion = null;
      // CRITICAL FIX: After processing queue completes, check if new diffs arrived
      // during processing and schedule a flush
      if (this.pendingSnapshot || this.pendingDiff) {
        this.scheduleFlush(true); // Force flush since we just finished a cycle
      }
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

  private handleCancelledJob(job: ArbJob, wantVersion: number, phase: string): void {
    const reason = this.lastCancelReason || (this.arbStreamEnabled ? 'cancelled' : 'arb_stream_disabled');
    try {
      logger.info('arb.push job_cancelled', { reason, phase, kind: job.kind, version: wantVersion });
    } catch {}
    if (wantVersion > 0 && this.inFlightVersion === wantVersion) {
      this.inFlightVersion = null;
    }
    job.resolve();
    this.resolveWaiters();
  }

  private requestJobCancel(reason: string): void {
    this.cancelToken += 1;
    this.lastCancelReason = reason || 'cancelled';
  }

  private hasJobCancellation(jobToken: number): boolean {
    return this.cancelToken !== jobToken;
  }

  hasPendingUpdates(): boolean {
    return !!this.pendingSnapshot || !!this.pendingDiff;
  }

  async flushPendingFromDetector(): Promise<boolean> {
    // Simplified: just call flushPending() - no special detector logic needed
    if (!this.arbStreamEnabled) {
      return false;
    }
    if (!this.pendingSnapshot && !this.pendingDiff) {
      return false;
    }
    if (this.flushInProgress) {
      return false; // Already flushing
    }
    
    // Just call the normal flush method
    await this.flushPending();
    return true;
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

export const clearPendingGraphUpdates = () => graphPushOrchestrator.clearPending();

export const hasDetectDrivenDirty = () => graphPushOrchestrator.hasPendingUpdates();

export async function flushPendingFromDetector(): Promise<boolean> {
  return graphPushOrchestrator.flushPendingFromDetector();
}

