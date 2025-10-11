// @ts-nocheck
import { describe, it, expect, vi } from 'vitest';
import express from 'express';

vi.mock('../../drift/client.js', () => ({
  DriftService: class {
    static getInstance() { return new this(); }
    async getStatus() { return { cluster: 'mainnet-beta', markets: [{ marketIndex: 0 }], subaccounts: [{ id: 0 }] }; }
    async getSubaccounts() { return [{ id: 0, totalCollateral: 0, freeCollateral: 0, maintenanceRequirement: 0, initialRequirement: 0, effectiveLeverage: 0, positions: [] }]; }
    invalidateSubaccountsCache() {}
    async switchSubaccount() { return true; }
    async depositToSubaccount() { return { ok: false }; }
    async withdrawFromSubaccount() { return { ok: false }; }
    async transferBetweenSubaccounts() { return { ok: false }; }
  },
}));

describe('drift routes (validation and shape)', () => {
  it('GET /drift/status returns expected shape', async () => {
    const { createDriftRouter } = await import('../routes/drift.js');
    const app = express();
    app.use(express.json());
    app.use(createDriftRouter({} as any));
    const request = (await import('supertest')).default;
    const res = await request(app).get('/drift/status');
    expect(res.status).toBe(200);
    expect(res.body.cluster).toBeDefined();
    expect(Array.isArray(res.body.markets)).toBe(true);
    expect(Array.isArray(res.body.subaccounts)).toBe(true);
  });

  it('POST /drift/subaccount/deposit rejects invalid payloads', async () => {
    const { createDriftRouter } = await import('../routes/drift.js');
    const app = express();
    app.use(express.json());
    app.use(createDriftRouter({} as any));
    const request = (await import('supertest')).default;
    const bad = await request(app).post('/drift/subaccount/deposit').send({ subaccountId: -1, amount: 0 });
    expect(bad.status).toBe(400);
  });
});


