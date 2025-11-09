import React, { useEffect, useState } from 'react';
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

type ExecutorControlProps = {
  apiBase: string;
  socket?: any;
};

export const ExecutorControl: React.FC<ExecutorControlProps> = ({ apiBase, socket }) => {
  const [status, setStatus] = useState<ExecutorStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  const fetchStatus = async () => {
    try {
      const response = await fetch(`${apiBase}/arb/executor/status`);
      const data = await response.json();
      setStatus(data);
      setError(null);
    } catch (e: any) {
      setError(e.message);
    }
  };

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 3000); // Poll every 3 seconds
    return () => clearInterval(interval);
  }, [apiBase]);

  // Listen for execution events via socket
  useEffect(() => {
    if (!socket) return;
    
    const onExecution = () => {
      fetchStatus(); // Refresh status on execution
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
          sizeUsd: status?.config?.sizeUsd || 100,
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
        <div className="mt-3 p-2 bg-black/20 rounded text-xs space-y-2">
          <div className="font-semibold mb-2">Configuration</div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <span className="opacity-70">Min Profit:</span>{' '}
              <span className="font-mono">{(status.config.minProfitBps / 100).toFixed(2)}%</span>
            </div>
            <div>
              <span className="opacity-70">Trade Size:</span>{' '}
              <span className="font-mono">${status.config.sizeUsd || 'N/A'}</span>
            </div>
            <div>
              <span className="opacity-70">Slippage:</span>{' '}
              <span className="font-mono">{((status.config.slippageBps || 50) / 100).toFixed(2)}%</span>
            </div>
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
        </div>
      )}
    </div>
  );
};

