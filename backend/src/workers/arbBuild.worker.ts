import { exposeWorkerHandler } from './runtime.js';
import { buildTransactionSummary } from '../server/arb.build.worker.compute.js';
import type { ArbBuildRequest, ArbBuildResult } from './arbBuild.types.js';

exposeWorkerHandler<ArbBuildRequest, ArbBuildResult>(async (request) => {
  if (!request || !request.plan) {
    throw new Error('arb build worker missing plan');
  }
  return buildTransactionSummary(request.plan, request.extraSetupIxs, request.computeBudget);
});


