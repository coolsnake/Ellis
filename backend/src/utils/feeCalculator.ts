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
      // Get recent block fees to estimate network congestion
      const recentBlocks = await this.connection.getBlocks(0, 10); // Get last 10 blocks
      if (recentBlocks.length === 0) return;

      // Get block production time to estimate congestion
      const blockTimes = await Promise.all(
        recentBlocks.slice(0, 5).map(async (slot) => {
          try {
            const blockTime = await this.connection.getBlockTime(slot);
            return blockTime;
          } catch {
            return null;
          }
        })
      );

      const validTimes = blockTimes.filter((t): t is number => t !== null);
      if (validTimes.length > 0) {
        // Calculate average block time
        const avgBlockTime = validTimes.reduce((a, b) => a + b, 0) / validTimes.length;
        
        // Estimate congestion based on block time (faster = more congested)
        const congestionFactor = Math.max(0.5, Math.min(2.0, 600 / avgBlockTime)); // 600ms is target
        this.recentFees.push(congestionFactor * 5000); // Base fee estimate
        
        // Keep only last 10 measurements
        if (this.recentFees.length > 10) {
          this.recentFees = this.recentFees.slice(-10);
        }
      }
    } catch (error) {
      logger.warn('Failed to update recent fees', { error: String(error) });
      // Fallback to default fee
      this.recentFees.push(5000);
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
