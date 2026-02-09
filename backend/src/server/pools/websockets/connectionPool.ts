/**
 * WebSocket connection pool for distributing subscriptions across multiple connections.
 *
 * Solana RPC nodes enforce a limit of 100 accountSubscribe calls per WebSocket
 * connection. This pool creates additional connections as needed, keeping each
 * under the configured maximum (default 90).
 */

import { CONFIG } from '../../../utils/config.js';
import { logger } from '../../../utils/logger.js';

interface PooledConnection {
  conn: any;
  subCount: number;
  subIds: Set<number>;
  pingTimer: NodeJS.Timeout | null;
  index: number;
}

export class WsConnectionPool {
  private connections: PooledConnection[] = [];
  private subIdToConnIndex = new Map<number, number>();
  private maxSubsPerConn: number;
  private rpcUrl: string;
  private commitment: string;
  private web3: any;

  constructor(opts: {
    rpcUrl: string;
    commitment: string;
    maxSubsPerConn?: number;
    web3: any;
  }) {
    this.rpcUrl = opts.rpcUrl;
    this.commitment = opts.commitment;
    this.maxSubsPerConn = opts.maxSubsPerConn
      ?? Number((CONFIG.system as any)?.wsMaxSubsPerConn || 90);
    this.web3 = opts.web3;
  }

  get totalSubs(): number {
    return this.connections.reduce((sum, pc) => sum + pc.subCount, 0);
  }

  get size(): number {
    return this.connections.length;
  }

  private async createConnection(): Promise<PooledConnection> {
    const conn = new this.web3.Connection(this.rpcUrl, this.commitment);
    const index = this.connections.length;

    // Apply WebSocket protection
    try {
      const { protectRpcWebSocket } = await import('../../../drift/wsHelper.js');
      protectRpcWebSocket(conn, `pools.pool[${index}]`);
    } catch (err) {
      logger.warn('ws.pool.protect.failed', { index, error: String(err), cat: 'pools' });
    }

    // Start keep-alive ping
    const pingIntervalMs = Math.max(10000,
      Number((CONFIG.system as any)?.wsPingIntervalMs || 30000));
    const pingTimer = setInterval(async () => {
      try {
        const rpcWs = (conn as any)?._rpcWebSocket;
        const ws = rpcWs?.underlyingSocket || rpcWs?._ws || rpcWs?.socket || rpcWs?._socket;
        if (ws?.readyState !== 1) return;
        await Promise.race([
          conn.getSlot(),
          new Promise((_: any, rej: any) => setTimeout(() => rej(new Error('ping timeout')), 5000))
        ]);
      } catch {}
    }, pingIntervalMs);

    const pc: PooledConnection = { conn, subCount: 0, subIds: new Set(), pingTimer, index };
    this.connections.push(pc);

    logger.info('ws.pool.connection.created', {
      index,
      totalConnections: this.connections.length,
      maxSubsPerConn: this.maxSubsPerConn,
      cat: 'pools'
    });

    return pc;
  }

  private async allocate(): Promise<PooledConnection> {
    for (const pc of this.connections) {
      if (pc.subCount < this.maxSubsPerConn) return pc;
    }
    return this.createConnection();
  }

  /** Subscribe to account changes. Returns raw subscription ID. */
  async onAccountChange(accountPk: any, handler: (info: any) => void): Promise<number> {
    const pc = await this.allocate();
    const subId: number = pc.conn.onAccountChange(accountPk, handler);
    pc.subCount++;
    pc.subIds.add(subId);
    this.subIdToConnIndex.set(subId, pc.index);
    return subId;
  }

  /** Subscribe to program account changes. Returns raw subscription ID. */
  async onProgramAccountChange(programPk: any, handler: (change: any) => void): Promise<number> {
    const pc = await this.allocate();
    const subId: number = pc.conn.onProgramAccountChange(programPk, handler);
    pc.subCount++;
    pc.subIds.add(subId);
    this.subIdToConnIndex.set(subId, pc.index);
    return subId;
  }

  /** Unsubscribe all and close all pooled connections. */
  async closeAll(): Promise<void> {
    let safeCloseWebSocket: any;
    try {
      const mod = await import('../../../drift/wsHelper.js');
      safeCloseWebSocket = mod.safeCloseWebSocket;
    } catch {}

    for (const pc of this.connections) {
      if (pc.pingTimer) { clearInterval(pc.pingTimer); pc.pingTimer = null; }

      const wsAny = (pc.conn as any)?._rpcWebSocket?._ws;
      const canRpc = Number(wsAny?.readyState) === 1;

      if (canRpc) {
        const removals: Promise<any>[] = [];
        for (const subId of pc.subIds) {
          removals.push(
            pc.conn.removeAccountChangeListener(subId).catch(() => {})
          );
        }
        try { await Promise.allSettled(removals); } catch {}
      }

      if (safeCloseWebSocket) {
        try { await safeCloseWebSocket(pc.conn, `pools.pool[${pc.index}]`); } catch {}
      }

      // Force-close underlying WS if still open
      try {
        const ws2 = (pc.conn as any)?._rpcWebSocket?._ws;
        if (ws2 && Number(ws2.readyState) < 2) {
          try { (pc.conn as any)?._rpcWebSocket?.close?.(); } catch {}
        }
      } catch {}
    }

    this.connections = [];
    this.subIdToConnIndex.clear();
    logger.info('ws.pool.closeAll.complete', { cat: 'pools' });
  }

  /** Return stats for logging/diagnostics. */
  getStats(): { total: number; connections: Array<{ index: number; subs: number; max: number }> } {
    return {
      total: this.totalSubs,
      connections: this.connections.map(pc => ({
        index: pc.index,
        subs: pc.subCount,
        max: this.maxSubsPerConn
      }))
    };
  }
}
