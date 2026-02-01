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
  profitThresholds: {
    low: number;      // USD threshold for low priority (default: 0)
    medium: number;   // USD threshold for medium priority (default: 1)
    high: number;     // USD threshold for high priority (default: 10)
    critical: number; // USD threshold for critical priority (default: 100)
  };
}

export interface ArbNotificationPayload {
  id: string;
  signature: string;
  timestamp: number;
  path: string[];
  hops: number;
  dexes: string[];
  sizeUsd?: number;
  expectedProfitBps?: number;
  estimatedProfitUsd?: number;
  priority: NotificationPriority;
  summary: string;
}

export const DEFAULT_NOTIFICATION_CONFIG: NotificationConfig = {
  enabled: true,
  profitThresholds: {
    low: 0,
    medium: 1,
    high: 10,
    critical: 100,
  },
};
