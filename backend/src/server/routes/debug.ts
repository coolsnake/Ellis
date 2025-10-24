import { Router } from 'express';
import type { Server as SocketIOServer } from 'socket.io';
import { CONFIG } from '../../utils/config.js';

export function createDebugRouter(_io: SocketIOServer): Router {
  const api = Router();

  api.get('/debug/pool/:id', async (req, res) => {
    try {
      const id = String(req.params.id || '');
      if (!id) return res.status(400).json({ error: 'id required' });
      const { Connection, PublicKey, Keypair } = await import('@solana/web3.js');
      const conn = new Connection(CONFIG.rpcUrl, { commitment: 'confirmed', disableRetryOnRateLimit: true } as any);
      const pk = new PublicKey(id);
      const { withRpcLimit } = await import('../../utils/rpcLimiter.js');
      const info = await withRpcLimit(() => conn.getAccountInfo(pk, { commitment: 'confirmed' } as any));
      const onchain: any = {};
      try {
        if (info?.data && info.data.length >= 72) {
          const buf = Buffer.from(info.data);
          const hexA = buf.subarray(8, 40).toString('hex');
          const hexB = buf.subarray(40, 72).toString('hex');
          try { onchain.mintA = new PublicKey(Buffer.from(hexA, 'hex')).toBase58(); } catch {}
          try { onchain.mintB = new PublicKey(Buffer.from(hexB, 'hex')).toBase58(); } catch {}
        }
      } catch {}
      let sdk: any = {};
      try {
        const sdkMod = await import('@raydium-io/raydium-sdk-v2').catch(() => null);
        if (sdkMod && (sdkMod as any).Raydium) {
          const { Raydium } = sdkMod as any;
          const owner = Keypair.generate();
          const raydium = await Raydium.load({ connection: conn, owner, disableLoadToken: true });
          const r = await (raydium as any).api.fetchPoolById({ ids: id }).catch(() => null);
          const it = Array.isArray(r?.data) ? r.data[0] : (Array.isArray(r) ? r[0] : null);
          const toB58 = (v: any) => (v?.toBase58?.() || v?.toString?.()?.replace(/^PublicKey\(([^)]+)\)$/, '$1') || (typeof v === 'string' ? v : ''));
          if (it) sdk = { mintA: toB58(it?.mintA?.address || it?.mintA || it?.tokenMintA), mintB: toB58(it?.mintB?.address || it?.mintB || it?.tokenMintB), programId: String(it?.programId || it?.programID || '') };
        }
      } catch {}
      const { getRaydiumPoolsNormalized } = await import('../pools.js');
      const pools = await getRaydiumPoolsNormalized(false);
      const norm = { amm: pools.amm.find(p => p.id === id), clmm: pools.clmm.find(p => p.id === id) };
      res.json({ id, onchain, sdk, norm });
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  return api;
}


