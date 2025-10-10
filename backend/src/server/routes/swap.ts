import { Router } from 'express';
import type { Server as SocketIOServer } from 'socket.io';
import { emit } from '../realtime.js';
import { executeSwap } from '../../jupiter/jupiter.js';
import { resolveMint } from '../../utils/tokens.js';
import { signAndSendSerializedTransaction, ensureWallet } from '../../wallet/wallet.js';
import { addWalletHistory } from '../walletHistory.js';

export function createSwapRouter(io: SocketIOServer): Router {
  const api = Router();

  // High-level swap endpoint
  api.post('/swap', async (req, res) => {
    let swapKey: string | undefined;
    try {
      const { from, to, amount } = req.body as { from: string; to: string; amount: number };
      if (!from || !to || !amount || amount <= 0) return res.status(400).json({ error: 'from, to, amount>0 required' });
      const { CONFIG } = await import('../../utils/config.js');
      const kp = await ensureWallet(CONFIG.walletPath);
      swapKey = `${from}->${to}`;
      const fromInfo = await resolveMint(from);
      const toInfo = await resolveMint(to);
      const raw = Math.round(Number(amount) * Math.pow(10, fromInfo.decimals));
      const result: any = await executeSwap(
        { inputMint: fromInfo.mint, outputMint: toInfo.mint, amount: raw, userPublicKey: kp.publicKey.toBase58(), slippageBps: 100 },
        (serialized) => signAndSendSerializedTransaction(serialized, kp, undefined, 'swap'),
        true,
        toInfo.decimals
      );
      const sig = (result as any)?.signature || (typeof result === 'string' ? result : undefined);
      res.json({ signature: sig });
      try { addWalletHistory({ type: 'swap', time: new Date().toISOString(), fromToken: from, fromAmount: amount, toToken: to, toAmount: undefined, signature: sig }); } catch {}
      emit('log', { level: 'info', message: `terminal: swap success ${amount} ${from}->${to} sig=${sig}`, timestamp: new Date().toISOString() });
    } catch (e: any) {
      const msg = String(e?.message || e);
      emit('log', { level: 'error', message: `Swap failed: ${msg}`, timestamp: new Date().toISOString() });
      res.status(500).json({ error: msg });
    }
  });

  return api;
}


