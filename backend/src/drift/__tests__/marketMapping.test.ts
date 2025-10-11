import { describe, it, expect } from 'vitest';

describe('marketMapping allowlist parsing', () => {
  it('parses allowlist and maps indices/symbols', async () => {
    process.env.DRIFT_MARKETS = '0:SOL-PERP,1:BTC-PERP,2';
    const mod = await import('../marketMapping.js');
    const list = mod.parseAllowlistMarkets();
    expect(list.map((m) => m.marketIndex)).toEqual([0, 1, 2]);
    expect(mod.indexToSymbol(0)).toMatch(/SOL/i);
    expect(mod.symbolToIndex('BTC-PERP')).toBe(1);
    expect(mod.symbolToIndex('ETH')).toBe(2);
  });
});


