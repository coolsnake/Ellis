// Push notification service for arb confirmations

import { logger } from '../utils/logger.js';
import { emit } from '../server/realtime.js';
import { getMessaging, isFirebaseReady } from './firebase.js';
import { getAllDeviceTokens, cleanupInvalidTokens, loadNotificationConfig } from './deviceStore.js';
import type { TxRecord } from '../server/txHistory.js';
import type { NotificationPriority, ArbNotificationPayload } from './types.js';

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
 * Estimate profit in USD from TxRecord
 */
function estimateProfitUsd(rec: TxRecord): number {
  if (rec.sizeUsd && rec.expectedProfitBps) {
    return rec.sizeUsd * (rec.expectedProfitBps / 10000);
  }
  return 0;
}

/**
 * Build notification payload from TxRecord
 */
function buildNotificationPayload(rec: TxRecord): ArbNotificationPayload {
  const estimatedProfitUsd = estimateProfitUsd(rec);
  const priority = calculatePriority(estimatedProfitUsd);
  const dexes = [...new Set(rec.hops.map(h => h.dex))];
  
  // Build human-readable summary
  const pathDisplay = rec.path.join(' → ');
  const profitStr = estimatedProfitUsd > 0 
    ? `+$${estimatedProfitUsd.toFixed(4)}` 
    : 'profit TBD';
  const summary = `${pathDisplay} via ${rec.hops.length} hop${rec.hops.length !== 1 ? 's' : ''} (${dexes.join(', ')}) - ${profitStr}`;
  
  return {
    id: rec.id,
    signature: rec.signature || '',
    timestamp: rec.confirmedAt || Date.now(),
    path: rec.path,
    hops: rec.hops.length,
    dexes,
    sizeUsd: rec.sizeUsd,
    expectedProfitBps: rec.expectedProfitBps,
    estimatedProfitUsd,
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
  const payload = buildNotificationPayload(rec);
  
  // Prepare FCM message
  const profitDisplay = payload.estimatedProfitUsd > 0 
    ? `+$${payload.estimatedProfitUsd.toFixed(4)}` 
    : 'Confirmed';
  
  try {
    const response = await messaging.sendEachForMulticast({
      tokens,
      notification: {
        title: `Arb ${profitDisplay}: ${payload.path.join(' → ')}`,
        body: payload.summary,
      },
      data: {
        type: 'arb_confirmed',
        id: payload.id,
        signature: payload.signature,
        path: JSON.stringify(payload.path),
        hops: String(payload.hops),
        dexes: JSON.stringify(payload.dexes),
        priority: payload.priority,
        profitUsd: String(payload.estimatedProfitUsd || 0),
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
