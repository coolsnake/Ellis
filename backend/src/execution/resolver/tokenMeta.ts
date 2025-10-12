import { executionCache } from '../cache.js';
import { Connection, PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getMint } from '@solana/spl-token';
import { CONFIG } from '../../utils/config.js';
import { loadJupiterTokenMap } from '../../utils/tokens.js';

export async function getTokenMeta(mintStr: string): Promise<{ decimals: number; program: 'spl-token'|'token-2022' }> {
  const cached = executionCache.getTokenMeta(mintStr);
  if (cached) return cached;
  const conn = new Connection(CONFIG.rpcUrl, 'confirmed');
  const mint = new PublicKey(mintStr);
  let program: 'spl-token'|'token-2022' = 'spl-token';
  let decimals: number | undefined;
  try {
    const [acc, jmap] = await Promise.all([
      conn.getAccountInfo(mint).catch(() => null),
      loadJupiterTokenMap().catch(() => ({} as any)),
    ]);
    const owner = acc?.owner?.toBase58?.();
    if (owner === TOKEN_2022_PROGRAM_ID.toBase58()) program = 'token-2022';
    const j = Number((jmap as any)?.[mintStr]?.decimals);
    if (Number.isFinite(j)) decimals = j;
  } catch {}
  if (!Number.isFinite(decimals as any)) {
    try { decimals = Number((await getMint(conn, mint)).decimals); } catch {}
  }
  const meta = { decimals: Math.min(12, Math.max(0, Number(decimals ?? 9))), program };
  executionCache.setTokenMeta(mintStr, meta);
  return meta;
}


