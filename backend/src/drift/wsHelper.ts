import { Connection } from '@solana/web3.js';
import { CONFIG } from '../utils/config.js';
import { logger } from '../utils/logger.js';

/**
 * Get the current WebSocket readyState
 * 0 = CONNECTING, 1 = OPEN, 2 = CLOSING, 3 = CLOSED
 */
export function getWebSocketReadyState(connection: Connection): number | undefined {
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
}

/**
 * Wait for the WebSocket connection to be ready before subscribing
 * to avoid "socket was not CONNECTING or OPEN" errors
 */
export async function waitUntilWsReady(connection: Connection, location = 'unknown'): Promise<void> {
  try {
    const deadline = Date.now() + Math.max(500, Number(((CONFIG.system as any)?.wsReadyWaitMs) || 5000));
    const started = Date.now();
    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
    
    for (;;) {
      const rs = getWebSocketReadyState(connection);
      // 0 CONNECTING, 1 OPEN, 2 CLOSING, 3 CLOSED
      if (rs === 0 || rs === 1) {
        const waited = Date.now() - started;
        if (waited > 200) {
          try { 
            logger.debug('ws.waitUntilReady.waited', { 
              ms: waited, 
              location,
              cat: 'ws' 
            }); 
          } catch {}
        }
        return;
      }
      if (Date.now() >= deadline) {
        try { 
          logger.debug('ws.waitUntilReady.timeout', { 
            ms: Date.now() - started, 
            readyState: rs,
            location,
            cat: 'ws' 
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

/**
 * Protect a Connection's RPC WebSocket from being called when socket is closed.
 * This prevents web3.js's internal _updateSubscriptions from attempting to
 * resubscribe on a CLOSED socket during automatic reconnection attempts.
 * 
 * This wrapper intercepts the RPC call method and checks readyState before
 * allowing the call to proceed. If the socket is CLOSING or CLOSED, it returns
 * a rejected promise instead of throwing, allowing the caller to handle it gracefully.
 */
export function protectRpcWebSocket(connection: Connection, location = 'unknown'): void {
  try {
    const rpcWs: any = (connection as any)?._rpcWebSocket;
    if (!rpcWs) {
      logger.debug('ws.protect.no_rpc_ws', { location, cat: 'ws' });
      return;
    }

    // Only wrap once
    if (rpcWs._lockstoneProtected) {
      logger.debug('ws.protect.already_protected', { location, cat: 'ws' });
      return;
    }
    rpcWs._lockstoneProtected = true;

    // Save original call method
    const originalCall = rpcWs.call.bind(rpcWs);

    // Wrap the call method to check readyState before proceeding
    rpcWs.call = function(...args: any[]) {
      try {
        // Get the underlying WebSocket
        const ws = this.underlyingSocket || this._ws || this.socket || this._socket;
        const rs = ws?.readyState;

        // Only allow calls when CONNECTING (0) or OPEN (1)
        if (rs !== undefined && rs !== 0 && rs !== 1) {
          const method = args[0];
          
          // Log blocked calls for subscription methods (reduce noise for other methods)
          if (method && (method.includes('Subscribe') || method.includes('subscribe'))) {
            try {
              logger.debug('ws.protect.blocked_call', {
                method,
                readyState: rs,
                location,
                cat: 'ws'
              });
            } catch {}
          }

          // Return rejected promise (allows web3.js _updateSubscriptions to handle gracefully)
          return Promise.reject(
            new Error(`WebSocket not ready (readyState: ${rs}, expected 0 or 1)`)
          );
        }

        // Socket is ready, proceed with original call
        return originalCall(...args);
      } catch (e) {
        // If any error in wrapper, reject rather than throw
        return Promise.reject(e);
      }
    };

    try {
      logger.debug('ws.protect.enabled', { location, cat: 'ws' });
    } catch {}
  } catch (err) {
    // Non-fatal: log but continue
    try {
      logger.warn('ws.protect.failed', {
        error: String(err),
        location,
        cat: 'ws'
      });
    } catch {}
  }
}

/**
 * Safely close a WebSocket connection and wait for it to fully close.
 * This prevents race conditions where new subscriptions start before the socket is closed.
 */
export async function safeCloseWebSocket(connection: Connection, location = 'unknown'): Promise<void> {
  try {
    const rpcWs: any = (connection as any)?._rpcWebSocket;
    if (!rpcWs) return;

    // Close the underlying WebSocket first
    try {
      const ws = rpcWs.underlyingSocket || rpcWs._ws || rpcWs.socket || rpcWs._socket;
      if (ws && typeof ws.close === 'function') {
        ws.close();
        // Brief wait for socket to transition to CLOSED state
        await new Promise(r => setTimeout(r, 50));
        try { 
          logger.debug('ws.safeClose.completed', { 
            location,
            readyState: ws.readyState,
            cat: 'ws' 
          }); 
        } catch {}
      }
    } catch (err) {
      try {
        logger.debug('ws.safeClose.error', {
          error: String(err),
          location,
          cat: 'ws'
        });
      } catch {}
    }

    // Clear internal subscription maps to prevent resubscription attempts
    try {
      if (rpcWs._subscriptionsByAccountChangeSubscriptionId) {
        rpcWs._subscriptionsByAccountChangeSubscriptionId.clear?.();
      }
      if (rpcWs._subscriptionsByProgramAccountChangeSubscriptionId) {
        rpcWs._subscriptionsByProgramAccountChangeSubscriptionId.clear?.();
      }
      if (rpcWs._subscriptionUpdateTimer) {
        clearTimeout(rpcWs._subscriptionUpdateTimer);
        rpcWs._subscriptionUpdateTimer = null;
      }
    } catch {}
  } catch (err) {
    try {
      logger.warn('ws.safeClose.failed', {
        error: String(err),
        location,
        cat: 'ws'
      });
    } catch {}
  }
}

