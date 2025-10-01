import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GridTrader, GridStrategyConfig, GridLevel, GridPosition } from '../src/trading/gridStrategy.js';

// Mock dependencies
vi.mock('../src/jupiter/jupiter.js', () => ({
  fetchPricesByMints: vi.fn(),
  executeSwap: vi.fn(),
  getQuote: vi.fn(),
  SOL_MINT: 'So11111111111111111111111111111111111111112'
}));

vi.mock('../src/server/priceStore.js', () => ({
  getAllPrices: vi.fn(() => ({}))
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  }
}));

vi.mock('../src/server/realtime.js', () => ({
  emit: vi.fn()
}));

vi.mock('../src/utils/tokens.js', () => ({
  resolveMint: vi.fn()
}));

vi.mock('../src/wallet/wallet.js', () => ({
  getBalances: vi.fn()
}));

vi.mock('../src/server/walletHistory.js', () => ({
  addWalletHistory: vi.fn()
}));

vi.mock('../src/utils/fs.js', () => ({
  readJson: vi.fn()
}));

vi.mock('../src/utils/config.js', () => ({
  CONFIG: {
    strategyConfigPath: 'test-config.json',
    websocketIntervalMs: 1000
  }
}));

describe('GridTrader', () => {
  let gridTrader: GridTrader;
  let mockWalletSignAndSend: any;
  let mockConfig: GridStrategyConfig;

  beforeEach(() => {
    mockWalletSignAndSend = vi.fn();
    gridTrader = new GridTrader('test-wallet', mockWalletSignAndSend);
    
    mockConfig = {
      name: 'test-grid',
      fromToken: 'USDC',
      toToken: 'SOL',
      active: true,
      testMode: true,
      gridType: 'arithmetic',
      gridSpacing: 0.01, // 1%
      gridLevels: 3,
      totalAmount: 1.0,
      levelAmount: 0.1,
      slippageBps: 100,
      cooldownMs: 1000
    };

    // Reset static state
    GridTrader.gridLevels = {};
    GridTrader.gridPositions = {};
    GridTrader.gridState = {};
    GridTrader.activityLogByStrategy = {};
  });

  describe('Grid Level Calculation', () => {
    it('should calculate arithmetic grid levels correctly', () => {
      const centerPrice = 100;
      const spacing = 0.01; // 1%
      const levels = 3;

      // Test arithmetic calculation
      const trader = new GridTrader('test', mockWalletSignAndSend);
      const buyPrice1 = (trader as any).calculateGridPrice('arithmetic', centerPrice, -1, spacing);
      const buyPrice2 = (trader as any).calculateGridPrice('arithmetic', centerPrice, -2, spacing);
      const sellPrice1 = (trader as any).calculateGridPrice('arithmetic', centerPrice, 1, spacing);
      const sellPrice2 = (trader as any).calculateGridPrice('arithmetic', centerPrice, 2, spacing);

      expect(buyPrice1).toBe(99); // 100 - 1%
      expect(buyPrice2).toBe(98); // 100 - 2%
      expect(sellPrice1).toBe(101); // 100 + 1%
      expect(sellPrice2).toBe(102); // 100 + 2%
    });

    it('should calculate geometric grid levels correctly', () => {
      const centerPrice = 100;
      const spacing = 0.01; // 1%
      
      const trader = new GridTrader('test', mockWalletSignAndSend);
      const buyPrice1 = (trader as any).calculateGridPrice('geometric', centerPrice, -1, spacing);
      const sellPrice1 = (trader as any).calculateGridPrice('geometric', centerPrice, 1, spacing);

      // Geometric: centerPrice * (1 + spacing)^level
      // For -1: 100 * (1 + 0.01)^(-1) = 100 * 0.9900990099... ≈ 99.0099
      // For +1: 100 * (1 + 0.01)^1 = 100 * 1.01 = 101
      expect(buyPrice1).toBeCloseTo(99.0099, 3); // More lenient precision
      expect(sellPrice1).toBeCloseTo(101, 3); // 100 * 1.01 = 101 exactly
    });

    it('should calculate fibonacci grid levels correctly', () => {
      const centerPrice = 100;
      const spacing = 0.01; // 1%
      
      const trader = new GridTrader('test', mockWalletSignAndSend);
      const buyPrice1 = (trader as any).calculateGridPrice('fibonacci', centerPrice, -1, spacing);
      const sellPrice1 = (trader as any).calculateGridPrice('fibonacci', centerPrice, 1, spacing);

      // Fibonacci ratio for level 1 is 1
      expect(buyPrice1).toBeCloseTo(99, 4); // 100 * (1 - 1 * 0.01)
      expect(sellPrice1).toBeCloseTo(101, 4); // 100 * (1 + 1 * 0.01)
    });
  });

  describe('Grid Initialization', () => {
    it('should initialize grid levels correctly', async () => {
      const instanceKey = 'test-wallet:test-grid';
      const centerPrice = 100;

      await (gridTrader as any).initializeGrid(mockConfig, instanceKey, centerPrice);

      const levels = GridTrader.getGridLevels(instanceKey);
      expect(levels).toHaveLength(6); // 3 buy + 3 sell levels

      const buyLevels = levels.filter(l => l.side === 'buy');
      const sellLevels = levels.filter(l => l.side === 'sell');

      expect(buyLevels).toHaveLength(3);
      expect(sellLevels).toHaveLength(3);

      // Check buy levels (should be below center price)
      // With initial range settings: first level uses initialBuyRange (5%), then arithmetic spacing
      expect(buyLevels[0].price).toBe(95); // -5% (initialBuyRange)
      expect(buyLevels[1].price).toBe(94); // -6% (95 - 1%)
      expect(buyLevels[2].price).toBe(93); // -7% (95 - 2%)

      // Check sell levels (should be above center price)
      // With initial range settings: first level uses initialSellRange (5%), then arithmetic spacing
      expect(sellLevels[0].price).toBe(105); // +5% (initialSellRange)
      expect(sellLevels[1].price).toBe(106); // +6% (105 + 1%)
      expect(sellLevels[2].price).toBe(107); // +7% (105 + 2%)

      // Check all levels are unfilled initially
      levels.forEach(level => {
        expect(level.filled).toBe(false);
        expect(level.amount).toBe(0.1);
      });
    });

    it('should apply long bias to compress buys and expand sells', async () => {
      const instanceKey = 'test-wallet:test-grid';
      const centerPrice = 100;
      const biasedConfig: GridStrategyConfig = {
        ...mockConfig,
        bias: 'long',
        biasStrength: 0.5,
        initialBuyRange: 0.05,
        initialSellRange: 0.05,
      };

      await (gridTrader as any).initializeGrid(biasedConfig, instanceKey, centerPrice);

      const levels = GridTrader.getGridLevels(instanceKey);
      const buyLevels = levels.filter(l => l.side === 'buy');
      const sellLevels = levels.filter(l => l.side === 'sell');

      // First levels should move closer/farther from center appropriately
      // With long bias, initialBuyRange reduced, initialSellRange increased
      expect(buyLevels[0].price).toBeGreaterThan(95); // closer than -5%
      expect(sellLevels[0].price).toBeGreaterThan(105); // farther than +5%
    });

    it('should add priority to biased side levels', () => {
      const cfg: GridStrategyConfig = { ...mockConfig, bias: 'short', biasStrength: 0.5 } as any;
      const levelSell: GridLevel = { id: 'sell-1', price: 101, side: 'sell', amount: 0.1, filled: false };
      const levelBuy: GridLevel = { id: 'buy-1', price: 99, side: 'buy', amount: 0.1, filled: false };
      const trader = new GridTrader('test', mockWalletSignAndSend);
      const pSell = (trader as any).calculateLevelPriority(cfg, levelSell, 100);
      const pBuy = (trader as any).calculateLevelPriority(cfg, levelBuy, 100);
      expect(pSell).toBeGreaterThan(pBuy); // short bias should favor sells
    });
  });

  describe('Level Execution Logic', () => {
    it('should identify when buy levels should execute', () => {
      const level: GridLevel = {
        id: 'buy-1',
        price: 99,
        side: 'buy',
        amount: 0.1,
        filled: false
      };

      const shouldExecute = (gridTrader as any).shouldExecuteLevel(level, 98.5); // Price below level
      expect(shouldExecute).toBe(true);

      const shouldNotExecute = (gridTrader as any).shouldExecuteLevel(level, 99.5); // Price above level
      expect(shouldNotExecute).toBe(false);
    });

    it('should identify when sell levels should execute', () => {
      const level: GridLevel = {
        id: 'sell-1',
        price: 101,
        side: 'sell',
        amount: 0.1,
        filled: false
      };

      const shouldExecute = (gridTrader as any).shouldExecuteLevel(level, 101.5); // Price above level
      expect(shouldExecute).toBe(true);

      const shouldNotExecute = (gridTrader as any).shouldExecuteLevel(level, 100.5); // Price below level
      expect(shouldNotExecute).toBe(false);
    });
  });

  describe('Rebalancing Logic', () => {
    it('should determine when rebalancing is needed', () => {
      const state = {
        centerPrice: 100,
        lastRebalance: Date.now() - 120000, // 2 minutes ago
        volatility: 0,
        totalFilled: 0,
        totalPnl: 0
      };

      const config = {
        ...mockConfig,
        rebalanceThreshold: 0.05 // 5%
      };

      const currentPrice = 95; // 5% below center
      const shouldRebalance = (gridTrader as any).shouldRebalance(config, state, currentPrice);
      expect(shouldRebalance).toBe(true);

      const currentPrice2 = 98; // 2% below center
      const shouldNotRebalance = (gridTrader as any).shouldRebalance(config, state, currentPrice2);
      expect(shouldNotRebalance).toBe(false);
    });
  });

  describe('Position Management', () => {
    it('should create grid positions correctly', () => {
      const instanceKey = 'test-wallet:test-grid';
      const position: GridPosition = {
        id: 'test-position',
        side: 'buy',
        entryPrice: 99,
        amount: 0.1,
        filledAmount: 0.1,
        pnl: 0,
        openedAt: Date.now(),
        transactionSignature: 'test-sig'
      };

      if (!GridTrader.gridPositions[instanceKey]) {
        GridTrader.gridPositions[instanceKey] = [];
      }
      GridTrader.gridPositions[instanceKey].push(position);

      const positions = GridTrader.getGridPositions(instanceKey);
      expect(positions).toHaveLength(1);
      expect(positions[0]).toEqual(position);
    });

    it('should track grid state correctly', () => {
      const instanceKey = 'test-wallet:test-grid';
      const state = {
        centerPrice: 100,
        lastRebalance: Date.now(),
        volatility: 0.02,
        totalFilled: 5,
        totalPnl: 10.5
      };

      GridTrader.gridState[instanceKey] = state;

      const retrievedState = GridTrader.getGridState(instanceKey);
      expect(retrievedState).toEqual(state);
    });
  });

  describe('Activity Logging', () => {
    it('should log activities correctly', () => {
      const strategyName = 'test-strategy';
      const activity = {
        time: new Date().toISOString(),
        action: 'grid-buy',
        token: 'USDC/SOL',
        amount: 0.1,
        price: 99
      };

      GridTrader.addActivity(strategyName, activity);

      const activities = GridTrader.activityLogByStrategy[strategyName];
      expect(activities).toHaveLength(1);
      expect(activities[0]).toEqual(activity);
    });

    it('should limit activity log size', () => {
      const strategyName = 'test-strategy';
      
      // Add more than 200 activities
      for (let i = 0; i < 250; i++) {
        GridTrader.addActivity(strategyName, {
          time: new Date().toISOString(),
          action: 'test',
          token: 'USDC/SOL',
          amount: 0.1,
          price: 99
        });
      }

      const activities = GridTrader.activityLogByStrategy[strategyName];
      expect(activities).toHaveLength(200); // Should be limited to 200
    });
  });

  describe('Fibonacci Ratio Calculation', () => {
    it('should calculate fibonacci ratios correctly', () => {
      const trader = new GridTrader('test', mockWalletSignAndSend);
      
      expect((trader as any).getFibonacciRatio(0)).toBe(1);
      expect((trader as any).getFibonacciRatio(1)).toBe(1);
      expect((trader as any).getFibonacciRatio(2)).toBe(2);
      expect((trader as any).getFibonacciRatio(3)).toBe(1.5);
      expect((trader as any).getFibonacciRatio(4)).toBeCloseTo(1.6667, 4);
      expect((trader as any).getFibonacciRatio(5)).toBeCloseTo(1.6, 4);
    });
  });

  describe('Grid Trader Lifecycle', () => {
    it('should start and stop correctly', () => {
      expect(gridTrader['isRunning']).toBe(false);
      
      gridTrader.start(1000);
      expect(gridTrader['isRunning']).toBe(true);
      expect(gridTrader['interval']).toBeDefined();
      
      gridTrader.stop();
      expect(gridTrader['isRunning']).toBe(false);
      expect(gridTrader['interval']).toBeUndefined();
    });

    it('should not start if already running', () => {
      gridTrader.start(1000);
      const interval1 = gridTrader['interval'];
      
      gridTrader.start(2000); // Try to start again
      const interval2 = gridTrader['interval'];
      
      expect(interval1).toBe(interval2); // Should be the same interval
    });
  });

  describe('In-flight Operation Tracking', () => {
    it('should track in-flight operations correctly', () => {
      const wallet = 'test-wallet';
      const pairKey = 'USDC->SOL';
      const operation = 'gridBuy';

      // Initially not in-flight
      expect(GridTrader.isInflight(wallet, pairKey, operation)).toBe(false);

      // Set as in-flight
      GridTrader.setInflight(wallet, pairKey, operation);
      expect(GridTrader.isInflight(wallet, pairKey, operation)).toBe(true);

      // Clear in-flight
      GridTrader.clearInflight(wallet, pairKey, operation);
      expect(GridTrader.isInflight(wallet, pairKey, operation)).toBe(false);
    });

    it('should expire in-flight operations after timeout', () => {
      const wallet = 'test-wallet';
      const pairKey = 'USDC->SOL';
      const operation = 'gridBuy';

      // Set as in-flight
      GridTrader.setInflight(wallet, pairKey, operation);
      expect(GridTrader.isInflight(wallet, pairKey, operation)).toBe(true);

      // Mock time passing beyond timeout
      const originalNow = Date.now;
      Date.now = vi.fn(() => originalNow() + 25000); // 25 seconds later

      expect(GridTrader.isInflight(wallet, pairKey, operation)).toBe(false);

      // Restore original Date.now
      Date.now = originalNow;
    });
  });
});
