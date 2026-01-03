import React, { useEffect, useState, useCallback, useRef } from 'react';
import { ROUTES } from '../utils/routes';

type ExecutorStatus = {
  running: boolean;
  config: {
    enabled: boolean;
    minProfitBps: number;
    maxConcurrentExecutions: number;
    sizeUsd?: number;
    slippageBps?: number;
    maxHops?: number;
    cooldownMs: number;
    maxExecutionsPerMinute?: number;
    // Dynamic sizing
    dynamicSizing?: {
      enabled: boolean;
      minSizeUsd: number;
      maxSizeUsd: number;
      method: string;
    };
    // Flashloan
    flashloanSettings?: {
      enabled: boolean;
      preferredToken?: string;
    };
    // Router
    useRouter?: boolean;
  };
  state?: {
    inFlight: number;
    totalExecutions: number;
    successfulExecutions: number;
    failedExecutions: number;
    successRate: string;
    executionsThisMinute: number;
  };
  error?: string;
};

type JitoConfig = {
  enabled: boolean;
  tipMode?: string;
  tipShare?: number;
};

type ExecutorControlProps = {
  apiBase: string;
  socket?: any;
};

export const ExecutorControl: React.FC<ExecutorControlProps> = ({ apiBase, socket }) => {
  const [status, setStatus] = useState<ExecutorStatus | null>(null);
  const [jitoConfig, setJitoConfig] = useState<JitoConfig | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [saving, setSaving] = useState(false);
  
  // Editable fields
  const [editMinProfit, setEditMinProfit] = useState<number | null>(null);
  const [editSlippage, setEditSlippage] = useState<number | null>(null);
  const [editSizeUsd, setEditSizeUsd] = useState<number | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const response = await fetch(`${apiBase}/arb/executor/status`);
      const data = await response.json();
      setStatus(data);
      setError(null);
    } catch (e: any) {
      setError(e.message);
    }
  }, [apiBase]);

  const fetchJitoConfig = useCallback(async () => {
    try {
      const response = await fetch(`${apiBase}/arb/jito/config`);
      if (response.ok) {
        const data = await response.json();
        setJitoConfig(data);
      }
    } catch {}
  }, [apiBase]);

  // Store latest fetch functions in refs to avoid dependency issues
  const fetchStatusRef = useRef(fetchStatus);
  const fetchJitoConfigRef = useRef(fetchJitoConfig);
  useEffect(() => {
    fetchStatusRef.current = fetchStatus;
    fetchJitoConfigRef.current = fetchJitoConfig;
  }, [fetchStatus, fetchJitoConfig]);

  const updateConfig = useCallback(async (updates: Record<string, any>) => {
    setSaving(true);
    try {
      const response = await fetch(`${apiBase}/arb/executor/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });
      if (!response.ok) throw new Error('Failed to update config');
      await fetchStatusRef.current();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }, [apiBase]);

  useEffect(() => {
    fetchStatus();
    fetchJitoConfig();
    // Reduced polling frequency - socket events provide real-time updates
    // Fallback poll every 30s for status (socket events handle most updates)
    const interval = setInterval(() => {
      fetchStatusRef.current();
    }, 30000);
    // Jito config polling at 60s interval (rarely changes)
    const jitoInterval = setInterval(() => {
      fetchJitoConfigRef.current();
    }, 60000);
    return () => {
      clearInterval(interval);
      clearInterval(jitoInterval);
    };
  }, [fetchStatus, fetchJitoConfig]); // Only re-run if fetch functions change

  // Reset edit values when status changes
  useEffect(() => {
    if (status?.config) {
      setEditMinProfit(status.config.minProfitBps);
      setEditSlippage(status.config.slippageBps ?? 50);
      setEditSizeUsd(status.config.sizeUsd ?? 100);
    }
  }, [status?.config?.minProfitBps, status?.config?.slippageBps, status?.config?.sizeUsd]);

  // Listen for execution events via socket
  useEffect(() => {
    if (!socket) return;
    
    let lastFetchTime = 0;
    const MIN_FETCH_INTERVAL = 2000; // Throttle: max once per 2 seconds
    
    const onExecution = () => {
      const now = Date.now();
      if (now - lastFetchTime < MIN_FETCH_INTERVAL) return;
      lastFetchTime = now;
      fetchStatusRef.current(); // Refresh status on execution
    };
    
    socket.on('arb:execution', onExecution);
    socket.on('arb:execution:failed', onExecution);
    
    return () => {
      socket.off('arb:execution', onExecution);
      socket.off('arb:execution:failed', onExecution);
    };
  }, [socket]);

  const handleStart = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`${apiBase}/arb/executor/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: true,
          minProfitBps: status?.config?.minProfitBps || 50,
          maxConcurrentExecutions: status?.config?.maxConcurrentExecutions || 1,
          sizeUsd: status?.config?.sizeUsd || 1,
          slippageBps: status?.config?.slippageBps || 50,
          cooldownMs: status?.config?.cooldownMs || 5000,
        }),
      });
      
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to start executor');
      }
      
      await fetchStatus();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const handleStop = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`${apiBase}/arb/executor/stop`, {
        method: 'POST',
      });
      
      if (!response.ok) {
        throw new Error('Failed to stop executor');
      }
      
      await fetchStatus();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const handleToggleEnabled = async () => {
    if (!status?.running) {
      await handleStart();
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const newEnabled = !status.config.enabled;
      const response = await fetch(`${apiBase}/arb/executor/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: newEnabled }),
      });
      
      if (!response.ok) {
        throw new Error('Failed to update config');
      }
      
      await fetchStatus();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const isRunning = status?.running && status?.config?.enabled;

  return (
    <div className="p-3 border rounded bg-gradient-to-br from-purple-900/20 to-blue-900/20 mb-3">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-3">
          <h4 className="font-semibold">Auto-Executor</h4>
          <div className="flex items-center gap-2">
            <div className={`w-2 h-2 rounded-full ${isRunning ? 'bg-green-400 animate-pulse' : 'bg-gray-400'}`} />
            <span className="text-xs opacity-70">
              {!status?.running ? 'Not Running' : status.config.enabled ? 'Active' : 'Paused'}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setExpanded(!expanded)}
            className="px-2 py-1 text-xs border rounded hover:bg-white/10"
          >
            {expanded ? '▼' : '▶'} {expanded ? 'Hide' : 'Show'}
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-2 p-2 bg-red-900/20 border border-red-500/50 rounded text-xs text-red-400">
          {error}
        </div>
      )}

      {/* Quick Controls */}
      <div className="flex items-center gap-2 mb-2">
        {!status?.running ? (
          <button
            onClick={handleStart}
            disabled={loading}
            className="px-3 py-1.5 bg-green-600 hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed rounded text-sm font-medium"
          >
            {loading ? 'Starting...' : '▶ Start Executor'}
          </button>
        ) : (
          <>
            <button
              onClick={handleToggleEnabled}
              disabled={loading}
              className={`px-3 py-1.5 rounded text-sm font-medium ${
                status.config.enabled
                  ? 'bg-yellow-600 hover:bg-yellow-700'
                  : 'bg-green-600 hover:bg-green-700'
              } disabled:opacity-50 disabled:cursor-not-allowed`}
            >
              {loading ? '...' : status.config.enabled ? '⏸ Pause' : '▶ Resume'}
            </button>
            <button
              onClick={handleStop}
              disabled={loading}
              className="px-3 py-1.5 bg-red-600 hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed rounded text-sm"
            >
              {loading ? '...' : '⏹ Stop'}
            </button>
          </>
        )}
      </div>

      {/* Stats Summary */}
      {status?.running && status.state && (
        <div className="grid grid-cols-3 gap-2 text-xs mb-2">
          <div className="p-1.5 bg-black/20 rounded">
            <div className="opacity-70">Executions</div>
            <div className="font-semibold">{status.state.totalExecutions}</div>
          </div>
          <div className="p-1.5 bg-black/20 rounded">
            <div className="opacity-70">Success Rate</div>
            <div className="font-semibold text-green-400">{status.state.successRate}</div>
          </div>
          <div className="p-1.5 bg-black/20 rounded">
            <div className="opacity-70">In Flight</div>
            <div className="font-semibold">{status.state.inFlight}</div>
          </div>
        </div>
      )}

      {/* Expanded Details */}
      {expanded && status?.running && (
        <div className="mt-3 p-2 bg-black/20 rounded text-xs space-y-3">
          {/* Feature Badges */}
          <div className="flex flex-wrap gap-1.5 mb-2">
            <span className={`px-2 py-0.5 rounded text-xs ${jitoConfig?.enabled ? 'bg-orange-600/30 text-orange-300' : 'bg-gray-700 text-gray-500'}`}>
              Jito {jitoConfig?.enabled ? '✓' : '✗'}
            </span>
            <span className={`px-2 py-0.5 rounded text-xs ${status.config.dynamicSizing?.enabled ? 'bg-emerald-600/30 text-emerald-300' : 'bg-gray-700 text-gray-500'}`}>
              Dynamic Size {status.config.dynamicSizing?.enabled ? '✓' : '✗'}
            </span>
            <span className={`px-2 py-0.5 rounded text-xs ${status.config.flashloanSettings?.enabled ? 'bg-blue-600/30 text-blue-300' : 'bg-gray-700 text-gray-500'}`}>
              Flashloan {status.config.flashloanSettings?.enabled ? '✓' : '✗'}
            </span>
            <span className={`px-2 py-0.5 rounded text-xs ${status.config.useRouter ? 'bg-purple-600/30 text-purple-300' : 'bg-gray-700 text-gray-500'}`}>
              Router {status.config.useRouter ? '✓' : '✗'}
            </span>
          </div>

          <div className="font-semibold mb-2">Configuration</div>
          
          {/* Editable Fields */}
          <div className="grid grid-cols-3 gap-2">
            <div>
              <label className="block opacity-70 mb-1">Min Profit (bps)</label>
              <input
                type="number"
                className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white text-xs"
                value={editMinProfit ?? status.config.minProfitBps}
                onChange={(e) => setEditMinProfit(Number(e.target.value))}
                onBlur={() => {
                  if (editMinProfit !== null && editMinProfit !== status.config.minProfitBps) {
                    updateConfig({ minProfitBps: editMinProfit });
                  }
                }}
                disabled={saving}
              />
              <div className="text-gray-500 mt-0.5">{((editMinProfit ?? status.config.minProfitBps) / 100).toFixed(2)}%</div>
            </div>
            <div>
              <label className="block opacity-70 mb-1">Slippage (bps)</label>
              <input
                type="number"
                className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white text-xs"
                value={editSlippage ?? (status.config.slippageBps ?? 50)}
                onChange={(e) => setEditSlippage(Number(e.target.value))}
                onBlur={() => {
                  if (editSlippage !== null && editSlippage !== status.config.slippageBps) {
                    updateConfig({ slippageBps: editSlippage });
                  }
                }}
                disabled={saving}
              />
              <div className="text-gray-500 mt-0.5">{((editSlippage ?? status.config.slippageBps ?? 50) / 100).toFixed(2)}%</div>
            </div>
            <div>
              <label className="block opacity-70 mb-1">
                Trade Size ($)
                {status.config.dynamicSizing?.enabled && <span className="text-emerald-400 ml-1">(dynamic)</span>}
              </label>
              <input
                type="number"
                className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white text-xs"
                value={editSizeUsd ?? (status.config.sizeUsd ?? 100)}
                onChange={(e) => setEditSizeUsd(Number(e.target.value))}
                onBlur={() => {
                  if (editSizeUsd !== null && editSizeUsd !== status.config.sizeUsd) {
                    updateConfig({ sizeUsd: editSizeUsd });
                  }
                }}
                disabled={saving || status.config.dynamicSizing?.enabled}
                title={status.config.dynamicSizing?.enabled ? 'Disabled when dynamic sizing is enabled' : ''}
              />
              {status.config.dynamicSizing?.enabled && (
                <div className="text-emerald-400 mt-0.5">
                  ${status.config.dynamicSizing.minSizeUsd}-${status.config.dynamicSizing.maxSizeUsd}
                </div>
              )}
            </div>
          </div>

          {/* Read-only Fields */}
          <div className="grid grid-cols-3 gap-2 mt-2">
            <div>
              <span className="opacity-70">Max Concurrent:</span>{' '}
              <span className="font-mono">{status.config.maxConcurrentExecutions}</span>
            </div>
            <div>
              <span className="opacity-70">Cooldown:</span>{' '}
              <span className="font-mono">{(status.config.cooldownMs / 1000).toFixed(1)}s</span>
            </div>
            <div>
              <span className="opacity-70">Max/Min:</span>{' '}
              <span className="font-mono">{status.config.maxExecutionsPerMinute || 'N/A'}</span>
            </div>
          </div>

          {/* Dynamic Sizing Details */}
          {status.config.dynamicSizing?.enabled && (
            <div className="mt-2 p-2 bg-emerald-900/20 border border-emerald-700/30 rounded">
              <span className="text-emerald-400 font-medium">Dynamic Sizing:</span>{' '}
              <span className="text-gray-300">{status.config.dynamicSizing.method}</span>
              <span className="text-gray-500 ml-2">
                (${status.config.dynamicSizing.minSizeUsd} - ${status.config.dynamicSizing.maxSizeUsd})
              </span>
            </div>
          )}

          {/* Jito Details */}
          {jitoConfig?.enabled && (
            <div className="mt-2 p-2 bg-orange-900/20 border border-orange-700/30 rounded">
              <span className="text-orange-400 font-medium">Jito Tips:</span>{' '}
              <span className="text-gray-300">{jitoConfig.tipMode || 'auto'}</span>
              {jitoConfig.tipShare && (
                <span className="text-gray-500 ml-2">({(jitoConfig.tipShare * 100).toFixed(0)}% share)</span>
              )}
            </div>
          )}

          {status.state && (
            <>
              <div className="font-semibold mt-3 mb-2">Statistics</div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <span className="opacity-70">Total:</span>{' '}
                  <span className="font-mono">{status.state.totalExecutions}</span>
                </div>
                <div>
                  <span className="opacity-70">Success:</span>{' '}
                  <span className="font-mono text-green-400">{status.state.successfulExecutions}</span>
                </div>
                <div>
                  <span className="opacity-70">Failed:</span>{' '}
                  <span className="font-mono text-red-400">{status.state.failedExecutions}</span>
                </div>
                <div>
                  <span className="opacity-70">This Minute:</span>{' '}
                  <span className="font-mono">{status.state.executionsThisMinute}</span>
                </div>
              </div>
            </>
          )}

          {saving && (
            <div className="text-center text-yellow-400 text-xs mt-2">Saving...</div>
          )}
        </div>
      )}
    </div>
  );
};

