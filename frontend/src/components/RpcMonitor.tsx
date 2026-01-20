import React, { useEffect, useState } from 'react';
import { CollapsibleSection } from './CollapsibleSection';
import { useSocket } from '../app/contexts/socket';
import { apiBase } from '../utils/api';
import { ROUTES } from '../utils/routes';

interface RpcMetrics {
  overall: {
    rps: {
      current: number;
      avg1s: number;
      avg5s: number;
      avg30s: number;
      avg60s: number;
    };
    rateLimiter: {
      availableTokens: number;
      capacity: number;
      maxRps: number;
      queueDepth: number;
    };
    success: {
      total: number;
      rate: number;
    };
    errors: {
      total: number;
      rate: number;
    };
    latency: {
      p50: number;
      p90: number;
      p95: number;
      p99: number;
    };
    totalCalls: number;
  };
  byModule: Record<string, {
    count: number;
    errors: number;
    latency: {
      p50: number;
      p90: number;
      p95: number;
      p99: number;
    };
    lastCall: number;
  }>;
  byMethod: Record<string, {
    count: number;
    errors: number;
    latency: {
      p50: number;
      p90: number;
      p95: number;
      p99: number;
    };
    weight: number;
    costTotal: number;
    lastCall: number;
  }>;
  recentErrors: Array<{
    timestamp: number;
    method: string;
    module: string;
    error: string;
    duration: number;
  }>;
  timestamp: number;
  uptimeMs: number;
}

type SupportedDex = 'raydium' | 'raydium-clmm' | 'orca' | 'meteora' | 'pumpswap';

interface GraphQLMetrics {
  inFlight: Record<SupportedDex, number>;
  totalInFlight: number;
  byDex: Record<SupportedDex, {
    inFlight: number;
    total: number;
    success: number;
    errors: number;
    avgLatencyMs: number;
    lastRequestMs: number;
  }>;
  rateLimiter: {
    inCooldown: boolean;
    cooldownRemainingMs: number;
    recentRateLimitCount: number;
  };
  timestamp: number;
}

type ViewMode = 'overview' | 'modules' | 'methods' | 'errors' | 'graphql' | 'config';

const formatMs = (ms: number): string => {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
};

const formatTimeAgo = (ms: number): string => {
  if (ms < 1000) return `${Math.round(ms)}ms ago`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s ago`;
  if (ms < 3600000) return `${(ms / 60000).toFixed(1)}m ago`;
  return `${(ms / 3600000).toFixed(1)}h ago`;
};

const formatNumber = (n: number): string => {
  if (n < 1000) return n.toFixed(0);
  if (n < 1000000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1000000).toFixed(1)}M`;
};

const StatusIndicator: React.FC<{ status: 'good' | 'warning' | 'error' }> = ({ status }) => {
  const colors = {
    good: 'bg-green-500',
    warning: 'bg-yellow-500',
    error: 'bg-red-500',
  };
  return <span className={`inline-block w-2 h-2 rounded-full ${colors[status]}`} />;
};

interface RpcLimiterConfig {
  maxRps: number;
  burst: number;
  minGapMs: number;
}

const RpcMonitorInner: React.FC = () => {
  const [metrics, setMetrics] = useState<RpcMetrics | null>(null);
  const [graphqlMetrics, setGraphqlMetrics] = useState<GraphQLMetrics | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('overview');
  const [config, setConfig] = useState<RpcLimiterConfig | null>(null);
  const [editingConfig, setEditingConfig] = useState<RpcLimiterConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [configError, setConfigError] = useState<string | null>(null);
  const { socket } = useSocket();

  // Load config on mount and when switching to config view
  useEffect(() => {
    if (viewMode === 'config' && !config) {
      loadConfig();
    }
  }, [viewMode]);

  const loadConfig = async () => {
    try {
      const response = await fetch(`${apiBase}${ROUTES.system.rpcLimiterConfig}`);
      if (!response.ok) throw new Error('Failed to load config');
      const data = await response.json();
      setConfig(data);
      setEditingConfig(data);
      setConfigError(null);
    } catch (err: any) {
      setConfigError(err.message || 'Failed to load config');
    }
  };

  const saveConfig = async () => {
    if (!editingConfig) return;
    setSaving(true);
    setConfigError(null);
    try {
      const response = await fetch(`${apiBase}${ROUTES.system.rpcLimiterConfig}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(editingConfig),
      });
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to save config');
      }
      const saved = await response.json();
      setConfig(saved.config);
      setEditingConfig(saved.config);
    } catch (err: any) {
      setConfigError(err.message || 'Failed to save config');
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    if (!socket) return;

    const handleMetrics = (data: RpcMetrics) => {
      try {
        if (data && data.overall) {
          setMetrics(data);
        }
      } catch (error) {
        console.error('Error handling RPC metrics:', error);
      }
    };

    const handleGraphQLMetrics = (data: GraphQLMetrics) => {
      try {
        if (data) {
          setGraphqlMetrics(data);
        }
      } catch (error) {
        console.error('Error handling GraphQL metrics:', error);
      }
    };

    socket.on('rpc-metrics', handleMetrics);
    socket.on('graphql-metrics', handleGraphQLMetrics);

    return () => {
      socket.off('rpc-metrics', handleMetrics);
      socket.off('graphql-metrics', handleGraphQLMetrics);
    };
  }, [socket]);

  if (!metrics) {
    return (
      <CollapsibleSection title="RPC Monitor" storageKey="rpc-monitor:collapsed" className="mt-4">
        <div className="text-sm text-gray-400">Waiting for RPC metrics...</div>
      </CollapsibleSection>
    );
  }

  // Defensive checks
  if (!metrics.overall || !metrics.byModule || !metrics.byMethod) {
    return (
      <CollapsibleSection title="RPC Monitor" storageKey="rpc-monitor:collapsed" className="mt-4">
        <div className="text-sm text-yellow-400">Invalid metrics data received</div>
      </CollapsibleSection>
    );
  }

  const getHealthStatus = (): 'good' | 'warning' | 'error' => {
    const errorRate = metrics.overall?.errors?.rate || 0;
    const p95 = metrics.overall?.latency?.p95 || 0;
    if (errorRate > 10) return 'error';
    if (errorRate > 5 || p95 > 2000) return 'warning';
    return 'good';
  };

  const sortedModules = Object.entries(metrics.byModule || {}).sort((a, b) => (b[1]?.count || 0) - (a[1]?.count || 0));
  const sortedMethods = Object.entries(metrics.byMethod || {}).sort((a, b) => (b[1]?.count || 0) - (a[1]?.count || 0));

  return (
    <CollapsibleSection 
      title="RPC Monitor" 
      storageKey="rpc-monitor:collapsed" 
      className="mt-4"
      rightActions={
        <div className="flex items-center gap-3">
          {/* GraphQL Activity Indicator */}
          {graphqlMetrics && (graphqlMetrics.totalInFlight > 0 || graphqlMetrics.rateLimiter?.inCooldown) && (
            <div className="flex items-center gap-1.5">
              {graphqlMetrics.totalInFlight > 0 ? (
                <>
                  <span className="relative flex h-2 w-2">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-purple-400 opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-purple-500"></span>
                  </span>
                  <span className="text-xs text-purple-400">
                    GQL: {graphqlMetrics.totalInFlight}
                  </span>
                </>
              ) : graphqlMetrics.rateLimiter?.inCooldown && (
                <>
                  <span className="inline-block w-2 h-2 rounded-full bg-yellow-500"></span>
                  <span className="text-xs text-yellow-400">
                    GQL CD: {Math.ceil((graphqlMetrics.rateLimiter.cooldownRemainingMs || 0) / 1000)}s
                  </span>
                </>
              )}
            </div>
          )}
          <StatusIndicator status={getHealthStatus()} />
          <span className="text-xs text-gray-400">
            {(metrics.overall?.rps?.avg1s || 0).toFixed(1)} req/s
          </span>
        </div>
      }
    >
      <div className="space-y-4">
        {/* Overall Health Summary */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 bg-gray-900/50 p-3 rounded">
          <div>
            <div className="text-xs text-gray-500 uppercase">RPS</div>
            <div className="text-lg font-semibold text-white">
              {(metrics.overall?.rps?.avg1s || 0).toFixed(1)}
            </div>
            <div className="text-xs text-gray-400">
              5s: {(metrics.overall?.rps?.avg5s || 0).toFixed(1)} | 
              30s: {(metrics.overall?.rps?.avg30s || 0).toFixed(1)}
            </div>
          </div>
          <div>
            <div className="text-xs text-gray-500 uppercase">Rate Limiter</div>
            <div className="text-lg font-semibold text-white">
              {(metrics.overall?.rateLimiter?.availableTokens || 0).toFixed(1)}/{metrics.overall?.rateLimiter?.capacity || 0}
            </div>
            <div className="text-xs text-gray-400">
              Max: {metrics.overall?.rateLimiter?.maxRps || 0} RPS | 
              Q: {metrics.overall?.rateLimiter?.queueDepth || 0}
            </div>
          </div>
          <div>
            <div className="text-xs text-gray-500 uppercase">Success Rate</div>
            <div className={`text-lg font-semibold ${(metrics.overall?.success?.rate || 0) >= 95 ? 'text-green-400' : (metrics.overall?.success?.rate || 0) >= 90 ? 'text-yellow-400' : 'text-red-400'}`}>
              {(metrics.overall?.success?.rate || 0).toFixed(1)}%
            </div>
            <div className="text-xs text-gray-400">
              {formatNumber(metrics.overall?.success?.total || 0)}/{formatNumber(metrics.overall?.totalCalls || 0)}
            </div>
          </div>
          <div>
            <div className="text-xs text-gray-500 uppercase">Latency</div>
            <div className="text-lg font-semibold text-white">
              {formatMs(metrics.overall?.latency?.p50 || 0)}
            </div>
            <div className="text-xs text-gray-400">
              p95: {formatMs(metrics.overall?.latency?.p95 || 0)} | 
              p99: {formatMs(metrics.overall?.latency?.p99 || 0)}
            </div>
          </div>
        </div>

        {/* View Mode Tabs */}
        <div className="flex gap-2 border-b border-gray-700">
          {(['overview', 'modules', 'methods', 'errors', 'graphql', 'config'] as ViewMode[]).map(mode => (
            <button
              key={mode}
              onClick={() => setViewMode(mode)}
              className={`px-3 py-2 text-sm font-medium capitalize ${
                viewMode === mode
                  ? 'text-blue-400 border-b-2 border-blue-400'
                  : 'text-gray-400 hover:text-gray-300'
              }`}
            >
              {mode === 'graphql' ? 'GraphQL' : mode}
              {mode === 'errors' && (metrics.recentErrors?.length || 0) > 0 && (
                <span className="ml-1 text-xs bg-red-900/50 text-red-400 px-1.5 py-0.5 rounded">
                  {metrics.recentErrors?.length || 0}
                </span>
              )}
              {mode === 'graphql' && graphqlMetrics?.totalInFlight && graphqlMetrics.totalInFlight > 0 && (
                <span className="ml-1 text-xs bg-purple-900/50 text-purple-400 px-1.5 py-0.5 rounded">
                  {graphqlMetrics.totalInFlight}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Content Area */}
        <div className="max-h-96 overflow-y-auto">
          {viewMode === 'overview' && (
            <div className="space-y-2">
              <div className="text-sm text-gray-300">
                <strong>Total Calls:</strong> {formatNumber(metrics.overall.totalCalls)} over {formatMs(metrics.uptimeMs)}
              </div>
              <div className="text-sm text-gray-300">
                <strong>Error Rate:</strong> {metrics.overall.errors.rate.toFixed(2)}% ({metrics.overall.errors.total} errors)
              </div>
              <div className="text-sm text-gray-300">
                <strong>Top Modules:</strong> {sortedModules.slice(0, 3).map(([mod, stats]) => `${mod} (${stats.count})`).join(', ')}
              </div>
              <div className="text-sm text-gray-300">
                <strong>Top Methods:</strong> {sortedMethods.slice(0, 3).map(([method, stats]) => `${method} (${stats.count})`).join(', ')}
              </div>
            </div>
          )}

          {viewMode === 'modules' && (
            <table className="w-full text-sm">
              <thead className="text-xs text-gray-500 uppercase border-b border-gray-700">
                <tr>
                  <th className="text-left py-2">Module</th>
                  <th className="text-right py-2">Calls</th>
                  <th className="text-right py-2">Errors</th>
                  <th className="text-right py-2">p50</th>
                  <th className="text-right py-2">p95</th>
                  <th className="text-right py-2">Last Call</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800">
                {sortedModules.map(([module, stats]) => (
                  <tr key={module} className="hover:bg-gray-900/30">
                    <td className="py-2 text-blue-300">{module}</td>
                    <td className="text-right text-gray-300">{stats.count}</td>
                    <td className={`text-right ${stats.errors > 0 ? 'text-red-400' : 'text-gray-500'}`}>
                      {stats.errors}
                    </td>
                    <td className="text-right text-gray-400">{formatMs(stats.latency.p50)}</td>
                    <td className="text-right text-gray-400">{formatMs(stats.latency.p95)}</td>
                    <td className="text-right text-gray-500 text-xs">{formatTimeAgo(stats.lastCall)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {viewMode === 'methods' && (
            <table className="w-full text-sm">
              <thead className="text-xs text-gray-500 uppercase border-b border-gray-700">
                <tr>
                  <th className="text-left py-2">Method</th>
                  <th className="text-right py-2">Calls</th>
                  <th className="text-right py-2">Errors</th>
                  <th className="text-right py-2">p50</th>
                  <th className="text-right py-2">p95</th>
                  <th className="text-right py-2">Avg Weight</th>
                  <th className="text-right py-2">Total Cost</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800">
                {sortedMethods.map(([method, stats]) => (
                  <tr key={method} className="hover:bg-gray-900/30">
                    <td className="py-2 text-emerald-300">{method}</td>
                    <td className="text-right text-gray-300">{stats.count}</td>
                    <td className={`text-right ${stats.errors > 0 ? 'text-red-400' : 'text-gray-500'}`}>
                      {stats.errors}
                    </td>
                    <td className="text-right text-gray-400">{formatMs(stats.latency.p50)}</td>
                    <td className="text-right text-gray-400">{formatMs(stats.latency.p95)}</td>
                    <td className="text-right text-gray-500">{stats.weight.toFixed(1)}</td>
                    <td className="text-right text-gray-500">{formatNumber(stats.costTotal)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {viewMode === 'errors' && (
            <div className="space-y-2">
              {(!metrics.recentErrors || metrics.recentErrors.length === 0) ? (
                <div className="text-sm text-gray-500 py-4 text-center">No recent errors</div>
              ) : (
                (metrics.recentErrors || []).map((err, idx) => (
                  <div key={idx} className="bg-red-900/10 border border-red-900/30 rounded p-2 text-sm">
                    <div className="flex justify-between items-start mb-1">
                      <span className="text-red-400 font-medium">{err?.method || 'unknown'}</span>
                      <span className="text-gray-500 text-xs">
                        {formatTimeAgo(Date.now() - (err?.timestamp || Date.now()))}
                      </span>
                    </div>
                    <div className="text-gray-400 text-xs mb-1">
                      Module: <span className="text-gray-300">{err?.module || 'unknown'}</span> | 
                      Duration: <span className="text-gray-300">{formatMs(err?.duration || 0)}</span>
                    </div>
                    <div className="text-gray-500 text-xs font-mono break-all">
                      {err?.error || 'No error message'}
                    </div>
                  </div>
                ))
              )}
            </div>
          )}

          {viewMode === 'graphql' && (
            <div className="space-y-4">
              {!graphqlMetrics ? (
                <div className="text-sm text-gray-500 py-4 text-center">Waiting for GraphQL metrics...</div>
              ) : (
                <>
                  {/* Rate Limiter Status */}
                  <div className="bg-gray-900/50 p-3 rounded">
                    <div className="text-xs text-gray-500 uppercase mb-2">Shyft Rate Limiter</div>
                    <div className="flex items-center gap-4">
                      <div className="flex items-center gap-2">
                        <span className={`inline-block w-2 h-2 rounded-full ${
                          graphqlMetrics.rateLimiter?.inCooldown ? 'bg-yellow-500' : 'bg-green-500'
                        }`}></span>
                        <span className={`text-sm ${
                          graphqlMetrics.rateLimiter?.inCooldown ? 'text-yellow-400' : 'text-green-400'
                        }`}>
                          {graphqlMetrics.rateLimiter?.inCooldown 
                            ? `Cooldown: ${Math.ceil((graphqlMetrics.rateLimiter.cooldownRemainingMs || 0) / 1000)}s` 
                            : 'Ready'}
                        </span>
                      </div>
                      {graphqlMetrics.rateLimiter?.recentRateLimitCount > 0 && (
                        <span className="text-xs text-red-400">
                          429s: {graphqlMetrics.rateLimiter.recentRateLimitCount}
                        </span>
                      )}
                      <span className="text-xs text-gray-400">
                        Active: {graphqlMetrics.totalInFlight || 0} requests
                      </span>
                    </div>
                  </div>

                  {/* DEX Breakdown Table */}
                  <table className="w-full text-sm">
                    <thead className="text-xs text-gray-500 uppercase border-b border-gray-700">
                      <tr>
                        <th className="text-left py-2">DEX</th>
                        <th className="text-right py-2">In-Flight</th>
                        <th className="text-right py-2">Total</th>
                        <th className="text-right py-2">Success</th>
                        <th className="text-right py-2">Errors</th>
                        <th className="text-right py-2">Avg Latency</th>
                        <th className="text-right py-2">Last Request</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-800">
                      {graphqlMetrics.byDex && Object.entries(graphqlMetrics.byDex)
                        .filter(([, stats]) => stats.total > 0)
                        .sort((a, b) => b[1].total - a[1].total)
                        .map(([dex, stats]) => (
                          <tr key={dex} className="hover:bg-gray-900/30">
                            <td className="py-2 text-purple-300 flex items-center gap-2">
                              {stats.inFlight > 0 && (
                                <span className="relative flex h-2 w-2">
                                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-purple-400 opacity-75"></span>
                                  <span className="relative inline-flex rounded-full h-2 w-2 bg-purple-500"></span>
                                </span>
                              )}
                              {dex}
                            </td>
                            <td className={`text-right ${stats.inFlight > 0 ? 'text-purple-400' : 'text-gray-500'}`}>
                              {stats.inFlight}
                            </td>
                            <td className="text-right text-gray-300">{stats.total}</td>
                            <td className="text-right text-green-400">{stats.success}</td>
                            <td className={`text-right ${stats.errors > 0 ? 'text-red-400' : 'text-gray-500'}`}>
                              {stats.errors}
                            </td>
                            <td className="text-right text-gray-400">
                              {stats.avgLatencyMs > 0 ? formatMs(stats.avgLatencyMs) : '-'}
                            </td>
                            <td className="text-right text-gray-500 text-xs">
                              {stats.lastRequestMs > 0 
                                ? formatTimeAgo(Date.now() - stats.lastRequestMs) 
                                : '-'}
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                  
                  {graphqlMetrics.byDex && Object.values(graphqlMetrics.byDex).every(s => s.total === 0) && (
                    <div className="text-sm text-gray-500 py-4 text-center">No GraphQL requests yet</div>
                  )}
                </>
              )}
            </div>
          )}

          {viewMode === 'config' && (
            <div className="space-y-4">
              {configError && (
                <div className="bg-red-900/20 border border-red-900/50 rounded p-3 text-sm text-red-400">
                  {configError}
                </div>
              )}
              
              {!editingConfig ? (
                <div className="text-sm text-gray-400 py-4 text-center">Loading configuration...</div>
              ) : (
                <div className="space-y-4">
                  <div className="bg-gray-900/50 p-4 rounded">
                    <h3 className="text-lg font-semibold mb-4 text-white">RPC Rate Limiter Configuration</h3>
                    
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                      <div>
                        <label className="block text-sm mb-1 text-gray-300">Max RPS (requests/sec)</label>
                        <input
                          type="number"
                          min="1"
                          step="1"
                          className="w-full bg-gray-800 border border-gray-600 rounded px-3 py-2 text-white focus:outline-none focus:border-blue-500"
                          value={editingConfig.maxRps}
                          onChange={(e) => setEditingConfig({ ...editingConfig, maxRps: Number(e.target.value) || 1 })}
                        />
                        <p className="text-xs text-gray-400 mt-1">Maximum RPC calls per second</p>
                        <p className="text-xs text-gray-500 mt-1">Current: {metrics?.overall?.rateLimiter?.maxRps || 'N/A'}</p>
                      </div>
                      
                      <div>
                        <label className="block text-sm mb-1 text-gray-300">Burst Capacity (tokens)</label>
                        <input
                          type="number"
                          min="0"
                          step="1"
                          className="w-full bg-gray-800 border border-gray-600 rounded px-3 py-2 text-white focus:outline-none focus:border-blue-500"
                          value={editingConfig.burst}
                          onChange={(e) => setEditingConfig({ ...editingConfig, burst: Number(e.target.value) || 0 })}
                        />
                        <p className="text-xs text-gray-400 mt-1">Token bucket capacity (0 = auto: maxRps/4)</p>
                        <p className="text-xs text-gray-500 mt-1">Current: {metrics?.overall?.rateLimiter?.capacity || 'N/A'}</p>
                      </div>
                      
                      <div>
                        <label className="block text-sm mb-1 text-gray-300">Min Gap (ms)</label>
                        <input
                          type="number"
                          min="0"
                          step="1"
                          className="w-full bg-gray-800 border border-gray-600 rounded px-3 py-2 text-white focus:outline-none focus:border-blue-500"
                          value={editingConfig.minGapMs}
                          onChange={(e) => setEditingConfig({ ...editingConfig, minGapMs: Number(e.target.value) || 0 })}
                        />
                        <p className="text-xs text-gray-400 mt-1">Minimum gap between requests in milliseconds</p>
                      </div>
                    </div>
                    
                    <div className="mt-4 p-3 bg-gray-800/50 rounded text-xs text-gray-300">
                      <strong className="text-yellow-400">💡 Tips:</strong>
                      <ul className="list-disc list-inside mt-2 space-y-1">
                        <li>Lower burst capacity (4-5) reduces RPS spikes while maintaining sustained rate</li>
                        <li>Set burst to 0 to auto-calculate as maxRps/4</li>
                        <li>Changes take effect immediately and persist across restarts</li>
                        <li>Monitor the Rate Limiter status in the Overview tab to see current token levels</li>
                      </ul>
                    </div>
                    
                    <div className="mt-4 flex gap-2">
                      <button
                        onClick={saveConfig}
                        disabled={saving || !editingConfig}
                        className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-white rounded text-sm font-medium"
                      >
                        {saving ? 'Saving...' : 'Save Configuration'}
                      </button>
                      <button
                        onClick={() => {
                          if (config) {
                            setEditingConfig(config);
                            setConfigError(null);
                          }
                        }}
                        disabled={saving || !config}
                        className="px-4 py-2 bg-gray-700 hover:bg-gray-600 disabled:bg-gray-800 disabled:cursor-not-allowed text-white rounded text-sm"
                      >
                        Reset
                      </button>
                    </div>
                  </div>
                  
                  {/* Current Status */}
                  {metrics && (
                    <div className="bg-gray-900/50 p-4 rounded">
                      <h4 className="text-sm font-semibold mb-2 text-gray-300">Current Status</h4>
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                        <div>
                          <div className="text-xs text-gray-500">Max RPS</div>
                          <div className="text-white">{metrics.overall?.rateLimiter?.maxRps || 'N/A'}</div>
                        </div>
                        <div>
                          <div className="text-xs text-gray-500">Capacity</div>
                          <div className="text-white">{metrics.overall?.rateLimiter?.capacity || 'N/A'}</div>
                        </div>
                        <div>
                          <div className="text-xs text-gray-500">Available Tokens</div>
                          <div className="text-green-400">{metrics.overall?.rateLimiter?.availableTokens?.toFixed(1) || 'N/A'}</div>
                        </div>
                        <div>
                          <div className="text-xs text-gray-500">Queue Depth</div>
                          <div className={`${(metrics.overall?.rateLimiter?.queueDepth || 0) > 0 ? 'text-yellow-400' : 'text-gray-400'}`}>
                            {metrics.overall?.rateLimiter?.queueDepth || 0}
                          </div>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </CollapsibleSection>
  );
};

// Export with simple fallback
export const RpcMonitor: React.FC = RpcMonitorInner;

