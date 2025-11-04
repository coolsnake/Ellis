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

const DETECT_ACK_MODE = String(
  ((globalThis as any)?.process?.env?.ARB_DETECT_ACK_MODE)
    ?? ((globalThis as any)?.process?.env?.ARB_DETECT_ACK_ENABLED)
    ?? ((globalThis as any)?.process?.env?.ARB_DETECT_ACK)
    ?? ''
).toLowerCase();

const DETECT_ACK_ENABLED = DETECT_ACK_MODE === ''
  ? true
  : ['1', 'true', 'yes', 'on'].includes(DETECT_ACK_MODE);

const DETECT_ACK_TIMEOUT_MS = Math.max(
  1000,
  Number(
    ((globalThis as any)?.process?.env?.ARB_DETECT_ACK_TIMEOUT_MS)
      ?? ((globalThis as any)?.process?.env?.GRAPH_DETECT_ACK_TIMEOUT_MS)
      ?? 8000,
  ),
);

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
  private readonly detectorAckEnabled = DETECT_ACK_ENABLED;
  private readonly detectWaitTimeoutMs: number;
  private resolvePendingDetect: (() => void) | null = null;
  private lastDetectCompleteMs = 0;
  private lastDetectCompleteVersion = 0;
  private pendingSinceMs: number = 0;
  private fallbackFlushTimer: NodeJS.Timeout | null = null;
  private readonly fallbackFlushTimeoutMs: number;

  constructor() {
    this.diffCoalesceMs = getDiffCoalesceMs();
    this.detectCoalesceMs = getDetectDrivenPushCoalesceMs();
    this.detectWaitTimeoutMs = DETECT_ACK_TIMEOUT_MS;
    // Fallback: if updates are pending for more than this, force flush even without ACK
    // Default to 2x the detect wait timeout, but allow override via env
    const defaultFallback = Math.max(this.detectWaitTimeoutMs * 2, 10000);
    this.fallbackFlushTimeoutMs = Number(
      ((globalThis as any)?.process?.env?.ARB_FALLBACK_FLUSH_TIMEOUT_MS) || defaultFallback
    );
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
    this.pendingSinceMs = Date.now();
    this.scheduleFallbackFlush();
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
    if (this.pendingSinceMs === 0) {
      this.pendingSinceMs = Date.now();
      this.scheduleFallbackFlush();
    } else {
      // Check if we've been waiting too long without a flush
      const elapsed = Date.now() - this.pendingSinceMs;
      const maxWait = this.detectCoalesceMs * 2;
      if (elapsed > maxWait && this.shouldWaitForDetect()) {
        // Force a flush if we've been waiting too long
        try {
          logger.debug('graph.push force_flush_long_wait', {
            elapsed_ms: elapsed,
            max_wait_ms: maxWait,
            pending_version: diff.version,
            cat: 'graph',
          });
        } catch {}
        this.scheduleFlush(true);
      }
    }
    const apply = () => {
      const coalesced = coalesceDiff(this.pendingDiff, diff);
      const coalescedVersion = Number(coalesced.version || 0);
      // Check again after coalescing - might have merged with pending diff that has a higher version
      // Use < instead of <= to allow equal versions (valid retry after network failure)
      if (coalescedVersion > 0 && coalescedVersion < this.lastAckedVersion) {
        try { logger.debug('arb.push skip coalesced diff', { coalesced_version: coalescedVersion, last_acked: this.lastAckedVersion, reason: 'already_acked' }); } catch {}
        this.pendingDiff = null;
        if (!this.pendingSnapshot) {
          this.cancelFallbackFlush();
        }
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

  markDetectorComplete(info: { version?: number; completedMs?: number }): void {
    const msRaw = Number(info?.completedMs ?? Date.now());
    if (Number.isFinite(msRaw) && msRaw > 0) {
      this.lastDetectSeen = Math.max(this.lastDetectSeen, msRaw);
      this.lastDetectCompleteMs = Math.max(this.lastDetectCompleteMs, msRaw);
    }
    const versionRaw = Number(info?.version ?? 0);
    const arbRsVersion = versionRaw > 0 ? versionRaw : this.lastDetectCompleteVersion;
    if (Number.isFinite(versionRaw) && versionRaw > 0) {
      this.lastDetectCompleteVersion = Math.max(this.lastDetectCompleteVersion, versionRaw);
    }
    if (this.resolvePendingDetect) {
      const resolver = this.resolvePendingDetect;
      this.resolvePendingDetect = null;
      try { resolver(); } catch {}
    }
    
    // CRITICAL: Check version gap - ensure arb-rs gets updates before next detection cycle
    try {
      const { getGraphVersion } = require('./graph.js');
      const backendVersion = getGraphVersion().version;
      
      if (backendVersion > arbRsVersion) {
        const versionGap = backendVersion - arbRsVersion;
        try {
          logger.info('graph.push version_gap_detected', {
            arb_rs_version: arbRsVersion,
            backend_version: backendVersion,
            gap: versionGap,
            cat: 'graph',
          });
        } catch {}
        
        // Force immediate flush with no coalescing to close version gap
        // IMPORTANT: Bypass blocking conditions when version gap exists - version gap takes priority
        if (this.pendingSnapshot || this.pendingDiff) {
          this.cancelFallbackFlush();
          // Force flush even if blocking conditions are true - version gap takes priority
          this.scheduleFlush(true); // Force flush - will skip coalescing in scheduleFlush
          // Also try direct flush from detector to bypass blocks
          try {
            void this.flushPendingFromDetector();
          } catch (err) {
            // If flush fails, scheduleFlush above will still attempt it
            try {
              logger.debug('graph.push version_gap_flush_failed', {
                error: String((err as any)?.message || err),
                cat: 'graph',
              });
            } catch {}
          }
        } else if (backendVersion > arbRsVersion) {
          // No pending updates but version gap exists - this shouldn't happen normally
          // Log warning but don't force rebuild (updates might be in flight)
          try {
            logger.warn('graph.push version_gap_no_pending', {
              arb_rs_version: arbRsVersion,
              backend_version: backendVersion,
              gap: versionGap,
              in_flight: this.inFlight,
              flush_in_progress: this.flushInProgress,
              cat: 'graph',
            });
          } catch {}
        }
      }
    } catch (err) {
      // If getGraphVersion fails, fall back to existing logic
      try {
        logger.debug('graph.push version_gap_check_failed', {
          error: String((err as any)?.message || err),
          cat: 'graph',
        });
      } catch {}
      
      // Fallback: Use existing logic if version check fails
      if (!this.flushInProgress && !this.inFlight && (this.pendingSnapshot || this.pendingDiff)) {
        this.cancelFallbackFlush();
        this.scheduleFlush(true);
      }
    }
  }

  private scheduleFallbackFlush(): void {
    // Cancel existing fallback timer if any
    if (this.fallbackFlushTimer) {
      clearTimeout(this.fallbackFlushTimer);
      this.fallbackFlushTimer = null;
    }
    
    // Only schedule if we have pending updates and detect mode is active
    if (!this.pendingSnapshot && !this.pendingDiff) {
      return;
    }
    if (!this.shouldWaitForDetect()) {
      return; // Not in detect mode, normal flush will handle it
    }

    const elapsed = Date.now() - this.pendingSinceMs;
    const remaining = Math.max(0, this.fallbackFlushTimeoutMs - elapsed);
    
    this.fallbackFlushTimer = setTimeout(() => {
      this.fallbackFlushTimer = null;
      if (!this.pendingSnapshot && !this.pendingDiff) {
        return; // Already flushed
      }
      try {
        logger.warn('arb.push fallback_flush triggered', {
          pending_since_ms: this.pendingSinceMs,
          elapsed_ms: Date.now() - this.pendingSinceMs,
          pending_snapshot: !!this.pendingSnapshot,
          pending_diff: !!this.pendingDiff,
          diff_version: this.pendingDiff?.version,
          reason: 'timeout_no_ack',
          cat: 'graph',
        });
      } catch {}
      // Force flush even without detection ACK
      this.scheduleFlush(true);
    }, remaining);
  }

  private cancelFallbackFlush(): void {
    if (this.fallbackFlushTimer) {
      clearTimeout(this.fallbackFlushTimer);
      this.fallbackFlushTimer = null;
    }
    this.pendingSinceMs = 0;
  }

  private scheduleFlush(force = false): void {
    if (!this.arbStreamEnabled) return;
    if (!this.pendingSnapshot && !this.pendingDiff) return;
    
    // Check version gap FIRST - if gap exists and we're forcing, bypass flushInProgress check
    const detectMode = this.shouldWaitForDetect();
    let skipCoalescing = force;
    let hasVersionGap = false;
    
    if (detectMode) {
      try {
        const { getGraphVersion } = require('./graph.js');
        const backendVersion = getGraphVersion().version;
        // Use lastDetectCompleteVersion here since scheduleFlush is synchronous
        // The async flushPendingFromDetector will use the cached version
        const arbVersion = this.lastDetectCompleteVersion || 0;
        
        if (backendVersion > arbVersion) {
          hasVersionGap = true;
          skipCoalescing = true;
          try {
            logger.info('graph.push force_flush_version_gap', {
              arb_rs_version: arbVersion,
              backend_version: backendVersion,
              gap: backendVersion - arbVersion,
              cat: 'graph',
            });
          } catch {}
        }
      } catch (err) {
        // If version check fails, continue
      }
    }
    
    // Only block flushInProgress if there's no version gap
    if (!hasVersionGap && this.flushInProgress) return;
    
    // Only block if awaitingDetect or flushInProgress (and not forcing/skipping coalescing)
    if (!skipCoalescing && detectMode && (this.awaitingDetect || this.flushInProgress)) {
      this.detectDirty = true;
      try {
        logger.info('graph.push wait_for_detect', {
          pending_snapshot: !!this.pendingSnapshot,
          pending_diff: !!this.pendingDiff,
          diff_version: this.pendingDiff?.version,
          queue_depth: this.queue.length,
          awaiting_detect: this.awaitingDetect,
          flush_in_progress: this.flushInProgress,
        });
      } catch {}
      return;
    }
    if (this.flushHandle) return;
    const delay = skipCoalescing ? 0 : this.detectCoalesceMs;
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
    if (!snapshot && !diff) {
      this.cancelFallbackFlush();
      return;
    }

    this.flushInProgress = true;
    this.pendingSnapshot = null;
    if (!snapshot) {
      this.pendingDiff = null;
    }
    this.cancelFallbackFlush(); // Cancel fallback since we're flushing

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
        // Check if there's still a version gap - if so, use flushPendingFromDetector to bypass blocks
        // Use IIFE to handle async properly in finally block
        (async () => {
          try {
            const { getGraphVersion } = require('./graph.js');
            const backendVersion = getGraphVersion().version;
            // Use the most recent version from polling cache, not just lastDetectCompleteVersion
            const { getCachedArbVersion } = await import('./realtime.js');
            const cachedVersion = getCachedArbVersion();
            const arbVersion = cachedVersion.version;
            const cacheAgeMs = cachedVersion.ageMs;
            
            // Prefer cached version if fresh (< 10 seconds), otherwise use lastDetectCompleteVersion
            const effectiveArbVersion = cacheAgeMs < 10000 ? arbVersion : (this.lastDetectCompleteVersion || 0);
            
            if (backendVersion > effectiveArbVersion) {
              // Version gap still exists - force flush via detector path to bypass all blocks
              try {
                logger.info('graph.push post_flush_version_gap', {
                  arb_rs_version: effectiveArbVersion,
                  backend_version: backendVersion,
                  gap: backendVersion - effectiveArbVersion,
                  cache_age_ms: cacheAgeMs,
                  using_cached: cacheAgeMs < 10000,
                  cat: 'graph',
                });
              } catch {}
              // Use flushPendingFromDetector which bypasses blocking conditions
              // Await it properly and handle errors
              try {
                await this.flushPendingFromDetector();
              } catch (err) {
                // Fallback to normal scheduleFlush if flushPendingFromDetector fails
                try {
                  logger.warn('graph.push post_flush_detector_failed', {
                    error: String((err as any)?.message || err),
                    cat: 'graph',
                  });
                } catch {}
                this.scheduleFlush(true);
              }
            } else {
              // No version gap, use normal scheduling
              this.scheduleFlush(true);
            }
          } catch (err) {
            // If version check fails, fall back to normal scheduling
            try {
              logger.debug('graph.push post_flush_version_check_failed', {
                error: String((err as any)?.message || err),
                cat: 'graph',
              });
            } catch {}
            this.scheduleFlush(true);
          }
        })();
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

        const baselineDetectionMs = Number(before.last_detection_ms || 0);
        if (this.shouldWaitForDetect()) {
          await this.waitForDetectorCompletion(baselineDetectionMs);
        } else {
          this.lastDetectSeen = Math.max(this.lastDetectSeen, baselineDetectionMs);
        }

        await notifyArbServiceRefreshImpl();

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

  private async waitForDetectorCompletion(baselineMs: number): Promise<void> {
    this.lastDetectSeen = Math.max(this.lastDetectSeen, baselineMs);
    if (this.detectorAckEnabled) {
      const acked = await this.waitForDetectorCompletionViaAck(baselineMs);
      if (acked) return;
      try { logger.debug('graph.detect.ack_timeout', { baseline_ms: baselineMs, timeout_ms: this.detectWaitTimeoutMs }); } catch {}
    }
    await this.waitForDetectorCompletionViaPolling(baselineMs);
  }

  private async waitForDetectorCompletionViaAck(baselineMs: number): Promise<boolean> {
    if (this.lastDetectCompleteMs > baselineMs) return true;
    return await new Promise<boolean>((resolve) => {
      let settled = false;
      const finalize = (result: boolean) => {
        if (settled) return;
        settled = true;
        this.resolvePendingDetect = null;
        resolve(result);
      };
      const timer = setTimeout(() => finalize(false), this.detectWaitTimeoutMs);
      const resolver = () => {
        clearTimeout(timer);
        finalize(true);
      };

      if (this.lastDetectCompleteMs > baselineMs) {
        clearTimeout(timer);
        finalize(true);
        return;
      }

      this.resolvePendingDetect = resolver;
    });
  }

  private async waitForDetectorCompletionViaPolling(baselineMs: number): Promise<void> {
    const deadline = Date.now() + this.detectWaitTimeoutMs;
    while (Date.now() < deadline) {
      const cur = await fetchArbMetrics();
      const currentMs = Number(cur.last_detection_ms || 0);
      this.lastDetectSeen = Math.max(this.lastDetectSeen, currentMs);
      if (currentMs > baselineMs) return;
      await new Promise((r) => setTimeout(r, 100));
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
    if (!this.arbStreamEnabled) {
      try { 
        logger.info('arb.push detector_flush blocked', { 
          reason: 'stream_disabled',
          pending_snapshot: !!this.pendingSnapshot,
          pending_diff: !!this.pendingDiff,
          cat: 'graph',
        }); 
      } catch {}
      return false;
    }
    if (!this.pendingSnapshot && !this.pendingDiff) {
      this.detectDirty = false;
      return false;
    }
    
    // Check version gap BEFORE checking blocking conditions
    // Use cached version from polling (getCachedArbVersion) instead of lastDetectCompleteVersion
    // which is only updated on detection completion events and can be stale
    let hasVersionGap = false;
    try {
      const { getGraphVersion } = require('./graph.js');
      const backendVersion = getGraphVersion().version;
      // Use cached version from polling, not lastDetectCompleteVersion (which can be stale)
      const { getCachedArbVersion } = await import('./realtime.js');
      const cachedVersion = getCachedArbVersion();
      const arbVersion = cachedVersion.version;
      const cacheAgeMs = cachedVersion.ageMs;
      
      // Only use cached version if it's relatively fresh (< 10 seconds old)
      // Otherwise fall back to lastDetectCompleteVersion
      const effectiveArbVersion = cacheAgeMs < 10000 ? arbVersion : (this.lastDetectCompleteVersion || 0);
      
      // Use cached version if fresh, otherwise fall back to lastDetectCompleteVersion
      const arbVersionToCheck = cacheAgeMs < 10000 ? arbVersion : (this.lastDetectCompleteVersion || 0);
      
      if (backendVersion > arbVersionToCheck) {
        hasVersionGap = true;
        const versionGap = backendVersion - arbVersionToCheck;
        try {
          logger.info('graph.push detector_flush_version_gap', {
            arb_rs_version: arbVersionToCheck,
            backend_version: backendVersion,
            gap: versionGap,
            cache_age_ms: cacheAgeMs,
            using_cached: cacheAgeMs < 10000,
            cat: 'graph',
          });
        } catch {}
      }
    } catch (err) {
      // If version check fails, continue with normal logic
    }
    
    // Allow flush if detection completion was recently signaled (within 5 seconds)
    // OR if there's a version gap (we MUST close the gap)
    // This means the system just detected completion and is ready to flush
    const recentlyCompleted = this.lastDetectCompleteMs > 0 && 
      (Date.now() - this.lastDetectCompleteMs) < 5000;
    const shouldBypassBlock = recentlyCompleted || hasVersionGap;
    
    // Block if:
    // - A flush is in progress AND we shouldn't bypass (existing flush will proceed)
    // - Queue is being processed AND we shouldn't bypass (inFlight is normal during processing)
    // - Awaiting detect AND we shouldn't bypass (this means we're still waiting)
    if ((this.flushInProgress && !shouldBypassBlock) || 
        (this.inFlight && !shouldBypassBlock) || 
        (this.awaitingDetect && !shouldBypassBlock)) {
      try { 
        logger.info('arb.push detector_flush blocked', { 
          reason: 'busy', 
          flushInProgress: this.flushInProgress,
          inFlight: this.inFlight,
          awaitingDetect: this.awaitingDetect,
          recently_completed: recentlyCompleted,
          has_version_gap: hasVersionGap,
          last_detect_complete_ms: this.lastDetectCompleteMs,
          pending_snapshot: !!this.pendingSnapshot,
          pending_diff: !!this.pendingDiff,
          diff_version: this.pendingDiff?.version,
          queue_depth: this.queue.length,
          cat: 'graph',
        }); 
      } catch {}
      this.detectDirty = true;
      return false;
    }
    
    // If version gap exists, log that we're bypassing blocks
    if (hasVersionGap) {
      try {
        logger.info('graph.push detector_flush_bypassing_for_gap', {
          flush_in_progress: this.flushInProgress,
          in_flight: this.inFlight,
          awaiting_detect: this.awaitingDetect,
          cat: 'graph',
        });
      } catch {}
    }
    
    // Check for duplicates before flushing
    const snapshot = this.pendingSnapshot;
    const diff = snapshot ? null : this.pendingDiff;
    const version = snapshot ? Number(snapshot.version || 0) : (diff ? Number(diff.version || 0) : 0);
    
    if (version > 0) {
      // Skip if already acknowledged, in-flight, or queued
      // Use < instead of <= to allow equal versions (valid retry after network failure)
      if (version < this.lastAckedVersion) {
        try { logger.debug('arb.push detector_flush skip duplicate', { version, last_acked: this.lastAckedVersion, reason: 'already_acked' }); } catch {}
        this.pendingSnapshot = null;
        this.pendingDiff = null;
        this.cancelFallbackFlush();
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
    this.cancelFallbackFlush(); // Clear fallback timer since we're flushing now
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

export const markDetectorCompleteFromAck = (info: { version?: number; completedMs?: number }) =>
  graphPushOrchestrator.markDetectorComplete(info);

export async function flushPendingFromDetector(): Promise<boolean> {
  return graphPushOrchestrator.flushPendingFromDetector();
}

