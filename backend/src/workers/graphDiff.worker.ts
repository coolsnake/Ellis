import { exposeWorkerHandler } from './runtime.js';
import { computeIncrementalGraphUpdate } from '../server/graph.worker.compute.js';
import type { GraphWorkerRequest, GraphWorkerResponse } from './graphDiff.types.js';

exposeWorkerHandler<GraphWorkerRequest, GraphWorkerResponse>(async (request) => {
  if (!request) {
    throw new Error('Graph worker received empty request');
  }
  switch (request.kind) {
    case 'incremental':
      return computeIncrementalGraphUpdate(request.payload);
    default:
      throw new Error(`Unknown graph worker request kind: ${(request as any)?.kind}`);
  }
});


