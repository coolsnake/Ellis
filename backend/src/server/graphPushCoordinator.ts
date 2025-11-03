import { logger } from '../utils/logger.js';
import type { GraphDiff, GraphSnapshot } from './graph.types.js';

type PushKind = 'diff' | 'snapshot';

type PendingJob =
  | { kind: 'snapshot'; snapshot: GraphSnapshot }
  | { kind: 'diff'; diff: GraphDiff };

type InflightJob = PendingJob & {
  version: number;
  startedAt: number;
  stage: 'push' | 'ack' | 'detect';
  lastDetectionMs: number;
  retries: number;
};

type AckStats = {
  ackMs: number[];
  success: number;
  failed: number;
};

const ACK_SAMPLE_CAP = 200;

function getArbHost(): string {
  try {
    return ((globalThis as any)?.process?.env?.ARB_SERVICE_URL) || 'http://127.0.0.1:4010';
  } catch {
    return 'http://127.0.0.1:4010';
  }
}

function diffKey(edge: any): string {
  if (!edge) return '';
  const pool = String(edge.pool_id || '');
  if (pool) return pool;
  const src = String(edge.source || '');
  const dst = String(edge.target || '');
  const dex = String(edge.dex || '');
  return `${src}|${dst}|${dex}`;
}

function coalesceDiff(base: GraphDiff | null, next: GraphDiff): GraphDiff {
  if (!base) return { ...next };
  const version = Math.max(Number(base.version || 0), Number(next.version || 0));
  const timestamp = Math.max(Number(base.timestamp || 0), Number(next.timestamp || 0), Date.now());

  const removedEdgeIds = Array.from(
    new Set([...(base.removedEdgeIds || []), ...(next.removedEdgeIds || [])].map((s) => String(s)))
  );

  const mergeEdges = (a: any[] | undefined, b: any[] | undefined) => {
    const map = new Map<string, any>();
    for (const item of a || []) {
      const key = diffKey(item);
      if (key) map.set(key, item);
    }
    for (const item of b || []) {
      const key = diffKey(item);
      if (key) map.set(key, item);
    }
    return Array.from(map.values());
  };

  const addedEdges = mergeEdges(base.addedEdges, next.addedEdges);
  const updatedEdges = mergeEdges(base.updatedEdges, next.updatedEdges);

  return {
    version,
    timestamp,
    addedNodes: [],
    updatedNodes: [],
    removedNodeIds: [],
    addedEdges,
    updatedEdges,
    removedEdgeIds,
  };
}

function pushBounded(arr: number[], value: number, cap = ACK_SAMPLE_CAP): void {
  if (!Number.isFinite(value)) return;
  arr.push(value);
  if (arr.length > cap) arr.shift();
}

class GraphPushCoordinator {
  private streamEnabled = false;
  private pendingSnapshot: GraphSnapshot | null = null;
  private pendingDiff: GraphDiff | null = null;
  private inflight: InflightJob | null = null;
  private flushScheduled = false;
  private awaitDetectVersion: number | null = null;
  private latestDetectionMs = 0;
  private stats: AckStats = { ackMs: [], success: 0, failed: 0 };

  submitSnapshot(snapshot: GraphSnapshot): void {
    try {
      this.pendingSnapshot = snapshot;
      this.pendingDiff = null;
      logger.debug('graph.push.coordinator snapshot enqueued', {
        version: snapshot?.version,
        edges: Array.isArray(snapshot?.edges) ? snapshot.edges.length : undefined,
      });
    } catch {}
    this.scheduleFlush();
  }

  submitDiff(diff: GraphDiff): void {
    try {
      this.pendingDiff = coalesceDiff(this.pendingDiff, diff);
      logger.debug('graph.push.coordinator diff enqueued', {
        version: diff?.version,
        added: diff?.addedEdges?.length || 0,
        updated: diff?.updatedEdges?.length || 0,
        removed: diff?.removedEdgeIds?.length || 0,
      });
    } catch {}
    this.scheduleFlush();
  }

  setStreamEnabled(enabled: boolean): void {
    this.streamEnabled = !!enabled;
    if (enabled) {
      this.scheduleFlush(true);
    }
  }

  markDetectorComplete(lastDetectionMs: number): void {
    const ms = Number(lastDetectionMs || 0);
    if (ms <= this.latestDetectionMs) return;
    this.latestDetectionMs = ms;
    if (this.inflight && this.inflight.stage === 'detect' && this.awaitDetectVersion === this.inflight.version) {
      logger.debug('graph.push.coordinator detection finished', { version: this.inflight.version, lastDetectionMs: ms });
      this.continueAfterDetection();
    }
  }

  getStats(): { count: number; p50: number | null; p95: number | null; success: number; failed: number } {
    const { ackMs, success, failed } = this.stats;
    const pct = (arr: number[], p: number): number | null => {
      if (!arr.length) return null;
      const sorted = arr.slice().sort((a, b) => a - b);
      const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(((p / 100) * (sorted.length - 1)))));
      return sorted[idx] ?? null;
    };
    return { count: this.stats.ackMs.length, p50: pct(ackMs, 50), p95: pct(ackMs, 95), success, failed };
  }

  getStatsRaw(): AckStats {
    return { ackMs: this.stats.ackMs.slice(), success: this.stats.success, failed: this.stats.failed };
  }

  private scheduleFlush(force = false): void {
    if (!force && this.flushScheduled) return;
    this.flushScheduled = true;
    setImmediate(() => {
      this.flushScheduled = false;
      void this.flush();
    });
  }

  private async flush(): Promise<void> {
    if (!this.streamEnabled) return;
    if (this.inflight) return;

    const job = this.dequeueJob();
    if (!job) return;

    const version = job.kind === 'snapshot' ? Number(job.snapshot.version || 0) : Number(job.diff.version || 0);
    this.inflight = {
      ...job,
      version,
      startedAt: Date.now(),
      stage: 'push',
      lastDetectionMs: this.latestDetectionMs,
      retries: 0,
    };

    try {
      await this.push(job);
      await this.requestAck(version);
      this.finishJob();
    } catch (error) {
      logger.error('graph.push.coordinator push failed', { error: String((error as any)?.message || error) });
      this.stats.failed += 1;
      this.finishJob();
    }
  }

  private dequeueJob(): PendingJob | null {
    if (this.pendingSnapshot) {
      const snap = this.pendingSnapshot;
      this.pendingSnapshot = null;
      this.pendingDiff = null;
      return { kind: 'snapshot', snapshot: snap };
    }
    if (this.pendingDiff) {
      const diff = this.pendingDiff;
      this.pendingDiff = null;
      return { kind: 'diff', diff };
    }
    return null;
  }

  private async push(job: PendingJob): Promise<void> {
    const host = getArbHost();
    const url = job.kind === 'snapshot' ? `${host}/arb/graph/snapshot` : `${host}/arb/graph/update`;
    const payload = job.kind === 'snapshot' ? { graph: job.snapshot } : job.diff;
    const auth = ((globalThis as any)?.process?.env?.ARB_SHARED_SECRET) || '';
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (auth) headers.authorization = `Bearer ${auth}`;
    let attempt = 0;
    const maxAttempts = 5;
    while (attempt < maxAttempts) {
      attempt += 1;
      try {
        // eslint-disable-next-line no-undef
        const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) });
        if (!res || !res.ok) throw new Error(`status ${res ? (res as any).status : 'unknown'}`);
        logger.info('graph.push.coordinator sent', { kind: job.kind, version: this.inflight?.version, attempt });
        await this.pingArbService();
        return;
      } catch (err) {
        const wait = Math.min(2000 * Math.pow(2, attempt - 1), 15000);
        logger.warn('graph.push.coordinator retry', {
          kind: job.kind,
          version: this.inflight?.version,
          attempt,
          waitMs: wait,
          error: String((err as any)?.message || err),
        });
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
    }
    throw new Error('push failed after retries');
  }

  private async requestAck(version: number): Promise<void> {
    const timeoutMs = Math.max(500, Number(((globalThis as any)?.process?.env?.ARB_ACK_TIMEOUT_MS) || 2500));
    const host = getArbHost();
    const auth = ((globalThis as any)?.process?.env?.ARB_SHARED_SECRET) || '';
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (auth) headers.authorization = `Bearer ${auth}`;

    const start = Date.now();
    try {
      // eslint-disable-next-line no-undef
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort('timeout'), timeoutMs + 500);
      const res = await fetch(`${host}/arb/graph/ack`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ version, timeout_ms: timeoutMs }),
        signal: ac.signal,
      }).finally(() => clearTimeout(timer));

      if (res && res.ok) {
        const json = await res.json().catch(() => ({} as any));
        if (json?.acked) {
          const waited = Date.now() - start;
          pushBounded(this.stats.ackMs, waited);
          this.stats.success += 1;
          logger.info('graph.push.coordinator acked', { version, waitedMs: waited });
          return;
        }
      }
    } catch (err) {
      logger.debug('graph.push.coordinator ack wait failed', { version, error: String((err as any)?.message || err) });
    }

    // Ack timed out; wait for detector completion before retrying
    if (this.inflight) {
      this.inflight.stage = 'detect';
      this.awaitDetectVersion = version;
      this.inflight.retries += 1;
      if (this.inflight.retries >= 3) {
        logger.warn('graph.push.coordinator ack timeout exceeded', { version, retries: this.inflight.retries });
        this.stats.failed += 1;
        this.finishJob();
        return;
      }
      logger.debug('graph.push.coordinator awaiting detection', { version, retries: this.inflight.retries });
    }
  }

  private async continueAfterDetection(): Promise<void> {
    if (!this.inflight) return;
    const version = this.inflight.version;
    this.inflight.stage = 'ack';
    this.awaitDetectVersion = null;
    try {
      await this.requestAck(version);
      if (this.awaitDetectVersion === null) {
        this.finishJob();
      }
    } catch (error) {
      logger.error('graph.push.coordinator post-detect ack failed', {
        version,
        error: String((error as any)?.message || error),
      });
      this.stats.failed += 1;
      this.finishJob();
    }
  }

  private finishJob(): void {
    if (this.inflight) {
      const duration = Date.now() - this.inflight.startedAt;
      try {
        logger.debug('graph.push.coordinator job finished', {
          version: this.inflight.version,
          kind: this.inflight.kind,
          durationMs: duration,
        });
      } catch {}
    }
    this.inflight = null;
    this.awaitDetectVersion = null;
    this.scheduleFlush();
  }

  private async pingArbService(): Promise<void> {
    try {
      const host = getArbHost();
      // eslint-disable-next-line no-undef
      await fetch(`${host}/arb/graph/version`, { method: 'GET', headers: { accept: 'application/json' } });
    } catch {}
  }
}

const coordinator = new GraphPushCoordinator();

export const submitSnapshot = (snapshot: GraphSnapshot): void => {
  coordinator.submitSnapshot(snapshot);
};

export const submitDiff = (diff: GraphDiff): void => {
  coordinator.submitDiff(diff);
};

export const setStreamEnabled = (enabled: boolean): void => {
  coordinator.setStreamEnabled(enabled);
};

export const markDetectorComplete = (lastDetectionMs: number): void => {
  coordinator.markDetectorComplete(lastDetectionMs);
};

export const getGraphPushStats = (): { count: number; p50: number | null; p95: number | null; success: number; failed: number } =>
  coordinator.getStats();

export const getGraphPushStatsRaw = (): AckStats => coordinator.getStatsRaw();

export default coordinator;

