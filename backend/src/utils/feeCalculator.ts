import { Connection, PublicKey } from '@solana/web3.js';
import { CONFIG } from './config.js';
import { logger } from './logger.js';

export interface FeeConfig {
  baseFee: number;
  priorityFee: number;
  maxFee: number;
  dynamicFees: boolean;
  feeMultiplier: number;
}

export interface CalculatedFees {
  baseFee: number;
  priorityFee: number;
  totalFee: number;
  isDynamic: boolean;
}

export class FeeCalculator {
  private connection: Connection;
  private recentFees: number[] = [];
  private lastFeeUpdate = 0;
  private readonly FEE_UPDATE_INTERVAL = 30000; // 30 seconds

  constructor(connection: Connection) {
    this.connection = connection;
  }

  async calculateFees(
    config: FeeConfig = CONFIG.fees,
    forceUpdate: boolean = false
  ): Promise<CalculatedFees> {
    const now = Date.now();
    
    // Update recent fees if needed
    if (forceUpdate || now - this.lastFeeUpdate > this.FEE_UPDATE_INTERVAL) {
      await this.updateRecentFees();
      this.lastFeeUpdate = now;
    }

    let baseFee = config.baseFee;
    let priorityFee = config.priorityFee;

    if (config.dynamicFees && this.recentFees.length > 0) {
      // Calculate dynamic fees based on recent network activity
      const avgRecentFee = this.recentFees.reduce((a, b) => a + b, 0) / this.recentFees.length;
      const networkMultiplier = Math.min(avgRecentFee / 5000, 3.0); // Cap at 3x
      
      baseFee = Math.round(baseFee * networkMultiplier * config.feeMultiplier);
      priorityFee = Math.round(priorityFee * networkMultiplier * config.feeMultiplier);
      
      logger.info(`Dynamic fees calculated: base=${baseFee}, priority=${priorityFee}, multiplier=${networkMultiplier.toFixed(2)}`);
    }

    // Apply maximum fee limits
    const totalFee = baseFee + priorityFee;
    if (totalFee > config.maxFee) {
      const scaleFactor = config.maxFee / totalFee;
      baseFee = Math.round(baseFee * scaleFactor);
      priorityFee = Math.round(priorityFee * scaleFactor);
    }

    return {
      baseFee,
      priorityFee,
      totalFee: baseFee + priorityFee,
      isDynamic: config.dynamicFees
    };
  }

  private async updateRecentFees(): Promise<void> {
    try {
      // Get recent performance samples to estimate network congestion
      const { withRpcLimit } = await import('./rpcLimiter.js');
      const recentSamples = await withRpcLimit(
        () => this.connection.getRecentPerformanceSamples(10),
        1,
        { module: 'utils', method: 'getRecentPerformanceSamples' }
      ).catch(() => []);
      
      if (recentSamples.length === 0) return;

      // Calculate average transactions per slot as congestion metric
      const samples = recentSamples.slice(0, 5);
      let totalSlots = 0;
      let totalTransactions = 0;
      
      for (const sample of samples) {
        totalSlots += sample.numSlots;
        totalTransactions += sample.numTransactions;
      }
      
      if (totalSlots === 0) return;
      
      const txPerSlot = totalTransactions / totalSlots;
      
      // Calculate congestion factor based on tx/slot (typical is ~1500)
      const congestionFactor = Math.max(0.5, Math.min(2.0, txPerSlot / 1500));
      this.recentFees.push(congestionFactor * 5000); // Base fee estimate
      
      // Keep only last 10 measurements
      if (this.recentFees.length > 10) {
        this.recentFees = this.recentFees.slice(-10);
      }
    } catch (error) {
      // Silent fail - fee estimation is not critical
    }
  }

  // Get fee recommendations for different transaction types
  getFeeRecommendation(transactionType: 'swap' | 'send' | 'strategy'): Partial<FeeConfig> {
    switch (transactionType) {
      case 'swap':
        return {
          baseFee: CONFIG.fees.baseFee,
          priorityFee: CONFIG.fees.priorityFee * 1.5, // Higher priority for swaps
          feeMultiplier: CONFIG.fees.feeMultiplier
        };
      case 'send':
        return {
          baseFee: CONFIG.fees.baseFee * 0.5, // Lower fees for simple sends
          priorityFee: CONFIG.fees.priorityFee * 0.5,
          feeMultiplier: CONFIG.fees.feeMultiplier
        };
      case 'strategy':
        return {
          baseFee: CONFIG.fees.baseFee,
          priorityFee: CONFIG.fees.priorityFee,
          feeMultiplier: CONFIG.fees.feeMultiplier
        };
      default:
        return CONFIG.fees;
    }
  }
}

// Global instance
let feeCalculator: FeeCalculator | null = null;

export function getFeeCalculator(connection: Connection): FeeCalculator {
  if (!feeCalculator) {
    feeCalculator = new FeeCalculator(connection);
  }
  return feeCalculator;
}
