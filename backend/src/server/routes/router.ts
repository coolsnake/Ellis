/**
 * API routes for the arb-router program
 * Handles deployment, vault management, and router configuration
 */

import { Router, type Request, type Response } from 'express';
import type { Server as SocketIOServer } from 'socket.io';
import { PublicKey, Keypair, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, createAssociatedTokenAccountInstruction, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import BN from 'bn.js';
import { logger } from '../../utils/logger.js';
import { getConnection, ensureWallet } from '../../wallet/wallet.js';
import { CONFIG } from '../../utils/config.js';
import { emit } from '../realtime.js';
import {
  loadRouterConfig,
  saveRouterConfig,
  setDeployedProgramId,
  setExecutionMode,
  setVaultOwner,
  setRouterEnabled,
  isRouterReady,
  isFlashLoanAvailable,
} from '../routerConfigStore.js';
import {
  // SDK
  deriveVaultPda,
  fetchVault,
  fetchVaultsForOwner,
  buildVaultInitIx,
  buildVaultDepositIx,
  buildVaultWithdrawIx,
  buildVaultCloseIx,
  calculateFlashLoanFee,
  accountExists,
  // Types
  ARB_ROUTER_PROGRAM_ID,
  VaultAccount,
  VaultInfo,
  ProgramStatus,
  ExecutionMode,
  // Deployer
  isSolanaCliAvailable,
  isAnchorCliAvailable,
  getSolanaCluster,
  setSolanaCluster,
  buildProgram,
  deployProgram,
  upgradeProgram,
  closeProgram,
  getProgramStatus,
  checkDeploymentBalance,
  requestAirdrop,
} from '../../router/index.js';

export function createRouterRouter(io: SocketIOServer): Router {
  const api = Router();

  // Helper to get program ID from config or default
  const getProgramId = async (): Promise<PublicKey> => {
    const config = await loadRouterConfig();
    return config.programId ? new PublicKey(config.programId) : ARB_ROUTER_PROGRAM_ID;
  };

  // ============================================================================
  // Configuration Routes
  // ============================================================================

  /**
   * GET /router/config - Get router configuration
   */
  api.get('/router/config', async (_req: Request, res: Response) => {
    try {
      const config = await loadRouterConfig();
      res.json({ success: true, config });
    } catch (err: any) {
      logger.error('router.config.get.error', { cat: 'router', error: err.message });
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * PUT /router/config - Update router configuration
   */
  api.put('/router/config', async (req: Request, res: Response) => {
    try {
      const updates = req.body;
      const config = await saveRouterConfig(updates);
      emit('router:config', config);
      res.json({ success: true, config });
    } catch (err: any) {
      logger.error('router.config.update.error', { cat: 'router', error: err.message });
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * PUT /router/config/mode - Update execution mode
   */
  api.put('/router/config/mode', async (req: Request, res: Response) => {
    try {
      const { mode } = req.body;
      if (!Object.values(ExecutionMode).includes(mode)) {
        return res.status(400).json({ success: false, error: 'Invalid execution mode' });
      }
      const config = await setExecutionMode(mode);
      emit('router:config', config);
      res.json({ success: true, config });
    } catch (err: any) {
      logger.error('router.config.mode.error', { cat: 'router', error: err.message });
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * PUT /router/config/enabled - Enable/disable router
   */
  api.put('/router/config/enabled', async (req: Request, res: Response) => {
    try {
      const { enabled } = req.body;
      const config = await setRouterEnabled(!!enabled);
      emit('router:config', config);
      res.json({ success: true, config });
    } catch (err: any) {
      logger.error('router.config.enabled.error', { cat: 'router', error: err.message });
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ============================================================================
  // Status & Deployment Routes
  // ============================================================================

  /**
   * GET /router/status - Get program deployment status
   */
  api.get('/router/status', async (_req: Request, res: Response) => {
    try {
      const config = await loadRouterConfig();
      const connection = getConnection();

      let status: ProgramStatus;
      if (config.programId) {
        status = await getProgramStatus(connection, config.programId);
      } else {
        status = {
          deployed: false,
          programId: null,
          dataSize: null,
          executable: false,
          upgradeAuthority: null,
          lastDeploySlot: null,
          cluster: getSolanaCluster(),
        };
      }

      // Add CLI availability info
      const cliStatus = {
        solana: isSolanaCliAvailable(),
        anchor: isAnchorCliAvailable(),
        cluster: getSolanaCluster(),
      };

      res.json({
        success: true,
        status,
        config,
        cli: cliStatus,
        ready: await isRouterReady(),
        flashLoanAvailable: await isFlashLoanAvailable(),
      });
    } catch (err: any) {
      logger.error('router.status.error', { cat: 'router', error: err.message });
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * POST /router/build - Build the program
   */
  api.post('/router/build', async (_req: Request, res: Response) => {
    try {
      logger.info('router.build.start', { cat: 'router' });
      emit('router:build:start', { timestamp: Date.now() });

      const result = await buildProgram();

      if (result.success) {
        logger.info('router.build.success', { cat: 'router', binaryPath: result.binaryPath });
        emit('router:build:complete', { success: true, binaryPath: result.binaryPath });
      } else {
        logger.error('router.build.failed', { cat: 'router', error: result.error });
        emit('router:build:complete', { success: false, error: result.error });
      }

      res.json(result);
    } catch (err: any) {
      logger.error('router.build.error', { cat: 'router', error: err.message });
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * POST /router/deploy - Deploy the program
   */
  api.post('/router/deploy', async (req: Request, res: Response) => {
    try {
      const { cluster } = req.body;

      // Set cluster if provided
      if (cluster && ['devnet', 'mainnet-beta', 'localnet'].includes(cluster)) {
        setSolanaCluster(cluster);
      }

      logger.info('router.deploy.start', { cat: 'router', cluster: getSolanaCluster() });
      emit('router:deploy:start', { cluster: getSolanaCluster(), timestamp: Date.now() });

      const result = await deployProgram(CONFIG.walletPath);

      if (result.success && result.programId) {
        // Save to config
        await setDeployedProgramId(result.programId, getSolanaCluster() as any);
        logger.info('router.deploy.success', { cat: 'router', programId: result.programId });
        emit('router:deploy:complete', { success: true, programId: result.programId });
      } else {
        logger.error('router.deploy.failed', { cat: 'router', error: result.error });
        emit('router:deploy:complete', { success: false, error: result.error });
      }

      res.json(result);
    } catch (err: any) {
      logger.error('router.deploy.error', { cat: 'router', error: err.message });
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * POST /router/upgrade - Upgrade the program
   */
  api.post('/router/upgrade', async (_req: Request, res: Response) => {
    try {
      const config = await loadRouterConfig();
      if (!config.programId) {
        return res.status(400).json({ success: false, error: 'No program deployed' });
      }

      logger.info('router.upgrade.start', { cat: 'router', programId: config.programId });
      emit('router:upgrade:start', { programId: config.programId, timestamp: Date.now() });

      const result = await upgradeProgram(config.programId, CONFIG.walletPath);

      if (result.success) {
        logger.info('router.upgrade.success', { cat: 'router', programId: config.programId });
        emit('router:upgrade:complete', { success: true, programId: config.programId });
      } else {
        logger.error('router.upgrade.failed', { cat: 'router', error: result.error });
        emit('router:upgrade:complete', { success: false, error: result.error });
      }

      res.json(result);
    } catch (err: any) {
      logger.error('router.upgrade.error', { cat: 'router', error: err.message });
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * POST /router/close - Close the program and recover rent
   */
  api.post('/router/close', async (req: Request, res: Response) => {
    try {
      const config = await loadRouterConfig();
      if (!config.programId) {
        return res.status(400).json({ success: false, error: 'No program deployed' });
      }

      const { recipient } = req.body; // Optional: specify rent recipient

      // Verify upgrade authority before attempting close
      const connection = getConnection();
      const status = await getProgramStatus(connection, config.programId);
      
      if (!status.executable) {
        return res.status(400).json({ 
          success: false, 
          error: 'Program is not executable or already closed' 
        });
      }
      
      if (!status.upgradeAuthority) {
        return res.status(400).json({ 
          success: false, 
          error: 'Program has no upgrade authority (immutable). Cannot close.' 
        });
      }

      // Verify the wallet is the upgrade authority
      const wallet = await ensureWallet(CONFIG.walletPath);
      if (status.upgradeAuthority !== wallet.publicKey.toBase58()) {
        return res.status(403).json({ 
          success: false, 
          error: `You are not the upgrade authority. ` +
                 `Expected: ${status.upgradeAuthority}, ` +
                 `Your wallet: ${wallet.publicKey.toBase58()}` 
        });
      }

      logger.info('router.close.start', { cat: 'router', programId: config.programId });
      emit('router:close:start', { programId: config.programId, timestamp: Date.now() });

      const result = await closeProgram(config.programId, CONFIG.walletPath, recipient);

      if (result.success) {
        // Clear program from config
        await saveRouterConfig({ 
          programId: null, 
          deployedAt: null,
          enabled: false 
        });
        
        logger.info('router.close.success', { 
          cat: 'router', 
          programId: config.programId,
          rentRecovered: result.rentRecovered,
          rentRecoveredSOL: result.rentRecovered ? (result.rentRecovered / 1e9).toFixed(6) : 'unknown'
        });
        emit('router:close:complete', { 
          success: true, 
          programId: config.programId,
          rentRecovered: result.rentRecovered 
        });
      } else {
        logger.error('router.close.failed', { cat: 'router', error: result.error });
        emit('router:close:complete', { success: false, error: result.error });
      }

      res.json(result);
    } catch (err: any) {
      logger.error('router.close.error', { cat: 'router', error: err.message });
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * POST /router/airdrop - Request airdrop (devnet only)
   */
  api.post('/router/airdrop', async (req: Request, res: Response) => {
    try {
      const { amount = 2 } = req.body;
      const cluster = getSolanaCluster();

      if (cluster !== 'devnet' && cluster !== 'localnet') {
        return res.status(400).json({ success: false, error: 'Airdrop only available on devnet/localnet' });
      }

      const wallet = await ensureWallet(CONFIG.walletPath);
      const connection = getConnection();

      const success = await requestAirdrop(connection, wallet.publicKey, amount);

      if (success) {
        const balance = await connection.getBalance(wallet.publicKey);
        res.json({ success: true, balance: balance / 1e9 });
      } else {
        res.status(500).json({ success: false, error: 'Airdrop failed' });
      }
    } catch (err: any) {
      logger.error('router.airdrop.error', { cat: 'router', error: err.message });
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ============================================================================
  // Vault Routes
  // ============================================================================

  /**
   * GET /router/vaults - List all vaults for the wallet
   */
  api.get('/router/vaults', async (_req: Request, res: Response) => {
    try {
      const wallet = await ensureWallet(CONFIG.walletPath);
      const connection = getConnection();
      const programId = await getProgramId();

      const vaultsData = await fetchVaultsForOwner(connection, wallet.publicKey, programId);

      // Convert to VaultInfo with extended data
      const vaults: VaultInfo[] = vaultsData.map(({ address, vault }) => ({
        ...vault,
        address,
        availableBalance: vault.balance - vault.borrowedAmount,
      }));

      res.json({ success: true, vaults });
    } catch (err: any) {
      logger.error('router.vaults.list.error', { cat: 'router', error: err.message });
      res.status(500).json({ success: false, error: err.message, vaults: [] });
    }
  });

  /**
   * GET /router/vaults/:mint - Get specific vault
   */
  api.get('/router/vaults/:mint', async (req: Request, res: Response) => {
    try {
      const { mint } = req.params;
      const wallet = await ensureWallet(CONFIG.walletPath);
      const connection = getConnection();
      const programId = await getProgramId();

      const mintPubkey = new PublicKey(mint);
      const [vaultAddress] = deriveVaultPda(wallet.publicKey, mintPubkey, programId);

      const vault = await fetchVault(connection, vaultAddress);

      if (!vault) {
        return res.status(404).json({ success: false, error: 'Vault not found' });
      }

      const vaultInfo: VaultInfo = {
        ...vault,
        address: vaultAddress,
        availableBalance: vault.balance - vault.borrowedAmount,
      };

      res.json({ success: true, vault: vaultInfo });
    } catch (err: any) {
      logger.error('router.vault.get.error', { cat: 'router', error: err.message });
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * POST /router/vaults/:mint/init - Initialize a new vault
   */
  api.post('/router/vaults/:mint/init', async (req: Request, res: Response) => {
    try {
      const { mint } = req.params;
      const wallet = await ensureWallet(CONFIG.walletPath);
      const connection = getConnection();
      const programId = await getProgramId();

      const mintPubkey = new PublicKey(mint);
      const [vaultAddress] = deriveVaultPda(wallet.publicKey, mintPubkey, programId);

      // Check if vault already exists
      if (await accountExists(connection, vaultAddress)) {
        return res.status(400).json({ success: false, error: 'Vault already exists' });
      }

      // Create vault token account
      const vaultTokenAccount = Keypair.generate();

      // Build instruction
      const ix = buildVaultInitIx(wallet.publicKey, mintPubkey, vaultTokenAccount.publicKey, programId);

      // Build and send transaction
      const tx = new Transaction().add(ix);
      tx.feePayer = wallet.publicKey;
      tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

      const signature = await sendAndConfirmTransaction(
        connection,
        tx,
        [Keypair.fromSecretKey(wallet.secretKey), vaultTokenAccount],
        { commitment: 'confirmed' }
      );

      logger.info('router.vault.init.success', {
        cat: 'router',
        mint,
        vault: vaultAddress.toBase58(),
        signature,
      });

      emit('router:vault:init', { mint, vault: vaultAddress.toBase58(), signature });

      res.json({
        success: true,
        vault: vaultAddress.toBase58(),
        tokenAccount: vaultTokenAccount.publicKey.toBase58(),
        signature,
      });
    } catch (err: any) {
      logger.error('router.vault.init.error', { cat: 'router', error: err.message });
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * POST /router/vaults/:mint/deposit - Deposit tokens into vault
   */
  api.post('/router/vaults/:mint/deposit', async (req: Request, res: Response) => {
    try {
      const { mint } = req.params;
      const { amount } = req.body;

      if (!amount || amount <= 0) {
        return res.status(400).json({ success: false, error: 'Invalid amount' });
      }

      const wallet = await ensureWallet(CONFIG.walletPath);
      const connection = getConnection();
      const programId = await getProgramId();

      const mintPubkey = new PublicKey(mint);
      const userAta = getAssociatedTokenAddressSync(mintPubkey, wallet.publicKey);

      // Build instruction
      const ix = buildVaultDepositIx(
        wallet.publicKey,
        mintPubkey,
        userAta,
        BigInt(amount),
        programId
      );

      // Build and send transaction
      const tx = new Transaction().add(ix);
      tx.feePayer = wallet.publicKey;
      tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

      const signature = await sendAndConfirmTransaction(
        connection,
        tx,
        [Keypair.fromSecretKey(wallet.secretKey)],
        { commitment: 'confirmed' }
      );

      logger.info('router.vault.deposit.success', {
        cat: 'router',
        mint,
        amount,
        signature,
      });

      emit('router:vault:deposit', { mint, amount, signature });

      res.json({ success: true, signature });
    } catch (err: any) {
      logger.error('router.vault.deposit.error', { cat: 'router', error: err.message });
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * POST /router/vaults/:mint/withdraw - Withdraw tokens from vault
   */
  api.post('/router/vaults/:mint/withdraw', async (req: Request, res: Response) => {
    try {
      const { mint } = req.params;
      const { amount } = req.body;

      if (!amount || amount <= 0) {
        return res.status(400).json({ success: false, error: 'Invalid amount' });
      }

      const wallet = await ensureWallet(CONFIG.walletPath);
      const connection = getConnection();
      const programId = await getProgramId();

      const mintPubkey = new PublicKey(mint);
      const userAta = getAssociatedTokenAddressSync(mintPubkey, wallet.publicKey);

      // Ensure user ATA exists
      const instructions = [];
      if (!(await accountExists(connection, userAta))) {
        instructions.push(
          createAssociatedTokenAccountInstruction(
            wallet.publicKey,
            userAta,
            wallet.publicKey,
            mintPubkey
          )
        );
      }

      // Build withdraw instruction
      const ix = buildVaultWithdrawIx(
        wallet.publicKey,
        mintPubkey,
        userAta,
        BigInt(amount),
        programId
      );
      instructions.push(ix);

      // Build and send transaction
      const tx = new Transaction().add(...instructions);
      tx.feePayer = wallet.publicKey;
      tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

      const signature = await sendAndConfirmTransaction(
        connection,
        tx,
        [Keypair.fromSecretKey(wallet.secretKey)],
        { commitment: 'confirmed' }
      );

      logger.info('router.vault.withdraw.success', {
        cat: 'router',
        mint,
        amount,
        signature,
      });

      emit('router:vault:withdraw', { mint, amount, signature });

      res.json({ success: true, signature });
    } catch (err: any) {
      logger.error('router.vault.withdraw.error', { cat: 'router', error: err.message });
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * POST /router/vaults/:mint/close - Close vault
   */
  api.post('/router/vaults/:mint/close', async (req: Request, res: Response) => {
    try {
      const { mint } = req.params;
      const wallet = await ensureWallet(CONFIG.walletPath);
      const connection = getConnection();
      const programId = await getProgramId();

      const mintPubkey = new PublicKey(mint);
      const [vaultAddress] = deriveVaultPda(wallet.publicKey, mintPubkey, programId);

      // Check vault exists and is empty
      const vault = await fetchVault(connection, vaultAddress);
      if (!vault) {
        return res.status(404).json({ success: false, error: 'Vault not found' });
      }
      if (vault.balance > 0n) {
        return res.status(400).json({ success: false, error: 'Vault not empty - withdraw first' });
      }
      if (vault.flashLoanActive) {
        return res.status(400).json({ success: false, error: 'Flash loan active' });
      }

      // Build instruction
      const ix = buildVaultCloseIx(wallet.publicKey, mintPubkey, programId);

      // Build and send transaction
      const tx = new Transaction().add(ix);
      tx.feePayer = wallet.publicKey;
      tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

      const signature = await sendAndConfirmTransaction(
        connection,
        tx,
        [Keypair.fromSecretKey(wallet.secretKey)],
        { commitment: 'confirmed' }
      );

      logger.info('router.vault.close.success', {
        cat: 'router',
        mint,
        signature,
      });

      emit('router:vault:close', { mint, signature });

      res.json({ success: true, signature });
    } catch (err: any) {
      logger.error('router.vault.close.error', { cat: 'router', error: err.message });
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * GET /router/vaults/:mint/fee - Calculate flash loan fee
   */
  api.get('/router/vaults/:mint/fee', async (req: Request, res: Response) => {
    try {
      const { amount } = req.query;
      if (!amount) {
        return res.status(400).json({ success: false, error: 'Amount required' });
      }

      const amountBn = BigInt(amount as string);
      const fee = calculateFlashLoanFee(amountBn);
      const repayAmount = amountBn + fee;

      res.json({
        success: true,
        amount: amountBn.toString(),
        fee: fee.toString(),
        repayAmount: repayAmount.toString(),
        feeBps: 9,
      });
    } catch (err: any) {
      logger.error('router.fee.error', { cat: 'router', error: err.message });
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ============================================================================
  // CLI Status Routes
  // ============================================================================

  /**
   * GET /router/cli - Get CLI availability status
   */
  api.get('/router/cli', async (_req: Request, res: Response) => {
    try {
      const wallet = await ensureWallet(CONFIG.walletPath);
      const connection = getConnection();

      const balanceCheck = await checkDeploymentBalance(connection, wallet.publicKey);

      res.json({
        success: true,
        solana: isSolanaCliAvailable(),
        anchor: isAnchorCliAvailable(),
        cluster: getSolanaCluster(),
        wallet: wallet.publicKey.toBase58(),
        balance: balanceCheck.balance,
        balanceSufficient: balanceCheck.sufficient,
        requiredBalance: balanceCheck.requiredEstimate,
      });
    } catch (err: any) {
      logger.error('router.cli.error', { cat: 'router', error: err.message });
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * POST /router/cli/cluster - Set Solana cluster
   */
  api.post('/router/cli/cluster', async (req: Request, res: Response) => {
    try {
      const { cluster } = req.body;

      if (!['devnet', 'mainnet-beta', 'testnet', 'localnet'].includes(cluster)) {
        return res.status(400).json({ success: false, error: 'Invalid cluster' });
      }

      const success = setSolanaCluster(cluster);

      if (success) {
        res.json({ success: true, cluster: getSolanaCluster() });
      } else {
        res.status(500).json({ success: false, error: 'Failed to set cluster' });
      }
    } catch (err: any) {
      logger.error('router.cli.cluster.error', { cat: 'router', error: err.message });
      res.status(500).json({ success: false, error: err.message });
    }
  });

  return api;
}


