// @ts-nocheck
import React, { useState, useEffect } from 'react';
import { ROUTES } from '../utils/routes';
import { useModalConfig } from '../app/hooks/useModalConfig';

interface AltStatus {
  initialized: boolean;
  altCount: number;
  categories: string[];
  addresses: { [category: string]: string };
}

interface DiscoveredAlt {
  address: string;
  accountCount: number;
  isDeactivated: boolean;
  canClose: boolean;
  rentLamports: number;
  rentSOL: string;
  inConfig: boolean;
  category?: string;
}

interface DiscoverResponse {
  status: string;
  summary: {
    total: number;
    inConfig: number;
    orphaned: number;
    deactivated: number;
    closeable: number;
    totalRentSOL: number;
    recoverableRentSOL: number;
  };
  alts: DiscoveredAlt[];
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
  // Raydium variants
  {
    name: 'Raydium AMM v4',
    key: 'raydium-amm',
    poolTypes: [{ value: 'amm', label: 'AMM v4' }],
    defaultCategory: 'raydium-amm',
  },
  {
    name: 'Raydium CLMM',
    key: 'raydium',
    poolTypes: [{ value: 'clmm', label: 'CLMM' }],
    defaultCategory: 'raydium-clmm',
  },
  {
    name: 'Raydium CPMM',
    key: 'raydium-cpmm',
    poolTypes: [{ value: 'cpmm', label: 'CPMM' }],
    defaultCategory: 'raydium-cpmm',
  },
  // Orca
  {
    name: 'Orca Whirlpool',
    key: 'orca',
    poolTypes: [{ value: 'clmm', label: 'Whirlpool' }],
    defaultCategory: 'orca-whirlpool',
  },
  // Meteora variants
  {
    name: 'Meteora DLMM',
    key: 'meteora',
    poolTypes: [{ value: 'clmm', label: 'DLMM' }],
    defaultCategory: 'meteora-dlmm',
  },
  {
    name: 'Meteora DAMM v1',
    key: 'meteora-damm-v1',
    poolTypes: [{ value: 'amm', label: 'Dynamic AMM v1' }],
    defaultCategory: 'meteora-damm-v1',
  },
  {
    name: 'Meteora DAMM v2',
    key: 'meteora-damm-v2',
    poolTypes: [{ value: 'amm', label: 'CP-AMM v2' }],
    defaultCategory: 'meteora-damm-v2',
  },
  // Pumpswap
  {
    name: 'Pumpswap',
    key: 'pumpswap',
    poolTypes: [{ value: 'amm', label: 'AMM' }],
    defaultCategory: 'pumpswap',
  },
];

export const AltManagementModal: React.FC<{ onClose: () => void; apiBase: string }> = ({ onClose, apiBase }) => {
  const [altStatus, setAltStatus] = useState<AltStatus | null>(null);
  const [discoveredAlts, setDiscoveredAlts] = useState<DiscoverResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [discoverLoading, setDiscoverLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ dex: string; pools: PoolPreview[] } | null>(null);
  const [activeTab, setActiveTab] = useState<'discover' | 'create'>('discover');
  
  // Track selected ALTs for bulk operations
  const [selectedAlts, setSelectedAlts] = useState<Set<string>>(new Set());
  const [bulkProcessing, setBulkProcessing] = useState(false);
  
  // Persist pool counts to localStorage
  const [uiPrefs, updateUiPrefs] = useModalConfig('altManagement', {
    poolCounts: {
      'raydium-amm': 50,
      'raydium-clmm': 50,
      'raydium-cpmm': 50,
      'orca-whirlpool': 50,
      'meteora-dlmm': 50,
      'meteora-damm-v1': 50,
      'meteora-damm-v2': 50,
      'pumpswap': 50,
    },
  });
  
  const [poolCounts, setPoolCounts] = useState<{ [key: string]: number }>(uiPrefs.poolCounts);
  const [processingAddress, setProcessingAddress] = useState<string | null>(null);
  
  // Manual account extension
  const [manualAccounts, setManualAccounts] = useState('');
  const [manualExtendCategory, setManualExtendCategory] = useState('common');
  const [manualExtending, setManualExtending] = useState(false);
  
  // Auto-extend static ALTs
  const [extendingCommon, setExtendingCommon] = useState(false);
  const [extendingUserPdas, setExtendingUserPdas] = useState(false);
  
  // Persist pool counts when they change
  useEffect(() => {
    updateUiPrefs({ poolCounts });
  }, [poolCounts]);

  useEffect(() => {
    loadAltStatus();
    discoverAllAlts();
  }, []);

  const loadAltStatus = async () => {
    try {
      const resp = await fetch(`${apiBase}${ROUTES.arb.alts.status}`);
      if (!resp.ok) throw new Error('Failed to load ALT status');
      const data = await resp.json();
      setAltStatus(data);
    } catch (err: any) {
      console.error('Failed to load ALT status:', err);
    }
  };

  const discoverAllAlts = async () => {
    setDiscoverLoading(true);
    setError(null);
    
    try {
      const resp = await fetch(`${apiBase}${ROUTES.arb.alts.discover}`);
      if (!resp.ok) throw new Error('Failed to discover wallet ALTs');
      const data: DiscoverResponse = await resp.json();
      setDiscoveredAlts(data);
      setSelectedAlts(new Set()); // Clear selection on refresh
    } catch (err: any) {
      setError(err.message || 'Failed to discover ALTs');
    } finally {
      setDiscoverLoading(false);
    }
  };

  const handleReinitialize = async () => {
    if (!confirm('Re-initialize ALT manager? This will clean up any deleted ALTs and refresh the in-memory cache.')) {
      return;
    }

    setLoading(true);
    setError(null);
    setSuccess(null);

    try {
      const resp = await fetch(`${apiBase}${ROUTES.arb.alts.reinitialize}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      
      if (!resp.ok) {
        const errData = await resp.json().catch(() => ({}));
        throw new Error(errData.error || 'Failed to reinitialize ALT manager');
      }
      
      const data = await resp.json();
      setSuccess(data.message || 'ALT manager re-initialized successfully');
      await loadAltStatus();
      await discoverAllAlts();
    } catch (err: any) {
      setError(err.message || 'Failed to reinitialize ALT manager');
    } finally {
      setLoading(false);
    }
  };

  const handleDeactivateByAddress = async (address: string) => {
    if (!confirm(`Deactivate ALT ${address.slice(0, 8)}...? You'll need to wait ~5 minutes before you can close it.`)) {
      return;
    }

    setProcessingAddress(address);
    setLoading(true);
    setError(null);
    setSuccess(null);

    try {
      const resp = await fetch(`${apiBase}${ROUTES.arb.alts.deactivateByAddress}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address }),
      });
      
      if (!resp.ok) {
        const errData = await resp.json().catch(() => ({}));
        throw new Error(errData.error || 'Failed to deactivate ALT');
      }
      
      const data = await resp.json();
      setSuccess(`Deactivated ALT. Wait ~5 minutes before closing.`);
      await discoverAllAlts();
    } catch (err: any) {
      setError(err.message || 'Failed to deactivate ALT');
    } finally {
      setLoading(false);
      setProcessingAddress(null);
    }
  };

  const handleCloseByAddress = async (address: string, rentSOL: string) => {
    if (!confirm(`Close ALT ${address.slice(0, 8)}... and recover ${rentSOL} SOL rent? This action cannot be undone.`)) {
      return;
    }

    setProcessingAddress(address);
    setLoading(true);
    setError(null);
    setSuccess(null);

    try {
      const resp = await fetch(`${apiBase}${ROUTES.arb.alts.closeByAddress}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address }),
      });
      
      if (!resp.ok) {
        const errData = await resp.json().catch(() => ({}));
        throw new Error(errData.error || 'Failed to close ALT');
      }
      
      const data = await resp.json();
      setSuccess(`Closed ALT. Recovered ${data.rentRecoveredSOL} SOL`);
      await discoverAllAlts();
    } catch (err: any) {
      setError(err.message || 'Failed to close ALT');
    } finally {
      setLoading(false);
      setProcessingAddress(null);
    }
  };

  const handleBulkDeactivate = async () => {
    const count = selectedAlts.size;
    if (count === 0) return;
    
    // Filter to only active (non-deactivated) ALTs
    const activeSelected = discoveredAlts?.alts
      .filter(alt => selectedAlts.has(alt.address) && !alt.isDeactivated)
      .map(alt => alt.address) || [];
    
    if (activeSelected.length === 0) {
      setError('No active ALTs selected to deactivate');
      return;
    }
    
    if (!confirm(`Deactivate ${activeSelected.length} ALT(s)? You'll need to wait ~5 minutes before closing.`)) {
      return;
    }

    setBulkProcessing(true);
    setLoading(true);
    setError(null);
    setSuccess(null);

    try {
      const resp = await fetch(`${apiBase}${ROUTES.arb.alts.bulkDeactivate}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ addresses: activeSelected }),
      });
      
      if (!resp.ok) {
        const errData = await resp.json().catch(() => ({}));
        throw new Error(errData.error || 'Failed to bulk deactivate ALTs');
      }
      
      const data = await resp.json();
      const successCount = data.success?.length || 0;
      const failCount = data.failed?.length || 0;
      
      if (failCount > 0) {
        setError(`${failCount} ALT(s) failed to deactivate`);
      }
      setSuccess(`Deactivated ${successCount} ALT(s). Wait ~5 minutes before closing.`);
      setSelectedAlts(new Set());
      await discoverAllAlts();
    } catch (err: any) {
      setError(err.message || 'Failed to bulk deactivate ALTs');
    } finally {
      setLoading(false);
      setBulkProcessing(false);
    }
  };

  const handleBulkClose = async () => {
    // Filter to only closeable ALTs
    const closeableSelected = discoveredAlts?.alts
      .filter(alt => selectedAlts.has(alt.address) && alt.canClose)
      .map(alt => alt.address) || [];
    
    if (closeableSelected.length === 0) {
      setError('No closeable ALTs selected. ALTs must be deactivated and wait ~5 minutes.');
      return;
    }
    
    const totalRent = discoveredAlts?.alts
      .filter(alt => closeableSelected.includes(alt.address))
      .reduce((sum, alt) => sum + parseFloat(alt.rentSOL), 0)
      .toFixed(6) || '0';
    
    if (!confirm(`Close ${closeableSelected.length} ALT(s) and recover ~${totalRent} SOL? This cannot be undone.`)) {
      return;
    }

    setBulkProcessing(true);
    setLoading(true);
    setError(null);
    setSuccess(null);

    try {
      const resp = await fetch(`${apiBase}${ROUTES.arb.alts.bulkClose}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ addresses: closeableSelected }),
      });
      
      if (!resp.ok) {
        const errData = await resp.json().catch(() => ({}));
        throw new Error(errData.error || 'Failed to bulk close ALTs');
      }
      
      const data = await resp.json();
      const successCount = data.success?.length || 0;
      const failCount = data.failed?.length || 0;
      const rentRecovered = (data.totalRentRecovered / 1e9).toFixed(6);
      
      if (failCount > 0) {
        setError(`${failCount} ALT(s) failed to close`);
      }
      setSuccess(`Closed ${successCount} ALT(s). Recovered ${rentRecovered} SOL`);
      setSelectedAlts(new Set());
      await discoverAllAlts();
    } catch (err: any) {
      setError(err.message || 'Failed to bulk close ALTs');
    } finally {
      setLoading(false);
      setBulkProcessing(false);
    }
  };

  const toggleSelectAll = () => {
    if (!discoveredAlts?.alts) return;
    
    if (selectedAlts.size === discoveredAlts.alts.length) {
      setSelectedAlts(new Set());
    } else {
      setSelectedAlts(new Set(discoveredAlts.alts.map(alt => alt.address)));
    }
  };

  const toggleSelectAlt = (address: string) => {
    const newSelected = new Set(selectedAlts);
    if (newSelected.has(address)) {
      newSelected.delete(address);
    } else {
      newSelected.add(address);
    }
    setSelectedAlts(newSelected);
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
      await discoverAllAlts();
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
      await discoverAllAlts();
    } catch (err: any) {
      setError(err.message || 'Failed to refresh ALT');
    } finally {
      setLoading(false);
    }
  };

  // Validate Solana public key format (base58, 32-44 chars)
  const isValidPublicKey = (key: string): boolean => {
    const trimmed = key.trim();
    if (trimmed.length < 32 || trimmed.length > 44) return false;
    // Base58 character set
    const base58Regex = /^[1-9A-HJ-NP-Za-km-z]+$/;
    return base58Regex.test(trimmed);
  };

  const handleManualExtend = async () => {
    setManualExtending(true);
    setError(null);
    setSuccess(null);

    try {
      // Parse accounts from textarea (supports newlines, commas, spaces)
      const accountList = manualAccounts
        .split(/[\n,\s]+/)
        .map(a => a.trim())
        .filter(a => a.length > 0);

      if (accountList.length === 0) {
        throw new Error('No accounts provided. Enter public keys separated by newlines or commas.');
      }

      // Validate all accounts
      const invalidAccounts = accountList.filter(a => !isValidPublicKey(a));
      if (invalidAccounts.length > 0) {
        throw new Error(`Invalid public key(s): ${invalidAccounts.slice(0, 3).join(', ')}${invalidAccounts.length > 3 ? '...' : ''}`);
      }

      // Remove duplicates
      const uniqueAccounts = [...new Set(accountList)];

      const resp = await fetch(`${apiBase}${ROUTES.arb.alts.extendCategory}/${manualExtendCategory}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accounts: uniqueAccounts }),
      });

      if (!resp.ok) {
        const errData = await resp.json().catch(() => ({}));
        throw new Error(errData.error || 'Failed to extend ALT');
      }

      const data = await resp.json();
      setSuccess(`Extended ${manualExtendCategory} ALT with ${uniqueAccounts.length} account(s). New total: ${data.accountCount}`);
      setManualAccounts(''); // Clear input on success
      await loadAltStatus();
      await discoverAllAlts();
    } catch (err: any) {
      setError(err.message || 'Failed to extend ALT');
    } finally {
      setManualExtending(false);
    }
  };

  const handleExtendAutoCommon = async () => {
    setExtendingCommon(true);
    setError(null);
    setSuccess(null);

    try {
      const resp = await fetch(`${apiBase}${ROUTES.arb.alts.extendAutoCommon}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      const data = await resp.json();
      
      if (!resp.ok) {
        throw new Error(data.error || 'Failed to extend common ALT');
      }

      if (data.status === 'no_change') {
        setSuccess(`Common ALT already has all accounts (${data.currentCount} total)`);
      } else {
        setSuccess(`Extended common ALT with ${data.accountsAdded} new account(s). New total: ${data.newTotal}`);
      }
      await loadAltStatus();
      await discoverAllAlts();
    } catch (err: any) {
      setError(err.message || 'Failed to extend common ALT');
    } finally {
      setExtendingCommon(false);
    }
  };

  const handleExtendAutoUserPdas = async () => {
    setExtendingUserPdas(true);
    setError(null);
    setSuccess(null);

    try {
      const resp = await fetch(`${apiBase}${ROUTES.arb.alts.extendAutoUserPdas}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      const data = await resp.json();
      
      if (!resp.ok) {
        throw new Error(data.error || 'Failed to extend user PDAs ALT');
      }

      if (data.status === 'no_change') {
        setSuccess(`User PDAs ALT already has all accounts (${data.currentCount} total)`);
      } else {
        setSuccess(`Extended user PDAs ALT with ${data.accountsAdded} new account(s). New total: ${data.newTotal}`);
      }
      await loadAltStatus();
      await discoverAllAlts();
    } catch (err: any) {
      setError(err.message || 'Failed to extend user PDAs ALT');
    } finally {
      setExtendingUserPdas(false);
    }
  };

  const truncateAddress = (addr: string) => {
    return addr.length > 16 ? `${addr.slice(0, 8)}...${addr.slice(-8)}` : addr;
  };

  const getStatusBadge = (alt: DiscoveredAlt) => {
    if (alt.canClose) {
      return <span className="px-2 py-0.5 bg-green-900/50 text-green-400 text-xs rounded">Ready to Close</span>;
    }
    if (alt.isDeactivated) {
      return <span className="px-2 py-0.5 bg-yellow-900/50 text-yellow-400 text-xs rounded">Deactivated</span>;
    }
    if (!alt.inConfig) {
      return <span className="px-2 py-0.5 bg-orange-900/50 text-orange-400 text-xs rounded">Orphaned</span>;
    }
    return <span className="px-2 py-0.5 bg-blue-900/50 text-blue-400 text-xs rounded">Active</span>;
  };

  // Group ALTs by status for better organization
  const groupedAlts = discoveredAlts?.alts ? {
    closeable: discoveredAlts.alts.filter(alt => alt.canClose),
    deactivated: discoveredAlts.alts.filter(alt => alt.isDeactivated && !alt.canClose),
    orphaned: discoveredAlts.alts.filter(alt => !alt.inConfig && !alt.isDeactivated),
    active: discoveredAlts.alts.filter(alt => alt.inConfig && !alt.isDeactivated),
  } : null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-gray-800 rounded-lg p-6 max-w-5xl w-full max-h-[90vh] overflow-y-auto">
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

        {/* Tab Navigation */}
        <div className="flex gap-2 mb-6 border-b border-gray-700 pb-2">
          <button
            onClick={() => setActiveTab('discover')}
            className={`px-4 py-2 rounded-t font-medium ${
              activeTab === 'discover'
                ? 'bg-gray-700 text-white'
                : 'text-gray-400 hover:text-white'
            }`}
          >
            📋 All Wallet ALTs
          </button>
          <button
            onClick={() => setActiveTab('create')}
            className={`px-4 py-2 rounded-t font-medium ${
              activeTab === 'create'
                ? 'bg-gray-700 text-white'
                : 'text-gray-400 hover:text-white'
            }`}
          >
            ➕ Create DEX ALTs
          </button>
        </div>

        {/* Discover All ALTs Tab */}
        {activeTab === 'discover' && (
          <div>
            {/* Summary */}
            {discoveredAlts && (
              <div className="bg-gray-900 rounded p-4 mb-4">
                <div className="flex justify-between items-center mb-3">
                  <h3 className="text-lg font-semibold text-white">Wallet ALT Summary</h3>
                  <div className="flex gap-2">
                    <button
                      onClick={discoverAllAlts}
                      disabled={discoverLoading}
                      className="bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 text-white px-3 py-1 rounded text-sm"
                    >
                      {discoverLoading ? '🔄 Scanning...' : '🔍 Re-scan On-Chain'}
                    </button>
                    <button
                      onClick={handleReinitialize}
                      disabled={loading}
                      className="bg-purple-600 hover:bg-purple-700 disabled:bg-gray-600 text-white px-3 py-1 rounded text-sm"
                    >
                      🔄 Refresh Cache
                    </button>
                  </div>
                </div>
                <div className="grid grid-cols-3 md:grid-cols-6 gap-4 text-sm">
                  <div className="text-center">
                    <div className="text-2xl font-bold text-white">{discoveredAlts.summary.total}</div>
                    <div className="text-gray-400">Total ALTs</div>
                  </div>
                  <div className="text-center">
                    <div className="text-2xl font-bold text-blue-400">{discoveredAlts.summary.inConfig}</div>
                    <div className="text-gray-400">Tracked</div>
                  </div>
                  <div className="text-center">
                    <div className="text-2xl font-bold text-orange-400">{discoveredAlts.summary.orphaned}</div>
                    <div className="text-gray-400">Orphaned</div>
                  </div>
                  <div className="text-center">
                    <div className="text-2xl font-bold text-yellow-400">{discoveredAlts.summary.deactivated}</div>
                    <div className="text-gray-400">Deactivated</div>
                  </div>
                  <div className="text-center">
                    <div className="text-2xl font-bold text-green-400">{discoveredAlts.summary.closeable}</div>
                    <div className="text-gray-400">Closeable</div>
                  </div>
                  <div className="text-center">
                    <div className="text-2xl font-bold text-emerald-400">{discoveredAlts.summary.totalRentSOL.toFixed(4)}</div>
                    <div className="text-gray-400">Total Rent (SOL)</div>
                  </div>
                </div>
                {discoveredAlts.summary.recoverableRentSOL > 0 && (
                  <div className="mt-3 text-center text-green-400 text-sm">
                    💰 Recoverable rent from closeable ALTs: <strong>{discoveredAlts.summary.recoverableRentSOL.toFixed(6)} SOL</strong>
                  </div>
                )}
              </div>
            )}

            {/* Bulk Actions */}
            {discoveredAlts && discoveredAlts.alts.length > 0 && (
              <div className="bg-gray-900 rounded p-4 mb-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    <label className="flex items-center gap-2 text-sm text-gray-300">
                      <input
                        type="checkbox"
                        checked={selectedAlts.size === discoveredAlts.alts.length && selectedAlts.size > 0}
                        onChange={toggleSelectAll}
                        className="rounded"
                      />
                      Select All ({selectedAlts.size} selected)
                    </label>
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={handleBulkDeactivate}
                      disabled={loading || bulkProcessing || selectedAlts.size === 0}
                      className="px-3 py-1.5 bg-orange-600 text-white rounded hover:bg-orange-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-sm"
                    >
                      {bulkProcessing ? '⏳ Processing...' : '🔶 Bulk Deactivate'}
                    </button>
                    <button
                      onClick={handleBulkClose}
                      disabled={loading || bulkProcessing || selectedAlts.size === 0}
                      className="px-3 py-1.5 bg-red-600 text-white rounded hover:bg-red-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-sm"
                    >
                      {bulkProcessing ? '⏳ Processing...' : '❌ Bulk Close'}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* ALT List by Status Groups */}
            {groupedAlts && (
              <div className="space-y-4">
                {/* Closeable ALTs - Most Important */}
                {groupedAlts.closeable.length > 0 && (
                  <div className="bg-green-900/20 border border-green-700/50 rounded p-4">
                    <h4 className="text-green-400 font-semibold mb-3">
                      ✅ Ready to Close ({groupedAlts.closeable.length}) - Recover {groupedAlts.closeable.reduce((sum, a) => sum + parseFloat(a.rentSOL), 0).toFixed(4)} SOL
                    </h4>
                    <div className="space-y-2">
                      {groupedAlts.closeable.map((alt) => (
                        <AltRow
                          key={alt.address}
                          alt={alt}
                          selected={selectedAlts.has(alt.address)}
                          onToggle={() => toggleSelectAlt(alt.address)}
                          onDeactivate={() => handleDeactivateByAddress(alt.address)}
                          onClose={() => handleCloseByAddress(alt.address, alt.rentSOL)}
                          processing={processingAddress === alt.address}
                          disabled={loading}
                          getStatusBadge={getStatusBadge}
                          truncateAddress={truncateAddress}
                        />
                      ))}
                    </div>
                  </div>
                )}

                {/* Deactivated but not closeable yet */}
                {groupedAlts.deactivated.length > 0 && (
                  <div className="bg-yellow-900/20 border border-yellow-700/50 rounded p-4">
                    <h4 className="text-yellow-400 font-semibold mb-3">
                      ⏳ Deactivated - Waiting ({groupedAlts.deactivated.length})
                    </h4>
                    <div className="space-y-2">
                      {groupedAlts.deactivated.map((alt) => (
                        <AltRow
                          key={alt.address}
                          alt={alt}
                          selected={selectedAlts.has(alt.address)}
                          onToggle={() => toggleSelectAlt(alt.address)}
                          onDeactivate={() => handleDeactivateByAddress(alt.address)}
                          onClose={() => handleCloseByAddress(alt.address, alt.rentSOL)}
                          processing={processingAddress === alt.address}
                          disabled={loading}
                          getStatusBadge={getStatusBadge}
                          truncateAddress={truncateAddress}
                        />
                      ))}
                    </div>
                  </div>
                )}

                {/* Orphaned ALTs - Important to show */}
                {groupedAlts.orphaned.length > 0 && (
                  <div className="bg-orange-900/20 border border-orange-700/50 rounded p-4">
                    <h4 className="text-orange-400 font-semibold mb-3">
                      ⚠️ Orphaned - Not in Config ({groupedAlts.orphaned.length})
                    </h4>
                    <p className="text-orange-300/70 text-xs mb-3">
                      These ALTs are owned by your wallet but not tracked in config. They may be from previous sessions or created manually.
                    </p>
                    <div className="space-y-2">
                      {groupedAlts.orphaned.map((alt) => (
                        <AltRow
                          key={alt.address}
                          alt={alt}
                          selected={selectedAlts.has(alt.address)}
                          onToggle={() => toggleSelectAlt(alt.address)}
                          onDeactivate={() => handleDeactivateByAddress(alt.address)}
                          onClose={() => handleCloseByAddress(alt.address, alt.rentSOL)}
                          processing={processingAddress === alt.address}
                          disabled={loading}
                          getStatusBadge={getStatusBadge}
                          truncateAddress={truncateAddress}
                        />
                      ))}
                    </div>
                  </div>
                )}

                {/* Active tracked ALTs */}
                {groupedAlts.active.length > 0 && (
                  <div className="bg-blue-900/20 border border-blue-700/50 rounded p-4">
                    <h4 className="text-blue-400 font-semibold mb-3">
                      🔵 Active Tracked ALTs ({groupedAlts.active.length})
                    </h4>
                    <div className="space-y-2">
                      {groupedAlts.active.map((alt) => (
                        <AltRow
                          key={alt.address}
                          alt={alt}
                          selected={selectedAlts.has(alt.address)}
                          onToggle={() => toggleSelectAlt(alt.address)}
                          onDeactivate={() => handleDeactivateByAddress(alt.address)}
                          onClose={() => handleCloseByAddress(alt.address, alt.rentSOL)}
                          processing={processingAddress === alt.address}
                          disabled={loading}
                          getStatusBadge={getStatusBadge}
                          truncateAddress={truncateAddress}
                        />
                      ))}
                    </div>
                  </div>
                )}

                {discoveredAlts.alts.length === 0 && (
                  <div className="text-center text-gray-400 py-8">
                    No ALTs found for this wallet. Use the "Create DEX ALTs" tab to create new ones.
                  </div>
                )}
              </div>
            )}

            {discoverLoading && (
              <div className="text-center text-gray-400 py-8">
                <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-white"></div>
                <p className="mt-2">Scanning blockchain for wallet ALTs...</p>
              </div>
            )}
          </div>
        )}

        {/* Create DEX ALTs Tab */}
        {activeTab === 'create' && (
          <div className="space-y-4">
            {/* Static ALTs Section */}
            <div className="bg-gradient-to-r from-green-900/30 to-teal-900/30 border border-green-700/50 rounded-lg p-4">
              <h4 className="text-white font-semibold mb-3 flex items-center gap-2">
                🔧 Static ALTs (Programs, Configs, User ATAs)
              </h4>
              <p className="text-gray-400 text-sm mb-4">
                These ALTs contain system programs, DEX configs, common mints, and user token accounts.
                Extend them to add any new accounts from the latest configuration.
              </p>
              
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {/* Common ALT */}
                <div className="bg-gray-800/50 rounded p-3">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-white font-medium">🔧 Common</span>
                    {altStatus?.addresses?.common ? (
                      <span className="text-xs text-green-400">Active</span>
                    ) : (
                      <span className="text-xs text-gray-500">Not Created</span>
                    )}
                  </div>
                  <p className="text-xs text-gray-400 mb-2">
                    System programs, DEX programs, CLMM configs, common mints
                  </p>
                  {altStatus?.addresses?.common ? (
                    <button
                      onClick={handleExtendAutoCommon}
                      disabled={extendingCommon || loading}
                      className="w-full px-3 py-1.5 bg-green-600 text-white rounded hover:bg-green-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-sm"
                    >
                      {extendingCommon ? '⏳ Extending...' : '🔄 Extend with New Accounts'}
                    </button>
                  ) : (
                    <button
                      onClick={async () => {
                        setLoading(true);
                        setError(null);
                        try {
                          const resp = await fetch(`${apiBase}${ROUTES.arb.alts.createCommon}`, {
                            method: 'POST',
                          });
                          if (!resp.ok) {
                            const data = await resp.json();
                            throw new Error(data.error || 'Failed to create');
                          }
                          const data = await resp.json();
                          setSuccess(`Created common ALT: ${data.address} (${data.accountCount} accounts)`);
                          await loadAltStatus();
                          await discoverAllAlts();
                        } catch (err: any) {
                          setError(err.message);
                        } finally {
                          setLoading(false);
                        }
                      }}
                      disabled={loading}
                      className="w-full px-3 py-1.5 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-sm"
                    >
                      ➕ Create ALT
                    </button>
                  )}
                </div>

                {/* Flashloan ALT */}
                <div className="bg-gray-800/50 rounded p-3">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-white font-medium">⚡ Flashloan</span>
                    {altStatus?.addresses?.flashloan ? (
                      <span className="text-xs text-green-400">Active</span>
                    ) : (
                      <span className="text-xs text-gray-500">Not Created</span>
                    )}
                  </div>
                  <p className="text-xs text-gray-400 mb-2">
                    Vault PDAs, vault token accounts for flashloans
                  </p>
                  {altStatus?.addresses?.flashloan ? (
                    <span className="text-xs text-gray-500 block text-center py-1.5">
                      ✓ Configured
                    </span>
                  ) : (
                    <button
                      onClick={async () => {
                        setLoading(true);
                        setError(null);
                        try {
                          const resp = await fetch(`${apiBase}${ROUTES.arb.alts.createFlashloan}`, {
                            method: 'POST',
                          });
                          if (!resp.ok) {
                            const data = await resp.json();
                            throw new Error(data.error || 'Failed to create');
                          }
                          const data = await resp.json();
                          setSuccess(`Created flashloan ALT: ${data.address} (${data.accountCount} accounts)`);
                          await loadAltStatus();
                          await discoverAllAlts();
                        } catch (err: any) {
                          setError(err.message);
                        } finally {
                          setLoading(false);
                        }
                      }}
                      disabled={loading}
                      className="w-full px-3 py-1.5 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-sm"
                    >
                      ➕ Create ALT
                    </button>
                  )}
                </div>

                {/* User PDAs ALT */}
                <div className="bg-gray-800/50 rounded p-3">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-white font-medium">👤 User PDAs</span>
                    {altStatus?.addresses?.userPdas ? (
                      <span className="text-xs text-green-400">Active</span>
                    ) : (
                      <span className="text-xs text-gray-500">Not Created</span>
                    )}
                  </div>
                  <p className="text-xs text-gray-400 mb-2">
                    User ATAs for common mints (WSOL, USDC, etc.)
                  </p>
                  {altStatus?.addresses?.userPdas ? (
                    <button
                      onClick={handleExtendAutoUserPdas}
                      disabled={extendingUserPdas || loading}
                      className="w-full px-3 py-1.5 bg-green-600 text-white rounded hover:bg-green-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-sm"
                    >
                      {extendingUserPdas ? '⏳ Extending...' : '🔄 Extend with New Accounts'}
                    </button>
                  ) : (
                    <button
                      onClick={async () => {
                        setLoading(true);
                        setError(null);
                        try {
                          const resp = await fetch(`${apiBase}${ROUTES.arb.alts.createUserPdas}`, {
                            method: 'POST',
                          });
                          if (!resp.ok) {
                            const data = await resp.json();
                            throw new Error(data.error || 'Failed to create');
                          }
                          const data = await resp.json();
                          setSuccess(`Created user PDAs ALT: ${data.address} (${data.accountCount} accounts)`);
                          await loadAltStatus();
                          await discoverAllAlts();
                        } catch (err: any) {
                          setError(err.message);
                        } finally {
                          setLoading(false);
                        }
                      }}
                      disabled={loading}
                      className="w-full px-3 py-1.5 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-sm"
                    >
                      ➕ Create ALT
                    </button>
                  )}
                </div>
              </div>
            </div>

            {/* Manual Account Extension Section */}
            <div className="bg-gradient-to-r from-purple-900/30 to-blue-900/30 border border-purple-700/50 rounded-lg p-4">
              <h4 className="text-white font-semibold mb-3 flex items-center gap-2">
                ✏️ Manually Add Accounts to ALT
              </h4>
              <p className="text-gray-400 text-sm mb-3">
                Add custom public keys to an existing ALT. Useful for adding program IDs, PDAs, or other frequently-used accounts.
              </p>
              
              <div className="flex gap-3 mb-3">
                <div className="flex-1">
                  <label className="text-sm text-gray-400 block mb-1">Target ALT Category</label>
                  <select
                    value={manualExtendCategory}
                    onChange={(e) => setManualExtendCategory(e.target.value)}
                    className="w-full bg-gray-800 text-white px-3 py-2 rounded border border-gray-700 focus:border-purple-500 focus:outline-none"
                  >
                    <option value="common">Common (Programs & System)</option>
                    <option value="flashloan">Flashloan (Vaults & PDAs)</option>
                    <option value="user-pdas">User PDAs</option>
                    {altStatus?.categories
                      .filter(c => !['common', 'flashloan', 'user-pdas'].includes(c))
                      .map(category => (
                        <option key={category} value={category}>{category}</option>
                      ))
                    }
                  </select>
                </div>
              </div>
              
              <div className="mb-3">
                <label className="text-sm text-gray-400 block mb-1">
                  Public Keys (one per line or comma-separated)
                </label>
                <textarea
                  value={manualAccounts}
                  onChange={(e) => setManualAccounts(e.target.value)}
                  placeholder="Enter Solana public keys...&#10;TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA&#10;11111111111111111111111111111111"
                  className="w-full bg-gray-800 text-white px-3 py-2 rounded border border-gray-700 focus:border-purple-500 focus:outline-none font-mono text-sm h-28 resize-y"
                />
                <div className="text-xs text-gray-500 mt-1">
                  {manualAccounts.split(/[\n,\s]+/).filter(a => a.trim().length > 0).length} account(s) entered
                </div>
              </div>
              
              <button
                onClick={handleManualExtend}
                disabled={manualExtending || manualAccounts.trim().length === 0}
                className="px-4 py-2 bg-purple-600 text-white rounded hover:bg-purple-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-sm font-medium"
              >
                {manualExtending ? '⏳ Adding...' : `➕ Add to ${manualExtendCategory} ALT`}
              </button>
            </div>

            <div className="border-t border-gray-700 pt-4">
              <h4 className="text-gray-400 text-sm font-medium mb-3">DEX Pool ALTs</h4>
            </div>

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
          </div>
        )}

        {loading && !discoverLoading && (
          <div className="mt-4 text-center text-gray-400">
            <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-white"></div>
            <p className="mt-2">Processing...</p>
          </div>
        )}
      </div>
    </div>
  );
};

// Separate component for ALT row to keep code clean
const AltRow: React.FC<{
  alt: DiscoveredAlt;
  selected: boolean;
  onToggle: () => void;
  onDeactivate: () => void;
  onClose: () => void;
  processing: boolean;
  disabled: boolean;
  getStatusBadge: (alt: DiscoveredAlt) => React.ReactNode;
  truncateAddress: (addr: string) => string;
}> = ({ alt, selected, onToggle, onDeactivate, onClose, processing, disabled, getStatusBadge, truncateAddress }) => {
  return (
    <div className="flex items-center justify-between bg-gray-800/50 rounded p-3">
      <div className="flex items-center gap-3">
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggle}
          className="rounded"
        />
        <div>
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm text-gray-200">{truncateAddress(alt.address)}</span>
            {getStatusBadge(alt)}
          </div>
          <div className="flex items-center gap-3 text-xs text-gray-400 mt-1">
            <span>{alt.accountCount} accounts</span>
            <span>{alt.rentSOL} SOL</span>
            {alt.category && <span className="text-blue-400">({alt.category})</span>}
          </div>
        </div>
      </div>
      <div className="flex gap-2">
        {alt.canClose ? (
          <button
            onClick={onClose}
            disabled={disabled || processing}
            className="px-2 py-1 bg-green-600 text-white rounded hover:bg-green-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-xs"
          >
            {processing ? '⏳' : `💰 Close & Recover`}
          </button>
        ) : alt.isDeactivated ? (
          <span className="text-xs text-yellow-400 px-2 py-1">⏳ Waiting ~5min</span>
        ) : (
          <button
            onClick={onDeactivate}
            disabled={disabled || processing}
            className="px-2 py-1 bg-orange-600 text-white rounded hover:bg-orange-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-xs"
          >
            {processing ? '⏳' : '🔶 Deactivate'}
          </button>
        )}
        <a
          href={`https://solscan.io/account/${alt.address}`}
          target="_blank"
          rel="noopener noreferrer"
          className="px-2 py-1 bg-gray-700 text-gray-300 rounded hover:bg-gray-600 text-xs"
        >
          🔗
        </a>
      </div>
    </div>
  );
};
