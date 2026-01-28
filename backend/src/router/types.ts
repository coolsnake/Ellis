/**
 * Type definitions for the arb-router on-chain program
 */

import { PublicKey } from '@solana/web3.js';

// ============================================================================
// Program Constants
// ============================================================================

export const ARB_ROUTER_PROGRAM_ID = new PublicKey('2Jgxnj7GGgR1EpwsfNKQhcFhmxAAhDoHmaiaDt2z9Fnw');

// PDA Seeds
export const VAULT_SEED = Buffer.from('vault');
export const CONFIG_SEED = Buffer.from('config');

// DEX Program IDs
export const DEX_PROGRAMS = {
  RAYDIUM_CLMM: new PublicKey('CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK'),
  METEORA_DLMM: new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo'),
  ORCA_WHIRLPOOL: new PublicKey('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc'),
  PUMPSWAP: new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA'), // Post-graduation AMM
} as const;

// Token Programs
export const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');

// Flash loan fee (9 basis points = 0.09%)
export const FLASH_LOAN_FEE_BPS = 9n;
export const BPS_DENOMINATOR = 10000n;

// Maximum route steps
export const MAX_ROUTE_STEPS = 8;

// ============================================================================
// Enums
// ============================================================================

export enum DexType {
  Raydium = 0,        // Raydium CLMM
  Meteora = 1,        // Meteora DLMM
  Orca = 2,           // Orca Whirlpool
  PumpSwap = 3,       // PumpSwap AMM
  RaydiumAmm = 4,     // Raydium AMM v4 (Serum/OpenBook)
  MeteoraDAMM = 5,    // Meteora Dynamic AMM (v1 and v2)
  RaydiumCpmm = 6,    // Raydium Constant Product AMM (CP-Swap)
}

export enum ExecutionMode {
  /** Direct execution - user's own tokens, no flash loan */
  Direct = 'direct',
  /** Flash loan mode - borrow from vault, execute arb, repay with profit */
  FlashLoan = 'flash_loan',
  /** Auto - use flash loan if vault has funds, otherwise direct */
  Auto = 'auto',
  /** SDK Quote mode - use DEX SDK quote methods to get accurate tick/bin arrays */
  SdkQuote = 'sdk_quote',
}

// ============================================================================
// Account Structures
// ============================================================================

/**
 * Vault account structure (matches on-chain Vault)
 * Size: 8 (discriminator) + 32 + 32 + 32 + 32 + 8 + 8 + 1 + 1 + 6 = 160 bytes
 */
export interface VaultAccount {
  /** Owner of this vault */
  owner: PublicKey;
  /** Mint of the token stored in this vault */
  mint: PublicKey;
  /** Token account that holds the vault's funds */
  tokenAccount: PublicKey;
  /** Token program ID (SPL Token or Token-2022) */
  tokenProgram: PublicKey;
  /** Current balance (cached) */
  balance: bigint;
  /** Amount currently borrowed via flash loan */
  borrowedAmount: bigint;
  /** Whether a flash loan is currently active */
  flashLoanActive: boolean;
  /** PDA bump seed */
  bump: number;
}

/**
 * Global config account structure
 */
export interface ConfigAccount {
  /** Authority that can update config */
  authority: PublicKey;
  /** Flash loan fee in basis points */
  flashLoanFeeBps: number;
  /** Whether flash loans are enabled */
  flashLoansEnabled: boolean;
  /** PDA bump */
  bump: number;
}

// ============================================================================
// Instruction Parameters
// ============================================================================

/**
 * Parameters for a route step
 */
export interface RouteStep {
  /** DEX to use */
  dexType: DexType;
  /** Amount to swap (0 = use all from previous step) */
  amountIn: bigint;
  /** Minimum output amount */
  minAmountOut: bigint;
  /** Swap direction: true = A to B, false = B to A */
  aToB: boolean;
}

/**
 * Parameters for execute instruction
 */
export interface ExecuteParams {
  /** Route steps to execute */
  steps: RouteStep[];
  /** 
   * Number of accounts for each step (enables variable bin arrays per hop).
   * If empty/undefined, falls back to fixed account counts per DEX type.
   * This allows Meteora hops to use more bin arrays when needed for low-TVL pools.
   */
  accountsPerStep?: number[];
  /** Minimum profit required */
  minProfit: bigint;
  /**
   * Pre-existing wallet balances for intermediate token accounts.
   * Used to exclude at-rest balances from dynamic amount propagation.
   * When amount_in == 0 for a step, the on-chain program reads the token account balance
   * and subtracts the corresponding initial_balance to get only the swap output.
   * If empty or shorter than steps, missing entries default to 0.
   */
  initialBalances?: bigint[];
  /**
   * Enable verbose logging on-chain (for simulation/debugging only).
   * When true, logs detailed input/output amounts for each hop.
   * Set to false for production to avoid revealing trade details in public logs.
   */
  verbose?: boolean;
}

/**
 * Parameters for route_swap instruction
 */
export interface SwapParams {
  /** DEX to use */
  dexType: DexType;
  /** Amount to swap */
  amountIn: bigint;
  /** Minimum output */
  minAmountOut: bigint;
  /** Swap direction: true = A to B, false = B to A */
  aToB: boolean;
}

/**
 * Parameters for flash_borrow instruction
 */
export interface FlashBorrowParams {
  /** Amount to borrow */
  amount: bigint;
}

/**
 * Parameters for flash_repay instruction
 */
export interface FlashRepayParams {
  /** Amount to repay (borrowed + fee) */
  amount: bigint;
}

// ============================================================================
// Compact Instruction Types (for reduced transaction size)
// ============================================================================

/**
 * Compact route step - no per-hop slippage (9 bytes vs 18 bytes)
 * 
 * Uses packed encoding: dexAndFlags contains both DEX type (bits 0-3) and
 * swap direction (bit 4). Removes min_amount_out entirely - relies on
 * final min_profit check for slippage protection.
 */
export interface RouteStepCompact {
  /** Packed: bits 0-3 = dex_type (0-15), bit 4 = a_to_b, bits 5-7 = reserved */
  dexAndFlags: number;
  /** Amount to swap (0 = use all from previous step) */
  amountIn: bigint;
}

/**
 * Parameters for execute_compact instruction
 * 
 * Size-optimized version of ExecuteParams:
 * - No per-hop min_amount_out (saves 8 bytes per step)
 * - Packed dex+direction (saves 1 byte per step)
 * 
 * Total savings for 4-hop route: ~74 bytes
 */
export interface ExecuteCompactParams {
  /** Compact route steps to execute */
  steps: RouteStepCompact[];
  /** 
   * Number of accounts for each step (enables variable bin arrays per hop).
   * If empty/undefined, falls back to fixed account counts per DEX type.
   */
  accountsPerStep?: number[];
  /** Minimum profit required - the ONLY slippage protection in compact mode */
  minProfit: bigint;
  /**
   * Pre-existing wallet balances for intermediate token accounts.
   * Used to exclude at-rest balances from dynamic amount propagation.
   */
  initialBalances?: bigint[];
  /**
   * Enable verbose logging on-chain (for simulation/debugging).
   * When true, logs detailed input/output amounts for each hop.
   */
  verbose?: boolean;
}

/**
 * Parameters for execute_compact_v2 instruction (index-based deduplication)
 * 
 * V2 enables account deduplication across hops by using indices instead of
 * contiguous slicing. This allows shared accounts (TOKEN_PROGRAM_ID, wallet,
 * DEX programs) to be included only once in remaining_accounts, reducing
 * transaction size for multi-hop same-DEX routes.
 * 
 * Example savings for 4-hop Meteora route:
 * - V1: ~74 accounts (duplicates TOKEN_PROGRAM_ID 4x, wallet 4x, etc.)
 * - V2: ~50 unique accounts + 74 byte indices = net savings when not fully ALT-covered
 */
export interface ExecuteCompactParamsV2 {
  /** Compact route steps to execute */
  steps: RouteStepCompact[];
  /** 
   * Flattened account indices into remaining_accounts.
   * Each hop's indices are concatenated: [hop0_indices..., hop1_indices..., ...]
   * Max 255 unique accounts (u8 indices).
   */
  accountIndices: number[];
  /** 
   * Number of indices for each step (to know where each hop's indices start).
   * Sum of indicesPerStep must equal accountIndices.length.
   */
  indicesPerStep: number[];
  /** Minimum profit required - the ONLY slippage protection in compact mode */
  minProfit: bigint;
  /**
   * Pre-existing wallet balances for intermediate token accounts.
   * Used to exclude at-rest balances from dynamic amount propagation.
   */
  initialBalances?: bigint[];
  /**
   * Enable verbose logging on-chain (for simulation/debugging).
   * When true, logs detailed input/output amounts for each hop.
   */
  verbose?: boolean;
}

/**
 * Pack DEX type and swap direction into a single byte
 * 
 * @param dexType - DEX enum value (0-15)
 * @param aToB - Swap direction: true = A to B, false = B to A
 * @returns Packed byte: bits 0-3 = dex_type, bit 4 = a_to_b
 */
export function packDexAndFlags(dexType: DexType, aToB: boolean): number {
  return (dexType & 0x0F) | (aToB ? 0x10 : 0x00);
}

/**
 * Unpack DEX type from packed byte
 * 
 * @param packed - Packed dexAndFlags byte
 * @returns DEX type (bits 0-3)
 */
export function unpackDexType(packed: number): DexType {
  return (packed & 0x0F) as DexType;
}

/**
 * Unpack swap direction from packed byte
 * 
 * @param packed - Packed dexAndFlags byte
 * @returns true if A to B, false if B to A
 */
export function unpackAToB(packed: number): boolean {
  return (packed & 0x10) !== 0;
}

/**
 * Convert a standard RouteStep to a compact RouteStepCompact
 * 
 * @param step - Standard route step with per-hop slippage
 * @returns Compact route step without slippage
 */
export function toCompactStep(step: RouteStep): RouteStepCompact {
  return {
    dexAndFlags: packDexAndFlags(step.dexType, step.aToB),
    amountIn: step.amountIn,
  };
}

/**
 * Convert standard ExecuteParams to compact ExecuteCompactParams
 * 
 * @param params - Standard execute parameters
 * @returns Compact execute parameters (drops per-hop slippage)
 */
export function toCompactParams(params: ExecuteParams): ExecuteCompactParams {
  return {
    steps: params.steps.map(toCompactStep),
    accountsPerStep: params.accountsPerStep,
    minProfit: params.minProfit,
    initialBalances: params.initialBalances,
    verbose: params.verbose,
  };
}

// ============================================================================
// Router Configuration
// ============================================================================

/**
 * Stored router configuration
 */
export interface RouterConfig {
  /** Deployed program ID (null if not deployed) */
  programId: string | null;
  /** Deployment timestamp */
  deployedAt: string | null;
  /** Cluster (devnet, mainnet-beta) */
  cluster: 'devnet' | 'mainnet-beta' | 'localnet';
  /** Default execution mode */
  executionMode: ExecutionMode;
  /** Default vault owner for flash loans */
  vaultOwner: string | null;
  /** Flash loan fee in basis points */
  flashLoanFeeBps: number;
  /** Whether router is enabled */
  enabled: boolean;
  /** 
   * Use pre-wrapped WSOL instead of wrapping fresh SOL for each transaction.
   * When enabled, transactions will use existing WSOL balance if sufficient,
   * saving 3 instructions (create ATA + transfer + sync) per SOL-input transaction.
   * Requires manually wrapping SOL via /wallet/wrap endpoint first.
   */
  usePreWrappedWsol?: boolean;
  /**
   * Keep WSOL balance after execution instead of auto-unwrapping to native SOL.
   * When enabled, arb profits accumulate as WSOL in the ATA.
   * Use /wallet/unwrap to convert back to native SOL when desired.
   */
  keepWsolAfterExecution?: boolean;
}

/**
 * Default router configuration
 */
export const DEFAULT_ROUTER_CONFIG: RouterConfig = {
  programId: null,
  deployedAt: null,
  cluster: 'mainnet-beta',
  executionMode: ExecutionMode.Auto,
  vaultOwner: null,
  flashLoanFeeBps: 9,
  enabled: false,
  usePreWrappedWsol: false,
  keepWsolAfterExecution: false,
};

// ============================================================================
// Vault Info (extended with derived data)
// ============================================================================

/**
 * Extended vault info for UI display
 */
export interface VaultInfo extends VaultAccount {
  /** Vault PDA address */
  address: PublicKey;
  /** Available balance (balance - borrowed) */
  availableBalance: bigint;
  /** Token symbol (if known) */
  tokenSymbol?: string;
  /** Token decimals */
  decimals?: number;
  /** USD value of balance */
  usdValue?: number;
}

// ============================================================================
// Program Status
// ============================================================================

export interface ProgramStatus {
  /** Whether program is deployed */
  deployed: boolean;
  /** Program ID if deployed */
  programId: string | null;
  /** Program data account size */
  dataSize: number | null;
  /** Whether program is executable */
  executable: boolean;
  /** Upgrade authority */
  upgradeAuthority: string | null;
  /** Last deploy slot */
  lastDeploySlot: number | null;
  /** Cluster */
  cluster: string;
}

// ============================================================================
// API Response Types
// ============================================================================

export interface DeployResponse {
  success: boolean;
  programId?: string;
  signature?: string;
  error?: string;
}

export interface VaultResponse {
  success: boolean;
  vault?: VaultInfo;
  error?: string;
}

export interface VaultsListResponse {
  success: boolean;
  vaults: VaultInfo[];
  error?: string;
}

export interface TransactionResponse {
  success: boolean;
  signature?: string;
  error?: string;
}


