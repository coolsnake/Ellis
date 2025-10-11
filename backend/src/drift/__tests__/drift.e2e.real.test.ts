import { describe, it, expect } from 'vitest';

const RUN = String(process.env.RUN_REAL_DRIFT_E2E || '') === 'true';

(RUN ? describe : describe.skip)('Drift real-data smoke (read-only, mainnet-beta)', () => {
  it('connects and fetches markets/subaccounts/L2/funding', async () => {
    const { CONFIG } = await import('../../utils/config.js');
    const { walletExists } = await import('../../wallet/wallet.js');
    const hasWallet = await walletExists(CONFIG.walletPath);
    expect(hasWallet).toBe(true);

    const { DriftService } = await import('../client.js');
    const svc = DriftService.getInstance();

    const status = await svc.getStatus();
    expect(status.cluster).toMatch(/mainnet|devnet/);
    expect(status.markets.length).toBeGreaterThan(0);
    expect(Array.isArray(status.subaccounts)).toBe(true);

    const { fetchDlobL2 } = await import('../marketdata.js');
    const l2 = await fetchDlobL2(0);
    expect(!!l2 && Array.isArray(l2.bid) && Array.isArray(l2.ask)).toBe(true);

    const fr = await svc.getFundingRate(0);
    expect(fr && typeof fr.lastFundingRate === 'number').toBe(true);
  }, 90_000);
});


