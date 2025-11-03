import { parentPort } from 'node:worker_threads';

import type { WorkerErrorPayload, WorkerHandler, WorkerInboundMessage, WorkerOutboundMessage } from './types.js';

function serializeError(err: unknown): WorkerErrorPayload {
  if (err instanceof Error) {
    const payload: WorkerErrorPayload = {
      message: err.message,
      name: err.name,
      stack: err.stack,
    };
    if ((err as any)?.code) {
      payload.code = String((err as any).code);
    }
    if ((err as any)?.details && typeof (err as any).details === 'object') {
      payload.details = { ...(err as any).details };
    }
    return payload;
  }
  if (err && typeof err === 'object') {
    const obj = err as Record<string, unknown>;
    return {
      message: String(obj.message ?? '[object error]'),
      name: typeof obj.name === 'string' ? obj.name : undefined,
      stack: typeof obj.stack === 'string' ? obj.stack : undefined,
      code: obj.code ? String(obj.code) : undefined,
      details: typeof obj.details === 'object' ? (obj.details as Record<string, unknown>) : undefined,
    };
  }
  return { message: String(err ?? 'Unknown error') };
}

export function exposeWorkerHandler<TIn = unknown, TOut = unknown>(handler: WorkerHandler<TIn, TOut>): void {
  if (!parentPort) {
    throw new Error('exposeWorkerHandler() must be called from a worker thread');
  }

  parentPort.on('message', async (raw: WorkerInboundMessage<TIn>) => {
    if (!raw || raw.kind !== 'job') return;
    const { id, payload } = raw;
    const response: WorkerOutboundMessage<TOut> = { kind: 'result', id, ok: true, result: undefined as any };
    try {
      const result = await handler(payload);
      response.ok = true;
      response.result = result as TOut;
    } catch (err) {
      response.ok = false;
      response.error = serializeError(err);
    }
    try {
      parentPort!.postMessage(response);
    } catch (err) {
      // If posting fails, there's nothing else we can do; log to stderr to aid debugging.
      try {
        console.error('Worker failed to post message', err);
      } catch {}
    }
  });
}


