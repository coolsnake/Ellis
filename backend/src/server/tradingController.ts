import { Keypair } from '@solana/web3.js';
import { ThresholdTrader, StrategyConfig } from '../trading/thresholdStrategy.js';
import { GridTrader, GridStrategyConfig } from '../trading/gridStrategy.js';
import { ensureWallet, signAndSendSerializedTransaction } from '../wallet/wallet.js';
import { CONFIG } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import { getStrategies, migrateSingleStrategy } from '../utils/strategies.js';
import { systemStatus } from './status.js';

export class TradingController {
  private traders: ThresholdTrader[] = [];
  private gridTraders: GridTrader[] = [];
  private traderByName: Record<string, ThresholdTrader> = {};
  private gridTraderByName: Record<string, GridTrader> = {};
  private keypair?: Keypair;
  private currentTickMs: number = 2000;

  async init(): Promise<void> {
    this.keypair = await ensureWallet(CONFIG.walletPath);
    this.traders = [];
    this.gridTraders = [];
    this.traderByName = {};
    this.gridTraderByName = {};
    await migrateSingleStrategy();
    const list = await getStrategies();
    for (const item of list) {
      // Check if this is a grid strategy
      const isGridStrategy = this.isGridStrategy(item);
      
      if (isGridStrategy) {
        const gridTrader = new GridTrader(this.keypair.publicKey.toBase58(), async (serialized: string) => {
          if (!this.keypair) throw new Error('missing signer');
          logger.info('Signing and sending transaction');
          return signAndSendSerializedTransaction(serialized, this.keypair);
        });
        // Bind strategy to trader by overriding loadConfig
        (gridTrader as any).loadConfig = async () => {
          const fresh = await getStrategies();
          const found = fresh.find((s) => s.name === item.name);
          return (found || item) as GridStrategyConfig;
        };
        this.gridTraders.push(gridTrader);
        this.gridTraderByName[item.name] = gridTrader;
      } else {
        const trader = new ThresholdTrader(this.keypair.publicKey.toBase58(), async (serialized: string) => {
          if (!this.keypair) throw new Error('missing signer');
          logger.info('Signing and sending transaction');
          return signAndSendSerializedTransaction(serialized, this.keypair);
        });
        // Bind strategy to trader by overriding loadConfig
        (trader as any).loadConfig = async () => {
          const fresh = await getStrategies();
          const found = fresh.find((s) => s.name === item.name);
          return (found || item) as StrategyConfig;
        };
        this.traders.push(trader);
        this.traderByName[item.name] = trader;
      }
    }
  }

  private isGridStrategy(item: any): boolean {
    // Check if strategy has grid-specific properties
    const isGrid = !!(item.gridType || item.gridSpacing || item.gridLevels || item.totalAmount || item.levelAmount);
    logger.info('Checking if strategy is grid', { 
      name: item.name, 
      isGrid, 
      hasGridType: !!item.gridType,
      hasGridSpacing: !!item.gridSpacing,
      hasGridLevels: !!item.gridLevels,
      hasTotalAmount: !!item.totalAmount,
      hasLevelAmount: !!item.levelAmount
    });
    return isGrid;
  }

  async start(): Promise<void> {
    if (!this.traders.length && !this.gridTraders.length) {
      await this.init();
    }
    if (!this.traders.length && !this.gridTraders.length) {
      throw new Error('No strategies configured');
    }
    ThresholdTrader.setGlobalHalt(false);
    GridTrader.setGlobalHalt(false);
    for (const t of this.traders) t.start(this.currentTickMs);
    for (const gt of this.gridTraders) gt.start(this.currentTickMs);
    systemStatus.bot = 'started';
  }

  stop(): void {
    ThresholdTrader.setGlobalHalt(true);
    GridTrader.setGlobalHalt(true);
    for (const t of this.traders) t.stop();
    for (const gt of this.gridTraders) gt.stop();
    this.traders = [];
    this.gridTraders = [];
    this.traderByName = {};
    this.gridTraderByName = {};
    systemStatus.bot = 'stopped';
  }

  setTickTimeMs(ms: number): void {
    const next = Math.max(200, Math.floor(Number(ms) || 0));
    this.currentTickMs = next;
    // restart all traders with new interval if running
    if (!(ThresholdTrader as any).globalHalt) {
      for (const t of this.traders) {
        t.stop();
        t.start(this.currentTickMs);
      }
    }
    if (!(GridTrader as any).globalHalt) {
      for (const gt of this.gridTraders) {
        gt.stop();
        gt.start(this.currentTickMs);
      }
    }
  }

  async addOrUpdateStrategy(): Promise<void> {
    if (!this.keypair) this.keypair = await ensureWallet(CONFIG.walletPath);
    const list = await getStrategies();
    for (const item of list) {
      const isGridStrategy = this.isGridStrategy(item);
      
      if (isGridStrategy) {
        if (this.gridTraderByName[item.name]) {
          // Existing grid trader picks up new config via loadConfig; restart if running and not halted
          if (!(GridTrader as any).globalHalt) {
            this.gridTraderByName[item.name].stop();
            this.gridTraderByName[item.name].start(this.currentTickMs);
          }
        } else {
          const gridTrader = new GridTrader(this.keypair.publicKey.toBase58(), async (serialized: string) => {
            if (!this.keypair) throw new Error('missing signer');
            logger.info('Signing and sending transaction');
            return signAndSendSerializedTransaction(serialized, this.keypair);
          });
          (gridTrader as any).loadConfig = async () => {
            const fresh = await getStrategies();
            const found = fresh.find((s) => s.name === item.name);
            return (found || item) as GridStrategyConfig;
          };
          this.gridTraders.push(gridTrader);
          this.gridTraderByName[item.name] = gridTrader;
          if (!(GridTrader as any).globalHalt) gridTrader.start(this.currentTickMs);
        }
      } else {
        if (this.traderByName[item.name]) {
          // Existing trader picks up new config via loadConfig; restart if running and not halted
          if (!(ThresholdTrader as any).globalHalt) {
            this.traderByName[item.name].stop();
            this.traderByName[item.name].start(this.currentTickMs);
          }
          // Retarget open positions for this strategy (update entry/target using new buy/sell pct)
          try {
            const name = item.name;
            const wallet = this.keypair?.publicKey.toBase58();
            if (name && wallet) {
              const instanceKey = `${wallet}:${name}`;
              const list: any[] = (ThresholdTrader as any).positionsFor?.[instanceKey] || [];
              const cfg: any = await (this.traderByName[name] as any).loadConfig();
              for (const p of list) {
                const from = p.fromSymbol || 'USDC';
                const to = p.toSymbol || p.symbol || 'SOL';
                const tokensMod: any = await import('../utils/tokens.js');
                const fromInfo = await tokensMod.resolveMint(from);
                const toInfo = await tokensMod.resolveMint(to);
                const pricesMod: any = await import('../jupiter/jupiter.js');
                const priceMap = await pricesMod.fetchPricesByMints([fromInfo.mint, toInfo.mint]);
                const fromUsd = priceMap[fromInfo.mint]?.usdc || null;
                const toUsd = priceMap[toInfo.mint]?.usdc || null;
                const pair = (fromUsd && toUsd) ? (toUsd / fromUsd) : null; // toToken per fromToken
                if (!pair) continue;
                const buyPct = cfg.buyPct ?? 0.05;
                const sellPct = cfg.sellPct ?? 0.05;
                if (p.side === 'long') {
                  p.target = pair * (1 + sellPct);
                } else if (p.side === 'short') {
                  p.target = pair * (1 - buyPct);
                }
              }
              ;(ThresholdTrader as any).emitAllPositions();
            }
          } catch {}
        } else {
          const trader = new ThresholdTrader(this.keypair.publicKey.toBase58(), async (serialized: string) => {
            if (!this.keypair) throw new Error('missing signer');
            logger.info('Signing and sending transaction');
            return signAndSendSerializedTransaction(serialized, this.keypair);
          });
          (trader as any).loadConfig = async () => {
            const fresh = await getStrategies();
            const found = fresh.find((s) => s.name === item.name);
            return (found || item) as StrategyConfig;
          };
          this.traders.push(trader);
          this.traderByName[item.name] = trader;
          if (!(ThresholdTrader as any).globalHalt) trader.start(this.currentTickMs);
        }
      }
    }
  }

  removeStrategy(name: string): void {
    const t = this.traderByName[name];
    const gt = this.gridTraderByName[name];
    
    if (t) {
      t.stop();
      delete this.traderByName[name];
      this.traders = this.traders.filter(tr => tr !== t);
    }
    
    if (gt) {
      gt.stop();
      delete this.gridTraderByName[name];
      this.gridTraders = this.gridTraders.filter(gtr => gtr !== gt);
    }
  }
}

export const tradingController = new TradingController();


