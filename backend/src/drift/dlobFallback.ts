// @ts-nocheck
import { DriftDlobWs } from './priceWs.js';
import { logger } from '../utils/logger.js';

/**
 * Minimal bridge to nudge the filler loop using Drift DLOB WS updates
 * when the internal SDK DLOB is degraded/unavailable.
 */
export class DlobFallback {
  private ws: DriftDlobWs | null = null;
  private started = false;
  private onNudge: (() => void) | null = null;

  constructor(onNudge: () => void) {
    this.onNudge = onNudge;
  }

  async start(wantMarkets: number[]): Promise<void> {
    if (this.started) return;
    this.started = true;
    try {
      this.ws = new DriftDlobWs();
      await this.ws.start();
      // Subscribe to desired markets
      const indices = Array.isArray(wantMarkets) ? wantMarkets : [];
      for (const i of indices) {
        try { this.ws.subscribeMarket(Number(i)); } catch {}
      }
      // On any L2 update, nudge the filler loop
      this.ws.on('l2', () => {
        try { if (typeof this.onNudge === 'function') this.onNudge(); } catch {}
      });
      try { logger.info('drift.ws.fallback.started', { cat: 'drift', markets: indices.length }); } catch {}
    } catch (e: any) {
      try { logger.warn('drift.ws.fallback.failed_to_start', { cat: 'drift', err: String(e?.message || e) }); } catch {}
    }
  }

  updateMarkets(wantMarkets: number[]): void {
    try {
      if (!this.ws) return;
      const indices = Array.isArray(wantMarkets) ? wantMarkets : [];
      for (const i of indices) {
        try { this.ws.subscribeMarket(Number(i)); } catch {}
      }
    } catch {}
  }

  stop(): void {
    try { this.ws?.stop?.(); } catch {}
    this.ws = null;
    this.started = false;
    try { logger.info('drift.ws.fallback.stopped', { cat: 'drift' }); } catch {}
  }
}


