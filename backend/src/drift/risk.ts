import type { LeveragedGridConfig, SubaccountInfo } from './types.js';
import { CONFIG } from '../utils/config.js';

export function computeEffectiveLeverage(netNotional: number, totalCollateral: number): number {
  if (!totalCollateral || totalCollateral <= 0) return 0;
  return Math.abs(netNotional) / totalCollateral;
}

export function computeLiquidationBuffer(totalCollateral: number, maintenanceRequirement: number): number {
  if (maintenanceRequirement <= 0) return Infinity;
  return (totalCollateral - maintenanceRequirement) / maintenanceRequirement;
}

export function canPlaceOrders(cfg: LeveragedGridConfig, sub: SubaccountInfo, proposedNotional: number): { ok: boolean; reason?: string } {
  const effLev = computeEffectiveLeverage(proposedNotional, sub.totalCollateral);
  if (cfg.leverage > 0 && effLev > cfg.leverage) {
    return { ok: false, reason: `leverage cap exceeded: ${effLev.toFixed(2)} > ${cfg.leverage}` };
  }
  const liqBuf = computeLiquidationBuffer(sub.totalCollateral, sub.maintenanceRequirement);
  if (cfg.liquidationBufferPct > 0 && liqBuf < cfg.liquidationBufferPct) {
    return { ok: false, reason: `liq buffer breached: ${liqBuf.toFixed(2)} < ${cfg.liquidationBufferPct}` };
  }
  // Funding guard: compare configured max APY threshold
  if (cfg.fundingGuard) {
    const maxApy = Number((CONFIG as any)?.drift?.maxFundingApy || 0);
    if (maxApy > 0) {
      // Placeholder: runner should fetch funding rate and pass here; for now, allow
    }
  }
  return { ok: true };
}


