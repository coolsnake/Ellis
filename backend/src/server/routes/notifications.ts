// Notification routes for device registration and configuration

import type { Request, Response } from 'express';
import { Router } from 'express';
import type { Server as SocketIOServer } from 'socket.io';
import { logger } from '../../utils/logger.js';
import { emit } from '../realtime.js';
import {
  registerDeviceToken,
  unregisterDeviceToken,
  getUserDeviceTokens,
  loadNotificationConfig,
  saveNotificationConfig,
} from '../../notifications/deviceStore.js';
import { initFirebase, isFirebaseReady } from '../../notifications/firebase.js';
import { sendTestNotification } from '../../notifications/push.js';

// Helper to extract username from Basic Auth header
function extractUsername(req: Request): string | null {
  try {
    const header = req.headers['authorization'];
    if (!header) return null;
    const match = /^Basic\s+(.+)$/i.exec(header);
    if (!match) return null;
    const decoded = Buffer.from(match[1], 'base64').toString('utf-8');
    const [user] = decoded.split(':');
    return user || null;
  } catch {
    return null;
  }
}

export function createNotificationsRouter(_io: SocketIOServer): Router {
  const api = Router();

  // Get notification status and config
  api.get('/notifications/status', async (req: Request, res: Response) => {
    try {
      const username = extractUsername(req);
      const config = await loadNotificationConfig();
      const firebaseReady = isFirebaseReady();
      
      let deviceCount = 0;
      if (username) {
        const tokens = await getUserDeviceTokens(username);
        deviceCount = tokens.length;
      }
      
      res.json({
        enabled: config.enabled,
        firebaseReady,
        deviceCount,
        profitThresholds: config.profitThresholds,
      });
    } catch (e: any) {
      logger.error('notifications: Failed to get status', { error: String(e?.message || e), cat: 'notifications' });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // Register a device token
  api.post('/notifications/register', async (req: Request, res: Response) => {
    try {
      const username = extractUsername(req);
      if (!username) {
        return res.status(401).json({ error: 'Authentication required' });
      }
      
      const { token, platform } = req.body as { token?: string; platform?: 'android' };
      
      if (!token || typeof token !== 'string') {
        return res.status(400).json({ error: 'token is required' });
      }
      
      if (platform && platform !== 'android') {
        return res.status(400).json({ error: 'Only android platform is supported' });
      }
      
      await registerDeviceToken(username, token, platform || 'android');
      
      emit('log', {
        level: 'info',
        message: `notifications: Device registered for ${username}`,
        timestamp: new Date().toISOString(),
        context: { cat: 'notifications' },
      });
      
      res.json({ ok: true, message: 'Device registered' });
    } catch (e: any) {
      logger.error('notifications: Failed to register device', { error: String(e?.message || e), cat: 'notifications' });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // Unregister a device token
  api.delete('/notifications/unregister', async (req: Request, res: Response) => {
    try {
      const username = extractUsername(req);
      if (!username) {
        return res.status(401).json({ error: 'Authentication required' });
      }
      
      const { token } = req.body as { token?: string };
      
      if (!token || typeof token !== 'string') {
        return res.status(400).json({ error: 'token is required' });
      }
      
      const removed = await unregisterDeviceToken(username, token);
      
      if (removed) {
        emit('log', {
          level: 'info',
          message: `notifications: Device unregistered for ${username}`,
          timestamp: new Date().toISOString(),
          context: { cat: 'notifications' },
        });
      }
      
      res.json({ ok: true, removed });
    } catch (e: any) {
      logger.error('notifications: Failed to unregister device', { error: String(e?.message || e), cat: 'notifications' });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // Get notification configuration
  api.get('/notifications/config', async (_req: Request, res: Response) => {
    try {
      const config = await loadNotificationConfig();
      res.json(config);
    } catch (e: any) {
      logger.error('notifications: Failed to get config', { error: String(e?.message || e), cat: 'notifications' });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // Update notification configuration
  api.patch('/notifications/config', async (req: Request, res: Response) => {
    try {
      const { enabled, profitThresholds } = req.body as {
        enabled?: boolean;
        profitThresholds?: {
          low?: number;
          medium?: number;
          high?: number;
          critical?: number;
        };
      };
      
      const updates: any = {};
      
      if (typeof enabled === 'boolean') {
        updates.enabled = enabled;
      }
      
      if (profitThresholds && typeof profitThresholds === 'object') {
        updates.profitThresholds = {};
        if (typeof profitThresholds.low === 'number') {
          updates.profitThresholds.low = Math.max(0, profitThresholds.low);
        }
        if (typeof profitThresholds.medium === 'number') {
          updates.profitThresholds.medium = Math.max(0, profitThresholds.medium);
        }
        if (typeof profitThresholds.high === 'number') {
          updates.profitThresholds.high = Math.max(0, profitThresholds.high);
        }
        if (typeof profitThresholds.critical === 'number') {
          updates.profitThresholds.critical = Math.max(0, profitThresholds.critical);
        }
      }
      
      const config = await saveNotificationConfig(updates);
      
      emit('log', {
        level: 'info',
        message: `notifications: Config updated`,
        timestamp: new Date().toISOString(),
        context: { cat: 'notifications' },
      });
      
      res.json(config);
    } catch (e: any) {
      logger.error('notifications: Failed to update config', { error: String(e?.message || e), cat: 'notifications' });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // Send test notification
  api.post('/notifications/test', async (req: Request, res: Response) => {
    try {
      const result = await sendTestNotification();
      
      emit('log', {
        level: result.success ? 'info' : 'warn',
        message: `notifications: Test ${result.success ? 'succeeded' : 'failed'} - ${result.message}`,
        timestamp: new Date().toISOString(),
        context: { cat: 'notifications' },
      });
      
      res.json(result);
    } catch (e: any) {
      logger.error('notifications: Failed to send test', { error: String(e?.message || e), cat: 'notifications' });
      res.status(500).json({ success: false, message: String(e?.message || e) });
    }
  });

  // Get user's registered devices
  api.get('/notifications/devices', async (req: Request, res: Response) => {
    try {
      const username = extractUsername(req);
      if (!username) {
        return res.status(401).json({ error: 'Authentication required' });
      }
      
      const tokens = await getUserDeviceTokens(username);
      
      // Return sanitized list (don't expose full tokens)
      const devices = tokens.map(t => ({
        platform: t.platform,
        registeredAt: t.registeredAt,
        lastUsed: t.lastUsed,
        tokenPrefix: t.token.slice(0, 20) + '...',
      }));
      
      res.json({ devices });
    } catch (e: any) {
      logger.error('notifications: Failed to get devices', { error: String(e?.message || e), cat: 'notifications' });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  return api;
}

// Initialize Firebase on module load
initFirebase().catch(() => {});
