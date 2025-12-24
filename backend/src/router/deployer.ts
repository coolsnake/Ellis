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

/**
 * Get environment variables for spawn calls
 * Ensures HOME is set (required by cargo_build_sbf and other tools)
 */
function getSpawnEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // Ensure HOME is set (required by cargo_build_sbf and other tools)
  if (!env.HOME) {
    // Try common locations
    if (process.env.USERPROFILE) {
      // Windows
      env.HOME = process.env.USERPROFILE;
    } else if (process.getuid && process.getuid() === 0) {
      // Running as root
      env.HOME = '/root';
    } else if (process.getuid) {
      // Try to get user home from /etc/passwd or use /tmp
      env.HOME = `/home/${process.env.USER || 'user'}`;
    } else {
      // Fallback
      env.HOME = '/tmp';
    }
  }
  return env;
}

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
      const env = getSpawnEnv();
      
      // Ensure PATH includes Solana platform tools
      const solanaBinPath = `${process.env.HOME || process.env.USERPROFILE || '/tmp'}/.local/share/solana/install/active_release/bin`;
      const existingPath = env.PATH || process.env.PATH || '';
      if (!existingPath.includes(solanaBinPath)) {
        env.PATH = `${solanaBinPath}:${existingPath}`;
      }
      
      // Set SOLANA_PLATFORM_TOOLS_DIR to prevent Anchor from downloading its own
      const platformToolsDir = `${process.env.HOME || process.env.USERPROFILE || '/tmp'}/.local/share/solana/install/active_release/platform-tools`;
      env.SOLANA_PLATFORM_TOOLS_DIR = platformToolsDir;
      
      // Also set Anchor's cache directory to point to our installation
      const anchorCacheDir = `${process.env.HOME || process.env.USERPROFILE || '/tmp'}/.cache/solana/platform-tools`;
      env.ANCHOR_PLATFORM_TOOLS_DIR = anchorCacheDir;
      
      const build = spawn('anchor', ['build'], {
        cwd: ARB_ROUTER_DIR,
        shell: true,
        env,
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
 * Update the program ID in source files (lib.rs and Anchor.toml)
 * This is necessary when generating a new program keypair after closing a program
 */
export async function updateProgramIdInSource(newProgramId: string): Promise<{ success: boolean; error?: string }> {
  try {
    const libRsPath = path.join(ARB_ROUTER_DIR, 'programs', 'arb-router', 'src', 'lib.rs');
    const anchorTomlPath = path.join(ARB_ROUTER_DIR, 'Anchor.toml');

    // Update lib.rs - replace declare_id! macro
    let libRsContent = await fs.readFile(libRsPath, 'utf-8');
    const declareIdRegex = /declare_id!\s*\(\s*"[A-Za-z0-9]{32,44}"\s*\)/;
    
    if (!declareIdRegex.test(libRsContent)) {
      return { success: false, error: 'Could not find declare_id! in lib.rs' };
    }
    
    libRsContent = libRsContent.replace(declareIdRegex, `declare_id!("${newProgramId}")`);
    await fs.writeFile(libRsPath, libRsContent, 'utf-8');
    
    logger.info('router.source.updated', { cat: 'router', file: 'lib.rs', programId: newProgramId });

    // Update Anchor.toml - replace all arb_router program IDs
    let anchorTomlContent = await fs.readFile(anchorTomlPath, 'utf-8');
    const programIdRegex = /arb_router\s*=\s*"[A-Za-z0-9]{32,44}"/g;
    
    anchorTomlContent = anchorTomlContent.replace(programIdRegex, `arb_router = "${newProgramId}"`);
    await fs.writeFile(anchorTomlPath, anchorTomlContent, 'utf-8');
    
    logger.info('router.source.updated', { cat: 'router', file: 'Anchor.toml', programId: newProgramId });

    return { success: true };
  } catch (err: any) {
    logger.error('router.source.update_failed', { cat: 'router', error: err.message });
    return { success: false, error: `Failed to update source files: ${err.message}` };
  }
}

/**
 * Check if a program ID has been closed (account doesn't exist or is not executable)
 */
export async function isProgramClosed(
  connection: Connection,
  programId: string
): Promise<boolean> {
  try {
    const pubkey = new PublicKey(programId);
    const accountInfo = await connection.getAccountInfo(pubkey);
    
    // If account doesn't exist or isn't executable, it's been closed
    if (!accountInfo) {
      return true;
    }
    
    // Also check if it's the BPF Upgradeable Loader - if not, it may have been closed
    const BPF_LOADER_UPGRADEABLE = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
    if (!accountInfo.owner.equals(BPF_LOADER_UPGRADEABLE)) {
      return true;
    }
    
    return false;
  } catch {
    return true;
  }
}

/**
 * Options for deployProgram
 */
export interface DeployOptions {
  walletPath?: string;
  binaryPath?: string;
  keypairPath?: string;
  /** Force generation of a new program ID (use after closing a program) */
  forceNewProgramId?: boolean;
  /** Connection for checking program status */
  connection?: Connection;
}

/**
 * Deploy the program to the configured cluster
 * 
 * @param options - Deployment options
 * @param options.forceNewProgramId - If true, generates a new keypair, updates source files, and rebuilds
 */
export async function deployProgram(options: DeployOptions = {}): Promise<DeployResult> {
  const {
    walletPath,
    binaryPath = PROGRAM_BINARY_PATH,
    keypairPath = KEYPAIR_PATH,
    forceNewProgramId = false,
    connection,
  } = options;
  
  const logs: string[] = [];

  try {
    if (!isSolanaCliAvailable()) {
      return {
        success: false,
        error: 'Solana CLI not available',
        logs,
      };
    }

    // Handle force new program ID scenario (after closing a program)
    if (forceNewProgramId) {
      logs.push('Force new program ID requested...');
      
      // Generate new keypair (overwrites existing)
      logs.push('Generating new program keypair...');
      const newKeypair = await generateProgramKeypair();
      if (!newKeypair) {
        return {
          success: false,
          error: 'Failed to generate new program keypair',
          logs,
        };
      }
      
      const newProgramId = newKeypair.keypair.publicKey.toBase58();
      logs.push(`New program ID: ${newProgramId}`);
      
      // Update source files with new program ID
      logs.push('Updating source files with new program ID...');
      const updateResult = await updateProgramIdInSource(newProgramId);
      if (!updateResult.success) {
        return {
          success: false,
          error: updateResult.error || 'Failed to update source files',
          logs,
        };
      }
      logs.push('Source files updated successfully');
      
      // Rebuild the program with new program ID
      logs.push('Rebuilding program with new program ID...');
      const buildResult = await buildProgram();
      if (!buildResult.success) {
        return {
          success: false,
          error: `Rebuild failed: ${buildResult.error}`,
          logs: [...logs, ...(buildResult.logs || [])],
        };
      }
      logs.push('Program rebuilt successfully');
    } else {
      // Check if existing keypair's program was closed
      let keypairExists = false;
      try {
        await fs.access(keypairPath);
        keypairExists = true;
      } catch {
        keypairExists = false;
      }
      
      if (keypairExists && connection) {
        const existingKeypair = await loadProgramKeypair();
        if (existingKeypair) {
          const closed = await isProgramClosed(connection, existingKeypair.publicKey.toBase58());
          if (closed) {
            // Check if there's still an account (closed programs have specific state)
            const accountInfo = await connection.getAccountInfo(existingKeypair.publicKey);
            if (accountInfo === null) {
              // Program was closed - need new keypair
              logs.push('Existing program ID was closed. Use forceNewProgramId: true to generate a new one.');
              return {
                success: false,
                error: 'Program ID was closed and cannot be reused. Set forceNewProgramId: true to generate a new program ID.',
                logs,
              };
            }
          }
        }
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
      if (!keypairExists) {
        logs.push('Generating new program keypair...');
        const result = await generateProgramKeypair();
        if (!result) {
          return {
            success: false,
            error: 'Failed to generate program keypair',
            logs,
          };
        }
        
        // For new keypairs, also update source files and rebuild
        const newProgramId = result.keypair.publicKey.toBase58();
        logs.push(`New program ID: ${newProgramId}`);
        
        logs.push('Updating source files with new program ID...');
        const updateResult = await updateProgramIdInSource(newProgramId);
        if (!updateResult.success) {
          logs.push(`Warning: Could not update source files: ${updateResult.error}`);
          // Continue anyway - source might already match or user can fix manually
        }
        
        logs.push('Rebuilding program...');
        const buildResult = await buildProgram();
        if (!buildResult.success) {
          return {
            success: false,
            error: `Build failed: ${buildResult.error}`,
            logs: [...logs, ...(buildResult.logs || [])],
          };
        }
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
        env: getSpawnEnv(),
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
        env: getSpawnEnv(),
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
        env: getSpawnEnv(),
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
    logger.debug('router.status.fetching', {
      cat: 'router',
      programId,
      cluster: getSolanaCluster(),
      rpcUrl: connection.rpcEndpoint,
    });
    
    const accountInfo = await connection.getAccountInfo(pubkey, 'confirmed');

    if (!accountInfo) {
      logger.warn('router.status.not_found', {
        cat: 'router',
        programId,
        cluster: getSolanaCluster(),
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
    
    logger.debug('router.status.found', {
      cat: 'router',
      programId,
      executable: accountInfo.executable,
      dataLength: accountInfo.data.length,
      lamports: accountInfo.lamports,
    });

    // For BPF programs, get the program data account
    let upgradeAuthority: string | null = null;
    let lastDeploySlot: number | null = null;

    if (accountInfo.executable) {
      // Try to get upgrade authority from program data account
      try {
        // The program account data contains the address of the program data account
        // For BPF Upgradeable Loader, first 4 bytes are discriminator, next 32 bytes are program data address
        if (accountInfo.data.length >= 36) {
          const programDataAddress = new PublicKey(accountInfo.data.subarray(4, 36));
          
          logger.debug('router.status.program_data_fetch', {
            cat: 'router',
            programDataAddress: programDataAddress.toBase58(),
            programId,
          });
          
          const programDataInfo = await connection.getAccountInfo(programDataAddress, 'confirmed');
          
          if (programDataInfo) {
            logger.debug('router.status.program_data_info', {
              cat: 'router',
              dataLength: programDataInfo.data.length,
              programDataAddress: programDataAddress.toBase58(),
            });
            
            // Program data account structure for BPF Upgradeable Loader (bincode serialized):
            // Bytes 0-3: enum variant discriminator (3 = ProgramData, u32 little-endian)
            // Bytes 4-11: slot (u64, little-endian)
            // Byte 12: upgrade authority option (0 = None, 1 = Some)
            // Bytes 13-44: upgrade authority Pubkey (32 bytes) if option is Some
            // Minimum length should be at least 13 bytes (discriminator + slot + option)
            // 45 bytes if upgrade authority exists
            const DISCRIMINATOR_SIZE = 4;
            const SLOT_SIZE = 8;
            const OPTION_SIZE = 1;
            const PUBKEY_SIZE = 32;
            const MIN_LENGTH = DISCRIMINATOR_SIZE + SLOT_SIZE + OPTION_SIZE; // 13 bytes
            const LENGTH_WITH_AUTHORITY = MIN_LENGTH + PUBKEY_SIZE; // 45 bytes
            
            if (programDataInfo.data.length >= MIN_LENGTH) {
              // Verify the discriminator is 3 (ProgramData)
              // Read as little-endian u32
              const discriminator = 
                programDataInfo.data[0] |
                (programDataInfo.data[1] << 8) |
                (programDataInfo.data[2] << 16) |
                (programDataInfo.data[3] << 24);
              
              logger.debug('router.status.program_data_discriminator', {
                cat: 'router',
                discriminator,
                expected: 3,
              });
              
              if (discriminator === 3) {
                // Read slot as little-endian uint64 (bytes 4-11)
                const slotBytes = programDataInfo.data.subarray(DISCRIMINATOR_SIZE, DISCRIMINATOR_SIZE + SLOT_SIZE);
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
                
                // Read upgrade authority option (byte 12)
                const optionOffset = DISCRIMINATOR_SIZE + SLOT_SIZE;
                const hasUpgradeAuthority = programDataInfo.data[optionOffset] === 1;
                
                logger.debug('router.status.upgrade_auth_check', {
                  cat: 'router',
                  hasUpgradeAuthority,
                  dataLength: programDataInfo.data.length,
                  optionByte: programDataInfo.data[optionOffset],
                  optionOffset,
                });
                
                if (hasUpgradeAuthority && programDataInfo.data.length >= LENGTH_WITH_AUTHORITY) {
                  // Read upgrade authority pubkey (bytes 13-44)
                  const authorityOffset = optionOffset + OPTION_SIZE;
                  upgradeAuthority = new PublicKey(
                    programDataInfo.data.subarray(authorityOffset, authorityOffset + PUBKEY_SIZE)
                  ).toBase58();
                  
                  logger.debug('router.status.upgrade_auth_found', {
                    cat: 'router',
                    upgradeAuthority,
                    authorityOffset,
                  });
                } else if (!hasUpgradeAuthority) {
                  logger.debug('router.status.no_upgrade_auth', {
                    cat: 'router',
                    optionByte: programDataInfo.data[optionOffset],
                    message: 'Program is immutable (no upgrade authority)',
                  });
                }
              } else {
                logger.warn('router.status.unexpected_discriminator', {
                  cat: 'router',
                  discriminator,
                  expected: 3,
                  message: 'Expected ProgramData discriminator (3)',
                });
              }
            } else {
              logger.warn('router.status.invalid_program_data_length', {
                cat: 'router',
                dataLength: programDataInfo.data.length,
                expectedMin: MIN_LENGTH,
              });
            }
          } else {
            logger.warn('router.status.program_data_not_found', {
              cat: 'router',
              programDataAddress: programDataAddress.toBase58(),
            });
          }
        } else {
          logger.warn('router.status.program_account_too_small', {
            cat: 'router',
            dataLength: accountInfo.data.length,
            expectedMin: 36,
          });
        }
      } catch (err: any) {
        // Log the error instead of silently ignoring it
        logger.error('router.status.upgrade_auth_error', {
          cat: 'router',
          error: err.message,
          stack: err.stack,
          programId,
        });
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


