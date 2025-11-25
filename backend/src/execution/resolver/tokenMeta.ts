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
  try {
    const [acc, jmap] = await Promise.all([
      mint ? withRpcLimit(() => conn.getAccountInfo(mint)).catch(() => null) : Promise.resolve(null),
      loadJupiterTokenMap().catch(() => ({} as any)),
    ]);
    const owner = acc?.owner?.toBase58?.();
    if (owner === TOKEN_2022_PROGRAM_ID.toBase58()) program = 'token-2022';
    const j = Number((jmap as any)?.[mintStr]?.decimals);
    if (Number.isFinite(j)) decimals = j;
  } catch (e) { logCatchError('resolver.tokenMeta', e); }
  if (!Number.isFinite(decimals as any) && mint) {
    try { decimals = Number((await getMint(conn, mint)).decimals); } catch (e) { logCatchError('resolver.tokenMeta', e); }
  }
  if (!Number.isFinite(decimals as any)) decimals = 9;
  const meta = { decimals: Math.min(12, Math.max(0, Number(decimals ?? 9))), program };
  executionCache.setTokenMeta(mintStr, meta);
  return meta;
}


