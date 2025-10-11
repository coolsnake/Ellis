import { describe, it, expect } from 'vitest';

// NOTE: These tests are scaffolding and are skipped by default.
// To run against a live backend, start the server and set API_BASE
// e.g. API_BASE=http://localhost:3001/api vitest run backend/tests/drift.integration.test.ts

const API_BASE = process.env.API_BASE as string | undefined;
const describeLive = API_BASE ? describe : describe.skip;

describeLive('Drift leveraged grid integration (devnet scaffolding)', () => {
  it('should fetch Drift status', async () => {
    const res = await fetch(`${API_BASE}/drift/status`);
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(data).toHaveProperty('cluster');
    expect(Array.isArray(data.subaccounts)).toBe(true);
  });

  it('should fetch L2 orderbook for a market', async () => {
    const res = await fetch(`${API_BASE}/drift/l2?marketIndex=0`);
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(data).toHaveProperty('bid');
    expect(data).toHaveProperty('ask');
  });

  it('should start and stop a leveraged grid strategy', async () => {
    const cfg = {
      name: `lev-grid-test-${Date.now()}`,
      market: { marketIndex: 0 },
      subaccountId: 0,
      leverage: 2,
      liquidationBufferPct: 0.25,
      gridLower: 0,
      gridUpper: 0,
      levels: 3,
      stepPct: 0.01,
      notionalPerLevel: 10,
      makerOnly: true,
      fundingGuard: true,
      rebalanceHysteresisPct: 0.02,
      maxOpenOrders: 12,
      enabled: true,
    };
    const start = await fetch(`${API_BASE}/strategies/leveraged-grid/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg) });
    expect(start.ok).toBe(true);
    const { key } = await start.json();
    expect(typeof key).toBe('string');

    const status = await fetch(`${API_BASE}/strategies/leveraged-grid/status`);
    expect(status.ok).toBe(true);
    const payload = await status.json();
    expect(Array.isArray(payload.strategies)).toBe(true);

    const stop = await fetch(`${API_BASE}/strategies/leveraged-grid/stop`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key }) });
    expect(stop.ok).toBe(true);
  });
});

describeLive('Drift liquidator integration (devnet scaffolding)', () => {
  it('should start and stop liquidator', async () => {
    const start = await fetch(`${API_BASE}/strategies/liquidator/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: `liq-${Date.now()}`, pollMs: 1200, dryRun: true })
    });
    expect(start.ok).toBe(true);
    const status = await fetch(`${API_BASE}/strategies/liquidator/status`);
    expect(status.ok).toBe(true);
    const payload = await status.json();
    expect(payload).toHaveProperty('liquidators');
    const firstKey = (payload.liquidators?.[0]?.key);
    if (firstKey) {
      const stop = await fetch(`${API_BASE}/strategies/liquidator/stop`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: firstKey }) });
      expect(stop.ok).toBe(true);
    }
  });
});


