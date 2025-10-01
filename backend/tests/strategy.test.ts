import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as jupiter from '../src/jupiter/jupiter';
import { ThresholdTrader } from '../src/trading/thresholdStrategy';

describe('ThresholdTrader', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('buys when price below threshold', async () => {
    vi.spyOn(jupiter, 'fetchTokenPrices').mockResolvedValue([
      { tokenSymbol: 'SOL', priceInUSDC: 10, priceInSOL: 1 },
      { tokenSymbol: 'USDC', priceInUSDC: 1, priceInSOL: 0.1 },
      { tokenSymbol: 'SOL', priceInUSDC: 10, priceInSOL: 1 },
    ] as any);
    vi.spyOn(jupiter, 'executeSwap').mockResolvedValue('sig');
    const signSend = vi.fn().mockResolvedValue('sig');
    const spySwap = vi.spyOn(jupiter, 'executeSwap').mockResolvedValue('sig');
    const trader = new ThresholdTrader('user', signSend);
    
    // Configure trader with proper strategy parameters
    // @ts-expect-error override
    trader.loadConfig = async () => ({ 
      token: 'SOL', 
      buyThreshold: 20, // Price below this triggers buy
      sellThreshold: 30, // Price above this triggers sell
      amount: 0.1,
      testMode: false,
      fromToken: 'USDC',
      toToken: 'SOL'
    });
    
    await trader.tick();
    expect(spySwap).toHaveBeenCalled();
  });

  it('sells when price above threshold', async () => {
    vi.spyOn(jupiter, 'fetchTokenPrices').mockResolvedValue([
      { tokenSymbol: 'SOL', priceInUSDC: 100, priceInSOL: 10 },
      { tokenSymbol: 'USDC', priceInUSDC: 1, priceInSOL: 0.1 },
      { tokenSymbol: 'SOL', priceInUSDC: 100, priceInSOL: 10 },
    ] as any);
    vi.spyOn(jupiter, 'executeSwap').mockResolvedValue('sig');
    const signSend = vi.fn().mockResolvedValue('sig');
    const spySwap = vi.spyOn(jupiter, 'executeSwap').mockResolvedValue('sig');
    const trader = new ThresholdTrader('user', signSend);
    
    // Configure trader with proper strategy parameters
    // @ts-expect-error override
    trader.loadConfig = async () => ({ 
      token: 'SOL', 
      buyThreshold: 20, // Price below this triggers buy
      sellThreshold: 30, // Price above this triggers sell
      amount: 0.1,
      testMode: false,
      fromToken: 'USDC',
      toToken: 'SOL'
    });
    
    await trader.tick();
    expect(spySwap).toHaveBeenCalled();
  });

  it('skips swaps in test mode', async () => {
    vi.spyOn(jupiter, 'fetchTokenPrices').mockResolvedValue([
      { tokenSymbol: 'SOL', priceInUSDC: 10, priceInSOL: 1 },
      { tokenSymbol: 'USDC', priceInUSDC: 1, priceInSOL: 0.1 },
      { tokenSymbol: 'SOL', priceInUSDC: 10, priceInSOL: 1 },
    ] as any);
    const signSend = vi.fn().mockResolvedValue('sig');
    const spySwap = vi.spyOn(jupiter, 'executeSwap').mockResolvedValue('sig');
    // Temporarily force test mode via monkey patch of loader
    const trader = new ThresholdTrader('user', signSend);
    // @ts-expect-error override
    trader.loadConfig = async () => ({ token: 'SOL', buyThreshold: 20, sellThreshold: 30, amount: 0.1, testMode: true });
    await trader.tick();
    expect(spySwap).not.toHaveBeenCalled();
  });
});


