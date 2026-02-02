// Push notification service for arb confirmations

import { logger } from '../utils/logger.js';
import { emit } from '../server/realtime.js';
import { getMessaging, isFirebaseReady } from './firebase.js';
import { getAllDeviceTokens, cleanupInvalidTokens, loadNotificationConfig } from './deviceStore.js';
import { loadJupiterTokenMap } from '../utils/tokens.js';
import type { TxRecord } from '../server/txHistory.js';
import type { NotificationPriority, ArbNotificationPayload } from './types.js';

// Cache for token symbol lookups
let tokenSymbolCache: Record<string, string> = {};
let tokenCacheLoaded = false;

/**
 * Load and cache token symbols from Jupiter token list
 */
async function ensureTokenCache(): Promise<void> {
  if (tokenCacheLoaded) return;
  try {
    const jupMap = await loadJupiterTokenMap();
    for (const [mint, info] of Object.entries(jupMap)) {
      tokenSymbolCache[mint] = info.symbol;
    }
    tokenCacheLoaded = true;
  } catch {
    // Fallback to common tokens
    tokenSymbolCache = {
      'So11111111111111111111111111111111111111112': 'SOL',
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': 'USDC',
      'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': 'USDT',
    };
    tokenCacheLoaded = true;
  }
}

/**
 * Convert mint address to symbol (short form if unknown)
 */
function mintToSymbol(mint: string): string {
  if (tokenSymbolCache[mint]) return tokenSymbolCache[mint];
  // Return shortened mint if unknown
  return mint.slice(0, 4) + '..';
}

/**
 * Calculate notification priority based on estimated profit
 */
function calculatePriority(estimatedProfitUsd: number): NotificationPriority {
  const config = loadNotificationConfig();
  const thresholds = config.then ? undefined : (config as any).profitThresholds;
  
  // Use defaults if config not loaded yet
  const t = thresholds || { low: 0, medium: 1, high: 10, critical: 100 };
  
  if (estimatedProfitUsd >= t.critical) return 'critical';
  if (estimatedProfitUsd >= t.high) return 'high';
  if (estimatedProfitUsd >= t.medium) return 'medium';
  return 'low';
}

/**
 * Format profit with dynamic precision based on magnitude.
 * Smaller profits get more decimal places for readability.
 */
function formatProfitUsd(usd: number): string {
  if (usd >= 1) return usd.toFixed(2);      // $1.23
  if (usd >= 0.01) return usd.toFixed(3);   // $0.123
  if (usd >= 0.001) return usd.toFixed(4);  // $0.0123
  return usd.toFixed(5);                     // $0.00123
}

/**
 * Get profit in USD from TxRecord.
 * Prefers actual profit from execution, falls back to estimated if not available.
 */
function getProfitUsd(rec: TxRecord): { profitUsd: number; isActual: boolean } {
  // Prefer actual profit from transaction execution
  if (rec.actualProfitUsd !== undefined && rec.actualProfitUsd !== null) {
    return { profitUsd: rec.actualProfitUsd, isActual: true };
  }
  // Fall back to estimated profit
  if (rec.sizeUsd && rec.expectedProfitBps) {
    return { profitUsd: rec.sizeUsd * (rec.expectedProfitBps / 10000), isActual: false };
  }
  return { profitUsd: 0, isActual: false };
}

/**
 * Build notification payload from TxRecord
 */
async function buildNotificationPayload(rec: TxRecord): Promise<ArbNotificationPayload> {
  // Ensure token cache is loaded
  await ensureTokenCache();
  
  // Get profit (actual from execution if available, otherwise estimated)
  const { profitUsd, isActual } = getProfitUsd(rec);
  const priority = calculatePriority(profitUsd);
  const dexes = [...new Set(rec.hops.map(h => h.dex))];
  
  // Convert mints to symbols for display
  const pathSymbols = rec.path.map(mint => mintToSymbol(mint));
  const pathDisplay = pathSymbols.join(' → ');
  
  // Build human-readable summary with profit first
  const profitStr = profitUsd > 0 
    ? `+$${formatProfitUsd(profitUsd)}${isActual ? '' : '~'}` // Add ~ suffix if estimated
    : 'Confirmed';
  const summary = `${profitStr} | ${pathDisplay} via ${dexes.join('/')}`;
  
  return {
    id: rec.id,
    signature: rec.signature || '',
    timestamp: rec.confirmedAt || Date.now(),
    path: rec.path,
    pathSymbols, // Include symbols for mobile app
    hops: rec.hops.length,
    dexes,
    sizeUsd: rec.sizeUsd,
    expectedProfitBps: rec.expectedProfitBps,
    estimatedProfitUsd: profitUsd, // Now contains actual profit if available
    actualProfitUsd: rec.actualProfitUsd, // Include actual profit separately
    isActualProfit: isActual, // Flag to indicate if profit is actual or estimated
    priority,
    summary,
  };
}

/**
 * Send push notification for a confirmed arb transaction
 */
export async function sendArbNotification(rec: TxRecord): Promise<void> {
  // Check if Firebase is ready
  if (!isFirebaseReady()) {
    return;
  }
  
  // Check if notifications are enabled
  const config = await loadNotificationConfig();
  if (!config.enabled) {
    return;
  }
  
  // Get all device tokens
  const tokens = await getAllDeviceTokens();
  if (tokens.length === 0) {
    return;
  }
  
  const messaging = getMessaging();
  if (!messaging) {
    return;
  }
  
  // Build notification payload
  const payload = await buildNotificationPayload(rec);
  
  // Format notification with profit first, then route
  // Use actual profit if available, add ~ suffix if estimated
  const profitDisplay = payload.estimatedProfitUsd && payload.estimatedProfitUsd > 0 
    ? `+$${formatProfitUsd(payload.estimatedProfitUsd)}${payload.isActualProfit ? '' : '~'}` 
    : 'Confirmed';
  const routeDisplay = payload.pathSymbols?.join(' → ') || payload.path.join(' → ');
  
  try {
    const response = await messaging.sendEachForMulticast({
      tokens,
      notification: {
        // Title: Profit amount prominently
        title: profitDisplay,
        // Body: Route with token symbols
        body: `${routeDisplay} via ${payload.dexes.join('/')}`,
      },
      data: {
        type: 'arb_confirmed',
        id: payload.id,
        signature: payload.signature,
        path: JSON.stringify(payload.path),
        pathSymbols: JSON.stringify(payload.pathSymbols || []),
        hops: String(payload.hops),
        dexes: JSON.stringify(payload.dexes),
        priority: payload.priority,
        profitUsd: String(payload.estimatedProfitUsd || 0),
        actualProfitUsd: String(payload.actualProfitUsd ?? ''),
        isActualProfit: String(payload.isActualProfit ?? false),
        sizeUsd: String(payload.sizeUsd || 0),
        timestamp: String(payload.timestamp),
      },
      android: {
        priority: 'high',
        notification: {
          channelId: `arb-${payload.priority}`,
          // LED color based on priority (hex string)
          // color is for icon tint, not LED - LED is controlled by channel on device
          color: payload.priority === 'critical' ? '#FF0000' 
               : payload.priority === 'high' ? '#FFD700'
               : payload.priority === 'medium' ? '#00FF00'
               : '#FFFFFF',
        },
      },
    });
    
    // Log success/failure stats
    logger.info('notifications: Push notification sent', {
      successCount: response.successCount,
      failureCount: response.failureCount,
      priority: payload.priority,
      profitUsd: payload.estimatedProfitUsd,
      cat: 'notifications',
    });
    
    // Emit log event for UI
    emit('log', {
      level: 'info',
      message: `notifications: Push sent to ${response.successCount} device(s) - ${profitDisplay}`,
      timestamp: new Date().toISOString(),
      context: { cat: 'notifications' },
    });
    
    // Handle invalid tokens
    if (response.failureCount > 0) {
      const invalidTokens: string[] = [];
      response.responses.forEach((resp, idx) => {
        if (!resp.success && resp.error) {
          const errorCode = resp.error.code;
          // Remove tokens that are invalid or unregistered
          if (
            errorCode === 'messaging/invalid-registration-token' ||
            errorCode === 'messaging/registration-token-not-registered'
          ) {
            invalidTokens.push(tokens[idx]);
          }
        }
      });
      
      if (invalidTokens.length > 0) {
        await cleanupInvalidTokens(invalidTokens);
      }
    }
  } catch (err: any) {
    logger.warn('notifications: Failed to send push notification', {
      error: String(err?.message || err),
      cat: 'notifications',
    });
  }
}

/**
 * Send a test notification to verify setup
 */
export async function sendTestNotification(): Promise<{ success: boolean; message: string }> {
  if (!isFirebaseReady()) {
    return { success: false, message: 'Firebase not initialized' };
  }
  
  const tokens = await getAllDeviceTokens();
  if (tokens.length === 0) {
    return { success: false, message: 'No registered devices' };
  }
  
  const messaging = getMessaging();
  if (!messaging) {
    return { success: false, message: 'Messaging service unavailable' };
  }
  
  try {
    const response = await messaging.sendEachForMulticast({
      tokens,
      notification: {
        title: 'Lockstone Test',
        body: 'Push notifications are working!',
      },
      data: {
        type: 'test',
        timestamp: String(Date.now()),
      },
      android: {
        priority: 'high',
        notification: {
          channelId: 'arb-medium',
        },
      },
    });
    
    return {
      success: response.successCount > 0,
      message: `Sent to ${response.successCount}/${tokens.length} devices`,
    };
  } catch (err: any) {
    return {
      success: false,
      message: String(err?.message || err),
    };
  }
}
