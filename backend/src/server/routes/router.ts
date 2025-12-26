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
import { ensureWallet } from '../../wallet/wallet.js';
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
  getRouterConnection,
} from '../routerConfigStore.js';
import {
  peekRaydiumPools,
  peekOrcaPools,
  peekMeteoraPools,
  peekPumpswapPools,
} from '../pools.cache.js';
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
      
      // If setting programId, validate it exists on-chain
      if (updates.programId) {
        try {
          // Use cluster from updates or current config
          const currentConfig = await loadRouterConfig();
          const targetCluster = updates.cluster || currentConfig.cluster;
          const connection = getRouterConnection(targetCluster);
          const pubkey = new PublicKey(updates.programId);
          const accountInfo = await connection.getAccountInfo(pubkey, 'confirmed');
          
          if (!accountInfo) {
            return res.status(400).json({ 
              success: false, 
              error: `Program ${updates.programId} not found on ${getSolanaCluster()}` 
            });
          }
          
          if (!accountInfo.executable) {
            return res.status(400).json({ 
              success: false, 
              error: `Account ${updates.programId} exists but is not executable` 
            });
          }
          
          logger.info('router.config.program_id_validated', {
            cat: 'router',
            programId: updates.programId,
            cluster: getSolanaCluster(),
          });
        } catch (err: any) {
          return res.status(400).json({ 
            success: false, 
            error: `Invalid program ID: ${err.message}` 
          });
        }
      }
      
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
   * POST /router/config/mode - Update execution mode (alias for PUT)
   */
  api.post('/router/config/mode', async (req: Request, res: Response) => {
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

  /**
   * POST /router/config/enabled - Enable/disable router (alias for PUT)
   */
  api.post('/router/config/enabled', async (req: Request, res: Response) => {
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
      const connection = getRouterConnection(config.cluster);

      let status: ProgramStatus;
      if (config.programId) {
        logger.info('router.status.checking', { 
          cat: 'router', 
          programId: config.programId,
          cluster: getSolanaCluster() 
        });
        status = await getProgramStatus(connection, config.programId);
        logger.info('router.status.result', { 
          cat: 'router', 
          deployed: status.deployed,
          executable: status.executable,
          upgradeAuthority: status.upgradeAuthority 
        });
      } else {
        logger.info('router.status.no_program_id', { cat: 'router' });
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
      logger.error('router.status.error', { cat: 'router', error: err.message, stack: err.stack });
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
   * 
   * Options:
   * - cluster: Target cluster (devnet, mainnet-beta, localnet)
   * - forceNewProgramId: Generate a new program ID (use after closing a program)
   */
  api.post('/router/deploy', async (req: Request, res: Response) => {
    try {
      const { cluster, forceNewProgramId } = req.body;

      // Set cluster if provided
      if (cluster && ['devnet', 'mainnet-beta', 'localnet'].includes(cluster)) {
        setSolanaCluster(cluster);
      }

      const currentCluster = getSolanaCluster();
      const config = await loadRouterConfig();
      const connection = getRouterConnection(config.cluster);

      logger.info('router.deploy.start', { 
        cat: 'router', 
        cluster: currentCluster,
        forceNewProgramId: !!forceNewProgramId,
      });
      emit('router:deploy:start', { 
        cluster: currentCluster, 
        forceNewProgramId: !!forceNewProgramId,
        timestamp: Date.now() 
      });

      const result = await deployProgram({
        walletPath: CONFIG.walletPath,
        forceNewProgramId: !!forceNewProgramId,
        connection,
      });

      if (result.success && result.programId) {
        // Save to config
        await setDeployedProgramId(result.programId, currentCluster as any);
        logger.info('router.deploy.success', { cat: 'router', programId: result.programId });
        emit('router:deploy:complete', { success: true, programId: result.programId });
      } else {
        logger.error('router.deploy.failed', { cat: 'router', error: result.error, logs: result.logs });
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
      const connection = getRouterConnection(config.cluster);
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
      const routerConfig = await loadRouterConfig();
      const cluster = routerConfig.cluster;

      if (cluster !== 'devnet' && cluster !== 'localnet') {
        return res.status(400).json({ success: false, error: 'Airdrop only available on devnet/localnet' });
      }

      const wallet = await ensureWallet(CONFIG.walletPath);
      const connection = getRouterConnection(cluster);

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
      const routerConfig = await loadRouterConfig();
      const wallet = await ensureWallet(CONFIG.walletPath);
      const connection = getRouterConnection(routerConfig.cluster);
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
      const routerConfig = await loadRouterConfig();
      const wallet = await ensureWallet(CONFIG.walletPath);
      const connection = getRouterConnection(routerConfig.cluster);
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
      const routerConfig = await loadRouterConfig();
      const wallet = await ensureWallet(CONFIG.walletPath);
      const connection = getRouterConnection(routerConfig.cluster);
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

      const routerConfig = await loadRouterConfig();
      const wallet = await ensureWallet(CONFIG.walletPath);
      const connection = getRouterConnection(routerConfig.cluster);
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

      const routerConfig = await loadRouterConfig();
      const wallet = await ensureWallet(CONFIG.walletPath);
      const connection = getRouterConnection(routerConfig.cluster);
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
      const routerConfig = await loadRouterConfig();
      const wallet = await ensureWallet(CONFIG.walletPath);
      const connection = getRouterConnection(routerConfig.cluster);
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
      const routerConfig = await loadRouterConfig();
      const wallet = await ensureWallet(CONFIG.walletPath);
      const connection = getRouterConnection(routerConfig.cluster);

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

  // ============================================================================
  // Test Routes - Devnet/Mainnet Integration Testing
  // ============================================================================

  /**
   * POST /router/test/swap - Test a swap through a specific pool
   * 
   * Options:
   * - useRouter: true = use on-chain router, false = direct DEX call (default: true if router deployed)
   */
  api.post('/router/test/swap', async (req: Request, res: Response) => {
    try {
      const { 
        poolId, 
        dex = 'raydium', 
        variant = 'clmm',
        inputMint,
        outputMint,
        amountIn = '10000000',
        minAmountOut = '1',
        simulate = true,
        useRouter,
        // New: Multi-hop support
        hops = 1, // Number of hops (1 or 2)
        secondPoolId, // Optional: second pool for 2-hop swap
        secondDex = 'raydium',
        secondVariant = 'clmm',
      } = req.body;

      if (!poolId) {
        return res.status(400).json({ success: false, error: 'poolId required' });
      }

      if (hops === 2 && !secondPoolId) {
        return res.status(400).json({ success: false, error: 'secondPoolId required for 2-hop swap' });
      }

      const routerConfig = await loadRouterConfig();
      const wallet = await ensureWallet(CONFIG.walletPath);
      const connection = getRouterConnection(routerConfig.cluster);
      
      let routerProgramId: string | undefined;
      if (useRouter === true) {
        if (!routerConfig.programId) {
          return res.status(400).json({ 
            success: false, 
            error: 'Router not deployed. Deploy the router first or set useRouter: false' 
          });
        }
        routerProgramId = routerConfig.programId;
      } else if (useRouter === false) {
        routerProgramId = undefined;
      } else {
        routerProgramId = routerConfig.programId || undefined;
      }

      logger.info('router.test.swap.start', { 
        cat: 'router', 
        poolId, 
        dex, 
        variant,
        inputMint,
        outputMint,
        amountIn,
        simulate,
        hops,
        secondPoolId,
        useRouter: !!routerProgramId,
        routerProgramId,
      });

      emit('router:test:start', { poolId, dex, timestamp: Date.now() });

      const { runSwapTest } = await import('../../router/testSwap.js');
      
      const result = await runSwapTest({
        connection,
        wallet: Keypair.fromSecretKey(wallet.secretKey),
        poolId,
        dex,
        variant,
        inputMint,
        outputMint,
        amountIn: BigInt(amountIn),
        minAmountOut: BigInt(minAmountOut),
        simulateOnly: simulate,
        routerProgramId,
        // Multi-hop parameters
        hops,
        secondPoolId,
        secondDex,
        secondVariant,
      });

      if (result.success) {
        logger.info('router.test.swap.success', { 
          cat: 'router', 
          poolId,
          hops,
          signature: result.signature,
          simulated: simulate,
        });
        emit('router:test:complete', { success: true, ...result });
      } else {
        logger.warn('router.test.swap.failed', { 
          cat: 'router', 
          poolId,
          hops,
          error: result.error,
        });
        emit('router:test:complete', { success: false, error: result.error });
      }

      res.json(result);
    } catch (err: any) {
      logger.error('router.test.swap.error', { cat: 'router', error: err.message, stack: err.stack });
      emit('router:test:complete', { success: false, error: err.message });
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * GET /router/test/pool/:poolId - Fetch pool details and derive accounts
   */
  api.get('/router/test/pool/:poolId', async (req: Request, res: Response) => {
    try {
      const { poolId } = req.params;
      const { dex = 'raydium', variant = 'clmm' } = req.query;

      const routerConfig = await loadRouterConfig();
      const connection = getRouterConnection(routerConfig.cluster);

      logger.info('router.test.pool.fetch', { cat: 'router', poolId, dex, variant, cluster: routerConfig.cluster });

      const { fetchPoolAccounts } = await import('../../router/testSwap.js');
      
      const result = await fetchPoolAccounts({
        connection,
        poolId,
        dex: dex as string,
        variant: variant as string,
      });

      res.json(result);
    } catch (err: any) {
      logger.error('router.test.pool.error', { cat: 'router', error: err.message });
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ============================================================================
  // Pool Listing & Execute Testing Routes
  // ============================================================================

  /**
   * GET /router/pools - List cached pools grouped by DEX
   * Returns a subset of pools for each DEX with key fields for UI selection
   */
  api.get('/router/pools', async (req: Request, res: Response) => {
    try {
      const limit = Math.min(parseInt(req.query.limit as string) || 100, 500);
      
      const raydium = peekRaydiumPools();
      const orca = peekOrcaPools();
      const meteora = peekMeteoraPools();
      const pumpswap = peekPumpswapPools();
      
      // Helper to map pool to summary format
      const mapClmmPool = (p: any) => ({
        id: p.id,
        mintA: p.mint_a,
        mintB: p.mint_b,
        nativeMintA: p.native_mint_a,
        nativeMintB: p.native_mint_b,
        feeBps: p.fee_bps,
        tickSpacing: p.tick_spacing,
        binStep: p.bin_step,
        liquidity: p.liquidity,
        sqrtPriceX64: p.sqrt_price_x64,
      });
      
      const mapAmmPool = (p: any) => ({
        id: p.id,
        mintA: p.mint_a,
        mintB: p.mint_b,
        nativeMintA: p.native_mint_a,
        nativeMintB: p.native_mint_b,
        feeBps: p.fee_bps,
        priceAPerB: p.price_a_per_b,
        liquidityBase: p.liquidity_base,
      });
      
      res.json({
        success: true,
        pools: {
          raydium: {
            clmm: raydium.clmm.slice(0, limit).map(mapClmmPool),
            amm: raydium.amm.slice(0, limit).map(mapAmmPool),
            clmmCount: raydium.clmm.length,
            ammCount: raydium.amm.length,
          },
          orca: {
            clmm: orca.clmm.slice(0, limit).map(mapClmmPool),
            clmmCount: orca.clmm.length,
          },
          meteora: {
            dlmm: meteora.clmm.slice(0, limit).map(mapClmmPool),
            dlmmCount: meteora.clmm.length,
          },
          pumpswap: {
            amm: pumpswap.amm.slice(0, limit).map(mapAmmPool),
            ammCount: pumpswap.amm.length,
          },
        },
        totalPools: {
          raydium: raydium.clmm.length + raydium.amm.length,
          orca: orca.clmm.length,
          meteora: meteora.clmm.length,
          pumpswap: pumpswap.amm.length,
        },
      });
    } catch (err: any) {
      logger.error('router.pools.list.error', { cat: 'router', error: err.message });
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * POST /router/test-execute - Test the execute instruction with multi-hop support
   * 
   * Request body:
   * - hops: Array of { poolId, dex, inputMint, outputMint }
   * - amountIn: Raw amount in base units (string)
   * - minProfit: Minimum profit in base units (can be negative for testing)
   * - simulate: If true, simulate only; if false, send transaction
   */
  api.post('/router/test-execute', async (req: Request, res: Response) => {
    try {
      const {
        hops,
        amountIn,
        minProfit = '0',
        simulate = true,
      }: {
        hops: Array<{
          poolId: string;
          dex: 'raydium' | 'orca' | 'meteora' | 'pumpswap';
          inputMint: string;
          outputMint: string;
        }>;
        amountIn: string;
        minProfit: string;
        simulate: boolean;
      } = req.body;

      if (!hops || !Array.isArray(hops) || hops.length === 0) {
        return res.status(400).json({ success: false, error: 'hops array required' });
      }
      if (!amountIn) {
        return res.status(400).json({ success: false, error: 'amountIn required' });
      }

      const routerConfig = await loadRouterConfig();
      if (!routerConfig.programId) {
        return res.status(400).json({ 
          success: false, 
          error: 'Router not deployed. Deploy the router first.' 
        });
      }

      const wallet = await ensureWallet(CONFIG.walletPath);
      const connection = getRouterConnection(routerConfig.cluster);

      logger.info('router.test-execute.start', {
        cat: 'router',
        hops: hops.length,
        amountIn,
        minProfit,
        simulate,
        programId: routerConfig.programId,
      });

      emit('router:test-execute:start', { 
        hops: hops.length, 
        amountIn, 
        simulate, 
        timestamp: Date.now() 
      });

      // Import build functions
      const { buildRouterTransaction } = await import('../../execution/builder/routerTx.js');
      const { resolveDirectPlan } = await import('../../execution/resolver/index.js');
      const { ExecutionMode } = await import('../../router/types.js');

      // Build path array for resolver (N+1 tokens for N hops)
      const path: string[] = [hops[0].inputMint];
      for (const hop of hops) {
        path.push(hop.outputMint);
      }

      // Resolve the execution plan
      const hopPoolIds = hops.map(h => h.poolId);
      const dexes = hops.map(h => {
        // Map dex name to variant for proper pool type identification
        const dexLower = h.dex.toLowerCase();
        if (dexLower === 'raydium') return 'raydium-clmm';
        if (dexLower === 'meteora') return 'meteora-dlmm';
        return dexLower;
      });

      // ExecConfig for resolver
      const execConfig = {
        mode: 'direct' as const,
        slippageBpsDefault: 100, // 1% slippage for testing
        computeUnitLimit: 400000,
        computeUnitPriceMicroLamports: 1000,
        createAtasInTx: true,
        dynamicCompute: false,
      };

      const executionPlan = await resolveDirectPlan({
        path,
        hopPoolIds,
        dexes,
        slippageBps: 100,
        minProfitBps: parseInt(minProfit) >= 0 ? parseInt(minProfit) : -10000,
      }, execConfig);

      if (!executionPlan || executionPlan.hops.length === 0) {
        return res.status(400).json({ 
          success: false, 
          error: 'Failed to resolve execution plan' 
        });
      }

      // Track input/output for logging - use local variables since ExecutionPlan doesn't have these fields
      const inputRaw = BigInt(amountIn);
      if (executionPlan.hops.length > 0) {
        executionPlan.hops[0].amountInRaw = inputRaw;
      }
      
      // Calculate expected output from the last hop
      const lastHop = executionPlan.hops[executionPlan.hops.length - 1];
      const expectedOutputRaw = lastHop?.minOutRaw || lastHop?.amountInRaw || BigInt(0);

      logger.info('router.test-execute.plan_resolved', {
        cat: 'router',
        hopsResolved: executionPlan.hops.length,
        inputRaw: inputRaw.toString(),
        expectedOutput: expectedOutputRaw.toString(),
      });

      // Build the router transaction (returns instructions, not a full transaction)
      const txResult = await buildRouterTransaction(
        executionPlan,
        { publicKey: wallet.publicKey, secretKey: wallet.secretKey },
        { mode: ExecutionMode.Direct }
      );

      if (txResult.error || txResult.instructions.length === 0) {
        logger.error('router.test-execute.build_failed', {
          cat: 'router',
          error: txResult.error,
          usedRouter: txResult.usedRouter,
        });
        return res.status(400).json({
          success: false,
          error: txResult.error || 'Failed to build transaction - no instructions generated',
        });
      }

      // Build a transaction from the instructions
      const tx = new Transaction();
      tx.add(...txResult.instructions);

      // Add recent blockhash
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
      tx.recentBlockhash = blockhash;
      tx.lastValidBlockHeight = lastValidBlockHeight;
      tx.feePayer = wallet.publicKey;

      if (simulate) {
        // Simulate the transaction (use empty signers array for legacy Transaction)
        const simResult = await connection.simulateTransaction(tx, []);

        const success = !simResult.value.err;
        
        logger.info('router.test-execute.simulated', {
          cat: 'router',
          success,
          error: simResult.value.err,
          logs: simResult.value.logs?.slice(-10),
          unitsConsumed: simResult.value.unitsConsumed,
        });

        emit('router:test-execute:complete', { 
          success, 
          simulated: true,
          unitsConsumed: simResult.value.unitsConsumed,
        });

        return res.json({
          success,
          simulated: true,
          error: simResult.value.err ? JSON.stringify(simResult.value.err) : null,
          logs: simResult.value.logs,
          unitsConsumed: simResult.value.unitsConsumed,
          plan: {
            hops: executionPlan.hops.length,
            inputRaw: inputRaw.toString(),
            expectedOutputRaw: expectedOutputRaw.toString(),
          },
        });
      } else {
        // Send the transaction
        try {
          // Sign the transaction
          const keypair = Keypair.fromSecretKey(wallet.secretKey);
          tx.sign(keypair);

          const signature = await connection.sendRawTransaction(tx.serialize(), {
            skipPreflight: true,
            preflightCommitment: 'confirmed',
          });

          logger.info('router.test-execute.sent', {
            cat: 'router',
            signature,
          });

          // Wait for confirmation
          const confirmation = await connection.confirmTransaction({
            signature,
            blockhash,
            lastValidBlockHeight,
          }, 'confirmed');

          const success = !confirmation.value.err;

          logger.info('router.test-execute.confirmed', {
            cat: 'router',
            signature,
            success,
            error: confirmation.value.err,
          });

          emit('router:test-execute:complete', { 
            success, 
            simulated: false,
            signature,
          });

          return res.json({
            success,
            simulated: false,
            signature,
            error: confirmation.value.err ? JSON.stringify(confirmation.value.err) : null,
            plan: {
              hops: executionPlan.hops.length,
              inputRaw: inputRaw.toString(),
              expectedOutputRaw: expectedOutputRaw.toString(),
            },
          });
        } catch (sendErr: any) {
          logger.error('router.test-execute.send_error', {
            cat: 'router',
            error: sendErr.message,
          });

          emit('router:test-execute:complete', { 
            success: false, 
            error: sendErr.message,
          });

          return res.status(500).json({
            success: false,
            error: sendErr.message,
          });
        }
      }
    } catch (err: any) {
      logger.error('router.test-execute.error', { 
        cat: 'router', 
        error: err.message, 
        stack: err.stack 
      });
      emit('router:test-execute:complete', { success: false, error: err.message });
      res.status(500).json({ success: false, error: err.message });
    }
  });

  return api;
}


