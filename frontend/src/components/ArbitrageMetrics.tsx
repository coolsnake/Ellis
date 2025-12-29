import React from 'react';
import { ROUTES } from '../utils/routes';
import { useSocket } from '../app/contexts/socket';

// Fetcher state tracking
type FetcherState = 'idle' | 'fetching' | 'enriching' | 'subscribing' | 'ready' | 'error';

// ALT category types
type AltCategory = 'common' | 'flashloan' | 'userPdas';
type DexAltType = 'raydium' | 'orca' | 'meteora';

interface AltDetailedInfo {
  address: string;
  accountCount: number;
  isDeactivated: boolean;
  deactivationSlot?: number;
  canClose: boolean;
  slotsUntilCloseable?: number;
  minutesUntilCloseable?: number;
  rentAmount: number;
  rentAmountSOL?: string;
}

interface AltManagementSectionProps {
  apiBase: string;
  altStatus: any;
  onRefresh: () => void;
  altActionLoading: string | null;
  setAltActionLoading: (v: string | null) => void;
}

const getAuthHeaders = (): Record<string, string> => {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  try {
    const s = localStorage.getItem('authCreds');
    if (s) {
      const creds = JSON.parse(s || '{}') as { user?: string; pass?: string };
      if (creds && creds.user && creds.pass) {
        headers['Authorization'] = `Basic ${btoa(`${creds.user}:${creds.pass}`)}`;
      }
    }
  } catch {}
  return headers;
};

const AltManagementSection: React.FC<AltManagementSectionProps> = ({
  apiBase,
  altStatus,
  onRefresh,
  altActionLoading,
  setAltActionLoading,
}) => {
  const [expanded, setExpanded] = React.useState(false);
  const [altConfig, setAltConfig] = React.useState<any>(null);
  const [altInfos, setAltInfos] = React.useState<Record<string, AltDetailedInfo>>({});
  const [dexPoolCounts, setDexPoolCounts] = React.useState<Record<DexAltType, number>>({
    raydium: 50,
    orca: 50,
    meteora: 50,
  });
  const [actionResult, setActionResult] = React.useState<{ type: 'success' | 'error'; message: string } | null>(null);

  // Load ALT config on mount and when expanded
  React.useEffect(() => {
    if (expanded) {
      loadAltConfig();
    }
  }, [expanded]);

  const loadAltConfig = async () => {
    try {
      const res = await fetch(`${apiBase}${ROUTES.arb.alts.config}`, { headers: getAuthHeaders() });
      if (res.ok) {
        const data = await res.json();
        setAltConfig(data);
      }
    } catch {}
  };

  const loadAltInfo = async (category: string) => {
    try {
      const res = await fetch(`${apiBase}${ROUTES.arb.alts.info}/${category}`, { headers: getAuthHeaders() });
      if (res.ok) {
        const data = await res.json();
        setAltInfos(prev => ({ ...prev, [category]: data }));
      }
    } catch {}
  };

  const handleCreateCategory = async (category: AltCategory) => {
    const actionKey = `create-${category}`;
    if (altActionLoading) return;
    setAltActionLoading(actionKey);
    setActionResult(null);

    try {
      let endpoint = '';
      switch (category) {
        case 'common':
          endpoint = ROUTES.arb.alts.createCommon;
          break;
        case 'flashloan':
          endpoint = ROUTES.arb.alts.createFlashloan;
          break;
        case 'userPdas':
          endpoint = ROUTES.arb.alts.createUserPdas;
          break;
      }

      const res = await fetch(`${apiBase}${endpoint}`, {
        method: 'POST',
        headers: getAuthHeaders(),
      });

      if (res.ok) {
        const data = await res.json();
        setActionResult({
          type: 'success',
          message: `Created ${category} ALT: ${data.accountCount || 0} accounts`,
        });
        onRefresh();
        loadAltConfig();
      } else {
        const err = await res.json().catch(() => ({}));
        setActionResult({ type: 'error', message: err.error || 'Failed to create ALT' });
      }
    } catch (e: any) {
      setActionResult({ type: 'error', message: e?.message || 'Unknown error' });
    } finally {
      setAltActionLoading(null);
    }
  };

  const handleCreateDexPools = async (dex: DexAltType) => {
    const actionKey = `create-dex-${dex}`;
    if (altActionLoading) return;
    setAltActionLoading(actionKey);
    setActionResult(null);

    try {
      const maxPools = dexPoolCounts[dex] || 50;
      const res = await fetch(`${apiBase}${ROUTES.arb.alts.createDexPools}?dex=${dex}&maxPools=${maxPools}`, {
        method: 'POST',
        headers: getAuthHeaders(),
      });

      if (res.ok) {
        const data = await res.json();
        setActionResult({
          type: 'success',
          message: `Created ${dex} ALTs: ${data.totalPools || 0} pools, ${data.totalAccounts || 0} accounts in ${data.altCount || 1} ALT(s)`,
        });
        onRefresh();
        loadAltConfig();
      } else {
        const err = await res.json().catch(() => ({}));
        setActionResult({ type: 'error', message: err.error || 'Failed to create DEX ALTs' });
      }
    } catch (e: any) {
      setActionResult({ type: 'error', message: e?.message || 'Unknown error' });
    } finally {
      setAltActionLoading(null);
    }
  };

  const handleRefreshCache = async () => {
    if (altActionLoading) return;
    setAltActionLoading('refresh-cache');
    setActionResult(null);

    try {
      const res = await fetch(`${apiBase}${ROUTES.arb.alts.refresh}`, {
        method: 'POST',
        headers: getAuthHeaders(),
      });

      if (res.ok) {
        const data = await res.json();
        setActionResult({
          type: 'success',
          message: `Cache refreshed: ${data.altCount || 0} ALTs loaded`,
        });
        onRefresh();
        loadAltConfig();
      } else {
        const err = await res.json().catch(() => ({}));
        setActionResult({ type: 'error', message: err.error || 'Failed to refresh cache' });
      }
    } catch (e: any) {
      setActionResult({ type: 'error', message: e?.message || 'Unknown error' });
    } finally {
      setAltActionLoading(null);
    }
  };

  const handleDeactivate = async (category: string) => {
    if (!confirm(`Deactivate ${category} ALT? You'll need to wait ~5 minutes before closing.`)) return;
    if (altActionLoading) return;
    setAltActionLoading(`deactivate-${category}`);
    setActionResult(null);

    try {
      const res = await fetch(`${apiBase}${ROUTES.arb.alts.deactivate}`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ category }),
      });

      if (res.ok) {
        setActionResult({ type: 'success', message: `Deactivated ${category}. Wait ~5 min to close.` });
        onRefresh();
        loadAltInfo(category);
      } else {
        const err = await res.json().catch(() => ({}));
        setActionResult({ type: 'error', message: err.error || 'Failed to deactivate' });
      }
    } catch (e: any) {
      setActionResult({ type: 'error', message: e?.message || 'Unknown error' });
    } finally {
      setAltActionLoading(null);
    }
  };

  const handleClose = async (category: string) => {
    const info = altInfos[category];
    if (!confirm(`Close ${category} ALT and recover ${info?.rentAmountSOL || '~0.01'} SOL?`)) return;
    if (altActionLoading) return;
    setAltActionLoading(`close-${category}`);
    setActionResult(null);

    try {
      const res = await fetch(`${apiBase}${ROUTES.arb.alts.close}`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ category }),
      });

      if (res.ok) {
        const data = await res.json();
        setActionResult({ type: 'success', message: `Closed ${category}. Recovered ${data.rentRecoveredSOL || '?'} SOL` });
        onRefresh();
        loadAltConfig();
      } else {
        const err = await res.json().catch(() => ({}));
        setActionResult({ type: 'error', message: err.error || 'Failed to close ALT' });
      }
    } catch (e: any) {
      setActionResult({ type: 'error', message: e?.message || 'Unknown error' });
    } finally {
      setAltActionLoading(null);
    }
  };

  const truncAddr = (addr: string) => addr ? `${addr.slice(0, 6)}...${addr.slice(-6)}` : '-';

  const categoryLabels: Record<AltCategory, { label: string; desc: string; icon: string }> = {
    common: { label: 'Common', desc: 'System programs, DEX programs, common mints', icon: '🔧' },
    flashloan: { label: 'Flashloan', desc: 'Vault PDAs, vault token accounts', icon: '⚡' },
    userPdas: { label: 'User PDAs', desc: 'User ATAs for common mints', icon: '👤' },
  };

  const dexLabels: Record<DexAltType, { label: string; color: string }> = {
    raydium: { label: 'Raydium', color: 'text-red-300' },
    orca: { label: 'Orca', color: 'text-blue-300' },
    meteora: { label: 'Meteora', color: 'text-green-300' },
  };

  if (!altStatus) return null;

  return (
    <div className="border border-gray-700 rounded p-3 bg-gray-800/50">
      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <button 
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-2 text-md font-semibold text-amber-300 hover:text-amber-200"
        >
          <span>{expanded ? '▼' : '▶'}</span>
          <span>Address Lookup Tables</span>
        </button>
        <div className="flex items-center gap-2">
          <span className={`px-2 py-0.5 text-xs rounded border ${
            altStatus.initialized && altStatus.altCount > 0 
              ? 'bg-green-800/40 border-green-700 text-green-300' 
              : 'bg-yellow-800/50 border-yellow-700 text-yellow-300'
          }`}>
            {altStatus.altCount || 0} ALT{altStatus.altCount !== 1 ? 's' : ''}
          </span>
          <button
            onClick={handleRefreshCache}
            disabled={altActionLoading !== null}
            className={`px-2 py-1 text-xs border rounded ${
              altActionLoading === 'refresh-cache' 
                ? 'bg-gray-700 opacity-50 cursor-not-allowed' 
                : 'bg-purple-700 hover:bg-purple-600 border-purple-600'
            }`}
          >
            {altActionLoading === 'refresh-cache' ? '⏳' : '🔄'} Refresh
          </button>
        </div>
      </div>

      {/* Quick Status */}
      {!expanded && (
        <div className="text-xs text-gray-400">
          Categories: {altStatus.categories?.join(', ') || 'None'} 
          {altConfig?.poolToAltCount ? ` • ${altConfig.poolToAltCount} pools mapped` : ''}
        </div>
      )}

      {/* Action Result */}
      {actionResult && (
        <div className={`mb-3 px-3 py-2 rounded text-xs ${
          actionResult.type === 'success' 
            ? 'bg-green-900/40 border border-green-700 text-green-300' 
            : 'bg-red-900/40 border border-red-700 text-red-300'
        }`}>
          {actionResult.type === 'success' ? '✓' : '✗'} {actionResult.message}
          <button 
            onClick={() => setActionResult(null)} 
            className="ml-2 opacity-60 hover:opacity-100"
          >×</button>
        </div>
      )}

      {/* Expanded Content */}
      {expanded && (
        <div className="space-y-4 mt-3">
          {/* Static ALT Categories */}
          <div>
            <h5 className="text-sm font-medium text-gray-300 mb-2">Static ALTs</h5>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
              {(Object.keys(categoryLabels) as AltCategory[]).map((cat) => {
                const { label, desc, icon } = categoryLabels[cat];
                const addr = altConfig?.alts?.[cat];
                const exists = !!addr;
                const isLoading = altActionLoading === `create-${cat}`;

                return (
                  <div key={cat} className="bg-gray-900/60 rounded p-2 border border-gray-700">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-sm font-medium text-gray-200">{icon} {label}</span>
                      {exists ? (
                        <span className="text-xs px-1.5 py-0.5 bg-green-900/50 text-green-400 rounded">Active</span>
                      ) : (
                        <span className="text-xs px-1.5 py-0.5 bg-gray-700 text-gray-400 rounded">None</span>
                      )}
                    </div>
                    <div className="text-xs text-gray-500 mb-2">{desc}</div>
                    {exists ? (
                      <div className="text-xs font-mono text-gray-400 truncate" title={addr}>
                        {truncAddr(addr)}
                      </div>
                    ) : (
                      <button
                        onClick={() => handleCreateCategory(cat)}
                        disabled={altActionLoading !== null}
                        className={`w-full px-2 py-1 text-xs rounded ${
                          isLoading 
                            ? 'bg-gray-700 opacity-50 cursor-not-allowed' 
                            : 'bg-blue-700 hover:bg-blue-600 text-white'
                        }`}
                      >
                        {isLoading ? 'Creating...' : 'Create ALT'}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* DEX Pool ALTs */}
          <div>
            <h5 className="text-sm font-medium text-gray-300 mb-2">DEX Pool ALTs</h5>
            <div className="space-y-2">
              {(Object.keys(dexLabels) as DexAltType[]).map((dex) => {
                const { label, color } = dexLabels[dex];
                const dexAltSet = altConfig?.dexAlts?.[dex];
                const altCount = dexAltSet?.addresses?.length || 0;
                const totalPools = dexAltSet?.totalPools || 0;
                const totalAccounts = dexAltSet?.totalAccounts || 0;
                const isLoading = altActionLoading === `create-dex-${dex}`;

                return (
                  <div key={dex} className="bg-gray-900/60 rounded p-2 border border-gray-700">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <span className={`text-sm font-medium ${color}`}>{label}</span>
                        {altCount > 0 && (
                          <span className="text-xs text-gray-400">
                            {altCount} ALT{altCount > 1 ? 's' : ''} • {totalPools} pools • {totalAccounts} accounts
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        <input
                          type="number"
                          min="10"
                          max="200"
                          value={dexPoolCounts[dex]}
                          onChange={(e) => setDexPoolCounts(prev => ({
                            ...prev,
                            [dex]: Math.min(200, Math.max(10, parseInt(e.target.value) || 50)),
                          }))}
                          className="w-16 px-1 py-0.5 text-xs bg-gray-800 border border-gray-600 rounded text-center"
                          title="Max pools to include"
                        />
                        <button
                          onClick={() => handleCreateDexPools(dex)}
                          disabled={altActionLoading !== null}
                          className={`px-2 py-1 text-xs rounded ${
                            isLoading 
                              ? 'bg-gray-700 opacity-50 cursor-not-allowed' 
                              : altCount > 0 
                                ? 'bg-purple-700 hover:bg-purple-600 text-white'
                                : 'bg-green-700 hover:bg-green-600 text-white'
                          }`}
                        >
                          {isLoading ? '⏳' : altCount > 0 ? 'Refresh' : 'Create'}
                        </button>
                      </div>
                    </div>
                    {dexAltSet?.addresses?.length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {dexAltSet.addresses.slice(0, 3).map((addr: string, i: number) => (
                          <span key={i} className="text-xs font-mono text-gray-500 bg-gray-800 px-1 rounded">
                            {truncAddr(addr)}
                          </span>
                        ))}
                        {dexAltSet.addresses.length > 3 && (
                          <span className="text-xs text-gray-500">+{dexAltSet.addresses.length - 3} more</span>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Pool Coverage Stats */}
          {altConfig?.poolToAltCount > 0 && (
            <div className="bg-gray-900/60 rounded p-2 border border-gray-700">
              <div className="flex items-center justify-between">
                <span className="text-sm text-gray-300">Pool-to-ALT Mappings</span>
                <span className="text-sm font-mono text-amber-300">{altConfig.poolToAltCount} pools</span>
              </div>
              <div className="text-xs text-gray-500 mt-1">
                Pools with ALT coverage for efficient versioned transactions
              </div>
            </div>
          )}

          {/* Existing ALTs Management */}
          {altStatus.addresses && Object.keys(altStatus.addresses).length > 0 && (
            <div>
              <h5 className="text-sm font-medium text-gray-300 mb-2">Manage Existing ALTs</h5>
              <div className="space-y-1 max-h-48 overflow-y-auto">
                {Object.entries(altStatus.addresses).map(([category, address]: [string, any]) => {
                  const info = altInfos[category];
                  const isDeactivating = altActionLoading === `deactivate-${category}`;
                  const isClosing = altActionLoading === `close-${category}`;

                  // Load info if not loaded
                  if (!info && expanded) {
                    loadAltInfo(category);
                  }

                  return (
                    <div key={category} className="flex items-center justify-between bg-gray-900/40 rounded px-2 py-1.5 border border-gray-700">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-medium text-gray-300">{category}</span>
                          {info && (
                            <span className="text-xs text-gray-500">{info.accountCount} accts</span>
                          )}
                          {info?.isDeactivated && (
                            <span className="text-xs px-1 bg-orange-900/50 text-orange-400 rounded">Deactivated</span>
                          )}
                        </div>
                        <div className="text-xs font-mono text-gray-500 truncate">{truncAddr(String(address))}</div>
                      </div>
                      <div className="flex items-center gap-1 ml-2">
                        {info?.isDeactivated ? (
                          info.canClose ? (
                            <button
                              onClick={() => handleClose(category)}
                              disabled={altActionLoading !== null}
                              className={`px-2 py-0.5 text-xs rounded ${
                                isClosing
                                  ? 'bg-gray-700 opacity-50'
                                  : 'bg-red-700 hover:bg-red-600 text-white'
                              }`}
                            >
                              {isClosing ? '⏳' : `Close (${info.rentAmountSOL} SOL)`}
                            </button>
                          ) : (
                            <span className="text-xs text-yellow-400">
                              ⏳ {info.minutesUntilCloseable || 0}m
                            </span>
                          )
                        ) : (
                          <button
                            onClick={() => handleDeactivate(category)}
                            disabled={altActionLoading !== null}
                            className={`px-2 py-0.5 text-xs rounded ${
                              isDeactivating
                                ? 'bg-gray-700 opacity-50'
                                : 'bg-orange-700 hover:bg-orange-600 text-white'
                            }`}
                          >
                            {isDeactivating ? '⏳' : 'Deactivate'}
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Warnings */}
          {altStatus.startupStatus?.errors?.length > 0 && (
            <div className="bg-yellow-900/20 border border-yellow-700/50 rounded p-2">
              <div className="text-xs text-yellow-400 font-medium mb-1">⚠️ Warnings</div>
              <div className="text-xs text-yellow-300/80">
                {altStatus.startupStatus.errors.slice(0, 3).join('; ')}
                {altStatus.startupStatus.errors.length > 3 && ` (+${altStatus.startupStatus.errors.length - 3} more)`}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
type DexKey = 'raydium' | 'orca' | 'meteora' | 'meteora_balanced' | 'pumpswap';
type WsStats = { attached?: number; events?: number };
type WsTargetsState = Partial<Record<DexKey, number>>;
type WsDetailsState = Partial<Record<DexKey, WsStats>>;

export const ArbitrageMetrics: React.FC<{ apiBase: string; paused?: boolean; socket?: any }> = (
  { apiBase, paused, socket }: { apiBase: string; paused?: boolean; socket?: any }
) => {
  const { socket: ctxSocket } = useSocket();
  const effectiveSocket = socket ?? ctxSocket;
  const [m, setM] = React.useState<any | null>(null);
  const [pools, setPools] = React.useState<any | null>(null);
  const [orcaPools, setOrcaPools] = React.useState<any | null>(null);
  const [meteoraPools, setMeteoraPools] = React.useState<any | null>(null);
  const [mblPools, setMblPools] = React.useState<any | null>(null);
  const [pumpswapPools, setPumpswapPools] = React.useState<any | null>(null);
  const [poolsStats, setPoolsStats] = React.useState<any | null>(null);
  const [subscribed, setSubscribed] = React.useState<boolean>(false);
  const [wsHealthy, setWsHealthy] = React.useState<boolean>(false);
  const [lastEventMs, setLastEventMs] = React.useState<number>(0);
  const [arbEnabled, setArbEnabled] = React.useState<boolean>(false);
  const [wsDetails, setWsDetails] = React.useState<WsDetailsState>({});
  const [poolAges, setPoolAges] = React.useState<any | null>(null);
  const [wsTargets, setWsTargets] = React.useState<WsTargetsState>({});
  const [altStatus, setAltStatus] = React.useState<any | null>(null);
  const [altActionLoading, setAltActionLoading] = React.useState<string | null>(null);
  
  // Cache validation state
  const [cacheValidation, setCacheValidation] = React.useState<any | null>(null);
  const [validationLoading, setValidationLoading] = React.useState<boolean>(false);
  const [validationExpanded, setValidationExpanded] = React.useState<boolean>(false);
  const [refreshLoading, setRefreshLoading] = React.useState<boolean>(false);
  const [refreshResult, setRefreshResult] = React.useState<any | null>(null);
  
  // Named snapshots state
  const [snapshots, setSnapshots] = React.useState<any[]>([]);
  const [activeSnapshot, setActiveSnapshot] = React.useState<string>('default');
  const [newSnapshotName, setNewSnapshotName] = React.useState<string>('');
  const [snapshotLoading, setSnapshotLoading] = React.useState<boolean>(false);
  const [showSnapshotPanel, setShowSnapshotPanel] = React.useState<boolean>(false);
  const [selectedSnapshots, setSelectedSnapshots] = React.useState<Set<string>>(new Set());
  const [mergeMode, setMergeMode] = React.useState<'union' | 'intersection'>('union');
  const [mergeSaveName, setMergeSaveName] = React.useState<string>('');
  
  // DEX fetcher states
  const [fetcherStates, setFetcherStates] = React.useState<Record<string, FetcherState>>({
    raydium: 'idle',
    orca: 'idle',
    meteora: 'idle',
    meteora_balanced: 'idle',
    pumpswap: 'idle',
  });

  const fetchMetrics = async () => {
    try {
      const headers: Record<string, string> = {};
      try {
        const s = localStorage.getItem('authCreds');
        if (s) {
          const creds = JSON.parse(s || '{}') as { user?: string; pass?: string };
          if (creds && creds.user && creds.pass) headers['Authorization'] = `Basic ${btoa(`${creds.user}:${creds.pass}`)}`;
        }
      } catch {}
      const r = await fetch(`${apiBase}${ROUTES.arb.metricsJson}`, { headers });
      if (r.ok) {
        const j = await r.json();
        setM(j);
        if (j?.pools) setPoolsStats(j.pools);
        if (j?.pools_age_ms) setPoolAges(j.pools_age_ms);
        if (j?.alt_status) setAltStatus(j.alt_status);
      }
    } catch {}
  };

  const refreshPoolsAndMetrics = async () => {
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      try {
        const s = localStorage.getItem('authCreds');
        if (s) {
          const creds = JSON.parse(s || '{}') as { user?: string; pass?: string };
          if (creds && creds.user && creds.pass) headers['Authorization'] = `Basic ${btoa(`${creds.user}:${creds.pass}`)}`;
        }
      } catch {}
      // Unified refresh: force a refresh and subscribe server-side by default
      await fetch(`${apiBase}${ROUTES.pools.refresh}`, { method: 'POST', headers, body: JSON.stringify({ source: 'all', subscribe: true, force: true }) });
    } catch {}
    // Re-pull scoped pools and metrics
    try {
      const headers: Record<string, string> = {};
      try {
        const s = localStorage.getItem('authCreds');
        if (s) {
          const creds = JSON.parse(s || '{}') as { user?: string; pass?: string };
          if (creds && creds.user && creds.pass) headers['Authorization'] = `Basic ${btoa(`${creds.user}:${creds.pass}`)}`;
        }
      } catch {}
      fetch(`${apiBase}${ROUTES.pools.raydium}`, { headers }).then(r=>r.json()).then(setPools).catch(()=>{});
      fetch(`${apiBase}${ROUTES.pools.orca}`, { headers }).then(r=>r.json()).then(setOrcaPools).catch(()=>{});
      fetch(`${apiBase}${ROUTES.pools.meteora}`, { headers }).then(r=>r.json()).then(setMeteoraPools).catch(()=>{});
      fetch(`${apiBase}${ROUTES.pools.meteoraBalanced}`, { headers }).then(r=>r.json()).then(setMblPools).catch(()=>{});
      fetch(`${apiBase}${ROUTES.pools.pumpswap}`, { headers }).then(r=>r.json()).then(setPumpswapPools).catch(()=>{});
    } catch {}
    fetchMetrics();
    try { window.dispatchEvent(new CustomEvent('graph-refresh')); } catch {}
  };

  // Fetch available snapshots
  const fetchSnapshots = async () => {
    try {
      const headers: Record<string, string> = {};
      try {
        const s = localStorage.getItem('authCreds');
        if (s) {
          const creds = JSON.parse(s || '{}') as { user?: string; pass?: string };
          if (creds && creds.user && creds.pass) headers['Authorization'] = `Basic ${btoa(`${creds.user}:${creds.pass}`)}`;
        }
      } catch {}
      const r = await fetch(`${apiBase}${ROUTES.pools.snapshots}`, { headers });
      if (r.ok) {
        const data = await r.json();
        if (data.snapshots) setSnapshots(data.snapshots);
        if (data.activeSnapshot) setActiveSnapshot(data.activeSnapshot);
      }
    } catch {}
  };

  // Save current pools as named snapshot
  const saveSnapshot = async (name: string, description?: string) => {
    if (!name.trim()) return;
    setSnapshotLoading(true);
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      try {
        const s = localStorage.getItem('authCreds');
        if (s) {
          const creds = JSON.parse(s || '{}') as { user?: string; pass?: string };
          if (creds && creds.user && creds.pass) headers['Authorization'] = `Basic ${btoa(`${creds.user}:${creds.pass}`)}`;
        }
      } catch {}
      const res = await fetch(`${apiBase}${ROUTES.pools.snapshotSave}`, { 
        method: 'POST', 
        headers, 
        body: JSON.stringify({ name, description }) 
      });
      const data = await res.json().catch(() => ({}));
      if (data.success) {
        setNewSnapshotName('');
        fetchSnapshots();
      } else {
        alert(data.error || 'Failed to save snapshot');
      }
    } catch {}
    setSnapshotLoading(false);
  };

  // Load a named snapshot
  const loadSnapshot = async (name: string) => {
    setSnapshotLoading(true);
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      try {
        const s = localStorage.getItem('authCreds');
        if (s) {
          const creds = JSON.parse(s || '{}') as { user?: string; pass?: string };
          if (creds && creds.user && creds.pass) headers['Authorization'] = `Basic ${btoa(`${creds.user}:${creds.pass}`)}`;
        }
      } catch {}
      const res = await fetch(`${apiBase}${ROUTES.pools.snapshotLoad}`, { 
        method: 'POST', 
        headers, 
        body: JSON.stringify({ name }) 
      });
      const data = await res.json().catch(() => ({}));
      if (data.success) {
        setActiveSnapshot(name);
        fetchMetrics();
        fetchSnapshots();
      } else {
        alert(data.error || 'Failed to load snapshot');
      }
    } catch {}
    setSnapshotLoading(false);
  };

  // Delete a named snapshot
  const deleteSnapshot = async (name: string) => {
    if (!confirm(`Delete snapshot "${name}"?`)) return;
    try {
      const headers: Record<string, string> = {};
      try {
        const s = localStorage.getItem('authCreds');
        if (s) {
          const creds = JSON.parse(s || '{}') as { user?: string; pass?: string };
          if (creds && creds.user && creds.pass) headers['Authorization'] = `Basic ${btoa(`${creds.user}:${creds.pass}`)}`;
        }
      } catch {}
      const res = await fetch(`${apiBase}${ROUTES.pools.snapshotDelete}/${encodeURIComponent(name)}`, { 
        method: 'DELETE', 
        headers 
      });
      const data = await res.json().catch(() => ({}));
      if (data.success) {
        fetchSnapshots();
      } else {
        alert(data.error || 'Failed to delete snapshot');
      }
    } catch {}
  };

  // Toggle snapshot selection for merge
  const toggleSnapshotSelection = (name: string) => {
    setSelectedSnapshots(prev => {
      const next = new Set(prev);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });
  };

  // Merge selected snapshots
  const mergeSelectedSnapshots = async () => {
    if (selectedSnapshots.size < 2) {
      alert('Select at least 2 snapshots to merge');
      return;
    }
    setSnapshotLoading(true);
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      try {
        const s = localStorage.getItem('authCreds');
        if (s) {
          const creds = JSON.parse(s || '{}') as { user?: string; pass?: string };
          if (creds && creds.user && creds.pass) headers['Authorization'] = `Basic ${btoa(`${creds.user}:${creds.pass}`)}`;
        }
      } catch {}
      const res = await fetch(`${apiBase}${ROUTES.pools.snapshotMerge}`, { 
        method: 'POST', 
        headers, 
        body: JSON.stringify({ 
          names: Array.from(selectedSnapshots),
          mode: mergeMode,
          saveTo: mergeSaveName.trim() || undefined,
        }) 
      });
      const data = await res.json().catch(() => ({}));
      if (data.success) {
        setSelectedSnapshots(new Set());
        setMergeSaveName('');
        fetchSnapshots();
        fetchMetrics();
        alert(`Merged ${selectedSnapshots.size} snapshots (${mergeMode}) → ${data.poolCount} pools`);
      } else {
        alert(data.error || 'Failed to merge snapshots');
      }
    } catch {}
    setSnapshotLoading(false);
  };

  const runCacheValidation = async (limit = 20) => {
    if (validationLoading) return;
    setValidationLoading(true);
    setCacheValidation(null);
    setRefreshResult(null);
    try {
      const headers: Record<string, string> = {};
      try {
        const s = localStorage.getItem('authCreds');
        if (s) {
          const creds = JSON.parse(s || '{}') as { user?: string; pass?: string };
          if (creds && creds.user && creds.pass) headers['Authorization'] = `Basic ${btoa(`${creds.user}:${creds.pass}`)}`;
        }
      } catch {}
      const r = await fetch(`${apiBase}${ROUTES.pools.validateCache}?dex=all&limit=${limit}`, { headers });
      if (r.ok) {
        const j = await r.json();
        if (j.success) {
          setCacheValidation(j);
          setValidationExpanded(true);
        }
      }
    } catch (e) {
      console.error('Cache validation failed:', e);
    } finally {
      setValidationLoading(false);
    }
  };

  const refreshInvalidPools = async () => {
    if (refreshLoading) return;
    setRefreshLoading(true);
    setRefreshResult(null);
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      try {
        const s = localStorage.getItem('authCreds');
        if (s) {
          const creds = JSON.parse(s || '{}') as { user?: string; pass?: string };
          if (creds && creds.user && creds.pass) headers['Authorization'] = `Basic ${btoa(`${creds.user}:${creds.pass}`)}`;
        }
      } catch {}
      const r = await fetch(`${apiBase}${ROUTES.pools.refreshInvalid}`, { 
        method: 'POST',
        headers,
        body: JSON.stringify({ dex: 'all', limit: 50 }),
      });
      if (r.ok) {
        const j = await r.json();
        setRefreshResult(j);
        // Re-run validation after refresh
        if (j.refreshed > 0) {
          await runCacheValidation(20);
        }
      }
    } catch (e) {
      console.error('Cache refresh failed:', e);
    } finally {
      setRefreshLoading(false);
    }
  };

  React.useEffect(() => {
    if (paused) return;
    fetchMetrics();
    fetchSnapshots();
    fetch(`${apiBase}${ROUTES.arb.metricsJson}`).catch(()=>{});
    // Probe arb config to detect enabled state
    fetch(`${apiBase}${ROUTES.arb.config}`).then(r=>r.json()).then((j)=>{ if (j && typeof j.enabled === 'boolean') setArbEnabled(!!j.enabled); }).catch(()=>{});
    fetch(`${apiBase}${ROUTES.pools.subscriptions}`).then(r=>r.json()).then((j)=>{
      setSubscribed(!!j.wsEnabled);
      setWsHealthy(!!j.wsHealthy);
      setLastEventMs(Number(j.lastEventMs||0));
      setWsDetails({
        raydium: j.ws?.raydium,
        orca: j.ws?.orca,
        meteora: j.ws?.meteora,
        meteora_balanced: j.ws?.meteora_balanced,
        pumpswap: j.ws?.pumpswap,
      });
      setWsTargets({
        raydium: j?.targets?.raydium?.target,
        orca: j?.targets?.orca?.target,
        meteora: j?.targets?.meteora?.target,
        meteora_balanced: j?.targets?.meteora_balanced?.target,
        pumpswap: j?.targets?.pumpswap?.target,
      });
    }).catch(()=>{});
    return () => {};
  }, [paused]);

  // Subscribe to socket events to refresh metrics on push updates
  React.useEffect(() => {
    if (!effectiveSocket || paused) return;
    // Debounce metrics refresh to avoid redundant work under event bursts
    const lastMetricsAtRef: { current: number } = { current: 0 } as any;
    const requestMetrics = (cooldownMs = 750) => {
      const now = Date.now();
      if (now - lastMetricsAtRef.current < cooldownMs) return;
      lastMetricsAtRef.current = now;
      try { fetchMetrics(); } catch {}
    };
    const onGraphSnapshot = () => { requestMetrics(); };
    const onGraphUpdate = () => { requestMetrics(); };
    const onWsActivity = (evt: any) => {
      try {
        if (!evt) return;
        setWsHealthy(!!evt.healthy);
        setLastEventMs(Number(evt.lastEventMs || 0));
        setWsDetails({
          raydium: evt.raydium,
          orca: evt.orca,
          meteora: evt.meteora,
          meteora_balanced: evt.meteora_balanced,
          pumpswap: evt.pumpswap,
        });
      } catch {}
    };
    const onArbLog = (evt: any) => {
      try {
        const msg: string = (evt?.message || '').toString();
        const code: string = String(evt?.code || '').toUpperCase();
        const cat: string = String(evt?.cat || evt?.context?.cat || '').toLowerCase();
        
        // Update fetcher states based on log events
        if (cat === 'raydium') {
          if (/fetch start/i.test(msg)) {
            setFetcherStates(s => ({ ...s, raydium: 'fetching' }));
          } else if (/pool_accounts|market_accounts/i.test(msg)) {
            setFetcherStates(s => ({ ...s, raydium: 'enriching' }));
          } else if (/pools\.ws subscribe raydium/i.test(msg)) {
            setFetcherStates(s => ({ ...s, raydium: 'subscribing' }));
          } else if (/error|fail/i.test(msg)) {
            setFetcherStates(s => ({ ...s, raydium: 'error' }));
          }
        }
        if (cat === 'orca') {
          if (/fetch start/i.test(msg)) {
            setFetcherStates(s => ({ ...s, orca: 'fetching' }));
          } else if (/pools\.ws subscribe orca/i.test(msg)) {
            setFetcherStates(s => ({ ...s, orca: 'subscribing' }));
          } else if (/error|fail/i.test(msg)) {
            setFetcherStates(s => ({ ...s, orca: 'error' }));
          }
        }
        if (cat === 'meteora') {
          if (/fetch start/i.test(msg)) {
            setFetcherStates(s => ({ ...s, meteora: 'fetching' }));
          } else if (/bitmap_ext|activeId/i.test(msg)) {
            setFetcherStates(s => ({ ...s, meteora: 'enriching' }));
          } else if (/pools\.ws subscribe meteora/i.test(msg) || /pools\.ws meteora\.attach/i.test(msg)) {
            setFetcherStates(s => ({ ...s, meteora: 'subscribing' }));
          } else if (/error|fail/i.test(msg)) {
            setFetcherStates(s => ({ ...s, meteora: 'error' }));
          }
        }
        if (cat === 'pumpswap') {
          if (/fetch start/i.test(msg)) {
            setFetcherStates(s => ({ ...s, pumpswap: 'fetching' }));
          } else if (/enrichment\.start/i.test(msg)) {
            setFetcherStates(s => ({ ...s, pumpswap: 'enriching' }));
          } else if (/pools\.ws subscribe pumpswap/i.test(msg)) {
            setFetcherStates(s => ({ ...s, pumpswap: 'subscribing' }));
          } else if (/error|fail/i.test(msg)) {
            setFetcherStates(s => ({ ...s, pumpswap: 'error' }));
          }
        }
        
        // Meteora Balanced - now has subscriptions
        if (/meteora\.balanced/i.test(msg)) {
          const key = 'meteora_balanced';
          if (/fetch start/i.test(msg)) {
            setFetcherStates(s => ({ ...s, [key]: 'fetching' }));
          } else if (/pools\.ws subscribe.*balanced/i.test(msg) || /pools\.ws.*meteora.*balanced/i.test(msg)) {
            setFetcherStates(s => ({ ...s, [key]: 'subscribing' }));
          } else if (/error|fail/i.test(msg)) {
            setFetcherStates(s => ({ ...s, [key]: 'error' }));
          }
        }
        
        // ONLY mark as ready when all subscriptions are fully active
        if (/pools\.ws subscriptions active/i.test(msg)) {
          // Mark all DEXes with subscriptions as ready
          setFetcherStates(s => {
            const updated: Record<string, FetcherState> = { ...s };
            // Only mark as ready if they were in a loading state (not already ready, not error, not idle)
            for (const key of ['raydium', 'orca', 'meteora', 'meteora_balanced', 'pumpswap']) {
              if (updated[key] === 'subscribing' || updated[key] === 'fetching' || updated[key] === 'enriching') {
                updated[key] = 'ready';
              }
            }
            return updated;
          });
        }
        
        const isGraphPush = /^GRAPH\.PUSH\.(SNAPSHOT|DIFF)$/.test(code) || /^(graph:push (snapshot|diff))$/i.test(msg);
        const isArbPush = /^ARB\.PUSH\.SNAPSHOT$/.test(code) || /^arb:push snapshot$/i.test(msg);
        if (isGraphPush || isArbPush) {
          requestMetrics();
        }
      } catch {}
    };
    try { effectiveSocket.on('graph-snapshot', onGraphSnapshot); } catch {}
    try { effectiveSocket.on('graph-update', onGraphUpdate); } catch {}
    try { effectiveSocket.on('ws-activity', onWsActivity); } catch {}
    try { effectiveSocket.on('log', onArbLog); } catch {}
    return () => {
      try { effectiveSocket.off('graph-snapshot', onGraphSnapshot); } catch {}
      try { effectiveSocket.off('graph-update', onGraphUpdate); } catch {}
      try { effectiveSocket.off('ws-activity', onWsActivity); } catch {}
      try { effectiveSocket.off('log', onArbLog); } catch {}
    };
  }, [effectiveSocket, paused]);

  const fmt = (v: any) => typeof v === 'number' ? v.toLocaleString() : String(v || '-');
  const ago = (ms?: number) => {
    if (!ms || ms === 0) return '-';
    const s = Math.max(0, Math.floor((Date.now() - ms)/1000));
    return `${s}s ago`;
  };

  const getStateColor = (state: FetcherState) => {
    switch (state) {
      case 'ready': return 'bg-green-600 border-green-500';
      case 'fetching': return 'bg-blue-600 border-blue-500';
      case 'enriching': return 'bg-yellow-600 border-yellow-500';
      case 'subscribing': return 'bg-purple-600 border-purple-500';
      case 'error': return 'bg-red-600 border-red-500';
      default: return 'bg-gray-600 border-gray-500';
    }
  };

  const getStateLabel = (state: FetcherState) => {
    switch (state) {
      case 'ready': return '✓';
      case 'fetching': return '↻';
      case 'enriching': return '⚡';
      case 'subscribing': return '📡';
      case 'error': return '✗';
      default: return '○';
    }
  };

  const wsDexList: Array<{ key: DexKey; label: string }> = [
    { key: 'raydium', label: 'Raydium' },
    { key: 'orca', label: 'Orca' },
    { key: 'meteora', label: 'Meteora DLMM' },
    { key: 'meteora_balanced', label: 'Meteora Balanced' },
    { key: 'pumpswap', label: 'Pumpswap' },
  ];

  return (
    <div className="p-3 border rounded bg-gray-900">
      {/* Header with Actions */}
      <div className="flex items-center justify-between mb-3 pb-2 border-b border-gray-700">
        <h3 className="text-lg font-semibold">Arbitrage Metrics</h3>
        <div className="flex items-center gap-2">
          <button className="px-2 py-1 text-sm border rounded bg-green-700/70 hover:bg-green-700" onClick={async()=>{
            try {
              const headers: Record<string, string> = { 'content-type': 'application/json' };
              try {
                const s = localStorage.getItem('authCreds');
                if (s) {
                  const creds = JSON.parse(s || '{}') as { user?: string; pass?: string };
                  if (creds && creds.user && creds.pass) headers['Authorization'] = `Basic ${btoa(`${creds.user}:${creds.pass}`)}`;
                }
              } catch {}
              await fetch(`${apiBase}/arb/start`, { method: 'POST', headers, body: JSON.stringify({ enable: !arbEnabled }) }).catch(()=>{});
              setArbEnabled(v => !v);
            } catch {}
          }}>{arbEnabled ? 'Stop Arb' : 'Start Arb'}</button>
          <button className="px-2 py-1 text-sm border rounded hover:bg-gray-700" onClick={refreshPoolsAndMetrics}>Refresh Pools</button>
          <button className="px-2 py-1 text-sm border rounded hover:bg-gray-700" onClick={async ()=>{
            try {
              const headers: Record<string, string> = { 'content-type': 'application/json' };
              try {
                const s = localStorage.getItem('authCreds');
                if (s) {
                  const creds = JSON.parse(s || '{}') as { user?: string; pass?: string };
                  if (creds && creds.user && creds.pass) headers['Authorization'] = `Basic ${btoa(`${creds.user}:${creds.pass}`)}`;
                }
              } catch {}
              await fetch(`${apiBase}${ROUTES.pools.retarget}`, { method: 'POST', headers }).catch(()=>{});
              fetchMetrics();
            } catch {}
          }}>Retarget WS</button>
          <button className="px-2 py-1 text-sm border rounded hover:bg-gray-700" onClick={async ()=>{
            try {
              const headers: Record<string, string> = { 'content-type': 'application/json' };
              try {
                const s = localStorage.getItem('authCreds');
                if (s) {
                  const creds = JSON.parse(s || '{}') as { user?: string; pass?: string };
                  if (creds && creds.user && creds.pass) headers['Authorization'] = `Basic ${btoa(`${creds.user}:${creds.pass}`)}`;
                }
              } catch {}
              await fetch(`${apiBase}${ROUTES.pools.revalidate}`, { method: 'POST', headers }).catch(()=>{});
              fetchMetrics();
            } catch {}
          }}>Revalidate</button>
          <button 
            className={`px-2 py-1 text-sm border rounded ${showSnapshotPanel ? 'bg-purple-800 text-purple-200' : 'hover:bg-purple-800 text-purple-300'}`}
            onClick={() => { setShowSnapshotPanel(v => !v); if (!showSnapshotPanel) fetchSnapshots(); }}
          >
            📁 Snapshots {activeSnapshot !== 'default' && `(${activeSnapshot})`}
          </button>
        </div>
      </div>
      
      {/* Named Snapshots Panel */}
      {showSnapshotPanel && (
        <div className="border border-purple-700 rounded p-3 bg-purple-900/30 space-y-3">
          <div className="flex items-center justify-between">
            <h4 className="text-md font-semibold text-purple-300">Pool Snapshots</h4>
            <span className="text-xs text-gray-400">Active: <span className="text-purple-300">{activeSnapshot}</span></span>
          </div>
          
          {/* Save new snapshot */}
          <div className="flex gap-2 items-center">
            <input
              type="text"
              placeholder="Snapshot name..."
              value={newSnapshotName}
              onChange={(e) => setNewSnapshotName(e.target.value)}
              className="flex-1 px-2 py-1 text-sm bg-gray-800 border border-gray-600 rounded focus:border-purple-500 focus:outline-none"
              onKeyDown={(e) => { if (e.key === 'Enter') saveSnapshot(newSnapshotName); }}
            />
            <button
              className="px-3 py-1 text-sm bg-green-800 hover:bg-green-700 text-green-200 rounded disabled:opacity-50"
              disabled={!newSnapshotName.trim() || snapshotLoading}
              onClick={() => saveSnapshot(newSnapshotName)}
            >
              Save As
            </button>
            <button
              className="px-3 py-1 text-sm bg-blue-800 hover:bg-blue-700 text-blue-200 rounded disabled:opacity-50"
              disabled={snapshotLoading}
              onClick={() => saveSnapshot('default')}
            >
              Quick Save
            </button>
          </div>
          
          {/* Snapshots list */}
          {snapshots.length > 0 ? (
            <div className="max-h-48 overflow-y-auto space-y-1">
              {snapshots.map((snap) => (
                <div 
                  key={snap.name}
                  className={`flex items-center justify-between p-2 rounded text-sm ${
                    snap.isActive ? 'bg-purple-800/50 border border-purple-600' : 'bg-gray-800/50 hover:bg-gray-700/50'
                  }`}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium truncate">{snap.name}</span>
                      {snap.isActive && <span className="text-xs text-purple-400">(active)</span>}
                    </div>
                    <div className="text-xs text-gray-400">
                      {snap.poolCount?.total || 0} pools • {snap.ageHours}h ago
                      {snap.description && <span className="ml-2 text-gray-500">- {snap.description}</span>}
                    </div>
                  </div>
                  <div className="flex gap-1 ml-2">
                    {!snap.isActive && (
                      <>
                        <button
                          className="px-2 py-1 text-xs bg-blue-700 hover:bg-blue-600 rounded disabled:opacity-50"
                          disabled={snapshotLoading}
                          onClick={() => loadSnapshot(snap.name)}
                        >
                          Load
                        </button>
                        <button
                          className="px-2 py-1 text-xs bg-red-800 hover:bg-red-700 rounded"
                          onClick={() => deleteSnapshot(snap.name)}
                        >
                          ✕
                        </button>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-sm text-gray-400 text-center py-2">
              No saved snapshots. Save current pools to create one.
            </div>
          )}
          
          <div className="text-xs text-gray-500 pt-1 border-t border-gray-700">
            💡 Snapshots preserve filtered pool configurations for quick switching between setups.
          </div>
        </div>
      )}

      {!m ? <div className="text-sm opacity-70">Loading...</div> : (
        <div className="space-y-4">
          {/* Graph State Section */}
          <div className="border border-gray-700 rounded p-3 bg-gray-800/50">
            <h4 className="text-md font-semibold mb-2 text-blue-300">Graph State</h4>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
              <div>
                <div className="text-gray-400 text-xs">Nodes</div>
                <div className="text-lg font-mono">{fmt((typeof m.backend_graph_nodes === 'number' && m.backend_graph_nodes > 0) ? m.backend_graph_nodes : m.graph_nodes)}</div>
              </div>
              <div>
                <div className="text-gray-400 text-xs">Edges</div>
                <div className="text-lg font-mono">{fmt((typeof m.backend_graph_edges === 'number' && m.backend_graph_edges > 0) ? m.backend_graph_edges : m.graph_edges)}</div>
              </div>
              <div>
                <div className="text-gray-400 text-xs">Last Detection</div>
                <div className="text-sm">{ago(m.last_detection_ms)}</div>
              </div>
              <div>
                <div className="text-gray-400 text-xs">Detect Duration</div>
                <div className="text-sm">{fmt(m.detection_duration_ms)}ms</div>
              </div>
              {m?.graph_push ? (
                <>
                  <div>
                    <div className="text-gray-400 text-xs">Graph Pushes</div>
                    <div className="text-sm">✓ {fmt(m.graph_push.success)} / ✗ {fmt(m.graph_push.failed)}</div>
                  </div>
                  <div>
                    <div className="text-gray-400 text-xs">Push Latency (p50/p95)</div>
                    <div className="text-sm">{fmt(m.graph_push.p50)}ms / {fmt(m.graph_push.p95)}ms</div>
                  </div>
                </>
              ) : null}
              {typeof m?.diff_to_detect_ms === 'number' ? (
                <div>
                  <div className="text-gray-400 text-xs">Diff→Detect</div>
                  <div className="text-sm">{fmt(m.diff_to_detect_ms)}ms</div>
                </div>
              ) : null}
              {typeof m?.arb_graph_version_delta === 'number' || typeof m?.arb_graph_age_ms === 'number' ? (
                <div>
                  <div className="text-gray-400 text-xs">Backend↔Arb-rs</div>
                  <div className="text-xs">Δv={fmt(m.arb_graph_version_delta)} age={fmt(m.arb_graph_age_ms)}ms</div>
                </div>
              ) : null}
            </div>
            {m?.graph_dex_breakdown ? (
              <div className="mt-3 pt-3 border-t border-gray-700">
                <div className="text-gray-400 text-xs mb-1">Pools in Graph by DEX</div>
                <div className="flex gap-4 text-xs">
                  <span className="text-red-300">Raydium: {fmt(m.graph_dex_breakdown.raydium?.pools)} pools ({fmt(m.graph_dex_breakdown.raydium?.edges)} edges)</span>
                  <span className="text-blue-300">Orca: {fmt(m.graph_dex_breakdown.orca?.pools)} pools ({fmt(m.graph_dex_breakdown.orca?.edges)} edges)</span>
                  <span className="text-green-300">Meteora: {fmt(m.graph_dex_breakdown.meteora?.pools)} pools ({fmt(m.graph_dex_breakdown.meteora?.edges)} edges)</span>
                  <span className="text-purple-300">Pumpswap: {fmt(m.graph_dex_breakdown.pumpswap?.pools)} pools ({fmt(m.graph_dex_breakdown.pumpswap?.edges)} edges)</span>
                </div>
              </div>
            ) : null}
          </div>

          {/* Pool Fetchers Section */}
          <div className="border border-gray-700 rounded p-3 bg-gray-800/50">
            <h4 className="text-md font-semibold mb-2 text-green-300">Pool Fetchers</h4>
            <div className="space-y-2">
              {/* Raydium */}
              <div className="flex items-center justify-between p-2 bg-gray-900/50 rounded">
                <div className="flex items-center gap-2">
                  <span className={`w-6 h-6 flex items-center justify-center rounded border text-xs ${getStateColor(fetcherStates.raydium)}`} title={fetcherStates.raydium}>
                    {getStateLabel(fetcherStates.raydium)}
                  </span>
                  <span className="font-semibold">Raydium</span>
                </div>
                <div className="flex items-center gap-4 text-sm">
                  {pools ? (
                    <span className="text-gray-300">AMM: {fmt(pools.amm?.length)} / CLMM: {fmt(pools.clmm?.length)}</span>
                  ) : <span className="text-gray-500">-</span>}
                  {poolsStats?.raydium ? (
                    <>
                      <span className="text-gray-400 text-xs">{fmt(poolsStats.raydium.fetches)} fetches</span>
                      <span className="text-gray-400 text-xs">{ago(poolsStats.raydium.lastMs)}</span>
                    </>
                  ) : null}
                  {poolAges?.raydium != null && poolAges?.ttl?.raydium != null ? (
                    <span className={`text-xs px-1 rounded border ${Number(poolAges.raydium) > Number(poolAges.ttl.raydium) ? 'bg-yellow-800/50 border-yellow-700' : 'bg-green-800/40 border-green-700'}`}>
                      {(Number(poolAges.raydium) / 1000).toFixed(1)}s / {(Number(poolAges.ttl.raydium) / 1000).toFixed(0)}s
                    </span>
                  ) : null}
                </div>
              </div>

              {/* Orca */}
              <div className="flex items-center justify-between p-2 bg-gray-900/50 rounded">
                <div className="flex items-center gap-2">
                  <span className={`w-6 h-6 flex items-center justify-center rounded border text-xs ${getStateColor(fetcherStates.orca)}`} title={fetcherStates.orca}>
                    {getStateLabel(fetcherStates.orca)}
                  </span>
                  <span className="font-semibold">Orca</span>
                </div>
                <div className="flex items-center gap-4 text-sm">
                  {orcaPools ? (
                    <span className="text-gray-300">AMM: {fmt(orcaPools.amm?.length)} / CLMM: {fmt(orcaPools.clmm?.length)}</span>
                  ) : <span className="text-gray-500">-</span>}
                  {poolsStats?.orca ? (
                    <>
                      <span className="text-gray-400 text-xs">{fmt(poolsStats.orca.fetches)} fetches</span>
                      <span className="text-gray-400 text-xs">{ago(poolsStats.orca.lastMs)}</span>
                    </>
                  ) : null}
                  {poolAges?.orca != null && poolAges?.ttl?.orca != null ? (
                    <span className={`text-xs px-1 rounded border ${Number(poolAges.orca) > Number(poolAges.ttl.orca) ? 'bg-yellow-800/50 border-yellow-700' : 'bg-green-800/40 border-green-700'}`}>
                      {(Number(poolAges.orca) / 1000).toFixed(1)}s / {(Number(poolAges.ttl.orca) / 1000).toFixed(0)}s
                    </span>
                  ) : null}
                </div>
              </div>

              {/* Meteora DLMM */}
              <div className="flex items-center justify-between p-2 bg-gray-900/50 rounded">
                <div className="flex items-center gap-2">
                  <span className={`w-6 h-6 flex items-center justify-center rounded border text-xs ${getStateColor(fetcherStates.meteora)}`} title={fetcherStates.meteora}>
                    {getStateLabel(fetcherStates.meteora)}
                  </span>
                  <span className="font-semibold">Meteora DLMM</span>
                </div>
                <div className="flex items-center gap-4 text-sm">
                  {meteoraPools ? (
                    <span className="text-gray-300">DLMM: {fmt(meteoraPools.clmm?.length || 0)}</span>
                  ) : <span className="text-gray-500">-</span>}
                  {poolsStats?.meteora ? (
                    <>
                      <span className="text-gray-400 text-xs">{fmt(poolsStats.meteora.fetches)} fetches</span>
                      <span className="text-gray-400 text-xs">{ago(poolsStats.meteora.lastMs)}</span>
                    </>
                  ) : null}
                  {poolAges?.meteora != null && poolAges?.ttl?.meteora != null ? (
                    <span className={`text-xs px-1 rounded border ${Number(poolAges.meteora) > Number(poolAges.ttl.meteora) ? 'bg-yellow-800/50 border-yellow-700' : 'bg-green-800/40 border-green-700'}`}>
                      {(Number(poolAges.meteora) / 1000).toFixed(1)}s / {(Number(poolAges.ttl.meteora) / 1000).toFixed(0)}s
                    </span>
                  ) : null}
                </div>
              </div>

              {/* Meteora Balanced */}
              <div className="flex items-center justify-between p-2 bg-gray-900/50 rounded">
                <div className="flex items-center gap-2">
                  <span className={`w-6 h-6 flex items-center justify-center rounded border text-xs ${getStateColor(fetcherStates.meteora_balanced)}`} title={fetcherStates.meteora_balanced}>
                    {getStateLabel(fetcherStates.meteora_balanced)}
                  </span>
                  <span className="font-semibold">Meteora Balanced</span>
                </div>
                <div className="flex items-center gap-4 text-sm">
                  {mblPools ? (
                    <span className="text-gray-300">AMM: {fmt(mblPools.amm?.length)}</span>
                  ) : <span className="text-gray-500">-</span>}
                  {poolsStats?.meteora_balanced ? (
                    <>
                      <span className="text-gray-400 text-xs">{fmt(poolsStats.meteora_balanced.fetches)} fetches</span>
                      <span className="text-gray-400 text-xs">{ago(poolsStats.meteora_balanced.lastMs)}</span>
                    </>
                  ) : null}
                  {poolAges?.meteora_balanced != null && poolAges?.ttl?.meteora_balanced != null ? (
                    <span className={`text-xs px-1 rounded border ${Number(poolAges.meteora_balanced) > Number(poolAges.ttl.meteora_balanced) ? 'bg-yellow-800/50 border-yellow-700' : 'bg-green-800/40 border-green-700'}`}>
                      {(Number(poolAges.meteora_balanced) / 1000).toFixed(1)}s / {(Number(poolAges.ttl.meteora_balanced) / 1000).toFixed(0)}s
                    </span>
                  ) : null}
                </div>
              </div>

              {/* Pumpswap */}
              <div className="flex items-center justify-between p-2 bg-gray-900/50 rounded">
                <div className="flex items-center gap-2">
                  <span className={`w-6 h-6 flex items-center justify-center rounded border text-xs ${getStateColor(fetcherStates.pumpswap)}`} title={fetcherStates.pumpswap}>
                    {getStateLabel(fetcherStates.pumpswap)}
                  </span>
                  <span className="font-semibold">Pumpswap</span>
                </div>
                <div className="flex items-center gap-4 text-sm">
                  {pumpswapPools ? (
                    <span className="text-gray-300">AMM: {fmt(pumpswapPools.amm?.length || 0)}</span>
                  ) : <span className="text-gray-500">-</span>}
                  {poolsStats?.pumpswap ? (
                    <>
                      <span className="text-gray-400 text-xs">{fmt(poolsStats.pumpswap.fetches)} fetches</span>
                      <span className="text-gray-400 text-xs">{ago(poolsStats.pumpswap.lastMs)}</span>
                      {(poolsStats.pumpswap.enrichmentSuccess > 0 || poolsStats.pumpswap.enrichmentFail > 0) ? (
                        <span className="text-xs text-purple-300" title="RPC Enrichment">
                          ⚡{fmt(poolsStats.pumpswap.enrichmentSuccess)}✓ {poolsStats.pumpswap.enrichmentFail > 0 ? `${fmt(poolsStats.pumpswap.enrichmentFail)}✗` : ''} ({fmt(poolsStats.pumpswap.enrichmentMs)}ms)
                        </span>
                      ) : null}
                    </>
                  ) : null}
                  {poolAges?.pumpswap != null && poolAges?.ttl?.pumpswap != null ? (
                    <span className={`text-xs px-1 rounded border ${Number(poolAges.pumpswap) > Number(poolAges.ttl.pumpswap) ? 'bg-yellow-800/50 border-yellow-700' : 'bg-green-800/40 border-green-700'}`}>
                      {(Number(poolAges.pumpswap) / 1000).toFixed(1)}s / {(Number(poolAges.ttl.pumpswap) / 1000).toFixed(0)}s
                    </span>
                  ) : null}
                </div>
              </div>
            </div>
            
            {/* Cache Validation Toggle */}
            <div className="mt-3 pt-3 border-t border-gray-700">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-gray-400 text-xs">Tick/Bin Array Validation</span>
                  {cacheValidation?.summary ? (
                    <span className={`text-xs px-2 py-0.5 rounded border ${
                      cacheValidation.summary.overallHealthPercent >= 90 
                        ? 'bg-green-800/40 border-green-700 text-green-300'
                        : cacheValidation.summary.overallHealthPercent >= 70 
                          ? 'bg-yellow-800/50 border-yellow-700 text-yellow-300'
                          : 'bg-red-800/50 border-red-700 text-red-300'
                    }`}>
                      {cacheValidation.summary.overallHealthPercent}% healthy
                    </span>
                  ) : null}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => runCacheValidation(20)}
                    disabled={validationLoading || refreshLoading}
                    className={`px-2 py-1 text-xs border rounded ${
                      validationLoading || refreshLoading
                        ? 'bg-gray-700 opacity-50 cursor-not-allowed border-gray-600' 
                        : 'bg-orange-700 hover:bg-orange-600 border-orange-600'
                    }`}
                    title="Validate tick/bin arrays exist on-chain"
                  >
                    {validationLoading ? '⏳ Validating...' : '🔍 Validate Cache'}
                  </button>
                  {cacheValidation && (cacheValidation.summary?.overallHealthPercent < 100 || cacheValidation.invalidPools?.length > 0) ? (
                    <button
                      onClick={refreshInvalidPools}
                      disabled={refreshLoading || validationLoading}
                      className={`px-2 py-1 text-xs border rounded ${
                        refreshLoading || validationLoading
                          ? 'bg-gray-700 opacity-50 cursor-not-allowed border-gray-600' 
                          : 'bg-green-700 hover:bg-green-600 border-green-600'
                      }`}
                      title="Refresh invalid pools via SDK"
                    >
                      {refreshLoading ? '⏳ Refreshing...' : '🔄 Refresh Invalid'}
                    </button>
                  ) : null}
                  {cacheValidation ? (
                    <button
                      onClick={() => setValidationExpanded(v => !v)}
                      className="px-2 py-1 text-xs border rounded bg-gray-700 hover:bg-gray-600 border-gray-600"
                    >
                      {validationExpanded ? '▲ Hide' : '▼ Show'}
                    </button>
                  ) : null}
                </div>
              </div>
              
              {/* Validation Results */}
              {cacheValidation && validationExpanded ? (
                <div className="mt-2 space-y-2">
                  {/* Summary Cards */}
                  <div className="grid grid-cols-3 gap-2">
                    {(['orca', 'raydium', 'meteora'] as const).map((dex) => {
                      const data = cacheValidation.summary?.[dex];
                      if (!data) return null;
                      const healthPct = data.totalPools > 0 
                        ? Math.round((data.validPools / data.totalPools) * 100) 
                        : 0;
                      return (
                        <div key={dex} className="p-2 bg-gray-900/70 rounded border border-gray-700">
                          <div className="flex items-center justify-between mb-1">
                            <span className={`font-semibold text-xs ${
                              dex === 'orca' ? 'text-blue-300' :
                              dex === 'raydium' ? 'text-red-300' : 'text-green-300'
                            }`}>
                              {dex.charAt(0).toUpperCase() + dex.slice(1)}
                            </span>
                            <span className={`text-xs px-1 rounded ${
                              healthPct >= 90 ? 'bg-green-800/50 text-green-300' :
                              healthPct >= 70 ? 'bg-yellow-800/50 text-yellow-300' :
                              'bg-red-800/50 text-red-300'
                            }`}>
                              {healthPct}%
                            </span>
                          </div>
                          <div className="grid grid-cols-2 gap-x-2 text-xs">
                            <div className="text-gray-400">Valid:</div>
                            <div className="text-green-400">{fmt(data.validPools)}/{fmt(data.totalPools)}</div>
                            {data.poolsWithMissingCenter > 0 ? (
                              <>
                                <div className="text-gray-400">Missing Center:</div>
                                <div className="text-red-400">{fmt(data.poolsWithMissingCenter)}</div>
                              </>
                            ) : null}
                            {data.poolsWithMissingArrays > 0 ? (
                              <>
                                <div className="text-gray-400">Missing Arrays:</div>
                                <div className="text-yellow-400">{fmt(data.poolsWithMissingArrays)}</div>
                              </>
                            ) : null}
                            {data.poolsWithNoCacheEntry > 0 ? (
                              <>
                                <div className="text-gray-400">No Cache:</div>
                                <div className="text-orange-400">{fmt(data.poolsWithNoCacheEntry)}</div>
                              </>
                            ) : null}
                          </div>
                          <div className="text-gray-500 text-xs mt-1">{fmt(data.durationMs)}ms</div>
                        </div>
                      );
                    })}
                  </div>
                  
                  {/* Refresh Result */}
                  {refreshResult ? (
                    <div className={`mt-2 p-2 rounded border ${
                      refreshResult.refreshed > 0 
                        ? 'bg-green-900/30 border-green-700' 
                        : 'bg-yellow-900/30 border-yellow-700'
                    }`}>
                      <div className="text-xs">
                        <span className="font-semibold">
                          {refreshResult.refreshed > 0 
                            ? `✓ Refreshed ${refreshResult.refreshed} pools via SDK` 
                            : refreshResult.message || 'No pools refreshed'}
                        </span>
                        {refreshResult.failed > 0 ? (
                          <span className="ml-2 text-yellow-400">
                            ({refreshResult.failed} failed)
                          </span>
                        ) : null}
                      </div>
                    </div>
                  ) : null}
                  
                  {/* Invalid Pools Details */}
                  {cacheValidation.invalidPools?.length > 0 ? (
                    <div className="mt-2">
                      <div className="text-xs text-gray-400 mb-1">
                        Invalid Pools ({cacheValidation.invalidPools.length}):
                      </div>
                      <div className="max-h-32 overflow-y-auto bg-gray-900/50 rounded p-2 text-xs font-mono space-y-1">
                        {cacheValidation.invalidPools.slice(0, 10).map((pool: any, idx: number) => (
                          <div key={idx} className="flex items-start gap-2 border-b border-gray-800 pb-1">
                            <span className={`px-1 rounded ${
                              pool.dex === 'orca' ? 'bg-blue-900/50 text-blue-300' :
                              pool.dex === 'raydium' ? 'bg-red-900/50 text-red-300' :
                              'bg-green-900/50 text-green-300'
                            }`}>
                              {pool.dex}
                            </span>
                            <span className="text-gray-400 truncate max-w-[100px]" title={pool.poolId}>
                              {pool.poolId?.slice(0, 8)}...
                            </span>
                            <span className="text-yellow-400 flex-1">
                              {pool.issues?.slice(0, 2).join('; ')}
                            </span>
                          </div>
                        ))}
                        {cacheValidation.invalidPools.length > 10 ? (
                          <div className="text-gray-500">
                            ... and {cacheValidation.invalidPools.length - 10} more
                          </div>
                        ) : null}
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>

          {/* WebSocket Activity Section */}
          <div className="border border-gray-700 rounded p-3 bg-gray-800/50">
            <h4 className="text-md font-semibold mb-2 text-purple-300">WebSocket Activity</h4>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
              <div className="flex items-center gap-2">
                <span className={`px-2 py-1 text-xs rounded border ${wsHealthy ? 'bg-green-700/50 border-green-600' : 'bg-yellow-700/50 border-yellow-600'}`}>
                  {wsHealthy ? '✓ Active' : '○ Idle'}
                </span>
                <span className="text-gray-400 text-xs">Last event: {ago(lastEventMs)}</span>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                {wsDexList.map(({ key, label }) => (
                  <div key={key} className="flex items-center gap-1">
                    <span className="text-gray-400 text-xs">{label}:</span>
                    <span className="ml-1 text-sm">
                      {wsDetails[key]?.attached || 0}/{wsTargets[key] || 0} ({wsDetails[key]?.events || 0} ev)
                    </span>
                  </div>
                ))}
              </div>
            </div>
            {typeof m.ws_push_total === 'number' || typeof m.ws_skipped_nochange_total === 'number' ? (
              <div className="mt-2 pt-2 border-t border-gray-700 flex gap-4 text-xs text-gray-400">
                <span>Pushes: {fmt(m.ws_push_total)}</span>
                <span>Skipped (no change): {fmt(m.ws_skipped_nochange_total)}</span>
              </div>
            ) : null}
          </div>

          {/* ALT Management Section */}
          <AltManagementSection 
            apiBase={apiBase} 
            altStatus={altStatus} 
            onRefresh={fetchMetrics}
            altActionLoading={altActionLoading}
            setAltActionLoading={setAltActionLoading}
          />
        </div>
      )}
    </div>
  );
};

