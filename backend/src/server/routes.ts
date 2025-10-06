// @ts-nocheck
import type { Express, Request, Response, NextFunction } from 'express';
import { Router } from 'express';
import type { Server as SocketIOServer } from 'socket.io';
import { logger, setLogLevel, setLoggingEnabled, setFileLogging } from '../utils/logger.js';
import { CONFIG } from '../utils/config.js';
import { ensureWallet, getBalances, getPublicKey, generateAndSaveWallet, signAndSendSerializedTransaction, getConnection } from '../wallet/wallet.js';
import { getPriceByMint } from './priceStore.js';
import { readJson, writeJson } from '../utils/fs.js';
import { searchTokens } from '../jupiter/tokenApi.js';
import { tradingController } from './tradingController.js';
import { systemStatus } from './status.js';
import { emit } from './realtime.js';
import { getStrategies, upsertStrategy, removeStrategy, migrateSingleStrategy, STRATEGY_LIST_PATH } from '../utils/strategies.js';
import { resolveMint } from '../utils/tokens.js';
import { executeSwap } from '../jupiter/jupiter.js';
import { enablePriceFeed, setPriceFeedInterval, pollPriceFeedNow } from './feedRegistry.js';
import { addWalletHistory, getWalletHistory } from './walletHistory.js';
import { apiStart, apiStop, apiReset, setTargetTickTimeMs } from '../jupiter/rateLimiter.js';
// priceFeed is started in index.ts and broadcasts via websocket
import { getRaydiumPoolsNormalized, getOrcaPoolsCached, startRaydiumRefreshLoop, getPoolsMetrics, getMeteoraPoolsCached } from './pools.js';
import { getGraphSnapshot, findPath } from './graph.js';
import { writeSessionLogAndClear } from '../utils/sessionLogs.js';

export function registerRoutes(app: Express, io: SocketIOServer): void {
  const api = Router();
  // Optionally auto-start periodic pool refresh loop (controlled by config)
  try { if ((CONFIG as any)?.system?.autoStartPools) { startRaydiumRefreshLoop(); } } catch {}
  // Arb service observability state
  let lastArbHealthStatus: string | null = null;
  const arbLatency: { metrics: number[]; opps: number[]; lastSummaryAt: number } = { metrics: [], opps: [], lastSummaryAt: 0 };

  api.get('/system', async (_req, res) => {
    const { getAppInfo } = await import('../utils/appInfo.js');
    const info = await getAppInfo();
    res.json({
      version: info.version,
      name: info.name,
      status: 'ok',
      uptimeMs: Date.now() - systemStatus.startTimeMs,
      lastPriceUpdateMs: systemStatus.lastPriceUpdateMs,
      rateLimitActive: systemStatus.rateLimitActive,
      cooldownUntilMs: systemStatus.cooldownUntilMs,
      botName: info.name,
      bot: systemStatus.bot,
      targetTickTimeMs: systemStatus.targetTickTimeMs,
      rpcUrl: CONFIG.rpcUrl,
      fees: CONFIG.fees,
      system: CONFIG.system,
      logCategories: CONFIG.system.logCategories,
    });
  });

  // Token map (mint -> symbol) combining Jupiter-verified tokens and local overrides (non-destructive)
  api.get('/tokens/map', async (_req, res) => {
    try {
      const tokensMod: any = await import('../utils/tokens.js');
      const loadTokenMap = (tokensMod as any).loadTokenMap as () => Promise<Record<string, { mint: string; decimals: number }>>;
      const loadJupiterTokenMap = (tokensMod as any).loadJupiterTokenMap as () => Promise<Record<string, { symbol: string; decimals: number }>>;
      const local = await loadTokenMap();
      const jmap = await loadJupiterTokenMap();
      const out: Record<string, string> = {};
      // 1) Prefer Jupiter-verified symbols first
      for (const [mint, meta] of Object.entries(jmap || {})) {
        if (!mint) continue;
        const sym = (meta?.symbol || '').toString().trim();
        if (sym) out[mint] = sym.toUpperCase();
      }
      // 2) Merge local tokens without overriding existing mints (avoid bad aliases)
      for (const [sym, info] of Object.entries(local || {})) {
        const upperSym = (sym || '').toString().trim().toUpperCase();
        const mint = info?.mint;
        if (!mint) continue;
        if (!out[mint]) out[mint] = upperSym;
      }
      // 3) Enforce canonical anchors for SOL and USDC
      const SOL_MINT = 'So11111111111111111111111111111111111111112';
      const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
      out[SOL_MINT] = 'SOL';
      out[USDC_MINT] = 'USDC';
      res.json({ map: out });
    } catch (e: any) {
      res.status(500).json({ map: {} });
    }
  });

  api.get('/system/config', async (_req, res) => {
    try {
      res.json({
        rpcUrl: CONFIG.rpcUrl,
        system: CONFIG.system,
        fees: CONFIG.fees,
        raydium: CONFIG.raydium,
        orca: CONFIG.orca,
        meteora: (CONFIG as any).meteora,
        sanity: (CONFIG as any).sanity,
      });
    } catch (e: any) {
      logger.error('server: failed to get system config', { error: String(e?.message || e), cat: 'server' });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  api.post('/system/config', async (req, res) => {
    try {
      const { rpcUrl, system, fees, raydium, orca, sanity } = req.body as {
        rpcUrl?: string;
        system?: any;
        fees?: any;
        raydium?: { enableOnChain?: boolean; ammV4Program?: string; clmmProgram?: string; cacheTtlMs?: number; sdkConcurrency?: number; sdkProbeMintsLimit?: number; sdkClmmPageSize?: number; filterToOrcaTokens?: boolean };
        orca?: { mode?: string; apiUrl?: string; programId?: string; configPubkey?: string; cacheTtlMs?: number; maxHttpRetries?: number; httpBackoffMs?: number; pageSize?: number; maxPages?: number; minAmmLiqBase?: number; minClmmLiquidity?: number };
        sanity?: { enabled?: boolean; maxPriceDeviation?: number; feeMin?: number; feeMax?: number; writeSamples?: boolean; sampleRate?: number };
      };
      
      // Update CONFIG with new values
      if (rpcUrl) CONFIG.rpcUrl = rpcUrl;
      if (system) {
        const nextSystem = { ...CONFIG.system, ...system } as any;
        // Validate category inputs if present
        try {
          if (Array.isArray(system.enabledLogCategories)) {
            nextSystem.enabledLogCategories = (system.enabledLogCategories as string[]).map((s) => String(s).toLowerCase());
          }
          if (Array.isArray(system.frontendEnabledLogCategories)) {
            nextSystem.frontendEnabledLogCategories = (system.frontendEnabledLogCategories as string[]).map((s) => String(s).toLowerCase());
          }
          // Map legacy category toggles to structured config if provided
          if (Array.isArray(nextSystem.enabledLogCategories) && nextSystem.enabledLogCategories.length) {
            nextSystem.log = nextSystem.log || {};
            const cats: Record<string, 'error'|'warn'|'info'|'debug'> = { ...(nextSystem.log?.categories || {}) };
            const on = new Set<string>(nextSystem.enabledLogCategories);
            const all: string[] = Array.isArray(nextSystem.logCategories) ? nextSystem.logCategories : [];
            for (const c of all) {
              const name = String(c || '').toLowerCase();
              if (!name) continue;
              cats[name] = on.has(name) ? (cats[name] || 'info') : 'error';
            }
            nextSystem.log.categories = cats;
          }
        } catch {}
        CONFIG.system = nextSystem;
      }
      if (fees) CONFIG.fees = { ...CONFIG.fees, ...fees };
      if (raydium) CONFIG.raydium = { ...CONFIG.raydium, ...raydium } as any;
      if (orca) CONFIG.orca = { ...CONFIG.orca, ...orca } as any;
      if (sanity) (CONFIG as any).sanity = { ...(CONFIG as any).sanity, ...sanity } as any;
      // Apply runtime logger changes if provided
      try {
        if (system && Object.prototype.hasOwnProperty.call(system, 'enableLogging')) {
          setLoggingEnabled(system.enableLogging !== false);
        }
        if (system && typeof system.logLevel === 'string') {
          setLogLevel((system.logLevel as string) as any);
        }
        if (system && (Object.prototype.hasOwnProperty.call(system, 'logToFile') || typeof system.logFilePath === 'string')) {
          setFileLogging(!!system.logToFile, system.logFilePath);
        }
      } catch {}
      
      res.json({ success: true, message: 'System configuration updated' });
      emit('log', { 
        level: 'info', 
        message: 'System configuration updated', 
        timestamp: new Date().toISOString(),
        context: { cat: 'terminal' }
      });
    } catch (e: any) {
      logger.error('server: failed to update system config', { error: String(e?.message || e), cat: 'server' });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // Shutdown all services (best-effort). This will terminate the backend process; scripts should clean up others.
  api.post('/system/shutdown', async (_req, res) => {
    try {
      emit('log', { level: 'warn', message: 'terminal: shutdown requested from UI', timestamp: new Date().toISOString() });
      res.json({ ok: true });
      setTimeout(() => {
        try { emit('log', { level: 'warn', message: 'terminal: shutting down now', timestamp: new Date().toISOString() }); } catch {}
        try { writeSessionLogAndClear().catch(() => null); } catch {}
        process.exit(0);
      }, 250);
    } catch (e: any) {
      logger.error('server: shutdown failed', { error: String(e?.message || e), cat: 'server' });
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  api.get('/wallet', async (_req, res) => {
    try {
      const kp = await ensureWallet(CONFIG.walletPath);
      const balances = await getBalances(kp.publicKey);
      const list = await readJson<any[]>(CONFIG.walletTokensPath, []);
      const aliases: Record<string, string> = {};
      // map existing wallet token aliases
      for (const item of list) {
        if (item?.id && item?.symbol) aliases[item.id] = item.symbol;
      }
      // resolve missing mints via Token API (best-effort)
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
          } catch {
            // ignore (API paused or network error)
          }
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
        // Send SOL
        const connection = new (await import('@solana/web3.js')).Connection(CONFIG.rpcUrl, 'confirmed');
        const { LAMPORTS_PER_SOL, SystemProgram, Transaction } = await import('@solana/web3.js');
        const tx = new Transaction().add(
          SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: new (await import('@solana/web3.js')).PublicKey(destination), lamports: Math.round(amount * LAMPORTS_PER_SOL) })
        );
        
        // Add fee configuration for SOL sends
        const { getFeeCalculator } = await import('../utils/feeCalculator.js');
        const feeCalculator = getFeeCalculator(connection);
        const recommendation = feeCalculator.getFeeRecommendation('send');
        const calculatedFees = await feeCalculator.calculateFees({ ...CONFIG.fees, ...recommendation });
        
        // Add compute budget instructions
        const { ComputeBudgetProgram } = await import('@solana/web3.js');
        tx.add(
          ComputeBudgetProgram.setComputeUnitLimit({ units: 200000 }),
          ComputeBudgetProgram.setComputeUnitPrice({ microLamports: calculatedFees.priorityFee })
        );
        
        const sig = await connection.sendTransaction(tx, [kp]);
        await connection.confirmTransaction(sig, 'confirmed');
        res.json({ signature: sig });
        addWalletHistory({ type: 'send', time: new Date().toISOString(), token: 'SOL', amount, destination, signature: sig });
        emit('log', { level: 'info', message: `terminal: send SOL ${amount} to ${destination} -> ${sig}`, timestamp: new Date().toISOString() });
        // Trigger wallet refresh after send operation
        try {
          const { createWalletFeed } = await import('./walletFeed.js');
          const walletFeed = createWalletFeed(io);
          await walletFeed.refresh();
        } catch {}
      } else {
        // Send SPL by mint or symbol
        const { PublicKey } = await import('@solana/web3.js');
        const { sendSplToken } = await import('../wallet/wallet.js');
        const tokensMod: any = await import('../utils/tokens.js');
        const tokenMap = await tokensMod.loadTokenMap();
        const mintResolved = token.length > 30 ? token : (tokenMap[token.toUpperCase()]?.mint || token);
        const sig = await sendSplToken({ from: kp, destination: new PublicKey(destination), mint: new PublicKey(mintResolved), amount });
        res.json({ signature: sig });
        addWalletHistory({ type: 'send', time: new Date().toISOString(), token, amount, destination, signature: sig });
        emit('log', { level: 'info', message: `terminal: send SPL ${token} ${amount} to ${destination} -> ${sig}`, timestamp: new Date().toISOString() });
        // Trigger wallet refresh after send operation
        try {
          const { createWalletFeed } = await import('./walletFeed.js');
          const walletFeed = createWalletFeed(io);
          await walletFeed.refresh();
        } catch {}
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
            const results = await (await import('../jupiter/tokenApi.js')).searchTokens(mint, true);
            const first: any = results[0];
            if (first?.id === mint && first?.symbol) {
              aliases[mint] = first.symbol;
              if (!list.find((t) => t.id === mint)) {
                list.push(first);
                updated = true;
              }
            }
          } catch {
            // ignore
          }
        }
      }
      if (updated) await writeJson(CONFIG.walletTokensPath, list);
      res.json({ address: kp.publicKey.toBase58(), balances, aliases });
      io.emit('wallet-update', { address: kp.publicKey.toBase58(), balances, aliases });
      emit('log', { level: 'info', message: 'Wallet refreshed', timestamp: new Date().toISOString() });
    } catch (e: any) {
      const msg = String(e?.message || e);
      if (msg === 'WALLET_NOT_FOUND') {
        return res.status(404).json({ error: 'Wallet not found. Generate one via /api/wallet/generate or terminal: wallet generate' });
      }
      logger.error('wallet refresh failed', { error: msg });
      res.status(500).json({ error: msg });
    }
  });

  // Wallet token alias list (for displaying SPL balances with symbols)
  api.get('/wallet/tokens', async (_req, res) => {
    const list = await readJson<any[]>(CONFIG.walletTokensPath, []);
    res.json({ walletTokens: list });
  });

  // Token account management endpoints
  api.get('/wallet/token-accounts', async (_req, res) => {
    try {
      const { getTokenAccountManager } = await import('../wallet/tokenAccountManager.js');
      const { getConnection } = await import('../wallet/wallet.js');
      const connection = getConnection();
      const manager = getTokenAccountManager(connection);
      const accounts = manager.getTokenAccounts();
      res.json({ tokenAccounts: accounts });
    } catch (e: any) {
      logger.error('wallet: failed to get token accounts', { error: String(e), cat: 'wallet' });
      res.status(500).json({ error: String(e) });
    }
  });

  api.delete('/wallet/token-accounts/:address', async (req, res) => {
    try {
      const { address } = req.params;
      const { getTokenAccountManager } = await import('../wallet/tokenAccountManager.js');
      const { getConnection } = await import('../wallet/wallet.js');
      const { PublicKey } = await import('@solana/web3.js');
      const connection = getConnection();
      const manager = getTokenAccountManager(connection);
      await manager.removeTokenAccount(new PublicKey(address));
      res.json({ ok: true });
      emit('log', { level: 'info', message: `Token account removed: ${address}`, timestamp: new Date().toISOString() });
    } catch (e: any) {
      logger.error('wallet: failed to remove token account', { error: String(e), cat: 'wallet' });
      res.status(500).json({ error: String(e) });
    }
  });

  api.post('/wallet/token-accounts/cleanup', async (req, res) => {
    try {
      const { maxAgeMs } = req.body as { maxAgeMs?: number };
      const { getTokenAccountManager } = await import('../wallet/tokenAccountManager.js');
      const { getConnection } = await import('../wallet/wallet.js');
      const connection = getConnection();
      const manager = getTokenAccountManager(connection);
      await manager.cleanupUnusedAccounts(maxAgeMs);
      res.json({ ok: true });
      emit('log', { level: 'info', message: 'Token account cleanup completed', timestamp: new Date().toISOString() });
    } catch (e: any) {
      logger.error('wallet: cleanup token accounts failed', { error: String(e), cat: 'wallet' });
      res.status(500).json({ error: String(e) });
    }
  });

  // Drift: status and subaccounts
  api.get('/drift/status', async (_req: Request, res: Response) => {
    try {
      const { DriftService } = await import('../drift/client.js');
      const svc = DriftService.getInstance();
      const status = await svc.getStatus();
      res.json(status);
    } catch (e: any) {
      logger.error('drift: status failed', { error: String(e?.message || e) });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  api.post('/drift/subaccount/switch', async (req: Request, res: Response) => {
    try {
      const { id } = req.body as { id: number };
      const { DriftService } = await import('../drift/client.js');
      const svc = DriftService.getInstance();
      const ok = await svc.switchSubaccount(Number(id));
      try {
        const { readJson, writeJson } = await import('../utils/fs.js');
        const pathMod = await import('path');
        const storePath = pathMod.resolve(process.cwd(), 'backend', 'config', 'driftSubaccounts.json');
        const store = await readJson<any>(storePath, { names: {}, selectedId: Number(id) });
        store.selectedId = Number(id);
        await writeJson(storePath, store);
      } catch {}
      res.json({ ok });
    } catch (e: any) {
      logger.error('drift: switch subaccount failed', { error: String(e?.message || e) });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // Drift: subaccount list
  api.get('/drift/subaccounts', async (_req: Request, res: Response) => {
    try {
      const { DriftService } = await import('../drift/client.js');
      const svc = DriftService.getInstance();
      const refresh = false;
      const subs = await svc.getSubaccounts();
      const { readJson } = await import('../utils/fs.js');
      const pathMod = await import('path');
      const storePath = pathMod.resolve(process.cwd(), 'backend', 'config', 'driftSubaccounts.json');
      const store = await readJson<any>(storePath, { names: {}, selectedId: subs?.[0]?.id ?? 0 });
      const subaccounts = subs.map((s: any) => ({ ...s, name: (store.names?.[String(s.id)] || null) }));
      res.json({ subaccounts, selectedId: store.selectedId });
    } catch (e: any) {
      logger.error('drift: subaccounts failed', { error: String(e?.message || e) });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // Drift: refresh subaccount list (invalidate cache)
  api.post('/drift/subaccounts', async (req: Request, res: Response) => {
    try {
      const refresh = !!(req.body?.refresh) || String(req.query?.refresh || '') === '1';
      const { DriftService } = await import('../drift/client.js');
      const svc = DriftService.getInstance();
      if (refresh) svc.invalidateSubaccountsCache();
      const subs = await svc.getSubaccounts();
      const { readJson } = await import('../utils/fs.js');
      const pathMod = await import('path');
      const storePath = pathMod.resolve(process.cwd(), 'backend', 'config', 'driftSubaccounts.json');
      const store = await readJson<any>(storePath, { names: {}, selectedId: subs?.[0]?.id ?? 0 });
      const subaccounts = subs.map((s: any) => ({ ...s, name: (store.names?.[String(s.id)] || null) }));
      res.json({ subaccounts, selectedId: store.selectedId, refreshed: refresh });
    } catch (e: any) {
      logger.error('drift: subaccounts refresh failed', { error: String(e?.message || e) });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // Drift: create subaccount
  api.post('/drift/subaccount/create', async (req: Request, res: Response) => {
    try {
      const { name } = (req.body || {}) as { name?: string };
      const { DriftService } = await import('../drift/client.js');
      const svc = DriftService.getInstance();
      const created = await svc.createSubaccount(name);
      const out = created || { id: Number((CONFIG as any).drift?.defaultSubaccountId || 0) };
      try {
        const { readJson, writeJson } = await import('../utils/fs.js');
        const pathMod = await import('path');
        const storePath = pathMod.resolve(process.cwd(), 'backend', 'config', 'driftSubaccounts.json');
        const store = await readJson<any>(storePath, { names: {}, selectedId: out.id });
        if (name && String(name).trim()) {
          store.names[String(out.id)] = String(name).trim();
        }
        store.selectedId = out.id;
        await writeJson(storePath, store);
      } catch {}
      res.json(out);
    } catch (e: any) {
      logger.error('drift: create subaccount failed', { error: String(e?.message || e) });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // Drift: set subaccount name
  api.post('/drift/subaccount/name', async (req: Request, res: Response) => {
    try {
      const { id, name } = req.body as { id: number; name: string };
      const pathMod = await import('path');
      const { readJson, writeJson } = await import('../utils/fs.js');
      const storePath = pathMod.resolve(process.cwd(), 'backend', 'config', 'driftSubaccounts.json');
      const store = await readJson<any>(storePath, { names: {}, selectedId: Number(id) });
      if (Number.isFinite(Number(id)) && String(name).trim()) {
        store.names[String(id)] = String(name).trim();
        await writeJson(storePath, store);
      }
      res.json({ ok: true });
    } catch (e: any) {
      logger.error('drift: subaccount name failed', { error: String(e?.message || e) });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // Drift: deposit to subaccount
  api.post('/drift/subaccount/deposit', async (req: Request, res: Response) => {
    try {
      const body = req.body as { subaccountId: number; amount: number; spotMarketIndex?: number };
      const subaccountId = Number(body?.subaccountId);
      const amount = Number(body?.amount);
      const spotMarketIndex = body?.spotMarketIndex;
      if (!Number.isFinite(subaccountId) || subaccountId < 0) return res.status(400).json({ error: 'invalid subaccountId' });
      if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'invalid amount' });
      const { DriftService } = await import('../drift/client.js');
      const svc = DriftService.getInstance();
      const out = await svc.depositToSubaccount({ subaccountId, amount, spotMarketIndex });
      res.json(out);
    } catch (e: any) {
      logger.error('drift: deposit failed', { error: String(e?.message || e) });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // Drift: withdraw from subaccount
  api.post('/drift/subaccount/withdraw', async (req: Request, res: Response) => {
    try {
      const body = req.body as { subaccountId: number; amount: number; spotMarketIndex?: number };
      const subaccountId = Number(body?.subaccountId);
      const amount = Number(body?.amount);
      const spotMarketIndex = body?.spotMarketIndex;
      if (!Number.isFinite(subaccountId) || subaccountId < 0) return res.status(400).json({ error: 'invalid subaccountId' });
      if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'invalid amount' });
      const { DriftService } = await import('../drift/client.js');
      const svc = DriftService.getInstance();
      const out = await svc.withdrawFromSubaccount({ subaccountId, amount, spotMarketIndex });
      res.json(out);
    } catch (e: any) {
      logger.error('drift: withdraw failed', { error: String(e?.message || e) });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // Drift: transfer deposit between subaccounts
  api.post('/drift/subaccount/transfer', async (req: Request, res: Response) => {
    try {
      const body = req.body as { amount: number; spotMarketIndex: number; fromSubaccountId: number; toSubaccountId: number };
      const amount = Number(body?.amount);
      const spotMarketIndex = Number(body?.spotMarketIndex);
      const fromSubaccountId = Number(body?.fromSubaccountId);
      const toSubaccountId = Number(body?.toSubaccountId);
      if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'invalid amount' });
      if (!Number.isFinite(spotMarketIndex)) return res.status(400).json({ error: 'invalid spotMarketIndex' });
      if (!Number.isFinite(fromSubaccountId) || fromSubaccountId < 0) return res.status(400).json({ error: 'invalid fromSubaccountId' });
      if (!Number.isFinite(toSubaccountId) || toSubaccountId < 0) return res.status(400).json({ error: 'invalid toSubaccountId' });
      const { DriftService } = await import('../drift/client.js');
      const svc = DriftService.getInstance();
      const out = await svc.transferBetweenSubaccounts({ amount, spotMarketIndex, fromSubaccountId, toSubaccountId });
      res.json(out);
    } catch (e: any) {
      logger.error('drift: transfer failed', { error: String(e?.message || e) });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // Grid Monitor adapter: expose grid endpoints for both classic and drift levered grids
  // Levels/positions/state snapshot
  api.get('/grid/levels/:name', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const name = String(req.params?.name || '');
      // Attempt to resolve a drift levered grid by strategy name
      const { DriftGridRegistry } = await import('../drift/execution.js');
      const { DriftPriceService } = await import('../drift/price.js');
      const { generatePriceLadder } = await import('../drift/orders.js');

      const all = DriftGridRegistry.list();
      const hit = all.find((x: any) => String(x?.status?.config?.name || '') === name);
      if (!hit) return next();
      const cfg: any = hit.status?.config || {};
      const marketIndex = Number(cfg?.market?.marketIndex || 0);
      const ps = DriftPriceService.getInstance().getPrice(marketIndex);
      // Prefer mid for center price; fallback to oracle if mid is unavailable
      const anchor = (ps && typeof ps?.mid === 'number') ? ps.mid : (ps?.oracle || undefined);
      // Honor sliding center if runner has it; fall back to anchor
      const stList = DriftGridRegistry.list();
      const stFound = stList.find((x: any) => String(x?.status?.config?.name || '') === name);
      const center = (stFound?.status?.centerPrice && isFinite(stFound.status.centerPrice)) ? Number(stFound.status.centerPrice) : anchor;
      const ladder = (typeof center === 'number' && isFinite(center)) ? generatePriceLadder(cfg, center) : [];
      const levels = ladder.map((l: any, i: number) => ({ id: `${l.side}-${i}-${Number(l.price).toFixed(6)}`, price: Number(l.price), side: l.side, amount: Number(l.size || 0), filled: false }));

      const state = {
        centerPrice: (typeof center === 'number' ? center : null),
        originalCenterPrice: (typeof center === 'number' ? center : null),
        lastRebalance: Date.now(),
        volatility: 0,
        totalFilled: 0,
        totalPnl: 0,
        completedCycles: 0,
        totalTrades: 0,
      };
      // Best-effort drift extras
      let spread: number | undefined = undefined;
      let feeBps: number | undefined = undefined;
      let feeEstRoundTrip: number | undefined = undefined;
      let fundingApy: number | undefined = undefined;
      try {
        const bid = (ps && typeof (ps as any)?.bid === 'number') ? (ps as any).bid : undefined;
        const ask = (ps && typeof (ps as any)?.ask === 'number') ? (ps as any).ask : undefined;
        if (typeof bid === 'number' && typeof ask === 'number') spread = ask - bid;
      } catch {}
      try {
        const feeMakerBps = Number((CONFIG as any)?.drift?.feeMakerBps || 0);
        const feeTakerBps = Number((CONFIG as any)?.drift?.feeTakerBps || 5);
        const cfgAny: any = cfg || {};
        feeBps = cfgAny?.makerOnly ? feeMakerBps : feeTakerBps;
        const perSide = Math.max(0, Number(cfgAny?.levels || 0));
        const proposedNotional = perSide * (cfgAny?.notionalPerLevel || 0);
        feeEstRoundTrip = (feeBps / 10000) * proposedNotional * 2;
      } catch {}
      try {
        const { DriftService } = await import('../drift/client.js');
        const fr = await DriftService.getInstance().getFundingRate(marketIndex);
        if (fr && typeof fr.lastFundingRate === 'number') fundingApy = fr.lastFundingRate * 365 * 24;
      } catch {}
      // Resolve perp market symbol via SDK constants if not present
      let marketSymbol: string | undefined = ps?.symbol;
      try {
        if (!marketSymbol) {
          const sdk: any = await import('@drift-labs/sdk');
          const constants: any = (sdk as any).constants || (sdk as any);
          const cluster = (CONFIG as any)?.drift?.cluster || 'mainnet-beta';
          const byCluster = (obj: any) => obj?.[cluster] || obj?.[cluster.replace('-', '_')];
          const list = byCluster(constants?.PERP_MARKETS) || byCluster(constants?.PerpMarkets) || constants?.PERP_MARKETS || constants?.PerpMarkets || [];
          const found = Array.isArray(list) ? list.find((m: any) => Number(m?.marketIndex ?? m?.index ?? m?.market_index) === marketIndex) : null;
          if (found) marketSymbol = String(found?.symbol || found?.name || '').trim() || undefined;
        }
      } catch {}
      const sym = marketSymbol || `PERP-${marketIndex}`;
      const tokens = { fromToken: 'USDC', toToken: sym, fromSymbol: 'USDC', toSymbol: sym, fromUsd: 1, toUsd: undefined as any };
      // Include runtime state from runner for extras
      try {
        if (stFound && stFound.status) {
          const st: any = stFound.status;
          return res.json({
            levels,
            positions: [],
            activePositions: [],
            tradeHistory: [],
            state,
            tokens,
            spread,
            feeBps,
            feeEstRoundTrip,
            fundingApy,
            openOrders: st.openOrders,
            effectiveLeverage: st.effectiveLeverage,
            liquidationBuffer: st.liquidationBuffer,
          });
        }
      } catch {}
      res.json({ levels, positions: [], activePositions: [], tradeHistory: [], state, tokens, spread, feeBps, feeEstRoundTrip, fundingApy });
    } catch (e: any) {
      logger.error('grid.levels adapter failed', { error: String(e?.message || e) });
      return next();
    }
  });

  // Performance
  api.get('/grid/performance/:name', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const name = String(req.params?.name || '');
      const { DriftGridRegistry } = await import('../drift/execution.js');
      const hit = DriftGridRegistry.list().find((x: any) => String(x?.status?.config?.name || '') === name);
      if (!hit) return next();
      // Minimal placeholder performance for drift grids for now
      const data = { totalPnl: 0, totalTrades: 0, completedCycles: 0 };
      res.json(data);
    } catch (e: any) {
      logger.error('grid.performance adapter failed', { error: String(e?.message || e) });
      return next();
    }
  });

  // Rebalance (no-op for drift adapter)
  api.post('/grid/rebalance/:name', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const name = String(req.params?.name || '');
      const { DriftGridRegistry } = await import('../drift/execution.js');
      const hit = DriftGridRegistry.list().find((x: any) => String(x?.status?.config?.name || '') === name);
      if (!hit) return next();
      res.json({ ok: true });
    } catch {
      return next();
    }
  });

  // Close position (not supported yet for drift adapter)
  api.post('/grid/close-position/:name', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const name = String(req.params?.name || '');
      const { DriftGridRegistry } = await import('../drift/execution.js');
      const hit = DriftGridRegistry.list().find((x: any) => String(x?.status?.config?.name || '') === name);
      if (!hit) return next();
      res.status(400).json({ error: 'not supported' });
    } catch {
      return next();
    }
  });

  // Drift: list spot markets map (index/mint/symbol/decimals) - best-effort via SDK constants
  api.get('/drift/spot-markets', async (_req: Request, res: Response) => {
    try {
      const sdk: any = await import('@drift-labs/sdk');
      const constants: any = (sdk as any).constants || (sdk as any);
      const cluster = (CONFIG as any)?.drift?.cluster || 'mainnet-beta';
      const byCluster = (obj: any) => obj?.[cluster] || obj?.[cluster.replace('-', '_')];
      const list = byCluster(constants?.SPOT_MARKETS) || byCluster(constants?.SpotMarkets) || constants?.SPOT_MARKETS || constants?.SpotMarkets || [];
      const out = Array.isArray(list) ? list.map((m: any) => ({
        marketIndex: Number(m?.marketIndex ?? m?.index ?? m?.market_index),
        symbol: String(m?.symbol || m?.name || '').trim() || undefined,
        mint: String(m?.mint || m?.mintAddress || m?.address || ''),
        decimals: Number(m?.decimals ?? m?.precision ?? 6),
      })).filter((m: any) => Number.isFinite(m.marketIndex)) : [];
      res.json({ markets: out });
    } catch (e: any) {
      logger.error('drift: spot-markets failed', { error: String(e?.message || e) });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // Drift: subaccount token balances (best-effort from SDK User state)
  api.get('/drift/subaccount/balances', async (req: Request, res: Response) => {
    try {
      const q = req.query as any;
      const subId = Number(q?.subaccountId ?? q?.id ?? 0);
      const { DriftService } = await import('../drift/client.js');
      const svc = DriftService.getInstance();
      await svc.init();
      const client: any = (svc as any)?.client;
      const user = client?.user;
      const spotPositions = user?.getSpotPositions?.() || [];
      const out: Array<{ marketIndex: number; balance: number; symbol?: string; mint?: string; decimals?: number }> = [];
      for (const p of spotPositions) {
        try {
          const idx = Number(p?.marketIndex ?? p?.market_index ?? 0);
          // Prefer UI amount via market precision conversion if available
          let bal = Number(p?.scaledBalance?.toString?.() || 0) || Number(p?.balance || 0);
          // Attempt to enrich with market info from constants
          let symbol: string | undefined = undefined;
          let mint: string | undefined = undefined;
          let decimals: number | undefined = undefined;
          try {
            const sdk: any = await import('@drift-labs/sdk');
            const constants: any = (sdk as any).constants || (sdk as any);
            const cluster = (CONFIG as any)?.drift?.cluster || 'mainnet-beta';
            const byCluster = (obj: any) => obj?.[cluster] || obj?.[cluster.replace('-', '_')];
            const list = byCluster(constants?.SPOT_MARKETS) || byCluster(constants?.SpotMarkets) || constants?.SPOT_MARKETS || constants?.SpotMarkets || [];
            const found = Array.isArray(list) ? list.find((m: any) => Number(m?.marketIndex ?? m?.index ?? m?.market_index) === idx) : null;
            if (found) {
              symbol = String(found?.symbol || found?.name || '').trim() || undefined;
              mint = String(found?.mint || found?.mintAddress || found?.address || '');
              decimals = Number(found?.decimals ?? found?.precision ?? 6);
              if (typeof decimals === 'number' && decimals >= 0) {
                // Convert native balance estimate to UI units when plausible
                const scale = Math.pow(10, decimals);
                if (scale > 0 && isFinite(scale)) {
                  bal = bal / scale;
                }
              }
            }
          } catch {}
          out.push({ marketIndex: idx, balance: bal, symbol, mint, decimals });
        } catch {}
      }
      res.json({ balances: out });
    } catch (e: any) {
      logger.error('drift: subaccount balances failed', { error: String(e?.message || e) });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // Drift: L2 orderbook proxy (DLOB)
  api.get('/drift/l2', async (req: Request, res: Response) => {
    try {
      const q = req.query as any;
      const marketIndex = Number(q.marketIndex ?? q.marketindex ?? q.index);
      if (!Number.isFinite(marketIndex)) return res.status(400).json({ error: 'marketIndex required' });
      const { fetchDlobL2 } = await import('../drift/marketdata.js');
      const l2 = await fetchDlobL2(marketIndex);
      res.json(l2 || { bid: [], ask: [] });
    } catch (e: any) {
      logger.error('drift: l2 failed', { error: String(e?.message || e) });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  api.get('/drift/funding', async (req: Request, res: Response) => {
    try {
      const q = req.query as any;
      const marketIndex = Number(q.marketIndex ?? q.marketindex ?? q.index);
      if (!Number.isFinite(marketIndex)) return res.status(400).json({ error: 'marketIndex required' });
      const { DriftService } = await import('../drift/client.js');
      const svc = DriftService.getInstance();
      const fr = await svc.getFundingRate(marketIndex);
      res.json(fr || { lastFundingRate: 0, cumulativeFunding: 0 });
    } catch (e: any) {
      logger.error('drift: funding failed', { error: String(e?.message || e) });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // Leveraged Grid (Drift) strategy control
  api.get('/strategies/leveraged-grid/status', async (_req: Request, res: Response) => {
    try {
      const { DriftGridRegistry } = await import('../drift/execution.js');
      const list = DriftGridRegistry.list();
      res.json({ strategies: list });
    } catch (e: any) {
      logger.error('drift-grid: status failed', { error: String(e?.message || e) });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  api.post('/strategies/leveraged-grid/start', async (req: Request, res: Response) => {
    try {
      const cfg = req.body as any; // validated on frontend; add backend zod later
      const { DriftGridRegistry } = await import('../drift/execution.js');
      const runner = DriftGridRegistry.upsert(cfg);
      const key = (DriftGridRegistry as any).keyOf(cfg);
      await DriftGridRegistry.start(key, (CONFIG as any).system?.targetTickTimeMs || 1500);
      emit('log', { level: 'info', message: `drift: grid started ${cfg?.name || key}`, timestamp: new Date().toISOString(), context: { cat: 'drift' } });
      try { const list = await getStrategies(); io.emit('strategies-update', list); } catch {}
      res.json({ ok: true, key });
    } catch (e: any) {
      logger.error('drift-grid: start failed', { error: String(e?.message || e) });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  api.post('/strategies/leveraged-grid/stop', async (req: Request, res: Response) => {
    try {
      const { key } = req.body as { key: string };
      const { DriftGridRegistry } = await import('../drift/execution.js');
      // Remove the runner completely so it doesn't reappear on next status
      const ok = DriftGridRegistry.remove(key);
      if (ok) emit('log', { level: 'info', message: `drift: grid removed ${key}`, timestamp: new Date().toISOString(), context: { cat: 'drift' } });
      try { const list = await getStrategies(); io.emit('strategies-update', list); } catch {}
      res.json({ ok });
    } catch (e: any) {
      logger.error('drift-grid: stop failed', { error: String(e?.message || e) });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  api.post('/strategies/leveraged-grid/update', async (req: Request, res: Response) => {
    try {
      const cfg = req.body as any;
      const { DriftGridRegistry } = await import('../drift/execution.js');
      const key = (DriftGridRegistry as any).keyOf(cfg);
      // Replace existing runner with new config to ensure updates take effect
      try { DriftGridRegistry.remove(key); } catch {}
      const runner = DriftGridRegistry.upsert(cfg);
      await DriftGridRegistry.start(key, (CONFIG as any).system?.targetTickTimeMs || 1500);
      emit('log', { level: 'info', message: `drift-grid: updated ${cfg?.name || key}`, timestamp: new Date().toISOString(), context: { cat: 'strategy' } });
      try { const list = await getStrategies(); io.emit('strategies-update', list); } catch {}
      res.json({ ok: true, key });
    } catch (e: any) {
      logger.error('drift-grid: update failed', { error: String(e?.message || e) });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // Drift Liquidator control
  api.get('/strategies/liquidator/status', async (_req: Request, res: Response) => {
    try {
      const { DriftLiquidatorRegistry } = await import('../drift/liquidator.js');
      const list = DriftLiquidatorRegistry.list();
      res.json({ liquidators: list });
    } catch (e: any) {
      logger.error('drift-liq: status failed', { error: String(e?.message || e), stack: String(e?.stack || '') });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  api.post('/strategies/liquidator/start', async (req: Request, res: Response) => {
    try {
      const cfg = req.body as any;
      const { DriftLiquidatorRegistry } = await import('../drift/liquidator.js');
      const runner = DriftLiquidatorRegistry.upsert({
        name: cfg?.name || 'default',
        enabled: true,
        pollMs: cfg?.pollMs,
        maxConcurrentTargets: cfg?.maxConcurrentTargets,
        dryRun: cfg?.dryRun,
        // discovery & scanning
        discoverAllUsers: cfg?.discoverAllUsers,
        maxDiscoveredUsers: cfg?.maxDiscoveredUsers,
        usersAllowlist: Array.isArray(cfg?.usersAllowlist) ? cfg?.usersAllowlist : (typeof cfg?.usersAllowlistCsv === 'string' ? String(cfg?.usersAllowlistCsv).split(',').map((s: string) => s.trim()).filter(Boolean) : undefined),
        scanConcurrency: cfg?.scanConcurrency,
        userCacheMax: cfg?.userCacheMax,
        riskHealthThreshold: cfg?.riskHealthThreshold,
        // triggers & markets
        usePriceTriggers: cfg?.usePriceTriggers,
        priceTriggerDebounceMs: cfg?.priceTriggerDebounceMs,
        httpPollMs: cfg?.httpPollMs,
        maxUsersPerPriceTick: cfg?.maxUsersPerPriceTick,
        marketsAllowlist: Array.isArray(cfg?.marketsAllowlist) ? cfg?.marketsAllowlist : (typeof cfg?.marketsAllowlistCsv === 'string' ? String(cfg?.marketsAllowlistCsv).split(',').map((s: string) => s.trim()).filter(Boolean) : undefined),
        marketIndices: Array.isArray(cfg?.marketIndices) ? cfg?.marketIndices : (typeof cfg?.marketIndicesCsv === 'string' ? String(cfg?.marketIndicesCsv).split(',').map((s: string) => Number(s.trim())).filter((n: any) => Number.isFinite(n)) : undefined),
        // execution tuning
        maxCancels: cfg?.maxCancels,
        maxPerpAttempts: cfg?.maxPerpAttempts,
        perpSizeFraction: cfg?.perpSizeFraction,
        maxSpotAttempts: cfg?.maxSpotAttempts,
        spotSizeFraction: cfg?.spotSizeFraction,
        targetCooldownMs: cfg?.targetCooldownMs,
        statsIntervalMs: cfg?.statsIntervalMs,
      } as any);
      const key = (DriftLiquidatorRegistry as any).keyOf(cfg?.name ? { name: cfg.name } : { name: 'default' });
      await DriftLiquidatorRegistry.start(key);
      emit('log', { level: 'info', message: `drift: liquidator started ${cfg?.name || key}` , timestamp: new Date().toISOString(), context: { cat: 'drift' } });
      res.json({ ok: true, key });
    } catch (e: any) {
      logger.error('drift-liq: start failed', { error: String(e?.message || e), stack: String(e?.stack || '') });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  api.post('/strategies/liquidator/stop', async (req: Request, res: Response) => {
    try {
      const { key } = req.body as { key: string };
      const { DriftLiquidatorRegistry } = await import('../drift/liquidator.js');
      const ok = DriftLiquidatorRegistry.stop(key);
      if (ok) emit('log', { level: 'info', message: `drift: liquidator stopped ${key}`, timestamp: new Date().toISOString(), context: { cat: 'drift' } });
      res.json({ ok });
    } catch (e: any) {
      logger.error('drift-liq: stop failed', { error: String(e?.message || e), stack: String(e?.stack || '') });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  api.post('/strategies/liquidator/remove', async (req: Request, res: Response) => {
    try {
      const { key } = req.body as { key: string };
      const { DriftLiquidatorRegistry } = await import('../drift/liquidator.js');
      const ok = DriftLiquidatorRegistry.remove(key);
      if (ok) emit('log', { level: 'info', message: `drift: liquidator removed ${key}`, timestamp: new Date().toISOString(), context: { cat: 'drift' } });
      res.json({ ok });
    } catch (e: any) {
      logger.error('drift-liq: remove failed', { error: String(e?.message || e) });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  api.post('/strategies/liquidator/update', async (req: Request, res: Response) => {
    try {
      const cfg = req.body as any;
      const { DriftLiquidatorRegistry } = await import('../drift/liquidator.js');
      const runner = DriftLiquidatorRegistry.upsert({
        name: cfg?.name || 'default',
        enabled: true,
        pollMs: cfg?.pollMs,
        maxConcurrentTargets: cfg?.maxConcurrentTargets,
        dryRun: cfg?.dryRun,
        // discovery & scanning
        discoverAllUsers: cfg?.discoverAllUsers,
        maxDiscoveredUsers: cfg?.maxDiscoveredUsers,
        usersAllowlist: Array.isArray(cfg?.usersAllowlist) ? cfg?.usersAllowlist : (typeof cfg?.usersAllowlistCsv === 'string' ? String(cfg?.usersAllowlistCsv).split(',').map((s: string) => s.trim()).filter(Boolean) : undefined),
        scanConcurrency: cfg?.scanConcurrency,
        userCacheMax: cfg?.userCacheMax,
        riskHealthThreshold: cfg?.riskHealthThreshold,
        // triggers & markets
        usePriceTriggers: cfg?.usePriceTriggers,
        priceTriggerDebounceMs: cfg?.priceTriggerDebounceMs,
        httpPollMs: cfg?.httpPollMs,
        maxUsersPerPriceTick: cfg?.maxUsersPerPriceTick,
        marketsAllowlist: Array.isArray(cfg?.marketsAllowlist) ? cfg?.marketsAllowlist : (typeof cfg?.marketsAllowlistCsv === 'string' ? String(cfg?.marketsAllowlistCsv).split(',').map((s: string) => s.trim()).filter(Boolean) : undefined),
        marketIndices: Array.isArray(cfg?.marketIndices) ? cfg?.marketIndices : (typeof cfg?.marketIndicesCsv === 'string' ? String(cfg?.marketIndicesCsv).split(',').map((s: string) => Number(s.trim())).filter((n: any) => Number.isFinite(n)) : undefined),
        // execution tuning
        maxCancels: cfg?.maxCancels,
        maxPerpAttempts: cfg?.maxPerpAttempts,
        perpSizeFraction: cfg?.perpSizeFraction,
        maxSpotAttempts: cfg?.maxSpotAttempts,
        spotSizeFraction: cfg?.spotSizeFraction,
        targetCooldownMs: cfg?.targetCooldownMs,
        statsIntervalMs: cfg?.statsIntervalMs,
      } as any);
      const key = (DriftLiquidatorRegistry as any).keyOf({ name: cfg?.name || 'default' });
      await DriftLiquidatorRegistry.start(key);
      emit('log', { level: 'info', message: `drift-liq: updated ${cfg?.name || key}`, timestamp: new Date().toISOString(), context: { cat: 'drift' } });
      res.json({ ok: true, key });
    } catch (e: any) {
      logger.error('drift-liq: update failed', { error: String(e?.message || e), stack: String(e?.stack || '') });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // Liquidator configuration endpoints
  api.get('/strategies/liquidator/config', async (_req: Request, res: Response) => {
    try {
      const { CONFIG } = await import('../utils/config.js');
      const cfg = ((CONFIG as any)?.drift?.liquidator) || {};
      const marketsAllowlist = ((CONFIG as any)?.drift?.marketsAllowlist) || [];
      res.json({ config: cfg, marketsAllowlist });
    } catch (e: any) {
      logger.error('drift-liq: get-config failed', { error: String(e?.message || e) });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  api.post('/strategies/liquidator/config', async (req: Request, res: Response) => {
    try {
      const body = req.body as any;
      const { CONFIG } = await import('../utils/config.js');
      (CONFIG as any).drift = (CONFIG as any).drift || {};
      (CONFIG as any).drift.liquidator = (CONFIG as any).drift.liquidator || {};
      const lc = (CONFIG as any).drift.liquidator as any;
      const assignBool = (k: string) => { if (body[k] !== undefined) lc[k] = !!body[k]; };
      const assignNum = (k: string, min?: number, max?: number) => {
        if (body[k] !== undefined) {
          let v = Number(body[k]);
          if (Number.isFinite(v)) {
            if (min !== undefined) v = Math.max(min, v);
            if (max !== undefined) v = Math.min(max, v);
            lc[k] = v;
          }
        }
      };
      const assignArrStr = (k: string) => {
        const val = body[k];
        if (val !== undefined) {
          if (Array.isArray(val)) lc[k] = val.map((s: any) => String(s || '').trim()).filter(Boolean);
          else if (typeof val === 'string') lc[k] = val.split(',').map(s => s.trim()).filter(Boolean);
        }
      };
      // Apply known keys
      assignNum('riskHealthThreshold', -1, 1);
      assignBool('usePriceTriggers');
      assignNum('priceTriggerDebounceMs', 200, 10000);
      assignNum('httpPollMs', 200, 10000);
      assignNum('maxUsersPerPriceTick', 1, 1000);
      assignBool('discoverAllUsers');
      assignNum('maxDiscoveredUsers', 1, 100000);
      assignArrStr('usersAllowlist');
      // marketsAllowlist lives under drift root
      if (body.marketsAllowlist !== undefined) {
        const arr = Array.isArray(body.marketsAllowlist)
          ? (body.marketsAllowlist as any[]).map((s: any) => String(s || '').trim()).filter(Boolean)
          : (typeof body.marketsAllowlist === 'string' ? String(body.marketsAllowlist).split(',').map(s => s.trim()).filter(Boolean) : undefined);
        if (arr) (CONFIG as any).drift.marketsAllowlist = arr;
      }

      // Optionally restart runner to apply trigger changes
      if (body.restart === true) {
        try {
          const { DriftLiquidatorRegistry } = await import('../drift/liquidator.js');
          const list = DriftLiquidatorRegistry.list();
          for (const r of list) {
            try { DriftLiquidatorRegistry.stop(r.key); } catch {}
            try { await DriftLiquidatorRegistry.start(r.key); } catch {}
          }
        } catch {}
      }

      res.json({ ok: true, config: (CONFIG as any).drift.liquidator, marketsAllowlist: (CONFIG as any).drift.marketsAllowlist || [] });
    } catch (e: any) {
      logger.error('drift-liq: set-config failed', { error: String(e?.message || e) });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // Drift Liquidator queue snapshot and markets
  api.get('/strategies/liquidator/queue', async (req: Request, res: Response) => {
    try {
      const limit = Number((req.query?.limit as string) || 20);
      const key = String((req.query?.key as string) || 'liq#default');
      const { DriftLiquidatorRegistry } = await import('../drift/liquidator.js');
      const r = DriftLiquidatorRegistry.get(key);
      if (!r) return res.json({ key, queue: { candidatesQueued: 0, top: [], markets: [], actionsLastMin: 0, errorsLastMin: 0 } });
      const queue = (r as any).getQueueSnapshot?.(limit) || { candidatesQueued: 0, top: [], markets: [], actionsLastMin: 0, errorsLastMin: 0 };
      res.json({ key, queue });
    } catch (e: any) {
      logger.error('drift-liq: queue failed', { error: String(e?.message || e), stack: String(e?.stack || '') });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // Fee configuration endpoints
  api.get('/fees/config', async (_req, res) => {
    try {
      const { CONFIG } = await import('../utils/config.js');
      res.json({ fees: CONFIG.fees });
    } catch (e: any) {
      logger.error('Failed to get fee config', { error: String(e) });
      res.status(500).json({ error: String(e) });
    }
  });

  api.post('/fees/config', async (req, res) => {
    try {
      const { 
        baseFee, priorityFee, maxFee, dynamicFees, feeMultiplier, minFee, maxFeeMultiplier,
        feeUpdateInterval, networkCongestionThreshold, jupiterPriorityFee, jupiterMaxAccounts,
        jupiterDynamicCompute, jupiterLegacyTransaction, jupiterSlippageBps, jupiterMaxSlippageBps
      } = req.body as {
        baseFee?: number;
        priorityFee?: number;
        maxFee?: number;
        dynamicFees?: boolean;
        feeMultiplier?: number;
        minFee?: number;
        maxFeeMultiplier?: number;
        feeUpdateInterval?: number;
        networkCongestionThreshold?: number;
        jupiterPriorityFee?: number;
        jupiterMaxAccounts?: number;
        jupiterDynamicCompute?: boolean;
        jupiterLegacyTransaction?: boolean;
        jupiterSlippageBps?: number;
        jupiterMaxSlippageBps?: number;
      };
      
      // Update CONFIG.fees
      if (baseFee !== undefined) CONFIG.fees.baseFee = Math.max(0, baseFee);
      if (priorityFee !== undefined) CONFIG.fees.priorityFee = Math.max(0, priorityFee);
      if (maxFee !== undefined) CONFIG.fees.maxFee = Math.max(0, maxFee);
      if (dynamicFees !== undefined) CONFIG.fees.dynamicFees = dynamicFees;
      if (feeMultiplier !== undefined) CONFIG.fees.feeMultiplier = Math.max(0.1, Math.min(10, feeMultiplier));
      if (minFee !== undefined) CONFIG.fees.minFee = Math.max(0, minFee);
      if (maxFeeMultiplier !== undefined) CONFIG.fees.maxFeeMultiplier = Math.max(1, Math.min(100, maxFeeMultiplier));
      if (feeUpdateInterval !== undefined) CONFIG.fees.feeUpdateInterval = Math.max(5000, Math.min(300000, feeUpdateInterval));
      if (networkCongestionThreshold !== undefined) CONFIG.fees.networkCongestionThreshold = Math.max(0.1, Math.min(1.0, networkCongestionThreshold));
      
      // Update Jupiter-specific settings
      if (jupiterPriorityFee !== undefined) CONFIG.fees.jupiterPriorityFee = Math.max(0, jupiterPriorityFee);
      if (jupiterMaxAccounts !== undefined) CONFIG.fees.jupiterMaxAccounts = Math.max(1, Math.min(256, jupiterMaxAccounts));
      if (jupiterDynamicCompute !== undefined) CONFIG.fees.jupiterDynamicCompute = jupiterDynamicCompute;
      if (jupiterLegacyTransaction !== undefined) CONFIG.fees.jupiterLegacyTransaction = jupiterLegacyTransaction;
      if (jupiterSlippageBps !== undefined) CONFIG.fees.jupiterSlippageBps = Math.max(1, Math.min(1000, jupiterSlippageBps));
      if (jupiterMaxSlippageBps !== undefined) CONFIG.fees.jupiterMaxSlippageBps = Math.max(1, Math.min(10000, jupiterMaxSlippageBps));
      
      res.json({ fees: CONFIG.fees });
      emit('log', { level: 'info', message: 'Fee configuration updated', timestamp: new Date().toISOString(), context: { ...CONFIG.fees, cat: 'terminal' } });
    } catch (e: any) {
      logger.error('server: failed to update fee config', { error: String(e), cat: 'server' });
      res.status(500).json({ error: String(e) });
    }
  });

  api.get('/fees/calculate', async (req, res) => {
    try {
      const { transactionType } = req.query as { transactionType?: 'swap' | 'send' | 'strategy' };
      const { getFeeCalculator } = await import('../utils/feeCalculator.js');
      const { getConnection } = await import('../wallet/wallet.js');
      const connection = getConnection();
      const calculator = getFeeCalculator(connection);
      
      const fees = await calculator.calculateFees();
      const recommendation = calculator.getFeeRecommendation(transactionType || 'strategy');
      
      res.json({ 
        current: fees, 
        recommendation,
        transactionType: transactionType || 'strategy'
      });
    } catch (e: any) {
      logger.error('server: failed to calculate fees', { error: String(e), cat: 'server' });
      res.status(500).json({ error: String(e) });
    }
  });

  api.post('/wallet/tokens', async (req, res) => {
    const { query } = req.body as { query: string };
    if (!query) return res.status(400).json({ error: 'query required' });
    const list = await readJson<any[]>(process.env.WALLET_TOKENS_PATH || 'backend/config/walletTokens.json', []);
    // Resolve using Token API V2
    try {
      const results = await (await import('../jupiter/tokenApi.js')).searchTokens(query, true);
      const entry = results[0];
      if (!entry) return res.status(404).json({ error: 'Token not found' });
      if (!list.find((t) => t.id === entry.id)) list.push(entry);
      await writeJson(CONFIG.walletTokensPath, list);
      res.json({ walletTokens: list, added: entry });
      emit('log', { level: 'info', message: `Wallet token added: ${entry.symbol}`, timestamp: new Date().toISOString(), context: entry, cat: 'wallet' });
    } catch (e: any) {
      res.status(500).json({ error: String(e) });
    }
  });

  // In-flight swap tracking
  const inflightSwaps = new Map<string, number>();
  const INFLIGHT_TIMEOUT_MS = 20000; // 20 seconds

  api.post('/swap', async (req, res) => {
    let swapKey: string | undefined;
    try {
      const { amount, from, to } = req.body as { amount: number | string; from: string; to: string };
      const amt = Number(amount);
      if (!from || !to || !isFinite(amt) || amt <= 0) {
        return res.status(400).json({ error: 'Invalid parameters. Usage: amount>0, from, to' });
      }
      const kp = await ensureWallet(CONFIG.walletPath);
      swapKey = `${kp.publicKey.toBase58()}:${from}:${to}`;
      
      // Check if swap is already in flight
      const now = Date.now();
      const lastSwap = inflightSwaps.get(swapKey);
      if (lastSwap && (now - lastSwap) < INFLIGHT_TIMEOUT_MS) {
        return res.status(429).json({ error: 'Swap already in progress for this pair. Please wait.' });
      }
      
      // Set in-flight flag
      inflightSwaps.set(swapKey, now);
      
      try {
        const fromInfo = await resolveMint(from);
        const toInfo = await resolveMint(to);
      const raw = Math.round(amt * Math.pow(10, fromInfo.decimals));
      // Fetch quote to compute expected outAmount for history
      const { getQuote } = await import('../jupiter/jupiter.js');
      const quote: any = await getQuote({ inputMint: fromInfo.mint, outputMint: toInfo.mint, amount: raw }, true);
      // Priority path: execute swap immediately (high-priority limiter lane)
      const swapResult = await executeSwap(
        { inputMint: fromInfo.mint, outputMint: toInfo.mint, amount: raw, userPublicKey: kp.publicKey.toBase58(), slippageBps: 100 },
        (serialized) => signAndSendSerializedTransaction(serialized, kp, undefined, 'swap'),
        true, // priority
        toInfo.decimals // output decimals for received amount
      );
      const sig = swapResult.signature;
      const outAmountRaw = Number(quote?.outAmount || 0);
      const lastPlan = Array.isArray(quote?.routePlan) && quote.routePlan.length > 0 ? quote.routePlan[quote.routePlan.length - 1] : null;
      const outDec = Number(lastPlan?.swapInfo?.outDecimals ?? toInfo.decimals ?? 6);
      const toAmount = outAmountRaw / Math.pow(10, outDec);
      res.json({ signature: sig });
      addWalletHistory({ type: 'swap', time: new Date().toISOString(), fromToken: from, fromAmount: amt, toToken: to, toAmount, signature: sig });
      emit('log', { level: 'info', message: `Swap executed: ${amt} ${from} -> ${to} (${sig})`, timestamp: new Date().toISOString() });
      emit('log', { level: 'info', message: `terminal: swap success ${amt} ${from}->${to} sig=${sig}`, timestamp: new Date().toISOString() });
      // Trigger wallet refresh after swap operation
      try {
        const { createWalletFeed } = await import('./walletFeed.js');
        const walletFeed = createWalletFeed(io);
        await walletFeed.refresh();
      } catch {}
      } finally {
        // Clear in-flight flag
        inflightSwaps.delete(swapKey);
      }
    } catch (e: any) {
      const msg = String(e?.message || e);
      if (msg === 'WALLET_NOT_FOUND') {
        return res.status(404).json({ error: 'Wallet not found. Generate one via /api/wallet/generate or terminal: wallet generate' });
      }
      logger.error('swap failed', { error: msg });
      res.status(500).json({ error: msg });
      emit('log', { level: 'error', message: `Swap failed: ${msg}`, timestamp: new Date().toISOString() });
      // Clear in-flight flag on error
      if (swapKey) {
        inflightSwaps.delete(swapKey);
      }
    }
  });

  // Wrap / Unwrap SOL
  api.post('/wallet/wrap', async (req, res) => {
    try {
      const { amount } = req.body as { amount: number };
      if (!amount || amount <= 0) return res.status(400).json({ error: 'amount > 0 required' });
      const { wrapSol } = await import('../wallet/wallet.js');
      const sig = await wrapSol(Number(amount));
      emit('log', { level: 'info', message: `terminal: wrap SOL success ${amount} sig=${sig}`, timestamp: new Date().toLocaleTimeString() });
      res.json({ signature: sig });
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });
  api.post('/wallet/unwrap', async (_req, res) => {
    try {
      const { unwrapSol } = await import('../wallet/wallet.js');
      const sig = await unwrapSol();
      emit('log', { level: 'info', message: `terminal: unwrap SOL success sig=${sig}`, timestamp: new Date().toLocaleTimeString() });
      res.json({ signature: sig });
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  api.get('/watchlist', async (_req, res) => {
    const watchlist = await readJson<any[]>(CONFIG.watchlistPath, []);
    res.json({ watchlist, walletHistory: getWalletHistory() });
  });

  api.post('/watchlist', async (req, res) => {
    try {
      const { query } = req.body as { query: string };
      const list = await readJson<any[]>(CONFIG.watchlistPath, []);
      let entry: any | null = null;
      if (query && query.length > 30) {
        const results = await searchTokens(query, true).catch(() => []);
        entry = results[0] || { id: query, symbol: query.slice(0, 4).toUpperCase(), name: query, decimals: 6 };
      } else {
        try {
          const results = await searchTokens(query, true);
          entry = results[0] || null;
        } catch (e: any) {
          // Fallback to local token resolver when API is paused/unavailable
          try {
            const r = await resolveMint(query);
            if (r?.mint) entry = { id: r.mint, symbol: query.toUpperCase(), name: query, decimals: (r as any).decimals ?? 6 };
          } catch {}
          if (!entry) {
            const msg = String(e?.message || e);
            if (msg.includes('API paused')) {
              emit('log', { level: 'warn', message: 'terminal: watchlist add blocked: API paused (run apistart or provide a mint address)', timestamp: new Date().toISOString() });
              return res.status(503).json({ error: 'API paused; run apistart or provide a mint address' });
            }
            throw e;
          }
        }
      }
      if (!entry) return res.status(404).json({ error: 'Token not found' });
      if (!list.find((t) => t.id === entry.id)) list.push(entry);
      await writeJson(CONFIG.watchlistPath, list);
      res.json({ watchlist: list, added: entry });
      io.emit('watchlist-update', list);
      emit('log', { level: 'info', message: `Added to watchlist: ${entry.symbol || entry.id}`, timestamp: new Date().toISOString(), context: entry });
      enablePriceFeed(true);
      try { await pollPriceFeedNow(); } catch {}
    } catch (e: any) {
      logger.error('watchlist add failed', { error: String(e) });
      res.status(500).json({ error: String(e) });
    }
  });

  api.delete('/watchlist', async (req, res) => {
    const { idOrSymbol } = req.body as { idOrSymbol: string };
    const list = await readJson<any[]>(CONFIG.watchlistPath, []);
    const upper = idOrSymbol?.toUpperCase?.() || '';
    const updated = list.filter((t) => {
      if (typeof t === 'string') {
        // legacy string entries (symbol or mint)
        return t !== idOrSymbol && t.toUpperCase() !== upper;
      }
      return t.id !== idOrSymbol && (t.symbol?.toUpperCase?.() || '') !== upper;
    });
    await writeJson(CONFIG.watchlistPath, updated);
    res.json({ watchlist: updated, removed: idOrSymbol });
    io.emit('watchlist-update', updated);
    emit('log', { level: 'info', message: `Removed from watchlist: ${idOrSymbol}` , timestamp: new Date().toISOString()});
    if (updated.length === 0) enablePriceFeed(false);
    else { try { await pollPriceFeedNow(); } catch {} }
  });

  // Token search endpoint
  api.get('/tokens/search', async (req, res) => {
    try {
      const { query } = req.query as { query: string };
      if (!query) return res.status(400).json({ error: 'query required' });
      
      const results = await searchTokens(query, true);
      res.json(results);
    } catch (e: any) {
      logger.error('token search failed', { error: String(e) });
      res.status(500).json({ error: String(e) });
    }
  });

  api.get('/prices', async (_req, res) => {
    // Simple in-memory; in a more robust design we'd inject a singleton feed
    res.json({ message: 'Use websocket for live prices' });
  });

  // Graph snapshot for frontend visualization
  api.get('/graph', async (_req, res) => {
    try {
      const snap = await getGraphSnapshot(false);
      res.json(snap);
    } catch (e: any) {
      logger.error('graph snapshot failed', { error: String(e?.message || e) });
      res.status(500).json({ version: 0, timestamp: Date.now(), nodes: [], edges: [] });
    }
  });

  // Simple path endpoint for highlighting routes
  api.get('/graph/path', async (req, res) => {
    try {
      const { from, to } = req.query as { from?: string; to?: string };
      if (!from || !to) return res.status(400).json({ error: 'from and to required' });
      const { path } = await findPath(from, to);
      res.json({ path });
    } catch (e: any) {
      res.status(500).json({ path: [] });
    }
  });

  // Raydium pools (normalized) for arb-rs bridge
  api.get('/arb/pools/raydium', async (req, res) => {
    try {
      // Optional per-request TVL overrides
      const q = (req.query || {}) as { minUsd?: string; minAmm?: string; minClmm?: string; unknown?: string; anchor?: string };
      const prevAmm = Number((CONFIG.raydium as any)?.minAmmLiqBase || 0);
      const prevClmm = Number((CONFIG.raydium as any)?.minClmmLiquidity || 0);
      const prevAnchors = Array.isArray((CONFIG.raydium as any)?.anchorMints) ? ([...((CONFIG.raydium as any).anchorMints as string[])]) : undefined;
      const prevUseAnchor = (CONFIG.raydium as any)?.useAnchorDiscovery;
      let restore = false;
      try {
        if (q.minAmm != null) { (CONFIG.raydium as any).minAmmLiqBase = Math.max(0, Number(q.minAmm)); restore = true; }
        if (q.minClmm != null) { (CONFIG.raydium as any).minClmmLiquidity = Math.max(0, Number(q.minClmm)); restore = true; }
        if (typeof q.anchor === 'string' && q.anchor.trim()) {
          const list = q.anchor.split(',').map(s => s.trim()).filter(Boolean);
          if (list.length) { (CONFIG.raydium as any).anchorMints = list; (CONFIG.raydium as any).useAnchorDiscovery = true; restore = true; }
        }
      } catch {}
      const pools = await getRaydiumPoolsNormalized(false);
      // Restore config if overridden for this request
      try { if (restore) { (CONFIG.raydium as any).minAmmLiqBase = prevAmm; (CONFIG.raydium as any).minClmmLiquidity = prevClmm; if (prevAnchors) (CONFIG.raydium as any).anchorMints = prevAnchors; if (prevUseAnchor !== undefined) (CONFIG.raydium as any).useAnchorDiscovery = prevUseAnchor; } } catch {}
      // Optional route-level scoping to avoid double filtering
      let out = pools;
      const routeScope = !!((CONFIG.system as any)?.routeLevelScoping);
      if (routeScope) {
        try {
          const mode = String((CONFIG.system as any)?.scopePoolsMode || 'jupiter');
          if (mode !== 'none') {
            const { computeTokenUniverse, filterPoolsByUniverse } = await import('./universe.js');
            const universe = await computeTokenUniverse(mode as any);
            const filtered = filterPoolsByUniverse(pools as any, universe, !!((CONFIG.system as any)?.enableAnchorBridging));
            const upstreamCount = (pools.amm?.length || 0) + (pools.clmm?.length || 0);
            const scopedCount = (filtered.amm.length || 0) + (filtered.clmm.length || 0);
            out = (upstreamCount > 0 && scopedCount === 0) ? pools : (filtered as any);
          }
        } catch {}
      }
      res.json(out);
    } catch (e: any) {
      logger.error('raydium pools fetch failed', { error: String(e?.message || e) });
      res.status(503).json({ amm: [], clmm: [] });
    }
  });

  // Debug endpoint: compare mints from different sources for a given pool id
  api.get('/debug/pool/:id', async (req, res) => {
    try {
      const id = String(req.params.id || '');
      if (!id) return res.status(400).json({ error: 'id required' });
      const { Connection, PublicKey } = await import('@solana/web3.js');
      const conn = new Connection(CONFIG.rpcUrl, 'confirmed');
      const pk = new PublicKey(id);
      const info = await conn.getAccountInfo(pk, { commitment: 'confirmed' } as any);
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
          const owner = (await import('@solana/web3.js')).Keypair.generate();
          const raydium = await Raydium.load({ connection: conn, owner, disableLoadToken: true });
          const r = await (raydium as any).api.fetchPoolById({ ids: id }).catch(() => null);
          const it = Array.isArray(r?.data) ? r.data[0] : (Array.isArray(r) ? r[0] : null);
          const toB58 = (v: any) => (v?.toBase58?.() || v?.toString?.()?.replace(/^PublicKey\(([^)]+)\)$/, '$1') || (typeof v === 'string' ? v : ''));
          if (it) sdk = { mintA: toB58(it?.mintA?.address || it?.mintA || it?.tokenMintA), mintB: toB58(it?.mintB?.address || it?.mintB || it?.tokenMintB), programId: String(it?.programId || it?.programID || '') };
        }
      } catch {}
      const pools = await getRaydiumPoolsNormalized(false);
      const norm = { amm: pools.amm.find(p => p.id === id), clmm: pools.clmm.find(p => p.id === id) };
      res.json({ id, onchain, sdk, norm });
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  api.get('/arb/pools/orca', async (_req, res) => {
    try {
      const pools = await getOrcaPoolsCached(false);
      // Optional route-level scoping
      let out = pools;
      const routeScope = !!((CONFIG.system as any)?.routeLevelScoping);
      if (routeScope) {
        try {
          const mode = String((CONFIG.system as any)?.scopePoolsMode || 'jupiter');
          if (mode !== 'none') {
            const { computeTokenUniverse, filterPoolsByUniverse } = await import('./universe.js');
            const universe = await computeTokenUniverse(mode as any);
            const filtered = filterPoolsByUniverse(pools as any, universe, !!((CONFIG.system as any)?.enableAnchorBridging));
            const upstreamCount = (pools.amm?.length || 0) + (pools.clmm?.length || 0);
            const scopedCount = (filtered.amm.length || 0) + (filtered.clmm.length || 0);
            out = (upstreamCount > 0 && scopedCount === 0) ? pools : (filtered as any);
          }
        } catch {}
      }
      res.json(out);
    } catch (e: any) {
      logger.error('orca pools fetch failed', { error: String(e?.message || e) });
      res.status(503).json({ amm: [], clmm: [] });
    }
  });

  // Meteora pools (normalized) for arb bridge
  api.get('/arb/pools/meteora', async (_req, res) => {
    try {
      const pools = await getMeteoraPoolsCached(false);
      // Optional route-level scoping
      let out = pools;
      const routeScope = !!((CONFIG.system as any)?.routeLevelScoping);
      if (routeScope) {
        try {
          const mode = String((CONFIG.system as any)?.scopePoolsMode || 'jupiter');
          if (mode !== 'none') {
            const { computeTokenUniverse, filterPoolsByUniverse } = await import('./universe.js');
            const universe = await computeTokenUniverse(mode as any);
            const filtered = filterPoolsByUniverse(pools as any, universe, !!((CONFIG.system as any)?.enableAnchorBridging));
            const upstreamCount = (pools.amm?.length || 0) + (pools.clmm?.length || 0);
            const scopedCount = (filtered.amm.length || 0) + (filtered.clmm.length || 0);
            out = (upstreamCount > 0 && scopedCount === 0) ? pools : (filtered as any);
          }
        } catch {}
      }
      res.json(out);
    } catch (e: any) {
      logger.error('meteora pools fetch failed', { error: String(e?.message || e) });
      res.status(503).json({ amm: [], clmm: [] });
    }
  });

  // Diagnostics: token universe overlap and diffs
  api.get('/arb/pools/universe/diagnostics', async (_req, res) => {
    try {
      const { computeTokenUniverse, getSourceTokenSet, getJupiterTokenSet, getWatchlistTokenSet } = await import('./universe.js');
      const uni = await computeTokenUniverse((CONFIG.system as any)?.tokenUniverseMode);
      const ray = await getSourceTokenSet('raydium');
      const orc = await getSourceTokenSet('orca');
      const jup = await getJupiterTokenSet();
      const wli = await getWatchlistTokenSet();
      const onlyRay: string[] = []; const onlyOrc: string[] = []; const overlap: string[] = [];
      const all = new Set<string>([...ray, ...orc]);
      for (const m of all) {
        if (ray.has(m) && orc.has(m)) overlap.push(m);
        else if (ray.has(m)) onlyRay.push(m); else onlyOrc.push(m);
      }
      res.json({
        mode: (CONFIG.system as any)?.tokenUniverseMode,
        sizes: { universe: uni.size, raydium: ray.size, orca: orc.size, jupiter: jup.size, watchlist: wli.size },
        onlyRay, onlyOrc, overlapCount: overlap.length, anchorBridging: !!((CONFIG.system as any)?.enableAnchorBridging), canon: (CONFIG.system as any)?.canonicalizePairs || 'none',
      });
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // Force refresh pools (Raydium and/or Orca)
  // Simple debounce to prevent spammed refreshes
  const lastRefresh: { raydium: number; orca: number; meteora: number } = { raydium: 0, orca: 0, meteora: 0 };
  api.post('/arb/pools/refresh', async (req, res) => {
    try {
      const { source, subscribe } = (req.body || {}) as { source?: 'raydium' | 'orca' | 'meteora' | 'all'; subscribe?: boolean };
      const wantRay = !source || source === 'all' || source === 'raydium';
      const wantOrc = !source || source === 'all' || source === 'orca';
      const wantMet = !source || source === 'all' || source === 'meteora';
      const t0 = Date.now();
      const minGap = Number((CONFIG.system as any)?.poolRefreshMinGapMs || 3000);
      const now = Date.now();
      const tasks: Array<Promise<any>> = [];
      let ray: any = null; let orc: any = null; let met: any = null;
      if (wantRay && now - lastRefresh.raydium >= minGap) {
        lastRefresh.raydium = now;
        tasks.push(getRaydiumPoolsNormalized(true).then(r => { ray = r; }).catch(() => { ray = { amm: [], clmm: [] }; }));
      }
      if (wantOrc && now - lastRefresh.orca >= minGap) {
        lastRefresh.orca = now;
        tasks.push(getOrcaPoolsCached(true).then(o => { orc = o; }).catch(() => { orc = { amm: [], clmm: [] }; }));
      }
      if (wantMet && now - lastRefresh.meteora >= minGap) {
        lastRefresh.meteora = now;
        tasks.push(getMeteoraPoolsCached(true).then(m => { met = m; }).catch(() => { met = { amm: [], clmm: [] }; }));
      }
      await Promise.all(tasks);
      // Optional: idempotent subscribe step after refresh when all sources requested
      if ((!source || source === 'all') && (subscribe !== false)) {
        try { (await import('./pools.js')).enablePoolWebsocketRefreshes(); } catch {}
        try { (await import('./pools.js')).startRaydiumRefreshLoop(); } catch {}
      }
      // After pools refresh, build a fresh graph snapshot and emit to clients
      let graph: any = null;
      try {
        const snap = await (await import('./graph.js')).getGraphSnapshot(true);
        graph = { version: snap.version, nodes: snap.nodes.length, edges: snap.edges.length };
        try { io.emit('graph-snapshot', snap); } catch {}
        // Also push snapshot to arb-rs and trigger a refresh so backend-graph mode stays current
        try {
          const { pushArbGraphSnapshot, notifyArbServiceRefresh } = await import('./realtime.js');
          try { await pushArbGraphSnapshot(snap); } catch {}
          try { await notifyArbServiceRefresh(); } catch {}
          try {
            logger.info('arb.push snapshot forwarded', { version: snap.version, nodes: snap.nodes.length, edges: snap.edges.length, cat: 'arb' });
            emit('log', { level: 'info', message: `arb:push snapshot v=${snap.version} nodes=${snap.nodes.length} edges=${snap.edges.length}` as any, timestamp: new Date().toISOString(), context: { cat: 'arb' } });
          } catch {}
        } catch {}
      } catch {}
      const ms = Date.now() - t0;
      res.json({ ok: true, ms, raydium: ray ? { amm: ray.amm.length, clmm: ray.clmm.length } : null, orca: orc ? { amm: orc.amm.length, clmm: orc.clmm.length } : null, graph });
      try { emit('log', { level: 'info', message: `arb:pools refresh ${source||'all'} ok ms=${ms}`, timestamp: new Date().toISOString(), context: { cat: 'arb' } }); } catch {}
    } catch (e: any) {
      logger.error('pools refresh failed', { error: String(e?.message || e) });
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // Pool websocket subscriptions control (idempotent)
  api.post('/arb/pools/subscribe', async (_req, res) => {
    try {
      // Enable WS and start loop (idempotent)
      try { (await import('./pools.js')).enablePoolWebsocketRefreshes(); } catch {}
      try { (await import('./pools.js')).startRaydiumRefreshLoop(); } catch {}
      res.json({ ok: true });
      try { emit('log', { level: 'info', message: 'pools:subscribe ok', timestamp: new Date().toISOString(), context: { cat: 'pools' } }); } catch {}
      // Schedule a graph rebuild shortly after subscription to propagate any immediate changes
      try {
        const { scheduleGraphRebuild } = await import('./graph.js');
        scheduleGraphRebuild(io, 250);
      } catch {}
    } catch (e: any) {
      logger.error('pools subscribe failed', { error: String(e?.message || e) });
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  api.post('/arb/pools/unsubscribe', async (_req, res) => {
    try {
      // Stop all pool activity
      try { (await import('./pools.js')).stopPoolRefreshLoop(); } catch {}
      res.json({ ok: true });
      try { emit('log', { level: 'info', message: 'pools:unsubscribe ok', timestamp: new Date().toISOString(), context: { cat: 'pools' } }); } catch {}
    } catch (e: any) {
      logger.error('pools unsubscribe failed', { error: String(e?.message || e) });
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  api.get('/arb/pools/subscriptions', async (_req, res) => {
    try {
      const cfg = (CONFIG as any)?.system || {};
      const { getPoolWsStatus, getWsActivity } = await import('./pools.js');
      const st = getPoolWsStatus();
      const act = getWsActivity();
      res.json({ enablePoolWs: !!cfg.enablePoolWs, healthy: !!st.healthy, lastEventMs: st.lastEventMs, orca: act.orca, raydium: act.raydium, meteora: act.meteora });
    } catch (e: any) {
      res.status(200).json({ enablePoolWs: false, healthy: false, lastEventMs: 0, orca: { attached: 0, events: 0 }, raydium: { attached: 0, events: 0 }, meteora: { attached: 0, events: 0 } });
    }
  });

  // Graph version endpoint for arb-rs freshness checks
  api.get('/arb/graph/version', async (_req, res) => {
    try {
      const { getGraphVersion } = await import('./graph.js');
      const v = getGraphVersion();
      res.json(v);
    } catch (e: any) {
      res.status(200).json({ version: 0, timestamp: 0 });
    }
  });

  // Arbitrage opportunities proxy to Rust service (MVP)
  api.get('/arb/opportunities', async (_req, res) => {
    try {
      const host = process.env.ARB_SERVICE_URL || 'http://127.0.0.1:4010';
      const started = Date.now();
      logger.info(`api.request GET /arb-service/opportunities`, { url: `${host}/opportunities`, cat: 'api' });
      const r = await (async () => { const ac = new AbortController(); const t = setTimeout(() => ac.abort('timeout'), 7000); try { return await fetch(`${host}/opportunities`, { headers: { 'accept': 'application/json' }, signal: ac.signal }); } finally { clearTimeout(t); } })();
      logger.info(`api.response GET /arb-service/opportunities ${r.status} ${Date.now()-started}ms`, { status: r.status, cat: 'api' });
      if (!r.ok) return res.status(502).json({ error: `arb service ${r.status}` });
      const json = await r.json();
      res.json(json);
    } catch (e: any) {
      logger.error('arb opportunities proxy failed', { error: String(e?.message || e) });
      res.status(500).json({ error: 'arb service unreachable' });
    }
  });

  // Optional: Arbitrage service health passthrough
  api.get('/arb/health', async (_req, res) => {
    try {
      const host = process.env.ARB_SERVICE_URL || 'http://127.0.0.1:4010';
      logger.info(`api.request GET /arb-service/health`, { url: `${host}/health`, cat: 'api' });
      const started = Date.now();
      const r = await fetch(`${host}/health`, { headers: { 'accept': 'application/json' } });
      logger.info(`api.response GET /arb-service/health ${r.status} ${Date.now()-started}ms`, { status: r.status, cat: 'api' });
      const json: any = await r.json();
      // Health up/down transition logging
      const status = (json?.status || (r.ok ? 'up' : 'down')).toString();
      if (status !== lastArbHealthStatus) {
        lastArbHealthStatus = status;
        emit('log', { level: status === 'up' ? 'info' : 'warn', message: `arb:health ${status}`, timestamp: new Date().toISOString(), context: { cat: 'arb' } });
      }
      res.status(r.status).json(json);
    } catch (e: any) {
      res.status(503).json({ status: 'down' });
    }
  });

  // Arbitrage config GET passthrough
  api.get('/arb/config', async (_req, res) => {
    try {
      const host = process.env.ARB_SERVICE_URL || 'http://127.0.0.1:4010';
      logger.info(`api.request GET /arb-service/config`, { url: `${host}/config`, cat: 'api' });
      const started = Date.now();
      const r = await (async () => { const ac = new AbortController(); const t = setTimeout(() => ac.abort('timeout'), 7000); try { return await fetch(`${host}/config`, { headers: { 'accept': 'application/json' }, signal: ac.signal }); } finally { clearTimeout(t); } })();
      logger.info(`api.response GET /arb-service/config ${r.status} ${Date.now()-started}ms`, { status: r.status, cat: 'api' });
      let json: any = {};
      try {
        const ct = r.headers.get('content-type') || '';
        if (ct.includes('application/json')) json = await r.json();
        else json = { ok: r.ok, text: await r.text().catch(() => '') };
      } catch { json = {}; }
      // Persist a local copy for durability
      try { await writeJson('backend/config/arbConfig.json', json); } catch {}
      try {
        const mode = (json?.execution_mode || 'unknown').toString();
        const minBps = typeof json?.min_profit_bps === 'number' ? json.min_profit_bps : undefined;
        const allowLen = Array.isArray(json?.dex_allowlist) ? json.dex_allowlist.length : undefined;
        const denyLen = Array.isArray(json?.dex_denylist) ? json.dex_denylist.length : undefined;
        emit('log', { level: 'info', message: `arb:config mode=${mode}${minBps!==undefined?` minBps=${minBps}`:''}${allowLen!==undefined?` allow=${allowLen}`:''}${denyLen!==undefined?` deny=${denyLen}`:''}`, timestamp: new Date().toISOString(), context: { cat: 'arb' } });
      } catch {}
      res.status(r.status).json(json);
    } catch (e: any) {
      // Fallback to locally persisted config, if any
      try {
        const local = await readJson<any>('backend/config/arbConfig.json', {} as any);
        if (local && Object.keys(local).length > 0) return res.status(200).json(local);
      } catch {}
      res.status(503).json({ ok: false, error: 'arb service unreachable' });
    }
  });

  // Arbitrage metrics passthroughs
  api.get('/arb/metrics', async (_req, res) => {
    try {
      const host = process.env.ARB_SERVICE_URL || 'http://127.0.0.1:4010';
      logger.info(`api.request GET /arb-service/metrics`, { url: `${host}/metrics`, cat: 'api' });
      const started = Date.now();
      const r = await (async () => { const ac = new AbortController(); const t = setTimeout(() => ac.abort('timeout'), 3000); try { return await fetch(`${host}/metrics`, { signal: ac.signal }); } finally { clearTimeout(t); } })();
      const dur = Date.now()-started;
      logger.info(`api.response GET /arb-service/metrics ${r.status} ${dur}ms`, { status: r.status, cat: 'api' });
      try { arbLatency.metrics.push(dur); if (arbLatency.metrics.length > 200) arbLatency.metrics.shift(); } catch {}
      const text = await r.text();
      res.status(r.status).type('text/plain').send(text);
    } catch (e: any) {
      res.status(503).type('text/plain').send('');
    }
  });

  api.get('/arb/metrics/json', async (_req, res) => {
    try {
      const host = process.env.ARB_SERVICE_URL || 'http://127.0.0.1:4010';
      logger.info(`api.request GET /arb-service/metrics/json`, { url: `${host}/metrics/json`, cat: 'api' });
      const started = Date.now();
      const r = await (async () => { const ac = new AbortController(); const t = setTimeout(() => ac.abort('timeout'), 3000); try { return await fetch(`${host}/metrics/json`, { headers: { 'accept': 'application/json' }, signal: ac.signal }); } finally { clearTimeout(t); } })();
      const dur = Date.now()-started;
      logger.info(`api.response GET /arb-service/metrics/json ${r.status} ${dur}ms`, { status: r.status, cat: 'api' });
      try { arbLatency.metrics.push(dur); if (arbLatency.metrics.length > 200) arbLatency.metrics.shift(); } catch {}
      let json: any = {};
      try { json = await r.json(); } catch { json = {}; }
      try {
        const pools = getPoolsMetrics();
        json = { ...json, pools };
      } catch {}
      try {
        const snap = await getGraphSnapshot(false);
        json = { ...json, backend_graph_nodes: snap.nodes.length, backend_graph_edges: snap.edges.length, backend_graph_timestamp: snap.timestamp };
      } catch {}
      try {
        json = { ...json, sanity: (CONFIG as any).sanity };
      } catch {}
      res.status(r.status).json(json);
    } catch (e: any) {
      try {
        const pools = getPoolsMetrics();
        try {
          const snap = await getGraphSnapshot(false);
          return res.status(200).json({ pools, backend_graph_nodes: snap.nodes.length, backend_graph_edges: snap.edges.length, backend_graph_timestamp: snap.timestamp });
        } catch {}
        return res.status(200).json({ pools });
      } catch {}
      res.status(503).json({});
    }
  });

  // Start arbitrage engine: build current graph snapshot and forward to arb-rs
  api.post('/arb/start', async (req, res) => {
    try {
      const host = process.env.ARB_SERVICE_URL || 'http://127.0.0.1:4010';
      const { getGraphSnapshot } = await import('./graph.js');
      // Do not auto-subscribe or start refresh loops here; respect explicit subscribe API
      const snap = await getGraphSnapshot(true);
      // Optional toggle mode: if client sends { enable: false } then forward stop
      const wantEnable = (req.body && typeof req.body.enable === 'boolean') ? !!req.body.enable : true;
      const payload = wantEnable ? ({ graph: snap, enable: true } as any) : ({ enable: false } as any);
      const started = Date.now();
      const r = await (async () => { const ac = new AbortController(); const t = setTimeout(() => ac.abort('timeout'), 8000); try { return await fetch(`${host}/arb/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: ac.signal }); } finally { clearTimeout(t); } })();
      const ms = Date.now() - started;
      try { emit('log', { level: r.ok ? 'info' : 'warn', message: `arb:${wantEnable?'start':'stop'} forwarded ${r.status} ms=${ms} nodes=${snap.nodes.length} edges=${snap.edges.length}`, timestamp: new Date().toISOString(), context: { cat: 'arb' } }); } catch {}
      if (!r.ok) return res.status(502).json({ ok: false, status: r.status });
      let json: any = {}; try { json = await r.json(); } catch {}
      res.json({ ok: true, forwarded: json, graph: { nodes: snap.nodes.length, edges: snap.edges.length } });
    } catch (e: any) {
      logger.error('arb start failed', { error: String(e?.message || e) });
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // Simulate arbitrage route with Jupiter v6 quotes
  api.post('/arb/simulate', async (req, res) => {
    try {
      const { path, sizeInMint, size, sizeUi, sizeUsd, slippageBps = 100 } = req.body as { path: string[]; sizeInMint?: string; size?: number; sizeUi?: number; sizeUsd?: number; slippageBps?: number };
      if (!Array.isArray(path) || path.length < 2) return res.status(400).json({ error: 'path length >= 2 required' });
      const { getV6Quote } = await import('../jupiter/v6.js');
      const cid = `arb-${Date.now().toString(36)}-${Math.floor(Math.random()*1e6).toString(36)}`;
      emit('log', { level: 'info', message: `pretrade:arb simulate start cid=${cid} hops=${path.length-1} size=${size}${sizeInMint?` sizeInMint=${sizeInMint}`:''} slippageBps=${slippageBps}`, timestamp: new Date().toISOString(), context: { cat: 'pretrade' } });
      const legs: any[] = [];
      const tStartAll = Date.now();
      let prevOutAmt = 0;
      for (let i = 0; i < path.length - 1; i += 1) {
        const inputMint = path[i];
        const outputMint = path[i + 1];
        // Determine first hop amount (smallest units). Support multiple input styles:
        // - sizeUsd: USD notional converted using input mint price and decimals
        // - sizeUi: UI tokens converted using input mint decimals
        // - size: raw smallest units (back-compat)
        let amt = 0;
        if (i === 0) {
          try {
            if (typeof sizeUsd === 'number' && sizeUsd > 0) {
              const info = await resolveMint(inputMint);
              const price = getPriceByMint(inputMint)?.usdc || null;
              if (!price) throw new Error(`no price for ${inputMint}`);
              const tokens = sizeUsd / price;
              amt = Math.max(1, Math.floor(tokens * Math.pow(10, info.decimals || 9)));
              emit('log', { level: 'info', message: `pretrade:arb simulate amount from USD in=${inputMint} usd=${sizeUsd} dec=${info.decimals} amt=${amt}`, timestamp: new Date().toISOString(), context: { cat: 'pretrade' } });
            } else if (typeof sizeUi === 'number' && sizeUi > 0) {
              const info = await resolveMint(inputMint);
              amt = Math.max(1, Math.floor(sizeUi * Math.pow(10, info.decimals || 9)));
              emit('log', { level: 'info', message: `pretrade:arb simulate amount from UI in=${inputMint} ui=${sizeUi} dec=${info.decimals} amt=${amt}`, timestamp: new Date().toISOString(), context: { cat: 'pretrade' } });
            } else {
              amt = Math.max(1, Math.floor(Number(size) || 0));
              emit('log', { level: 'info', message: `pretrade:arb simulate amount raw in=${inputMint} raw=${size} amt=${amt}`, timestamp: new Date().toISOString(), context: { cat: 'pretrade' } });
            }
          } catch (e: any) {
            return res.status(400).json({ error: `size conversion failed: ${String(e?.message || e)}` });
          }
        } else {
          amt = Math.max(1, Math.floor(prevOutAmt));
        }
        const t0 = Date.now();
        const quote = await getV6Quote(inputMint, outputMint, amt, slippageBps);
        const qDur = Date.now() - t0;
        legs.push({ inputMint, outputMint, quote });
        const outAmt = Number(quote?.outAmount || 0);
        const inAmt = Number(quote?.inAmount || 0) || amt;
        const outDec = Number(quote?.routePlan?.[quote?.routePlan?.length - 1]?.swapInfo?.outDecimals ?? '');
        emit('log', { level: 'info', message: `pretrade:arb leg${i+1} cid=${cid} ${inputMint.slice(0,4)}->${outputMint.slice(0,4)} in=${inAmt} out=${outAmt}${outDec?` outDec=${outDec}`:''} durMs=${qDur}`, timestamp: new Date().toISOString(), context: { cat: 'pretrade' } });
        prevOutAmt = outAmt;
      }
      // compute rough net bps (placeholder, better from quotes)
      let rateProd = 1.0;
      for (let i = 0; i < legs.length; i += 1) {
        const l = legs[i];
        const outRaw = Number(l.quote?.outAmount || 0);
        const inRaw = Number(l.quote?.inAmount || 0);
        if (outRaw > 0 && inRaw > 0) rateProd *= (outRaw / inRaw);
      }
      const netBps = Math.floor((rateProd - 1.0) * 10_000);
      emit('log', { level: 'info', message: `pretrade:arb simulate result cid=${cid} hops=${legs.length} netBps=${netBps} totalMs=${Date.now()-tStartAll}`, timestamp: new Date().toISOString(), context: { cat: 'pretrade' } });
      res.json({ legs, netBps });
    } catch (e: any) {
      logger.error('arb simulate failed', { error: String(e?.message || e) });
      emit('log', { level: 'error', message: `terminal: arb simulate failed ${String(e?.message || e)}`, timestamp: new Date().toISOString() });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // Execute arbitrage route: compose single v0 transaction with all hops
  api.post('/arb/execute', async (req, res) => {
    try {
      const { path, size, sizeUsd, slippageBps = 100, priorityFeeMicroLamports = 0 } = req.body as { path: string[]; size?: number; sizeUsd?: number; slippageBps?: number; priorityFeeMicroLamports?: number };
      if (!Array.isArray(path) || path.length < 2) return res.status(400).json({ error: 'path length >= 2 required' });
      const kp = await ensureWallet(CONFIG.walletPath);
      const { getV6Quote, getSwapInstructions, buildCombinedTransaction } = await import('../jupiter/v6.js');
      const { getAssociatedTokenAddress, createAssociatedTokenAccountIdempotentInstruction, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } = await import('@solana/spl-token');
      const connection = getConnection();
      // Type-safe read of arb service config
      type ArbServiceConfig = { execution_mode?: string };
      let execMode = 'simulate';
      try {
        const cfgResp = await fetch((process.env.ARB_SERVICE_URL || 'http://127.0.0.1:4010') + '/config', { headers: { 'accept': 'application/json' } })
          .then(r => r.json() as Promise<unknown>)
          .catch(() => ({} as unknown));
        const cfg = (cfgResp as Partial<ArbServiceConfig>) || {};
        execMode = String(cfg.execution_mode || 'simulate');
      } catch {}
      const cid = `arb-${Date.now().toString(36)}-${Math.floor(Math.random()*1e6).toString(36)}`;
      emit('log', { level: 'info', message: `pretrade:arb execute start cid=${cid} hops=${path.length-1} size=${size??'-'} sizeUsd=${sizeUsd??'-'} mode=${execMode} slipBps=${slippageBps} cuPrice=${priorityFeeMicroLamports}`, timestamp: new Date().toISOString(), context: { cat: 'pretrade' } });
      const legs: any[] = [];
      // Build legs
      for (let i = 0; i < path.length - 1; i += 1) {
        const inputMint = path[i];
        const outputMint = path[i + 1];
        // Compute first hop amount in smallest units. If sizeUsd provided and first output is USDC, convert.
        let amt = 0;
        if (i === 0) {
          if (typeof size === 'number' && size > 0) {
            // Convert tokens -> smallest by resolving decimals when possible
            const inInfo = await resolveMint(inputMint);
            amt = Math.max(1, Math.floor(size * Math.pow(10, inInfo.decimals || 9)));
          } else if (typeof sizeUsd === 'number' && sizeUsd > 0) {
            const inInfo = await resolveMint(inputMint);
            const price = getPriceByMint(inputMint)?.usdc || null;
            if (!price) return res.status(400).json({ error: `no price for ${inputMint}` });
            const tokens = sizeUsd / price;
            amt = Math.max(1, Math.floor(tokens * Math.pow(10, inInfo.decimals || 9)));
          } else {
            return res.status(400).json({ error: 'size or sizeUsd required' });
          }
        } else {
          amt = Number(legs[i - 1]?.quote?.outAmount || 0);
        }
        const t0 = Date.now();
        const quote = await getV6Quote(inputMint, outputMint, amt, slippageBps);
        const qDur = Date.now() - t0;
        const instructions: any = await getSwapInstructions(quote, kp.publicKey.toBase58(), true);
        legs.push({ inputMint, outputMint, quote, instructions });
        const outAmt = Number(quote?.outAmount || 0);
        const inAmt = Number(quote?.inAmount || 0) || amt;
        const ixCount = ((instructions && instructions.setupInstructions?.length) || 0) + ((instructions && instructions.cleanupInstructions?.length) || 0) + ((instructions && instructions.swapInstruction) ? 1 : 0);
        emit('log', { level: 'info', message: `pretrade:arb leg${i+1} cid=${cid} ${inputMint.slice(0,4)}->${outputMint.slice(0,4)} in=${inAmt} out=${outAmt} ixs=${ixCount} qMs=${qDur}`, timestamp: new Date().toISOString(), context: { cat: 'pretrade' } });
      }
      if (execMode === 'simulate') {
        emit('log', { level: 'info', message: `pretrade:arb decision skip execute (simulate mode)`, timestamp: new Date().toISOString() });
        return res.json({ simulated: true, legs });
      }
      // Ensure ATAs for all path mints (both input and output of each hop), and any fee/intermediate recipient mints, excluding native SOL
      const extraSetup: any[] = [];
      try {
        const { PublicKey } = await import('@solana/web3.js');
        const SOL = 'So11111111111111111111111111111111111111112';
        const mintSet = new Set<string>();
        for (let i = 0; i < path.length; i += 1) { const m = String(path[i] || ''); if (m && m !== SOL) mintSet.add(m); }
        // Extract mints from routePlan (output mints, fee mints)
        try {
          const outMints: string[] = [];
          for (const leg of legs) {
            const rp = (leg?.quote?.routePlan || []) as any[];
            for (const step of rp) {
              const out = String(step?.swapInfo?.outputMint || '');
              if (out && out !== SOL) outMints.push(out);
              const fee = String(step?.swapInfo?.feeMint || '');
              if (fee && fee !== SOL) outMints.push(fee);
            }
          }
          for (const m of outMints) mintSet.add(m);
        } catch {}
        for (const m of mintSet) {
          try {
            const mintPk = new PublicKey(m);
            const info = await connection.getAccountInfo(mintPk);
            const isToken2022 = info?.owner?.toBase58?.() === TOKEN_2022_PROGRAM_ID.toBase58();
            const tokenProgramId = isToken2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
            const ata = await getAssociatedTokenAddress(mintPk, kp.publicKey, false, tokenProgramId);
            extraSetup.push(createAssociatedTokenAccountIdempotentInstruction(kp.publicKey, ata, kp.publicKey, mintPk, tokenProgramId));
            emit('log', { level: 'info', message: `pretrade:arb ata precreate mint=${m} prog=${tokenProgramId.toBase58()}`, timestamp: new Date().toISOString(), context: { cat: 'pretrade' } });
          } catch {}
        }
      } catch {}
      const tx = await buildCombinedTransaction(connection, kp.publicKey, legs, priorityFeeMicroLamports, extraSetup);
      try {
        // Log a concise summary of ATA-related instructions for diagnostics
        const { ASSOCIATED_TOKEN_PROGRAM_ID } = await import('@solana/spl-token');
        const msgAny: any = tx.message as any;
        const keysDump: string[] = [];
        const programDump: string[] = [];
        const compiled: any[] = (msgAny.compiledInstructions || []);
        const acctKeys: string[] = ((msgAny.staticAccountKeys || msgAny.accountKeys || []).map((k: any) => (k?.toBase58 ? k.toBase58() : String(k))));
        for (const ci of compiled) {
          const pid = acctKeys[ci.programIdIndex] || '';
          if (pid === ASSOCIATED_TOKEN_PROGRAM_ID.toBase58()) {
            programDump.push(pid);
            const ixKeys = (ci.accounts || []).map((i: number) => acctKeys[i] || '').join(',');
            keysDump.push(ixKeys);
          }
        }
        if (programDump.length) {
          emit('log', { level: 'info', message: `pretrade:arb ata ix summary count=${programDump.length}`, timestamp: new Date().toISOString(), context: { cat: 'pretrade' } });
          for (const k of keysDump.slice(0, 5)) {
            emit('log', { level: 'info', message: `pretrade:arb ata ix keys ${k}`, timestamp: new Date().toISOString(), context: { cat: 'pretrade' } });
          }
        }
      } catch {}
      const ixLen = (tx.message as any).compiledInstructions?.length || 'n/a';
      emit('log', { level: 'info', message: `pretrade:arb tx built cid=${cid} ixs=${ixLen} alts=unknown`, timestamp: new Date().toISOString(), context: { cat: 'pretrade' } });
      tx.sign([kp]);
      let msgSize = 0;
      try { msgSize = tx.serialize().length; } catch {}
      if (msgSize) emit('log', { level: 'info', message: `pretrade:arb tx size bytes=${msgSize}`, timestamp: new Date().toISOString(), context: { cat: 'pretrade' } });
      // Preflight simulate to capture logs before submission
      try {
        const sim = await connection.simulateTransaction(tx, { replaceRecentBlockhash: true, sigVerify: true } as any);
        const logs = (sim as any)?.value?.logs || [];
        if (Array.isArray(logs) && logs.length) {
          emit('log', { level: 'info', message: `pretrade:arb simulate logs cid=${cid} lines=${logs.length}`, timestamp: new Date().toISOString(), context: { cat: 'pretrade' } });
          for (const line of logs.slice(0, 50)) {
            emit('log', { level: 'info', message: `pretrade:arb log ${line}`, timestamp: new Date().toISOString(), context: { cat: 'pretrade' } });
          }
        }
      } catch {}
      let sig: string = '';
      try {
        sig = await connection.sendTransaction(tx, { skipPreflight: false, maxRetries: 3 });
        await connection.confirmTransaction(sig, 'finalized');
      } catch (e: any) {
        // Attempt to extract logs from SendTransactionError
        try {
          // Some versions expose logs directly
          const logs = (e?.logs && Array.isArray(e.logs)) ? e.logs : [];
          if (logs.length) {
            emit('log', { level: 'error', message: `pretrade:arb send logs cid=${cid} lines=${logs.length}`, timestamp: new Date().toISOString(), context: { cat: 'pretrade' } });
            for (const line of logs.slice(0, 50)) {
              emit('log', { level: 'error', message: `pretrade:arb log ${line}`, timestamp: new Date().toISOString(), context: { cat: 'pretrade' } });
            }
          }
        } catch {}
        try {
          if (typeof e?.getLogs === 'function') {
            const logs = await e.getLogs(connection);
            if (Array.isArray(logs) && logs.length) {
              emit('log', { level: 'error', message: `pretrade:arb send logs(cid=${cid}) lines=${logs.length}`, timestamp: new Date().toISOString(), context: { cat: 'pretrade' } });
              for (const line of logs.slice(0, 50)) {
                emit('log', { level: 'error', message: `pretrade:arb log ${line}`, timestamp: new Date().toISOString(), context: { cat: 'pretrade' } });
              }
            }
          }
        } catch {}
        // Parse failing instruction index and dump the failing ix program/keys using in-scope tx
        try {
          const msg = String(e?.message || '');
          const m = /Instruction\s+(\d+)/i.exec(msg);
          if (m) {
            const idx = Number(m[1]);
            emit('log', { level: 'error', message: `pretrade:arb failing instruction index=${idx}`, timestamp: new Date().toISOString(), context: { cat: 'pretrade' } });
            const { ASSOCIATED_TOKEN_PROGRAM_ID } = await import('@solana/spl-token');
            const { PublicKey } = await import('@solana/web3.js');
            const msgAny: any = tx.message as any;
            const compiled: any[] = (msgAny.compiledInstructions || []);
            let acctKeys: string[] = ((msgAny.staticAccountKeys || msgAny.accountKeys || []).map((k: any) => (k?.toBase58 ? k.toBase58() : String(k))));
            // Resolve address lookup tables to get full key list for v0 messages
            try {
              const lookups: any[] = Array.isArray(msgAny.addressTableLookups) ? msgAny.addressTableLookups : [];
              if (lookups.length) {
                const writableFromLookups: string[] = [];
                const readonlyFromLookups: string[] = [];
                for (const l of lookups) {
                  try {
                    const { value } = await connection.getAddressLookupTable(new PublicKey(l.accountKey));
                    const addrs: any[] = (value?.state?.addresses || []);
                    for (const wi of (l.writableIndexes || [])) {
                      const a = addrs[wi];
                      writableFromLookups.push(a?.toBase58 ? a.toBase58() : String(a));
                    }
                    for (const ri of (l.readonlyIndexes || [])) {
                      const a = addrs[ri];
                      readonlyFromLookups.push(a?.toBase58 ? a.toBase58() : String(a));
                    }
                  } catch {}
                }
                acctKeys = [...acctKeys, ...writableFromLookups, ...readonlyFromLookups];
              }
            } catch {}
            const ci = compiled[idx];
            if (ci) {
              const pid = acctKeys[ci.programIdIndex] || '';
              const ixKeyIdx: number[] = (ci.accounts || []).map((i: number) => i);
              const ixKeys = ixKeyIdx.map((i: number) => acctKeys[i] || '');
              emit('log', { level: 'error', message: `pretrade:arb ix${idx} program=${pid}`, timestamp: new Date().toISOString(), context: { cat: 'pretrade' } });
              emit('log', { level: 'error', message: `pretrade:arb ix${idx} keys=${ixKeys.join(',')}`, timestamp: new Date().toISOString(), context: { cat: 'pretrade' } });
              if (pid === ASSOCIATED_TOKEN_PROGRAM_ID.toBase58()) {
                emit('log', { level: 'error', message: `pretrade:arb ix${idx} keyIdx=${ixKeyIdx.join(',')} progIdx=${ci.programIdIndex}`, timestamp: new Date().toISOString(), context: { cat: 'pretrade' } });
                if (ixKeys.length >= 4) {
                  emit('log', { level: 'error', message: `pretrade:arb ix${idx} owner=${ixKeys[2]} mint=${ixKeys[3]}`, timestamp: new Date().toISOString(), context: { cat: 'pretrade' } });
                }
              }
            }
          }
        } catch {}
        throw e;
      }
      emit('log', { level: 'info', message: `trade:arb submitted cid=${cid} sig=${sig}`, timestamp: new Date().toISOString(), context: { cat: 'trade' } });
      res.json({ signature: sig });
    } catch (e: any) {
      // Capture logs where possible
      try {
        const msg = String(e?.message || e);
        // Try immediate logs
        const logs = (e?.logs && Array.isArray(e.logs)) ? e.logs : [];
        if (logs.length) {
          emit('log', { level: 'error', message: `pretrade:arb send logs (caught) lines=${logs.length}`, timestamp: new Date().toISOString(), context: { cat: 'pretrade' } });
          for (const line of logs.slice(0, 50)) {
            emit('log', { level: 'error', message: `pretrade:arb log ${line}`, timestamp: new Date().toISOString(), context: { cat: 'pretrade' } });
          }
        }
        // Try getLogs() API for SendTransactionError
        try {
          if (typeof e?.getLogs === 'function') {
            const connection = getConnection();
            const more = await e.getLogs(connection);
            if (Array.isArray(more) && more.length) {
              emit('log', { level: 'error', message: `pretrade:arb send logs (getLogs) lines=${more.length}`, timestamp: new Date().toISOString(), context: { cat: 'pretrade' } });
              for (const line of more.slice(0, 50)) {
                emit('log', { level: 'error', message: `pretrade:arb log ${line}`, timestamp: new Date().toISOString(), context: { cat: 'pretrade' } });
              }
            }
          }
        } catch {}
        // Note: failing instruction index and key dump is already logged in the inner send catch where tx is in scope
      } catch {}
      logger.error('arb execute failed', { error: String(e?.message || e) });
      emit('log', { level: 'error', message: `terminal: arb execute failed ${String(e?.message || e)}`, timestamp: new Date().toISOString() });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // Background: poll arb metrics and emit log snapshots
  try {
    let lastActive = -1;
    let lastDet = -1;
    let lastOppSig = '';
    let lastDetWarnAt = 0;
    const stallThresholdMs = 30_000;
    let lastHeartbeatAt = 0;
    let lastConfigAt = 0;
    let zeroDetWarnedAt = 0;
    setInterval(async () => {
      try {
        const host = process.env.ARB_SERVICE_URL || 'http://127.0.0.1:4010';
        const t0 = Date.now();
        const r = await (async () => { const ac = new AbortController(); const t = setTimeout(() => ac.abort('timeout'), 3000); try { return await fetch(`${host}/metrics/json`, { headers: { 'accept': 'application/json' }, signal: ac.signal }); } finally { clearTimeout(t); } })();
        const dur = Date.now() - t0;
        if (!r.ok) {
          emit('log', { level: 'warn', message: `pretrade:arb metrics http ${r.status} durMs=${dur}`, timestamp: new Date().toISOString() });
          return;
        }
        let m: any = {};
        try { m = await r.json(); } catch (e: any) {
          emit('log', { level: 'warn', message: `pretrade:arb metrics json parse error: ${String(e?.message || e)}`, timestamp: new Date().toISOString() });
          return;
        }
        try { arbLatency.metrics.push(dur); if (arbLatency.metrics.length > 200) arbLatency.metrics.shift(); } catch {}
        if (typeof m?.opportunities_active === 'number' && m.opportunities_active !== lastActive) {
          lastActive = m.opportunities_active;
          emit('log', { level: 'info', message: `pretrade:arb opps=${lastActive} maxBps=${m?.max_profit_bps ?? 0} nodes=${m?.graph_nodes ?? 0} edges=${m?.graph_edges ?? 0}`, timestamp: new Date().toISOString() });
        }
        if (typeof m?.last_detection_ms === 'number') {
          if (m.last_detection_ms !== lastDet) {
            lastDet = m.last_detection_ms;
            emit('log', { level: 'info', message: `pretrade:arb lastDetection=${new Date(m.last_detection_ms).toLocaleTimeString()}`, timestamp: new Date().toISOString() });
            lastDetWarnAt = 0; // reset stall warning on fresh detection
          }
          const age = Date.now() - m.last_detection_ms;
          if (age > stallThresholdMs && Date.now() - lastDetWarnAt > stallThresholdMs) {
            lastDetWarnAt = Date.now();
            emit('log', { level: 'warn', message: `pretrade:arb stalled ageMs=${age}`, timestamp: new Date().toISOString() });
          }
          if ((m.last_detection_ms === 0) && (Date.now() - zeroDetWarnedAt > 20000)) {
            zeroDetWarnedAt = Date.now();
            emit('log', { level: 'warn', message: `pretrade:arb no detections yet (last_detection_ms=0). Verify arb service is enabled and pools available.`, timestamp: new Date().toISOString() });
          }
          if (Date.now() - lastHeartbeatAt > 15000) {
            lastHeartbeatAt = Date.now();
            emit('log', { level: 'info', message: `pretrade:arb heartbeat ageMs=${age} active=${m?.opportunities_active ?? 0}`, timestamp: new Date().toISOString() });
          }
        }
        // Poll opportunities and emit summary if changed
        try {
          const o0 = Date.now();
          const or = await (async () => { const ac = new AbortController(); const t = setTimeout(() => ac.abort('timeout'), 4000); try { return await fetch(`${host}/opportunities`, { headers: { 'accept': 'application/json' }, signal: ac.signal }); } finally { clearTimeout(t); } })();
          const odur = Date.now() - o0;
          if (or.ok) {
            const payload: unknown = await or.json();
            type ArbOpportunity = { profit_bps?: number; net_bps?: number; path?: string[] };
            type ArbOpportunityFull = ArbOpportunity & {
              est_profit_usd?: number;
              hop_rates?: number[];
              hop_outs?: number[];
              hop_pool_ids?: string[];
              hop_fee_bps?: number[];
              hop_liquidity_display?: number[];
              hop_dexes?: string[];
              dexes?: string[];
              est_capacity?: number;
              bottleneck?: { from?: string; to?: string; dex?: string; rate?: number; liquidity?: number; fee_bps?: number };
            };
            const items: ArbOpportunity[] = Array.isArray((payload as any)?.items)
              ? ((payload as any).items as ArbOpportunity[])
              : (Array.isArray(payload) ? (payload as ArbOpportunity[]) : []);
            const top: ArbOpportunity[] = items.slice(0, 3);
            const sig = top.map((o: ArbOpportunity) => `${Math.round((o.profit_bps ?? o.net_bps ?? 0))}:${(o.path || []).join('>')}`).join('|');
            if (sig !== lastOppSig) {
              lastOppSig = sig;
              const lines = top.map((o: ArbOpportunity, i: number) => `#${i+1} bps=${Math.round((o.profit_bps ?? o.net_bps ?? 0))} hops=${(o.path || []).length-1} path=${(o.path || []).join('->')}`);
              emit('log', { level: 'info', message: `pretrade:arb opps:update ${top.length} top=${lines.join(' | ')} oMs=${odur}`, timestamp: new Date().toISOString() });
              try { arbLatency.opps.push(odur); if (arbLatency.opps.length > 200) arbLatency.opps.shift(); } catch {}
              const topBps = Math.round((top?.[0]?.profit_bps ?? top?.[0]?.net_bps ?? 0));
              if (topBps >= 30) {
                emit('log', { level: 'info', message: `pretrade:arb top>=30bps bps=${topBps} hops=${(top?.[0]?.path||[]).length-1}`, timestamp: new Date().toISOString(), context: { cat: 'pretrade' } });
              }
              // Emit detailed logs for identified opportunities (top N)
              try {
                const detailed: ArbOpportunityFull[] = (Array.isArray((payload as any)?.items) ? (payload as any).items : []).slice(0, 3);
                for (const [i, o] of detailed.entries()) {
                  const bps = Math.round((o.profit_bps ?? o.net_bps ?? 0));
                  const path = (o.path || []).join('->');
                  const dexes = (o.hop_dexes || o.dexes || []).join('>');
                  const rates = (o.hop_rates || []).map(v => Number.isFinite(v) ? Number(v).toFixed(8) : String(v)).join(',');
                  const outs = (o.hop_outs || []).map(v => Number.isFinite(v) ? Number(v).toFixed(6) : String(v)).join(',');
                  const fees = (o.hop_fee_bps || []).join(',');
                  const pools = (o.hop_pool_ids || []).join(',');
                  const liqs = (o.hop_liquidity_display || []).map(v => Number.isFinite(v) ? Number(v).toFixed(2) : String(v)).join(',');
                  const cap = (o.est_capacity ?? undefined);
                  const bn = o.bottleneck ? ` from=${o.bottleneck.from} to=${o.bottleneck.to} dex=${o.bottleneck.dex} rate=${o.bottleneck.rate} liq=${o.bottleneck.liquidity} fee_bps=${o.bottleneck.fee_bps}` : '';
                  // Build explicit edge sequence from path and pool ids, including closing hop
                  const edges = (() => {
                    try {
                      const p: string[] = Array.isArray((o as any).path) ? ((o as any).path as string[]) : [];
                      const ids: string[] = Array.isArray((o as any).hop_pool_ids) ? ((o as any).hop_pool_ids as string[]) : [];
                      const n = p.length;
                      const out: string[] = [];
                      for (let k = 0; k < n; k += 1) {
                        const a = p[k];
                        const b = p[(k + 1) % n];
                        const id = ids[k] || '';
                        const short = (m: string) => (typeof m === 'string' && m.length > 8) ? `${m.slice(0,4)}…${m.slice(-4)}` : m;
                        out.push(`${short(a)}->${short(b)}:${id}`);
                      }
                      return out.join(',');
                    } catch { return ''; }
                  })();
                  const msg = `opportunity:detected #${i+1} bps=${bps} usd=${o.est_profit_usd ?? '-'} hops=${(o.path||[]).length-1} path=${path} dexes=${dexes} rates=[${rates}] outs=[${outs}] fees=[${fees}] pools=[${pools}] edges=[${edges}] liq=[${liqs}] est_capacity=${cap ?? '-'} bottleneck{${bn.trim()}}`;
                  emit('log', { level: 'info', message: msg, timestamp: new Date().toISOString(), context: { cat: 'opportunity' } });
                }
              } catch {}
            }
            // Emit detailed log for near-miss opportunities when present
            try {
              const summary: any = (payload as any)?.summary || {};
              const near: ArbOpportunityFull | undefined = summary?.near_miss;
              const shortfallBps: number | undefined = summary?.near_miss_shortfall_bps;
              // Keep a signature to avoid spamming identical near-miss logs
              (registerRoutes as any)._lastNearSig = (registerRoutes as any)._lastNearSig || '';
              if (near && typeof shortfallBps === 'number') {
                const nearSig = `${Math.round(shortfallBps)}:${(near.path||[]).join('>')}`;
                if ((registerRoutes as any)._lastNearSig !== nearSig) {
                  (registerRoutes as any)._lastNearSig = nearSig;
                  const bps = Math.round((near.profit_bps ?? near.net_bps ?? 0));
                  const path = (near.path || []).join('->');
                  const dexes = (near.hop_dexes || near.dexes || []).join('>');
                  const rates = (near.hop_rates || []).map(v => Number.isFinite(v) ? Number(v).toFixed(8) : String(v)).join(',');
                  const outs = (near.hop_outs || []).map(v => Number.isFinite(v) ? Number(v).toFixed(6) : String(v)).join(',');
                  const fees = (near.hop_fee_bps || []).join(',');
                  const pools = (near.hop_pool_ids || []).join(',');
                  const liqs = (near.hop_liquidity_display || []).map(v => Number.isFinite(v) ? Number(v).toFixed(2) : String(v)).join(',');
                  const cap = (near.est_capacity ?? undefined);
                  const bn = near.bottleneck ? ` from=${near.bottleneck.from} to=${near.bottleneck.to} dex=${near.bottleneck.dex} rate=${near.bottleneck.rate} liq=${near.bottleneck.liquidity} fee_bps=${near.bottleneck.fee_bps}` : '';
                  const msg = `opportunity:near_miss shortfall_bps=${Math.round(shortfallBps)} bps=${bps} hops=${(near.path||[]).length-1} path=${path} dexes=${dexes} rates=[${rates}] outs=[${outs}] fees=[${fees}] pools=[${pools}] liq=[${liqs}] est_capacity=${cap ?? '-'} bottleneck{${bn.trim()}}`;
                  emit('log', { level: 'info', message: msg, timestamp: new Date().toISOString(), context: { cat: 'opportunity' } });
                }
              }
            } catch {}
          }
        } catch {}
        // Periodic latency summary (once per 60s)
        if (Date.now() - arbLatency.lastSummaryAt > 60000) {
          arbLatency.lastSummaryAt = Date.now();
          const summarize = (arr: number[]) => {
            if (!arr.length) return { n: 0 } as any;
            const sorted = [...arr].sort((a, b) => a - b);
            const p = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))];
            const sum = arr.reduce((a, b) => a + b, 0);
            return { n: arr.length, min: sorted[0], p50: p(0.5), p95: p(0.95), max: sorted[sorted.length - 1], avg: Math.round((sum / arr.length) * 10) / 10 };
          };
          const m = summarize(arbLatency.metrics);
          const o = summarize(arbLatency.opps);
          emit('log', { level: 'info', message: `arb:latency metrics n=${m.n||0}${m.n?` min=${m.min} p50=${m.p50} p95=${m.p95} max=${m.max} avg=${m.avg}`:''} | opps n=${o.n||0}${o.n?` min=${o.min} p50=${o.p50} p95=${o.p95} max=${o.max} avg=${o.avg}`:''}`, timestamp: new Date().toISOString(), context: { cat: 'arb' } });
        }
        // Sample arb config occasionally to report enabled state
        try {
          if (Date.now() - lastConfigAt > 30000) {
            lastConfigAt = Date.now();
            const rc = await (async () => { const ac = new AbortController(); const t = setTimeout(() => ac.abort('timeout'), 3000); try { return await fetch(`${host}/config`, { headers: { 'accept': 'application/json' }, signal: ac.signal }); } finally { clearTimeout(t); } })();
            if (rc.ok) {
              const cj: any = await rc.json().catch(() => ({}));
              if (typeof cj?.enabled === 'boolean') emit('log', { level: 'info', message: `pretrade:arb config enabled=${cj.enabled}`, timestamp: new Date().toISOString() });
            }
          }
        } catch {}
      } catch {}
    }, 3000);
  } catch {}

  // Arbitrage config passthrough (min profit bps, DEX allowlist)
  api.post('/arb/config', async (req, res) => {
    try {
      const host = process.env.ARB_SERVICE_URL || 'http://127.0.0.1:4010';
      logger.info(`api.request POST /arb-service/config`, { url: `${host}/config`, cat: 'api' });
      const started = Date.now();
      const r = await (async () => { const ac = new AbortController(); const t = setTimeout(() => ac.abort('timeout'), 7000); try { return await fetch(`${host}/config`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req.body || {}), signal: ac.signal }); } finally { clearTimeout(t); } })();
      logger.info(`api.response POST /arb-service/config ${r.status} ${Date.now()-started}ms`, { status: r.status, cat: 'api' });
      let json: any = {};
      try { json = await r.json(); } catch { json = {}; }
      try {
        const changedKeys = Object.keys(req.body || {});
        emit('log', { level: r.ok ? 'info' : 'warn', message: `arb:config update keys=[${changedKeys.join(',')}] status=${r.status}`, timestamp: new Date().toISOString(), context: { cat: 'arb' } });
        emit('log', { level: r.ok ? 'info' : 'warn', message: `terminal: Arbitrage configuration ${r.ok ? 'updated' : 'update failed'} (${r.status})`, timestamp: new Date().toISOString() });
      } catch {}
      // Persist last requested config locally regardless of remote status
      try { await writeJson('backend/config/arbConfig.json', { ...(req.body || {}), _savedAt: new Date().toISOString() }); } catch {}
      res.status(r.status).json(json);
    } catch (e: any) {
      // Save locally even if arb service is unreachable
      try { await writeJson('backend/config/arbConfig.json', { ...(req.body || {}), _savedAt: new Date().toISOString() }); } catch {}
      res.status(503).json({ ok: false, error: 'arb service unreachable; config saved locally' });
    }
  });

  api.post('/bot/start', async (_req, res) => {
    try {
      // Resume API and price feed (if watchlist has items)
      apiStart();
      try {
        const wl = await readJson<any[]>(CONFIG.watchlistPath, []);
        enablePriceFeed(Array.isArray(wl) && wl.length > 0);
      } catch {}
      await tradingController.start();
      res.json({ status: 'started' });
      io.emit('system', { bot: 'started' });
      emit('log', { level: 'info', message: 'Bot started', timestamp: new Date().toISOString() });
    } catch (e: any) {
      logger.error('failed to start bot', { error: String(e) });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  api.post('/bot/stop', async (_req, res) => {
    try {
      tradingController.stop();
      // Pause API and stop price feed
      apiStop();
      enablePriceFeed(false);
      res.json({ status: 'stopped' });
      io.emit('system', { bot: 'stopped' });
      emit('log', { level: 'info', message: 'Bot stopped', timestamp: new Date().toISOString() });
    } catch (e: any) {
      logger.error('failed to stop bot', { error: String(e) });
      res.status(500).json({ error: String(e) });
    }
  });

  // Strategy endpoints (multi)
  api.get('/strategy', async (_req, res) => {
    await migrateSingleStrategy();
    const list = await getStrategies();
    res.json({ strategies: list });
    emit('log', { level: 'info', message: `Strategies: ${list.map(s => s.name).join(', ') || '(none)'}`, timestamp: new Date().toISOString() });
  });

  api.post('/strategy', async (req, res) => {
    const item = req.body as any;
    if (!item?.name) return res.status(400).json({ error: 'name required' });
    const name = String(item.name);
    const list = await getStrategies();
    const idx = list.findIndex((s) => s.name === name);
    const existing: any = idx >= 0 ? list[idx] : {};
    const updated: any = { ...existing, name };
    // Map and merge only provided keys
    const has = (k: string) => Object.prototype.hasOwnProperty.call(item, k);
    if (has('token') || has('toToken')) updated.token = String(item.toToken ?? item.token ?? updated.token ?? '');
    if (has('fromToken')) updated.fromToken = item.fromToken ? String(item.fromToken) : undefined;
    if (has('toToken')) updated.toToken = item.toToken ? String(item.toToken) : undefined;
    const toNum = (v: any) => (Number.isFinite(Number(v)) ? Number(v) : undefined);
    if (has('buyPct')) { const n = toNum(item.buyPct); if (n === undefined) return res.status(400).json({ error: 'buyPct must be a number' }); updated.buyPct = n; }
    if (has('sellPct')) { const n = toNum(item.sellPct); if (n === undefined) return res.status(400).json({ error: 'sellPct must be a number' }); updated.sellPct = n; }
    // Accept BPS for thresholds as well (converted to fractions)
    if (has('buyBps')) { const n = toNum(item.buyBps); if (n === undefined) return res.status(400).json({ error: 'buyBps must be a number' }); updated.buyPct = Number(n) / 10000; }
    if (has('sellBps')) { const n = toNum(item.sellBps); if (n === undefined) return res.status(400).json({ error: 'sellBps must be a number' }); updated.sellPct = Number(n) / 10000; }
    if (has('amount')) { const n = toNum(item.amount); if (n === undefined || n <= 0) return res.status(400).json({ error: 'amount must be > 0' }); updated.amount = n; }
    if (has('testMode')) updated.testMode = !!item.testMode;
    if (has('inputMintUSDC')) updated.inputMintUSDC = item.inputMintUSDC;
    if (has('tokenMint')) updated.tokenMint = item.tokenMint;
    if (has('active')) updated.active = item.active !== false;
    if (has('marketEnter')) updated.marketEnter = (item.marketEnter === 'long' || item.marketEnter === 'short') ? item.marketEnter : null;
    if (has('fixedAnchor')) updated.fixedAnchor = item.fixedAnchor === true;
    if (has('anchorPairAtSetup')) updated.anchorPairAtSetup = (typeof item.anchorPairAtSetup === 'number') ? item.anchorPairAtSetup : updated.anchorPairAtSetup;
    if (has('scaleAggressiveness')) { const n = toNum(item.scaleAggressiveness); if (n === undefined || n < 0) return res.status(400).json({ error: 'scaleAggressiveness must be >= 0' }); updated.scaleAggressiveness = n; }
    if (has('scaleStepPct')) { const n = toNum(item.scaleStepPct); if (n === undefined || n < 0) return res.status(400).json({ error: 'scaleStepPct must be >= 0' }); updated.scaleStepPct = n; }
    if (has('slippageBps')) { const n = toNum(item.slippageBps); if (n === undefined || n < 0) return res.status(400).json({ error: 'slippageBps must be >= 0' }); updated.slippageBps = n; }
    if (has('maxOpenPositions')) { const n = toNum(item.maxOpenPositions); if (n === undefined || n < 0) return res.status(400).json({ error: 'maxOpenPositions must be >= 0' }); updated.maxOpenPositions = n; }
    if (has('maxPositionSize')) { const n = toNum(item.maxPositionSize); if (n === undefined || n < 0) return res.status(400).json({ error: 'maxPositionSize must be >= 0' }); updated.maxPositionSize = n; }
    if (has('lst')) updated.lst = item.lst === true;
    if (has('navSource')) updated.navSource = (item.navSource === 'protocol' || item.navSource === 'ema') ? item.navSource : updated.navSource;
    if (has('hysteresisBps')) { const n = toNum(item.hysteresisBps); if (n === undefined || n < 0) return res.status(400).json({ error: 'hysteresisBps must be >= 0' }); updated.hysteresisBps = n; }
    if (has('cooldownMs')) { const n = toNum(item.cooldownMs); if (n === undefined || n < 0) return res.status(400).json({ error: 'cooldownMs must be >= 0' }); updated.cooldownMs = n; }
    if (has('feeBps')) { const n = toNum(item.feeBps); if (n === undefined || n < 0) return res.status(400).json({ error: 'feeBps must be >= 0' }); updated.feeBps = n; }
    if (has('extraSlippageBps')) { const n = toNum(item.extraSlippageBps); if (n === undefined || n < 0) return res.status(400).json({ error: 'extraSlippageBps must be >= 0' }); updated.extraSlippageBps = n; }
    if (has('minEdgeBps')) { const n = toNum(item.minEdgeBps); if (n === undefined || n < 0) return res.status(400).json({ error: 'minEdgeBps must be >= 0' }); (updated as any).minEdgeBps = n; }
    // Sliding anchor
    if (has('slidingAnchor')) updated.slidingAnchor = !!item.slidingAnchor;
    if (has('slideRateBpsPerSec')) { const n = toNum(item.slideRateBpsPerSec); if (n === undefined || n < 0) return res.status(400).json({ error: 'slideRateBpsPerSec must be >= 0' }); (updated as any).slideRateBpsPerSec = n; }
    if (has('slideMaxPct')) { const n = toNum(item.slideMaxPct); if (n === undefined || n < 0) return res.status(400).json({ error: 'slideMaxPct must be >= 0' }); (updated as any).slideMaxPct = n; }

    // Grid strategy parameters
    if (has('gridType')) updated.gridType = String(item.gridType);
    if (has('gridSpacing')) { const n = toNum(item.gridSpacing); if (n === undefined) return res.status(400).json({ error: 'gridSpacing must be a number' }); updated.gridSpacing = n; }
    if (has('gridLevels')) { const n = toNum(item.gridLevels); if (n === undefined) return res.status(400).json({ error: 'gridLevels must be a number' }); updated.gridLevels = n; }
    if (has('centerPrice')) { const n = toNum(item.centerPrice); if (n !== undefined) updated.centerPrice = n; }
    if (has('totalAmount')) { const n = toNum(item.totalAmount); if (n === undefined) return res.status(400).json({ error: 'totalAmount must be a number' }); updated.totalAmount = n; }
    if (has('levelAmount')) { const n = toNum(item.levelAmount); if (n === undefined) return res.status(400).json({ error: 'levelAmount must be a number' }); updated.levelAmount = n; }
    if (has('initialBuyRange')) { const n = toNum(item.initialBuyRange); if (n !== undefined) updated.initialBuyRange = n; }
    if (has('initialSellRange')) { const n = toNum(item.initialSellRange); if (n !== undefined) updated.initialSellRange = n; }
    if (has('maxPositions')) { const n = toNum(item.maxPositions); if (n !== undefined) updated.maxPositions = n; }
    if (has('stopLoss')) { const n = toNum(item.stopLoss); if (n !== undefined) updated.stopLoss = n; }
    if (has('takeProfit')) { const n = toNum(item.takeProfit); if (n !== undefined) updated.takeProfit = n; }
    if (has('rebalanceThreshold')) { const n = toNum(item.rebalanceThreshold); if (n !== undefined) updated.rebalanceThreshold = n; }
    if (has('adaptiveSpacing')) updated.adaptiveSpacing = !!item.adaptiveSpacing;
    if (has('volatilityPeriod')) { const n = toNum(item.volatilityPeriod); if (n !== undefined) updated.volatilityPeriod = n; }
    if (has('minLevelSpacing')) { const n = toNum(item.minLevelSpacing); if (n !== undefined) updated.minLevelSpacing = n; }
    if (has('maxLevelSpacing')) { const n = toNum(item.maxLevelSpacing); if (n !== undefined) updated.maxLevelSpacing = n; }
    // Grid control flags
    if (has('onlyClose')) updated.onlyClose = !!item.onlyClose;
    // Grid bias parameters
    if (has('bias')) {
      const v = String(item.bias);
      if (v === 'neutral' || v === 'long' || v === 'short') updated.bias = v;
    }
    if (has('biasStrength')) {
      const n = toNum(item.biasStrength);
      if (n !== undefined) updated.biasStrength = Math.max(0, Math.min(1, n));
    }
    
    // Sliding center price parameters
    if (has('slidingCenter')) updated.slidingCenter = !!item.slidingCenter;
    if (has('slideRate')) { const n = toNum(item.slideRate); if (n !== undefined) updated.slideRate = n; }
    if (has('slideMaxDistance')) { const n = toNum(item.slideMaxDistance); if (n !== undefined) updated.slideMaxDistance = n; }

    // If fixedAnchor newly requested and no anchor set, capture current pair at setup
    if (has('fixedAnchor') && updated.fixedAnchor && typeof updated.anchorPairAtSetup !== 'number') {
      try {
        if (updated.fromToken && updated.toToken) {
          const fromInfo = await resolveMint(updated.fromToken);
          const toInfo = await resolveMint(updated.toToken);
          const prices = await (await import('../jupiter/jupiter.js')).fetchPricesByMints([fromInfo.mint, toInfo.mint]);
          const fromUsd = prices[fromInfo.mint]?.usdc || null;
          const toUsd = prices[toInfo.mint]?.usdc || null;
          if (fromUsd && toUsd) updated.anchorPairAtSetup = toUsd / fromUsd;
        }
      } catch {}
    }

    // Write back
    if (idx >= 0) list[idx] = updated; else list.push(updated);
    await writeJson(STRATEGY_LIST_PATH, list);
    
    // Process the strategy in trading controller
    try {
      await tradingController.addOrUpdateStrategy();
    } catch (e: any) {
      logger.error('Failed to process strategy in trading controller', { error: String(e) });
    }
    
    res.json({ ok: true, strategies: list });
    emit('log', { level: 'info', message: `Strategy upserted: ${name}`, timestamp: new Date().toISOString(), context: { ...updated, cat: 'terminal' } });
    io.emit('strategies-update', list);
    // Optimistically emit activity stub for UI immediacy
    emit('activity', { strategy: name, status: 'waiting', pair: `${updated.fromToken || 'USDC'}/${updated.toToken || updated.token || 'SOL'}`, trades: [] });
    // Auto-add fromToken/toToken to watchlist
    try {
      const wl = await readJson(CONFIG.watchlistPath, [] as any[]);
      const toAdd: string[] = [];
      if (updated.fromToken) toAdd.push(updated.fromToken);
      if (updated.toToken) toAdd.push(updated.toToken);
      const existingIds = new Set((wl.map((t: any) => (typeof t === 'string' ? t : t.id)) as string[]));
      for (const q of toAdd) {
        if (!q) continue;
        let entry: any | null = null;
        if (q.length > 30) {
          entry = { id: q, symbol: q.slice(0, 4).toUpperCase(), name: q, decimals: 6 };
        } else {
          let r: any[] = [];
          try { r = await searchTokens(q, true); } catch {}
          entry = r[0] || null;
          if (!entry) {
            try {
              const rm = await resolveMint(q);
              if (rm?.mint) entry = { id: rm.mint, symbol: q.toUpperCase(), name: q, decimals: (rm as any).decimals ?? 6 };
            } catch {}
          }
        }
        if (entry && !existingIds.has(entry.id)) {
          wl.push(entry);
          existingIds.add(entry.id);
        }
      }
      await writeJson(CONFIG.watchlistPath, wl);
      io.emit('watchlist-update', wl);
      enablePriceFeed(wl.length > 0);
    } catch {}

    // Incremental trader add/update for immediacy
    try {
      await tradingController.addOrUpdateStrategy();
    } catch {}
  });

  api.delete('/strategy', async (req, res) => {
    const { name } = req.body as { name: string };
    if (!name) return res.status(400).json({ error: 'name required' });
    const list = await removeStrategy(name);
    res.json({ ok: true, strategies: list });
    emit('log', { level: 'info', message: `Strategy removed: ${name}`, timestamp: new Date().toISOString(), context: { cat: 'terminal' } });
    io.emit('strategies-update', list);
    // Clear positions and activity for removed strategy
    try {
      const { ThresholdTrader } = await import('../trading/thresholdStrategy.js');
      const walletMod: any = await import('../wallet/wallet.js');
      let walletKey: string | null = null;
      try {
        walletKey = (await walletMod.ensureWallet(CONFIG.walletPath)).publicKey.toBase58();
      } catch {}
      const instanceKey = `${walletKey}:${name}`;
      // Clear open positions for this strategy
      if (walletKey && (ThresholdTrader as any).positionsFor?.[instanceKey]) {
        (ThresholdTrader as any).positionsFor[instanceKey] = [];
        emit('positions', []);
      }
      // Clear last entry for PnL tracking
      if (walletKey && (ThresholdTrader as any).lastEntryPair?.[instanceKey]) {
        delete (ThresholdTrader as any).lastEntryPair[instanceKey];
      }
      // Clear state (anchor/holding and scale levels)
      if (walletKey && (ThresholdTrader as any).stateFor?.[instanceKey]) {
        delete (ThresholdTrader as any).stateFor[instanceKey];
      }
      // Clear inflight locks for safety
      const inflight = (ThresholdTrader as any).inflightByWallet;
      if (walletKey && inflight && inflight[walletKey]) {
        for (const pairKey of Object.keys(inflight[walletKey] || {})) {
          // delete specific kinds to be safe
          const kinds = inflight[walletKey][pairKey];
          delete kinds.openLong; delete kinds.openShort; delete kinds.closeLong; delete kinds.closeShort; delete kinds.scaleLong; delete kinds.scaleShort;
        }
      }
      emit('activity', { strategy: name, status: 'idle', trades: [] });
      tradingController.removeStrategy(name);
    } catch {}

    // Refresh traders if bot is running
    try {
      const { ThresholdTrader } = await import('../trading/thresholdStrategy.js');
      if (!(ThresholdTrader as any).globalHalt) {
        tradingController.stop();
        await tradingController.init();
        await tradingController.start();
      }
    } catch {}
  });

  // Activate/deactivate strategy
  api.post('/strategy/status', async (req, res) => {
    const { name, active } = req.body as { name: string; active: boolean };
    if (!name || typeof active !== 'boolean') return res.status(400).json({ error: 'name and active required' });
    const list = await getStrategies();
    const idx = list.findIndex((s) => s.name === name);
    if (idx < 0) return res.status(404).json({ error: 'strategy not found' });
    (list[idx] as any).active = active;
    await writeJson(STRATEGY_LIST_PATH, list);
    res.json({ ok: true, strategies: list });
    io.emit('strategies-update', list);
    emit('log', { level: 'info', message: `Strategy ${active ? 'activated' : 'deactivated'}: ${name}`, timestamp: new Date().toISOString(), context: { cat: 'terminal' } });
  });

  // Grid strategy specific routes
  api.get('/grid/levels/:strategyName', async (req, res) => {
    try {
      const { strategyName } = req.params;
      const { GridTrader } = await import('../trading/gridStrategy.js');
      const walletMod: any = await import('../wallet/wallet.js');
      const walletKey = (await walletMod.ensureWallet(CONFIG.walletPath)).publicKey.toBase58();
      const instanceKey = `${walletKey}:${strategyName}`;
      
      // Clean up closed positions and their corresponding levels
      GridTrader.cleanupClosedPositions(instanceKey);
      
      // Update grid level statuses based on active positions
      GridTrader.updateGridLevelStatuses(instanceKey);
      
      const levels = GridTrader.getGridLevels(instanceKey);
      let positions = GridTrader.getSuccessfulPositions(instanceKey);
      let activePositions = GridTrader.getActivePositions(instanceKey);
      let tradeHistory = GridTrader.getTradeHistory(instanceKey);
      const state = GridTrader.getGridState(instanceKey);
      
      // Get token information for display using the strategy-specific config
      const strategies = await getStrategies();
      const strat = strategies.find((s) => s.name === strategyName);
      const config = {
        fromToken: (strat as any)?.fromToken || (await GridTrader.prototype.loadConfig.call({})).fromToken || 'USDC',
        toToken: (strat as any)?.toToken || (await GridTrader.prototype.loadConfig.call({})).toToken || 'SOL',
      } as any;
      // Resolve USD prices for tokens (if available) with fetch fallback
      let fromUsd: number | null = null;
      let toUsd: number | null = null;
      try {
        const fromInfo = await resolveMint(config.fromToken || 'USDC');
        const toInfo = await resolveMint(config.toToken || 'SOL');
        fromUsd = getPriceByMint(fromInfo.mint)?.usdc || null;
        toUsd = getPriceByMint(toInfo.mint)?.usdc || null;
        if (!fromUsd || !toUsd) {
          try {
            const { fetchPricesByMints } = await import('../jupiter/jupiter.js');
            const fresh = await fetchPricesByMints([fromInfo.mint, toInfo.mint]);
            fromUsd = fromUsd ?? (fresh[fromInfo.mint]?.usdc ?? null);
            toUsd = toUsd ?? (fresh[toInfo.mint]?.usdc ?? null);
          } catch {}
        }
      } catch {}
      
      // Backfill missing USD fields using current prices as last resort to stabilize display for historical entries
      const backfillUsd = (p: any) => {
        try {
          const from = (state?.fromToken || (p.strategyName ? undefined : undefined)) as string | undefined;
          const entryPair = p.entryPrice;
          if (typeof p.entryUsdPerTo !== 'number' && typeof entryPair === 'number' && typeof fromUsd === 'number' && entryPair > 0) {
            p.entryUsdPerTo = fromUsd / entryPair;
          }
          const exitPair = p.exitPrice;
          if (typeof p.exitUsdPerTo !== 'number' && typeof exitPair === 'number' && typeof fromUsd === 'number' && exitPair > 0) {
            p.exitUsdPerTo = fromUsd / exitPair;
          }
          const plannedPair = p.plannedExitPrice;
          if (typeof p.plannedExitUsdPerTo !== 'number' && typeof plannedPair === 'number' && typeof fromUsd === 'number' && plannedPair > 0) {
            // pair is to per from; USD per to = fromUsd * (to/from)
            p.plannedExitUsdPerTo = fromUsd * plannedPair;
          }
        } catch {}
        return p;
      };

      // Expose stored USD fields transparently
      const mapUsdFields = (p: any) => backfillUsd({
        ...p,
        entryUsdPerTo: p.entryUsdPerTo,
        exitUsdPerTo: p.exitUsdPerTo,
        plannedExitUsdPerTo: p.plannedExitUsdPerTo,
      });

      res.json({ 
        levels, 
        positions: (positions || []).map(mapUsdFields), 
        activePositions: (activePositions || []).map(mapUsdFields),
        tradeHistory: (tradeHistory || []).map(mapUsdFields),
        state,
        strategyName,
        tokens: {
          fromToken: config.fromToken || 'USDC',
          toToken: config.toToken || 'SOL',
          fromSymbol: config.fromToken || 'USDC',
          toSymbol: config.toToken || 'SOL',
          fromUsd,
          toUsd
        },
        // include strategy controls for UI (if present)
        controls: (() => {
          try {
            const item = (strategies || []).find((s) => (s as any)?.name === strategyName) as any;
            return { onlyClose: !!item?.onlyClose };
          } catch { return { onlyClose: false }; }
        })()
      });
    } catch (e: any) {
      logger.error('Failed to get grid levels', { error: String(e?.message || e) });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  api.post('/grid/rebalance/:strategyName', async (req, res) => {
    try {
      const { strategyName } = req.params;
      const { centerPrice } = req.body as { centerPrice?: number };
      
      // Get the grid trader instance
      const { GridTrader } = await import('../trading/gridStrategy.js');
      const walletMod: any = await import('../wallet/wallet.js');
      const walletKey = (await walletMod.ensureWallet(CONFIG.walletPath)).publicKey.toBase58();
      const instanceKey = `${walletKey}:${strategyName}`;
      
      // Update center price if provided
      if (centerPrice && GridTrader.getGridState(instanceKey)) {
        GridTrader.getGridState(instanceKey).centerPrice = centerPrice;
        GridTrader.getGridState(instanceKey).lastRebalance = Date.now();
      }
      
      // Trigger rebalancing by clearing existing levels
      GridTrader.getGridLevels(instanceKey).length = 0;
      
      res.json({ ok: true, message: 'Grid rebalancing triggered' });
      emit('log', { 
        level: 'info', 
        message: `Grid rebalancing triggered for ${strategyName}`, 
        timestamp: new Date().toISOString(),
        context: { cat: 'terminal' }
      });
    } catch (e: any) {
      logger.error('Failed to rebalance grid', { error: String(e?.message || e) });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  api.post('/grid/close-position/:strategyName', async (req, res) => {
    try {
      const { strategyName } = req.params;
      const { positionId } = req.body as { positionId: string };
      
      if (!positionId) {
        return res.status(400).json({ error: 'Position ID is required' });
      }
      
      // Get the grid trader instance
      const { GridTrader } = await import('../trading/gridStrategy.js');
      const walletMod: any = await import('../wallet/wallet.js');
      const walletKey = (await walletMod.ensureWallet(CONFIG.walletPath)).publicKey.toBase58();
      const instanceKey = `${walletKey}:${strategyName}`;
      
      // Find the position
      const positions = GridTrader.getGridPositions(instanceKey);
      const position = positions.find(p => p.id === positionId && !p.closedAt);
      
      if (!position) {
        return res.status(404).json({ error: 'Position not found or already closed' });
      }
      
      // Get the grid configuration for this specific strategy (not the prototype defaults)
      const listForClose = await getStrategies();
      const stratForClose = listForClose.find((s) => s.name === strategyName);
      const protoCfgForClose = await GridTrader.prototype.loadConfig.call({});
      const config = {
        fromToken: (stratForClose as any)?.fromToken || protoCfgForClose.fromToken || 'USDC',
        toToken: (stratForClose as any)?.toToken || protoCfgForClose.toToken || 'SOL',
      } as any;
      const fromInfo = await resolveMint(config.fromToken || 'USDC');
      const toInfo = await resolveMint(config.toToken || 'SOL');
      
      // Determine swap parameters based on position side
      let inputMint: string, outputMint: string, amount: number;
      
      if (position.side === 'buy') {
        // If it's a buy position, sell the received toToken back to fromToken
        inputMint = toInfo.mint; // sell toToken
        outputMint = fromInfo.mint; // receive fromToken
        // Prefer the actual received toToken amount from the buy fill; fallback to paired sell level amount; lastly to configured amount
        let sellAmountTo = position.filledAmount || 0;
        if (!(sellAmountTo > 0)) {
          try {
            const levels = GridTrader.getGridLevels(instanceKey) || [];
            const pairedSell = levels.find((l: any) => l.side === 'sell' && l.pairedLevelId === (position as any).levelId);
            if (pairedSell && typeof pairedSell.amount === 'number' && pairedSell.amount > 0) sellAmountTo = pairedSell.amount;
          } catch {}
        }
        amount = sellAmountTo || position.amount; // still fallback if needed
      } else {
        // If it's a sell position, we need to buy back the tokens
        inputMint = fromInfo.mint; // spend fromToken
        outputMint = toInfo.mint; // receive toToken
        // For closing a sell, we spend fromToken. Prefer using the intended spend amount from the UI (position.amount is the toToken size at entry),
        // but the actual sent will be read from swap result; use amount here as a ceiling for quote build.
        amount = position.amount || position.filledAmount || 0;
      }
      
      // Get the wallet keypair for signing
      const wallet = await ensureWallet(CONFIG.walletPath);
      
      // In-flight guard for manual close to avoid duplicates
      const inflightKey = `close:${walletKey}:${strategyName}:${positionId}`;
      const now = Date.now();
      (global as any).__inflightClose = (global as any).__inflightClose || new Map<string, number>();
      const inflightMap: Map<string, number> = (global as any).__inflightClose;
      const prev = inflightMap.get(inflightKey);
      if (prev && (now - prev) < 20000) {
        return res.status(429).json({ error: 'Close already in-flight' });
      }
      inflightMap.set(inflightKey, now);

      // Execute the swap to close the position (use high slippage and priority to ensure fill)
      const slippageForClose = Math.max(Number(CONFIG.fees?.jupiterMaxSlippageBps || 500), Number(config.slippageBps || 0));
      const swapResult = await executeSwap(
        {
          inputMint,
          outputMint,
          amount: Math.round(amount * Math.pow(10, position.side === 'buy' ? toInfo.decimals : fromInfo.decimals)),
          userPublicKey: walletKey,
          slippageBps: slippageForClose,
          prioritizationFeeLamports: CONFIG.fees.jupiterPriorityFee,
          maxAccounts: CONFIG.fees.jupiterMaxAccounts,
          dynamicComputeUnitLimit: CONFIG.fees.jupiterDynamicCompute,
          asLegacyTransaction: CONFIG.fees.jupiterLegacyTransaction
        },
        (serialized) => signAndSendSerializedTransaction(serialized, wallet, undefined, 'swap'),
        true, // priority: manual closes should be sent ASAP
        position.side === 'buy' ? fromInfo.decimals : toInfo.decimals // output decimals
      );
      
      // Compute actual exit price from actual amounts when available
      const actualOut = swapResult.receivedAmountActual ?? swapResult.receivedAmount;
      const actualSent = swapResult.sentAmountActual; // prefer on-chain sent amount when available
      let exitPrice: number | undefined;
      if (position.side === 'buy') {
        // Sold toToken back to fromToken: maintain to per from orientation
        // to per from = soldTo / receivedFrom
        const soldTo = (typeof actualSent === 'number' && actualSent > 0)
          ? actualSent
          : (position.filledAmount || 0);
        const receivedFrom = actualOut;
        if (soldTo > 0 && typeof receivedFrom === 'number' && receivedFrom > 0) exitPrice = soldTo / receivedFrom;
      } else {
        // Bought toToken using fromToken: to per from = receivedTo / spentFrom
        const spentFrom = (typeof actualSent === 'number' && actualSent > 0)
          ? actualSent
          : (position.filledAmount || position.amount || 0);
        const receivedTo = actualOut;
        if (spentFrom > 0 && typeof receivedTo === 'number' && receivedTo > 0) exitPrice = receivedTo / spentFrom;
      }

      // Update the position as closed
      position.closedAt = Date.now();
      position.exitPrice = Math.abs(exitPrice ?? position.entryPrice);
      position.exitTransactionSignature = swapResult.signature;
      position.status = 'closed';
      position.timeSinceOpen = Date.now() - (position.openedAt || Date.now());
      
      // Calculate PNL if we have an exitPrice
      if (position.exitPrice !== undefined) {
        const qty = position.side === 'buy' ? (position.filledAmount || 0) : (position.amount || 0);
        const priceDiff = (position.side === 'buy') ? (position.exitPrice - position.entryPrice) : (position.entryPrice - position.exitPrice);
        position.pnl = priceDiff * qty;
      } else {
        position.pnl = 0;
      }
      
      // Update Grid state and levels to reflect manual close
      try {
        GridTrader.manualClosePosition(
          instanceKey,
          position.id,
          exitPrice,
          swapResult.signature,
          actualOut,
          amount
        );
        GridTrader.cleanupClosedPositions(instanceKey);
        GridTrader.updateGridLevelStatuses(instanceKey);
      } catch {}

      // Emit user-facing trade log for manual close (User Log)
      try {
        const fromSym = config.fromToken || 'FROM';
        const toSym = config.toToken || 'TO';
        const inputAmt = amount; // amount of input token spent/sold
        const outputAmt = swapResult.receivedAmountActual ?? swapResult.receivedAmount;
        const msg = position.side === 'buy'
          // we sold toToken back to fromToken
          ? `trade: manual-close ${strategyName} sell ${inputAmt} ${toSym} -> ${outputAmt} ${fromSym}${exitPrice ? ` @ ${exitPrice}` : ''}`
          // we bought toToken back using fromToken
          : `trade: manual-close ${strategyName} buy ${inputAmt} ${fromSym} -> ${outputAmt} ${toSym}${exitPrice ? ` @ ${exitPrice}` : ''}`;
        emit('log', { level: 'info', message: msg, timestamp: new Date().toLocaleTimeString(), context: { cat: 'trade', strategy: strategyName } });
      } catch {}

      res.json({ 
        ok: true, 
        message: 'Position closed successfully',
        signature: swapResult.signature,
        receivedAmount: swapResult.receivedAmount,
        receivedAmountActual: swapResult.receivedAmountActual,
        sentAmountActual: swapResult.sentAmountActual
      });
      
      emit('log', { 
        level: 'info', 
        message: `Position ${positionId} closed manually`, 
        timestamp: new Date().toISOString() 
      });
      
    } catch (e: any) {
      logger.error('Failed to close position', { error: String(e?.message || e) });
      res.status(500).json({ error: String(e?.message || e) });
    } finally {
      try {
        const { strategyName } = req.params as any;
        const { positionId } = (req.body || {}) as any;
        const wallet = await ensureWallet(CONFIG.walletPath);
        const walletKey = wallet.publicKey.toBase58();
        const inflightKey = `close:${walletKey}:${strategyName}:${positionId}`;
        (global as any).__inflightClose?.delete?.(inflightKey);
      } catch {}
    }
  });

  api.get('/grid/performance/:strategyName', async (req, res) => {
    try {
      const { strategyName } = req.params;
      const { GridTrader } = await import('../trading/gridStrategy.js');
      const walletMod: any = await import('../wallet/wallet.js');
      const walletKey = (await walletMod.ensureWallet(CONFIG.walletPath)).publicKey.toBase58();
      const instanceKey = `${walletKey}:${strategyName}`;
      
      const levels = GridTrader.getGridLevels(instanceKey);
      const positions = GridTrader.getGridPositions(instanceKey);
      const state = GridTrader.getGridState(instanceKey);
      
      // Calculate performance metrics
      const totalLevels = levels.length;
      const filledLevels = levels.filter(l => l.filled).length;
      const activePositions = positions.filter(p => !p.closedAt).length;
      const totalPnl = positions.reduce((sum, p) => sum + (p.pnl || 0), 0);
      const winRate = positions.length > 0 ? 
        positions.filter(p => (p.pnl || 0) > 0).length / positions.length : 0;
      
      res.json({
        strategyName,
        totalLevels,
        filledLevels,
        activePositions,
        totalPnl,
        winRate,
        state,
        recentTrades: positions.slice(-10)
      });
    } catch (e: any) {
      logger.error('Failed to get grid performance', { error: String(e?.message || e) });
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  api.post('/terminal/log', async (req, res) => {
    const { level = 'info', message, cat } = req.body as { level?: string; message: string; cat?: string };
    const normalizedCat = typeof cat === 'string' && cat.trim() ? String(cat).toLowerCase() : undefined;
    emit('log', { level, message, timestamp: new Date().toISOString(), cat: normalizedCat, context: normalizedCat ? { cat: normalizedCat } : undefined });
    res.json({ ok: true });
  });

  api.post('/api/stop', async (_req, res) => {
    apiStop();
    enablePriceFeed(false);
    res.json({ ok: true });
    emit('log', { level: 'info', message: 'API paused', timestamp: new Date().toISOString() });
  });

  api.post('/api/start', async (_req, res) => {
    apiStart();
    // do not auto-enable price feed; user must add watchlist or run apistart + enable watchlist
    res.json({ ok: true });
    emit('log', { level: 'info', message: 'API resumed', timestamp: new Date().toISOString() });
  });

  api.post('/api/reset', async (_req, res) => {
    apiReset();
    res.json({ ok: true });
    emit('log', { level: 'info', message: 'API window reset', timestamp: new Date().toISOString() });
  });

  // Configure Target Tick Time (TTT) in ms; updates rate limiter, price feed, and traders
  api.post('/ticktime', async (req, res) => {
    try {
      const { ms } = req.body as { ms: number };
      const value = Math.max(200, Math.floor(Number(ms) || 0));
      setTargetTickTimeMs(value);
      setPriceFeedInterval(value);
      tradingController.setTickTimeMs(value);
      res.json({ ok: true, targetTickTimeMs: value });
      emit('log', { level: 'info', message: `terminal: ticktime set to ${value} ms`, timestamp: new Date().toISOString() });
    } catch (e: any) {
      res.status(400).json({ error: 'invalid ms' });
    }
  });

	// Reset configurable parameters (watchlist, strategies, wallet tokens), preserving wallet key
	api.post('/config/reset', async (_req, res) => {
		try {
			// Halt trading and clear traders first
			try { tradingController.stop(); } catch {}
            await writeJson(CONFIG.watchlistPath, []);
            await writeJson(STRATEGY_LIST_PATH, []);
            await writeJson(CONFIG.walletTokensPath, []);
			io.emit('watchlist-update', []);
			io.emit('strategies-update', []);
			// Stop trading and clear all in-memory strategy/position state
			try {
				const { ThresholdTrader } = await import('../trading/thresholdStrategy.js');
				// Clear all positions/state/entries for every instance key
				for (const key of Object.keys((ThresholdTrader as any).positionsFor || {})) {
					(ThresholdTrader as any).positionsFor[key] = [];
				}
				for (const key of Object.keys((ThresholdTrader as any).stateFor || {})) {
					delete (ThresholdTrader as any).stateFor[key];
				}
				for (const key of Object.keys((ThresholdTrader as any).lastEntryPair || {})) {
					delete (ThresholdTrader as any).lastEntryPair[key];
				}
				// Clear inflight locks
				const inflight = (ThresholdTrader as any).inflightByWallet || {};
				for (const w of Object.keys(inflight)) {
					for (const pairKey of Object.keys(inflight[w] || {})) {
						delete inflight[w][pairKey].openLong;
						delete inflight[w][pairKey].openShort;
						delete inflight[w][pairKey].closeLong;
						delete inflight[w][pairKey].closeShort;
						delete inflight[w][pairKey].scaleLong;
						delete inflight[w][pairKey].scaleShort;
					}
				}
				// Broadcast cleared positions and stopped bot status
				emit('positions', []);
				io.emit('system', { bot: 'stopped' });
			} catch {}
			enablePriceFeed(false);
			res.json({ ok: true });
			emit('log', { level: 'info', message: 'Config reset (watchlist, strategies, wallet tokens) — trading halted and positions cleared', timestamp: new Date().toISOString() });
		} catch (e: any) {
			logger.error('config reset failed', { error: String(e) });
			res.status(500).json({ error: String(e) });
		}
	});

  app.use('/api', api);

  logger.info('API routes registered');
}


