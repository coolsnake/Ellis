import { describe, it, expect, vi } from 'vitest';
import { fetchTokenPrices, getQuote, executeSwap } from '../src/jupiter/jupiter';

describe('jupiter client', () => {
  it('fetchTokenPrices returns mapped results', async () => {
    const solMint = 'So11111111111111111111111111111111111111112';
    const usdcMint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const mockData: any = {
      [solMint]: { usdPrice: 100, blockId: 1, decimals: 9 },
      [usdcMint]: { usdPrice: 1, blockId: 1, decimals: 6 }
    };
    // @ts-expect-error
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => mockData });
    const res = await fetchTokenPrices(['SOL', 'USDC']);
    expect(res.find(r => r.tokenSymbol === 'SOL')?.priceInUSDC).toBe(100);
  });

  it('executeSwap delegates to wallet signer with base64', async () => {
    // mock quote
    // @ts-expect-error
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ swapTransaction: 'BASE64_TX' }) });
    const signer = vi.fn().mockResolvedValue('SIG');
    const sig = await executeSwap({ inputMint: 'A', outputMint: 'B', amount: 1, userPublicKey: 'U' }, signer);
    expect(sig).toBe('SIG');
    expect(signer).toHaveBeenCalledWith('BASE64_TX');
  });
});


