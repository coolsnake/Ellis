import { CONFIG } from './config.js';

export type LiquidatorCfg = {
  // Account selection and sizing caps
  subaccountId?: number;
  maxAttemptNotional?: number;
  testMaxAttemptNotional?: number;
  testSizeFraction?: number;
  discoverAllUsers?: boolean;
  maxDiscoveredUsers?: number;
  usersAllowlist?: string[];
  usePriceTriggers?: boolean;
  priceTriggerDebounceMs?: number;
  httpPollMs?: number;
  maxUsersPerPriceTick?: number;
  riskHealthThreshold?: number;
  maxCancels?: number;
  maxPerpAttempts?: number;
  perpSizeFraction?: number;
  maxSpotAttempts?: number;
  spotSizeFraction?: number;
  targetCooldownMs?: number;
  scanConcurrency?: number;
  userCacheMax?: number;
};

export type DriftConfig = {
  cluster: 'mainnet-beta' | 'devnet' | 'localnet' | string;
  programId?: string;
  subscriptionType?: 'websocket' | 'polling';
  marketsAllowlist?: string[];
  feeMakerBps?: number;
  feeTakerBps?: number;
  maxFundingApy?: number;
  enableWsPrices?: boolean;
  wsOnlyPrices?: boolean;
  priceStaleMs?: number;
  websocketIntervalMs?: number;
  dlobUrl?: string;
  dlobWsUrl?: string;
  dlobPriceScale?: number;
  wsHeartbeatMs?: number;
  wsReconnectMinMs?: number;
  wsResubChunkSize?: number;
  httpTimeoutMs?: number;
  liquidator?: LiquidatorCfg;
};

export function getDriftConfig(): DriftConfig {
  const d: any = (CONFIG as any)?.drift || {};
  return {
    cluster: d.cluster || 'mainnet-beta',
    programId: d.programId,
    subscriptionType: d.subscriptionType || 'websocket',
    marketsAllowlist: Array.isArray(d.marketsAllowlist) ? d.marketsAllowlist : [],
    feeMakerBps: Number(d.feeMakerBps || 0),
    feeTakerBps: Number(d.feeTakerBps || 5),
    maxFundingApy: typeof d.maxFundingApy === 'number' ? d.maxFundingApy : undefined,
    enableWsPrices: !!d.enableWsPrices,
    wsOnlyPrices: (d.wsOnlyPrices !== undefined ? !!d.wsOnlyPrices : true),
    priceStaleMs: Number(d.priceStaleMs || 3000),
    websocketIntervalMs: Number(d.websocketIntervalMs || 400),
    dlobUrl: d.dlobUrl || 'https://dlob.drift.trade',
    dlobWsUrl: d.dlobWsUrl || 'wss://dlob.drift.trade/ws',
    dlobPriceScale: Number(d.dlobPriceScale || 1_000_000),
    wsHeartbeatMs: Number(d.wsHeartbeatMs || 15000),
    wsReconnectMinMs: Number(d.wsReconnectMinMs || 1000),
    wsResubChunkSize: Number(d.wsResubChunkSize || 25),
    httpTimeoutMs: Number(d.httpTimeoutMs || 1200),
    liquidator: d.liquidator || {},
  } as DriftConfig;
}


