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
  deployProgram,
  upgradeProgram,
  getProgramStatus,
  checkDeploymentBalance,
  requestAirdrop,
} from './deployer.js';


