/**
 * Deployment utilities for the arb-router program
 */

import { spawn, execSync } from 'child_process';
import { promises as fs } from 'fs';
import path, { dirname } from 'path';
import { fileURLToPath } from 'url';
import { Connection, PublicKey, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { logger } from '../utils/logger.js';
import { ProgramStatus } from './types.js';

// ============================================================================
// Configuration
// ============================================================================

// Use import.meta.url for reliable path resolution (same pattern as config.ts)
const __dirname = dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.resolve(__dirname, '..', '..');
// Allow environment variable override for custom deployments
const ARB_ROUTER_DIR = process.env.ARB_ROUTER_DIR || path.resolve(BACKEND_ROOT, '..', 'arb-router');
const PROGRAM_BINARY_PATH = path.join(ARB_ROUTER_DIR, 'target', 'deploy', 'arb_router.so');
const KEYPAIR_PATH = path.join(ARB_ROUTER_DIR, 'target', 'deploy', 'arb_router-keypair.json');

// ============================================================================
// Types
// ============================================================================

export interface DeployResult {
  success: boolean;
  programId?: string;
  signature?: string;
  error?: string;
  logs?: string[];
}

export interface BuildResult {
  success: boolean;
  binaryPath?: string;
  error?: string;
  logs?: string[];
}

export interface CloseResult {
  success: boolean;
  rentRecovered?: number;
  error?: string;
  logs?: string[];
}

// ============================================================================
// Deployment Functions
// ============================================================================

/**
 * Check if Solana CLI is available
 */
export function isSolanaCliAvailable(): boolean {
  try {
    execSync('solana --version', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if Anchor CLI is available
 */
export function isAnchorCliAvailable(): boolean {
  try {
    execSync('anchor --version', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the current Solana CLI cluster
 */
export function getSolanaCluster(): string {
  try {
    const output = execSync('solana config get json_rpc_url', { encoding: 'utf-8' });
    const url = output.split('\n').find((line) => line.includes('http'))?.trim() || '';
    
    if (url.includes('devnet')) return 'devnet';
    if (url.includes('mainnet')) return 'mainnet-beta';
    if (url.includes('testnet')) return 'testnet';
    if (url.includes('localhost') || url.includes('127.0.0.1')) return 'localnet';
    
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Set Solana CLI cluster
 */
export function setSolanaCluster(cluster: 'devnet' | 'mainnet-beta' | 'testnet' | 'localnet'): boolean {
  try {
    const urls: Record<string, string> = {
      devnet: 'https://api.devnet.solana.com',
      'mainnet-beta': 'https://api.mainnet-beta.solana.com',
      testnet: 'https://api.testnet.solana.com',
      localnet: 'http://127.0.0.1:8899',
    };
    
    execSync(`solana config set --url ${urls[cluster]}`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Build the program using Anchor
 */
export async function buildProgram(): Promise<BuildResult> {
  const logs: string[] = [];
  
  try {
    if (!isAnchorCliAvailable()) {
      return {
        success: false,
        error: 'Anchor CLI not available. Please install with: cargo install --git https://github.com/coral-xyz/anchor anchor-cli',
        logs,
      };
    }

    // Check if arb-router directory exists
    try {
      await fs.access(ARB_ROUTER_DIR);
    } catch {
      return {
        success: false,
        error: `arb-router directory not found at ${ARB_ROUTER_DIR}`,
        logs,
      };
    }

    logs.push(`Building program in ${ARB_ROUTER_DIR}...`);

    return new Promise((resolve) => {
      const build = spawn('anchor', ['build'], {
        cwd: ARB_ROUTER_DIR,
        shell: true,
      });

      build.stdout.on('data', (data) => {
        const line = data.toString().trim();
        logs.push(line);
        logger.debug('anchor.build.stdout', { cat: 'router', line });
      });

      build.stderr.on('data', (data) => {
        const line = data.toString().trim();
        logs.push(line);
        logger.debug('anchor.build.stderr', { cat: 'router', line });
      });

      build.on('close', async (code) => {
        if (code === 0) {
          // Verify binary exists
          try {
            await fs.access(PROGRAM_BINARY_PATH);
            resolve({
              success: true,
              binaryPath: PROGRAM_BINARY_PATH,
              logs,
            });
          } catch {
            resolve({
              success: false,
              error: 'Build succeeded but binary not found',
              logs,
            });
          }
        } else {
          resolve({
            success: false,
            error: `Build failed with exit code ${code}`,
            logs,
          });
        }
      });

      build.on('error', (err) => {
        resolve({
          success: false,
          error: `Build error: ${err.message}`,
          logs,
        });
      });
    });
  } catch (err: any) {
    return {
      success: false,
      error: `Build failed: ${err.message}`,
      logs,
    };
  }
}

/**
 * Generate a new program keypair
 */
export async function generateProgramKeypair(): Promise<{ keypair: Keypair; path: string } | null> {
  try {
    // Create directory if it doesn't exist
    const dir = path.dirname(KEYPAIR_PATH);
    await fs.mkdir(dir, { recursive: true });

    const keypair = Keypair.generate();
    const secretKey = JSON.stringify(Array.from(keypair.secretKey));
    await fs.writeFile(KEYPAIR_PATH, secretKey, 'utf-8');

    logger.info('router.keypair.generated', {
      cat: 'router',
      publicKey: keypair.publicKey.toBase58(),
      path: KEYPAIR_PATH,
    });

    return { keypair, path: KEYPAIR_PATH };
  } catch (err: any) {
    logger.error('router.keypair.generate_failed', {
      cat: 'router',
      error: err.message,
    });
    return null;
  }
}

/**
 * Load existing program keypair
 */
export async function loadProgramKeypair(): Promise<Keypair | null> {
  try {
    const data = await fs.readFile(KEYPAIR_PATH, 'utf-8');
    const secretKey = Uint8Array.from(JSON.parse(data));
    return Keypair.fromSecretKey(secretKey);
  } catch {
    return null;
  }
}

/**
 * Deploy the program to the configured cluster
 */
export async function deployProgram(
  walletPath?: string,
  binaryPath: string = PROGRAM_BINARY_PATH,
  keypairPath: string = KEYPAIR_PATH
): Promise<DeployResult> {
  const logs: string[] = [];

  try {
    if (!isSolanaCliAvailable()) {
      return {
        success: false,
        error: 'Solana CLI not available',
        logs,
      };
    }

    // Check binary exists
    try {
      await fs.access(binaryPath);
    } catch {
      return {
        success: false,
        error: `Program binary not found at ${binaryPath}. Run build first.`,
        logs,
      };
    }

    // Check or generate keypair
    try {
      await fs.access(keypairPath);
    } catch {
      logs.push('Generating new program keypair...');
      const result = await generateProgramKeypair();
      if (!result) {
        return {
          success: false,
          error: 'Failed to generate program keypair',
          logs,
        };
      }
    }

    // Load keypair to get program ID
    const keypair = await loadProgramKeypair();
    if (!keypair) {
      return {
        success: false,
        error: 'Failed to load program keypair',
        logs,
      };
    }

    const programId = keypair.publicKey.toBase58();
    logs.push(`Deploying program with ID: ${programId}`);
    logs.push(`Cluster: ${getSolanaCluster()}`);

    // Build deploy command
    const args = ['program', 'deploy', binaryPath, '--program-id', keypairPath];
    if (walletPath) {
      args.push('--keypair', walletPath);
    }

    return new Promise((resolve) => {
      const deploy = spawn('solana', args, {
        shell: true,
      });

      deploy.stdout.on('data', (data) => {
        const line = data.toString().trim();
        logs.push(line);
        logger.info('solana.deploy.stdout', { cat: 'router', line });
      });

      deploy.stderr.on('data', (data) => {
        const line = data.toString().trim();
        logs.push(line);
        logger.warn('solana.deploy.stderr', { cat: 'router', line });
      });

      deploy.on('close', (code) => {
        if (code === 0) {
          resolve({
            success: true,
            programId,
            logs,
          });
        } else {
          resolve({
            success: false,
            error: `Deploy failed with exit code ${code}`,
            logs,
          });
        }
      });

      deploy.on('error', (err) => {
        resolve({
          success: false,
          error: `Deploy error: ${err.message}`,
          logs,
        });
      });
    });
  } catch (err: any) {
    return {
      success: false,
      error: `Deploy failed: ${err.message}`,
      logs,
    };
  }
}

/**
 * Upgrade an existing program
 */
export async function upgradeProgram(
  programId: string,
  walletPath?: string,
  binaryPath: string = PROGRAM_BINARY_PATH
): Promise<DeployResult> {
  const logs: string[] = [];

  try {
    if (!isSolanaCliAvailable()) {
      return {
        success: false,
        error: 'Solana CLI not available',
        logs,
      };
    }

    // Check binary exists
    try {
      await fs.access(binaryPath);
    } catch {
      return {
        success: false,
        error: `Program binary not found at ${binaryPath}. Run build first.`,
        logs,
      };
    }

    logs.push(`Upgrading program: ${programId}`);
    logs.push(`Cluster: ${getSolanaCluster()}`);

    // Build upgrade command
    const args = ['program', 'deploy', binaryPath, '--program-id', programId];
    if (walletPath) {
      args.push('--keypair', walletPath);
    }

    return new Promise((resolve) => {
      const upgrade = spawn('solana', args, {
        shell: true,
      });

      upgrade.stdout.on('data', (data) => {
        const line = data.toString().trim();
        logs.push(line);
        logger.info('solana.upgrade.stdout', { cat: 'router', line });
      });

      upgrade.stderr.on('data', (data) => {
        const line = data.toString().trim();
        logs.push(line);
        logger.warn('solana.upgrade.stderr', { cat: 'router', line });
      });

      upgrade.on('close', (code) => {
        if (code === 0) {
          resolve({
            success: true,
            programId,
            logs,
          });
        } else {
          resolve({
            success: false,
            error: `Upgrade failed with exit code ${code}`,
            logs,
          });
        }
      });

      upgrade.on('error', (err) => {
        resolve({
          success: false,
          error: `Upgrade error: ${err.message}`,
          logs,
        });
      });
    });
  } catch (err: any) {
    return {
      success: false,
      error: `Upgrade failed: ${err.message}`,
      logs,
    };
  }
}

/**
 * Close a deployed program and recover rent
 * Requires: upgrade authority must be the wallet used
 */
export async function closeProgram(
  programId: string,
  walletPath?: string,
  recipient?: string
): Promise<CloseResult> {
  const logs: string[] = [];

  try {
    if (!isSolanaCliAvailable()) {
      return {
        success: false,
        error: 'Solana CLI not available',
        logs,
      };
    }

    logs.push(`Closing program: ${programId}`);
    logs.push(`Cluster: ${getSolanaCluster()}`);

    // Estimate rent to recover (best effort)
    let estimatedRent = 0;
    try {
      const { getConnection } = await import('../wallet/wallet.js');
      const connection = getConnection();
      const programPubkey = new PublicKey(programId);
      
      const accountInfo = await connection.getAccountInfo(programPubkey);
      if (accountInfo) {
        estimatedRent = accountInfo.lamports;
        
        // Try to get program data account rent too
        if (accountInfo.data.length >= 36) {
          try {
            const programDataAddress = new PublicKey(accountInfo.data.subarray(4, 36));
            const programDataInfo = await connection.getAccountInfo(programDataAddress);
            if (programDataInfo) {
              estimatedRent += programDataInfo.lamports;
            }
          } catch {
            // Ignore errors reading program data account
          }
        }
      }
      
      logs.push(`Estimated rent to recover: ${(estimatedRent / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
    } catch (e: any) {
      logs.push(`Could not estimate rent: ${e.message}`);
    }

    // Build close command
    // solana program close <PROGRAM_ID> [OPTIONS]
    const args = ['program', 'close', programId, '--bypass-warning'];
    
    if (walletPath) {
      args.push('--keypair', walletPath);
    }
    
    if (recipient) {
      args.push('--recipient', recipient);
    }

    return new Promise((resolve) => {
      const close = spawn('solana', args, {
        shell: true,
      });

      close.stdout.on('data', (data) => {
        const line = data.toString().trim();
        logs.push(line);
        logger.info('solana.close.stdout', { cat: 'router', line });
      });

      close.stderr.on('data', (data) => {
        const line = data.toString().trim();
        logs.push(line);
        // Check if this is an error or just info
        if (line.toLowerCase().includes('error') || line.toLowerCase().includes('failed')) {
          logger.error('solana.close.stderr', { cat: 'router', line });
        } else {
          logger.warn('solana.close.stderr', { cat: 'router', line });
        }
      });

      close.on('close', (code) => {
        if (code === 0) {
          logs.push('Program closed successfully');
          resolve({
            success: true,
            rentRecovered: estimatedRent,
            logs,
          });
        } else {
          resolve({
            success: false,
            error: `Close failed with exit code ${code}`,
            logs,
          });
        }
      });

      close.on('error', (err) => {
        resolve({
          success: false,
          error: `Close error: ${err.message}`,
          logs,
        });
      });
    });
  } catch (err: any) {
    return {
      success: false,
      error: `Close failed: ${err.message}`,
      logs,
    };
  }
}

/**
 * Get program deployment status
 */
export async function getProgramStatus(
  connection: Connection,
  programId: string
): Promise<ProgramStatus> {
  try {
    const pubkey = new PublicKey(programId);
    const accountInfo = await connection.getAccountInfo(pubkey);

    if (!accountInfo) {
      return {
        deployed: false,
        programId,
        dataSize: null,
        executable: false,
        upgradeAuthority: null,
        lastDeploySlot: null,
        cluster: getSolanaCluster(),
      };
    }

    // For BPF programs, get the program data account
    let upgradeAuthority: string | null = null;
    let lastDeploySlot: number | null = null;

    if (accountInfo.executable) {
      // Try to get upgrade authority from program data account
      try {
        // The program account data contains the address of the program data account
        if (accountInfo.data.length >= 36) {
          const programDataAddress = new PublicKey(accountInfo.data.subarray(4, 36));
          const programDataInfo = await connection.getAccountInfo(programDataAddress);
          
          if (programDataInfo && programDataInfo.data.length >= 45) {
            // First 8 bytes are slot, next 1 byte is option, then 32 bytes upgrade authority
            // Read slot as little-endian uint64
            const slotBytes = programDataInfo.data.subarray(0, 8);
            lastDeploySlot = Number(
              BigInt(slotBytes[0]) |
              (BigInt(slotBytes[1]) << 8n) |
              (BigInt(slotBytes[2]) << 16n) |
              (BigInt(slotBytes[3]) << 24n) |
              (BigInt(slotBytes[4]) << 32n) |
              (BigInt(slotBytes[5]) << 40n) |
              (BigInt(slotBytes[6]) << 48n) |
              (BigInt(slotBytes[7]) << 56n)
            );
            const hasUpgradeAuthority = programDataInfo.data[8] === 1;
            if (hasUpgradeAuthority) {
              upgradeAuthority = new PublicKey(programDataInfo.data.subarray(9, 41)).toBase58();
            }
          }
        }
      } catch {
        // Ignore errors reading upgrade authority
      }
    }

    return {
      deployed: true,
      programId,
      dataSize: accountInfo.data.length,
      executable: accountInfo.executable,
      upgradeAuthority,
      lastDeploySlot,
      cluster: getSolanaCluster(),
    };
  } catch (err: any) {
    logger.error('router.status.error', {
      cat: 'router',
      error: err.message,
      programId,
    });

    return {
      deployed: false,
      programId,
      dataSize: null,
      executable: false,
      upgradeAuthority: null,
      lastDeploySlot: null,
      cluster: getSolanaCluster(),
    };
  }
}

/**
 * Check wallet balance for deployment
 */
export async function checkDeploymentBalance(connection: Connection, walletPubkey: PublicKey): Promise<{
  balance: number;
  sufficient: boolean;
  requiredEstimate: number;
}> {
  const balance = await connection.getBalance(walletPubkey);
  const balanceSol = balance / LAMPORTS_PER_SOL;
  
  // Rough estimate: ~3 SOL for program deployment
  const requiredEstimate = 3;
  
  return {
    balance: balanceSol,
    sufficient: balanceSol >= requiredEstimate,
    requiredEstimate,
  };
}

/**
 * Request airdrop (devnet/testnet only)
 */
export async function requestAirdrop(
  connection: Connection,
  walletPubkey: PublicKey,
  amount: number = 2
): Promise<boolean> {
  try {
    const signature = await connection.requestAirdrop(
      walletPubkey,
      amount * LAMPORTS_PER_SOL
    );
    await connection.confirmTransaction(signature);
    
    logger.info('router.airdrop.success', {
      cat: 'router',
      wallet: walletPubkey.toBase58(),
      amount,
      signature,
    });
    
    return true;
  } catch (err: any) {
    logger.error('router.airdrop.failed', {
      cat: 'router',
      error: err.message,
    });
    return false;
  }
}


