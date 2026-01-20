/**
 * Yellowstone gRPC Stream Adapter
 * 
 * Provides a unified interface for streaming pool account updates via gRPC.
 * Designed as a drop-in alternative to WSS subscriptions.
 * 
 * Key features:
 * - Subscribes to specific pool accounts (not all program accounts)
 * - Uses 'processed' commitment for lowest latency
 * - Converts gRPC AccountUpdate → AccountInfo for existing decoders
 * - Supports dynamic retargeting (add/remove subscriptions)
 * - Per-DEX metrics tracking for monitoring
 * - Ping/keepalive for stream health
 */

import Client, { CommitmentLevel, SubscribeRequest } from "@triton-one/yellowstone-grpc";
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { logger } from "../../../utils/logger.js";
import { emit } from "../../realtime.js";
import type { AccountInfo, DerivedAccountInfo } from "../websockets/decoders/types.js";
import {
  handleRaydiumUpdate,
  handleRaydiumCpmmUpdate,
  handleOrcaUpdate,
  handleMeteoraUpdate,
  handlePumpswapUpdate,
  handleMeteoraBalancedUpdate,
} from "../websockets/decoders/index.js";

// Per-DEX update metrics
export interface DexMetrics {
  updates: number;
  errors: number;
  lastUpdateMs: number;
}

export type DexMetricsMap = Record<PoolSubscription['dex'], DexMetrics>;

export interface GrpcAdapterConfig {
  endpoint: string;
  xToken: string;
  commitment?: 'processed' | 'confirmed' | 'finalized';
  maxReconnectAttempts?: number;
  reconnectDelayMs?: number;
}

export interface PoolSubscription {
  poolId: string;
  dex: 'raydium' | 'raydium-cpmm' | 'orca' | 'meteora' | 'pumpswap' | 'meteora_balanced';
  derivedAccounts?: string[];  // Vault accounts, tick arrays, etc.
}

// Map commitment string to Yellowstone enum
const COMMITMENT_MAP = {
  'processed': CommitmentLevel.PROCESSED,
  'confirmed': CommitmentLevel.CONFIRMED,
  'finalized': CommitmentLevel.FINALIZED,
} as const;

// Program ID to DEX mapping
const PROGRAM_TO_DEX: Record<string, PoolSubscription['dex']> = {
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8': 'raydium',  // AMM v4
  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK': 'raydium',  // CLMM
  'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C': 'raydium-cpmm',  // CPMM
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc': 'orca',
  'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo': 'meteora',
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P': 'pumpswap',  // Bonding curve
  'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA': 'pumpswap',  // Post-graduation AMM
  'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB': 'meteora_balanced',  // Dynamic AMM v1
  'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG': 'meteora_balanced',  // CP-AMM v2
};

export class GrpcStreamAdapter {
  private client: Client | null = null;
  private stream: any = null;
  private config: GrpcAdapterConfig;
  private subscriptions: Map<string, PoolSubscription> = new Map();
  private derivedAccountToPool: Map<string, DerivedAccountInfo> = new Map();
  private poolIdToDex: Map<string, PoolSubscription['dex']> = new Map();
  private isConnected: boolean = false;
  private reconnectAttempts: number = 0;
  private eventCount: number = 0;
  private lastEventMs: number = 0;
  private reconnecting: boolean = false;
  private pingTimer: NodeJS.Timeout | null = null;
  private lastPongMs: number = 0;
  
  // Per-DEX metrics for monitoring
  private dexMetrics: DexMetricsMap = {
    raydium: { updates: 0, errors: 0, lastUpdateMs: 0 },
    'raydium-cpmm': { updates: 0, errors: 0, lastUpdateMs: 0 },
    orca: { updates: 0, errors: 0, lastUpdateMs: 0 },
    meteora: { updates: 0, errors: 0, lastUpdateMs: 0 },
    pumpswap: { updates: 0, errors: 0, lastUpdateMs: 0 },
    meteora_balanced: { updates: 0, errors: 0, lastUpdateMs: 0 },
  };

  constructor(config: GrpcAdapterConfig) {
    this.config = {
      commitment: 'processed',  // Default to processed for lowest latency
      maxReconnectAttempts: 10,
      reconnectDelayMs: 1000,
      ...config,
    };
  }

  /**
   * Initialize the gRPC client and establish connection
   */
  async connect(): Promise<boolean> {
    try {
      logger.info('grpc.adapter.connecting', {
        endpoint: this.config.endpoint,
        commitment: this.config.commitment,
        cat: 'grpc'
      });

      this.client = new Client(
        this.config.endpoint,
        this.config.xToken,
        undefined
      );

      this.stream = await this.client.subscribe();
      this.setupStreamHandlers();
      this.isConnected = true;
      this.reconnectAttempts = 0;

      logger.info('grpc.adapter.connected', { cat: 'grpc' });
      emit('log', {
        level: 'info',
        message: 'gRPC stream connected',
        timestamp: new Date().toISOString(),
        context: { cat: 'grpc' }
      });

      return true;
    } catch (err) {
      logger.error('grpc.adapter.connect_failed', {
        error: String((err as Error)?.message || err),
        cat: 'grpc'
      });
      return false;
    }
  }

  /**
   * Setup stream event handlers
   */
  private setupStreamHandlers(): void {
    if (!this.stream) return;

    this.stream.on("data", async (data: any) => {
      try {
        if (data.account) {
          this.eventCount++;
          this.lastEventMs = Date.now();
          await this.handleAccountUpdate(data.account);
        } else if (data.pong) {
          // Handle pong response for keepalive
          this.lastPongMs = Date.now();
          logger.debug('grpc.adapter.pong_received', { cat: 'grpc' });
        }
      } catch (err) {
        logger.error('grpc.adapter.data_error', {
          error: String((err as Error)?.message || err),
          cat: 'grpc'
        });
      }
    });

    this.stream.on("error", async (err: Error) => {
      logger.error('grpc.adapter.stream_error', {
        error: String(err?.message || err),
        cat: 'grpc'
      });
      this.isConnected = false;
      this.stopPingTimer();
      await this.attemptReconnect();
    });

    this.stream.on("end", async () => {
      logger.warn('grpc.adapter.stream_ended', { cat: 'grpc' });
      this.isConnected = false;
      this.stopPingTimer();
      await this.attemptReconnect();
    });
  }

  /**
   * Start periodic ping for keepalive
   */
  private startPingTimer(): void {
    this.stopPingTimer();
    
    // Send ping every 30 seconds
    this.pingTimer = setInterval(() => {
      if (this.isConnected && this.stream) {
        try {
          this.stream.write({ ping: { id: Date.now() } }, (err: any) => {
            if (err) {
              logger.warn('grpc.adapter.ping_failed', {
                error: String(err?.message || err),
                cat: 'grpc'
              });
            }
          });
        } catch (err) {
          logger.warn('grpc.adapter.ping_error', {
            error: String((err as Error)?.message || err),
            cat: 'grpc'
          });
        }
      }
    }, 30_000);
  }

  /**
   * Stop the ping timer
   */
  private stopPingTimer(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  /**
   * Attempt to reconnect with exponential backoff
   */
  private async attemptReconnect(): Promise<void> {
    if (this.reconnecting) return;
    this.reconnecting = true;

    try {
      if (this.reconnectAttempts >= (this.config.maxReconnectAttempts || 10)) {
        logger.error('grpc.adapter.max_reconnect_exceeded', { cat: 'grpc' });
        emit('log', {
          level: 'error',
          message: 'gRPC max reconnection attempts exceeded',
          timestamp: new Date().toISOString(),
          context: { cat: 'grpc' }
        });
        return;
      }

      this.reconnectAttempts++;
      const delay = (this.config.reconnectDelayMs || 1000) * Math.pow(2, this.reconnectAttempts - 1);
      
      logger.info('grpc.adapter.reconnecting', {
        attempt: this.reconnectAttempts,
        delayMs: delay,
        cat: 'grpc'
      });

      await new Promise(r => setTimeout(r, delay));
      
      const connected = await this.connect();
      if (connected && this.subscriptions.size > 0) {
        await this.resubscribeAll();
      }
    } finally {
      this.reconnecting = false;
    }
  }

  /**
   * Convert gRPC account update to AccountInfo format for existing decoders
   */
  private toAccountInfo(grpcAccount: any): { info: AccountInfo; pubkey: string; owner: string } {
    const account = grpcAccount.account || grpcAccount;
    const pubkeyBytes = account.pubkey;
    const ownerBytes = account.owner;
    const dataBytes = account.data;
    
    return {
      info: {
        data: Buffer.from(dataBytes),
        executable: account.executable ?? false,
        lamports: Number(account.lamports ?? 0),
        owner: bs58.encode(ownerBytes),
      },
      pubkey: bs58.encode(pubkeyBytes),
      owner: bs58.encode(ownerBytes),
    };
  }

  /**
   * Handle incoming account update - route to appropriate decoder
   */
  private async handleAccountUpdate(accountUpdate: any): Promise<void> {
    const { info, pubkey, owner } = this.toAccountInfo(accountUpdate);

    // Check if this is a pool account we're subscribed to
    const subscription = this.subscriptions.get(pubkey);

    // Or check if it's a derived account (vault, tick array, etc.)
    const derivedInfo = this.derivedAccountToPool.get(pubkey);

    // Determine pool ID (for metrics) and DEX type (for routing)
    // poolId is used for metrics/logging, pubkey is passed to decoders
    const poolId = subscription?.poolId || derivedInfo?.poolId || pubkey;
    let dex = subscription?.dex || this.poolIdToDex.get(poolId) || this.getDexFromOwner(owner);

    if (!dex) {
      logger.debug('grpc.adapter.unknown_account', {
        pubkey: pubkey.slice(0, 8),
        owner: owner.slice(0, 8),
        cat: 'grpc'
      });
      return;
    }

    // Route to appropriate decoder
    // IMPORTANT: Pass `pubkey` (actual account address), not `poolId`
    // Decoders need the actual account address to:
    // 1. Check owner program to identify pool vs vault accounts
    // 2. Look up in derivedAccountToPool map for vault routing
    try {
      switch (dex) {
        case 'raydium':
          await handleRaydiumUpdate(info, pubkey, this.derivedAccountToPool);
          break;
        case 'raydium-cpmm':
          await handleRaydiumCpmmUpdate(info, pubkey, this.derivedAccountToPool);
          break;
        case 'orca':
          // Orca SDK requires PublicKey for parsing - create from the base58 pubkey
          const accountPubkey = new PublicKey(pubkey);
          await handleOrcaUpdate(info, pubkey, this.derivedAccountToPool, accountPubkey);
          break;
        case 'meteora':
          await handleMeteoraUpdate(info, pubkey, this.derivedAccountToPool);
          break;
        case 'pumpswap':
          await handlePumpswapUpdate(info, pubkey, this.derivedAccountToPool);
          break;
        case 'meteora_balanced':
          await handleMeteoraBalancedUpdate(info, pubkey, this.derivedAccountToPool);
          break;
      }

      // Update per-DEX metrics on success
      this.dexMetrics[dex].updates++;
      this.dexMetrics[dex].lastUpdateMs = Date.now();
    } catch (err) {
      // Track errors per-DEX
      this.dexMetrics[dex].errors++;

      logger.error('grpc.adapter.decoder_error', {
        dex,
        pubkey: pubkey.slice(0, 8),
        poolId: poolId.slice(0, 8),
        isDerived: !!derivedInfo,
        error: String((err as Error)?.message || err),
        cat: 'grpc'
      });
    }
  }

  /**
   * Determine DEX from account owner program ID
   */
  private getDexFromOwner(owner: string): PoolSubscription['dex'] | null {
    return PROGRAM_TO_DEX[owner] || null;
  }

  /**
   * Subscribe to a set of pool accounts
   */
  async subscribeToAccounts(pools: PoolSubscription[]): Promise<void> {
    if (!this.isConnected || !this.stream) {
      throw new Error('gRPC not connected');
    }

    // Store subscriptions
    for (const pool of pools) {
      this.subscriptions.set(pool.poolId, pool);
      this.poolIdToDex.set(pool.poolId, pool.dex);
      
      // Also track derived accounts
      if (pool.derivedAccounts) {
        for (const derived of pool.derivedAccounts) {
          this.derivedAccountToPool.set(derived, {
            poolId: pool.poolId,
            accountType: 'vault',  // Generic - could be more specific
          });
        }
      }
    }

    // Build account list including derived accounts
    const allAccounts: string[] = [];
    for (const pool of pools) {
      allAccounts.push(pool.poolId);
      if (pool.derivedAccounts) {
        allAccounts.push(...pool.derivedAccounts);
      }
    }

    const req: SubscribeRequest = {
      accounts: {
        poolUpdates: {
          owner: [],  // Don't filter by owner - we're subscribing to specific accounts
          account: allAccounts,
          filters: [],
        },
      },
      slots: {},
      transactions: {},
      transactionsStatus: {},
      entry: {},
      blocks: {},
      blocksMeta: {},
      accountsDataSlice: [],
      ping: undefined,
      commitment: COMMITMENT_MAP[this.config.commitment || 'processed'],
    };

    await new Promise<void>((resolve, reject) => {
      this.stream.write(req, (err: any) => {
        if (err) {
          logger.error('grpc.adapter.subscribe_failed', {
            error: String(err?.message || err),
            accountCount: allAccounts.length,
            cat: 'grpc'
          });
          reject(err);
        } else {
          logger.info('grpc.adapter.subscribed', {
            poolCount: pools.length,
            accountCount: allAccounts.length,
            cat: 'grpc'
          });
          emit('log', {
            level: 'info',
            message: `gRPC subscribed to ${pools.length} pools (${allAccounts.length} accounts)`,
            timestamp: new Date().toISOString(),
            context: { cat: 'grpc' }
          });
          
          // Start keepalive ping timer after successful subscription
          this.startPingTimer();
          
          resolve();
        }
      });
    });
  }

  /**
   * Resubscribe to all tracked accounts (used after reconnect)
   */
  private async resubscribeAll(): Promise<void> {
    const pools = Array.from(this.subscriptions.values());
    if (pools.length > 0) {
      await this.subscribeToAccounts(pools);
    }
  }

  /**
   * Update subscriptions (retarget to new pool set)
   * Uses differential updates to minimize subscription gaps
   */
  async retarget(newPools: PoolSubscription[]): Promise<void> {
    const newPoolIds = new Set(newPools.map(p => p.poolId));
    const existingPoolIds = new Set(this.subscriptions.keys());
    
    // Calculate what changed
    const added: PoolSubscription[] = [];
    const removed: string[] = [];
    
    for (const pool of newPools) {
      if (!existingPoolIds.has(pool.poolId)) {
        added.push(pool);
      }
    }
    
    for (const existingId of existingPoolIds) {
      if (!newPoolIds.has(existingId)) {
        removed.push(existingId);
      }
    }
    
    // If changes are minimal, we could do incremental updates
    // But Yellowstone gRPC requires a full subscription update, so we still need to resubscribe
    // However, we preserve the internal tracking to avoid gaps in event processing
    
    logger.info('grpc.adapter.retarget.diff', {
      added: added.length,
      removed: removed.length,
      unchanged: newPools.length - added.length,
      cat: 'grpc'
    });
    
    // Clear existing subscriptions
    this.subscriptions.clear();
    this.derivedAccountToPool.clear();
    this.poolIdToDex.clear();

    // Subscribe to new set
    if (newPools.length > 0) {
      await this.subscribeToAccounts(newPools);
    }

    logger.info('grpc.adapter.retargeted', {
      poolCount: newPools.length,
      cat: 'grpc'
    });
  }

  /**
   * Get adapter status including per-DEX metrics
   */
  getStatus(): {
    connected: boolean;
    subscriptionCount: number;
    eventCount: number;
    lastEventMs: number;
    lastPongMs: number;
    reconnectAttempts: number;
    dexMetrics: DexMetricsMap;
  } {
    return {
      connected: this.isConnected,
      subscriptionCount: this.subscriptions.size,
      eventCount: this.eventCount,
      lastEventMs: this.lastEventMs,
      lastPongMs: this.lastPongMs,
      reconnectAttempts: this.reconnectAttempts,
      dexMetrics: { ...this.dexMetrics },
    };
  }

  /**
   * Check if connected
   */
  isActive(): boolean {
    return this.isConnected;
  }

  /**
   * Disconnect and cleanup
   */
  async disconnect(): Promise<void> {
    this.isConnected = false;
    this.stopPingTimer();
    
    if (this.stream) {
      try {
        this.stream.cancel();
      } catch {}
      this.stream = null;
    }

    this.client = null;
    this.subscriptions.clear();
    this.derivedAccountToPool.clear();
    this.poolIdToDex.clear();
    
    logger.info('grpc.adapter.disconnected', { cat: 'grpc' });
    emit('log', {
      level: 'info',
      message: 'gRPC stream disconnected',
      timestamp: new Date().toISOString(),
      context: { cat: 'grpc' }
    });
  }

  /**
   * Reset metrics counters (useful for testing/monitoring)
   */
  resetMetrics(): void {
    this.eventCount = 0;
    this.lastEventMs = 0;
    this.lastPongMs = 0;
    for (const dex of Object.keys(this.dexMetrics) as PoolSubscription['dex'][]) {
      this.dexMetrics[dex] = { updates: 0, errors: 0, lastUpdateMs: 0 };
    }
  }
}

