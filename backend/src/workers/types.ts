export interface WorkerErrorPayload {
  message: string;
  name?: string;
  stack?: string;
  code?: string;
  details?: Record<string, unknown>;
}

export interface WorkerRequestMessage<T = unknown> {
  kind: 'job';
  id: number;
  payload: T;
}

export interface WorkerSuccessMessage<T = unknown> {
  kind: 'result';
  id: number;
  ok: true;
  result: T;
}

export interface WorkerErrorMessage {
  kind: 'result';
  id: number;
  ok: false;
  error: WorkerErrorPayload;
}

export type WorkerResponseMessage<T = unknown> = WorkerSuccessMessage<T> | WorkerErrorMessage;

export type WorkerInboundMessage<T = unknown> = WorkerRequestMessage<T>;

export type WorkerOutboundMessage<T = unknown> = WorkerResponseMessage<T>;

export type WorkerHandler<TIn = unknown, TOut = unknown> = (payload: TIn) => Promise<TOut> | TOut;

export interface WorkerClientOptions {
  /** Absolute or relative URL pointing to the worker module. */
  url: URL;
  /** Friendly name for logging/debugging. */
  name: string;
  /** Optional environment overrides for worker thread. */
  env?: NodeJS.ProcessEnv;
  /** Optional data passed to worker via workerData. */
  workerData?: unknown;
  /** Maximum concurrent in-flight jobs. Defaults to 1. */
  maxConcurrency?: number;
  /** Idle timeout (ms) before worker is disposed. */
  idleTimeoutMs?: number;
}

export interface RunJobOptions {
  timeoutMs?: number;
}


