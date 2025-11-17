import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fetchRaydiumGraphQL } from '../pools/raydiumGraphQL.js';
import { poolsMetrics } from '../pools.metrics.js';

const executeMock = vi.fn();

vi.mock('../pools/shyftHelpers.js', () => ({
  executeShyftGraphQL: (req: any) => executeMock(req),
}));

vi.mock('../../utils/fs.js', () => ({
  writeJson: vi.fn(async () => {}),
  joinPath: (...parts: string[]) => parts.join('/'),
}));

vi.mock('../../utils/config.js', () => ({
  CONFIG: {
    cacheDir: '/tmp',
    logDir: '/tmp',
    raydium: { detailBatchSize: 10 },
  },
}));

const summaryPool = {
  pubkey: 'POOL1',
  baseMint: 'MintA',
  quoteMint: 'MintB',
  baseDecimal: 6,
  quoteDecimal: 6,
  swapBaseInAmount: '100',
  swapQuoteInAmount: '200',
  swapBaseOutAmount: '90',
  swapQuoteOutAmount: '190',
  swapFeeNumerator: 25,
  swapFeeDenominator: 10000,
  _updatedAt: 'now',
};

const detailPool = {
  pubkey: 'POOL1',
  baseVault: 'VaultA',
  quoteVault: 'VaultB',
  baseNeedTakePnl: '10',
  quoteNeedTakePnl: '20',
};

describe('fetchRaydiumGraphQL dual fetch', () => {
  beforeEach(() => {
    executeMock.mockReset();
    poolsMetrics.raydium.detailBatches = 0;
    poolsMetrics.raydium.detailFailures = 0;
    poolsMetrics.raydium.apiBatches = 0;
    poolsMetrics.raydium.apiBatchSizeAvg = 0;
  });

  it('merges detail fields with summary pools', async () => {
    executeMock.mockImplementation(({ extraLogContext }: any) => {
      if (extraLogContext?.phase === 'summary') {
        return Promise.resolve({ Raydium_LiquidityPoolv4: [summaryPool] });
      }
      if (extraLogContext?.phase === 'detail') {
        return Promise.resolve({ Raydium_LiquidityPoolv4: [detailPool] });
      }
      return Promise.resolve({});
    });

    const result = await fetchRaydiumGraphQL(['MintA']);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      pubkey: 'POOL1',
      baseVault: 'VaultA',
      quoteVault: 'VaultB',
    });
    expect(poolsMetrics.raydium.detailBatches).toBe(1);
    expect(poolsMetrics.raydium.detailFailures).toBe(0);
  });

  it('retains summary data if detail fetch empty', async () => {
    executeMock.mockImplementation(({ extraLogContext }: any) => {
      if (extraLogContext?.phase === 'summary') {
        return Promise.resolve({ Raydium_LiquidityPoolv4: [summaryPool] });
      }
      if (extraLogContext?.phase === 'detail') {
        return Promise.resolve({ Raydium_LiquidityPoolv4: [] });
      }
      return Promise.resolve({});
    });

    const result = await fetchRaydiumGraphQL(['MintA']);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      pubkey: 'POOL1',
      baseMint: 'MintA',
    });
    expect(result[0].baseVault).toBeUndefined();
    expect(poolsMetrics.raydium.detailBatches).toBe(1);
  });
});

