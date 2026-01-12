/**
 * Simulation Log Parser
 * 
 * Parses on-chain simulation logs to extract swap execution details
 * and compare expected vs actual values for debugging.
 */

export interface ParsedSwapLog {
  dex: string;
  amountIn: bigint;
  minAmountOut: bigint;
  aToB?: boolean;
  stepIndex?: number;
}

export interface SimulationAnalysis {
  swapsExecuted: ParsedSwapLog[];
  profitCheckFailed: boolean;
  profitValue?: bigint;
  minProfitRequired?: bigint;
  errorCode?: number;
  errorMessage?: string;
  lastSuccessfulStep?: number;
}

/**
 * Parse simulation logs to extract swap execution details
 */
export function parseSimulationLogs(logs: string[] | undefined): SimulationAnalysis {
  const result: SimulationAnalysis = {
    swapsExecuted: [],
    profitCheckFailed: false,
  };

  if (!logs) return result;

  // Patterns for different DEX swap logs
  const swapPatterns = [
    // Orca Whirlpool: "Orca Whirlpool swap_v2 executed: 1997163851 in, min 1 out, a_to_b: true"
    /Orca Whirlpool (?:swap|swap_v2) executed:\s*(\d+)\s*in,\s*min\s*(\d+)\s*out(?:,\s*a_to_b:\s*(true|false))?/i,
    // Raydium CLMM
    /Raydium (?:CLMM|swap) executed:\s*(\d+)\s*in,\s*min\s*(\d+)\s*out/i,
    // Raydium AMM
    /Raydium AMM swap executed:\s*(\d+)\s*in,\s*min\s*(\d+)\s*out/i,
    // Raydium CPMM
    /Raydium CPMM swap executed:\s*(\d+)\s*in,\s*min\s*(\d+)\s*out/i,
    // Meteora DLMM
    /Meteora (?:DLMM|swap) executed:\s*(\d+)\s*in,\s*min\s*(\d+)\s*out/i,
    // Meteora DAMM
    /Meteora DAMM (?:v1|v2)? ?swap executed:\s*(\d+)\s*in,\s*min\s*(\d+)\s*out/i,
    // PumpSwap
    /PumpSwap swap executed:\s*(\d+)\s*in,\s*min\s*(\d+)\s*out/i,
    // Generic router swap log
    /Swap completed:\s*(\d+)\s*in,\s*min\s*(\d+)\s*out/i,
  ];

  // Pattern for step execution
  const stepPattern = /Executing step (\d+) on DEX/i;

  // Pattern for profit check
  const profitPattern = /Route executed successfully\.\s*Profit:\s*(-?\d+)/i;
  const noProfitPattern = /NoProfitFromRoute|Route execution failed - no profit/i;

  let currentStep = -1;

  for (const log of logs) {
    // Check for step execution
    const stepMatch = log.match(stepPattern);
    if (stepMatch) {
      currentStep = parseInt(stepMatch[1], 10);
      continue;
    }

    // Check for swap execution
    for (const pattern of swapPatterns) {
      const swapMatch = log.match(pattern);
      if (swapMatch) {
        const dex = detectDexFromLog(log);
        result.swapsExecuted.push({
          dex,
          amountIn: BigInt(swapMatch[1]),
          minAmountOut: BigInt(swapMatch[2]),
          aToB: swapMatch[3] === 'true' ? true : swapMatch[3] === 'false' ? false : undefined,
          stepIndex: currentStep >= 0 ? currentStep : result.swapsExecuted.length,
        });
        result.lastSuccessfulStep = currentStep >= 0 ? currentStep : result.swapsExecuted.length - 1;
        break;
      }
    }

    // Check for profit result
    const profitMatch = log.match(profitPattern);
    if (profitMatch) {
      result.profitValue = BigInt(profitMatch[1]);
    }

    // Check for no profit error
    if (noProfitPattern.test(log)) {
      result.profitCheckFailed = true;
    }

    // Extract error code if present
    const errorCodeMatch = log.match(/Error Code:\s*(\w+)\.\s*Error Number:\s*(\d+)/);
    if (errorCodeMatch) {
      result.errorMessage = errorCodeMatch[1];
      result.errorCode = parseInt(errorCodeMatch[2], 10);
    }
  }

  return result;
}

/**
 * Detect DEX name from log string
 */
function detectDexFromLog(log: string): string {
  const logLower = log.toLowerCase();
  if (logLower.includes('orca')) return 'Orca';
  if (logLower.includes('raydium amm')) return 'RaydiumAmm';
  if (logLower.includes('raydium cpmm')) return 'RaydiumCpmm';
  if (logLower.includes('raydium')) return 'Raydium';
  if (logLower.includes('meteora damm')) return 'MeteoraDAMM';
  if (logLower.includes('meteora')) return 'Meteora';
  if (logLower.includes('pumpswap')) return 'PumpSwap';
  return 'Unknown';
}

/**
 * Opportunity data structure (subset of fields needed for comparison)
 */
export interface OpportunityForComparison {
  path?: string[];
  profit_bps: number;
  net_bps?: number;
  est_profit_usd?: number;
  rate_product?: number;
  hop_rates?: number[];
  hop_outs?: number[];
  hop_fee_bps?: number[];
  hop_count?: number;
  hop_dexes?: string[];
  hop_pool_ids?: string[];
}

/**
 * Plan data structure (subset of fields needed for comparison)
 */
export interface PlanForComparison {
  path?: string[];
  hops: Array<{
    dex: string;
    variant?: string;
    poolId?: string;
    amountInRaw?: bigint;
    minOutRaw?: bigint;
    quotedOutputRaw?: bigint;
  }>;
  isArbCycle?: boolean;
  initialInputRaw?: bigint;
  minProfitBps?: number;
}

/**
 * Build detailed simulation comparison report
 */
export function buildSimulationReport(
  opp: OpportunityForComparison,
  plan: PlanForComparison,
  simAnalysis: SimulationAnalysis,
): Record<string, any> {
  // Calculate min profit
  let calculatedMinProfit = '0';
  if (plan.isArbCycle && plan.initialInputRaw && plan.minProfitBps !== undefined) {
    try {
      calculatedMinProfit = ((BigInt(plan.initialInputRaw.toString()) * BigInt(plan.minProfitBps)) / 10000n).toString();
    } catch {
      calculatedMinProfit = 'calc_error';
    }
  }

  const report: Record<string, any> = {
    // Path info
    path: opp.path,
    pathStr: opp.path?.join(' -> '),
    hopCount: opp.hop_count ?? plan.hops.length,
    isArbCycle: plan.isArbCycle,
    
    // Expected values (from opportunity/arb-rs)
    expected: {
      profitBps: opp.profit_bps,
      netBps: opp.net_bps,
      estProfitUsd: opp.est_profit_usd,
      rateProduct: opp.rate_product,
      hopRates: opp.hop_rates,
      hopOuts: opp.hop_outs,
      hopFees: opp.hop_fee_bps,
      hopDexes: opp.hop_dexes,
    },
    
    // Quoted values (from plan/resolver)
    quoted: {
      initialInputRaw: plan.initialInputRaw?.toString(),
      minProfitBps: plan.minProfitBps,
      calculatedMinProfit,
      hops: plan.hops.map((h, i) => ({
        index: i,
        dex: h.dex,
        variant: h.variant,
        pool: h.poolId ? (h.poolId.slice(0, 12) + '...') : 'unknown',
        amountInRaw: h.amountInRaw?.toString(),
        quotedOutputRaw: h.quotedOutputRaw?.toString(),
        minOutRaw: h.minOutRaw?.toString(),
      })),
    },
    
    // Actual values (from simulation)
    actual: {
      swapsExecuted: simAnalysis.swapsExecuted.length,
      lastSuccessfulStep: simAnalysis.lastSuccessfulStep,
      profitCheckFailed: simAnalysis.profitCheckFailed,
      profitValue: simAnalysis.profitValue?.toString(),
      errorCode: simAnalysis.errorCode,
      errorMessage: simAnalysis.errorMessage,
      swapDetails: simAnalysis.swapsExecuted.map(s => ({
        step: s.stepIndex,
        dex: s.dex,
        amountIn: s.amountIn.toString(),
        minOut: s.minAmountOut.toString(),
        aToB: s.aToB,
      })),
    },
    
    // Delta analysis
    analysis: {
      // Did all hops execute?
      allHopsExecuted: simAnalysis.swapsExecuted.length >= plan.hops.length,
      // Which hop failed (if any)?
      failedAtHop: simAnalysis.swapsExecuted.length < plan.hops.length 
        ? simAnalysis.swapsExecuted.length 
        : (simAnalysis.profitCheckFailed ? 'profit_check' : null),
      // Profit delta (if we have both expected and actual)
      profitDelta: opp.profit_bps !== undefined && simAnalysis.profitValue !== undefined
        ? `expected ${opp.profit_bps} bps, got ${simAnalysis.profitValue.toString()} raw`
        : null,
    },
  };
  
  // Add per-hop comparison if we have both expected and actual data
  if (opp.hop_outs || simAnalysis.swapsExecuted.length > 0) {
    report.hopComparison = plan.hops.map((hop, i) => {
      const expectedOut = opp.hop_outs?.[i];
      const quotedOut = hop.quotedOutputRaw;
      const actualSwap = simAnalysis.swapsExecuted.find(s => s.stepIndex === i);
      const expectedDex = opp.hop_dexes?.[i];
      
      // Calculate delta between quoted and expected
      let quotedVsExpectedDelta: string | null = null;
      if (expectedOut && quotedOut && expectedOut > 0) {
        try {
          const expectedBigInt = BigInt(Math.floor(expectedOut));
          const quotedBigInt = BigInt(quotedOut.toString());
          const deltaBps = ((quotedBigInt - expectedBigInt) * 10000n) / expectedBigInt;
          quotedVsExpectedDelta = `${deltaBps.toString()} bps`;
        } catch {
          quotedVsExpectedDelta = 'calc_error';
        }
      }
      
      return {
        index: i,
        dex: hop.dex,
        expectedDex,
        dexMatch: !expectedDex || hop.dex.toLowerCase().includes(expectedDex.toLowerCase()),
        expectedOutRaw: expectedOut?.toString(),
        quotedOutRaw: quotedOut?.toString(),
        actualInRaw: actualSwap?.amountIn.toString(),
        actualMinOut: actualSwap?.minAmountOut.toString(),
        executed: !!actualSwap,
        quotedVsExpectedDelta,
      };
    });
  }
  
  return report;
}

/**
 * Format simulation report for logging (condensed version)
 */
export function formatSimReportForLog(report: Record<string, any>): Record<string, any> {
  return {
    path: report.pathStr,
    hopCount: report.hopCount,
    isArbCycle: report.isArbCycle,
    expected: {
      profitBps: report.expected?.profitBps,
      rateProduct: report.expected?.rateProduct,
    },
    quoted: {
      initialInput: report.quoted?.initialInputRaw,
      minProfit: report.quoted?.calculatedMinProfit,
    },
    actual: {
      swapsExecuted: report.actual?.swapsExecuted,
      profitCheckFailed: report.actual?.profitCheckFailed,
      profitValue: report.actual?.profitValue,
      errorCode: report.actual?.errorCode,
      errorMessage: report.actual?.errorMessage,
    },
    failedAt: report.analysis?.failedAtHop,
    hopComparison: report.hopComparison?.map((h: any) => ({
      i: h.index,
      dex: h.dex,
      exp: h.expectedOutRaw,
      quoted: h.quotedOutRaw,
      delta: h.quotedVsExpectedDelta,
      ok: h.executed,
    })),
  };
}
