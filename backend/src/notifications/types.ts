// Notification system types

export type NotificationPriority = 'low' | 'medium' | 'high' | 'critical';

export interface DeviceToken {
  token: string;
  platform: 'android';
  registeredAt: number;
  lastUsed?: number;
}

export interface UserDevices {
  tokens: DeviceToken[];
}

export interface DeviceTokenStore {
  users: Record<string, UserDevices>;
}

export interface NotificationConfig {
  enabled: boolean;
  // Arb settings
  arbEnabled: boolean;
  profitThresholds: {
    low: number;      // USD threshold for low priority (default: 0)
    medium: number;   // USD threshold for medium priority (default: 1)
    high: number;     // USD threshold for high priority (default: 10)
    critical: number; // USD threshold for critical priority (default: 100)
  };
  // Drift settings
  driftEnabled: boolean;
  driftActions: Array<'fill' | 'trigger' | 'liquidate'>;
  driftMinRewardUsd: number;  // Minimum filler reward to notify
  driftNotifyFailures: boolean;  // Notify on failed txs
}

export interface ArbNotificationPayload {
  id: string;
  signature: string;
  timestamp: number;
  path: string[];
  pathSymbols?: string[]; // Token symbols corresponding to path mints
  hops: number;
  dexes: string[];
  sizeUsd?: number;
  expectedProfitBps?: number;
  estimatedProfitUsd?: number; // Best available profit (actual if available, otherwise estimated)
  actualProfitUsd?: number;    // Actual profit from transaction execution (if available)
  isActualProfit?: boolean;    // True if estimatedProfitUsd is from actual execution
  priority: NotificationPriority;
  summary: string;
}

export interface DriftNotificationPayload {
  id: string;
  signature: string;
  timestamp: number;
  action: 'fill' | 'trigger' | 'liquidate';
  marketIndex?: number;
  marketSymbol?: string;
  success: boolean;
  baseFilled?: number;
  quoteFilled?: number;
  fillerRewardQuote?: number;
  fillerRewardUsd?: number;
  lamportsPaid: number;
  bot?: string;
  priority: NotificationPriority;
  summary: string;
}

export const DEFAULT_NOTIFICATION_CONFIG: NotificationConfig = {
  enabled: true,
  // Arb defaults
  arbEnabled: true,
  profitThresholds: {
    low: 0,
    medium: 1,
    high: 10,
    critical: 100,
  },
  // Drift defaults
  driftEnabled: true,
  driftActions: ['fill', 'trigger', 'liquidate'],
  driftMinRewardUsd: 0,
  driftNotifyFailures: false,
};
