import { describe, it, expect } from 'vitest';

const RUN = String(process.env.RUN_DRIFT_MUTATING || '') === 'true';
const ACK = String(process.env.DRIFT_MUTATING_MAINNET_ACK || '') === 'I_ACCEPT_RISK';
const FUNDS = String(process.env.DRIFT_MUTATING_FUNDS || '') === 'true';

(RUN && ACK ? describe : describe.skip)('Drift real-data (mutating, gated)', () => {
  it('local name change via route; optional createSubaccount()', async () => {
    const { CONFIG } = await import('../../utils/config.js');
    const { ensureWallet, getConnection } = await import('../../wallet/wallet.js');
    const kp = await ensureWallet(CONFIG.walletPath);
    const conn = getConnection();
    const lamports = await conn.getBalance(kp.publicKey, 'confirmed');
    expect(lamports).toBeGreaterThan(100_000);

    const expressMod: any = await import('express');
    const { createDriftRouter } = await import('../../server/routes/drift.js');
    const http = await import('http');
    const app = expressMod.default();
    app.use(expressMod.json());
    app.use(createDriftRouter({} as any));
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address: any = server.address();
    const base = `http://127.0.0.1:${address.port}`;
    const res = await fetch(`${base}/drift/subaccount/name`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: Number((CONFIG as any).drift?.defaultSubaccountId || 0), name: `test-${Date.now()}` }),
    });
    expect(res.status).toBe(200);
    server.close();

    if (FUNDS) {
      const { DriftService } = await import('../client.js');
      const svc = DriftService.getInstance();
      const created = await svc.createSubaccount(`t-${Date.now()}`);
      expect(created && typeof created.id === 'number').toBe(true);
    }
  }, 120_000);
});


