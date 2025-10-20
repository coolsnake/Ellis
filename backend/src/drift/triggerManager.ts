// @ts-nocheck
import { SlotSubscriber, BlockhashSubscriber, PriorityFeeSubscriber, PublicKey } from '@drift-labs/sdk';
import { DriftService } from './client.js';
import { logger } from '../logger.js';

export class TriggerManager {
  private trig: any | null = null;
  private stats: { lastRunMs?: number; lastError?: string; triggers?: number; errors?: number } = {};

  async start(cfg: any, globalCfg: any) {
    if (this.trig) { logger.info('[trigger] already running'); return; }
    const drift = DriftService.getInstance();
    await drift.init();

    const slotSub = new SlotSubscriber(drift.connection, { commitment: 'confirmed' });
    await slotSub.subscribe();

    const blockhashSub = new BlockhashSubscriber(drift.connection, { commitment: 'confirmed' });
    await blockhashSub.subscribe();

    const priority = new PriorityFeeSubscriber(drift.connection);
    const addrs = Array.isArray(cfg?.priorityFeeAddresses) ? cfg.priorityFeeAddresses : [];
    if (addrs.length) {
      try { priority.updateAddresses(addrs.map((s: string) => new PublicKey(s))); } catch {}
    }

    const sdk = await import('@drift-labs/sdk');
    const ev = new (sdk as any).EventSubscriber(drift.connection, drift.program);
    try { await ev.subscribe(); } catch {}
    const userMap = new (sdk as any).UserMap({ connection: drift.connection, program: drift.program, eventSubscriber: ev });
    await userMap.subscribe();

    const runtimeSpec = { driftEnv: (drift as any).cluster };
    let TriggerCtor: any;
    try {
      const mod = await import('./trigger.js');
      TriggerCtor = (mod as any).TriggerBot;
    } catch {
      const mod = await import('./trigger_lean.js');
      TriggerCtor = (mod as any).TriggerBot;
    }

    this.trig = new (TriggerCtor as any)(
      drift.client, slotSub, blockhashSub, userMap, runtimeSpec, cfg || {}, globalCfg || {}, priority
    );

    await this.trig.init();
    try {
      const origTry = (this.trig as any)?.tryTrigger?.bind(this.trig);
      if (typeof origTry === 'function') {
        (this.trig as any).tryTrigger = async (...args: any[]) => {
          const t0 = Date.now();
          try { return await origTry(...args); }
          finally { this.stats.lastRunMs = Date.now() - t0; }
        };
      }
    } catch {}
    try {
      const dc: any = (this.trig as any)?.driftClient;
      if (dc && typeof dc.sendTransaction === 'function') {
        const origSend = dc.sendTransaction.bind(dc);
        dc.sendTransaction = (...args: any[]) => {
          return origSend(...args)
            .then((res: any) => { try { this.stats.triggers = (this.stats.triggers || 0) + 1; } catch {} return res; })
            .catch((e: any) => { try { this.stats.errors = (this.stats.errors || 0) + 1; } catch {} throw e; });
        };
      }
    } catch {}
    await this.trig.startIntervalLoop(cfg?.intervalMs ?? 1000);
    logger.info('[trigger] started');
  }

  async stop() {
    try { await this.trig?.reset?.(); } catch {}
    this.trig = null;
    logger.info('[trigger] stopped');
  }

  status() {
    return { running: !!this.trig, ...this.stats };
  }
}


