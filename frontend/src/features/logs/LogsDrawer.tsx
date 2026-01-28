import React, { useEffect, useMemo, useState, useRef } from 'react';
import { useLogs } from '../../app/contexts/logs';
import { LOG_WINDOWS, WINDOW_ORDER, LogWindowConfig, WindowId, LogEvent, getStorageKey } from '../../utils/logs';

type LogsDrawerProps = {
  className?: string;
};

const configById: Record<WindowId, LogWindowConfig> = (() => {
  const map = Object.create(null) as Record<WindowId, LogWindowConfig>;
  for (const cfg of LOG_WINDOWS) {
    map[cfg.id] = cfg;
  }
  return map;
})();

const LogRow: React.FC<{ l: LogEvent }> = React.memo(({ l }) => {
  const colorByCat: Record<string, string> = {
    // API & External
    api: 'text-blue-300', jupiter: 'text-blue-300', http: 'text-blue-200', shyft: 'text-blue-200',
    // DEXs
    raydium: 'text-emerald-300', orca: 'text-amber-300', meteora: 'text-teal-300', pumpswap: 'text-violet-300',
    // Arbitrage & Execution
    arb: 'text-indigo-300', opportunity: 'text-indigo-200', sizing: 'text-indigo-200',
    execution: 'text-orange-300', cache: 'text-orange-200', marginfi: 'text-orange-200',
    // Trading
    strategy: 'text-green-300', pretrade: 'text-purple-300', trade: 'text-cyan-300', tx: 'text-cyan-200', jito: 'text-cyan-200',
    // Infrastructure
    terminal: 'text-gray-300', graph: 'text-pink-300', pools: 'text-teal-300', grpc: 'text-teal-200',
    price: 'text-orange-300', router: 'text-emerald-200', tokens: 'text-lime-200',
    // User & Wallet
    wallet: 'text-lime-300', auth: 'text-fuchsia-300',
    // System
    server: 'text-slate-300', system: 'text-zinc-300', other: 'text-gray-300', rpc: 'text-zinc-200',
    // Protocols
    rust: 'text-red-300', drift: 'text-rose-300', ws: 'text-rose-200'
  };
  const cat = (l as any).cat as string | undefined;
  const color = l.level === 'error' ? 'text-red-400' : l.level === 'warn' ? 'text-yellow-400' : (cat ? (colorByCat as any)[cat] : null) || 'text-gray-300';
  const ctx = l.context as Record<string, unknown> | undefined;
  const reserved = new Set(['cat', 'subcat', 'code', 'cid', 'span']);
  const ctxParts: string[] = [];
  if (ctx && typeof ctx === 'object') {
    for (const [k, v] of Object.entries(ctx)) {
      if (reserved.has(k)) continue;
      if (v === undefined || v === null) continue;
      let vs: string;
      if (typeof v === 'number' || typeof v === 'boolean') {
        vs = String(v);
      } else if (typeof v === 'string') {
        vs = v;
      } else if (Array.isArray(v)) {
        vs = `[${v.length}]`;
      } else {
        try { vs = JSON.stringify(v); } catch { vs = '[obj]'; }
      }
      if (vs.length > 120) vs = vs.slice(0, 117) + '...';
      ctxParts.push(`${k}=${vs}`);
    }
  }
  return (
    <li className={`text-sm ${color}`}>
      <span className="text-gray-500">[{l.timestamp}]</span> <span className="uppercase text-gray-400">{l.level}</span> {cat ? <span className={`uppercase ${color}`}>[{cat}]</span> : null} {(l as any).code ? <span className="text-blue-300">[{(l as any).code}]</span> : null} {(l as any).cid ? <span className="text-gray-400">(cid={(l as any).cid})</span> : null} {l.message} {ctxParts.length ? <span className="text-gray-400">{ctxParts.map((p, idx) => (<span key={idx}>({p}) </span>))}</span> : null}
    </li>
  );
});

const LogsDrawerComponent: React.FC<LogsDrawerProps> = ({ className = '' }) => {
  const { logsByWindow, setLogsByWindow } = useLogs();
  const [activeTab, setActiveTab] = useState<WindowId>('system');
  const [isExpanded, setIsExpanded] = useState<boolean>(true);
  const [paused, setPaused] = useState<boolean>(false);
  const [autoscroll, setAutoscroll] = useState<boolean>(true);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const atBottom = useRef<boolean>(true);

  // Load saved state
  useEffect(() => {
    try {
      const saved = localStorage.getItem('logs-drawer:active-tab');
      if (saved && WINDOW_ORDER.includes(saved as WindowId)) {
        setActiveTab(saved as WindowId);
      }
      const expanded = localStorage.getItem('logs-drawer:expanded');
      if (expanded === '0') setIsExpanded(false);
    } catch {}
  }, []);

  // Save active tab
  useEffect(() => {
    try { localStorage.setItem('logs-drawer:active-tab', activeTab); } catch {}
  }, [activeTab]);

  // Save expanded state
  useEffect(() => {
    try { localStorage.setItem('logs-drawer:expanded', isExpanded ? '1' : '0'); } catch {}
  }, [isExpanded]);

  // Handle clear events
  useEffect(() => {
    const onClear = (e: Event) => {
      const detail = (e as CustomEvent<{ id?: string }>).detail;
      const id = detail?.id as WindowId | undefined;
      if (!id) return;
      setLogsByWindow((prev) => ({ ...prev, [id]: [] }));
    };
    window.addEventListener('logwin:clear' as any, onClear as EventListener);
    return () => {
      window.removeEventListener('logwin:clear' as any, onClear as EventListener);
    };
  }, [setLogsByWindow]);

  // Scroll handling
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onScroll = () => {
      try {
        const nearBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 8;
        atBottom.current = nearBottom;
      } catch {}
    };
    el.addEventListener('scroll', onScroll);
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  // Auto-scroll on new logs
  const activeLogs = logsByWindow[activeTab] || [];
  useEffect(() => {
    if (paused) return;
    if (autoscroll && atBottom.current) {
      try { const el = containerRef.current; if (el) el.scrollTop = el.scrollHeight; } catch {}
    }
  }, [activeLogs, paused, autoscroll]);

  const clear = () => {
    const evt = new CustomEvent('logwin:clear', { detail: { id: activeTab } });
    try { window.dispatchEvent(evt); } catch {}
  };

  // Calculate unread counts per tab
  const unreadCounts = useMemo(() => {
    const counts: Record<WindowId, number> = {} as any;
    for (const id of WINDOW_ORDER) {
      counts[id] = 0; // Could track unread here if needed
    }
    return counts;
  }, []);

  // Get log count for badge
  const getLogCount = (id: WindowId) => {
    const logs = logsByWindow[id] || [];
    return logs.length;
  };

  // Tab color based on window type
  const getTabColor = (id: WindowId, isActive: boolean) => {
    const colors: Record<WindowId, string> = {
      user: 'text-lime-400',
      trade: 'text-cyan-400',
      arbitrage: 'text-indigo-400',
      execution: 'text-orange-400',
      graph: 'text-pink-400',
      pools: 'text-teal-400',
      rust: 'text-red-400',
      drift: 'text-rose-400',
      strategy: 'text-green-400',
      router: 'text-emerald-400',
      api: 'text-blue-400',
      system: 'text-zinc-400',
    };
    if (isActive) return colors[id] || 'text-white';
    return 'text-gray-500 hover:text-gray-300';
  };

  return (
    <div className={`bg-gray-900 border-t border-gray-700 ${className}`}>
      {/* Tab bar */}
      <div className="flex items-center gap-1 px-2 py-1 bg-gray-800/50 border-b border-gray-700">
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="px-2 py-1 text-gray-400 hover:text-white text-sm"
          title={isExpanded ? 'Collapse logs' : 'Expand logs'}
        >
          {isExpanded ? '▼' : '▲'} Logs
        </button>
        
        <div className="flex-1 flex items-center gap-1 overflow-x-auto">
          {WINDOW_ORDER.map((id) => {
            const cfg = configById[id];
            const isActive = activeTab === id;
            const count = getLogCount(id);
            return (
              <button
                key={id}
                onClick={() => { setActiveTab(id); if (!isExpanded) setIsExpanded(true); }}
                className={`px-3 py-1.5 text-xs font-medium rounded-t transition-colors whitespace-nowrap ${
                  isActive 
                    ? `${getTabColor(id, true)} bg-gray-900 border-t border-l border-r border-gray-600` 
                    : `${getTabColor(id, false)} hover:bg-gray-700/50`
                }`}
              >
                {cfg?.title || id}
                {count > 0 && (
                  <span className={`ml-1.5 px-1.5 py-0.5 text-[10px] rounded-full ${
                    isActive ? 'bg-gray-700 text-gray-300' : 'bg-gray-700/50 text-gray-500'
                  }`}>
                    {count > 99 ? '99+' : count}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Controls */}
        <div className="flex items-center gap-2 ml-2">
          <label className="text-xs flex items-center gap-1 text-gray-400">
            <input 
              type="checkbox" 
              checked={paused} 
              onChange={(e) => setPaused(e.target.checked)}
              className="w-3 h-3"
            />
            Pause
          </label>
          <label className="text-xs flex items-center gap-1 text-gray-400">
            <input 
              type="checkbox" 
              checked={autoscroll} 
              onChange={(e) => setAutoscroll(e.target.checked)}
              className="w-3 h-3"
            />
            Auto
          </label>
          <button 
            className="text-xs px-2 py-1 rounded bg-gray-700 hover:bg-gray-600 text-gray-300"
            onClick={clear}
          >
            Clear
          </button>
        </div>
      </div>

      {/* Log content */}
      {isExpanded && (
        <div 
          ref={containerRef}
          className="h-[25vh] overflow-auto px-3 py-2"
        >
          <ul className="space-y-0.5 font-mono text-xs">
            {activeLogs.map((l, i) => (
              <LogRow key={(l as any).__k ?? i} l={l} />
            ))}
            {activeLogs.length === 0 && (
              <li className="text-sm text-gray-500 py-4 text-center">
                No logs in {configById[activeTab]?.title || activeTab}
              </li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
};

export const LogsDrawer = React.memo(LogsDrawerComponent);

export default LogsDrawer;
