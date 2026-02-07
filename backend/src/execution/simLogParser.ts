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

/** Actual hop execution data from VERBOSE logs */
export interface HopActualOutput {
  hop: number;
  amountIn: bigint;
  amountOut: bigint;
  dex: string;
}

export interface SimulationAnalysis {
  swapsExecuted: ParsedSwapLog[];
  profitCheckFailed: boolean;
  profitValue?: bigint;
  minProfitRequired?: bigint;
  errorCode?: number;
  errorMessage?: string;
  lastSuccessfulStep?: number;
  /** Actual hop outputs from VERBOSE logs (in/out amounts per hop) */
  hopActualOutputs?: HopActualOutput[];
  /** Initial token balance before route execution (from VERBOSE profit_check) */
  initialBalance?: bigint;
  /** Final token balance after route execution (from VERBOSE profit_check) */
  finalBalance?: bigint;
}

/** Raydium CLMM: first tick array does not contain current tick (tick drifted) */
export const RAYDIUM_ERROR_INVALID_FIRST_TICK_ARRAY = 6028;
/** Raydium CLMM: not enough tick array accounts passed (swap crosses more arrays) */
export const RAYDIUM_ERROR_NOT_ENOUGH_TICK_ARRAYS = 6027;

/**
 * Extract error code from simResult.err (handles InstructionError format)
 */
export function extractErrorCodeFromSimError(err: any): number | undefined {
  if (!err) return undefined;
  
  // Handle InstructionError format: { InstructionError: [index, { Custom: code }] }
  if (err.InstructionError && Array.isArray(err.InstructionError)) {
    const errDetail = err.InstructionError[1];
    if (typeof errDetail === 'object' && errDetail.Custom !== undefined) {
      return errDetail.Custom;
    }
  }
  
  // Handle string format: "Custom(6007)" or "InstructionError at 3: Custom(6007)"
  if (typeof err === 'string') {
    const match = err.match(/Custom\((\d+)\)/);
    if (match) return parseInt(match[1], 10);
  }
  
  return undefined;
}

/**
 * Parse simulation logs to extract swap execution details
 * @param logs - Simulation logs from simResult.logs
 * @param simErr - Optional error from simResult.err to extract error code from
 */
export function parseSimulationLogs(logs: string[] | undefined, simErr?: any): SimulationAnalysis {
  const result: SimulationAnalysis = {
    swapsExecuted: [],
    profitCheckFailed: false,
  };

  // Extract error code from simResult.err if provided
  const errCodeFromSimErr = extractErrorCodeFromSimError(simErr);
  if (errCodeFromSimErr !== undefined) {
    result.errorCode = errCodeFromSimErr;
  }

  if (!logs) {
    // Even with no logs, check if error code indicates profit check failure
    if (result.errorCode === 6007) {
      result.profitCheckFailed = true;
    }
    return result;
  }

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

  // Pattern for profit check (matches all variants: Route, Compact route, Compact V2 route)
  const profitPattern = /(?:Compact V2 route|Compact route|Route) executed successfully\.\s*Profit:\s*(-?\d+)/i;
  const noProfitPattern = /NoProfitFromRoute|Route execution failed - no profit/i;

  // VERBOSE log patterns (arb-router verbose mode)
  // Format: "VERBOSE hop[0]: in=1000000 out=3242186 dex=Orca"
  const verboseHopPattern = /VERBOSE hop\[(\d+)\]: in=(\d+) out=(\d+) dex=(\w+)/i;
  // Format: "VERBOSE profit_check: initial=1000000 final=999800 profit=-200 min_required=100"
  const verboseProfitCheckPattern = /VERBOSE profit_check: initial=(\d+) final=(\d+) profit=(-?\d+) min_required=(-?\d+)/i;

  let currentStep = -1;

  for (const log of logs) {
    // Check for step execution
    const stepMatch = log.match(stepPattern);
    if (stepMatch) {
      currentStep = parseInt(stepMatch[1], 10);
      continue;
    }

    // Check for VERBOSE hop output (actual in/out amounts per hop)
    const verboseHopMatch = log.match(verboseHopPattern);
    if (verboseHopMatch) {
      if (!result.hopActualOutputs) {
        result.hopActualOutputs = [];
      }
      result.hopActualOutputs.push({
        hop: parseInt(verboseHopMatch[1], 10),
        amountIn: BigInt(verboseHopMatch[2]),
        amountOut: BigInt(verboseHopMatch[3]),
        dex: verboseHopMatch[4],
      });
      continue;
    }

    // Check for VERBOSE profit_check (initial/final balance details)
    const verboseProfitMatch = log.match(verboseProfitCheckPattern);
    if (verboseProfitMatch) {
      result.initialBalance = BigInt(verboseProfitMatch[1]);
      result.finalBalance = BigInt(verboseProfitMatch[2]);
      result.profitValue = BigInt(verboseProfitMatch[3]);
      result.minProfitRequired = BigInt(verboseProfitMatch[4]);
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

    // Check for profit result (non-verbose format)
    const profitMatch = log.match(profitPattern);
    if (profitMatch) {
      // Only set if not already set by verbose log
      if (result.profitValue === undefined) {
        result.profitValue = BigInt(profitMatch[1]);
      }
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

  // Correlate error code 6007 (NoProfitFromRoute) with profitCheckFailed
  // This handles cases where the error comes from simResult.err rather than log text
  if (result.errorCode === 6007) {
    result.profitCheckFailed = true;
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
    inputDecimals?: number;
    outputDecimals?: number;
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
      minProfitRequired: simAnalysis.minProfitRequired?.toString(),
      initialBalance: simAnalysis.initialBalance?.toString(),
      finalBalance: simAnalysis.finalBalance?.toString(),
      errorCode: simAnalysis.errorCode,
      errorMessage: simAnalysis.errorMessage,
      swapDetails: simAnalysis.swapsExecuted.map(s => ({
        step: s.stepIndex,
        dex: s.dex,
        amountIn: s.amountIn.toString(),
        minOut: s.minAmountOut.toString(),
        aToB: s.aToB,
      })),
      // Actual hop outputs from VERBOSE logs (shows real in/out per hop)
      hopActualOutputs: simAnalysis.hopActualOutputs?.map(h => ({
        hop: h.hop,
        amountIn: h.amountIn.toString(),
        amountOut: h.amountOut.toString(),
        dex: h.dex,
      })),
    },
    
    // Delta analysis
    analysis: {
      // Did all hops execute?
      // Note: If profitCheckFailed is true, we KNOW all hops executed because
      // the profit check instruction runs AFTER all swap instructions
      allHopsExecuted: simAnalysis.profitCheckFailed || simAnalysis.swapsExecuted.length >= plan.hops.length,
      // Which hop failed (if any)?
      // IMPORTANT: Check profitCheckFailed FIRST - error 6007 means all swaps succeeded
      // but the final profit check failed. Don't rely on swapsExecuted count which
      // may be 0 if swap logs weren't captured.
      failedAtHop: simAnalysis.profitCheckFailed 
        ? 'profit_check'
        : (simAnalysis.swapsExecuted.length < plan.hops.length 
          ? simAnalysis.swapsExecuted.length 
          : null),
      // Profit delta (if we have both expected and actual)
      profitDelta: opp.profit_bps !== undefined && simAnalysis.profitValue !== undefined
        ? `expected ${opp.profit_bps} bps, got ${simAnalysis.profitValue.toString()} raw`
        : null,
    },
  };
  
  // Add per-hop RATE comparison if we have expected rates or actual data
  // Compare expected rates (from arb-rs hop_rates) with quoted rates (from resolver)
  if (opp.hop_rates || simAnalysis.swapsExecuted.length > 0) {
    report.hopComparison = plan.hops.map((hop, i) => {
      const expectedRate = opp.hop_rates?.[i];
      const actualSwap = simAnalysis.swapsExecuted.find(s => s.stepIndex === i);
      const expectedDex = opp.hop_dexes?.[i];
      
      // Calculate the quoted rate from amountInRaw and quotedOutputRaw
      // Rate = (quotedOutput / 10^outDecimals) / (amountIn / 10^inDecimals)
      //      = quotedOutput * 10^inDecimals / (amountIn * 10^outDecimals)
      let quotedRate: number | null = null;
      if (hop.amountInRaw && hop.quotedOutputRaw && hop.amountInRaw > 0n) {
        const inDec = hop.inputDecimals ?? 6;
        const outDec = hop.outputDecimals ?? 6;
        try {
          // Use floating point for rate calculation to match arb-rs behavior
          const amtIn = Number(hop.amountInRaw) / Math.pow(10, inDec);
          const amtOut = Number(hop.quotedOutputRaw) / Math.pow(10, outDec);
          if (amtIn > 0) {
            quotedRate = amtOut / amtIn;
          }
        } catch {
          quotedRate = null;
        }
      }
      
      // Calculate rate delta in bps: ((quoted - expected) / expected) * 10000
      // Note: arb-rs hop_rates might be for the opposite direction if the cycle was rotated
      // We check both the forward rate and inverse rate to find the best match
      let rateDeltaBps: number | null = null;
      let rateOk = false;
      let matchedDirection: 'forward' | 'inverse' | null = null;
      
      if (expectedRate !== undefined && expectedRate > 0 && quotedRate !== null && quotedRate > 0) {
        // Try forward comparison: quotedRate vs expectedRate
        const forwardDeltaBps = Math.round(((quotedRate - expectedRate) / expectedRate) * 10000);
        
        // Try inverse comparison: quotedRate vs (1/expectedRate)
        // This handles cases where arb-rs stored the rate in opposite direction
        const inverseExpectedRate = 1 / expectedRate;
        const inverseDeltaBps = Math.round(((quotedRate - inverseExpectedRate) / inverseExpectedRate) * 10000);
        
        // Use whichever comparison gives a smaller delta (more likely correct direction)
        if (Math.abs(forwardDeltaBps) <= Math.abs(inverseDeltaBps)) {
          rateDeltaBps = forwardDeltaBps;
          matchedDirection = 'forward';
        } else {
          rateDeltaBps = inverseDeltaBps;
          matchedDirection = 'inverse';
        }
        
        // Consider rates "ok" if within ±100 bps (1%) - accounts for price movement and slippage
        rateOk = Math.abs(rateDeltaBps) <= 100;
      }
      
      return {
        index: i,
        poolId: hop.poolId,  // Pool ID for calibration feedback
        dex: hop.dex,
        expectedDex,
        dexMatch: !expectedDex || hop.dex.toLowerCase().includes(expectedDex.toLowerCase()),
        // Rate comparison (the main useful info)
        expectedRate: expectedRate?.toFixed(8),
        quotedRate: quotedRate?.toFixed(8),
        rateDeltaBps,
        rateOk,
        matchedDirection, // 'forward' = rates match, 'inverse' = had to invert expected rate
        // Raw amounts for debugging
        amountInRaw: hop.amountInRaw?.toString(),
        quotedOutRaw: hop.quotedOutputRaw?.toString(),
        // Actual execution info
        actualInRaw: actualSwap?.amountIn.toString(),
        actualMinOut: actualSwap?.minAmountOut.toString(),
        executed: !!actualSwap,
      };
    });
  }
  
  return report;
}

/**
 * Format simulation report for logging (condensed version)
 */
export function formatSimReportForLog(report: Record<string, any>): Record<string, any> {
  // Calculate quoted rate product for comparison
  let quotedRateProduct: number | null = null;
  if (report.hopComparison?.length > 0) {
    quotedRateProduct = 1.0;
    for (const h of report.hopComparison) {
      const rate = parseFloat(h.quotedRate);
      if (!isNaN(rate) && rate > 0) {
        quotedRateProduct *= rate;
      } else {
        quotedRateProduct = null;
        break;
      }
    }
  }
  
  return {
    path: report.pathStr,
    hopCount: report.hopCount,
    isArbCycle: report.isArbCycle,
    comparison: {
      expectedProfitBps: report.expected?.profitBps,
      expectedNetBps: report.expected?.netBps,
      expectedRateProduct: report.expected?.rateProduct,
      quotedMinProfit: report.quoted?.calculatedMinProfit,
      isArbCycle: report.isArbCycle,
      initialInputRaw: report.quoted?.initialInputRaw,
    },
    simulation: {
      swapsExecuted: report.actual?.swapsExecuted,
      totalHops: report.hopCount,
      profitCheckFailed: report.actual?.profitCheckFailed,
      errorCode: report.actual?.errorCode,
      errorMessage: report.actual?.errorMessage,
      lastSuccessfulStep: report.actual?.lastSuccessfulStep,
    },
    // Per-hop rate comparison: expected (arb-rs) vs quoted (resolver)
    hopComparison: report.hopComparison?.map((h: any) => ({
      i: h.index,
      dex: h.dex,
      // Rate comparison - the key diagnostic info
      expRate: h.expectedRate,         // Expected rate from arb-rs prices
      quotedRate: h.quotedRate,        // Actual rate from DEX quote
      deltaBps: h.rateDeltaBps,        // Difference in bps (negative = quoted worse than expected)
      ok: h.rateOk,                    // true if rates within acceptable range (±100 bps)
      dir: h.matchedDirection,         // 'forward' = direct match, 'inverse' = expected rate was inverted
    })),
  };
}
