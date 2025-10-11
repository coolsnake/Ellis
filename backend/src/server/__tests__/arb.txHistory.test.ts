// @ts-nocheck
import express from 'express';
import request from 'supertest';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock heavy modules used by routes
vi.mock('../../execution/resolver/index.js', () => ({
  resolveDirectPlan: vi.fn(async (input: any) => ({
    path: Array.isArray(input?.path) ? input.path : ['A', 'B'],
    hops: (input?.hopPoolIds || ['p1']).map((pid: string, i: number) => ({ dex: (input?.dexes?.[i] || 'Raydium'), poolId: pid, variant: 'CLMM' })),
  })),
}));

vi.mock('../../execution/builder/tx.js', () => ({
  buildDirectArbTx: vi.fn(async () => ({ tx: { instructions: [] }, ixCount: 3, sizeBytes: 123 })),
}));

// Default to success; tests can override via mockImplementationOnce
vi.mock('../../execution/sender.js', () => ({
  assembleAndSimulate: vi.fn(async () => ({ logs: ['ok'], err: null })),
  assembleAndSend: vi.fn(async () => ({ signature: 'SIG123' })),
}));

vi.mock('../execConfigStore.js', () => ({
  loadExecConfig: vi.fn(async () => ({ mode: 'simulate', computeUnitLimit: 0, computeUnitPriceMicroLamports: 0, lookupTableAddresses: [] })),
}));

vi.mock('../../utils/txTrace.js', () => ({
  logTxTrace: vi.fn(async () => undefined),
}));

// Spy on websocket emission bridge
vi.mock('../realtime.js', () => ({
  emit: vi.fn(async () => undefined),
  setIo: vi.fn(() => undefined),
}));

import { createArbRouter } from '../routes/arb.js';
import { emit } from '../realtime.js';
import { getTxHistory } from '../txHistory.js';

describe('arb tx-history and websocket emission', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeApp() {
    const app = express();
    app.use(express.json());
    // Mount only arb router
    // @ts-ignore Socket server is mocked via setIo
    app.use(createArbRouter({} as any));
    return app;
  }

  it('records sim_ok on /arb/simulate-send and emits tx:history.updated', async () => {
    const app = makeApp();
    // Success path for preflight
    const res = await request(app)
      .post('/arb/simulate-send')
      .send({ path: ['A','B'], hopPoolIds: ['P1'], dexes: ['Raydium'] })
      .expect(200);
    const id = res.body?.id;
    expect(typeof id).toBe('string');

    const hist = await getTxHistory(50);
    const row = hist.find((r) => r.id === id);
    expect(row).toBeTruthy();
    expect(row?.status).toBe('sim_ok');
    // Check websocket emit was called with history updated
    expect((emit as any).mock.calls.find((c: any[]) => c?.[0] === 'tx:history.updated')).toBeTruthy();
  });

  it('records sim_err on /arb/simulate-send failure and emits', async () => {
    const { assembleAndSimulate } = await import('../../execution/sender.js');
    (assembleAndSimulate as any).mockImplementationOnce(async () => ({ logs: ['fail'], err: 'preflight_failed' }));
    const app = makeApp();
    const res = await request(app)
      .post('/arb/simulate-send')
      .send({ path: ['C','D'], hopPoolIds: ['P2'], dexes: ['Orca'] })
      .expect(200);
    const id = res.body?.id;
    const hist = await getTxHistory(20);
    const row = hist.find((r) => r.id === id);
    expect(row?.status).toBe('sim_err');
  });

  it('does not record history on /arb/execute in simulate mode', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/arb/execute')
      .send({ path: ['E','F'], hopPoolIds: ['P3'], dexes: ['Meteora'] })
      .expect(200);
    const id = res.body?.id;
    const hist = await getTxHistory(30);
    const row = hist.find((r) => r.id === id);
    expect(row).toBeUndefined();
  });
});


