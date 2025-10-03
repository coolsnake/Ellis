import { PublicKey, Keypair } from '@solana/web3.js';

export async function resolveAtaForSpotMarketIndex(
  client: any,
  walletKp: Keypair,
  spotMarketIndex: number,
  cluster: string
): Promise<PublicKey> {
  // Try SDK helper first
  try {
    if (typeof client?.getAssociatedTokenAccount === 'function') {
      const ata = await client.getAssociatedTokenAccount(Number(spotMarketIndex));
      if (ata) return ata as PublicKey;
    }
  } catch {}
  // Derive from SDK constants
  try {
    const sdk: any = await import('@drift-labs/sdk');
    const constants: any = (sdk as any).constants || (sdk as any);
    const byCluster = (obj: any) => obj?.[cluster] || obj?.[cluster?.replace?.('-', '_')];
    const list = byCluster(constants?.SPOT_MARKETS) || byCluster(constants?.SpotMarkets) || constants?.SPOT_MARKETS || constants?.SpotMarkets || [];
    const found = Array.isArray(list) ? list.find((m: any) => Number(m?.marketIndex ?? m?.index ?? m?.market_index) === Number(spotMarketIndex)) : null;
    const mintStr = String(found?.mint || found?.mintAddress || found?.address || '');
    if (mintStr) {
      const { getOrCreateTokenAccount } = await import('../wallet/wallet.js');
      const mintPk = new PublicKey(mintStr);
      const ataRes = await getOrCreateTokenAccount(mintPk, walletKp.publicKey, walletKp);
      return ataRes.address as PublicKey;
    }
  } catch {}
  // Fallback: send to wallet's SOL address (program may redirect)
  return walletKp.publicKey;
}


