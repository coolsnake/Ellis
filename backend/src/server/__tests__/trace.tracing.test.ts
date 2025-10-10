// @ts-nocheck
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

// Shared stubs which individual tests may override
let execMode: 'simulate' | 'direct' = 'simulate';
let builtSizeBytes = 200;

const logTxTraceMock = vi.fn(async () => {});

vi.mock('../../utils/txTrace.js', () => ({
  logTxTrace: (...args: any[]) => logTxTraceMock(...args),
}));

vi.mock('../execConfigStore.js', () => ({
  loadExecConfig: vi.fn(async () => ({
    mode: execMode,
    slippageBpsDefault: 50,
    computeUnitLimit: 1_000_000,
    computeUnitPriceMicroLamports: 1_000,
    createAtasInTx: true,
    dynamicCompute: true,
    maxTxSizeBytes: 1200,
    wrapSolInTx: true,
    lookupTableAddresses: undefined,
  })),
}));

vi.mock('../../execution/resolver/index.js', () => ({
  resolveDirectPlan: vi.fn(async (input: any) => ({ path: input?.path || ['A', 'B'], hops: [], computeUnitPriceMicroLamports: 0 })),
}));

vi.mock('../../execution/builder/tx.js', () => ({
  buildDirectArbTx: vi.fn(async (_plan: any) => ({
    tx: { instructions: [{ programId: 'Test111111111111111111111111111111111111111', keys: [], data: {} }] },
    ixCount: 1,
    sizeBytes: builtSizeBytes,
  })),
}));

// Sender mocked per test where needed
vi.mock('../../execution/sender.js', () => ({
  assembleAndSimulate: vi.fn(async () => ({ logs: ['ok'], err: null, wireBase64: 'AAA==' })),
  assembleAndSend: vi.fn(async () => ({ signature: 'sig-xyz', wireBase64: 'BBB==' })),
}));

// Schemas: accept body as-is to avoid coupling to zod in tests
vi.mock('../routes/schemas.js', () => ({
  ResolveDirectSchema: { parse: (x: any) => x },
}));

describe('Tracing writes for arb routes', () => {
  let app: express.Express;

  beforeAll(async () => {
    const { createArbRouter } = await import('../routes/arb.js');
    app = express();
    app.use(express.json());
    app.use(createArbRouter({} as any));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    execMode = 'simulate';
    builtSizeBytes = 200;
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  it('logs simulate trace on /arb/simulate', async () => {
    const res = await request(app).post('/arb/simulate').send({ path: ['X','Y'], hopPoolIds: ['p'], dexes: ['raydium.amm'] }).set('content-type', 'application/json');
    expect(res.status).toBe(200);
    expect(logTxTraceMock).toHaveBeenCalled();
    const call = logTxTraceMock.mock.calls.find(c => c[0] === 'simulate');
    expect(call).toBeTruthy();
    expect(call[1]).toHaveProperty('ixCount', 1);
    expect(call[1]).toHaveProperty('txSizeBytes', builtSizeBytes);
  });

  it('logs preflight trace with wireBase64 on /arb/simulate-send', async () => {
    const res = await request(app).post('/arb/simulate-send').send({ path: ['X','Y'], hopPoolIds: ['p'], dexes: ['raydium.amm'] }).set('content-type', 'application/json');
    expect(res.status).toBe(200);
    const call = logTxTraceMock.mock.calls.find(c => c[0] === 'preflight');
    expect(call).toBeTruthy();
    expect(call[1]).toHaveProperty('wireBase64');
    expect(typeof call[1].wireBase64).toBe('string');
  });

  it('logs preflight and send traces on /arb/execute (direct mode)', async () => {
    execMode = 'direct';
    const res = await request(app).post('/arb/execute').send({ path: ['A','B'], hopPoolIds: ['h'], dexes: ['raydium.amm'] }).set('content-type', 'application/json');
    expect(res.status).toBe(200);
    const kinds = logTxTraceMock.mock.calls.map(c => c[0]);
    expect(kinds).toContain('preflight');
    expect(kinds).toContain('send');
    const sendCall = logTxTraceMock.mock.calls.find(c => c[0] === 'send');
    expect(sendCall[1]).toHaveProperty('signature');
    expect(sendCall[1]).toHaveProperty('wireBase64');
  });
});


