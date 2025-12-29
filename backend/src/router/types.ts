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
  PUMPSWAP: new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'),
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
  Raydium = 0,
  Meteora = 1,
  Orca = 2,
  PumpSwap = 3,
}

export enum ExecutionMode {
  /** Direct execution - user's own tokens, no flash loan */
  Direct = 'direct',
  /** Flash loan mode - borrow from vault, execute arb, repay with profit */
  FlashLoan = 'flash_loan',
  /** Auto - use flash loan if vault has funds, otherwise direct */
  Auto = 'auto',
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
}

/**
 * Default router configuration
 */
export const DEFAULT_ROUTER_CONFIG: RouterConfig = {
  programId: null,
  deployedAt: null,
  cluster: 'devnet',
  executionMode: ExecutionMode.Auto,
  vaultOwner: null,
  flashLoanFeeBps: 9,
  enabled: false,
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


