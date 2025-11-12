import { Router } from 'express';
import type { Server as SocketIOServer } from 'socket.io';
import { CONFIG } from '../../utils/config.js';
import { ensureWallet, getBalances, generateAndSaveWallet, signAndSendSerializedTransaction } from '../../wallet/wallet.js';
import { readJson, writeJson } from '../../utils/fs.js';
import { searchTokens } from '../../jupiter/tokenApi.js';
import { emit } from '../realtime.js';
import { addWalletHistory } from '../walletHistory.js';
import { logger } from '../../utils/logger.js';

export function createWalletRouter(io: SocketIOServer): Router {
  const api = Router();

  api.get('/wallet', async (_req, res) => {
    try {
      const kp = await ensureWallet(CONFIG.walletPath);
      const balances = await getBalances(kp.publicKey);
      const list = await readJson<any[]>(CONFIG.walletTokensPath, []);
      const aliases: Record<string, string> = {};
      for (const item of list) {
        if (item?.id && item?.symbol) aliases[item.id] = item.symbol;
      }
      const mints = Object.keys(balances.tokens || {});
      let updated = false;
      for (const mint of mints) {
        if (!aliases[mint]) {
          try {
            const results = await searchTokens(mint, true);
            const first = results[0];
            if (first?.id === mint && first?.symbol) {
              aliases[mint] = first.symbol;
              if (!list.find((t) => t.id === mint)) {
                list.push(first);
                updated = true;
              }
            }
          } catch {}
        }
      }
      if (updated) await writeJson(CONFIG.walletTokensPath, list);
      res.json({ address: kp.publicKey.toBase58(), balances, aliases });
      io.emit('wallet-update', { address: kp.publicKey.toBase58(), balances, aliases });
    } catch (e: any) {
      const msg = String(e?.message || e);
      if (msg === 'WALLET_NOT_FOUND') {
        return res.status(404).json({ error: 'Wallet not found. Generate one via /api/wallet/generate or terminal: wallet generate' });
      }
      logger.error('wallet: fetch failed', { error: msg, cat: 'wallet' });
      res.status(500).json({ error: msg });
    }
  });

  api.post('/wallet/generate', async (_req, res) => {
    try {
      const kp = await generateAndSaveWallet(CONFIG.walletPath);
      res.json({ address: kp.publicKey.toBase58() });
      io.emit('wallet-update', { address: kp.publicKey.toBase58() });
    } catch (e: any) {
      logger.error('wallet: generate failed', { error: String(e), cat: 'wallet' });
      res.status(500).json({ error: String(e) });
    }
  });

  api.post('/wallet/send', async (req, res) => {
    try {
      const { token, destination, amount } = req.body as { token: string; destination: string; amount: number };
      const kp = await ensureWallet(CONFIG.walletPath);
      if (!token || token.toUpperCase() === 'SOL') {
        const { LAMPORTS_PER_SOL, SystemProgram, Transaction, PublicKey, ComputeBudgetProgram } = await import('@solana/web3.js');
        const { getConnection } = await import('../../wallet/wallet.js');
        const connection = getConnection();
        const tx = new Transaction().add(
          SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: new PublicKey(destination), lamports: Math.round(amount * LAMPORTS_PER_SOL) })
        );
        try {
          const { getFeeCalculator } = await import('../../utils/feeCalculator.js');
          const feeCalculator = getFeeCalculator(connection);
          const recommendation = feeCalculator.getFeeRecommendation('send');
          const calculatedFees = await feeCalculator.calculateFees({ ...CONFIG.fees, ...recommendation });
          tx.add(
            ComputeBudgetProgram.setComputeUnitLimit({ units: 200000 }),
            ComputeBudgetProgram.setComputeUnitPrice({ microLamports: calculatedFees.priorityFee })
          );
        } catch {}
        const { withRpcLimit } = await import('../../utils/rpcLimiter.js');
        const sig = await withRpcLimit(
          () => connection.sendTransaction(tx, [kp], { skipPreflight: true }),
          1,
          { module: 'wallet', method: 'sendTransaction' }
        );
        await withRpcLimit(
          () => connection.confirmTransaction(sig, 'confirmed'),
          1,
          { module: 'wallet', method: 'confirmTransaction' }
        );
        res.json({ signature: sig });
        try { addWalletHistory({ type: 'send', time: new Date().toISOString(), token: 'SOL', amount, destination, signature: sig }); } catch {}
        emit('log', { level: 'info', message: `terminal: send SOL ${amount} to ${destination} -> ${sig}`, timestamp: new Date().toISOString() });
      } else {
        const { PublicKey } = await import('@solana/web3.js');
        const { sendSplToken } = await import('../../wallet/wallet.js');
        const tokensMod: any = await import('../../utils/tokens.js');
        const tokenMap = await tokensMod.loadTokenMap();
        const mintResolved = token.length > 30 ? token : (tokenMap[token.toUpperCase()]?.mint || token);
        const sig = await sendSplToken({ from: kp, destination: new PublicKey(destination), mint: new PublicKey(mintResolved), amount });
        res.json({ signature: sig });
        try { addWalletHistory({ type: 'send', time: new Date().toISOString(), token, amount, destination, signature: sig }); } catch {}
        emit('log', { level: 'info', message: `terminal: send SPL ${token} ${amount} to ${destination} -> ${sig}`, timestamp: new Date().toISOString() });
      }
    } catch (e: any) {
      const msg = String(e?.message || e);
      if (msg === 'WALLET_NOT_FOUND') {
        return res.status(404).json({ error: 'Wallet not found. Generate one via /api/wallet/generate or terminal: wallet generate' });
      }
      logger.error('wallet: send failed', { error: msg, cat: 'wallet' });
      res.status(500).json({ error: msg });
      emit('log', { level: 'error', message: `terminal: send failed ${msg}` , timestamp: new Date().toISOString() });
    }
  });

  api.post('/wallet/refresh', async (_req, res) => {
    try {
      const kp = await ensureWallet(CONFIG.walletPath);
      const balances = await getBalances(kp.publicKey, { force: true });
      const list = await readJson<any[]>(CONFIG.walletTokensPath, []);
      const aliases: Record<string, string> = {};
      for (const item of list) {
        if (item?.id && item?.symbol) aliases[item.id] = item.symbol;
      }
      const mints = Object.keys(balances.tokens || {});
      let updated = false;
      for (const mint of mints) {
        if (!aliases[mint]) {
          try {
            const results = await (await import('../../jupiter/tokenApi.js')).searchTokens(mint, true);
            const first: any = results[0];
            if (first?.id === mint && first?.symbol) {
              aliases[mint] = first.symbol;
              if (!list.find((t) => t.id === mint)) {
                list.push(first);
                updated = true;
              }
            }
          } catch {}
        }
      }
      if (updated) await writeJson(CONFIG.walletTokensPath, list);
      res.json({ address: kp.publicKey.toBase58(), balances, aliases });
      io.emit('wallet-update', { address: kp.publicKey.toBase58(), balances, aliases });
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  api.get('/wallet/tokens', async (_req, res) => {
    const list = await readJson<any[]>(CONFIG.walletTokensPath, []);
    res.json({ list });
  });

  api.get('/wallet/token-accounts', async (_req, res) => {
    try {
        const { getConnection } = await import('../../wallet/wallet.js');
        const { getTokenAccountManager } = await import('../../wallet/tokenAccountManager.js');
        const manager = getTokenAccountManager(getConnection());
        const list = manager.getTokenAccounts();
        res.json({ list });
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  api.delete('/wallet/token-accounts/:address', async (req, res) => {
    try {
      const { address } = req.params as { address: string };
      const { getConnection } = await import('../../wallet/wallet.js');
      const { getTokenAccountManager } = await import('../../wallet/tokenAccountManager.js');
      const { PublicKey } = await import('@solana/web3.js');
      const manager = getTokenAccountManager(getConnection());
      const ok = await manager.closeTokenAccount(new PublicKey(address), (await ensureWallet(CONFIG.walletPath)).publicKey);
      res.json({ ok });
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  api.post('/wallet/token-accounts/cleanup', async (req, res) => {
    try {
      const { dryRun } = (req.body || {}) as { dryRun?: boolean };
      const { getConnection } = await import('../../wallet/wallet.js');
      const { getTokenAccountManager } = await import('../../wallet/tokenAccountManager.js');
      const manager = getTokenAccountManager(getConnection());
      await manager.cleanupUnusedAccounts();
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  api.post('/wallet/tokens', async (req, res) => {
    const { query } = req.body as { query: string };
    try {
      const results = await searchTokens(query, true);
      res.json(results);
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  api.post('/wallet/wrap', async (req, res) => {
    try {
      const { amount } = req.body as { amount: number };
      if (!amount || amount <= 0) return res.status(400).json({ error: 'amount > 0 required' });
      const { wrapSol } = await import('../../wallet/wallet.js');
      const sig = await wrapSol(Number(amount));
      emit('log', { level: 'info', message: `terminal: wrap SOL success ${amount} sig=${sig}`, timestamp: new Date().toLocaleTimeString() });
      res.json({ signature: sig });
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  api.post('/wallet/unwrap', async (_req, res) => {
    try {
      const { unwrapSol } = await import('../../wallet/wallet.js');
      const sig = await unwrapSol();
      emit('log', { level: 'info', message: `terminal: unwrap SOL success sig=${sig}`, timestamp: new Date().toLocaleTimeString() });
      res.json({ signature: sig });
    } catch (e: any) {
      const errMsg = String(e?.message || e);
      logger.error('wallet: unwrap failed', { error: errMsg, cat: 'wallet' });
      emit('log', { level: 'error', message: `terminal: unwrap SOL failed: ${errMsg}`, timestamp: new Date().toLocaleTimeString() });
      res.status(400).json({ error: errMsg });
    }
  });

  return api;
}


