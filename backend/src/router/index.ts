/**
 * Arb-Router SDK module
 * 
 * Provides TypeScript SDK for interacting with the arb-router on-chain program
 */

// Types
export * from './types.js';

// SDK functions
export {
  // PDA derivation
  deriveVaultPda,
  deriveConfigPda,
  
  // Account fetching
  deserializeVault,
  fetchVault,
  fetchVaultsForOwner,
  
  // Instruction builders
  buildVaultInitIx,
  buildVaultDepositIx,
  buildVaultWithdrawIx,
  buildVaultCloseIx,
  buildFlashBorrowIx,
  buildFlashRepayIx,
  buildRouteSwapIx,
  buildExecuteIx,
  buildExecuteCompactIx,
  buildExecuteCompactV2Ix,
  
  // Utilities
  calculateFlashLoanFee,
  calculateRepayAmount,
  getAccountsNeededForDex,
  dexNameToType,
  accountExists,
  
  // Discriminators
  DISCRIMINATORS,
} from './sdk.js';

// Deployer functions
export {
  isSolanaCliAvailable,
  isAnchorCliAvailable,
  getSolanaCluster,
  setSolanaCluster,
  buildProgram,
  generateProgramKeypair,
  loadProgramKeypair,
  updateProgramIdInSource,
  isProgramClosed,
  deployProgram,
  upgradeProgram,
  closeProgram,
  getProgramStatus,
  checkDeploymentBalance,
  requestAirdrop,
  type DeployOptions,
} from './deployer.js';

// Test swap functions
export {
  runSwapTest,
  fetchPoolAccounts,
  type TestSwapParams,
  type TestSwapResult,
  type RaydiumClmmPoolState,
} from './testSwap.js';

