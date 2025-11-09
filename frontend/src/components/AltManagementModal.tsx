// @ts-nocheck
import React, { useState, useEffect } from 'react';
import { ROUTES } from '../utils/routes';

interface AltStatus {
  initialized: boolean;
  altCount: number;
  categories: string[];
  addresses: { [category: string]: string };
}

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

interface PoolPreview {
  poolId: string;
  dex: string;
  poolKind: string;
  mintA: string;
  mintB: string;
  tvl: number;
  feeBps: number;
}

interface DexConfig {
  name: string;
  key: string;
  poolTypes: Array<{ value: string; label: string }>;
  defaultCategory: string;
}

const DEX_CONFIGS: DexConfig[] = [
  {
    name: 'Raydium AMM',
    key: 'raydium',
    poolTypes: [{ value: 'amm', label: 'AMM Only' }],
    defaultCategory: 'raydium-amm',
  },
  {
    name: 'Raydium CLMM',
    key: 'raydium',
    poolTypes: [{ value: 'clmm', label: 'CLMM Only' }],
    defaultCategory: 'raydium-clmm',
  },
  {
    name: 'Orca Whirlpool',
    key: 'orca',
    poolTypes: [{ value: 'clmm', label: 'Whirlpool' }],
    defaultCategory: 'orca-whirlpool',
  },
  {
    name: 'Meteora DLMM',
    key: 'meteora',
    poolTypes: [{ value: 'clmm', label: 'DLMM' }],
    defaultCategory: 'meteora-dlmm',
  },
];

export const AltManagementModal: React.FC<{ onClose: () => void; apiBase: string }> = ({ onClose, apiBase }) => {
  const [altStatus, setAltStatus] = useState<AltStatus | null>(null);
  const [altInfos, setAltInfos] = useState<{ [category: string]: AltDetailedInfo }>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ dex: string; pools: PoolPreview[] } | null>(null);
  const [poolCounts, setPoolCounts] = useState<{ [key: string]: number }>({
    'raydium-amm': 50,
    'raydium-clmm': 50,
    'orca-whirlpool': 50,
    'meteora-dlmm': 50,
  });
  const [deletingCategory, setDeletingCategory] = useState<string | null>(null);

  useEffect(() => {
    loadAltStatus();
  }, []);

  const loadAltStatus = async () => {
    try {
      const resp = await fetch(`${apiBase}${ROUTES.arb.alts.status}`);
      if (!resp.ok) throw new Error('Failed to load ALT status');
      const data = await resp.json();
      setAltStatus(data);
      
      // Load detailed info for each ALT
      for (const category of data.categories) {
        loadAltInfo(category);
      }
    } catch (err: any) {
      setError(err.message || 'Failed to load ALT status');
    }
  };

  const loadAltInfo = async (category: string) => {
    try {
      const resp = await fetch(`${apiBase}${ROUTES.arb.alts.info}/${category}`);
      if (!resp.ok) return; // Silently fail for individual ALTs
      const data = await resp.json();
      setAltInfos(prev => ({ ...prev, [category]: data }));
    } catch (err) {
      // Silently fail
    }
  };

  const handleDeactivate = async (category: string) => {
    if (!confirm(`Deactivate ${category} ALT? You'll need to wait ~5 minutes before you can close it.`)) {
      return;
    }

    setDeletingCategory(category);
    setLoading(true);
    setError(null);
    setSuccess(null);

    try {
      const resp = await fetch(`${apiBase}${ROUTES.arb.alts.deactivate}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category }),
      });
      
      if (!resp.ok) {
        const errData = await resp.json().catch(() => ({}));
        throw new Error(errData.error || 'Failed to deactivate ALT');
      }
      
      const data = await resp.json();
      setSuccess(`Deactivated ${category} ALT. Wait ~5 minutes before closing.`);
      await loadAltStatus();
    } catch (err: any) {
      setError(err.message || 'Failed to deactivate ALT');
    } finally {
      setLoading(false);
      setDeletingCategory(null);
    }
  };

  const handleClose = async (category: string) => {
    const info = altInfos[category];
    const rentStr = info?.rentAmountSOL || '~0.01';
    
    if (!confirm(`Close ${category} ALT and recover ${rentStr} SOL rent? This action cannot be undone.`)) {
      return;
    }

    setDeletingCategory(category);
    setLoading(true);
    setError(null);
    setSuccess(null);

    try {
      const resp = await fetch(`${apiBase}${ROUTES.arb.alts.close}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category }),
      });
      
      if (!resp.ok) {
        const errData = await resp.json().catch(() => ({}));
        throw new Error(errData.error || 'Failed to close ALT');
      }
      
      const data = await resp.json();
      setSuccess(`Closed ${category} ALT. Recovered ${data.rentRecoveredSOL} SOL`);
      await loadAltStatus();
    } catch (err: any) {
      setError(err.message || 'Failed to close ALT');
    } finally {
      setLoading(false);
      setDeletingCategory(null);
    }
  };

  const handlePreview = async (config: DexConfig) => {
    setLoading(true);
    setError(null);
    setPreview(null);

    try {
      const poolType = config.poolTypes[0].value;
      const maxPools = poolCounts[config.defaultCategory] || 30;
      const resp = await fetch(
        `${apiBase}${ROUTES.arb.alts.poolsByDex}?dex=${config.key}&poolType=${poolType}&maxPools=${maxPools}`
      );
      if (!resp.ok) throw new Error('Failed to fetch pool preview');
      const data = await resp.json();
      setPreview({ dex: config.name, pools: data.pools });
    } catch (err: any) {
      setError(err.message || 'Failed to preview pools');
    } finally {
      setLoading(false);
    }
  };

  const handleCreate = async (config: DexConfig) => {
    setLoading(true);
    setError(null);
    setSuccess(null);

    try {
      const poolType = config.poolTypes[0].value;
      const maxPools = poolCounts[config.defaultCategory] || 30;
      const resp = await fetch(`${apiBase}${ROUTES.arb.alts.createDex}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dex: config.key,
          poolType,
          maxPools,
          category: config.defaultCategory,
        }),
      });
      
      if (!resp.ok) {
        const errData = await resp.json().catch(() => ({}));
        throw new Error(errData.error || 'Failed to create ALT');
      }
      
      const data = await resp.json();
      setSuccess(`Created ${config.name} ALT: ${data.address} (${data.accountCount} accounts)`);
      await loadAltStatus();
      setPreview(null);
    } catch (err: any) {
      setError(err.message || 'Failed to create ALT');
    } finally {
      setLoading(false);
    }
  };

  const handleRefresh = async (config: DexConfig) => {
    setLoading(true);
    setError(null);
    setSuccess(null);

    try {
      const maxPools = poolCounts[config.defaultCategory] || 30;
      const resp = await fetch(`${apiBase}${ROUTES.arb.alts.refreshDex}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          category: config.defaultCategory,
          maxPools,
        }),
      });
      
      if (!resp.ok) {
        const errData = await resp.json().catch(() => ({}));
        throw new Error(errData.error || 'Failed to refresh ALT');
      }
      
      const data = await resp.json();
      setSuccess(`Refreshed ${config.name} ALT: ${data.accountsAdded} accounts added (total: ${data.accountCount})`);
      await loadAltStatus();
    } catch (err: any) {
      setError(err.message || 'Failed to refresh ALT');
    } finally {
      setLoading(false);
    }
  };

  const truncateAddress = (addr: string) => {
    return addr.length > 16 ? `${addr.slice(0, 8)}...${addr.slice(-8)}` : addr;
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-gray-800 rounded-lg p-6 max-w-4xl w-full max-h-[90vh] overflow-y-auto">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-2xl font-bold text-white">Manage Address Lookup Tables (ALTs)</h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white text-2xl"
          >
            ×
          </button>
        </div>

        {error && (
          <div className="bg-red-900/50 border border-red-500 text-red-200 px-4 py-2 rounded mb-4">
            {error}
          </div>
        )}

        {success && (
          <div className="bg-green-900/50 border border-green-500 text-green-200 px-4 py-2 rounded mb-4">
            {success}
          </div>
        )}

        {/* Current ALT Status */}
        <div className="mb-6">
          <h3 className="text-lg font-semibold text-white mb-2">Current ALTs</h3>
          {altStatus ? (
            <div className="bg-gray-900 rounded p-4">
              <div className="grid grid-cols-2 gap-2 text-sm mb-4">
                <div className="text-gray-400">Total ALTs:</div>
                <div className="text-white">{altStatus.altCount}</div>
                <div className="text-gray-400">Categories:</div>
                <div className="text-white">{altStatus.categories.join(', ') || 'None'}</div>
              </div>
              {Object.keys(altStatus.addresses).length > 0 && (
                <div className="space-y-3">
                  {Object.entries(altStatus.addresses).map(([category, address]) => {
                    const info = altInfos[category];
                    return (
                      <div key={category} className="border border-gray-700 rounded p-3">
                        <div className="flex justify-between items-start mb-2">
                          <div>
                            <span className="text-gray-400 text-sm">{category}</span>
                            <div className="text-gray-300 font-mono text-xs">{truncateAddress(address)}</div>
                          </div>
                          {info && (
                            <div className="text-right text-xs">
                              <div className="text-gray-400">{info.accountCount} accounts</div>
                              <div className="text-gray-400">{info.rentAmountSOL} SOL rent</div>
                            </div>
                          )}
                        </div>
                        
                        {info && (
                          <div className="flex gap-2 mt-2">
                            {info.isDeactivated ? (
                              info.canClose ? (
                                <button
                                  onClick={() => handleClose(category)}
                                  disabled={loading && deletingCategory === category}
                                  className="px-2 py-1 bg-red-600 text-white rounded hover:bg-red-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-xs"
                                >
                                  {loading && deletingCategory === category ? 'Closing...' : `Close & Recover ${info.rentAmountSOL} SOL`}
                                </button>
                              ) : (
                                <div className="text-xs text-yellow-400">
                                  ⏳ Wait {info.minutesUntilCloseable || 0} more minutes to close
                                </div>
                              )
                            ) : (
                              <button
                                onClick={() => handleDeactivate(category)}
                                disabled={loading && deletingCategory === category}
                                className="px-2 py-1 bg-orange-600 text-white rounded hover:bg-orange-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-xs"
                              >
                                {loading && deletingCategory === category ? 'Deactivating...' : 'Deactivate (Step 1)'}
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ) : (
            <div className="text-gray-400">Loading...</div>
          )}
        </div>

        {/* DEX-specific ALT Management */}
        <div className="space-y-4">
          {DEX_CONFIGS.map((config) => {
            const exists = altStatus?.categories.includes(config.defaultCategory);
            return (
              <div key={config.defaultCategory} className="bg-gray-900 rounded p-4">
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <h4 className="text-white font-semibold">{config.name}</h4>
                    <p className="text-xs text-gray-400">Category: {config.defaultCategory}</p>
                  </div>
                  {exists && (
                    <span className="px-2 py-1 bg-green-900/50 text-green-400 text-xs rounded">
                      Active
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-2 mb-2">
                  <label className="text-sm text-gray-400">Pool Count:</label>
                  <input
                    type="number"
                    min="1"
                    max="100"
                    value={poolCounts[config.defaultCategory] || 50}
                    onChange={(e) =>
                      setPoolCounts({
                        ...poolCounts,
                        [config.defaultCategory]: Math.min(100, Math.max(1, parseInt(e.target.value) || 50)),
                      })
                    }
                    className="bg-gray-800 text-white px-2 py-1 rounded w-20 text-sm"
                  />
                  <span className="text-xs text-gray-500">(1-100)</span>
                </div>

                <div className="flex gap-2">
                  <button
                    onClick={() => handlePreview(config)}
                    disabled={loading}
                    className="px-3 py-1.5 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-sm"
                  >
                    Preview Pools
                  </button>
                  {!exists ? (
                    <button
                      onClick={() => handleCreate(config)}
                      disabled={loading}
                      className="px-3 py-1.5 bg-green-600 text-white rounded hover:bg-green-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-sm"
                    >
                      Create ALT
                    </button>
                  ) : (
                    <button
                      onClick={() => handleRefresh(config)}
                      disabled={loading}
                      className="px-3 py-1.5 bg-purple-600 text-white rounded hover:bg-purple-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-sm"
                    >
                      Refresh ALT
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Pool Preview */}
        {preview && (
          <div className="mt-6 bg-gray-900 rounded p-4">
            <h4 className="text-white font-semibold mb-3">
              {preview.dex} - Top {preview.pools.length} Pools by Liquidity
            </h4>
            <div className="max-h-64 overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="text-gray-400 border-b border-gray-700">
                  <tr>
                    <th className="text-left py-2">Pool ID</th>
                    <th className="text-left py-2">Type</th>
                    <th className="text-right py-2">TVL/Liquidity</th>
                    <th className="text-right py-2">Fee (bps)</th>
                  </tr>
                </thead>
                <tbody className="text-gray-300">
                  {preview.pools.map((pool, idx) => (
                    <tr key={idx} className="border-b border-gray-800">
                      <td className="py-2 font-mono text-xs">{truncateAddress(pool.poolId)}</td>
                      <td className="py-2 text-xs">{pool.poolKind}</td>
                      <td className="py-2 text-right">${pool.tvl.toFixed(0)}</td>
                      <td className="py-2 text-right">{pool.feeBps || '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {loading && (
          <div className="mt-4 text-center text-gray-400">
            <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-white"></div>
            <p className="mt-2">Processing...</p>
          </div>
        )}
      </div>
    </div>
  );
};

