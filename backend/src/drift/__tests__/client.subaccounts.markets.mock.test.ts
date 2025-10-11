// @ts-nocheck
import { describe, it, expect, vi } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';

vi.mock('../../wallet/wallet.js', () => ({
  ensureWallet: vi.fn(async () => Keypair.generate()),
}));

vi.mock('@drift-labs/sdk', () => {
  class FakeClient {
    user = {};
    async subscribe() {}
    async addUser() {}
    async initializeUserIfNotExists() {}
    async switchActiveUser() {}
    async getPerpMarketAccounts() {
      return [{ marketIndex: 0, name: 'SOL-PERP' }, { marketIndex: 1, name: 'BTC-PERP' }];
    }
    async getUserAccountPublicKey(_id: number) {
      return new PublicKey(Keypair.generate().publicKey);
    }
  }
  class FakeUser {
    constructor(_) {}
    async exists() { return true; }
    getTotalCollateral() { return 1000; }
    getMaintenanceMarginRequirement() { return 100; }
    getInitialMarginRequirement() { return 150; }
    getFreeCollateral() { return 800; }
    getLeverage() { return 1.2; }
    getPerpPositions() { return [{ marketIndex: 0, baseAssetAmount: 0 }]; }
    getSpotPositions() { return []; }
  }
  return {
    DriftClient: FakeClient,
    User: FakeUser,
    Wallet: class { constructor(_) {} },
    BulkAccountLoader: class {},
    getMarketsAndOraclesForSubscription: () => ({}),
    getMaxNumberOfSubAccounts: () => 3,
  };
});

describe('DriftService (mocked SDK)', () => {
  it('discovers perp markets via SDK', async () => {
    const { DriftService } = await import('../client.js');
    const svc = DriftService.getInstance();
    await svc.init();
    const markets = await (svc as any).discoverMarkets();
    expect(markets.length).toBeGreaterThanOrEqual(2);
    expect(markets[0]).toHaveProperty('marketIndex');
  });

  it('enumerates subaccounts and caches/invalidate', async () => {
    const { DriftService } = await import('../client.js');
    const svc = DriftService.getInstance();
    await svc.init();
    (svc as any).connection = { getAccountInfo: vi.fn(async () => ({ data: 'ok' })) };
    const first = await svc.getSubaccounts();
    expect(first.length).toBe(3);
    const again = await svc.getSubaccounts();
    expect(again).toBe(first);
    svc.invalidateSubaccountsCache();
    const after = await svc.getSubaccounts();
    expect(after).not.toBe(first);
  });

  it('switches active subaccount best-effort', async () => {
    const { DriftService } = await import('../client.js');
    const svc = DriftService.getInstance();
    await svc.init();
    const ok = await svc.switchSubaccount(1);
    expect(ok).toBe(true);
  });
});


