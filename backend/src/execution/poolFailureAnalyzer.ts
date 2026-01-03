/**
 * Pool Failure Analyzer
 * 
 * Maps failing transaction instructions back to the specific pool that caused the failure.
 * 
 * Transaction Structure:
 * - Compute budget instructions (0-2)
 * - Extra setup instructions (variable)
 * - Per-hop instructions: ATA creates, SOL wrap, DEX swap
 * - Unwrap SOL (if needed)
 * 
 * This module handles the complexity of instruction ordering to correctly identify
 * which pool caused a transaction failure.
 */

import { logger } from '../utils/logger.js';
import { parseSimLogs, SimDiagnostics } from './sim.js';
import { CONFIG } from '../utils/config.js';

// ============================================================================
// Known Program IDs
// ============================================================================

const KNOWN_PROGRAMS = {
  COMPUTE_BUDGET: 'ComputeBudget111111111111111111111111111111',
  SYSTEM_PROGRAM: '11111111111111111111111111111111',
  TOKEN_PROGRAM: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  TOKEN_2022: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  ATA_PROGRAM: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  MEMO_PROGRAM: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
};

// DEX program IDs (with config fallbacks)
function getDexPrograms(): Record<string, string[]> {
  return {
    raydium: [
      (CONFIG as any)?.raydium?.ammV4Program || '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
      (CONFIG as any)?.raydium?.ammV5Program || '',
      (CONFIG as any)?.raydium?.clmmProgram || 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
    ].filter(Boolean),
    orca: [
      (CONFIG as any)?.orca?.programId || 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
    ].filter(Boolean),
    meteora: [
      (CONFIG as any)?.meteora?.programId || 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',
    ].filter(Boolean),
    meteora_balanced: [
      (CONFIG as any)?.meteora?.amm?.v1ProgramId || '',
      (CONFIG as any)?.meteora?.amm?.v2ProgramId || '',
    ].filter(Boolean),
    pumpswap: [
      'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
    ],
  };
}

// ============================================================================
// Types
// ============================================================================

type InstructionType = 
  | 'compute_budget' 
  | 'ata_create' 
  | 'token_transfer'
  | 'system_transfer'
  | 'dex_swap' 
  | 'memo'
  | 'other';

interface InstructionInfo {
  index: number;
  programId: string;
  type: InstructionType;
  hopIndex?: number;
  poolId?: string;
  dex?: string;
}

interface TransactionLayout {
  instructions: InstructionInfo[];
  hopToInstructionMap: Map<number, number[]>;
  swapInstructionToHop: Map<number, { hopIndex: number; poolId: string; dex: string }>;
}

export interface FailingPoolResult {
  hopIndex: number;
  poolId: string;
  dex: string;
  instructionType: InstructionType;
  programId: string;
  isDirectSwapFailure: boolean;
  likelyError?: string;
}

export interface TransactionFailureAnalysis {
  failingPool: {
    hopIndex: number;
    poolId: string;
    dex: string;
  } | null;
  diagnostics: SimDiagnostics;
  instructionIndex?: number;
  errorType?: string;
  errorMessage?: string;
}

// ============================================================================
// Instruction Classification
// ============================================================================

/**
 * Classify a program ID into instruction type
 */
function classifyProgramId(programId: string): InstructionType {
  if (!programId) return 'other';
  
  if (programId === KNOWN_PROGRAMS.COMPUTE_BUDGET) return 'compute_budget';
  if (programId === KNOWN_PROGRAMS.ATA_PROGRAM) return 'ata_create';
  if (programId === KNOWN_PROGRAMS.TOKEN_PROGRAM) return 'token_transfer';
  if (programId === KNOWN_PROGRAMS.TOKEN_2022) return 'token_transfer';
  if (programId === KNOWN_PROGRAMS.SYSTEM_PROGRAM) return 'system_transfer';
  if (programId === KNOWN_PROGRAMS.MEMO_PROGRAM) return 'memo';

  // Check DEX programs
  const dexPrograms = getDexPrograms();
  for (const programs of Object.values(dexPrograms)) {
    if (programs.includes(programId)) return 'dex_swap';
  }

  return 'other';
}

/**
 * Detect which DEX a program ID belongs to
 */
function detectDex(programId: string): string | undefined {
  const dexPrograms = getDexPrograms();
  
  for (const [dex, programs] of Object.entries(dexPrograms)) {
    if (programs.includes(programId)) return dex;
  }
  
  return undefined;
}

// ============================================================================
// Transaction Layout Building
// ============================================================================

/**
 * Build a transaction layout from the instruction list and hop pool IDs.
 * This allows us to map any instruction index back to its hop/pool.
 */
export function buildTransactionLayout(
  programIds: string[],
  hopPoolIds: string[],
  hopDexes: string[]
): TransactionLayout {
  const instructions: InstructionInfo[] = [];
  const hopToInstructionMap = new Map<number, number[]>();
  const swapInstructionToHop = new Map<number, { hopIndex: number; poolId: string; dex: string }>();

  let currentHopIndex = 0;

  for (let i = 0; i < programIds.length; i++) {
    const programId = programIds[i];
    const baseType = classifyProgramId(programId);

    const info: InstructionInfo = {
      index: i,
      programId,
      type: baseType,
    };

    // If this is a DEX swap, map it to the corresponding hop
    if (baseType === 'dex_swap') {
      if (currentHopIndex < hopPoolIds.length) {
        info.hopIndex = currentHopIndex;
        info.poolId = hopPoolIds[currentHopIndex];
        info.dex = hopDexes[currentHopIndex] || detectDex(programId);

        // Add to mappings
        swapInstructionToHop.set(i, {
          hopIndex: currentHopIndex,
          poolId: hopPoolIds[currentHopIndex],
          dex: info.dex || 'unknown',
        });

        if (!hopToInstructionMap.has(currentHopIndex)) {
          hopToInstructionMap.set(currentHopIndex, []);
        }
        hopToInstructionMap.get(currentHopIndex)!.push(i);

        currentHopIndex++;
      }
    }

    instructions.push(info);
  }

  return { instructions, hopToInstructionMap, swapInstructionToHop };
}

// ============================================================================
// Failure Identification
// ============================================================================

/**
 * Given a failing instruction index, identify which pool caused the failure.
 * Returns null if the failure is not attributable to a specific pool.
 */
export function identifyFailingPool(
  failingIxIndex: number,
  programIds: string[],
  hopPoolIds: string[],
  hopDexes: string[],
  simLogs?: string[]
): FailingPoolResult | null {
  if (failingIxIndex < 0 || failingIxIndex >= programIds.length) {
    return null;
  }

  if (!hopPoolIds || hopPoolIds.length === 0) {
    return null;
  }

  const layout = buildTransactionLayout(programIds, hopPoolIds, hopDexes);
  const failingInstruction = layout.instructions[failingIxIndex];

  // Direct swap failure - the DEX swap instruction itself failed
  const directMapping = layout.swapInstructionToHop.get(failingIxIndex);
  if (directMapping) {
    // Extract error hint from logs if available
    let likelyError: string | undefined;
    if (simLogs && Array.isArray(simLogs)) {
      const errorLog = simLogs.find(l =>
        /error|failed|custom program error|slippage|insufficient|exceeded/i.test(l)
      );
      likelyError = errorLog?.slice(0, 200);
    }

    return {
      hopIndex: directMapping.hopIndex,
      poolId: directMapping.poolId,
      dex: directMapping.dex,
      instructionType: 'dex_swap',
      programId: failingInstruction.programId,
      isDirectSwapFailure: true,
      likelyError,
    };
  }

  // Not a direct swap failure - try to attribute to nearest hop
  // This handles cases like:
  // - ATA creation failure (pool requires account that doesn't exist)
  // - Token program failures (insufficient balance for swap)
  
  let attributedHopIndex = -1;

  // Find the last DEX swap before this instruction
  for (let i = failingIxIndex - 1; i >= 0; i--) {
    const mapping = layout.swapInstructionToHop.get(i);
    if (mapping) {
      // Failure is AFTER a swap - might be related to handling output
      attributedHopIndex = mapping.hopIndex;
      break;
    }
  }

  // If no preceding swap, check if there's a swap after and attribute to that hop
  if (attributedHopIndex < 0) {
    for (let i = failingIxIndex + 1; i < layout.instructions.length; i++) {
      const mapping = layout.swapInstructionToHop.get(i);
      if (mapping) {
        // Failure is before the first swap - likely setup for hop 0
        attributedHopIndex = mapping.hopIndex;
        break;
      }
    }
  }

  if (attributedHopIndex >= 0 && attributedHopIndex < hopPoolIds.length) {
    return {
      hopIndex: attributedHopIndex,
      poolId: hopPoolIds[attributedHopIndex],
      dex: hopDexes[attributedHopIndex] || 'unknown',
      instructionType: failingInstruction.type,
      programId: failingInstruction.programId,
      isDirectSwapFailure: false,
      likelyError: `Non-swap failure (${failingInstruction.type}) attributed to hop ${attributedHopIndex}`,
    };
  }

  return null;
}

// ============================================================================
// Main Analysis Entry Point
// ============================================================================

/**
 * Analyze a simulation/execution error and extract the failing pool.
 * This is the main entry point for failure analysis.
 */
export function analyzeTransactionFailure(
  simResult: any,
  programIds: string[],
  hopPoolIds: string[],
  hopDexes: string[]
): TransactionFailureAnalysis {
  // Parse simulation diagnostics
  const diagnostics = parseSimLogs(simResult);

  // Extract error details from InstructionError if present
  let instructionIndex: number | undefined;
  let errorType: string | undefined;
  let errorMessage: string | undefined;

  const err = simResult?.value?.err || simResult?.err;
  if (err?.InstructionError && Array.isArray(err.InstructionError)) {
    instructionIndex = Number(err.InstructionError[0]);
    const detail = err.InstructionError[1];

    if (typeof detail === 'object' && detail !== null) {
      errorType = Object.keys(detail)[0];
      if (detail.Custom !== undefined) {
        errorMessage = `Custom error ${detail.Custom}`;
      } else {
        try {
          errorMessage = JSON.stringify(detail);
        } catch {
          errorMessage = String(detail);
        }
      }
    } else {
      errorMessage = String(detail);
    }
  } else if (typeof diagnostics.failingIx === 'number') {
    instructionIndex = diagnostics.failingIx;
    errorMessage = diagnostics.err;
  }

  // If we have an instruction index, try to identify the failing pool
  let failingPool: { hopIndex: number; poolId: string; dex: string } | null = null;

  if (
    typeof instructionIndex === 'number' &&
    programIds &&
    programIds.length > 0 &&
    hopPoolIds &&
    hopPoolIds.length > 0
  ) {
    const result = identifyFailingPool(
      instructionIndex,
      programIds,
      hopPoolIds,
      hopDexes || [],
      diagnostics.logs
    );

    if (result) {
      failingPool = {
        hopIndex: result.hopIndex,
        poolId: result.poolId,
        dex: result.dex,
      };

      try {
        logger.info('tx.failure.pool_identified', {
          cat: 'execution',
          instructionIndex,
          hopIndex: result.hopIndex,
          poolId: result.poolId.slice(0, 16) + '...',
          dex: result.dex,
          instructionType: result.instructionType,
          isDirectSwapFailure: result.isDirectSwapFailure,
          errorType,
          errorMessage: errorMessage?.slice(0, 100),
        });
      } catch {}
    }
  }

  return {
    failingPool,
    diagnostics,
    instructionIndex,
    errorType,
    errorMessage,
  };
}

/**
 * Extract program IDs from built transaction instructions.
 * Utility to help with tracking programs array.
 */
export function extractProgramIds(instructions: any[]): string[] {
  const programIds: string[] = [];
  
  for (const ix of instructions) {
    if (!ix) continue;
    
    let pid = ix.programId;
    if (pid) {
      if (typeof pid.toBase58 === 'function') {
        pid = pid.toBase58();
      } else {
        pid = String(pid);
      }
      programIds.push(pid);
    }
  }
  
  return programIds;
}
