export type DriftCluster = 'mainnet-beta' | 'devnet' | 'localnet';

export type DriftMarketRef = {
  marketIndex: number;
  symbol?: string;
};

export type LeveragedGridConfig = {
  name: string;
  market: DriftMarketRef;
  subaccountId: number;
  leverage: number; // target max effective leverage
  liquidationBufferPct: number; // e.g., 0.25 = 25%
  gridLower: number; // lower bound price
  gridUpper: number; // upper bound price
  levels: number; // ladder count per side
  stepPct?: number; // optional percentage spacing if bounds not used
  notionalPerLevel: number; // quote notional per level
  makerOnly?: boolean;
  fundingGuard?: boolean;
  rebalanceHysteresisPct?: number;
  maxOpenOrders?: number;
  enabled: boolean;
  // Sliding center behavior (mirror classic grid)
  slidingCenter?: boolean; // enable sliding center price
  slideRate?: number; // bps per second toward current
  slideMaxDistance?: number; // percent cap from original center
};

export type SubaccountInfo = {
  id: number;
  freeCollateral: number; // quote units
  totalCollateral: number; // quote units
  maintenanceRequirement: number; // quote units
  initialRequirement: number; // quote units
  effectiveLeverage: number;
  positions: Array<{ marketIndex: number; base: number; entryPrice?: number }>;
};

export type DriftStatus = {
  cluster: DriftCluster;
  programId?: string;
  subaccounts: SubaccountInfo[];
  markets: DriftMarketRef[];
};

export type GridRuntimeState = {
  running: boolean;
  config?: LeveragedGridConfig;
  openOrders: number;
  netExposure: number; // base units
  effectiveLeverage: number;
  liquidationBuffer: number; // (collateral - maint) / maint
  fundingRateApy?: number;
  // Sliding center tracking for UI/reporting
  centerPrice?: number;
  originalCenterPrice?: number;
  lastSlideUpdate?: number;
};


