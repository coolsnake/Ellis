// @ts-nocheck
import React, { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { logger } from '../utils/logger';
import { io, Socket } from 'socket.io-client';
import { GridStrategyConfig } from '../components/GridStrategyConfig';
import { LeveragedGridConfig } from '../components/LeveragedGridConfig';
import { ROUTES } from '../utils/routes';
import { GridMonitor } from '../components/GridMonitor';
import { LiquidationMonitor } from '../components/LiquidationMonitor';
import { WatchlistSection } from '../features/wallet/WatchlistSection';
import { ConfigsSection } from '../features/configs/ConfigsSection';
// removed legacy LiquidatorConfig modal
import { LiquidatorRunnerConfig } from '../components/LiquidatorRunnerConfig';
import { TriggerRunnerConfig } from '../components/TriggerRunnerConfig';
import { ThresholdStrategyConfig } from '../components/ThresholdStrategyConfig';
import { AddTokenForm } from '../components/AddTokenForm';
import { FeeConfig } from '../components/FeeConfig';
import { ArbitrageSection } from '../features/arbitrage/ArbitrageSection';
import { DriftSection } from '../features/drift/DriftSection';
import { ExecutionConfigModal } from '../components/ExecutionConfigModal';
import { ArbConfig } from '../components/ArbConfig';
import { DataFetchConfig } from '../components/DataFetchConfig';
import { ArbEngineConfig } from '../components/ArbEngineConfig';
import { GraphConfig } from '../components/GraphConfig';
import { SystemConfig } from '../components/SystemConfig';
import { GraphView } from '../components/GraphView';
import { CollapsibleSection } from '../components/CollapsibleSection';
import { AltManagementModal } from '../components/AltManagementModal';
import { setLogLevel as setFrontendLogLevel } from '../utils/logger';
import { downloadModalConfigs, uploadModalConfigs, clearAllModalConfigs } from '../utils/modalConfigManager';
import { maskRpcUrl } from '../utils/mask';
import { useSystem } from '../app/contexts/system';
import { useWallet } from '../app/contexts/wallet';
import { useDrift } from '../app/contexts/drift';
import { useArb } from '../app/contexts/arb';
import { useAuth } from '../app/contexts/auth';
// Login page is now routed at /login; main app assumes authenticated state

const LogsColumn = React.lazy(() => import('../features/logs/LogsColumn'));

// maskRpcUrl moved to ../utils/mask

export const App: React.FC = () => {
  const { system, setSystem } = useSystem();
  const [showFillerRunnerConfig, setShowFillerRunnerConfig] = useState(false);
  const { wallet, setWallet, walletTokens, setWalletTokens, prices, setPrices } = useWallet();
  const { status: driftStatus, setStatus: setDriftStatus, subaccounts: driftSubaccounts, setSubaccounts: setDriftSubaccounts, selectedSubId: driftSelectedSubId, setSelectedSubId: setDriftSelectedSubId, subBalances: driftSubBalances, setSubBalances: setDriftSubBalances, spotMarkets: driftSpotMarkets, setSpotMarkets: setDriftSpotMarkets, action: driftAction, setAction: setDriftAction, amount: driftAmount, setAmount: setDriftAmount, spotIndex: driftSpotIndex, setSpotIndex: setDriftSpotIndex } = useDrift();
  const { arbConfig, setArbConfig, strategies, setStrategies } = useArb();
  const [watchlist, setWatchlist] = useState<any[]>([]);
  const [driftNewSubName, setDriftNewSubName] = useState<string>('');
  const [driftRenameSubName, setDriftRenameSubName] = useState<string>('');
  const [driftOpBusy, setDriftOpBusy] = useState<boolean>(false);
  const [positions, setPositions] = useState<any[]>([]);
  const [gridPositionsSummary, setGridPositionsSummary] = useState<Array<{ strategy: string; fromSymbol: string; toSymbol: string; count: number; totalFromToken: number; avgOpenMs: number }>>([]);
  const [activity, setActivity] = useState<{ status: string; trades: any[] }>({ status: 'idle', trades: [] });
  const [activitiesByStrategy, setActivitiesByStrategy] = useState<Record<string, { status: string; trades: any[]; pair?: string; anchor?: number; buyTrigger?: number; sellTrigger?: number; currentPairPrice?: number }>>({});
  
  const [walletHistory, setWalletHistory] = useState<any[]>([]);
  const [terminalInput, setTerminalInput] = useState('');
  const [showGridConfig, setShowGridConfig] = useState(false);
  const [showLevGridConfig, setShowLevGridConfig] = useState(false);
  const [showThresholdConfig, setShowThresholdConfig] = useState(false);
  const [showAddToken, setShowAddToken] = useState(false);
  const [editingStrategy, setEditingStrategy] = useState<any>(null);
  const [editingLevGrid, setEditingLevGrid] = useState<any>(null);
  const [selectedGridStrategies, setSelectedGridStrategies] = useState<Set<string>>(new Set());
  const [collapsedStrategies, setCollapsedStrategies] = useState<Record<string, boolean>>({});
  const [collapsedStrategyParams, setCollapsedStrategyParams] = useState<Record<string, boolean>>({});
  const [showFeeConfig, setShowFeeConfig] = useState(false);
  const [showSystemConfig, setShowSystemConfig] = useState(false);
  const [showArbConfig, setShowArbConfig] = useState(false);
  const [showDataFetchConfig, setShowDataFetchConfig] = useState(false);
  const [showGraphConfig, setShowGraphConfig] = useState(false);
  const [showEngineConfig, setShowEngineConfig] = useState(false);
  const [showOpportunityConfig, setShowOpportunityConfig] = useState(false);
  const [showAltModal, setShowAltModal] = useState(false);
  const [showLiqConfig, setShowLiqConfig] = useState(false);
  const [showGraph, setShowGraph] = useState(false);
  const [showModalConfigManager, setShowModalConfigManager] = useState(false);
  // socket managed by context; remove local ref after full migration
  const lastSystemRef = useRef<number>(Date.now());
  const { credentials } = useAuth();
  
  // Handler for modal config import
  const handleImportModalConfigs = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    try {
      await uploadModalConfigs(file);
      alert('Modal configurations imported successfully! Refresh to see changes.');
    } catch (err) {
      alert('Failed to import configurations: ' + String(err));
    }
    // Reset input so same file can be selected again
    e.target.value = '';
  };
  
  // Handler for clearing modal configs
  const handleClearModalConfigs = () => {
    if (confirm('Are you sure you want to reset all modal preferences? This cannot be undone.')) {
      clearAllModalConfigs();
      alert('All modal configurations have been cleared! Refresh to see changes.');
    }
  };

  // Track last received backend heartbeat (via socket 'system' event updating `system`)
  useEffect(() => {
    try { lastSystemRef.current = Date.now(); } catch {}
  }, [system?.uptimeMs]);

  // Liquidator panel state
  // removed legacy inline liquidator fields (use +Liquidator modal instead)
  const [liqStatus, setLiqStatus] = useState<any>(null);
  const [showLiqRunnerConfig, setShowLiqRunnerConfig] = useState<boolean>(false);
  const [showTriggerRunnerConfig, setShowTriggerRunnerConfig] = useState<boolean>(false);
  const [showExecConfig, setShowExecConfig] = useState<boolean>(false);

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

  // Authorization headers are injected globally in utils/api

  // TTL/redirects handled by fetch interceptor + router gating

  useEffect(() => {
    if (!credentials) return;
    fetch(`${apiBase}${ROUTES.watchlist}`).then(r => r.json()).then(d => setWatchlist(d.watchlist));
    // Load base (spot) strategies first
    fetch(`${apiBase}${ROUTES.legacy.strategy}`).then(r => r.json()).then(async (d) => {
      const baseList = d.strategies || [];
      // Load Drift leveraged grid strategies and merge into the same list for display
      try {
        const resp = await fetch(`${apiBase}${ROUTES.strategies.leveragedGrid.status}`);
        const lg = await resp.json();
        const mapped = Array.isArray(lg?.strategies) ? (lg.strategies as any[]).map((s: any, i: number) => {
          const cfg = (s?.status?.config || {}) as any;
          const market = cfg?.market || {};
          const idx = Number(market?.marketIndex ?? i);
          const driftMarketSym = (() => {
            try {
              const list = (driftStatus?.markets || []) as Array<{ marketIndex: number; symbol?: string }>;
              const hit = list.find(m => Number(m.marketIndex) === idx);
              return hit?.symbol;
            } catch {}
            return undefined;
          })();
          const toSym = driftMarketSym || market?.symbol || `PERP-${idx ?? '?'}`;
          return {
            name: cfg?.name || `lev-grid-${idx}`,
            type: 'drift-grid',
            fromToken: 'USDC',
            toToken: toSym,
            gridType: 'drift',
            gridLevels: [],
            active: !!(s?.status?.running),
            driftKey: String(s?.key || `${cfg?.name || `lev-grid-${idx}`}#${idx}#${cfg?.subaccountId ?? ''}`),
            marketIndex: idx,
            subaccountId: Number(cfg?.subaccountId ?? 0),
          } as any;
        }) : [];
        setStrategies([...(baseList || []), ...mapped]);
      } catch {
        setStrategies(baseList || []);
      }
    });
  }, [apiBase, credentials]);

  useEffect(() => {
    if (!credentials) return;
    (async () => {
      try {
        if (!Number.isFinite(Number(driftSelectedSubId))) return;
        const b = await fetch(`${apiBase}${ROUTES.drift.subaccountBalances}?subaccountId=${Number(driftSelectedSubId)}`).then(r => r.json());
        setDriftSubBalances(Array.isArray(b?.balances) ? b.balances : []);
      } catch {}
    })();
  }, [apiBase, credentials, driftSelectedSubId]);

  useEffect(() => {
    const sel = driftSubaccounts.find((s: any) => Number(s.id) === Number(driftSelectedSubId));
    setDriftRenameSubName(sel?.name || '');
  }, [driftSelectedSubId, driftSubaccounts]);

  useEffect(() => {
    if (!credentials) return;
    // strategies and activity updates remain here for now
    // strategies/activity updates are now handled via socket context hooks
    const onStrategiesUpdate = async (list: any[]) => {
      const base = Array.isArray(list) ? list : [];
      try {
            const resp = await fetch(`${apiBase}${ROUTES.strategies.leveragedGrid.status}`);
        const lg = await resp.json();
        const mapped = Array.isArray(lg?.strategies) ? (lg.strategies as any[]).map((s: any, i: number) => {
          const cfg = (s?.status?.config || {}) as any;
          const market = cfg?.market || {};
          const idx = Number(market?.marketIndex ?? i);
          const driftMarketSym = (() => {
            try {
              const list = (driftStatus?.markets || []) as Array<{ marketIndex: number; symbol?: string }>;
              const hit = list.find(m => Number(m.marketIndex) === idx);
              return hit?.symbol;
            } catch {}
            return undefined;
          })();
          const toSym = driftMarketSym || market?.symbol || `PERP-${idx ?? '?'}`;
          return {
            name: cfg?.name || `lev-grid-${idx}`,
            type: 'drift-grid',
            fromToken: 'USDC',
            toToken: toSym,
            gridType: 'drift',
            gridLevels: [],
            active: !!(s?.status?.running),
            driftKey: String(s?.key || `${cfg?.name || `lev-grid-${idx}`}#${idx}#${cfg?.subaccountId ?? ''}`),
            marketIndex: idx,
            subaccountId: Number(cfg?.subaccountId ?? 0),
          } as any;
        }) : [];
        setStrategies([...(base || []), ...mapped]);
      } catch {
        setStrategies(base || []);
      }
    };
    const onPositions = (p: any) => setPositions(p || []);
    const onGridPositions = (payload: any) => {
      const updates = Array.isArray(payload) ? payload : [payload];
      setGridPositionsSummary((prev) => {
        const next = new Map<string, { strategy: string; fromSymbol: string; toSymbol: string; count: number; totalFromToken: number; avgOpenMs: number }>();
        for (const it of prev) { next.set(`${it.strategy}|${it.fromSymbol}|${it.toSymbol}`, { ...it }); }
        for (const upd of updates) {
          try {
            const strategy = String((upd as any)?.strategy || 'default');
            const fromSymbol = String((upd as any)?.fromSymbol || 'USDC');
            const toSymbol = String((upd as any)?.toSymbol || 'SOL');
            const key = `${strategy}|${fromSymbol}|${toSymbol}`;
            const exists = next.get(key) || { strategy, fromSymbol, toSymbol, count: 0, totalFromToken: 0, avgOpenMs: 0 };
            next.set(key, {
              strategy, fromSymbol, toSymbol,
              count: Number((upd as any)?.count || exists.count || 0),
              totalFromToken: Number((upd as any)?.totalFromToken || exists.totalFromToken || 0),
              avgOpenMs: Number((upd as any)?.avgOpenMs || exists.avgOpenMs || 0),
            });
          } catch {}
        }
        return Array.from(next.values());
      });
    };
    const onWalletHistory = (h: any) => setWalletHistory(h || []);
    const onActivity = (a: any) => {
      setActivity(a || { status: 'idle', trades: [] });
      const name = (a && (a as any).strategy) || 'default';
      setActivitiesByStrategy((prev) => ({
        ...prev,
        [name]: {
          status: a?.status || 'idle',
          trades: a?.trades || [],
          // Remove drift-specific metrics from Activity (moved into GridMonitor)
          pair: (a as any)?.pair,
          anchor: (a as any)?.anchor,
          buyTrigger: (a as any)?.buyTrigger,
          sellTrigger: (a as any)?.sellTrigger,
          currentPairPrice: (a as any)?.currentPairPrice,
          holding: (a as any)?.holding,
          completedCycles: (a as any)?.completedCycles,
          // omit realized/unrealized drift PnL from activity card summary now
          marketSymbol: (() => {
            try {
              const idx = Number((a as any)?.marketIndex);
              if (Number.isFinite(idx)) {
                const hit = (driftStatus?.markets || []).find((m: any) => Number(m.marketIndex) === idx);
                return hit?.symbol;
              }
            } catch {}
            return undefined;
          })(),
        },
      }));
    };
    // No direct socket binding here; left for compatibility if needed in future
    return () => {};
  }, [wsUrl, credentials]);

  // Listen for clear events from individual LogWindow components
  // Auth is gated at the router level

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

  const handleSystemConfigSave = async (config: import('shared/config-types').SystemConfigRequest) => {
    try {
      const response = await fetch(`${apiBase}${ROUTES.system.config}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config)
      });
      
      if (response.ok) {
        setShowSystemConfig(false);
        // Refresh system info
        const systemResponse = await fetch(`${apiBase}${ROUTES.system.base}`);
        const systemData = await systemResponse.json();
        setSystem(systemData);
        // Apply frontend log level locally if provided
        try {
          const lvl = (config?.system?.frontendLogLevel || config?.system?.logLevel);
          if (lvl === 'error' || lvl === 'warn' || lvl === 'info' || lvl === 'debug') {
            setFrontendLogLevel(lvl);
          }
          // Persist frontend category preferences from System Config
          const cats = Array.isArray(config?.system?.frontendEnabledLogCategories) ? config.system.frontendEnabledLogCategories : undefined;
          if (cats) {
            try { window.localStorage.setItem('frontendEnabledLogCategories', JSON.stringify(cats)); } catch {}
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
      const response = await fetch(`${apiBase}${ROUTES.legacy.strategy}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config)
      });
      
      if (response.ok) {
        const data = await response.json();
        setStrategies(data.strategies || []);
        setShowGridConfig(false);
        setEditingStrategy(null);
        await fetch(`${apiBase}${ROUTES.legacy.terminalLog}`, { 
          method: 'POST', 
          headers: { 'Content-Type': 'application/json' }, 
          body: JSON.stringify({ level: 'info', message: `terminal: Grid strategy saved: ${config.name}` }) 
        });
      } else {
        const error = await response.json();
        throw new Error(error.error || 'Failed to save strategy');
      }
    } catch (error: any) {
      await fetch(`${apiBase}${ROUTES.legacy.terminalLog}`, { 
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
    setEditingLevGrid(null);
    setShowLevGridConfig(true);
  };

  const handleSaveThresholdStrategy = async (config: any) => {
    try {
      const response = await fetch(`${apiBase}${ROUTES.legacy.strategy}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config)
      });
      
      if (response.ok) {
        const data = await response.json();
        setStrategies(data.strategies || []);
        setShowThresholdConfig(false);
        setEditingStrategy(null);
        await fetch(`${apiBase}${ROUTES.legacy.terminalLog}`, { 
          method: 'POST', 
          headers: { 'Content-Type': 'application/json' }, 
          body: JSON.stringify({ level: 'info', message: `terminal: Threshold strategy saved: ${config.name}` }) 
        });
      } else {
        const error = await response.json();
        throw new Error(error.error || 'Failed to save strategy');
      }
    } catch (error: any) {
      await fetch(`${apiBase}${ROUTES.legacy.terminalLog}`, { 
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

  const handleRemoveStrategy = async (strategy: any) => {
    const strategyName = strategy?.name || 'default';
    if (!confirm(`Are you sure you want to remove strategy "${strategyName}"? This will also close any associated positions.`)) {
      return;
    }

    try {
      if (strategy?.gridType === 'drift') {
        // Resolve exact runner key for leveraged grid and stop it
        const resolveDriftKey = async (): Promise<string | null> => {
          const byProp = typeof strategy?.driftKey === 'string' ? strategy.driftKey as string : null;
          if (byProp && byProp.includes('#')) return byProp;
          const mi = Number(strategy?.marketIndex);
          const sa = Number(strategy?.subaccountId);
          if (Number.isFinite(mi) && Number.isFinite(sa)) return `${strategyName}#${mi}#${sa}`;
          try {
            const statusResp = await fetch(`${apiBase}/strategies/leveraged-grid/status`);
            const lg = await statusResp.json();
            const items = Array.isArray(lg?.strategies) ? lg.strategies : [];
            // Prefer exact name match
            let candidates = items.filter((x: any) => {
              const cfg = (x?.status?.config || {}) as any;
              const key = String(x?.key || '');
              const keyName = key.includes('#') ? key.split('#')[0] : key;
              return (cfg?.name === strategyName) || (keyName === strategyName);
            });
            // Narrow by marketIndex if provided
            if (Number.isFinite(mi)) {
              candidates = candidates.filter((x: any) => Number((x?.status?.config as any)?.market?.marketIndex) === mi);
            }
            if (candidates.length > 0) return String(candidates[0].key);
          } catch {}
          return null;
        };

        const key = await resolveDriftKey();
        if (!key) throw new Error('Unable to determine leveraged grid key to remove');

        const resp = await fetch(`${apiBase}${ROUTES.strategies.leveragedGrid.stop}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key }) });
        if (!resp.ok) {
          const txt = await resp.text();
          throw new Error(txt || 'Failed to stop leveraged grid');
        }
        const out = await resp.json().catch(() => ({ ok: true }));
        if (!out?.ok) throw new Error('Leveraged grid not found or could not be removed');
        // Optimistically remove from local state
        setStrategies(prev => (prev || []).filter((s: any) => {
          const sMi = Number(s?.marketIndex);
          const sSa = Number(s?.subaccountId);
          const sKey = typeof s?.driftKey === 'string' && s.driftKey.includes('#') ? s.driftKey : (Number.isFinite(sMi) && Number.isFinite(sSa) ? `${s?.name}#${sMi}#${sSa}` : null);
          return sKey !== key;
        }));
        setPositions(prev => (prev || []).filter((p: any) => (p?.strategy || 'default') !== strategyName));
        setActivitiesByStrategy(prev => { const next = { ...(prev || {}) } as any; delete next[strategyName]; return next; });
        // Refresh from server to avoid reappearing due to stale merges
        try {
          const base = await (await fetch(`${apiBase}${ROUTES.legacy.strategy}`)).json();
          const baseList = base?.strategies || [];
          const statusResp = await fetch(`${apiBase}/strategies/leveraged-grid/status`);
          const lg = await statusResp.json();
          const mapped = Array.isArray(lg?.strategies) ? (lg.strategies as any[]).map((s: any, i: number) => {
            const cfg = (s?.status?.config || {}) as any;
            const market = cfg?.market || {};
            const idx = Number(market?.marketIndex ?? i);
            const driftMarketSym = (() => {
              try {
                const list = (driftStatus?.markets || []) as Array<{ marketIndex: number; symbol?: string }>;
                const hit = list.find(m => Number(m.marketIndex) === idx);
                return hit?.symbol;
              } catch {}
              return undefined;
            })();
            const toSym = driftMarketSym || market?.symbol || `PERP-${idx ?? '?'}`;
            return {
              name: cfg?.name || `lev-grid-${idx}`,
              type: 'drift-grid',
              fromToken: 'USDC',
              toToken: toSym,
              gridType: 'drift',
              gridLevels: [],
              active: !!(s?.status?.running),
              driftKey: String(s?.key || `${cfg?.name || `lev-grid-${idx}`}#${idx}#${cfg?.subaccountId ?? ''}`),
              marketIndex: idx,
              subaccountId: Number(cfg?.subaccountId ?? 0),
            } as any;
          }) : [];
          setStrategies([...(baseList || []), ...mapped]);
        } catch {}
      } else {
        const response = await fetch(`${apiBase}${ROUTES.legacy.strategy}`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: strategyName })
        });
        if (response.ok) {
          const data = await response.json();
          setStrategies(data.strategies || []);
        } else {
          const error = await response.json();
          throw new Error(error.error || 'Failed to remove strategy');
        }
      }
        await fetch(`${apiBase}${ROUTES.legacy.terminalLog}`, { 
          method: 'POST', 
          headers: { 'Content-Type': 'application/json' }, 
          body: JSON.stringify({ level: 'info', message: `terminal: Strategy removed: ${strategyName}` }) 
        });
    } catch (error: any) {
      await fetch(`${apiBase}${ROUTES.legacy.terminalLog}`, { 
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
        await fetch(`${apiBase}${ROUTES.legacy.terminalLog}`, { 
          method: 'POST', 
          headers: { 'Content-Type': 'application/json' }, 
          body: JSON.stringify({ level: 'info', message: `terminal: Token added to watchlist: ${token.symbol}` }) 
        });
      } else {
        const error = await response.json();
        throw new Error(error.error || 'Failed to add token');
      }
    } catch (error: any) {
      await fetch(`${apiBase}${ROUTES.legacy.terminalLog}`, { 
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
        await fetch(`${apiBase}${ROUTES.legacy.terminalLog}`, { 
          method: 'POST', 
          headers: { 'Content-Type': 'application/json' }, 
          body: JSON.stringify({ level: 'info', message: `terminal: Token removed from watchlist: ${tokenSymbol}` }) 
        });
      } else {
        const error = await response.json();
        throw new Error(error.error || 'Failed to remove token');
      }
    } catch (error: any) {
      await fetch(`${apiBase}${ROUTES.legacy.terminalLog}`, { 
        method: 'POST', 
        headers: { 'Content-Type': 'application/json' }, 
        body: JSON.stringify({ level: 'error', message: `terminal: Failed to remove token: ${error.message}` }) 
      });
    }
  };

  async function handleTerminal(cmd: string) {
    if (cmd) {
      await fetch(`${apiBase}${ROUTES.legacy.terminalLog}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'info', message: `terminal: > ${cmd}` }) });
    }
    // Namespaced command routing (preferred)
    {
      const parts = cmd.split(/\s+/).filter(Boolean);
      const ns = (parts[0] || '').toLowerCase();
      if (ns === 'wallet') {
        const action = (parts[1] || '').toLowerCase();
        if (action === 'generate') {
          try {
            const resp = await fetch(`${apiBase}${ROUTES.wallet.generate}`, { method: 'POST' });
            const json = await resp.json();
            if (!resp.ok) throw new Error(json?.error || 'generate failed');
            await fetch(`${apiBase}${ROUTES.legacy.terminalLog}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'info', message: `terminal: wallet generated ${json.address}` }) });
          } catch (e: any) {
            await fetch(`${apiBase}${ROUTES.legacy.terminalLog}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'error', message: `terminal: wallet generate failed ${String(e?.message || e)}` }) });
          }
          return;
        }
        if (action === 'wrap') {
          const amount = Number(parts[2]);
          if (!isFinite(amount) || amount <= 0) {
            await fetch(`${apiBase}${ROUTES.legacy.terminalLog}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'warn', message: 'terminal: wallet wrap AMOUNT' }) });
          } else {
            try {
              const resp = await fetch(`${apiBase}${ROUTES.wallet.wrap}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ amount }) });
              const json = await resp.json();
              if (!resp.ok) throw new Error(json?.error || 'wrap failed');
              await fetch(`${apiBase}${ROUTES.legacy.terminalLog}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'info', message: `terminal: wallet wrap success ${amount} SOL sig=${json.signature}` }) });
            } catch (e: any) {
              await fetch(`${apiBase}${ROUTES.legacy.terminalLog}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'error', message: `terminal: wallet wrap failed ${String(e?.message || e)}` }) });
            }
          }
          return;
        }
        if (action === 'unwrap') {
          try {
            const resp = await fetch(`${apiBase}${ROUTES.wallet.unwrap}`, { method: 'POST' });
            const json = await resp.json();
            if (!resp.ok) throw new Error(json?.error || 'unwrap failed');
            await fetch(`${apiBase}${ROUTES.legacy.terminalLog}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'info', message: `terminal: wallet unwrap success sig=${json.signature}` }) });
          } catch (e: any) {
            await fetch(`${apiBase}${ROUTES.legacy.terminalLog}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'error', message: `terminal: wallet unwrap failed ${String(e?.message || e)}` }) });
          }
          return;
        }
        if (action === 'refresh') {
          try { await fetch(`${apiBase}${ROUTES.wallet.refresh}`, { method: 'POST' }); } catch {}
          return;
        }
        if (action === 'send') {
          if (parts.length >= 5) {
            const token = parts[2];
            const amount = Number(parts[3]);
            const address = parts[4];
            if (!isFinite(amount) || amount <= 0) {
              await fetch(`${apiBase}${ROUTES.legacy.terminalLog}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'warn', message: 'terminal: wallet send TOKEN|MINT AMOUNT ADDRESS' }) });
              return;
            }
            try {
              const resp = await fetch(`${apiBase}${ROUTES.wallet.send}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, destination: address, amount }) });
              const json = await resp.json();
              if (!resp.ok) throw new Error(json?.error || 'send failed');
              await fetch(`${apiBase}${ROUTES.legacy.terminalLog}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'info', message: `terminal: wallet send success sig=${json.signature || '(n/a)'}` }) });
            } catch (e: any) {
              await fetch(`${apiBase}${ROUTES.legacy.terminalLog}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'error', message: `terminal: wallet send failed ${String(e?.message || e)}` }) });
            }
          } else {
            await fetch(`${apiBase}${ROUTES.legacy.terminalLog}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'warn', message: 'terminal: wallet send TOKEN|MINT AMOUNT ADDRESS' }) });
          }
          return;
        }
        if (action === 'addtoken') {
          const query = parts.slice(2).join(' ');
          if (!query) {
            await fetch(`${apiBase}${ROUTES.legacy.terminalLog}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'warn', message: 'terminal: wallet addtoken TOKEN|MINT' }) });
            return;
          }
          const resp = await fetch(`${apiBase}${ROUTES.wallet.tokens}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query }) });
          const json = await resp.json();
          if (!resp.ok) {
            await fetch(`${apiBase}${ROUTES.legacy.terminalLog}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'error', message: `terminal: wallet addtoken failed: ${json?.error || 'unknown'}` }) });
          } else {
            setWalletTokens(Array.isArray(json.list) ? json.list : (json.walletTokens || []));
            await fetch(`${apiBase}${ROUTES.legacy.terminalLog}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'info', message: `terminal: wallet addtoken added ${json.added?.symbol || json.added?.id}` }) });
          }
          return;
        }
        await fetch(`${apiBase}${ROUTES.legacy.terminalLog}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'warn', message: 'terminal: wallet commands: generate | refresh | send TOKEN|MINT AMOUNT ADDRESS | addtoken TOKEN|MINT | wrap AMOUNT | unwrap' }) });
        return;
      }
      if (ns === 'watchlist') {
        const action = (parts[1] || '').toLowerCase();
        if (action === 'add') {
          const query = cmd.slice('watchlist add '.length).trim();
          if (!query) {
            await fetch(`${apiBase}${ROUTES.legacy.terminalLog}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'warn', message: 'terminal: watchlist add QUERY|MINT' }) });
          } else {
            await fetch(`${apiBase}${ROUTES.legacy.terminalLog}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'info', message: `terminal: -> adding ${query} to watchlist` }) });
            await fetch(`${apiBase}${ROUTES.watchlist}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idOrSymbol: query }) });
          }
          return;
        }
        if (action === 'remove') {
          const idOrSymbol = parts[2];
          if (!idOrSymbol) {
            await fetch(`${apiBase}${ROUTES.legacy.terminalLog}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'warn', message: 'terminal: watchlist remove SYMBOL|MINT' }) });
          } else {
            await fetch(`${apiBase}${ROUTES.legacy.terminalLog}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'info', message: `terminal: -> removing ${idOrSymbol} from watchlist` }) });
            await fetch(`${apiBase}${ROUTES.watchlist}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idOrSymbol }) });
          }
          return;
        }
        if (action === 'list') {
          const d = await (await fetch(`${apiBase}${ROUTES.watchlist}`)).json();
          setWatchlist(d.watchlist || []);
          return;
        }
        await fetch(`${apiBase}${ROUTES.legacy.terminalLog}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'warn', message: 'terminal: watchlist commands: add QUERY|MINT | remove SYMBOL|MINT | list' }) });
        return;
      }
      if (ns === 'strategy') {
        await fetch(`${apiBase}${ROUTES.legacy.terminalLog}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ level: 'warn', message: 'terminal: strategy commands have been removed; use the Strategy UI panels instead' })
        });
        return;
      }
      if (ns === 'graph') {
        const action = (parts[1] || '').toLowerCase();
        if (action === 'drop') {
          const poolId = parts[2];
          if (!poolId) {
            await fetch(`${apiBase}${ROUTES.legacy.terminalLog}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'warn', message: "terminal: graph drop POOL_ID" }) });
            return;
          }
          try {
            const resp = await fetch(`${apiBase}${ROUTES.graph.drop}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: poolId }) });
            const json = await resp.json();
            if (!resp.ok) throw new Error(json?.error || 'drop failed');
            await fetch(`${apiBase}${ROUTES.legacy.terminalLog}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'info', message: `terminal: graph dropped ${poolId}` }) });
          } catch (e: any) {
            await fetch(`${apiBase}${ROUTES.legacy.terminalLog}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'error', message: `terminal: graph drop failed ${String(e?.message || e)}` }) });
          }
          return;
        }
        await fetch(`${apiBase}${ROUTES.legacy.terminalLog}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'warn', message: 'terminal: graph commands: drop POOL_ID' }) });
        return;
      }
      if (ns === 'bot') {
        const action = (parts[1] || '').toLowerCase();
        if (action === 'start') { await fetch(`${apiBase}/bot/start`, { method: 'POST' }); return; }
        if (action === 'stop') { await fetch(`${apiBase}/bot/stop`, { method: 'POST' }); return; }
        await fetch(`${apiBase}${ROUTES.legacy.terminalLog}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'warn', message: 'terminal: bot commands: start | stop' }) });
        return;
      }
      if (ns === 'api') {
        const action = (parts[1] || '').toLowerCase();
        if (action === 'start') { await fetch(`${apiBase}${ROUTES.legacy.apiStart}`, { method: 'POST' }); return; }
        if (action === 'stop') { await fetch(`${apiBase}${ROUTES.legacy.apiStop}`, { method: 'POST' }); return; }
        if (action === 'reset') { await fetch(`${apiBase}${ROUTES.legacy.apiReset}`, { method: 'POST' }); return; }
        await fetch(`${apiBase}${ROUTES.legacy.terminalLog}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'warn', message: 'terminal: api commands: start | stop | reset' }) });
        return;
      }
      if (ns === 'arb') {
        const action = (parts[1] || '').toLowerCase();

        const SOL = 'So11111111111111111111111111111111111111112';
        const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
        const USDT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

        const pickPoolId = async (
          dex: 'raydium'|'orca'|'meteora',
          options?: { prefer?: 'amm' | 'clmm'; inputMint?: string; outputMint?: string },
        ): Promise<string | null> => {
          const resp = await fetch(`${apiBase}/arb/pools/${dex}?sort=tvl`);
          const json = await resp.json();
          const prefer = options?.prefer;
          const clmmList: any[] = Array.isArray(json?.clmm) ? json.clmm : [];
          const ammList: any[] = Array.isArray(json?.amm) ? json.amm : [];
          const list = (() => {
            if (dex === 'raydium') {
              if (prefer === 'amm') return [...ammList, ...clmmList];
              if (prefer === 'clmm') return [...clmmList, ...ammList];
            }
            return [...clmmList, ...ammList];
          })();
          
          // If input/output mints are provided, filter by that pair; otherwise default to SOL/USDC
          const inputMint = options?.inputMint || SOL;
          const outputMint = options?.outputMint || USDC;
          
          const match = list.find((p: any) => {
            const a = String(p?.mint_a || p?.mintA || '').trim();
            const b = String(p?.mint_b || p?.mintB || '').trim();
            return (a === inputMint && b === outputMint) || (a === outputMint && b === inputMint);
          });
          return match ? String(match.id) : null;
        };

        const buildTwoHopBody = async (dex: 'raydium'|'orca'|'meteora', variant?: 'amm'|'clmm', poolId?: string) => {
          const preferVariant = dex === 'raydium' ? variant : undefined;
          const path = [USDC, USDT, USDC];
          // Pick pool for USDC -> USDT hop
          const pid = poolId || await pickPoolId(dex, preferVariant ? { prefer: preferVariant, inputMint: USDC, outputMint: USDT } : { inputMint: USDC, outputMint: USDT });
          if (!pid) throw new Error(`no USDC/USDT pool found for ${dex}`);
          const dexKey = dex === 'raydium'
            ? (variant === 'clmm' ? 'raydium-clmm' : 'raydium-amm')
            : (dex === 'orca' ? 'orca' : 'meteora');
          return {
            path,
            hopPoolIds: [pid, pid],
            dexes: [dexKey, dexKey],
            // Use token units; backend resolver converts to atoms using decimals
            size: 1,
            slippageBps: 50,
          };
        };

        const buildMultiHopBody = async (rayPool?: string, orcaPool?: string, meteoraPool?: string) => {
          const path = [USDC, USDT, USDC, USDT, USDC];
          // Pick pools for each hop with correct token pairs
          const ray = rayPool || await pickPoolId('raydium', { prefer: 'amm', inputMint: USDC, outputMint: USDT });
          const orc = orcaPool || await pickPoolId('orca', { inputMint: USDT, outputMint: USDC });
          const met = meteoraPool || await pickPoolId('meteora', { inputMint: USDC, outputMint: USDT });
          const ray2 = rayPool || await pickPoolId('raydium', { prefer: 'amm', inputMint: USDT, outputMint: USDC });
          if (!ray || !orc || !met || !ray2) throw new Error('missing one or more std pools (ray/orca/meteora)');
          return {
            path,
            hopPoolIds: [ray, orc, met, ray2],
            dexes: ['raydium-amm', 'orca', 'meteora', 'raydium-amm'],
            size: 1,
            slippageBps: 50,
          };
        };

        try {
          if (action === 'mode') {
            const raw = (parts[2] || '').toLowerCase();
            const mode = ['direct','simulate','jupiter'].includes(raw) ? raw : 'simulate';
            await fetch(`${apiBase}/exec/config`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode }) });
            if (mode === 'direct') {
              await fetch(`${apiBase}${ROUTES.legacy.terminalLog}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'info', message: 'tx.arbmode = direct' }) });
            }
            await fetch(`${apiBase}${ROUTES.legacy.terminalLog}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'info', message: `terminal: arb mode set to ${mode}` }) });
            return;
          }

          if (action === 'pools') {
            const kind = (parts[2] || '').toLowerCase();
            if (kind && kind !== 'usdc-usdt') {
              await fetch(`${apiBase}${ROUTES.legacy.terminalLog}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'warn', message: 'terminal: arb pools usdc-usdt' }) });
              return;
            }
            const [ray, orc, met] = await Promise.all([
              pickPoolId('raydium'),
              pickPoolId('orca'),
              pickPoolId('meteora'),
            ]);
            const msg = `USDC/USDT std pools → ray=${ray || '(none)'} orca=${orc || '(none)'} meteora=${met || '(none)'}`;
            await fetch(`${apiBase}${ROUTES.legacy.terminalLog}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'info', message: `terminal: ${msg}` }) });
            return;
          }

          if (['simulate','preflight','execute'].includes(action)) {
            const target = (parts[2] || '').toLowerCase();
            let endpoint = action === 'simulate' ? '/arb/simulate' : (action === 'preflight' ? '/arb/simulate-send' : '/arb/execute');
            if (action === 'execute' && target === 'orca') {
              endpoint = '/arb/execute/orca';
            }
            if (action === 'preflight' && target === 'orca') {
              endpoint = '/arb/simulate-send/orca';
            }
            
            let body: any = null;
            if (target === 'multi') {
              body = await buildMultiHopBody();
            } else if (target === 'ray' || target === 'raydium' || target === 'ray-amm' || target === 'raydium-amm' || target === 'ray-clmm' || target === 'raydium-clmm') {
              const isClmm = target.includes('clmm');
              body = await buildTwoHopBody('raydium', isClmm ? 'clmm' : 'amm');
            } else if (target === 'orca') {
              body = await buildTwoHopBody('orca', undefined);
            } else if (target === 'meteora') {
              body = await buildTwoHopBody('meteora', undefined);
            } else {
              await fetch(`${apiBase}${ROUTES.legacy.terminalLog}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'warn', message: 'terminal: arb simulate|preflight|execute ray|orca|meteora|multi' }) });
              return;
            }

            await fetch(`${apiBase}${endpoint}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
            });
            return;
          }

          // Jupiter helpers
          if (action === 'jup' || action === 'jupiter') {
            const sub = (parts[2] || '').toLowerCase(); // roundtrip
            if (sub === 'roundtrip' || sub === 'rt') {
              const sizeSol = Number(parts[3] || 0.01);
              const slippageBps = Number(parts[4] || 50);
              await fetch(`${apiBase}${ROUTES.arb.jupiterRoundtrip}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sizeSol, slippageBps }) });
              return;
            }
            await fetch(`${apiBase}${ROUTES.legacy.terminalLog}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'warn', message: 'terminal: arb jup roundtrip [SIZE_SOL] [SLIPPAGE_BPS]' }) });
            return;
          }

          // New: single-hop helpers for UI terminal
          if (action === 'singlehop') {
            const mode = (parts[2] || '').toLowerCase(); // sim|exec
            const target = (parts[3] || '').toLowerCase(); // ray-amm|ray-clmm|orca|meteora
            const sizeSol = Number(parts[4] || 0.01);
            const slippageBps = Number(parts[5] || 50);
            const poolId = parts[6];
            if (!['sim','exec'].includes(mode) || !['ray-amm','ray-clmm','orca','meteora'].includes(target)) {
              await fetch(`${apiBase}${ROUTES.legacy.terminalLog}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'warn', message: 'terminal: arb singlehop sim|exec ray-amm|ray-clmm|orca|meteora [SIZE_SOL] [SLIPPAGE_BPS] [POOL_ID]' }) });
              return;
            }
            // Pick pool if not provided
            const dexForPick = target.startsWith('ray') ? 'raydium' : (target as any);
            const preferForPick = target === 'ray-amm' ? 'amm' : (target === 'ray-clmm' ? 'clmm' : undefined);
            const pid = poolId || await pickPoolId(
              dexForPick as any,
              preferForPick ? { prefer: preferForPick } : undefined,
            );
            if (!pid) {
              await fetch(`${apiBase}${ROUTES.legacy.terminalLog}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'error', message: `terminal: no USDC/USDT pool found for ${target}` }) });
              return;
            }
            const route = ((): string => {
              if (mode === 'sim') {
                if (target === 'ray-amm') return ROUTES.arb.simulateSendRaydiumAmm;
                if (target === 'ray-clmm') return ROUTES.arb.simulateSendRaydiumClmm;
                if (target === 'orca') return ROUTES.arb.simulateSendOrca;
                return ROUTES.arb.simulateSendMeteora;
              }
              if (target === 'ray-amm') return ROUTES.arb.executeRaydiumAmm;
              if (target === 'ray-clmm') return ROUTES.arb.executeRaydiumClmm;
              if (target === 'orca') return ROUTES.arb.executeOrca;
              return ROUTES.arb.executeMeteora;
            })();
            const payload: any = { path: [SOL, USDC], poolId: pid, size: sizeSol, slippageBps };
            if (mode === 'exec') payload.forceDirect = true;
            try {
              const resp = await fetch(`${apiBase}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
              const json = await resp.json();
              if (!resp.ok) throw new Error(json?.error || 'request failed');
              const msg = mode === 'sim' ? `singlehop ${target} sim OK pool=${pid}` : `singlehop ${target} exec signature=${json?.signature || '(n/a)'} pool=${pid}`;
              await fetch(`${apiBase}${ROUTES.legacy.terminalLog}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'info', message: `terminal: ${msg}` }) });
            } catch (e: any) {
              await fetch(`${apiBase}${ROUTES.legacy.terminalLog}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'error', message: `terminal: arb singlehop failed ${String(e?.message || e)}` }) });
            }
            return;
          }

          // New: multihop helpers for UI terminal
          if (action === 'multihop') {
            const mode = (parts[2] || '').toLowerCase(); // sim|exec
            const target = (parts[3] || '').toLowerCase(); // ray-amm|ray-clmm|orca|meteora OR ray+orca, ray-amm+met, etc.
            const sizeSol = Number(parts[4] || 0.01);
            const slippageBps = Number(parts[5] || 50);
            const poolIds = parts.slice(6).filter(Boolean); // All remaining args are pool IDs
            
            // Check if target contains '+' for 2-dex multihop
            const isTwoDex = target.includes('+');
            
            if (!['sim','exec'].includes(mode)) {
              await fetch(`${apiBase}${ROUTES.legacy.terminalLog}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'warn', message: 'terminal: arb multihop sim|exec ray-amm|ray-clmm|orca|meteora|ray+orca|ray-amm+met|... [SIZE_SOL] [SLIPPAGE_BPS] [POOL_ID_1] [POOL_ID_2] ...' }) });
              return;
            }
            
            let dexKeys: string[] = [];
            let dexForPicks: string[] = [];
            let preferForPicks: (string | undefined)[] = [];
            let numHops: number;
            let path: string[] = [];
            
            if (isTwoDex) {
              // Parse 2-dex format: e.g., "ray+orca", "ray-amm+met", "ray-clmm+orca"
              const dexParts = target.split('+').map(s => s.trim().toLowerCase());
              if (dexParts.length !== 2) {
                await fetch(`${apiBase}${ROUTES.legacy.terminalLog}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'warn', message: 'terminal: arb multihop sim|exec DEX1+DEX2 [SIZE_SOL] [SLIPPAGE_BPS] [POOL_ID_1] [POOL_ID_2] (e.g., ray+orca, ray-amm+met)' }) });
                return;
              }
              
              const [dex1, dex2] = dexParts;
              
              // Validate DEX names
              const validDexes = ['ray-amm', 'ray-clmm', 'ray', 'orca', 'meteora', 'met'];
              const normalizeDex = (d: string) => {
                if (d === 'ray') return 'ray-amm'; // default ray to ray-amm
                if (d === 'met') return 'meteora';
                return d;
              };
              
              const normDex1 = normalizeDex(dex1);
              const normDex2 = normalizeDex(dex2);
              
              if (!validDexes.includes(normDex1) || !validDexes.includes(normDex2)) {
                await fetch(`${apiBase}${ROUTES.legacy.terminalLog}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'warn', message: 'terminal: invalid DEX names. Use: ray-amm, ray-clmm, ray, orca, meteora, met' }) });
                return;
              }
              
              // Map to dexKey, dexForPick, preferForPick for each DEX
              const mapDex = (d: string) => {
                const dexKey = d === 'ray-amm' ? 'raydium.amm' : (d === 'ray-clmm' ? 'raydium.clmm' : (d === 'orca' ? 'orca.clmm' : 'meteora'));
                const dexForPick = d.startsWith('ray') ? 'raydium' : (d === 'orca' ? 'orca' : 'meteora');
                const preferForPick = d === 'ray-amm' ? 'amm' : (d === 'ray-clmm' ? 'clmm' : undefined);
                return { dexKey, dexForPick, preferForPick };
              };
              
              const dex1Map = mapDex(normDex1);
              const dex2Map = mapDex(normDex2);
              
              dexKeys = [dex1Map.dexKey, dex2Map.dexKey];
              dexForPicks = [dex1Map.dexForPick, dex2Map.dexForPick];
              preferForPicks = [dex1Map.preferForPick, dex2Map.preferForPick];
              numHops = 2;
              
              // Build 2-hop path: SOL -> USDC -> USDT
              path = [SOL, USDC, USDT];
            } else {
              // Original single-DEX multihop logic
              if (!['ray-amm','ray-clmm','orca','meteora'].includes(target)) {
                await fetch(`${apiBase}${ROUTES.legacy.terminalLog}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'warn', message: 'terminal: arb multihop sim|exec ray-amm|ray-clmm|orca|meteora [SIZE_SOL] [SLIPPAGE_BPS] [POOL_ID_1] [POOL_ID_2] ...' }) });
                return;
              }
              
              // Determine DEX key for each hop
              const dexKey = target === 'ray-amm' ? 'raydium.amm' : (target === 'ray-clmm' ? 'raydium.clmm' : (target === 'orca' ? 'orca.clmm' : 'meteora'));
              const dexForPick = target.startsWith('ray') ? 'raydium' : (target as any);
              const preferForPick = target === 'ray-amm' ? 'amm' : (target === 'ray-clmm' ? 'clmm' : undefined);
              
              // Determine number of hops (default to 2-hop if no pools specified)
              numHops = Math.max(2, poolIds.length || 2);
              
              // Build path first: SOL -> USDC -> USDT -> ... (alternating for numHops)
              path = [SOL];
              for (let i = 0; i < numHops; i++) {
                path.push(i % 2 === 0 ? USDC : USDT);
              }
              
              dexKeys = Array(numHops).fill(dexKey);
              dexForPicks = Array(numHops).fill(dexForPick);
              preferForPicks = Array(numHops).fill(preferForPick);
            }
            
            // Pick pools if not all provided - now we can use the path to determine token pairs
            const pickedPoolIds: string[] = [];
            for (let i = 0; i < numHops; i++) {
              const provided = poolIds[i];
              if (provided) {
                pickedPoolIds.push(provided);
              } else {
                // Determine the token pair for this hop
                const hopInputMint = path[i];
                const hopOutputMint = path[i + 1];
                
                const pid = await pickPoolId(
                  dexForPicks[i] as any,
                  {
                    prefer: preferForPicks[i] as any,
                    inputMint: hopInputMint,
                    outputMint: hopOutputMint,
                  },
                );
                if (!pid) {
                  const dexName = isTwoDex ? `${target.split('+')[i].trim()} (hop ${i + 1})` : target;
                  await fetch(`${apiBase}${ROUTES.legacy.terminalLog}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'error', message: `terminal: no pool found for hop ${i + 1} (${dexName}) for ${hopInputMint}/${hopOutputMint}` }) });
                  return;
                }
                pickedPoolIds.push(pid);
              }
            }
            
            // Build payload
            const endpoint = mode === 'sim' ? '/arb/simulate-send' : '/arb/execute';
            const payload: any = {
              path,
              hopPoolIds: pickedPoolIds,
              dexes: dexKeys,
              size: sizeSol,
              slippageBps,
            };
            if (mode === 'exec') payload.forceDirect = true;
            
            try {
              const resp = await fetch(`${apiBase}${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
              const json = await resp.json();
              if (!resp.ok) throw new Error(json?.error || 'request failed');
              const poolStr = pickedPoolIds.join(',');
              const dexStr = isTwoDex ? target : `${target} (${numHops}hops)`;
              const msg = mode === 'sim' 
                ? `multihop ${dexStr} sim OK pools=[${poolStr}]`
                : `multihop ${dexStr} exec signature=${json?.signature || '(n/a)'} pools=[${poolStr}]`;
              await fetch(`${apiBase}${ROUTES.legacy.terminalLog}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'info', message: `terminal: ${msg}` }) });
            } catch (e: any) {
              await fetch(`${apiBase}${ROUTES.legacy.terminalLog}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'error', message: `terminal: arb multihop failed ${String(e?.message || e)}` }) });
            }
            return;
          }

          // New: multidex multihop tester (3 hops: one hop on each DEX)
          if (action === 'test') {
            const subAction = (parts[2] || '').toLowerCase();
            if (subAction === 'multidex') {
              const mode = (parts[3] || 'sim').toLowerCase(); // sim|exec
              const sizeSol = Number(parts[4] || 0.01);
              const slippageBps = Number(parts[5] || 50);

              if (!['sim', 'exec'].includes(mode)) {
                await fetch(`${apiBase}${ROUTES.legacy.terminalLog}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'warn', message: 'terminal: arb test multidex sim|exec [SIZE_SOL] [SLIPPAGE_BPS]' }) });
                return;
              }

              // 3-hop path: SOL -> USDC -> SOL -> USDC
              // Hop 1: Raydium CLMM: SOL -> USDC
              // Hop 2: Meteora: USDC -> SOL
              // Hop 3: Orca: SOL -> USDC
              const path = [SOL, USDC, SOL, USDC];
              const dexes = ['raydium.clmm', 'meteora', 'orca.clmm'];

              // Pick pools for each hop with correct token pairs
              const hopPoolIds: string[] = [];
              const poolPickPromises = [
                pickPoolId('raydium', { prefer: 'clmm', inputMint: SOL, outputMint: USDC }), // Hop 1: SOL -> USDC
                pickPoolId('meteora', { inputMint: USDC, outputMint: SOL }),                  // Hop 2: USDC -> SOL
                pickPoolId('orca', { inputMint: SOL, outputMint: USDC }),                     // Hop 3: SOL -> USDC
              ];

              try {
                const picked = await Promise.all(poolPickPromises);
                for (let i = 0; i < picked.length; i++) {
                  if (!picked[i]) {
                    await fetch(`${apiBase}${ROUTES.legacy.terminalLog}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'error', message: `terminal: no pool found for hop ${i + 1} (${dexes[i]})` }) });
                    return;
                  }
                  hopPoolIds.push(picked[i]);
                }
              } catch (e: any) {
                await fetch(`${apiBase}${ROUTES.legacy.terminalLog}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'error', message: `terminal: pool picking failed ${String(e?.message || e)}` }) });
                return;
              }

              // Build payload
              const endpoint = mode === 'sim' ? '/arb/simulate-send' : '/arb/execute';
              const payload: any = {
                path,
                hopPoolIds,
                dexes,
                size: sizeSol,
                slippageBps,
              };
              if (mode === 'exec') payload.forceDirect = true;

              try {
                await fetch(`${apiBase}${ROUTES.legacy.terminalLog}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'info', message: `terminal: running multidex test (3 hops: Ray CLMM -> Met -> Orca)...` }) });
                const resp = await fetch(`${apiBase}${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
                const json = await resp.json();
                if (!resp.ok) throw new Error(json?.error || 'request failed');
                const poolStr = hopPoolIds.join(',');
                const msg = mode === 'sim'
                  ? `multidex test OK 3hops pools=[${poolStr}]`
                  : `multidex test exec signature=${json?.signature || '(n/a)'} 3hops pools=[${poolStr}]`;
                await fetch(`${apiBase}${ROUTES.legacy.terminalLog}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'info', message: `terminal: ${msg}` }) });
              } catch (e: any) {
                await fetch(`${apiBase}${ROUTES.legacy.terminalLog}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'error', message: `terminal: arb test multidex failed ${String(e?.message || e)}` }) });
              }
              return;
            }
            // If action is 'test' but subAction is not 'multidex', show help
            await fetch(`${apiBase}${ROUTES.legacy.terminalLog}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'warn', message: 'terminal: arb test multidex sim|exec [SIZE_SOL] [SLIPPAGE_BPS]' }) });
            return;
          }
        } catch (e: any) {
          await fetch(`${apiBase}${ROUTES.legacy.terminalLog}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'error', message: `terminal: arb failed ${String(e?.message || e)}` }) });
          return;
        }

        await fetch(`${apiBase}${ROUTES.legacy.terminalLog}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'warn', message: 'terminal: arb commands: mode direct|simulate|jupiter | pools usdc-usdt | jup roundtrip [SIZE_SOL] [SLIPPAGE_BPS] | simulate|preflight|execute ray|orca|meteora|multi | singlehop sim|exec ray-amm|ray-clmm|orca|meteora [SIZE_SOL] [SLIPPAGE_BPS] [POOL_ID] | multihop sim|exec ray-amm|ray-clmm|orca|meteora|ray+orca|ray-amm+met|... [SIZE_SOL] [SLIPPAGE_BPS] [POOL_ID_1] [POOL_ID_2] ... | test multidex sim|exec [SIZE_SOL] [SLIPPAGE_BPS]' }) });
        return;
      }
      if (ns === 'swap') {
        if (parts.length >= 4) {
          const amount = Number(parts[1]);
          const from = parts[2];
          const to = parts[3];
          try {
            await fetch(`${apiBase}${ROUTES.legacy.terminalLog}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'info', message: `terminal: -> swapping ${amount} ${from} ${to}` }) });
            const resp = await fetch(`${apiBase}/swap`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ amount, from, to }) });
            const json = await resp.json();
            if (!resp.ok) throw new Error(json?.error || 'swap failed');
            await fetch(`${apiBase}${ROUTES.legacy.terminalLog}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'info', message: `terminal: swap success ${amount} ${from}->${to} sig=${json.signature}` }) });
          } catch (e: any) {
            await fetch(`${apiBase}${ROUTES.legacy.terminalLog}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'error', message: `terminal: swap failed ${String(e?.message || e)}` }) });
          }
        } else {
          await fetch(`${apiBase}${ROUTES.legacy.terminalLog}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'warn', message: 'terminal: swap AMOUNT FROM TO' }) });
        }
        return;
      }
      if (ns === 'ticktime') {
        const ms = Number(parts[1]);
        if (!isFinite(ms) || ms <= 0) {
          await fetch(`${apiBase}${ROUTES.legacy.terminalLog}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'warn', message: 'terminal: ticktime MS (e.g., ticktime 2000)' }) });
        } else {
          const resp = await fetch(`${apiBase}/ticktime`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ms }) });
          const json = await resp.json();
          if (!resp.ok) {
            await fetch(`${apiBase}${ROUTES.legacy.terminalLog}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'error', message: `terminal: ticktime failed ${json?.error || 'unknown'}` }) });
          } else {
            setSystem((prev: any) => ({ ...prev, targetTickTimeMs: json.targetTickTimeMs }));
            await fetch(`${apiBase}${ROUTES.legacy.terminalLog}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'info', message: `terminal: ticktime set to ${json.targetTickTimeMs} ms` }) });
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
            const st = await (await fetch(`${apiBase}${ROUTES.legacy.strategy}`)).json();
            setStrategies(st.strategies || []);
        const wt = await (await fetch(`${apiBase}/wallet/tokens`)).json();
        setWalletTokens(Array.isArray(wt.list) ? wt.list : (wt.walletTokens || []));
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
        await fetch(`${apiBase}${ROUTES.legacy.terminalLog}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'warn', message: 'terminal: config commands: reset' }) });
        }
        return;
      }
      if (ns === 'help') {
        const lines = [
          'Help — Commands',
          'wallet: generate | refresh | send TOKEN|MINT AMOUNT ADDRESS | addtoken TOKEN|MINT',
          'watchlist: add QUERY|MINT | remove SYMBOL|MINT | list',
          'strategies are now configured via the UI panels (no terminal commands)',
          'bot: start | stop',
          'api: start | stop | reset',
          'ticktime: MS (set target tick time in ms)',
          'swap: AMOUNT FROM TO',
          'arb: mode direct|simulate|jupiter | pools usdc-usdt | jup roundtrip [SIZE_SOL] [SLIPPAGE_BPS] | simulate|preflight|execute ray|orca|meteora|multi | singlehop sim|exec ray-amm|ray-clmm|orca|meteora [SIZE_SOL] [SLIPPAGE_BPS] [POOL_ID] | multihop sim|exec ray-amm|ray-clmm|orca|meteora|ray+orca|ray-amm+met|... [SIZE_SOL] [SLIPPAGE_BPS] [POOL_ID_1] [POOL_ID_2] ... | test multidex sim|exec [SIZE_SOL] [SLIPPAGE_BPS]',
          'config: reset | ticktime MS',
          'help — show this help'
        ];
        await Promise.all(lines.map(line => fetch(`${apiBase}${ROUTES.legacy.terminalLog}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'info', message: `terminal: ${line}` }) })));
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
      await fetch(`${apiBase}${ROUTES.legacy.terminalLog}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ level: 'warn', message: 'terminal: strategy terminal commands have been removed; use the Strategy UI panels instead' })
      });
    } else if (cmd === 'help') {
      const lines = [
        'Help: Available commands',
        "start — start the trading bot",
        "stop — stop the trading bot",
        "add QUERY|MINT — add a token to watchlist (symbol/name or mint)",
        "remove SYMBOL|MINT — remove a token from watchlist",
        "strategies are configured via the UI panels (no terminal commands)",
        "swap AMOUNT FROM TO — swap tokens immediately (e.g., swap 0.01 SOL dSOL)",
        "refreshwallet — refresh wallet balances",
        "walletaddtoken TOKEN|MINT — add token alias for wallet balances",
        "resetconfig — reset watchlist, strategies, and wallet token aliases",
        "apistart | apistop | apireset — control Jupiter API calls",
        "send TOKEN|MINT ADDRESS AMOUNT — send SOL/SPL from wallet",
        "help — show this help"
      ];
      await Promise.all(lines.map(line => fetch(`${apiBase}${ROUTES.legacy.terminalLog}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'info', message: `terminal: ${line}` }) })));
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
        await fetch(`${apiBase}${ROUTES.legacy.terminalLog}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'warn', message: 'terminal: send incomplete' }) });
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
          await fetch(`${apiBase}${ROUTES.legacy.terminalLog}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'info', message: `terminal: swap success ${amount} ${from}->${to} sig=${json.signature}` }) });
        } catch (e: any) {
          await fetch(`${apiBase}${ROUTES.legacy.terminalLog}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'error', message: `terminal: swap failed ${String(e?.message || e)}` }) });
        }
      } else {
        await fetch(`${apiBase}${ROUTES.legacy.terminalLog}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'warn', message: 'terminal: swap incomplete (usage: swap AMOUNT FROM TO)' }) });
      }
    } else if (cmd === 'refreshwallet') {
      try {
        const resp = await fetch(`${apiBase}/wallet/refresh`, { method: 'POST' });
        if (!resp.ok) throw new Error('refresh failed');
      } catch (e: any) {
        await fetch(`${apiBase}${ROUTES.legacy.terminalLog}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'error', message: `terminal: refreshwallet failed ${String(e?.message || e)}` }) });
      }
    } else if (cmd.startsWith('walletaddtoken ')) {
      const query = cmd.slice('walletaddtoken '.length).trim();
      if (!query) {
        await fetch(`${apiBase}${ROUTES.legacy.terminalLog}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'warn', message: 'walletaddtoken requires a TOKEN or MINT' }) });
      } else {
        const resp = await fetch(`${apiBase}/wallet/tokens`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query }) });
        const json = await resp.json();
        if (!resp.ok) {
          await fetch(`${apiBase}${ROUTES.legacy.terminalLog}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'error', message: `terminal: walletaddtoken failed: ${json?.error || 'unknown'}` }) });
        } else {
          setWalletTokens(Array.isArray(json.list) ? json.list : (json.walletTokens || []));
          await fetch(`${apiBase}${ROUTES.legacy.terminalLog}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'info', message: `terminal: walletaddtoken added ${json.added?.symbol || json.added?.id}` }) });
        }
      }
    } else if (cmd === 'apistop') {
      await fetch(`${apiBase}${ROUTES.legacy.apiStop}`, { method: 'POST' });
    } else if (cmd === 'apistart') {
      await fetch(`${apiBase}${ROUTES.legacy.apiStart}`, { method: 'POST' });
    } else if (cmd === 'apireset') {
      await fetch(`${apiBase}${ROUTES.legacy.apiReset}`, { method: 'POST' });
    } else if (cmd.startsWith('set ')) {
      await fetch(`${apiBase}${ROUTES.legacy.terminalLog}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ level: 'warn', message: 'terminal: strategy terminal commands have been removed; use the Strategy UI panels instead' })
      });
    } else if (cmd.startsWith('removestrategy')) {
      await fetch(`${apiBase}${ROUTES.legacy.terminalLog}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ level: 'warn', message: 'terminal: strategy terminal commands have been removed; use the Strategy UI panels instead' })
      });
    } else if (cmd === 'resetconfig') {
      try {
        const resp = await fetch(`${apiBase}/config/reset`, { method: 'POST' });
        if (!resp.ok) throw new Error('reset failed');
        const wl = await (await fetch(`${apiBase}/watchlist`)).json();
        setWatchlist(wl.watchlist || []);
        const st = await (await fetch(`${apiBase}/strategy`)).json();
        setStrategies(st.strategies || []);
        const wt = await (await fetch(`${apiBase}/wallet/tokens`)).json();
        setWalletTokens(Array.isArray(wt.list) ? wt.list : (wt.walletTokens || []));
      await fetch(`${apiBase}${ROUTES.legacy.terminalLog}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'info', message: 'terminal: resetconfig executed' }) });
      } catch (e: any) {
      await fetch(`${apiBase}${ROUTES.legacy.terminalLog}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'error', message: `resetconfig failed: ${String(e?.message || e)}` }) });
      }
    } else {
      await fetch(`${apiBase}${ROUTES.legacy.terminalLog}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'warn', message: `terminal: unknown or incomplete command: ${cmd}` }) });
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
              {/* Replaced Pause/Resume with Start Arb handled in ArbitrageMetrics */}
              <button
                onClick={async () => {
                  if (!confirm('Shutdown all services? This will stop the backend and related processes.')) return;
                  try {
                    await fetch(`${apiBase}${ROUTES.system.shutdown}`, { method: 'POST' });
                  } catch {}
                }}
                className="px-4 py-2 rounded text-sm font-medium bg-gray-700 hover:bg-gray-800 text-white"
                title="Shutdown all services"
              >
                Shutdown
              </button>
              
            </div>
          </div>
          {(() => {
            const rlActive = !!system.rateLimitActive;
            const cooldown = !!system.cooldownUntilMs;
            const apiColor = rlActive ? (cooldown ? 'text-yellow-400' : 'text-red-400') : 'text-green-400';
            const apiText = rlActive ? (cooldown ? 'THROTTLED' : 'PAUSED') : 'ON';
            return <div className="text-base text-gray-300">API Status: <span className={`font-semibold ${apiColor}`}>{apiText}</span></div>;
          })()}
          {(() => {
            const now = Date.now();
            const stale = (now - (lastSystemRef.current || 0) > 5000);
            const got429 = !!system.last429AtMs && (now - system.last429AtMs < 60000);
            const showThrottled = got429 && !!system.rateLimitActive;
            const statusText = stale ? 'offline' : (showThrottled ? 'throttled' : 'running');
            const color = stale ? 'text-red-400' : (showThrottled ? 'text-yellow-400' : 'text-green-400');
            return <div className={`text-base ${color}`}>Backend: {statusText}</div>;
          })()}
          <div className="text-base text-gray-300">Uptime: {typeof system.uptimeMs === 'number' ? Math.floor(system.uptimeMs/1000) + 's' : '-'}</div>
          <div className="text-base text-gray-300">Last Price Update: {system.lastPriceUpdateMs ? `${new Date(system.lastPriceUpdateMs).toLocaleTimeString()} (${(() => { const d = Date.now() - system.lastPriceUpdateMs; return Math.floor(d/1000) + 's ago'; })()})` : '-'}</div>
          <div className="flex items-center justify-between">
            <div className="text-base text-gray-300">RPC: {system.rpcUrl ? maskRpcUrl(system.rpcUrl) : '-'}</div>
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
          <WatchlistSection
            watchlist={watchlist}
            prices={prices}
            strategies={strategies}
            activitiesByStrategy={activitiesByStrategy}
            onAdd={()=>setShowAddToken(true)}
            onRemove={handleRemoveToken}
            onFetchVerified={async ()=>{
              try { await fetch('/api/watchlist/fetch-verified', { method: 'POST' }); } catch {}
            }}
            onBootstrapPools={async ()=>{
              try { await fetch('/api/watchlist/bootstrap-pools', { method: 'POST' }); } catch {}
            }}
          />
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
        <section className="bg-gray-900 rounded p-4">
          <h2 className="text-2xl font-semibold mb-3">Terminal</h2>
          <form onSubmit={(e) => { e.preventDefault(); handleTerminal(terminalInput.trim()); setTerminalInput(''); }}>
            <input value={terminalInput} onChange={(e) => setTerminalInput(e.target.value)} className="w-full bg-gray-800 rounded px-3 py-2 outline-none text-base" placeholder="Type command or type 'help'...." />
          </form>
        </section>
        <CollapsibleSection
          title={"Arbitrage"}
          storageKey="panel:arbitrage"
          rightActions={(
            <>
              <button onClick={()=>setShowDataFetchConfig(true)} className="px-3 py-1 bg-blue-600 text-white rounded text-sm hover:bg-blue-700">Fetchers & Normalizers</button>
              <button onClick={()=>setShowEngineConfig(true)} className="px-3 py-1 bg-indigo-600 text-white rounded text-sm hover:bg-indigo-700">Arb Engine</button>
              <button onClick={()=>setShowOpportunityConfig(true)} className="px-3 py-1 bg-fuchsia-600 text-white rounded text-sm hover:bg-fuchsia-700">Opportunity Config</button>
              <button onClick={()=>setShowGraphConfig(true)} className="px-3 py-1 bg-teal-600 text-white rounded text-sm hover:bg-teal-700">Graph Config</button>
              <button onClick={()=>setShowAltModal(true)} className="px-3 py-1 bg-purple-600 text-white rounded text-sm hover:bg-purple-700">Manage ALTs</button>
              <button onClick={()=>setShowModalConfigManager(!showModalConfigManager)} className="px-3 py-1 bg-yellow-600 text-white rounded text-sm hover:bg-yellow-700">UI Prefs</button>
            </>
          )}
        >
          <ArbitrageSection apiBase={apiBase} showGraph={showGraph} onToggleGraph={()=>setShowGraph(v=>!v)} paused={showArbConfig || showSystemConfig || showFeeConfig} />
          
          {/* UI Preferences Export/Import Panel */}
          {showModalConfigManager && (
            <div className="mt-3 p-4 bg-gray-800 border border-yellow-600 rounded">
              <h3 className="text-lg font-semibold text-yellow-400 mb-3">UI Preferences Manager</h3>
              <p className="text-sm text-gray-300 mb-3">
                Export, import, or reset your modal UI preferences (expanded sections, filter settings, etc.)
              </p>
              <div className="flex flex-wrap gap-2">
                <button 
                  onClick={downloadModalConfigs} 
                  className="px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700 text-sm"
                >
                  📥 Export UI Preferences
                </button>
                <label className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 cursor-pointer text-sm">
                  📤 Import UI Preferences
                  <input 
                    type="file" 
                    accept=".json" 
                    onChange={handleImportModalConfigs} 
                    className="hidden" 
                  />
                </label>
                <button 
                  onClick={handleClearModalConfigs} 
                  className="px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700 text-sm"
                >
                  🗑️ Reset All UI Preferences
                </button>
              </div>
            </div>
          )}
        </CollapsibleSection>
        <ConfigsSection
          apiBase={apiBase}
          showGraphConfig={showGraphConfig}
          onCloseGraph={() => setShowGraphConfig(false)}
          showFeeConfig={showFeeConfig}
          onSaveFee={async (config) => {
            const res = await fetch(`${apiBase}/fees/config`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fees: config }) });
            if (res.ok) setShowFeeConfig(false);
          }}
          onCloseFee={() => setShowFeeConfig(false)}
          showSystemConfig={showSystemConfig}
          onSaveSystem={handleSystemConfigSave}
          onCloseSystem={() => setShowSystemConfig(false)}
          showDataFetchConfig={showDataFetchConfig}
          onCloseDataFetch={() => setShowDataFetchConfig(false)}
          showEngineConfig={showEngineConfig}
          onCloseEngine={() => setShowEngineConfig(false)}
          showOpportunityConfig={showOpportunityConfig}
          onCloseOpportunity={() => setShowOpportunityConfig(false)}
          showLiqRunnerConfig={showLiqRunnerConfig}
          onCloseLiqRunner={() => setShowLiqRunnerConfig(false)}
          showTriggerRunnerConfig={showTriggerRunnerConfig}
          onCloseTriggerRunner={() => setShowTriggerRunnerConfig(false)}
          showFillerRunnerConfig={showFillerRunnerConfig}
          onCloseFillerRunner={() => setShowFillerRunnerConfig(false)}
        />
        <CollapsibleSection title={"Drift"} storageKey="panel:drift">
          <DriftSection
            apiBase={apiBase}
            driftSubaccounts={driftSubaccounts}
            driftSelectedSubId={driftSelectedSubId}
            driftNewSubName={driftNewSubName}
            driftRenameSubName={driftRenameSubName}
            driftOpBusy={driftOpBusy}
            setDriftSelectedSubId={(id)=>setDriftSelectedSubId(id)}
            setDriftNewSubName={(s)=>setDriftNewSubName(s)}
            setDriftRenameSubName={(s)=>setDriftRenameSubName(s)}
            setDriftOpBusy={(v)=>setDriftOpBusy(v)}
            setDriftSubaccounts={(list)=>setDriftSubaccounts(list)}
            ls={liqStatus?.liquidators || []}
            onOpenLiqRunner={() => setShowLiqRunnerConfig(true)}
            onOpenTriggerRunner={() => setShowTriggerRunnerConfig(true)}
            onOpenFillerRunner={() => setShowFillerRunnerConfig(true)}
            onOpenExecConfig={() => setShowExecConfig(true)}
          />
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
                    {isGrid && s?.gridType === 'drift' && <span className="ml-2 px-2 py-1 bg-purple-600 text-white text-xs rounded">LEVERED GRID</span>}
                    {isGrid && (!s?.gridType || s?.gridType !== 'drift') && <span className="ml-2 px-2 py-1 bg-blue-600 text-white text-xs rounded">GRID</span>}
                  </div>
                  {s?.gridType === 'drift' && (
                    <div className="text-xs text-gray-400">
                      {(() => {
                        const cur = (a as any)?.currentPairPrice ?? (a as any)?.current;
                        const mid = (a as any)?.mid;
                        const spr = (a as any)?.spread;
                        const src = (typeof (a as any)?.oracle === 'number') ? 'oracle' : (typeof mid === 'number' ? 'mid' : 'n/a');
                        const sprStr = typeof spr === 'number' ? spr.toFixed(6) : '-';
                        const curStr = typeof cur === 'number' ? cur.toFixed(6) : '-';
                        const midStr = typeof mid === 'number' ? mid.toFixed(6) : '-';
                        const feeBps = (a as any)?.feeBps;
                        const feeEst = (a as any)?.feeEstRoundTrip;
                        const fApy = (a as any)?.fundingApy;
                        const uPnl = (a as any)?.unrealizedPnl;
                        const uFund = (a as any)?.unrealizedFunding;
                        const net = (a as any)?.netApprox;
                        const feeStr = typeof feeEst === 'number' ? `${feeEst.toFixed(4)} (${feeBps ?? 0}bps)` : '-';
                        const apyStr = typeof fApy === 'number' ? `${(fApy*100).toFixed(2)}%` : '-';
                        const uStr = typeof uPnl === 'number' ? uPnl.toFixed(4) : '-';
                        const ufStr = typeof uFund === 'number' ? uFund.toFixed(4) : '-';
                        const netStr = typeof net === 'number' ? net.toFixed(4) : '-';
                        return `Price (${src}): ${curStr} — Mid: ${midStr} — Spread: ${sprStr} | Fees: ${feeStr} | Funding APY: ${apyStr} | U-PnL: ${uStr} | U-Funding: ${ufStr} | Net≈: ${netStr}`;
                      })()}
                    </div>
                  )}
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
                const to = (() => {
                  if (s?.gridType === 'drift') {
                    const name = s?.name || 'default';
                    const a = activitiesByStrategy[name] as any;
                    const mSym = a?.marketSymbol;
                    if (mSym) return mSym;
                    return s.toToken || s.token || 'PERP';
                  }
                  return s.toToken || s.token || 'SOL';
                })();
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
                // For levered grid (Drift), prefer mid/current from activity; fallback to oracle; else Jupiter-derived pair
                const activityForStrategy = activitiesByStrategy[s.name || 'default'] as any;
                const currentMid = typeof activityForStrategy?.current === 'number' ? activityForStrategy.current : null;
                const oracleOrCurrent = typeof activityForStrategy?.currentPairPrice === 'number' ? activityForStrategy.currentPairPrice : null;
                const pair = (s?.gridType === 'drift' && (typeof currentMid === 'number' || typeof oracleOrCurrent === 'number'))
                  ? (typeof currentMid === 'number' ? currentMid : oracleOrCurrent)
                  : ((usdFrom && usdTo) ? (usdTo / usdFrom) : null);
                const buyPct = s.buyPct ?? 0.05;
                const sellPct = s.sellPct ?? 0.05;
                const isActive = s.active !== false;
                const statusColor = isActive ? 'text-green-400' : 'text-red-400';
                const stratActivity = activitiesByStrategy[s.name || 'default'] || { status: 'idle', trades: [] };
                const anchor = (s?.gridType === 'drift') ? (typeof (stratActivity as any)?.currentPairPrice === 'number' ? (stratActivity as any).currentPairPrice : pair) : ((stratActivity as any)?.anchor ?? pair);
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
                          {isGrid && s?.gridType === 'drift' && <span className="ml-2 px-2 py-1 bg-purple-600 text-white text-xs rounded">LEVERED GRID</span>}
                          {isGrid && (!s?.gridType || s?.gridType !== 'drift') && <span className="ml-2 px-2 py-1 bg-blue-600 text-white text-xs rounded">GRID</span>}
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
                          
                          {isGrid && (!s?.gridType || s?.gridType !== 'drift') && (
                            <button 
                              className="text-sm bg-blue-600 px-3 py-1.5 rounded hover:bg-blue-700"
                              onClick={() => toggleGridStrategyMonitor(s.name)}
                            >
                              {selectedGridStrategies.has(s.name) ? 'Hide Monitor' : 'Show Monitor'}
                            </button>
                          )}
                          
                          {isGrid && s?.gridType === 'drift' && (
                            <>
                              <button 
                                className="text-sm bg-purple-600 px-3 py-1.5 rounded hover:bg-purple-700"
                                onClick={() => { setEditingLevGrid(s); setShowLevGridConfig(true); }}
                              >
                                Edit
                              </button>
                              <button 
                                className="ml-2 text-sm bg-blue-600 px-3 py-1.5 rounded hover:bg-blue-700"
                                onClick={() => toggleGridStrategyMonitor(s.name)}
                              >
                                {selectedGridStrategies.has(s.name) ? 'Hide Monitor' : 'Show Monitor'}
                              </button>
                            </>
                          )}
                          {isGrid && (!s?.gridType || s?.gridType !== 'drift') && (
                            <button 
                              className="text-sm bg-green-600 px-3 py-1.5 rounded hover:bg-green-700"
                              onClick={() => handleEditGridStrategy(s)}
                            >
                              Edit
                            </button>
                          )}
                          
                          <button 
                            className="text-sm bg-red-600 px-3 py-1.5 rounded hover:bg-red-700"
                            onClick={() => handleRemoveStrategy(s)}
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
                            {anchor && (<><div>anchor</div><div className="text-gray-300">{`${anchor.toFixed(6)} ${s?.gridType === 'drift' ? (activitiesByStrategy[s.name || 'default'] as any)?.marketSymbol || to : `${from}->${to}`}`}</div></>)}
                            {buyTrigger && (<><div>buyTrigger</div><div className="text-gray-300">{`${buyTrigger.toFixed(6)} ${s?.gridType === 'drift' ? (activitiesByStrategy[s.name || 'default'] as any)?.marketSymbol || to : `${from}->${to}`}`}</div></>)}
                            {sellTrigger && (<><div>sellTrigger</div><div className="text-gray-300">{`${sellTrigger.toFixed(6)} ${s?.gridType === 'drift' ? (activitiesByStrategy[s.name || 'default'] as any)?.marketSymbol || to : `${from}->${to}`}`}</div></>)}
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
                              isDrift={s?.gridType === 'drift'}
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
      <Suspense fallback={<div className="space-y-4"><div className="text-sm text-gray-400">Loading logs...</div></div>}>
        <LogsColumn />
      </Suspense>
      
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
        <LeveragedGridConfig 
          onClose={() => { setShowLevGridConfig(false); setEditingLevGrid(null); }} 
          initialConfig={editingLevGrid}
          onSaved={async () => {
            try {
              const base = await (await fetch(`${apiBase}/strategy`)).json();
              const baseList = base?.strategies || [];
        const resp = await fetch(`${apiBase}${ROUTES.strategies.leveragedGrid.status}`);
              const lg = await resp.json();
              const mapped = Array.isArray(lg?.strategies) ? (lg.strategies as any[]).map((s: any, i: number) => {
                const cfg = (s?.status?.config || {}) as any;
                const market = cfg?.market || {};
                const idx = Number(market?.marketIndex ?? i);
                const driftMarketSym = (() => {
                  try {
                    const list = (driftStatus?.markets || []) as Array<{ marketIndex: number; symbol?: string }>;
                    const hit = list.find(m => Number(m.marketIndex) === idx);
                    return hit?.symbol;
                  } catch {}
                  return undefined;
                })();
                const toSym = driftMarketSym || market?.symbol || `PERP-${idx ?? '?'}`;
                return {
                  name: cfg?.name || `lev-grid-${idx}`,
                  type: 'drift-grid',
                  fromToken: 'USDC',
                  toToken: toSym,
                  gridType: 'drift',
                  gridLevels: [],
                  active: !!(s?.status?.running),
                } as any;
              }) : [];
              setStrategies([...(baseList || []), ...mapped]);
            } catch {}
          }}
        />
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
                body: JSON.stringify({ fees: config })
              });
              
              if (response.ok) {
                setShowFeeConfig(false);
                // Refresh system config so UI reflects latest fees
                try {
                  const sys = await fetch(`${apiBase}${ROUTES.system.base}`).then(r => r.json());
                  setSystem(sys);
                } catch {}
                await fetch(`${apiBase}${ROUTES.legacy.terminalLog}`, {
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
      {showExecConfig && (
        <ExecutionConfigModal apiBase={apiBase} onClose={() => setShowExecConfig(false)} onSaved={async () => {
          try {
            const sys = await fetch(`${apiBase}${ROUTES.system.base}`).then(r => r.json());
            setSystem(sys);
          } catch {}
        }} />
      )}
      {showAltModal && (
        <AltManagementModal onClose={() => setShowAltModal(false)} apiBase={apiBase} />
      )}
    </div>
  );
}


