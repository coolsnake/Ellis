import { executionCache } from '../cache.js';
import { Connection, PublicKey } from '@solana/web3.js';
import { withRpcLimit } from '../../utils/rpcLimiter.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getMint } from '@solana/spl-token';
import { CONFIG } from '../../utils/config.js';
import { loadJupiterTokenMap } from '../../utils/tokens.js';
import { logCatchError } from '../../utils/errorHandler.js';

export async function getTokenMeta(mintStr: string): Promise<{ decimals: number; program: 'spl-token'|'token-2022' }> {
  const cached = executionCache.getTokenMeta(mintStr);
  if (cached) return cached;
  const conn = new Connection(CONFIG.rpcUrl, { commitment: 'confirmed', disableRetryOnRateLimit: true } as any);
  let mint: PublicKey | null = null;
  try { mint = new PublicKey(mintStr); } catch (e) { logCatchError('resolver.tokenMeta', e); }
  let program: 'spl-token'|'token-2022' = 'spl-token';
  let decimals: number | undefined;
  let rpcSucceeded = false;  // Track if we got valid RPC response
  
  try {
    const [acc, jmap] = await Promise.all([
      mint ? withRpcLimit(() => conn.getAccountInfo(mint)).catch((e) => {
        // Log RPC failure for debugging
        try {
          const { logger } = require('../../utils/logger.js');
          logger.warn('tokenMeta.rpc.failed', {
            cat: 'tx',
            mint: mintStr.slice(0, 8) + '...',
            error: String(e?.message || e).slice(0, 100),
          });
        } catch (_) {}
        return null;
      }) : Promise.resolve(null),
      loadJupiterTokenMap().catch(() => ({} as any)),
    ]);
    
    const owner = acc?.owner?.toBase58?.();
    if (owner) {
      // We got a valid account - mark RPC as successful
      rpcSucceeded = true;
      if (owner === TOKEN_2022_PROGRAM_ID.toBase58()) {
        program = 'token-2022';
      } else if (owner === TOKEN_PROGRAM_ID.toBase58()) {
        program = 'spl-token';
      }
    }
    
    const j = Number((jmap as any)?.[mintStr]?.decimals);
    if (Number.isFinite(j)) decimals = j;
  } catch (e) { logCatchError('resolver.tokenMeta', e); }
  
  if (!Number.isFinite(decimals as any) && mint) {
    try { 
      // getMint can also tell us the program type via commitment
      const mintInfo = await getMint(conn, mint, 'confirmed', TOKEN_2022_PROGRAM_ID).catch(() => null);
      if (mintInfo) {
        decimals = Number(mintInfo.decimals);
        program = 'token-2022';
        rpcSucceeded = true;
      } else {
        // Try standard token program
        const mintInfoStd = await getMint(conn, mint, 'confirmed', TOKEN_PROGRAM_ID).catch(() => null);
        if (mintInfoStd) {
          decimals = Number(mintInfoStd.decimals);
          program = 'spl-token';
          rpcSucceeded = true;
        }
      }
    } catch (e) { logCatchError('resolver.tokenMeta', e); }
  }
  
  if (!Number.isFinite(decimals as any)) decimals = 9;
  const meta = { decimals: Math.min(12, Math.max(0, Number(decimals ?? 9))), program };
  
  // CRITICAL: Only cache if RPC succeeded, otherwise we might cache incorrect program type
  // A temporary RPC failure shouldn't permanently mark a Token-2022 mint as spl-token
  if (rpcSucceeded) {
    executionCache.setTokenMeta(mintStr, meta);
  }
  
  return meta;
}


