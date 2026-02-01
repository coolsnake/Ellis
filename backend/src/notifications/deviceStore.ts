// Device token storage for push notifications
// Stores tokens per authenticated user

import { resolve } from 'path';
import { readJson, writeJson, ensureDir, joinPath } from '../utils/fs.js';
import { logger } from '../utils/logger.js';
import type { DeviceToken, DeviceTokenStore, NotificationConfig } from './types.js';
import { DEFAULT_NOTIFICATION_CONFIG } from './types.js';

const DEVICE_TOKENS_PATH = resolve('config', 'device-tokens.json');
const NOTIFICATION_CONFIG_PATH = resolve('config', 'notification-config.json');

// In-memory cache
let tokenStore: DeviceTokenStore = { users: {} };
let notificationConfig: NotificationConfig = { ...DEFAULT_NOTIFICATION_CONFIG };
let storeLoaded = false;
let configLoaded = false;

/**
 * Load device tokens from disk
 */
async function loadTokenStore(): Promise<DeviceTokenStore> {
  if (storeLoaded) return tokenStore;
  
  try {
    await ensureDir(joinPath(DEVICE_TOKENS_PATH, '..'));
    const data = await readJson<DeviceTokenStore>(DEVICE_TOKENS_PATH, { users: {} });
    tokenStore = data || { users: {} };
    storeLoaded = true;
  } catch {
    tokenStore = { users: {} };
    storeLoaded = true;
  }
  
  return tokenStore;
}

/**
 * Save device tokens to disk
 */
async function saveTokenStore(): Promise<void> {
  try {
    await ensureDir(joinPath(DEVICE_TOKENS_PATH, '..'));
    await writeJson(DEVICE_TOKENS_PATH, tokenStore);
  } catch (err: any) {
    logger.warn('notifications: Failed to save device tokens', {
      error: String(err?.message || err),
      cat: 'notifications',
    });
  }
}

/**
 * Register a device token for a user
 */
export async function registerDeviceToken(
  username: string,
  token: string,
  platform: 'android' = 'android'
): Promise<void> {
  await loadTokenStore();
  
  if (!tokenStore.users[username]) {
    tokenStore.users[username] = { tokens: [] };
  }
  
  const userDevices = tokenStore.users[username];
  
  // Check if token already exists
  const existingIndex = userDevices.tokens.findIndex(t => t.token === token);
  
  if (existingIndex >= 0) {
    // Update existing token
    userDevices.tokens[existingIndex].lastUsed = Date.now();
  } else {
    // Add new token
    userDevices.tokens.push({
      token,
      platform,
      registeredAt: Date.now(),
    });
  }
  
  // Limit to 10 devices per user
  if (userDevices.tokens.length > 10) {
    // Remove oldest tokens
    userDevices.tokens.sort((a, b) => (b.lastUsed || b.registeredAt) - (a.lastUsed || a.registeredAt));
    userDevices.tokens = userDevices.tokens.slice(0, 10);
  }
  
  await saveTokenStore();
  
  logger.info('notifications: Device token registered', {
    username,
    platform,
    tokenCount: userDevices.tokens.length,
    cat: 'notifications',
  });
}

/**
 * Unregister a device token for a user
 */
export async function unregisterDeviceToken(
  username: string,
  token: string
): Promise<boolean> {
  await loadTokenStore();
  
  if (!tokenStore.users[username]) {
    return false;
  }
  
  const before = tokenStore.users[username].tokens.length;
  tokenStore.users[username].tokens = tokenStore.users[username].tokens.filter(
    t => t.token !== token
  );
  const removed = tokenStore.users[username].tokens.length < before;
  
  if (removed) {
    await saveTokenStore();
    logger.info('notifications: Device token unregistered', {
      username,
      cat: 'notifications',
    });
  }
  
  return removed;
}

/**
 * Get all device tokens for a user
 */
export async function getUserDeviceTokens(username: string): Promise<DeviceToken[]> {
  await loadTokenStore();
  return tokenStore.users[username]?.tokens || [];
}

/**
 * Get all device tokens across all users
 */
export async function getAllDeviceTokens(): Promise<string[]> {
  await loadTokenStore();
  
  const tokens: string[] = [];
  for (const username of Object.keys(tokenStore.users)) {
    for (const device of tokenStore.users[username].tokens) {
      tokens.push(device.token);
    }
  }
  
  return tokens;
}

/**
 * Remove invalid/expired tokens
 */
export async function cleanupInvalidTokens(invalidTokens: string[]): Promise<void> {
  if (!invalidTokens.length) return;
  
  await loadTokenStore();
  
  const invalidSet = new Set(invalidTokens);
  let removedCount = 0;
  
  for (const username of Object.keys(tokenStore.users)) {
    const before = tokenStore.users[username].tokens.length;
    tokenStore.users[username].tokens = tokenStore.users[username].tokens.filter(
      t => !invalidSet.has(t.token)
    );
    removedCount += before - tokenStore.users[username].tokens.length;
  }
  
  if (removedCount > 0) {
    await saveTokenStore();
    logger.info('notifications: Cleaned up invalid tokens', {
      removedCount,
      cat: 'notifications',
    });
  }
}

/**
 * Load notification configuration
 */
export async function loadNotificationConfig(): Promise<NotificationConfig> {
  if (configLoaded) return notificationConfig;
  
  try {
    await ensureDir(joinPath(NOTIFICATION_CONFIG_PATH, '..'));
    const data = await readJson<NotificationConfig>(NOTIFICATION_CONFIG_PATH, DEFAULT_NOTIFICATION_CONFIG);
    notificationConfig = { ...DEFAULT_NOTIFICATION_CONFIG, ...data };
    configLoaded = true;
  } catch {
    notificationConfig = { ...DEFAULT_NOTIFICATION_CONFIG };
    configLoaded = true;
  }
  
  return notificationConfig;
}

/**
 * Save notification configuration
 */
export async function saveNotificationConfig(config: Partial<NotificationConfig>): Promise<NotificationConfig> {
  await loadNotificationConfig();
  
  notificationConfig = {
    ...notificationConfig,
    ...config,
    profitThresholds: {
      ...notificationConfig.profitThresholds,
      ...(config.profitThresholds || {}),
    },
  };
  
  try {
    await ensureDir(joinPath(NOTIFICATION_CONFIG_PATH, '..'));
    await writeJson(NOTIFICATION_CONFIG_PATH, notificationConfig);
  } catch (err: any) {
    logger.warn('notifications: Failed to save notification config', {
      error: String(err?.message || err),
      cat: 'notifications',
    });
  }
  
  return notificationConfig;
}

/**
 * Get current notification configuration (cached)
 */
export function getNotificationConfig(): NotificationConfig {
  return notificationConfig;
}
