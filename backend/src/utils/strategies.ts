import { readJson, writeJson } from '../utils/fs.js';
import path from 'path';
import { CONFIG } from '../utils/config.js';

export type StrategyItem = {
  name: string;
  token: string;
  buyPct?: number;
  sellPct?: number;
  amount: number;
  inputMintUSDC?: string;
  tokenMint?: string;
  testMode?: boolean;
  fromToken?: string;
  toToken?: string;
  active?: boolean;
  // New optional controls
  marketEnter?: 'long' | 'short' | null;
  fixedAnchor?: boolean;
  anchorPairAtSetup?: number;
  scaleAggressiveness?: number;
  scaleStepPct?: number;
  slippageBps?: number;
  maxOpenPositions?: number;
  maxPositionSize?: number;
  lst?: boolean;
  navSource?: 'protocol' | 'ema';
  hysteresisBps?: number;
  cooldownMs?: number;
  feeBps?: number;
  extraSlippageBps?: number;
  
  // Grid trading parameters
  gridType?: 'arithmetic' | 'geometric' | 'fibonacci';
  gridSpacing?: number;
  gridLevels?: number;
  centerPrice?: number;
  totalAmount?: number;
  levelAmount?: number;
  initialBuyRange?: number;
  initialSellRange?: number;
  bias?: 'neutral' | 'long' | 'short';
  biasStrength?: number;
  maxPositions?: number;
  stopLoss?: number;
  takeProfit?: number;
  rebalanceThreshold?: number;
  adaptiveSpacing?: boolean;
  volatilityPeriod?: number;
  minLevelSpacing?: number;
  maxLevelSpacing?: number;
};

export const STRATEGY_LIST_PATH = (CONFIG as any).strategyListPath || 'backend/config/strategies.json';
const LEGACY_STRATEGY_LIST_PATH = 'backend/config/strategies.json';

export async function getStrategies(): Promise<StrategyItem[]> {
  const list = await readJson<StrategyItem[]>(STRATEGY_LIST_PATH, []);
  if (Array.isArray(list) && list.length > 0) return list;
  // migrate from legacy path if needed
  if (LEGACY_STRATEGY_LIST_PATH !== STRATEGY_LIST_PATH) {
    const legacy = await readJson<StrategyItem[]>(LEGACY_STRATEGY_LIST_PATH, []);
    if (Array.isArray(legacy) && legacy.length > 0) {
      await writeJson(STRATEGY_LIST_PATH, legacy);
      return legacy;
    }
  }
  return list;
}

export async function upsertStrategy(item: StrategyItem): Promise<StrategyItem[]> {
  const list = await getStrategies();
  const idx = list.findIndex((s) => s.name === item.name);
  if (idx >= 0) list[idx] = item; else list.push(item);
  await writeJson(STRATEGY_LIST_PATH, list);
  return list;
}

export async function removeStrategy(name: string): Promise<StrategyItem[]> {
  const list = await getStrategies();
  const updated = list.filter((s) => s.name !== name);
  await writeJson(STRATEGY_LIST_PATH, updated);
  return updated;
}

export async function migrateSingleStrategy(): Promise<void> {
  try {
    const single = await readJson<any>((CONFIG as any).strategyConfigPath || 'backend/config/strategy.json', null as any);
    if (!single) return;
    const name: string = single.name || '';
    const token: string = single.token || '';
    // skip migration if incomplete or unnamed DSOL; do not clear existing strategies
    if (!name || !token) return;
    if (!name && token.toUpperCase() === 'DSOL') return;
    const item: StrategyItem = {
      name,
      token,
      buyPct: single.buyPct ?? undefined,
      sellPct: single.sellPct ?? undefined,
      amount: single.amount ?? 0,
      inputMintUSDC: single.inputMintUSDC,
      tokenMint: single.tokenMint,
      testMode: single.testMode,
      fromToken: (single as any).fromToken,
      toToken: (single as any).toToken,
      active: (single as any).active !== false,
    };
    const list = await getStrategies();
    if (!list.find((s) => s.name === item.name)) {
      list.push(item);
      await writeJson(STRATEGY_LIST_PATH, list);
    }
  } catch {
    // ignore
  }
}


