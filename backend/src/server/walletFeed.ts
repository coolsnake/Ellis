import type { Server as SocketIOServer } from 'socket.io';
import { CONFIG } from '../utils/config.js';
import { ensureWallet, getBalances } from '../wallet/wallet.js';
import { logger } from '../utils/logger.js';
import { emit } from './realtime.js';

export class WalletFeed {
  private interval?: NodeJS.Timeout;
  private enabled = false;
  private polling = false;
  private lastActivity = 0;
  private readonly ACTIVITY_THRESHOLD = 30000; // 30 seconds

  constructor(private readonly io: SocketIOServer) {}

  startEvery(ms = 60000) { // Changed from 10000 to 60000 (1 minute)
    if (this.enabled) return;
    this.enabled = true;
    this.poll().catch((e) => {
      logger.error('wallet poll failed', { error: String(e) });
      try { emit('log', { level: 'error', message: `wallet: poll failed ${String(e?.message || e)}`, timestamp: new Date().toLocaleTimeString(), context: { cat: 'wallet' } }); } catch {}
    });
    this.interval = setInterval(() => {
      this.poll().catch((e) => {
        logger.error('wallet poll failed', { error: String(e) });
        try { emit('log', { level: 'error', message: `wallet: poll failed ${String(e?.message || e)}`, timestamp: new Date().toLocaleTimeString(), context: { cat: 'wallet' } }); } catch {}
      });
    }, ms);
  }

  stop() {
    if (this.interval) clearInterval(this.interval);
    this.interval = undefined;
  }

  // Manual refresh trigger
  async refresh() {
    if (this.polling) return;
    this.lastActivity = Date.now();
    await this.poll();
  }

  // Mark activity for smart refresh
  markActivity() {
    this.lastActivity = Date.now();
  }

  private async poll() {
    if (this.polling) return;
    this.polling = true;
    try {
      const kp = await ensureWallet(CONFIG.walletPath);
      const balances = await getBalances(kp.publicKey);
      this.io.emit('wallet-update', { address: kp.publicKey.toBase58(), balances });
    } finally {
      this.polling = false;
    }
  }

  // Smart refresh based on recent activity
  private shouldRefresh(): boolean {
    const now = Date.now();
    return now - this.lastActivity < this.ACTIVITY_THRESHOLD;
  }
}

export function createWalletFeed(io: SocketIOServer) {
  return new WalletFeed(io);
}


