import { Worker } from 'node:worker_threads';

import type { WorkerErrorPayload, WorkerInboundMessage, WorkerOutboundMessage, WorkerClientOptions, RunJobOptions } from './types.js';

type PendingJob<TOut> = {
  id: number;
  resolve: (value: TOut) => void;
  reject: (reason: unknown) => void;
  timeoutHandle: NodeJS.Timeout | null;
  enqueuedAt: number;
};

type QueuedJob<TIn, TOut> = {
  payload: TIn;
  resolve: (value: TOut) => void;
  reject: (reason: unknown) => void;
  options?: RunJobOptions;
};

const DEFAULT_IDLE_TIMEOUT_MS = 30_000;

function reviveError(payload: WorkerErrorPayload | undefined): Error {
  const msg = payload?.message ?? 'Unknown worker error';
  const err = new Error(msg);
  if (payload?.name) err.name = payload.name;
  if (payload?.stack) err.stack = payload.stack;
  if (payload?.code) {
    (err as any).code = payload.code;
  }
  if (payload?.details) {
    (err as any).details = payload.details;
  }
  return err;
}

export class WorkerClient<TIn = unknown, TOut = unknown> {
  private readonly url: URL;
  private readonly name: string;
  private readonly env?: NodeJS.ProcessEnv;
  private readonly workerData?: unknown;
  private readonly maxConcurrency: number;
  private readonly idleTimeoutMs: number;

  private worker: Worker | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private nextJobId = 1;
  private active = 0;
  private readonly queue: Array<QueuedJob<TIn, TOut>> = [];
  private readonly pending = new Map<number, PendingJob<TOut>>();
  private disposed = false;

  constructor(options: WorkerClientOptions) {
    this.url = options.url;
    this.name = options.name;
    this.env = options.env;
    this.workerData = options.workerData;
    this.maxConcurrency = Math.max(1, Math.floor(options.maxConcurrency ?? 1));
    this.idleTimeoutMs = Math.max(0, Math.floor(options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS));
  }

  getQueueSize(): number {
    return this.queue.length;
  }

  getActiveCount(): number {
    return this.pending.size;
  }

  getMaxConcurrency(): number {
    return this.maxConcurrency;
  }

  run(payload: TIn, options?: RunJobOptions): Promise<TOut> {
    if (this.disposed) {
      return Promise.reject(new Error(`Worker ${this.name} is disposed`));
    }
    return new Promise<TOut>((resolve, reject) => {
      this.queue.push({ payload, resolve, reject, options });
      this.pump();
    });
  }

  dispose(): void {
    this.disposed = true;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.worker) {
      this.worker.terminate().catch(() => {});
      this.worker = null;
    }
    for (const [, pending] of this.pending) {
      if (pending.timeoutHandle) clearTimeout(pending.timeoutHandle);
      pending.reject(new Error(`Worker ${this.name} disposed`));
    }
    this.pending.clear();
    while (this.queue.length) {
      const job = this.queue.shift()!;
      job.reject(new Error(`Worker ${this.name} disposed`));
    }
  }

  private pump(): void {
    if (this.disposed) return;
    this.ensureWorker();
    while (this.worker && this.active < this.maxConcurrency && this.queue.length) {
      const job = this.queue.shift()!;
      const id = this.nextJobId++;
      const timeoutMs = Math.max(0, Math.floor(job.options?.timeoutMs ?? 0));

      const pending: PendingJob<TOut> = {
        id,
        resolve: job.resolve,
        reject: job.reject,
        timeoutHandle: null,
        enqueuedAt: Date.now(),
      };

      if (timeoutMs > 0) {
        pending.timeoutHandle = setTimeout(() => {
          this.handleTimeout(id, timeoutMs);
        }, timeoutMs);
      }

      this.pending.set(id, pending);
      this.active += 1;

      const message: WorkerInboundMessage<TIn> = {
        kind: 'job',
        id,
        payload: job.payload,
      };

      try {
        this.worker.postMessage(message);
      } catch (err) {
        this.pending.delete(id);
        if (pending.timeoutHandle) clearTimeout(pending.timeoutHandle);
        this.active -= 1;
        job.reject(err);
      }
    }
    if (this.active === 0 && this.queue.length === 0) {
      this.scheduleIdleTeardown();
    } else {
      this.clearIdleTimer();
    }
  }

  private ensureWorker(): void {
    if (this.worker || this.disposed) return;
    this.clearIdleTimer();
    const worker = new Worker(this.url, {
      name: this.name,
      env: this.env,
      workerData: this.workerData,
      type: 'module',
    });
    worker.on('message', (msg: WorkerOutboundMessage<TOut>) => this.onMessage(msg));
    worker.on('error', (err) => this.onError(err));
    worker.on('exit', (code) => this.onExit(code));
    this.worker = worker;
  }

  private onMessage(msg: WorkerOutboundMessage<TOut>): void {
    if (!msg || msg.kind !== 'result') return;
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    this.pending.delete(msg.id);
    this.active = Math.max(0, this.active - 1);
    if (pending.timeoutHandle) clearTimeout(pending.timeoutHandle);

    if (msg.ok) {
      pending.resolve(msg.result as TOut);
    } else {
      pending.reject(reviveError(msg.error));
    }

    if (!this.disposed) {
      this.pump();
    }
  }

  private onError(err: unknown): void {
    this.failAll(err);
    this.teardownWorker();
  }

  private onExit(code: number | null): void {
    if (code !== 0 && code !== null) {
      this.failAll(new Error(`Worker ${this.name} exited with code ${code}`));
    }
    this.teardownWorker();
  }

  private teardownWorker(): void {
    if (this.worker) {
      this.worker.removeAllListeners();
      this.worker = null;
    }
    this.active = 0;
    if (!this.disposed && (this.queue.length > 0 || this.pending.size > 0)) {
      this.pump();
    }
  }

  private failAll(err: unknown): void {
    for (const [, pending] of this.pending) {
      if (pending.timeoutHandle) clearTimeout(pending.timeoutHandle);
      pending.reject(err);
    }
    this.pending.clear();
    while (this.queue.length) {
      const job = this.queue.shift()!;
      job.reject(err);
    }
  }

  private handleTimeout(id: number, timeoutMs: number): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    this.active = Math.max(0, this.active - 1);
    pending.reject(new Error(`Worker ${this.name} job ${id} timed out after ${timeoutMs}ms`));
    try {
      this.worker?.postMessage({ kind: 'cancel', id });
    } catch {
      // ignore
    }
    this.pump();
  }

  private scheduleIdleTeardown(): void {
    if (this.idleTimeoutMs === 0) return;
    if (this.idleTimer) return;
    const handle = setTimeout(() => {
      this.idleTimer = null;
      if (this.worker && this.active === 0 && this.queue.length === 0) {
        this.worker.terminate().catch(() => {});
        this.worker = null;
      }
    }, this.idleTimeoutMs);
    (handle as any)?.unref?.();
    this.idleTimer = handle;
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }
}

export function createWorkerClient<TIn = unknown, TOut = unknown>(options: WorkerClientOptions): WorkerClient<TIn, TOut> {
  return new WorkerClient<TIn, TOut>(options);
}


