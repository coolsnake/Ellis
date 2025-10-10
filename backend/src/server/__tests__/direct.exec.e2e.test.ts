// @ts-nocheck
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

// Shared stubs which individual tests may override
let execMode: 'simulate' | 'direct' = 'simulate';
let builtSizeBytes = 200;
let preflightErr: any = null;
let preflightLogs: string[] = ['log A', 'log B'];
let sendSignature = 'sig-test-123';

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

vi.mock('../../execution/sender.js', () => ({
  assembleAndSimulate: vi.fn(async () => ({ logs: preflightLogs, err: preflightErr })),
  assembleAndSend: vi.fn(async () => ({ signature: sendSignature })),
}));

// Schemas: accept body as-is to avoid coupling to zod in tests
vi.mock('../routes/schemas.js', () => ({
  ResolveDirectSchema: { parse: (x: any) => x },
}));

describe('Direct execution endpoints', () => {
  let app: express.Express;

  beforeAll(async () => {
    const { createArbRouter } = await import('../routes/arb.js');
    app = express();
    app.use(express.json());
    app.use(createArbRouter({} as any));
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  it('POST /arb/simulate-send returns logs and no error', async () => {
    execMode = 'simulate';
    preflightErr = null; preflightLogs = ['ok1', 'ok2'];
    const body = { path: ['X', 'Y'], hopPoolIds: ['p'], dexes: ['raydium.amm'] };
    const res = await request(app).post('/arb/simulate-send').send(body).set('content-type', 'application/json');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('ixCount');
    expect(res.body).toHaveProperty('txSizeBytes');
    expect(res.body.logs).toEqual(['ok1', 'ok2']);
    expect(res.body.err).toBeFalsy();
  });

  it('POST /arb/execute short-circuits in simulate mode', async () => {
    execMode = 'simulate';
    const body = { path: ['X', 'Y'], hopPoolIds: ['p'], dexes: ['raydium.amm'] };
    const res = await request(app).post('/arb/execute').send(body).set('content-type', 'application/json');
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe('simulate');
    expect(res.body.signature).toBeNull();
  });

  it('POST /arb/execute sends when direct mode and preflight succeeds', async () => {
    execMode = 'direct';
    preflightErr = null; preflightLogs = ['pre-ok'];
    builtSizeBytes = 200; // under limit
    sendSignature = 'sig-abc-123';
    const res = await request(app).post('/arb/execute').send({ path: ['A', 'B'], hopPoolIds: ['h'], dexes: ['raydium.amm'] }).set('content-type', 'application/json');
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe('direct');
    expect(res.body.signature).toBe('sig-abc-123');
  });

  it('POST /arb/execute fails when oversized (atomic only)', async () => {
    execMode = 'direct';
    builtSizeBytes = 10_000; // exceed maxTxSizeBytes
    const res = await request(app).post('/arb/execute').send({ path: ['A', 'B'], hopPoolIds: ['h'], dexes: ['raydium.amm'] }).set('content-type', 'application/json');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('tx_too_large');
    expect(res.body.maxTxSizeBytes).toBeGreaterThan(0);
  });

  it('POST /arb/execute fails when preflight returns error', async () => {
    execMode = 'direct';
    builtSizeBytes = 200;
    preflightErr = 'simulation failed';
    preflightLogs = ['fail: something'];
    const res = await request(app).post('/arb/execute').send({ path: ['A', 'B'], hopPoolIds: ['h'], dexes: ['raydium.amm'] }).set('content-type', 'application/json');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('preflight_failed');
    expect(Array.isArray(res.body.logs)).toBe(true);
  });
});


