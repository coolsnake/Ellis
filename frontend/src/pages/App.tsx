import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { logger } from '../utils/logger';
import { io, Socket } from 'socket.io-client';
import { GridStrategyConfig } from '../components/GridStrategyConfig';
import { LeveragedGridConfig } from '../components/LeveragedGridConfig';
import { GridMonitor } from '../components/GridMonitor';
import { ThresholdStrategyConfig } from '../components/ThresholdStrategyConfig';
import { AddTokenForm } from '../components/AddTokenForm';
import { FeeConfig } from '../components/FeeConfig';
import { ArbitragePanel } from '../components/ArbitragePanel';
import { ArbitrageMetrics } from '../components/ArbitrageMetrics';
import { ArbConfig } from '../components/ArbConfig';
import { DataFetchConfig } from '../components/DataFetchConfig';
import { ArbEngineConfig } from '../components/ArbEngineConfig';
import { SystemConfig } from '../components/SystemConfig';
import { GraphView } from '../components/GraphView';
import { CollapsibleSection } from '../components/CollapsibleSection';
import { setLogLevel as setFrontendLogLevel } from '../utils/logger';
// Login page is now routed at /login; main app assumes authenticated state

type LogEvent = { level: string; message: string; timestamp: string; context?: Record<string, unknown>; cat?: string; muted?: boolean };

export const App: React.FC = () => {
  const [system, setSystem] = useState<any>({});
  const [wallet, setWallet] = useState<any>(null);
  const [watchlist, setWatchlist] = useState<any[]>([]);
  const [strategies, setStrategies] = useState<any[]>([]);
  const [driftStatus, setDriftStatus] = useState<any>(null);
  const [driftSubaccounts, setDriftSubaccounts] = useState<any[]>([]);
  const [driftSelectedSubId, setDriftSelectedSubId] = useState<number>(0);
  const [driftOpBusy, setDriftOpBusy] = useState<boolean>(false);
  const [driftAmount, setDriftAmount] = useState<number>(0);
  const [driftSpotIndex, setDriftSpotIndex] = useState<number>(0);
  const [tradeLogs, setTradeLogs] = useState<LogEvent[]>([]);
  const [strategyLogs, setStrategyLogs] = useState<LogEvent[]>([]);
  const [arbLogs, setArbLogs] = useState<LogEvent[]>([]);
  const [apiLogs, setApiLogs] = useState<LogEvent[]>([]);
  const [terminalLogs, setTerminalLogs] = useState<LogEvent[]>([]);
  const [positions, setPositions] = useState<any[]>([]);
  const [gridPositionsSummary, setGridPositionsSummary] = useState<Array<{ strategy: string; fromSymbol: string; toSymbol: string; count: number; totalFromToken: number; avgOpenMs: number }>>([]);
  const [activity, setActivity] = useState<{ status: string; trades: any[] }>({ status: 'idle', trades: [] });
  const [activitiesByStrategy, setActivitiesByStrategy] = useState<Record<string, { status: string; trades: any[]; pair?: string; anchor?: number; buyTrigger?: number; sellTrigger?: number; currentPairPrice?: number }>>({});
  const [prices, setPrices] = useState<Record<string, { usdc: number | null; sol: number | null }>>({});
  const [walletTokens, setWalletTokens] = useState<any[]>([]);
  const [walletHistory, setWalletHistory] = useState<any[]>([]);
  const [terminalInput, setTerminalInput] = useState('');
  const [showGridConfig, setShowGridConfig] = useState(false);
  const [showLevGridConfig, setShowLevGridConfig] = useState(false);
  const [showThresholdConfig, setShowThresholdConfig] = useState(false);
  const [showAddToken, setShowAddToken] = useState(false);
  const [editingStrategy, setEditingStrategy] = useState<any>(null);
  const [selectedGridStrategies, setSelectedGridStrategies] = useState<Set<string>>(new Set());
  const [collapsedStrategies, setCollapsedStrategies] = useState<Record<string, boolean>>({});
  const [collapsedStrategyParams, setCollapsedStrategyParams] = useState<Record<string, boolean>>({});
  const [showFeeConfig, setShowFeeConfig] = useState(false);
  const [showSystemConfig, setShowSystemConfig] = useState(false);
  const [showArbConfig, setShowArbConfig] = useState(false);
  const [showDataFetchConfig, setShowDataFetchConfig] = useState(false);
  const [showEngineConfig, setShowEngineConfig] = useState(false);
  const [showGraph, setShowGraph] = useState(false);
  const socketRef = useRef<Socket | null>(null);
  const lastSystemRef = useRef<number>(Date.now());
  const [isConnected, setIsConnected] = useState<boolean>(false);
  const [arbConfig, setArbConfig] = useState<any>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [creds, setCreds] = useState<{ user: string; pass: string } | null>(() => {
    try {
      const s = localStorage.getItem('authCreds');
      return s ? JSON.parse(s) : null;
    } catch { return null; }
  });

  // Default to same-origin behind nginx; allow overrides via env
  const apiBase = useMemo(() => (import.meta as any).env?.VITE_API_BASE ?? '/api', []);
  const wsUrl = useMemo(() => (import.meta as any).env?.VITE_WS_URL ?? (typeof window !== 'undefined' ? `${window.location.origin}` : ''), []);

  // Load collapsed state from localStorage on mount
  useEffect(() => {
    const saved = localStorage.getItem('collapsedStrategies');
    if (saved) {
      try {
        setCollapsedStrategies(JSON.parse(saved));
      } catch (e) {
        logger.warn('Failed to parse collapsed strategies from localStorage:', e);
      }
    }
    const savedParams = localStorage.getItem('collapsedStrategyParams');
    if (savedParams) {
      try {
        setCollapsedStrategyParams(JSON.parse(savedParams));
      } catch (e) {
        logger.warn('Failed to parse collapsed strategy params from localStorage:', e);
      }
    }
  }, []);

  // Save collapsed state to localStorage whenever it changes
  useEffect(() => {
    localStorage.setItem('collapsedStrategies', JSON.stringify(collapsedStrategies));
  }, [collapsedStrategies]);
  useEffect(() => {
    localStorage.setItem('collapsedStrategyParams', JSON.stringify(collapsedStrategyParams));
  }, [collapsedStrategyParams]);

  const toggleStrategyParams = (name: string) => {
    setCollapsedStrategyParams(prev => ({ ...prev, [name]: !prev[name] }));
  };

  // Helper to inject Basic Authorization header when creds exist
  const authHeaders = useMemo(() => {
    if (!creds) return {};
    const token = btoa(`${creds.user}:${creds.pass}`);
    return { Authorization: `Basic ${token}` } as Record<string, string>;
  }, [creds]);

  useEffect(() => {
    if (!creds) return;
    fetch(`${apiBase}/system`).then(r => r.json()).then(setSystem);
    fetch(`${apiBase}/wallet`).then(r => r.json()).then(setWallet);
    fetch(`${apiBase}/watchlist`).then(r => r.json()).then(d => setWatchlist(d.watchlist));
    // Load base (spot) strategies first
    fetch(`${apiBase}/strategy`).then(r => r.json()).then(async (d) => {
      const baseList = d.strategies || [];
      // Load Drift leveraged grid strategies and merge into the same list for display
      try {
        const resp = await fetch(`${apiBase}/strategies/leveraged-grid/status`);
        const lg = await resp.json();
        const mapped = Array.isArray(lg?.strategies) ? (lg.strategies as any[]).map((s: any, i: number) => {
          const cfg = (s?.status?.config || {}) as any;
          const market = cfg?.market || {};
          const toSym = market?.symbol || `PERP-${market?.marketIndex ?? '?'}`;
          return {
            name: cfg?.name || `lev-grid-${market?.marketIndex ?? i}`,
            type: 'drift-grid',
            fromToken: 'USDC',
            toToken: toSym,
            gridType: 'drift',
            gridLevels: [],
            active: !!(s?.status?.running),
          } as any;
        }) : [];
        setStrategies([...(baseList || []), ...mapped]);
      } catch {
        setStrategies(baseList || []);
      }
    });
    fetch(`${apiBase}/wallet/tokens`).then(r => r.json()).then(d => setWalletTokens(d.walletTokens || []));
    fetch(`${apiBase}/arb/config`).then(r => r.json()).then(setArbConfig).catch(() => {});
    // Load Drift status/subaccounts for Drift panel
    (async () => {
      try {
        const st = await fetch(`${apiBase}/drift/status`).then(r => r.json());
        setDriftStatus(st);
        try {
          const subsResp = await fetch(`${apiBase}/drift/subaccounts`).then(r => r.json());
          const subs = subsResp?.subaccounts || [];
          setDriftSubaccounts(subs);
          if (Array.isArray(subs) && subs.length > 0) setDriftSelectedSubId(Number(subs[0].id));
        } catch {}
      } catch {}
    })();
  }, [apiBase, authHeaders, creds]);

  useEffect(() => {
    if (!creds) return;
    const socket = io(wsUrl, {
      path: '/socket.io',
      transports: ['websocket', 'polling'],
      auth: { user: creds.user, pass: creds.pass },
      extraHeaders: authHeaders as any,
    });
    socketRef.current = socket;
    socket.on('connect', () => setIsConnected(true));
    socket.on('disconnect', () => setIsConnected(false));
    socket.on('system', (data) => { lastSystemRef.current = Date.now(); setSystem((prev: any) => ({ ...prev, ...data })); });
    socket.on('wallet-update', (data) => setWallet((prev: any) => ({ ...prev, ...data })));
    socket.on('watchlist-update', (list) => setWatchlist(list));
    socket.on('log', (evt: LogEvent & { cat?: string; muted?: boolean }) => {
      const cat = (evt?.cat || '').toLowerCase();
      const msg = (evt?.message || '').toString();
      // Frontend category filter: use server-provided defaults if present
      const serverCats: string[] | undefined = (system as any)?.system?.frontendEnabledLogCategories || (system as any)?.system?.enabledLogCategories;
      const localCatsJson = typeof window !== 'undefined' ? window.localStorage.getItem('frontendEnabledLogCategories') : null;
      const localCats: string[] | null = localCatsJson ? JSON.parse(localCatsJson) : null;
      const allowedCats = Array.isArray(localCats) && localCats.length ? localCats : (Array.isArray(serverCats) ? serverCats : null);
      if (allowedCats && allowedCats.length && cat && !allowedCats.includes(cat)) return;
      if (evt.muted === true) return; // backend flagged as muted
      const push = (setter: React.Dispatch<React.SetStateAction<LogEvent[]>>) => setter((prev) => [evt, ...prev].slice(0, 500));
      const isApiCat = cat === 'api' || cat === 'jupiter' || cat === 'raydium' || cat === 'orca';
      // Categorize without duplication
      // User Log: user-facing
      if (!isApiCat && (
        cat === 'terminal' || msg.startsWith('terminal:') ||
        cat === 'trade' && /executed|submitted|filled|success|fail|error/i.test(msg) ||
        /swap success|filled:|executed:|Swap executed/i.test(msg) ||
        /strategy (saved|updated|removed)/i.test(msg) || (/\bwatchlist\b|wallet addtoken/i.test(msg) && !/^api\./i.test(msg))
      )) {
        push(setTerminalLogs);
      }
      // Trade Log: trade lifecycle (quotes ok to show here if directly tied to a trade attempt)
      if (cat === 'trade' || cat === 'pretrade' || /^pretrade:|^trade:/i.test(msg)) {
        push(setTradeLogs);
      }
      // Strategy Log: strategy computations and triggers
      if (cat === 'strategy' || /^strategy:/i.test(msg)) {
        push(setStrategyLogs);
      }
      // Arbitrage Log: arb engine activity
      if (cat === 'arb' || /^arb\b|^pretrade:arb|^trade:arb/i.test(msg)) {
        push(setArbLogs);
      }
      // API Log: internal/external API requests
      if (cat === 'api' || cat === 'jupiter' || cat === 'raydium' || cat === 'orca' || /^api:|^jup\.|^raydium:|^orca:/i.test(msg)) {
        push(setApiLogs);
      }
    });
    socket.on('prices-update', (p) => setPrices(p));
    socket.on('strategies-update', (list) => {
      const next = Array.isArray(list) ? list : [];
      setStrategies(next);
      // Remove grid summaries for strategies that no longer exist
      try {
        const valid = new Set((next || []).map((s: any) => s?.name).filter(Boolean));
        setGridPositionsSummary((prev) => (prev || []).filter((x) => valid.has(x.strategy)));
      } catch {}
    });
    socket.on('positions', (p) => setPositions(p || []));
    socket.on('grid-positions', (payload: any) => {
      const updates = Array.isArray(payload) ? payload : [payload];
      setGridPositionsSummary((prev) => {
        const map = new Map<string, { strategy: string; fromSymbol: string; toSymbol: string; count: number; totalFromToken: number; avgOpenMs: number }>(
          (prev || []).map((x) => [x.strategy, x])
        );
        for (const u of updates) {
          if (u && typeof u.strategy === 'string') {
            map.set(u.strategy, u);
          }
        }
        return Array.from(map.values());
      });
    });
    socket.on('wallet-history', (h) => setWalletHistory(h || []));
    socket.on('activity', (a) => {
      setActivity(a || { status: 'idle', trades: [] });
      const name = (a && (a as any).strategy) || 'default';
      setActivitiesByStrategy((prev) => ({
        ...prev,
        [name]: {
          status: a?.status || 'idle',
          trades: a?.trades || [],
          pair: (a as any)?.pair,
          anchor: (a as any)?.anchor,
          buyTrigger: (a as any)?.buyTrigger,
          sellTrigger: (a as any)?.sellTrigger,
          currentPairPrice: (a as any)?.currentPairPrice ?? (a as any)?.current,
          phaseLabel: (a as any)?.phaseLabel,
          nextAction: (a as any)?.nextAction,
          holding: (a as any)?.holding,
          completedCycles: (a as any)?.completedCycles,
          realizedPnlFrom: (a as any)?.realizedPnlFrom,
          unrealizedPnlFrom: (a as any)?.unrealizedPnlFrom,
        }
      }));
    });
    return () => { socket.disconnect(); };
  }, [wsUrl, creds, authHeaders]);

  const onLogin = (c: { user: string; pass: string }) => {
    setAuthError(null);
    // probe first; only persist/set creds on success
    const token = btoa(`${c.user}:${c.pass}`);
    fetch(`${apiBase}/system`, { headers: { Authorization: `Basic ${token}` } })
      .then(r => { if (!r.ok) throw new Error('Invalid credentials'); return r.json(); })
      .then((sys) => {
        setCreds(c);
        try { localStorage.setItem('authCreds', JSON.stringify(c)); } catch {}
        setSystem(sys);
      })
      .catch(() => setAuthError('Invalid username or password'));
  };

  const onLogout = () => {
    setCreds(null);
    setAuthError(null);
    try { localStorage.removeItem('authCreds'); } catch {}
    try { socketRef.current?.disconnect(); } catch {}
  };

  // Always require login: gate the app until credentials are provided
  const needsLogin = !creds;

  if (needsLogin) {
    return <Navigate to="/login" replace />;
  }

  const isGridStrategy = (strategy: any) => {
    return !!(strategy.gridType || strategy.gridSpacing || strategy.gridLevels || strategy.totalAmount || strategy.levelAmount);
  };

  const toggleStrategyCollapse = (strategyName: string) => {
    setCollapsedStrategies(prev => ({
      ...prev,
      [strategyName]: !prev[strategyName]
    }));
  };

  const toggleGridStrategyMonitor = (strategyName: string) => {
    setSelectedGridStrategies(prev => {
      const newSet = new Set(prev);
      if (newSet.has(strategyName)) {
        newSet.delete(strategyName);
      } else {
        newSet.add(strategyName);
      }
      return newSet;
    });
  };

  const expandAllStrategies = () => {
    setCollapsedStrategies({});
  };

  const collapseAllStrategies = () => {
    const allCollapsed = strategies.reduce((acc, strategy) => {
      acc[strategy.name || 'default'] = true;
      return acc;
    }, {} as Record<string, boolean>);
    setCollapsedStrategies(allCollapsed);
  };

  const handleSystemConfigSave = async (config: any) => {
    try {
      const response = await fetch(`${apiBase}/system/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config)
      });
      
      if (response.ok) {
        setShowSystemConfig(false);
        // Refresh system info
        const systemResponse = await fetch(`${apiBase}/system`);
        const systemData = await systemResponse.json();
        setSystem(systemData);
        // Apply frontend log level locally if provided
        try {
          const lvl = (config?.system?.frontendLogLevel || config?.system?.logLevel);
          if (lvl === 'error' || lvl === 'warn' || lvl === 'info' || lvl === 'debug') {
            setFrontendLogLevel(lvl);
          }
        } catch {}
      } else {
        logger.error('Failed to save system configuration');
      }
    } catch (error) {
      logger.error('Error saving system configuration:', error);
    }
  };

  const handleSaveGridStrategy = async (config: any) => {
    try {
      const response = await fetch(`${apiBase}/strategy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config)
      });
      
      if (response.ok) {
        const data = await response.json();
        setStrategies(data.strategies || []);
        setShowGridConfig(false);
        setEditingStrategy(null);
        await fetch(`${apiBase}/terminal/log`, { 
          method: 'POST', 
          headers: { 'Content-Type': 'application/json' }, 
          body: JSON.stringify({ level: 'info', message: `terminal: Grid strategy saved: ${config.name}` }) 
        });
      } else {
        const error = await response.json();
        throw new Error(error.error || 'Failed to save strategy');
      }
    } catch (error: any) {
      await fetch(`${apiBase}/terminal/log`, { 
        method: 'POST', 
        headers: { 'Content-Type': 'application/json' }, 
        body: JSON.stringify({ level: 'error', message: `terminal: Failed to save grid strategy: ${error.message}` }) 
      });
    }
  };

  const handleEditGridStrategy = (strategy: any) => {
    setEditingStrategy(strategy);
    setShowGridConfig(true);
  };

  const handleCreateGridStrategy = () => {
    setEditingStrategy(null);
    setShowGridConfig(true);
  };
  const handleCreateLeveragedGrid = () => {
    setShowLevGridConfig(true);
  };

  const handleSaveThresholdStrategy = async (config: any) => {
    try {
      const response = await fetch(`${apiBase}/strategy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config)
      });
      
      if (response.ok) {
        const data = await response.json();
        setStrategies(data.strategies || []);
        setShowThresholdConfig(false);
        setEditingStrategy(null);
        await fetch(`${apiBase}/terminal/log`, { 
          method: 'POST', 
          headers: { 'Content-Type': 'application/json' }, 
          body: JSON.stringify({ level: 'info', message: `terminal: Threshold strategy saved: ${config.name}` }) 
        });
      } else {
        const error = await response.json();
        throw new Error(error.error || 'Failed to save strategy');
      }
    } catch (error: any) {
      await fetch(`${apiBase}/terminal/log`, { 
        method: 'POST', 
        headers: { 'Content-Type': 'application/json' }, 
        body: JSON.stringify({ level: 'error', message: `terminal: Failed to save threshold strategy: ${error.message}` }) 
      });
    }
  };

  const handleEditThresholdStrategy = (strategy: any) => {
    setEditingStrategy(strategy);
    setShowThresholdConfig(true);
  };

  const handleCreateThresholdStrategy = () => {
    setEditingStrategy(null);
    setShowThresholdConfig(true);
  };

  const handleRemoveStrategy = async (strategyName: string) => {
    if (!confirm(`Are you sure you want to remove strategy "${strategyName}"? This will also close any associated positions.`)) {
      return;
    }

    try {
      const response = await fetch(`${apiBase}/strategy`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: strategyName })
      });
      
      if (response.ok) {
        const data = await response.json();
        setStrategies(data.strategies || []);
        await fetch(`${apiBase}/terminal/log`, { 
          method: 'POST', 
          headers: { 'Content-Type': 'application/json' }, 
          body: JSON.stringify({ level: 'info', message: `terminal: Strategy removed: ${strategyName}` }) 
        });
      } else {
        const error = await response.json();
        throw new Error(error.error || 'Failed to remove strategy');
      }
    } catch (error: any) {
      await fetch(`${apiBase}/terminal/log`, { 
        method: 'POST', 
        headers: { 'Content-Type': 'application/json' }, 
        body: JSON.stringify({ level: 'error', message: `terminal: Failed to remove strategy: ${error.message}` }) 
      });
    }
  };

  const handleAddToken = async (token: { symbol: string; mint?: string; name?: string }) => {
    try {
      const response = await fetch(`${apiBase}/watchlist`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: token.mint || token.symbol })
      });
      
      if (response.ok) {
        const data = await response.json();
        setWatchlist(data.watchlist || []);
        setShowAddToken(false);
        await fetch(`${apiBase}/terminal/log`, { 
          method: 'POST', 
          headers: { 'Content-Type': 'application/json' }, 
          body: JSON.stringify({ level: 'info', message: `terminal: Token added to watchlist: ${token.symbol}` }) 
        });
      } else {
        const error = await response.json();
        throw new Error(error.error || 'Failed to add token');
      }
    } catch (error: any) {
      await fetch(`${apiBase}/terminal/log`, { 
        method: 'POST', 
        headers: { 'Content-Type': 'application/json' }, 
        body: JSON.stringify({ level: 'error', message: `terminal: Failed to add token: ${error.message}` }) 
      });
    }
  };

  const handleRemoveToken = async (token: string | { symbol: string; id?: string }) => {
    try {
      const tokenSymbol = typeof token === 'string' ? token : token.symbol;
      
      const response = await fetch(`${apiBase}/watchlist`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idOrSymbol: tokenSymbol })
      });
      
      if (response.ok) {
        const data = await response.json();
        setWatchlist(data.watchlist || []);
        await fetch(`${apiBase}/terminal/log`, { 
          method: 'POST', 
          headers: { 'Content-Type': 'application/json' }, 
          body: JSON.stringify({ level: 'info', message: `terminal: Token removed from watchlist: ${tokenSymbol}` }) 
        });
      } else {
        const error = await response.json();
        throw new Error(error.error || 'Failed to remove token');
      }
    } catch (error: any) {
      await fetch(`${apiBase}/terminal/log`, { 
        method: 'POST', 
        headers: { 'Content-Type': 'application/json' }, 
        body: JSON.stringify({ level: 'error', message: `terminal: Failed to remove token: ${error.message}` }) 
      });
    }
  };

  async function handleTerminal(cmd: string) {
    if (cmd) {
      await fetch(`${apiBase}/terminal/log`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'info', message: `terminal: > ${cmd}` }) });
    }
    // Namespaced command routing (preferred)
    {
      const parts = cmd.split(/\s+/).filter(Boolean);
      const ns = (parts[0] || '').toLowerCase();
      if (ns === 'wallet') {
        const action = (parts[1] || '').toLowerCase();
        if (action === 'generate') {
          try {
            const resp = await fetch(`${apiBase}/wallet/generate`, { method: 'POST' });
            const json = await resp.json();
            if (!resp.ok) throw new Error(json?.error || 'generate failed');
            await fetch(`${apiBase}/terminal/log`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'info', message: `terminal: wallet generated ${json.address}` }) });
          } catch (e: any) {
            await fetch(`${apiBase}/terminal/log`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'error', message: `terminal: wallet generate failed ${String(e?.message || e)}` }) });
          }
          return;
        }
        if (action === 'wrap') {
          const amount = Number(parts[2]);
          if (!isFinite(amount) || amount <= 0) {
            await fetch(`${apiBase}/terminal/log`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'warn', message: 'terminal: wallet wrap AMOUNT' }) });
          } else {
            try {
              const resp = await fetch(`${apiBase}/wallet/wrap`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ amount }) });
              const json = await resp.json();
              if (!resp.ok) throw new Error(json?.error || 'wrap failed');
              await fetch(`${apiBase}/terminal/log`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'info', message: `terminal: wallet wrap success ${amount} SOL sig=${json.signature}` }) });
            } catch (e: any) {
              await fetch(`${apiBase}/terminal/log`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'error', message: `terminal: wallet wrap failed ${String(e?.message || e)}` }) });
            }
          }
          return;
        }
        if (action === 'unwrap') {
          try {
            const resp = await fetch(`${apiBase}/wallet/unwrap`, { method: 'POST' });
            const json = await resp.json();
            if (!resp.ok) throw new Error(json?.error || 'unwrap failed');
            await fetch(`${apiBase}/terminal/log`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'info', message: `terminal: wallet unwrap success sig=${json.signature}` }) });
          } catch (e: any) {
            await fetch(`${apiBase}/terminal/log`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'error', message: `terminal: wallet unwrap failed ${String(e?.message || e)}` }) });
          }
          return;
        }
        if (action === 'refresh') {
          try { await fetch(`${apiBase}/wallet/refresh`, { method: 'POST' }); } catch {}
          return;
        }
        if (action === 'send') {
          if (parts.length >= 5) {
            const token = parts[2];
            const amount = Number(parts[3]);
            const address = parts[4];
            if (!isFinite(amount) || amount <= 0) {
              await fetch(`${apiBase}/terminal/log`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'warn', message: 'terminal: wallet send TOKEN|MINT AMOUNT ADDRESS' }) });
              return;
            }
            try {
              const resp = await fetch(`${apiBase}/wallet/send`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, destination: address, amount }) });
              const json = await resp.json();
              if (!resp.ok) throw new Error(json?.error || 'send failed');
              await fetch(`${apiBase}/terminal/log`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'info', message: `terminal: wallet send success sig=${json.signature || '(n/a)'}` }) });
            } catch (e: any) {
              await fetch(`${apiBase}/terminal/log`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'error', message: `terminal: wallet send failed ${String(e?.message || e)}` }) });
            }
          } else {
            await fetch(`${apiBase}/terminal/log`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'warn', message: 'terminal: wallet send TOKEN|MINT AMOUNT ADDRESS' }) });
          }
          return;
        }
        if (action === 'addtoken') {
          const query = parts.slice(2).join(' ');
          if (!query) {
            await fetch(`${apiBase}/terminal/log`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'warn', message: 'terminal: wallet addtoken TOKEN|MINT' }) });
            return;
          }
          const resp = await fetch(`${apiBase}/wallet/tokens`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query }) });
          const json = await resp.json();
          if (!resp.ok) {
            await fetch(`${apiBase}/terminal/log`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'error', message: `terminal: wallet addtoken failed: ${json?.error || 'unknown'}` }) });
          } else {
            setWalletTokens(json.walletTokens || []);
            await fetch(`${apiBase}/terminal/log`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'info', message: `terminal: wallet addtoken added ${json.added?.symbol || json.added?.id}` }) });
          }
          return;
        }
        await fetch(`${apiBase}/terminal/log`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'warn', message: 'terminal: wallet commands: generate | refresh | send TOKEN|MINT AMOUNT ADDRESS | addtoken TOKEN|MINT | wrap AMOUNT | unwrap' }) });
        return;
      }
      if (ns === 'watchlist') {
        const action = (parts[1] || '').toLowerCase();
        if (action === 'add') {
          const query = cmd.slice('watchlist add '.length).trim();
          if (!query) {
            await fetch(`${apiBase}/terminal/log`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'warn', message: 'terminal: watchlist add QUERY|MINT' }) });
          } else {
            await fetch(`${apiBase}/terminal/log`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'info', message: `terminal: -> adding ${query} to watchlist` }) });
            await fetch(`${apiBase}/watchlist`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query }) });
          }
          return;
        }
        if (action === 'remove') {
          const idOrSymbol = parts[2];
          if (!idOrSymbol) {
            await fetch(`${apiBase}/terminal/log`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'warn', message: 'terminal: watchlist remove SYMBOL|MINT' }) });
          } else {
            await fetch(`${apiBase}/terminal/log`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'info', message: `terminal: -> removing ${idOrSymbol} from watchlist` }) });
            await fetch(`${apiBase}/watchlist`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idOrSymbol }) });
          }
          return;
        }
        if (action === 'list') {
          const d = await (await fetch(`${apiBase}/watchlist`)).json();
          setWatchlist(d.watchlist || []);
          return;
        }
        await fetch(`${apiBase}/terminal/log`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'warn', message: 'terminal: watchlist commands: add QUERY|MINT | remove SYMBOL|MINT | list' }) });
        return;
      }
      if (ns === 'strategy') {
        const action = (parts[1] || '').toLowerCase();
        if (action === 'list') {
          const updated = await (await fetch(`${apiBase}/strategy`)).json();
          setStrategies(updated.strategies || []);
          return;
        }
        // Shorthand update: strategy NAME key=value [key=value ...]
        if (action && !['list','set','remove','status'].includes(action)) {
          const name = parts[1];
          const kvParts = parts.slice(2);
          if (!name || kvParts.length === 0) {
            await fetch(`${apiBase}/terminal/log`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'warn', message: 'terminal: strategy NAME key=value [key=value ...]' }) });
            return;
          }
          const rawKv: Record<string, string> = {};
          for (const p of kvParts) { const [k,v] = p.split('='); if (k && v !== undefined) rawKv[k.toLowerCase()] = v; }
          const boolKeys = new Set(['test','fixedanchor','lst','active','slidinganchor']);
          const numKeys = new Set(['buypct','sellpct','amount','scaleaggressiveness','scalesteppct','slippagebps','maxopenpositions','maxpositionsize','hysteresisbps','cooldownms','feebps','extraslippagebps','anchorpairatsetup','slideratebpspersec','slidemaxpct']);
          const mapKeys: Record<string,string> = {
            fromtoken:'fromToken', totoken:'toToken', token:'token', marketenter:'marketEnter', navsource:'navSource',
            buypct:'buyPct', sellpct:'sellPct',
            scaleaggressiveness:'scaleAggressiveness', scalesteppct:'scaleStepPct',
            slippagebps:'slippageBps', maxopenpositions:'maxOpenPositions', maxpositionsize:'maxPositionSize',
            hysteresisbps:'hysteresisBps', cooldownms:'cooldownMs', feebps:'feeBps', extraslippagebps:'extraSlippageBps',
            anchorpairatsetup:'anchorPairAtSetup',
            slidinganchor:'slidingAnchor', slideratebpspersec:'slideRateBpsPerSec', slidemaxpct:'slideMaxPct',
            test:'testMode'
          };
          const payload: any = { name };
          for (const [k, v] of Object.entries(rawKv)) {
            const key = mapKeys[k] || k;
            if (boolKeys.has(k)) payload[key] = v.toLowerCase() === 'true';
            else if (numKeys.has(k)) payload[key] = Number(v);
            else payload[key] = v;
          }
          await fetch(`${apiBase}/terminal/log`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'info', message: `terminal: -> strategy update ${name} ${JSON.stringify(payload)}` }) });
          const resp = await fetch(`${apiBase}/strategy`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
          const updated = await (await fetch(`${apiBase}/strategy`)).json();
          setStrategies(updated.strategies || []);
          if (!resp.ok) {
            await fetch(`${apiBase}/terminal/log`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'error', message: 'terminal: strategy update failed' }) });
          } else {
            await fetch(`${apiBase}/terminal/log`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'info', message: `terminal: strategy updated ${name}` }) });
          }
          return;
        }
        if (action === 'set') {
          const raw = cmd.slice('strategy set '.length);
          const items = raw.split(/[\s,]+/).filter(Boolean);
          const kv: Record<string, string> = {};
          for (const p of items) { const [k, v] = p.split('='); if (k && v !== undefined) kv[k.toLowerCase()] = v; }
          const current: any = {};
          const next = {
            ...current,
            name: kv.name ?? 'default',
            token: kv.totoken || kv.token || current.token || 'SOL',
            buyPct: kv.buypct ? Number(kv.buypct) : current.buyPct ?? 0.05,
            sellPct: kv.sellpct ? Number(kv.sellpct) : current.sellPct ?? 0.05,
            amount: kv.amount ? Number(kv.amount) : current.amount ?? 0.1,
            testMode: kv.test ? kv.test.toLowerCase() === 'true' : current.testMode ?? true,
            inputMintUSDC: kv.inputmintusdc,
            tokenMint: kv.tokenmint,
            fromToken: kv.fromtoken,
            toToken: kv.totoken,
            scaleAggressiveness: kv.scaleaggressiveness ? Number(kv.scaleaggressiveness) : (current as any).scaleAggressiveness,
            scaleStepPct: kv.scalesteppct ? Number(kv.scalesteppct) : (current as any).scaleStepPct,
            marketEnter: kv.marketenter ? (kv.marketenter.toLowerCase() === 'long' ? 'long' : (kv.marketenter.toLowerCase() === 'short' ? 'short' : null)) : (current as any).marketEnter,
            fixedAnchor: kv.fixedanchor ? kv.fixedanchor.toLowerCase() === 'true' : (current as any).fixedAnchor,
            slippageBps: kv.slippagebps ? Number(kv.slippagebps) : (current as any).slippageBps,
            // Newly supported fields for quick set
            lst: kv.lst ? kv.lst.toLowerCase() === 'true' : (current as any).lst,
            navSource: kv.navsource ? (kv.navsource.toLowerCase() === 'protocol' ? 'protocol' : 'ema') : (current as any).navSource,
            hysteresisBps: kv.hysteresisbps ? Number(kv.hysteresisbps) : (current as any).hysteresisBps,
            cooldownMs: kv.cooldownms ? Number(kv.cooldownms) : (current as any).cooldownMs,
            feeBps: kv.feebps ? Number(kv.feebps) : (current as any).feeBps,
            extraSlippageBps: kv.extraslippagebps ? Number(kv.extraslippagebps) : (current as any).extraSlippageBps,
            maxOpenPositions: kv.maxopenpositions ? Number(kv.maxopenpositions) : (current as any).maxOpenPositions,
            maxPositionSize: kv.maxpositionsize ? Number(kv.maxpositionsize) : (current as any).maxPositionSize,
            anchorPairAtSetup: kv.anchorpairatsetup ? Number(kv.anchorpairatsetup) : (current as any).anchorPairAtSetup,
          } as any;
          await fetch(`${apiBase}/terminal/log`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'info', message: `terminal: -> strategy set ${JSON.stringify(next)}` }) });
          await fetch(`${apiBase}/strategy`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(next) });
          const updated = await (await fetch(`${apiBase}/strategy`)).json();
          setStrategies(updated.strategies || []);
          await fetch(`${apiBase}/terminal/log`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'info', message: `terminal: strategy set ${JSON.stringify(next)}` }) });
          return;
        }
        if (action === 'remove') {
          const name = parts[2];
          if (!name) {
            await fetch(`${apiBase}/terminal/log`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'warn', message: 'terminal: strategy remove NAME' }) });
          } else {
            await fetch(`${apiBase}/strategy`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
            const updated = await (await fetch(`${apiBase}/strategy`)).json();
            setStrategies(updated.strategies || []);
            await fetch(`${apiBase}/terminal/log`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'info', message: `terminal: -> strategy remove ${name}` }) });
          }
          return;
        }
        await fetch(`${apiBase}/terminal/log`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'warn', message: 'terminal: strategy commands: list | set name=... token=... buyPct=... sellPct=... amount=... test=true|false | remove NAME' }) });
        return;
      }
      if (ns === 'bot') {
        const action = (parts[1] || '').toLowerCase();
        if (action === 'start') { await fetch(`${apiBase}/bot/start`, { method: 'POST' }); return; }
        if (action === 'stop') { await fetch(`${apiBase}/bot/stop`, { method: 'POST' }); return; }
        await fetch(`${apiBase}/terminal/log`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'warn', message: 'terminal: bot commands: start | stop' }) });
        return;
      }
      if (ns === 'api') {
        const action = (parts[1] || '').toLowerCase();
        if (action === 'start') { await fetch(`${apiBase}/api/start`, { method: 'POST' }); return; }
        if (action === 'stop') { await fetch(`${apiBase}/api/stop`, { method: 'POST' }); return; }
        if (action === 'reset') { await fetch(`${apiBase}/api/reset`, { method: 'POST' }); return; }
        await fetch(`${apiBase}/terminal/log`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'warn', message: 'terminal: api commands: start | stop | reset' }) });
        return;
      }
      if (ns === 'swap') {
        if (parts.length >= 4) {
          const amount = Number(parts[1]);
          const from = parts[2];
          const to = parts[3];
          try {
            await fetch(`${apiBase}/terminal/log`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'info', message: `terminal: -> swapping ${amount} ${from} ${to}` }) });
            const resp = await fetch(`${apiBase}/swap`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ amount, from, to }) });
            const json = await resp.json();
            if (!resp.ok) throw new Error(json?.error || 'swap failed');
            await fetch(`${apiBase}/terminal/log`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'info', message: `terminal: swap success ${amount} ${from}->${to} sig=${json.signature}` }) });
          } catch (e: any) {
            await fetch(`${apiBase}/terminal/log`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'error', message: `terminal: swap failed ${String(e?.message || e)}` }) });
          }
        } else {
          await fetch(`${apiBase}/terminal/log`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'warn', message: 'terminal: swap AMOUNT FROM TO' }) });
        }
        return;
      }
      if (ns === 'ticktime') {
        const ms = Number(parts[1]);
        if (!isFinite(ms) || ms <= 0) {
          await fetch(`${apiBase}/terminal/log`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'warn', message: 'terminal: ticktime MS (e.g., ticktime 2000)' }) });
        } else {
          const resp = await fetch(`${apiBase}/ticktime`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ms }) });
          const json = await resp.json();
          if (!resp.ok) {
            await fetch(`${apiBase}/terminal/log`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'error', message: `terminal: ticktime failed ${json?.error || 'unknown'}` }) });
          } else {
            setSystem((prev: any) => ({ ...prev, targetTickTimeMs: json.targetTickTimeMs }));
            await fetch(`${apiBase}/terminal/log`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'info', message: `terminal: ticktime set to ${json.targetTickTimeMs} ms` }) });
          }
        }
        return;
      }
      if (ns === 'config') {
        const action = (parts[1] || '').toLowerCase();
        if (action === 'reset') {
          try {
            const resp = await fetch(`${apiBase}/config/reset`, { method: 'POST' });
            if (!resp.ok) throw new Error('reset failed');
            const wl = await (await fetch(`${apiBase}/watchlist`)).json();
            setWatchlist(wl.watchlist || []);
            const st = await (await fetch(`${apiBase}/strategy`)).json();
            setStrategies(st.strategies || []);
            const wt = await (await fetch(`${apiBase}/wallet/tokens`)).json();
            setWalletTokens(wt.walletTokens || []);
            await fetch(`${apiBase}/terminal/log`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'info', message: 'terminal: config reset executed' }) });
          } catch (e: any) {
            await fetch(`${apiBase}/terminal/log`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'error', message: `terminal: config reset failed ${String(e?.message || e)}` }) });
          }
        } else if (action === 'ticktime') {
          const ms = Number(parts[2]);
          if (!isFinite(ms) || ms <= 0) {
            await fetch(`${apiBase}/terminal/log`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'warn', message: 'terminal: config ticktime MS' }) });
          } else {
            const resp = await fetch(`${apiBase}/ticktime`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ms }) });
            const json = await resp.json();
            if (!resp.ok) {
              await fetch(`${apiBase}/terminal/log`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'error', message: `terminal: ticktime failed ${json?.error || 'unknown'}` }) });
            } else {
              setSystem((prev: any) => ({ ...prev, targetTickTimeMs: json.targetTickTimeMs }));
              await fetch(`${apiBase}/terminal/log`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'info', message: `terminal: ticktime set to ${json.targetTickTimeMs} ms` }) });
            }
          }
          return;
        } else {
          await fetch(`${apiBase}/terminal/log`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'warn', message: 'terminal: config commands: reset' }) });
        }
        return;
      }
      if (ns === 'help') {
        const lines = [
          'Help — Commands',
          'wallet: generate | refresh | send TOKEN|MINT AMOUNT ADDRESS | addtoken TOKEN|MINT',
          'watchlist: add QUERY|MINT | remove SYMBOL|MINT | list',
          'strategy:',
          '  essentials -> strategy set name=STR fromToken=SYMBOL|MINT toToken=SYMBOL|MINT buyPct=NUM sellPct=NUM amount=NUM active=true|false test=true|false',
          '  (See README for advanced parameters: slippage/scaling/hysteresis/cooldown/fees/LST/fixedAnchor/slidingAnchor/navSource/maxOpenPositions/maxPositionSize and more)',
          '  other      -> strategy list | strategy status name=STR active=true|false | strategy remove NAME',
          'bot: start | stop',
          'api: start | stop | reset',
          'ticktime: MS (set target tick time in ms)',
          'swap: AMOUNT FROM TO',
          'config: reset | ticktime MS',
          'help — show this help'
        ];
        await Promise.all(lines.map(line => fetch(`${apiBase}/terminal/log`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'info', message: `terminal: ${line}` }) })));
        return;
      }
    }
    if (cmd === 'start') {
      await fetch(`${apiBase}/bot/start`, { method: 'POST' });
    } else if (cmd === 'stop') {
      await fetch(`${apiBase}/bot/stop`, { method: 'POST' });
    } else if (cmd.startsWith('add ')) {
      const query = cmd.slice(4).trim();
      await fetch(`${apiBase}/watchlist`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query }) });
    } else if (cmd.startsWith('remove ')) {
      const idOrSymbol = cmd.split(' ')[1];
      await fetch(`${apiBase}/watchlist`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idOrSymbol }) });
    } else if (cmd === 'show strategy') {
      const cfg = await (await fetch(`${apiBase}/strategy`)).json();
      setStrategies(cfg.strategies || []);
      await fetch(`${apiBase}/terminal/log`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'info', message: 'terminal: show strategy' }) });
    } else if (cmd === 'help') {
      const lines = [
        'Help: Available commands',
        "start — start the trading bot",
        "stop — stop the trading bot",
        "add QUERY|MINT — add a token to watchlist (symbol/name or mint)",
        "remove SYMBOL|MINT — remove a token from watchlist",
        "show strategy — display current strategies",
        "set name=STR token=SYMBOL|MINT buyPct=NUM sellPct=NUM amount=NUM test=true|false — upsert strategy",
        "removestrategy NAME — remove a named strategy",
        "swap AMOUNT FROM TO — swap tokens immediately (e.g., swap 0.01 SOL dSOL)",
        "refreshwallet — refresh wallet balances",
        "walletaddtoken TOKEN|MINT — add token alias for wallet balances",
        "resetconfig — reset watchlist, strategies, and wallet token aliases",
        "apistart | apistop | apireset — control Jupiter API calls",
        "send TOKEN|MINT ADDRESS AMOUNT — send SOL/SPL from wallet",
        "help — show this help"
      ];
      await Promise.all(lines.map(line => fetch(`${apiBase}/terminal/log`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'info', message: `terminal: ${line}` }) })));
    } else if (cmd.startsWith('send ')) {
      // send TOKEN|MINT ADDRESS AMOUNT
      const parts = cmd.split(/\s+/);
      if (parts.length >= 4) {
        const token = parts[1];
        const address = parts[2];
        const amount = Number(parts[3]);
        await fetch(`${apiBase}/wallet/send`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token, destination: address, amount })
        });
      } else {
        await fetch(`${apiBase}/terminal/log`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'warn', message: 'terminal: send incomplete' }) });
      }
    } else if (cmd.startsWith('swap ')) {
      // swap AMOUNT FROM TO
      const parts = cmd.split(/\s+/);
      if (parts.length >= 4) {
        const amount = Number(parts[1]);
        const from = parts[2];
        const to = parts[3];
        try {
          const resp = await fetch(`${apiBase}/swap`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ amount, from, to })
          });
          const json = await resp.json();
          if (!resp.ok) throw new Error(json?.error || 'swap failed');
          await fetch(`${apiBase}/terminal/log`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'info', message: `terminal: swap success ${amount} ${from}->${to} sig=${json.signature}` }) });
        } catch (e: any) {
          await fetch(`${apiBase}/terminal/log`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'error', message: `terminal: swap failed ${String(e?.message || e)}` }) });
        }
      } else {
        await fetch(`${apiBase}/terminal/log`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'warn', message: 'terminal: swap incomplete (usage: swap AMOUNT FROM TO)' }) });
      }
    } else if (cmd === 'refreshwallet') {
      try {
        const resp = await fetch(`${apiBase}/wallet/refresh`, { method: 'POST' });
        if (!resp.ok) throw new Error('refresh failed');
      } catch (e: any) {
        await fetch(`${apiBase}/terminal/log`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'error', message: `terminal: refreshwallet failed ${String(e?.message || e)}` }) });
      }
    } else if (cmd.startsWith('walletaddtoken ')) {
      const query = cmd.slice('walletaddtoken '.length).trim();
      if (!query) {
        await fetch(`${apiBase}/terminal/log`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'warn', message: 'walletaddtoken requires a TOKEN or MINT' }) });
      } else {
        const resp = await fetch(`${apiBase}/wallet/tokens`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query }) });
        const json = await resp.json();
        if (!resp.ok) {
          await fetch(`${apiBase}/terminal/log`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'error', message: `terminal: walletaddtoken failed: ${json?.error || 'unknown'}` }) });
        } else {
          setWalletTokens(json.walletTokens || []);
          await fetch(`${apiBase}/terminal/log`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'info', message: `terminal: walletaddtoken added ${json.added?.symbol || json.added?.id}` }) });
        }
      }
    } else if (cmd === 'apistop') {
      await fetch(`${apiBase}/api/stop`, { method: 'POST' });
    } else if (cmd === 'apistart') {
      await fetch(`${apiBase}/api/start`, { method: 'POST' });
    } else if (cmd === 'apireset') {
      await fetch(`${apiBase}/api/reset`, { method: 'POST' });
    } else if (cmd.startsWith('set ')) {
      // set key=value pairs; allowed keys: token, buyPct, sellPct, amount, test
      const parts = cmd.slice(4).split(/[\s,]+/).filter(Boolean);
      const kv: Record<string, string> = {};
      for (const p of parts) {
        const [k, v] = p.split('=');
        if (k && v !== undefined) kv[k.toLowerCase()] = v;
      }
      const current: any = {};
      const next = {
        ...current,
        name: kv.name ?? 'default',
        token: kv.token ?? current.token ?? 'SOL',
        buyPct: kv.buypct ? Number(kv.buypct) : current.buyPct ?? 0.05,
        sellPct: kv.sellpct ? Number(kv.sellpct) : current.sellPct ?? 0.05,
        amount: kv.amount ? Number(kv.amount) : current.amount ?? 0.1,
        testMode: kv.test ? kv.test.toLowerCase() === 'true' : current.testMode ?? true,
      };
      await fetch(`${apiBase}/strategy`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(next) });
      const updated = await (await fetch(`${apiBase}/strategy`)).json();
      setStrategies(updated.strategies || []);
      await fetch(`${apiBase}/terminal/log`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'info', message: `terminal: set ${JSON.stringify(next)}` }) });
    } else if (cmd.startsWith('removestrategy')) {
      const parts = cmd.split(/\s+/);
      const name = parts[1];
      if (!name) {
        await fetch(`${apiBase}/terminal/log`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'warn', message: 'terminal: removestrategy requires a name' }) });
      } else {
        await fetch(`${apiBase}/strategy`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
        const updated = await (await fetch(`${apiBase}/strategy`)).json();
        setStrategies(updated.strategies || []);
        await fetch(`${apiBase}/terminal/log`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'info', message: `terminal: removed strategy ${name}` }) });
      }
    } else if (cmd === 'resetconfig') {
      try {
        const resp = await fetch(`${apiBase}/config/reset`, { method: 'POST' });
        if (!resp.ok) throw new Error('reset failed');
        const wl = await (await fetch(`${apiBase}/watchlist`)).json();
        setWatchlist(wl.watchlist || []);
        const st = await (await fetch(`${apiBase}/strategy`)).json();
        setStrategies(st.strategies || []);
        const wt = await (await fetch(`${apiBase}/wallet/tokens`)).json();
        setWalletTokens(wt.walletTokens || []);
        await fetch(`${apiBase}/terminal/log`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'info', message: 'terminal: resetconfig executed' }) });
      } catch (e: any) {
        await fetch(`${apiBase}/terminal/log`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'error', message: `resetconfig failed: ${String(e?.message || e)}` }) });
      }
    } else {
      await fetch(`${apiBase}/terminal/log`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'warn', message: `terminal: unknown or incomplete command: ${cmd}` }) });
    }
  }

  return (
    <div className="min-h-screen p-4 grid grid-cols-1 lg:grid-cols-3 gap-4">
      <div className="lg:col-span-2 space-y-4">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="flex flex-col h-full">
          <section className="bg-gray-900 rounded p-4">
          <div className="flex items-center mb-3">
            <img src="/lockstone_favicon.svg" alt="Logo" className="w-6 h-6 mr-2" />
            <h2 className="text-2xl font-semibold">System Info</h2>
          </div>
          <div className="text-base text-gray-300">Bot: {system.name || system.botName || 'TLEbot1'}</div>
          <div className="text-base text-gray-300">Version: {system.version}</div>
          <div className="flex items-center justify-between">
            <div className="text-base text-gray-300">
              {(() => {
                const botRunning = (system.bot || '').toLowerCase() === 'started';
                const botColor = botRunning ? 'text-green-400' : 'text-red-400';
                const botText = botRunning ? 'RUNNING' : 'STOPPED';
                const thresholdCount = strategies.filter(s => !isGridStrategy(s)).length;
                const gridCount = strategies.filter(s => isGridStrategy(s)).length;
                return (
                  <div>
                    Bot Status: <span className={`font-semibold ${botColor}`}>{botText}</span>
                    {botRunning && (
                      <div className="text-sm text-gray-400 mt-1">
                        Active Strategies: {thresholdCount} Threshold, {gridCount} Grid
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>
            <div className="flex space-x-2">
              {(() => {
                const botRunning = (system.bot || '').toLowerCase() === 'started';
                return (
                  <button
                    onClick={async () => {
                      if (botRunning) {
                        await fetch(`${apiBase}/bot/stop`, { method: 'POST' });
                      } else {
                        await fetch(`${apiBase}/bot/start`, { method: 'POST' });
                      }
                    }}
                    className={`px-4 py-2 rounded text-sm font-medium ${
                      botRunning 
                        ? 'bg-red-600 hover:bg-red-700 text-white' 
                        : 'bg-green-600 hover:bg-green-700 text-white'
                    }`}
                  >
                    {botRunning ? 'Stop Bot' : 'Start Bot'}
                  </button>
                );
              })()}
              {(() => {
                const enabled = !!arbConfig?.enabled;
                return (
                  <button
                    onClick={async () => {
                      try {
                        const r = await fetch(`${apiBase}/arb/config`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: !enabled }) });
                        if (r.ok) {
                          const j = await r.json();
                          setArbConfig(j?.config || { enabled: !enabled });
                          await fetch(`${apiBase}/terminal/log`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'info', message: `terminal: arb ${!enabled ? 'enabled' : 'disabled'}` }) });
                        }
                      } catch {}
                    }}
                    className={`px-4 py-2 rounded text-sm font-medium ${enabled ? 'bg-yellow-600 hover:bg-yellow-700 text-white' : 'bg-gray-600 hover:bg-gray-700 text-white'}`}
                    title="Toggle arbitrage detection/execution loop"
                  >
                    {enabled ? 'Pause Arbitrage' : 'Resume Arbitrage'}
                  </button>
                );
              })()}
              <button
                onClick={async () => {
                  if (!confirm('Shutdown all services? This will stop the backend and related processes.')) return;
                  try {
                    await fetch(`${apiBase}/system/shutdown`, { method: 'POST' });
                  } catch {}
                }}
                className="px-4 py-2 rounded text-sm font-medium bg-gray-700 hover:bg-gray-800 text-white"
                title="Shutdown all services"
              >
                Shutdown
              </button>
              <button
                onClick={() => setShowGraph((v) => !v)}
                className="px-4 py-2 rounded text-sm font-medium bg-blue-600 hover:bg-blue-700 text-white"
                title="Toggle Graph Visualizer"
              >
                {showGraph ? 'Hide Graph' : 'Show Graph'}
              </button>
            </div>
          </div>
          {(() => {
            const rlActive = isConnected && !!system.rateLimitActive;
            const cooldown = !!system.cooldownUntilMs;
            const apiColor = rlActive ? (cooldown ? 'text-yellow-400' : 'text-red-400') : 'text-green-400';
            const apiText = isConnected ? (rlActive ? (cooldown ? 'THROTTLED' : 'PAUSED') : 'ON') : 'STOPPED';
            return <div className="text-base text-gray-300">API Status: <span className={`font-semibold ${apiColor}`}>{apiText}</span></div>;
          })()}
          {(() => {
            const now = Date.now();
            const stale = !isConnected || (now - (lastSystemRef.current || 0) > 5000);
            const got429 = !!system.last429AtMs && (now - system.last429AtMs < 60000);
            const showThrottled = got429 && !!system.rateLimitActive;
            const statusText = stale ? 'offline' : (showThrottled ? 'throttled' : 'running');
            const color = stale ? 'text-red-400' : (showThrottled ? 'text-yellow-400' : 'text-green-400');
            return <div className={`text-base ${color}`}>Backend: {statusText}</div>;
          })()}
          <div className="text-base text-gray-300">Uptime: {typeof system.uptimeMs === 'number' ? Math.floor(system.uptimeMs/1000) + 's' : '-'}</div>
          <div className="text-base text-gray-300">Last Price Update: {system.lastPriceUpdateMs ? `${new Date(system.lastPriceUpdateMs).toLocaleTimeString()} (${(() => { const d = Date.now() - system.lastPriceUpdateMs; return Math.floor(d/1000) + 's ago'; })()})` : '-'}</div>
          <div className="flex items-center justify-between">
            <div className="text-base text-gray-300">RPC: {system.rpcUrl || '-'}</div>
            <button
              onClick={() => setShowSystemConfig(true)}
              className="text-sm bg-blue-600 px-3 py-1 rounded hover:bg-blue-700"
            >
              Configure
            </button>
          </div>
          {(() => {
            const now = Date.now();
            const got429 = !!system.last429AtMs && (now - system.last429AtMs < 60000);
            if (!got429) return null;
            return <div className="text-sm text-yellow-400">Rate limit active. Cooldown until {system.cooldownUntilMs ? new Date(system.cooldownUntilMs).toLocaleTimeString() : '...'}.</div>;
          })()}
          
          
          
          {/* Fee Configuration */}
          <div className="mt-4 pt-4 border-t border-gray-700">
            <div className="flex justify-between items-center mb-2">
              <h3 className="text-lg font-semibold text-white">Fee Configuration</h3>
              <button
                onClick={() => setShowFeeConfig(true)}
                className="px-3 py-1 bg-blue-600 text-white rounded text-sm hover:bg-blue-700"
              >
                Configure Fees
              </button>
            </div>
            <div className="grid grid-cols-2 gap-2 text-sm">
              <div>
                <div className="text-gray-400">Base Fee</div>
                <div className="text-white">{system.fees?.baseFee || '5000'} lamports</div>
              </div>
              <div>
                <div className="text-gray-400">Priority Fee</div>
                <div className="text-white">{system.fees?.priorityFee || '1000'} lamports</div>
              </div>
              <div>
                <div className="text-gray-400">Max Fee</div>
                <div className="text-white">{system.fees?.maxFee || '100000'} lamports</div>
              </div>
              <div>
                <div className="text-gray-400">Dynamic Fees</div>
                <div className="text-white">{system.fees?.dynamicFees ? 'Enabled' : 'Disabled'}</div>
              </div>
            </div>
          </div>
          </section>
          <section className="bg-gray-900 rounded p-4 mt-4 flex-1 overflow-auto">
            <div className="flex justify-between items-center mb-3">
              <h2 className="text-2xl font-semibold">Watchlist</h2>
              <button
                onClick={() => setShowAddToken(true)}
                className="px-3 py-1 bg-green-600 text-white rounded text-sm hover:bg-green-700"
              >
                + Token
              </button>
            </div>
            <ul className="space-y-1">
              {watchlist.map((t, index) => {
                const isString = typeof t === 'string';
                const id = isString ? t : t?.id;
                const label = isString ? t : (t?.symbol || (t?.id ? t.id.slice(0,4) : ''));
                const priceUsd = id ? prices?.[id]?.usdc : null;
                // LST NAV/premium if strategy indicates lst and matches token symbol
                const symUpper = (isString ? label : t?.symbol || '').toUpperCase?.() || '';
                const lstStrat = strategies.find((s) => {
                  if (!s?.lst) return false;
                  const cand = [s.toToken, s.token, s.fromToken].filter(Boolean).map((x: any) => String(x).toUpperCase());
                  return cand.includes(symUpper);
                });
                const a = lstStrat ? (activitiesByStrategy[lstStrat.name || 'default'] as any) : undefined;
                const navPair = typeof a?.nav === 'number' ? a.nav as number : null;
                const premPct = typeof a?.premium === 'number' ? a.premium as number : null;
                return (
                  <li key={id || label} className="text-sm text-gray-300 flex items-center justify-between px-3 py-1.5 bg-gray-800 rounded">
                    <span className="font-medium">{label}</span>
                    <div className="flex items-center space-x-2">
                      <span>
                        {priceUsd ? `$${priceUsd.toFixed(4)}` : '-'}
                        {navPair ? <span className="ml-2 text-gray-400">NAV {navPair.toFixed(6)}{typeof premPct === 'number' ? ` (${(premPct*100).toFixed(2)}%)` : ''}</span> : null}
                      </span>
                      <button
                        onClick={() => handleRemoveToken(t)}
                        className="text-red-400 hover:text-red-300 text-xs px-2 py-1 rounded hover:bg-red-900"
                        title="Remove token"
                      >
                        ×
                      </button>
                    </div>
                  </li>
                );
              })}
              {watchlist.length === 0 && <li className="text-gray-400 text-sm px-3">No tokens yet (use terminal)</li>}
            </ul>
          </section>
          </div>
          <section className="bg-gray-900 rounded p-4">
            <h2 className="text-2xl font-semibold mb-3">Wallet</h2>
            <div className="text-base break-all">{wallet?.address}</div>
            <div className="mt-2 text-base">SOL: {wallet?.balances?.sol ?? '-'}</div>
            {(() => {
              const sol = Number(wallet?.balances?.sol || 0);
              const solUsd = prices?.['So11111111111111111111111111111111111111112']?.usdc || null;
              let tokensUsd = 0;
              for (const [mint, amount] of Object.entries(wallet?.balances?.tokens || {})) {
                const p = prices?.[mint]?.usdc || 0;
                tokensUsd += Number(amount) * p;
              }
              const totalUsd = (solUsd ? sol * solUsd : 0) + tokensUsd;
              const totalSol = sol + (solUsd ? (tokensUsd / solUsd) : 0);
              return (
                <div className="mt-2 text-base text-gray-300">
                  <div className="text-gray-400">Portfolio Value</div>
                  <div>USDC: {totalUsd ? `$${totalUsd.toFixed(2)}` : '-'}</div>
                  <div>SOL: {totalSol ? totalSol.toFixed(4) : '-'}</div>
                </div>
              );
            })()}
            <div className="mt-2">
              <div className="text-base text-gray-400 mb-1">SPL Balances</div>
              <ul className="text-sm text-gray-300 space-y-1">
                {Object.entries(wallet?.balances?.tokens || {}).map(([mint, amount]) => {
                  const alias = walletTokens.find((t) => t.id === mint);
                  const label = wallet?.aliases?.[mint] || alias?.symbol || mint.slice(0, 4);
                  return <li key={mint}>{label}: {Number(amount).toFixed(6)}</li>;
                })}
                {Object.keys(wallet?.balances?.tokens || {}).length === 0 && <li className="text-gray-500">No SPL tokens detected</li>}
              </ul>
            </div>
            {(() => {
              // Aggregate realized and unrealized PnL from activity payloads
              let realizedFrom = 0;
              let unrealizedFrom = 0;
              let fromSymbol = 'USDC';
              for (const [, a] of Object.entries(activitiesByStrategy)) {
                realizedFrom += Number((a as any)?.realizedPnlFrom || 0);
                unrealizedFrom += Number((a as any)?.unrealizedPnlFrom || 0);
                const pair = (a as any)?.pair;
                if (pair && typeof pair === 'string' && pair.includes('/')) fromSymbol = pair.split('/')[0];
              }
              const format5 = (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: 5, maximumFractionDigits: 5 });
              return (
                <div className="mt-3 text-base text-gray-300">
                  <div className="text-gray-400 mb-1">PnL (since start)</div>
                  <div>Realized: {realizedFrom >= 0 ? '+' : ''}{format5(Math.abs(realizedFrom))} {fromSymbol}</div>
                  <div>Unrealized: {unrealizedFrom >= 0 ? '+' : ''}{format5(Math.abs(unrealizedFrom))} {fromSymbol}</div>
                </div>
              );
            })()}
            <div className="mt-3">
              <div className="text-base text-gray-400 mb-1">Wallet History</div>
              <ul className="text-sm text-gray-300 space-y-1 max-h-40 overflow-auto">
                {walletHistory.map((h, i) => (
                  <li key={i} className="flex items-center justify-between">
                    <span>
                      [{new Date(h.time).toLocaleTimeString()}] {h.type === 'swap' ? `swap: ${h.fromToken} ${h.fromAmount} -> ${h.toToken}${(h as any).toAmount ? ` ${((h as any).toAmount as number).toFixed(6)}` : ''}` : h.type === 'send' ? `send: ${h.token} ${h.amount} to ${h.destination}` : `receive: ${h.token} ${h.amount}`}
                    </span>
                    {(h as any).signature && (
                      <a
                        href={`https://solscan.io/tx/${(h as any).signature}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-400 hover:text-blue-300 text-xs ml-2"
                        title="View on Solscan"
                      >
                        🔗
                      </a>
                    )}
                  </li>
                ))}
                {walletHistory.length === 0 && <li className="text-gray-500">No history yet</li>}
              </ul>
            </div>
          </section>
        </div>
        <CollapsibleSection
          title={"Arbitrage"}
          storageKey="panel:arbitrage"
          rightActions={(
            <>
              <button onClick={()=>setShowDataFetchConfig(true)} className="px-3 py-1 bg-blue-600 text-white rounded text-sm hover:bg-blue-700">Fetchers & Normalizers</button>
              <button onClick={()=>setShowEngineConfig(true)} className="px-3 py-1 bg-indigo-600 text-white rounded text-sm hover:bg-indigo-700">Arb Engine</button>
            </>
          )}
        >
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <ArbitragePanel apiBase={apiBase} socket={socketRef.current} />
            <ArbitrageMetrics apiBase={apiBase} paused={showArbConfig || showSystemConfig || showFeeConfig} />
          </div>
          {showGraph ? (
            <div className="mt-4">
              <GraphView apiBase={apiBase} socket={socketRef.current} square />
            </div>
          ) : null}
        </CollapsibleSection>
        <section className="bg-gray-900 rounded p-4">
          <h2 className="text-2xl font-semibold mb-3">Terminal</h2>
          <div className="text-sm text-gray-400 mb-3">Type 'help' to list available commands.</div>
          <form onSubmit={(e) => { e.preventDefault(); handleTerminal(terminalInput.trim()); setTerminalInput(''); }}>
            <input value={terminalInput} onChange={(e) => setTerminalInput(e.target.value)} className="w-full bg-gray-800 rounded px-3 py-2 outline-none text-base" placeholder="Type command..." />
          </form>
        </section>
        {/* Drift Panel: subaccounts and management */}
        <CollapsibleSection title={"Drift"} storageKey="panel:drift">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="p-3 bg-gray-800 rounded">
              <div className="text-white font-semibold mb-2">Status</div>
              <div className="text-sm text-gray-300 space-y-1">
                <div>Cluster: <span className="text-white">{driftStatus?.cluster || '-'}</span></div>
                <div>Program: <span className="text-white">{driftStatus?.programId || '-'}</span></div>
                <div>Markets: <span className="text-white">{Array.isArray(driftStatus?.markets) ? driftStatus.markets.length : 0}</span></div>
              </div>
            </div>
            <div className="p-3 bg-gray-800 rounded">
              <div className="text-white font-semibold mb-2">Subaccounts</div>
              {driftSubaccounts.length === 0 ? (
                <div className="text-gray-400 text-sm">No subaccounts detected.</div>
              ) : (
                <div className="space-y-2 text-sm">
                  <div className="flex items-center space-x-2">
                    <select className="flex-1 px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white" value={driftSelectedSubId} onChange={e => setDriftSelectedSubId(Number(e.target.value))}>
                      {driftSubaccounts.map((s: any) => (<option key={s.id} value={s.id}>Sub {s.id}</option>))}
                    </select>
                    <button disabled={driftOpBusy} onClick={async () => { try { setDriftOpBusy(true); await fetch(`${apiBase}/drift/subaccount/create`, { method: 'POST', headers: { 'Content-Type': 'application/json' } }); const subsResp = await fetch(`${apiBase}/drift/subaccounts`).then(r => r.json()); const subs = subsResp?.subaccounts || []; setDriftSubaccounts(subs); if (subs[0]) setDriftSelectedSubId(Number(subs[0].id)); } catch {} finally { setDriftOpBusy(false); } }} className="px-3 py-2 bg-gray-700 text-white rounded hover:bg-gray-600 disabled:opacity-60">{driftOpBusy ? 'Working...' : 'Create'}</button>
                  </div>
                  {driftSubaccounts.map((s: any) => (
                    <div key={s.id} className={`p-2 rounded ${Number(s.id) === Number(driftSelectedSubId) ? 'bg-gray-900' : 'bg-gray-750'}`}>
                      <div className="text-gray-200">Sub {s.id}</div>
                      <div className="grid grid-cols-2 gap-2 text-sm text-gray-300 mt-1">
                        <div>Free Collateral: <span className="text-white">{Number(s.freeCollateral || 0).toFixed(2)}</span></div>
                        <div>Total Collateral: <span className="text-white">{Number(s.totalCollateral || 0).toFixed(2)}</span></div>
                        <div>Initial Req: <span className="text-white">{Number(s.initialRequirement || 0).toFixed(2)}</span></div>
                        <div>Maintenance: <span className="text-white">{Number(s.maintenanceRequirement || 0).toFixed(2)}</span></div>
                        <div>Eff. Leverage: <span className="text-white">{Number(s.effectiveLeverage || 0).toFixed(2)}</span></div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
          <div className="mt-3 p-3 bg-gray-800 rounded">
            <div className="text-white font-semibold mb-2">Manage Funds</div>
            <div className="grid grid-cols-3 gap-2">
              <input type="number" min={0} step={0.000001} className="px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white" value={driftAmount} onChange={e => setDriftAmount(Number(e.target.value))} placeholder="Amount (e.g. USDC)" />
              <input type="number" min={0} step={1} className="px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white" value={driftSpotIndex} onChange={e => setDriftSpotIndex(Number(e.target.value))} placeholder="Spot Market Index (0=USDC)" />
              <div className="flex space-x-2">
                <button disabled={driftOpBusy} onClick={async () => { try { setDriftOpBusy(true); await fetch(`${apiBase}/drift/subaccount/deposit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subaccountId: Number(driftSelectedSubId), amount: Number(driftAmount), spotMarketIndex: Number(driftSpotIndex) }) }); const subsResp = await fetch(`${apiBase}/drift/subaccounts`).then(r => r.json()); setDriftSubaccounts(subsResp?.subaccounts || []); } catch {} finally { setDriftOpBusy(false); } }} className="flex-1 px-3 py-2 bg-green-700 text-white rounded hover:bg-green-800 disabled:opacity-60">Deposit</button>
                <button disabled={driftOpBusy} onClick={async () => { try { setDriftOpBusy(true); await fetch(`${apiBase}/drift/subaccount/withdraw`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subaccountId: Number(driftSelectedSubId), amount: Number(driftAmount), spotMarketIndex: Number(driftSpotIndex) }) }); const subsResp = await fetch(`${apiBase}/drift/subaccounts`).then(r => r.json()); setDriftSubaccounts(subsResp?.subaccounts || []); } catch {} finally { setDriftOpBusy(false); } }} className="flex-1 px-3 py-2 bg-red-700 text-white rounded hover:bg-red-800 disabled:opacity-60">Withdraw</button>
              </div>
            </div>
          </div>
        </CollapsibleSection>
        <CollapsibleSection title={"Positions"} storageKey="panel:positions">
          {/* Grid summary per strategy */}
          {gridPositionsSummary.length > 0 && (
            <div className="mb-3">
              <div className="text-lg font-semibold text-white mb-2">Grid Summary</div>
              <table className="w-full text-sm mb-4">
                <thead>
                  <tr className="text-gray-400">
                    <th className="text-left">Strategy</th>
                    <th className="text-left">Pair</th>
                    <th className="text-left">Active</th>
                    <th className="text-left">Total From</th>
                    <th className="text-left">Avg Open</th>
                    <th className="text-left">Cycles</th>
                    <th className="text-left">PnL (from)</th>
                    <th className="text-left">Unrealized (from)</th>
                  </tr>
                </thead>
                <tbody>
                  {gridPositionsSummary
                    .filter((s) => strategies.some((st: any) => (st?.name || 'default') === s.strategy))
                    .map((s, i) => {
                    const act = (activitiesByStrategy as any)?.[s.strategy] || {};
                    const cycles = typeof act.completedCycles === 'number' ? act.completedCycles : 0;
                    const pnlFrom = typeof act.realizedPnlFrom === 'number' ? act.realizedPnlFrom : 0;
                    const unrealFrom = typeof act.unrealizedPnlFrom === 'number' ? act.unrealizedPnlFrom : 0;
                    return (
                      <tr key={i} className="text-gray-300">
                        <td>{s.strategy}</td>
                        <td>{s.fromSymbol}{'→'}{s.toSymbol}</td>
                        <td>{s.count}</td>
                        <td>{s.totalFromToken.toLocaleString(undefined, { maximumFractionDigits: 9 })} {s.fromSymbol}</td>
                        <td>{(() => { const sec = Math.floor((s.avgOpenMs || 0)/1000); const h = Math.floor(sec/3600); const m = Math.floor((sec%3600)/60); const s2 = sec%60; return `${h}h ${m}m ${s2}s`; })()}</td>
                        <td>{cycles}</td>
                        <td className={pnlFrom >= 0 ? 'text-green-400' : 'text-red-400'}>{pnlFrom.toLocaleString(undefined, { maximumFractionDigits: 6 })} {s.fromSymbol}</td>
                        <td className={unrealFrom >= 0 ? 'text-green-400' : 'text-red-400'}>{unrealFrom.toLocaleString(undefined, { maximumFractionDigits: 6 })} {s.fromSymbol}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {positions.length === 0 ? (
            <div className="text-gray-400 text-base">No active positions</div>
          ) : (
            <table className="w-full text-base">
              <thead>
                <tr className="text-gray-400">
                  <th className="text-left">Pair</th>
                  <th className="text-left">Side</th>
                  <th className="text-left">Strategy</th>
                  <th className="text-left">Size</th>
                  <th className="text-left">Opened</th>
                  <th className="text-left">Open For</th>
                  <th className="text-left">Entry</th>
                  <th className="text-left">Target</th>
                  <th className="text-left">Current</th>
                  <th className="text-left">Unrealized PnL (from)</th>
                </tr>
              </thead>
              <tbody>
                {positions.map((p, i) => {
                  const from = p.fromSymbol || 'USDC';
                  const to = p.toSymbol || p.symbol || 'SOL';
                  const wlFrom = watchlist.find(w => (typeof w === 'string' ? false : (w.symbol?.toUpperCase?.() === from?.toUpperCase?.())));
                  const wlTo = watchlist.find(w => (typeof w === 'string' ? false : (w.symbol?.toUpperCase?.() === to?.toUpperCase?.())));
                  const mintFrom = (from && from.length > 30) ? from : (wlFrom?.id || '');
                  const mintTo = (to && to.length > 30) ? to : (wlTo?.id || '');
                  const upperFrom = (from || '').toUpperCase();
                  const upperTo = (to || '').toUpperCase();
                  const solUsdFromMap = (() => {
                    for (const v of Object.values(prices || {})) {
                      const usdc = (v as any)?.usdc; const sol = (v as any)?.sol;
                      if (typeof usdc === 'number' && typeof sol === 'number' && sol > 0) {
                        const s = usdc / sol; if (isFinite(s) && s > 0) return s;
                      }
                    }
                    return null as number | null;
                  })();
                  const usdFrom = upperFrom === 'USDC' ? 1 : (upperFrom === 'SOL' ? solUsdFromMap : (mintFrom ? (prices as any)?.[mintFrom]?.usdc : null));
                  const usdTo = upperTo === 'USDC' ? 1 : (upperTo === 'SOL' ? solUsdFromMap : (mintTo ? (prices as any)?.[mintTo]?.usdc : null));
                  const currentFromActivities = activitiesByStrategy[p.strategy || 'default']?.currentPairPrice;
                  const currentPair = (usdFrom && usdTo) ? (usdFrom / usdTo) : (typeof currentFromActivities === 'number' ? currentFromActivities : null);
                  const entryPair = (p.entryPrice ?? p.entry) || null;
                  const targetPair = p.target || null;
                  const amountFrom = Number(p.amountFrom || 0);
                  // Unrealized PnL in from-token units
                  const side = String(p.side || '').toLowerCase();
                  const qtyTo = (() => {
                    if (side === 'long' || side === 'buy') return Number((p as any)?.filledAmount || (p as any)?.amount || (p as any)?.quoteAmount || 0);
                    if (side === 'short' || side === 'sell') return Number((p as any)?.filledAmount || (p as any)?.amount || (p as any)?.quoteAmountSold || 0);
                    return Number((p as any)?.filledAmount || (p as any)?.amount || 0);
                  })();
                  let unrealFrom: number | null = null;
                  if (typeof entryPair === 'number' && typeof currentPair === 'number' && qtyTo) {
                    const diff = (side === 'long' || side === 'buy') ? (currentPair - entryPair) : (entryPair - currentPair);
                    unrealFrom = diff * qtyTo;
                  }
                  const unrealUsd = (typeof unrealFrom === 'number' && typeof usdFrom === 'number') ? (unrealFrom * usdFrom) : null;
                  const openedAtMs: number | undefined = (p as any)?.openedAtMs;
                  const openedStr = openedAtMs ? new Date(openedAtMs).toLocaleTimeString() : '-';
                  const openFor = openedAtMs ? (() => { const sec = Math.max(0, Math.floor((Date.now() - openedAtMs)/1000)); const m = Math.floor(sec/60); const s = sec%60; return `${m}m ${s}s`; })() : '-';
                  return (
                    <tr key={i} className="text-gray-300">
                      <td>{`${from}->${to}`}</td>
                      <td className="uppercase">{p.side}</td>
                      <td>{p.strategy || '-'}</td>
                      <td>{amountFrom ? `${amountFrom} ${from}` : '-'}</td>
                      <td>{openedStr}</td>
                      <td>{openFor}</td>
                      <td>{entryPair ? `${entryPair.toFixed(6)} ${from}->${to}` : '-'}</td>
                      <td>{targetPair ? `${targetPair.toFixed(6)} ${from}->${to}` : '-'}</td>
                      <td>{currentPair ? `${currentPair.toFixed(6)} ${from}->${to}` : '-'}</td>
                      <td className={typeof unrealFrom === 'number' ? (unrealFrom >= 0 ? 'text-green-400' : 'text-red-400') : ''}>
                        {typeof unrealFrom === 'number'
                          ? `${unrealFrom.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${from}${typeof unrealUsd === 'number' ? ` ($${Math.abs(unrealUsd) < 1 ? unrealUsd.toFixed(4) : unrealUsd.toFixed(2)})` : ''}`
                          : '-'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={10} className="text-gray-300 pt-2 border-t border-gray-700">
                    {(() => {
                      const now = Date.now();
                      let count = positions.length;
                      let totalFromPrincipalUsd = 0;
                      let totalOpenMs = 0;
                      let totalUnrealFrom = 0;
                      let totalUnrealUsd = 0;
                      for (const p of positions) {
                        const from = (p as any).fromSymbol || 'USDC';
                        const to = (p as any).toSymbol || (p as any).symbol || 'SOL';
                        const wlFrom = watchlist.find(w => (typeof w === 'string' ? false : (w.symbol?.toUpperCase?.() === from?.toUpperCase?.())));
                        const wlTo = watchlist.find(w => (typeof w === 'string' ? false : (w.symbol?.toUpperCase?.() === to?.toUpperCase?.())));
                        const mintFrom = (from && from.length > 30) ? from : (wlFrom?.id || '');
                        const mintTo = (to && to.length > 30) ? to : (wlTo?.id || '');
                        const upperFrom = (from || '').toUpperCase();
                        const upperTo = (to || '').toUpperCase();
                        const solUsdFromMap = (() => {
                          for (const v of Object.values(prices || {})) {
                            const usdc = (v as any)?.usdc; const sol = (v as any)?.sol;
                            if (typeof usdc === 'number' && typeof sol === 'number' && sol > 0) {
                              const s = usdc / sol; if (isFinite(s) && s > 0) return s;
                            }
                          }
                          return null as number | null;
                        })();
                        const usdFrom = upperFrom === 'USDC' ? 1 : (upperFrom === 'SOL' ? solUsdFromMap : (mintFrom ? (prices as any)?.[mintFrom]?.usdc : null));
                        const usdTo = upperTo === 'USDC' ? 1 : (upperTo === 'SOL' ? solUsdFromMap : (mintTo ? (prices as any)?.[mintTo]?.usdc : null));
                        const currentPair = (usdFrom && usdTo) ? (usdFrom / usdTo) : null;
                        const entryPair = ((p as any).entryPrice ?? (p as any).entry) || null;
                        const side = String((p as any).side || '').toLowerCase();
                        const qtyTo = (() => {
                          if (side === 'long' || side === 'buy') return Number((p as any)?.filledAmount || (p as any)?.amount || (p as any)?.quoteAmount || 0);
                          if (side === 'short' || side === 'sell') return Number((p as any)?.filledAmount || (p as any)?.amount || (p as any)?.quoteAmountSold || 0);
                          return Number((p as any)?.filledAmount || (p as any)?.amount || 0);
                        })();
                        if (typeof entryPair === 'number' && qtyTo && typeof usdFrom === 'number') {
                          totalFromPrincipalUsd += (entryPair * qtyTo) * usdFrom;
                        }
                        if (typeof entryPair === 'number' && typeof currentPair === 'number' && qtyTo) {
                          const diff = (side === 'long' || side === 'buy') ? (currentPair - entryPair) : (entryPair - currentPair);
                          const uFrom = diff * qtyTo;
                          totalUnrealFrom += uFrom;
                          if (typeof usdFrom === 'number') totalUnrealUsd += uFrom * usdFrom;
                        }
                        const openedAtMs: number | undefined = (p as any)?.openedAtMs;
                        if (openedAtMs) totalOpenMs += Math.max(0, now - openedAtMs);
                      }
                      const avgOpenMs = count ? (totalOpenMs / count) : 0;
                      const sec = Math.floor(avgOpenMs / 1000); const h = Math.floor(sec/3600); const m = Math.floor((sec%3600)/60); const s = sec%60;
                      const totalCycles = Object.values(activitiesByStrategy || {}).reduce((acc, a: any) => acc + (Number(a?.completedCycles) || 0), 0);
                      const realizedFrom = Object.values(activitiesByStrategy || {}).reduce((acc, a: any) => acc + (Number(a?.realizedPnlFrom) || 0), 0);
                      return `Active: ${count} | From Value: $${totalFromPrincipalUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })} | Avg Open: ${h}h ${m}m ${s}s | Cycles: ${totalCycles} | Unrealized: ${totalUnrealFrom >= 0 ? '+' : ''}${totalUnrealFrom.toLocaleString(undefined, { maximumFractionDigits: 6 })} from ($${totalUnrealUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}) | Realized: ${realizedFrom >= 0 ? '+' : ''}${realizedFrom.toLocaleString(undefined, { maximumFractionDigits: 6 })} from`;
                    })()}
                  </td>
                </tr>
              </tfoot>
            </table>
          )}
          
          {/* Position Summary by Strategy */}
          {positions.length > 0 && (
            <div className="mt-4 p-4 bg-gray-800 rounded">
              <h3 className="text-lg font-semibold text-white mb-3">Position Summary by Strategy</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {strategies.map((strategy) => {
                  const strategyPositions = positions.filter(p => p.strategy === strategy.name);
                  const activePositions = strategyPositions.filter(p => !p.closedAt);
                  const closedPositions = strategyPositions.filter(p => p.closedAt);
                  // Realized/unrealized in from-token units
                  let realizedFrom = 0;
                  let unrealizedFrom = 0;
                  const current = (activitiesByStrategy[strategy.name] as any)?.currentPairPrice;
                  for (const p of strategyPositions) {
                    if (p.closedAt) {
                      // For closed positions, incorporate realized delta if a cycle pair exists will be reflected via activity stream; skip here to avoid double counting
                    } else if (p.entryPrice && current) {
                      const qtyTo = (p.filledAmount || p.amount || 0);
                      if (p.side === 'buy') unrealizedFrom += (current - p.entryPrice) * qtyTo;
                      else unrealizedFrom += (p.entryPrice - current) * qtyTo;
                    }
                  }
                  const realizedFromAgg = Number((activitiesByStrategy[strategy.name] as any)?.realizedPnlFrom || 0);
                  
                  if (strategyPositions.length === 0) return null;
                  
                  return (
                    <div key={strategy.name} className="bg-gray-700 rounded p-3">
                      <div className="text-sm font-medium text-white mb-2">{strategy.name}</div>
                      <div className="grid grid-cols-2 gap-2 text-xs">
                        <div>
                          <div className="text-gray-400">Total</div>
                          <div className="text-white">{strategyPositions.length}</div>
                        </div>
                        <div>
                          <div className="text-gray-400">Active</div>
                          <div className="text-white">{activePositions.length}</div>
                        </div>
                        <div>
                          <div className="text-gray-400">Closed</div>
                          <div className="text-white">{closedPositions.length}</div>
                        </div>
                        <div>
                          <div className="text-gray-400">PnL</div>
                          <div className={`font-mono ${totalPnL >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                            {totalPnL.toFixed(4)}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          {/* Removed Planned section as requested */}
        </CollapsibleSection>
        <CollapsibleSection title={"Activity"} storageKey="panel:activity">
          <div className="space-y-4">
            {strategies.length === 0 && (
              <div className="text-gray-400 text-base">No strategies configured</div>
            )}
            {strategies.map((s, i) => {
              const name = s.name || 'default';
              const a = activitiesByStrategy[name] || { status: 'idle', trades: [] };
              const isGrid = isGridStrategy(s);
              const waitingInfo = a && a.status === 'waiting' ? (
                <div className="text-sm text-gray-400">
                  {(() => {
                    const from = s.fromToken || 'USDC';
                    const to = s.toToken || s.token || 'SOL';
                    const wlFrom = watchlist.find(w => (typeof w === 'string' ? false : (w.symbol?.toUpperCase?.() === from?.toUpperCase?.())));
                    const wlTo = watchlist.find(w => (typeof w === 'string' ? false : (w.symbol?.toUpperCase?.() === to?.toUpperCase?.())));
                    const mintFrom = (from && from.length > 30) ? from : (wlFrom?.id || '');
                    const mintTo = (to && to.length > 30) ? to : (wlTo?.id || '');
                    const upperFrom = (from || '').toUpperCase();
                    const upperTo = (to || '').toUpperCase();
                    const solUsdFromMap = (() => {
                      for (const v of Object.values(prices || {})) {
                        const usdc = (v as any)?.usdc; const sol = (v as any)?.sol;
                        if (typeof usdc === 'number' && typeof sol === 'number' && sol > 0) {
                          const s = usdc / sol; if (isFinite(s) && s > 0) return s;
                        }
                      }
                      return null as number | null;
                    })();
                    const usdFrom = upperFrom === 'USDC' ? 1 : (upperFrom === 'SOL' ? solUsdFromMap : (mintFrom ? (prices as any)?.[mintFrom]?.usdc : null));
                    const usdTo = upperTo === 'USDC' ? 1 : (upperTo === 'SOL' ? solUsdFromMap : (mintTo ? (prices as any)?.[mintTo]?.usdc : null));
                    const computed = (usdFrom && usdTo) ? (usdTo / usdFrom) : null;
                    const live = (a as any)?.currentPairPrice ?? (a as any)?.current ?? computed;
                    const norm = (v?: number | null) => (typeof v === 'number' && typeof live === 'number')
                      ? (Math.abs(v - (1 / live)) < Math.abs(v - live) ? (1 / v) : v)
                      : v;
                    const buyN = norm((a as any)?.buyTrigger);
                    const sellN = norm((a as any)?.sellTrigger);
                    const anchorN = norm((a as any)?.anchor);
                    const phase = (a as any)?.phaseLabel ? ` — ${String((a as any).phaseLabel)}` : '';
                    const intent = (a as any)?.nextAction && (a as any).nextAction !== 'wait' ? ` — next ${(a as any).nextAction}` : '';
                    return `Waiting on ${a.pair || `${from}/${to}`} at buy ${typeof buyN === 'number' ? buyN.toFixed(6) : '-'} / sell ${typeof sellN === 'number' ? sellN.toFixed(6) : '-'} (anchor ${typeof anchorN === 'number' ? anchorN.toFixed(6) : '-'})${typeof live === 'number' ? ` — current ${live.toFixed(6)}` : ''}${phase}${intent}`;
                  })()}
                </div>
              ) : null;
              return (
                <div key={i} className="border border-gray-800 rounded p-3 text-base">
                  <div className="font-semibold mb-1 flex items-center">
                    {name} — <span className="uppercase text-gray-300">{a.status}</span>
                    {isGrid && <span className="ml-2 px-2 py-1 bg-blue-600 text-white text-xs rounded">GRID</span>}
                  </div>
                  {waitingInfo}
                  
                  {/* Grid Levels Display for Grid Strategies */}
                  {isGrid && (a as any).gridLevels && Array.isArray((a as any).gridLevels) && (a as any).gridLevels.length > 0 && (
                    <div className="mt-3 p-3 bg-gray-800 rounded">
                      <h4 className="text-sm font-medium text-blue-300 mb-2">Grid Levels</h4>
                      <div className="grid grid-cols-2 gap-2 text-xs">
                        <div>
                          <div className="text-green-400 font-medium mb-1">Sell Levels</div>
                          {(a as any).gridLevels
                            .filter((level: any) => level.side === 'sell')
                            .sort((a: any, b: any) => a.price - b.price)
                            .map((level: any, idx: number) => (
                              <div key={idx} className={`flex justify-between ${level.filled ? 'text-green-300' : 'text-gray-400'}`}>
                                <span>{level.price?.toFixed(6) || 'N/A'}</span>
                                <span>{level.filled ? '✓' : '○'}</span>
                              </div>
                            ))}
                        </div>
                        <div>
                          <div className="text-red-400 font-medium mb-1">Buy Levels</div>
                          {(a as any).gridLevels
                            .filter((level: any) => level.side === 'buy')
                            .sort((a: any, b: any) => b.price - a.price)
                            .map((level: any, idx: number) => (
                              <div key={idx} className={`flex justify-between ${level.filled ? 'text-red-300' : 'text-gray-400'}`}>
                                <span>{level.price?.toFixed(6) || 'N/A'}</span>
                                <span>{level.filled ? '✓' : '○'}</span>
                              </div>
                            ))}
                        </div>
                      </div>
                    </div>
                  )}
                  
                  <ul className="space-y-1 text-sm text-gray-300 mt-2 max-h-28 overflow-auto">
                    {[...a.trades].slice().reverse().map((t: any, j: number) => (
                      <li key={j}>[{new Date(t.time).toLocaleTimeString()}] {t.action} {t.token} {t.amount} @ {typeof t.priceUsd === 'number' ? `$${t.priceUsd.toFixed(2)}` : `$${Number(t.price).toFixed(2)}`}</li>
                    ))}
                    {a.trades.length === 0 && <li className="text-gray-500">No recent activity</li>}
                  </ul>
                </div>
              );
            })}
          </div>
        </CollapsibleSection>
        
        
        <CollapsibleSection
          title={"Strategy"}
          storageKey="panel:strategy"
          rightActions={(
            <div className="flex space-x-2">
              <div className="flex space-x-1">
                <button
                  onClick={expandAllStrategies}
                  className="px-2 py-1 bg-gray-700 text-white rounded text-xs hover:bg-gray-600"
                  title="Expand All Strategies"
                >
                  Expand All
                </button>
                <button
                  onClick={collapseAllStrategies}
                  className="px-2 py-1 bg-gray-700 text-white rounded text-xs hover:bg-gray-600"
                  title="Collapse All Strategies"
                >
                  Collapse All
                </button>
              </div>
              <div className="space-x-2">
                <button
                  onClick={handleCreateThresholdStrategy}
                  className="px-3 py-1 bg-green-600 text-white rounded text-sm hover:bg-green-700"
                >
                  + Threshold Strategy
                </button>
                <button
                  onClick={handleCreateGridStrategy}
                  className="px-3 py-1 bg-blue-600 text-white rounded text-sm hover:bg-blue-700"
                >
                  + Grid Strategy
                </button>
                <button
                  onClick={handleCreateLeveragedGrid}
                  className="px-3 py-1 bg-purple-600 text-white rounded text-sm hover:bg-purple-700"
                >
                  + Leveraged Grid
                </button>
              </div>
            </div>
          )}
        >
          {strategies.length === 0 ? (
            <div className="text-gray-400 text-base">No strategies configured</div>
          ) : (
            <div className="space-y-3">
              {strategies.map((s, i) => {
                // find mint for price lookup
                const wl = watchlist.find(w => (typeof w === 'string' ? false : (w.symbol?.toUpperCase?.() === s.token?.toUpperCase?.())));
                const mint = (s.token && s.token.length > 30) ? s.token : (wl?.id || '');
                const from = s.fromToken || 'USDC';
                const to = s.toToken || s.token || 'SOL';
                // try to map to watchlist mint ids for both
                const wlFrom = watchlist.find(w => (typeof w === 'string' ? false : (w.symbol?.toUpperCase?.() === from?.toUpperCase?.())));
                const wlTo = watchlist.find(w => (typeof w === 'string' ? false : (w.symbol?.toUpperCase?.() === to?.toUpperCase?.())));
                const mintFrom = (from && from.length > 30) ? from : (wlFrom?.id || '');
                const mintTo = (to && to.length > 30) ? to : (wlTo?.id || '');
                const upperFrom = (from || '').toUpperCase();
                const upperTo = (to || '').toUpperCase();
                const solUsdFromMap = (() => {
                  for (const v of Object.values(prices || {})) {
                    const usdc = (v as any)?.usdc; const sol = (v as any)?.sol;
                    if (typeof usdc === 'number' && typeof sol === 'number' && sol > 0) {
                      const s = usdc / sol; if (isFinite(s) && s > 0) return s;
                    }
                  }
                  return null as number | null;
                })();
                const usdFrom = upperFrom === 'USDC' ? 1 : (upperFrom === 'SOL' ? solUsdFromMap : (mintFrom ? (prices as any)?.[mintFrom]?.usdc : null));
                const usdTo = upperTo === 'USDC' ? 1 : (upperTo === 'SOL' ? solUsdFromMap : (mintTo ? (prices as any)?.[mintTo]?.usdc : null));
                const pair = (usdFrom && usdTo) ? (usdTo / usdFrom) : null;
                const buyPct = s.buyPct ?? 0.05;
                const sellPct = s.sellPct ?? 0.05;
                const isActive = s.active !== false;
                const statusColor = isActive ? 'text-green-400' : 'text-red-400';
                const stratActivity = activitiesByStrategy[s.name || 'default'] || { status: 'idle', trades: [] };
                const anchor = (stratActivity as any)?.anchor ?? pair;
                const buyTrigger = (stratActivity as any)?.buyTrigger ?? (anchor ? anchor * (1 - buyPct) : null);
                const sellTrigger = (stratActivity as any)?.sellTrigger ?? (anchor ? anchor * (1 + sellPct) : null);
                const expectedPnlPct = sellPct * 100;
                const expectedPnlAbs = anchor && usdFrom ? (anchor * sellPct * (s.amount ?? 0) * usdFrom).toFixed(2) : null;
                const isGrid = isGridStrategy(s);
                const strategyName = s.name || 'default';
                const isCollapsed = collapsedStrategies[strategyName];
                const isParamsCollapsed = collapsedStrategyParams[strategyName] ?? true;
                
                return (
                  <div key={i} className="border border-gray-800 rounded p-3 text-base">
                    <div className="font-semibold mb-1 flex items-center justify-between">
                      <div className="flex items-center space-x-2">
                        <button
                          onClick={() => toggleStrategyCollapse(strategyName)}
                          className="text-gray-400 hover:text-gray-200 transition-colors"
                          title={isCollapsed ? 'Expand strategy details' : 'Collapse strategy details'}
                        >
                          {isCollapsed ? '▶' : '▼'}
                        </button>
                        <span className="flex items-center">
                          {s.name || 'unnamed'}
                          {isGrid && <span className="ml-2 px-2 py-1 bg-blue-600 text-white text-xs rounded">GRID</span>}
                        </span>
                      </div>
                      <span className={`text-sm font-semibold ${statusColor}`}>{isActive ? 'ACTIVE' : 'INACTIVE'}</span>
                    </div>
                    {!isCollapsed && (
                      <>
                        <div className="mb-2 space-x-2">
                          <button className="text-sm bg-gray-800 px-3 py-1.5 rounded" onClick={async () => { const resp = await fetch(`${apiBase}/strategy/status`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: s.name, active: !isActive }) }); const json = await resp.json(); if (resp.ok) setStrategies(json.strategies || []); }}>Toggle Active</button>
                          
                          {!isGrid && (
                            <button 
                              className="text-sm bg-green-600 px-3 py-1.5 rounded hover:bg-green-700"
                              onClick={() => handleEditThresholdStrategy(s)}
                            >
                              Edit
                            </button>
                          )}
                          
                          {isGrid && (
                            <button 
                              className="text-sm bg-blue-600 px-3 py-1.5 rounded hover:bg-blue-700"
                              onClick={() => toggleGridStrategyMonitor(s.name)}
                            >
                              {selectedGridStrategies.has(s.name) ? 'Hide Monitor' : 'Show Monitor'}
                            </button>
                          )}
                          
                          {isGrid && (
                            <button 
                              className="text-sm bg-green-600 px-3 py-1.5 rounded hover:bg-green-700"
                              onClick={() => handleEditGridStrategy(s)}
                            >
                              Edit
                            </button>
                          )}
                          
                          <button 
                            className="text-sm bg-red-600 px-3 py-1.5 rounded hover:bg-red-700"
                            onClick={() => handleRemoveStrategy(s.name)}
                          >
                            Remove
                          </button>
                          <button
                            className="ml-2 text-sm bg-gray-700 px-3 py-1.5 rounded hover:bg-gray-600"
                            title={isParamsCollapsed ? 'Show parameters' : 'Hide parameters'}
                            onClick={() => toggleStrategyParams(strategyName)}
                          >
                            {isParamsCollapsed ? 'Show Parameters' : 'Hide Parameters'}
                          </button>
                        </div>
                        {!isParamsCollapsed && (
                          <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                            {Object.entries(s).filter(([k,v]) => v !== undefined && v !== null && k !== 'name').map(([k,v]) => (
                              <React.Fragment key={k}>
                                <div>{k}</div>
                                <div className="text-gray-300">{typeof v === 'boolean' ? (v ? 'true' : 'false') : String(v)}</div>
                              </React.Fragment>
                            ))}
                            {anchor && (<><div>anchor</div><div className="text-gray-300">{`${anchor.toFixed(6)} ${from}->${to}`}</div></>)}
                            {buyTrigger && (<><div>buyTrigger</div><div className="text-gray-300">{`${buyTrigger.toFixed(6)} ${from}->${to}`}</div></>)}
                            {sellTrigger && (<><div>sellTrigger</div><div className="text-gray-300">{`${sellTrigger.toFixed(6)} ${from}->${to}`}</div></>)}
                            {expectedPnlAbs && (<><div>expectedPnL</div><div className="text-gray-300">{`$${expectedPnlAbs} (${expectedPnlPct.toFixed(2)}%)`}</div></>)}
                            {(() => {
                              const a = activitiesByStrategy[s.name || 'default'];
                              const pUsdc = a ? (a as any).pnlUSDC : undefined;
                              const pSol = a ? (a as any).pnlSOL : undefined;
                              return (typeof pUsdc === 'number') ? (<><div>realizedPnL</div><div className="text-gray-300">{`$${pUsdc.toFixed(2)} (${(pSol ?? 0).toFixed(6)} SOL)`}</div></>) : <></>;
                            })()}
                          </div>
                        )}
                        
                        {/* Grid Monitor: overview & performance always visible when expanded; details behind Show Monitor */}
                        {isGrid && (
                          <div className="mt-4 border-t border-gray-600 pt-4">
                            <GridMonitor 
                              strategyName={s.name} 
                              apiBase={apiBase} 
                              currentPrice={pair || undefined}
                              showDetails={selectedGridStrategies.has(s.name)}
                            />
                          </div>
                        )}
                      </>
                    )}
                    
                  </div>
                );
              })}
            </div>
          )}
        </CollapsibleSection>
        
      </div>
      <div className="space-y-4">
        <section className="bg-gray-900 rounded p-4 h-[32vh] overflow-auto">
          <h2 className="text-2xl font-semibold mb-3">User Log</h2>
          <ul className="space-y-1">
            {terminalLogs.map((l, i) => {
              const colorByCat: Record<string,string> = {
                api: 'text-blue-300', jupiter: 'text-blue-300', raydium: 'text-emerald-300', orca: 'text-amber-300',
                arb: 'text-indigo-300', strategy: 'text-green-300', pretrade: 'text-purple-300', trade: 'text-cyan-300',
                terminal: 'text-gray-300', graph: 'text-pink-300', pools: 'text-teal-300', price: 'text-orange-300',
                wallet: 'text-lime-300', server: 'text-slate-300', auth: 'text-fuchsia-300', system: 'text-zinc-300', other: 'text-gray-300'
              };
              const color = l.level === 'error' ? 'text-red-400' : l.level === 'warn' ? 'text-yellow-400' : (colorByCat as any)[(l as any).cat] || 'text-gray-300';
              return (
                <li key={i} className={`text-sm ${color}`}>
                  <span className="text-gray-500">[{l.timestamp}]</span> <span className="uppercase text-gray-400">{l.level}</span> {(l as any).cat ? <span className={`uppercase ${color}`}>[{(l as any).cat}]</span> : null} {l.message}
                </li>
              );
            })}
            {terminalLogs.length === 0 && <li className="text-sm text-gray-500">No terminal logs yet</li>}
          </ul>
        </section>
        <section className="bg-gray-900 rounded p-4 h-[52vh] overflow-auto">
          <h2 className="text-2xl font-semibold mb-3">Trade Log</h2>
          <ul className="space-y-1">
            {tradeLogs.map((l, i) => {
              const colorByCat: Record<string,string> = { api: 'text-blue-300', jupiter: 'text-blue-300', pretrade: 'text-purple-300', trade: 'text-cyan-300', arb: 'text-indigo-300', raydium: 'text-emerald-300', orca: 'text-amber-300' };
              const color = l.level === 'error' ? 'text-red-400' : l.level === 'warn' ? 'text-yellow-400' : (colorByCat as any)[(l as any).cat] || 'text-gray-300';
              return (
                <li key={i} className={`text-sm ${color}`}>
                  <span className="text-gray-500">[{l.timestamp}]</span> <span className="uppercase text-gray-400">{l.level}</span> {(l as any).cat ? <span className={`uppercase ${color}`}>[{(l as any).cat}]</span> : null} {l.message}
                </li>
              );
            })}
          </ul>
        </section>
        <section className="bg-gray-900 rounded p-4 h-[40vh] overflow-auto">
          <h2 className="text-2xl font-semibold mb-3">Strategy Log</h2>
          <ul className="space-y-1">
            {strategyLogs.map((l, i) => {
              const colorByCat: Record<string,string> = { strategy: 'text-green-300', pretrade: 'text-purple-300', trade: 'text-cyan-300' };
              const color = l.level === 'error' ? 'text-red-400' : l.level === 'warn' ? 'text-yellow-400' : (colorByCat as any)[(l as any).cat] || 'text-green-300';
              return (
                <li key={i} className={`text-sm ${color}`}>
                  <span className="text-gray-500">[{l.timestamp}]</span> <span className="uppercase text-gray-400">{l.level}</span> {(l as any).cat ? <span className={`uppercase ${color}`}>[{(l as any).cat}]</span> : null} {l.message}
                </li>
              );
            })}
          </ul>
        </section>
        <section className="bg-gray-900 rounded p-4 h-[40vh] overflow-auto">
          <h2 className="text-2xl font-semibold mb-3">Arbitrage Log</h2>
          <ul className="space-y-1">
            {arbLogs.map((l, i) => {
              const colorByCat: Record<string,string> = { arb: 'text-indigo-300', graph: 'text-pink-300', pools: 'text-teal-300', raydium: 'text-emerald-300', orca: 'text-amber-300' };
              const color = l.level === 'error' ? 'text-red-400' : l.level === 'warn' ? 'text-yellow-400' : (colorByCat as any)[(l as any).cat] || 'text-indigo-300';
              return (
                <li key={i} className={`text-sm ${color}`}>
                  <span className="text-gray-500">[{l.timestamp}]</span> <span className="uppercase text-gray-400">{l.level}</span> {(l as any).cat ? <span className={`uppercase ${color}`}>[{(l as any).cat}]</span> : null} {l.message}
                </li>
              );
            })}
          </ul>
        </section>
        <section className="bg-gray-900 rounded p-4 h-[40vh] overflow-auto">
          <h2 className="text-2xl font-semibold mb-3">API Log</h2>
          <ul className="space-y-1">
            {apiLogs.map((l, i) => {
              const colorByCat: Record<string,string> = { api: 'text-blue-300', jupiter: 'text-blue-300', raydium: 'text-amber-300', orca: 'text-emerald-300' };
              const color = l.level === 'error' ? 'text-red-400' : l.level === 'warn' ? 'text-yellow-400' : (colorByCat as any)[(l as any).cat] || 'text-blue-300';
              return (
                <li key={i} className={`text-sm ${color}`}>
                  <span className="text-gray-500">[{l.timestamp}]</span> <span className="uppercase text-gray-400">{l.level}</span> {(l as any).cat ? <span className={`uppercase ${color}`}>[{(l as any).cat}]</span> : null} {l.message}
                </li>
              );
            })}
          </ul>
        </section>
      </div>
      
      {/* Grid Strategy Configuration Modal */}
      {showGridConfig && (
        <GridStrategyConfig
          onSave={handleSaveGridStrategy}
          onCancel={() => {
            setShowGridConfig(false);
            setEditingStrategy(null);
          }}
          initialConfig={editingStrategy}
        />
      )}

      {/* Leveraged Grid Configuration Modal */}
      {showLevGridConfig && (
        <LeveragedGridConfig onClose={() => setShowLevGridConfig(false)} />
      )}

      {/* Threshold Strategy Configuration Modal */}
      {showThresholdConfig && (
        <ThresholdStrategyConfig
          onSave={handleSaveThresholdStrategy}
          onCancel={() => {
            setShowThresholdConfig(false);
            setEditingStrategy(null);
          }}
          initialConfig={editingStrategy}
        />
      )}

      {/* Add Token Modal */}
      {showAddToken && (
        <AddTokenForm
          onSave={handleAddToken}
          onCancel={() => setShowAddToken(false)}
          apiBase={apiBase}
        />
      )}

      {/* Fee Configuration Modal */}
      {showFeeConfig && (
        <FeeConfig
          onSave={async (config) => {
            try {
              const response = await fetch(`${apiBase}/fees/config`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(config)
              });
              
              if (response.ok) {
                setShowFeeConfig(false);
                await fetch(`${apiBase}/terminal/log`, { 
                  method: 'POST', 
                  headers: { 'Content-Type': 'application/json' }, 
                  body: JSON.stringify({ level: 'info', message: 'terminal: Fee configuration updated' }) 
                });
              } else {
                throw new Error('Failed to update fee configuration');
              }
            } catch (error) {
              logger.error('Failed to update fee configuration:', error);
              throw error;
            }
          }}
          onCancel={() => setShowFeeConfig(false)}
          initialConfig={system.fees}
        />
      )}

      {/* System Configuration Modal */}
      {showSystemConfig && (
        <SystemConfig
          onSave={handleSystemConfigSave}
          onCancel={() => setShowSystemConfig(false)}
          initialConfig={system}
        />
      )}

      {/* Arbitrage Configuration Modal */}
      {showDataFetchConfig && (
        <DataFetchConfig apiBase={apiBase} onClose={() => setShowDataFetchConfig(false)} />
      )}
      {showEngineConfig && (
        <ArbEngineConfig apiBase={apiBase} onClose={() => setShowEngineConfig(false)} />
      )}
    </div>
  );
}


