import { Connection } from '@solana/web3.js';
import { CONFIG } from '../config.js';
import { logger } from '../utils/logger.js';

/**
 * Wait for the WebSocket connection to be ready before subscribing
 * to avoid "socket was not CONNECTING or OPEN" errors
 */
export async function waitUntilWsReady(connection: Connection, location = 'unknown'): Promise<void> {
  try {
    const deadline = Date.now() + Math.max(500, Number(((CONFIG.system as any)?.wsReadyWaitMs) || 5000));
    const started = Date.now();
    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
    
    const getRpcWebSocketReadyState = (): number | undefined => {
      try {
        const rpcWs: any = (connection as any)?._rpcWebSocket;
        if (!rpcWs) return undefined;
        const sockets = [
          (rpcWs as any)?.underlyingSocket,
          (rpcWs as any)?._ws,
          (rpcWs as any)?.socket,
          (rpcWs as any)?._socket,
        ];
        for (const sock of sockets) {
          const ready = Number((sock as any)?.readyState);
          if (Number.isFinite(ready) && ready >= 0) return ready;
        }
        if ((connection as any)?._rpcWebSocketConnected === true) return 1;
      } catch {}
      return undefined;
    };
    
    for (;;) {
      const rs = getRpcWebSocketReadyState();
      // 0 CONNECTING, 1 OPEN, 2 CLOSING, 3 CLOSED
      if (rs === 0 || rs === 1) {
        const waited = Date.now() - started;
        if (waited > 200) {
          try { 
            logger.debug('drift.ws waitUntilWsReady waited', { 
              ms: waited, 
              cat: 'drift', 
              location 
            }); 
          } catch {}
        }
        return;
      }
      if (Date.now() >= deadline) {
        try { 
          logger.debug('drift.ws waitUntilWsReady timeout', { 
            ms: Date.now() - started, 
            cat: 'drift', 
            location 
          }); 
        } catch {}
        return;
      }
      if (rs === undefined || rs === 3) {
        try { await (connection as any)?._rpcWebSocket?.connect?.(); } catch {}
      }
      await sleep(150);
    }
  } catch {}
}

