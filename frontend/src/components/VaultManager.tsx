import React, { useState, useEffect, useCallback } from 'react';
import { apiGet, apiPost } from '../utils/api';

// Types matching backend
interface VaultInfo {
  address: string;
  owner: string;
  mint: string;
  tokenAccount: string;
  balance: string;
  borrowedAmount: string;
  availableBalance: string;
  flashLoanActive: boolean;
  bump: number;
  tokenSymbol?: string;
  decimals?: number;
  usdValue?: number;
}

interface VaultsResponse {
  success: boolean;
  vaults: VaultInfo[];
  error?: string;
}

interface TransactionResponse {
  success: boolean;
  signature?: string;
  error?: string;
}

type VaultManagerProps = {
  apiBase: string;
  onClose: () => void;
};

// Common token mints for quick selection
const COMMON_TOKENS = [
  { symbol: 'SOL', mint: 'So11111111111111111111111111111111111111112' },
  { symbol: 'USDC', mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
  { symbol: 'USDT', mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB' },
];

export const VaultManager: React.FC<VaultManagerProps> = ({ apiBase, onClose }) => {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [vaults, setVaults] = useState<VaultInfo[]>([]);
  
  // Action state
  const [actionVault, setActionVault] = useState<VaultInfo | null>(null);
  const [actionType, setActionType] = useState<'deposit' | 'withdraw' | null>(null);
  const [actionAmount, setActionAmount] = useState('');
  const [actionLoading, setActionLoading] = useState(false);
  
  // Init vault state
  const [showInitForm, setShowInitForm] = useState(false);
  const [initMint, setInitMint] = useState('');
  const [initLoading, setInitLoading] = useState(false);

  const fetchVaults = useCallback(async () => {
    try {
      setLoading(true);
      const data = await apiGet<VaultsResponse>('/router/vaults');
      if (data.success) {
        setVaults(data.vaults);
      } else {
        setError(data.error || 'Failed to fetch vaults');
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchVaults();
  }, [fetchVaults]);

  const handleInitVault = async () => {
    if (!initMint || initLoading) return;
    setInitLoading(true);
    setError(null);
    
    try {
      const result = await apiPost<TransactionResponse>(`/router/vaults/${initMint}/init`);
      if (result.success) {
        setShowInitForm(false);
        setInitMint('');
        await fetchVaults();
      } else {
        setError(result.error || 'Failed to initialize vault');
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setInitLoading(false);
    }
  };

  const handleDeposit = async () => {
    if (!actionVault || !actionAmount || actionLoading) return;
    setActionLoading(true);
    setError(null);
    
    try {
      const amount = BigInt(Math.floor(parseFloat(actionAmount) * Math.pow(10, actionVault.decimals || 9)));
      const result = await apiPost<TransactionResponse>(
        `/router/vaults/${actionVault.mint}/deposit`,
        { amount: amount.toString() }
      );
      if (result.success) {
        setActionType(null);
        setActionVault(null);
        setActionAmount('');
        await fetchVaults();
      } else {
        setError(result.error || 'Deposit failed');
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setActionLoading(false);
    }
  };

  const handleWithdraw = async () => {
    if (!actionVault || !actionAmount || actionLoading) return;
    setActionLoading(true);
    setError(null);
    
    try {
      const amount = BigInt(Math.floor(parseFloat(actionAmount) * Math.pow(10, actionVault.decimals || 9)));
      const result = await apiPost<TransactionResponse>(
        `/router/vaults/${actionVault.mint}/withdraw`,
        { amount: amount.toString() }
      );
      if (result.success) {
        setActionType(null);
        setActionVault(null);
        setActionAmount('');
        await fetchVaults();
      } else {
        setError(result.error || 'Withdraw failed');
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setActionLoading(false);
    }
  };

  const handleCloseVault = async (vault: VaultInfo) => {
    if (!confirm(`Are you sure you want to close this vault? Balance must be 0.`)) return;
    
    try {
      const result = await apiPost<TransactionResponse>(`/router/vaults/${vault.mint}/close`);
      if (result.success) {
        await fetchVaults();
      } else {
        setError(result.error || 'Close failed');
      }
    } catch (err: any) {
      setError(err.message);
    }
  };

  const formatBalance = (balance: string, decimals: number = 9) => {
    const num = parseFloat(balance) / Math.pow(10, decimals);
    return num.toLocaleString(undefined, { maximumFractionDigits: 6 });
  };

  const shortenAddress = (addr: string) => {
    return `${addr.slice(0, 4)}...${addr.slice(-4)}`;
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-gray-800 rounded-lg p-6 w-full max-w-4xl max-h-[90vh] overflow-auto">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-2xl font-bold text-white">Vault Manager</h2>
          <button className="text-gray-300 hover:text-white text-xl" onClick={onClose}>✕</button>
        </div>

        {error && (
          <div className="mb-4 p-3 bg-red-900/50 border border-red-600 rounded text-red-300 text-sm">
            {error}
            <button onClick={() => setError(null)} className="ml-2 text-red-400 hover:text-red-300">×</button>
          </div>
        )}

        {/* Header Actions */}
        <div className="mb-6 flex items-center justify-between">
          <div className="text-gray-400 text-sm">
            Manage your flash loan vaults for arbitrage execution
          </div>
          <button
            onClick={() => setShowInitForm(true)}
            className="px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded font-medium"
          >
            + New Vault
          </button>
        </div>

        {/* Init Vault Form */}
        {showInitForm && (
          <div className="mb-6 p-4 bg-gray-700/50 rounded-lg">
            <h3 className="text-lg font-semibold text-white mb-3">Initialize New Vault</h3>
            <div className="flex items-end gap-4">
              <div className="flex-1">
                <label className="block text-gray-400 text-sm mb-1">Token Mint Address</label>
                <input
                  type="text"
                  value={initMint}
                  onChange={(e) => setInitMint(e.target.value)}
                  placeholder="Enter mint address..."
                  className="w-full px-3 py-2 bg-gray-700 text-white border border-gray-600 rounded focus:border-blue-500 focus:outline-none font-mono text-sm"
                />
              </div>
              <button
                onClick={handleInitVault}
                disabled={!initMint || initLoading}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 text-white rounded font-medium"
              >
                {initLoading ? 'Creating...' : 'Create Vault'}
              </button>
              <button
                onClick={() => { setShowInitForm(false); setInitMint(''); }}
                className="px-4 py-2 bg-gray-600 hover:bg-gray-500 text-white rounded"
              >
                Cancel
              </button>
            </div>
            <div className="mt-3 flex gap-2">
              <span className="text-gray-400 text-sm">Quick select:</span>
              {COMMON_TOKENS.map((token) => (
                <button
                  key={token.mint}
                  onClick={() => setInitMint(token.mint)}
                  className="px-2 py-1 bg-gray-600 hover:bg-gray-500 text-gray-300 rounded text-xs"
                >
                  {token.symbol}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Vaults List */}
        {loading ? (
          <div className="text-center text-gray-400 py-8">Loading vaults...</div>
        ) : vaults.length === 0 ? (
          <div className="text-center text-gray-400 py-8">
            No vaults found. Create one to start using flash loans.
          </div>
        ) : (
          <div className="space-y-4">
            {vaults.map((vault) => (
              <div
                key={vault.address}
                className="p-4 bg-gray-700/50 rounded-lg border border-gray-600"
              >
                <div className="flex items-start justify-between">
                  <div>
                    <div className="flex items-center gap-2 mb-2">
                      <span className="text-white font-semibold text-lg">
                        {vault.tokenSymbol || shortenAddress(vault.mint)}
                      </span>
                      {vault.flashLoanActive && (
                        <span className="px-2 py-0.5 bg-yellow-600/50 text-yellow-300 text-xs rounded">
                          Flash Loan Active
                        </span>
                      )}
                    </div>
                    <div className="grid grid-cols-2 gap-x-8 gap-y-1 text-sm">
                      <div>
                        <span className="text-gray-400">Balance:</span>
                        <span className="text-white ml-2 font-mono">
                          {formatBalance(vault.balance, vault.decimals)}
                        </span>
                      </div>
                      <div>
                        <span className="text-gray-400">Available:</span>
                        <span className="text-green-400 ml-2 font-mono">
                          {formatBalance(vault.availableBalance, vault.decimals)}
                        </span>
                      </div>
                      <div>
                        <span className="text-gray-400">Borrowed:</span>
                        <span className={`ml-2 font-mono ${vault.borrowedAmount !== '0' ? 'text-yellow-400' : 'text-gray-500'}`}>
                          {formatBalance(vault.borrowedAmount, vault.decimals)}
                        </span>
                      </div>
                      <div>
                        <span className="text-gray-400">Address:</span>
                        <span className="text-gray-300 ml-2 font-mono text-xs">
                          {shortenAddress(vault.address)}
                        </span>
                      </div>
                    </div>
                  </div>
                  
                  <div className="flex gap-2">
                    <button
                      onClick={() => { setActionVault(vault); setActionType('deposit'); }}
                      className="px-3 py-1 bg-green-600 hover:bg-green-700 text-white rounded text-sm"
                    >
                      Deposit
                    </button>
                    <button
                      onClick={() => { setActionVault(vault); setActionType('withdraw'); }}
                      disabled={vault.availableBalance === '0'}
                      className="px-3 py-1 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-white rounded text-sm"
                    >
                      Withdraw
                    </button>
                    <button
                      onClick={() => handleCloseVault(vault)}
                      disabled={vault.balance !== '0' || vault.flashLoanActive}
                      className="px-3 py-1 bg-red-600 hover:bg-red-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-white rounded text-sm"
                    >
                      Close
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Action Modal */}
        {actionType && actionVault && (
          <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-60">
            <div className="bg-gray-800 rounded-lg p-6 w-full max-w-md">
              <h3 className="text-xl font-bold text-white mb-4">
                {actionType === 'deposit' ? 'Deposit to Vault' : 'Withdraw from Vault'}
              </h3>
              
              <div className="mb-4">
                <label className="block text-gray-400 text-sm mb-1">
                  Amount ({actionVault.tokenSymbol || 'tokens'})
                </label>
                <input
                  type="number"
                  value={actionAmount}
                  onChange={(e) => setActionAmount(e.target.value)}
                  placeholder="0.00"
                  min="0"
                  step="any"
                  className="w-full px-3 py-2 bg-gray-700 text-white border border-gray-600 rounded focus:border-blue-500 focus:outline-none"
                />
                {actionType === 'withdraw' && (
                  <div className="mt-1 text-gray-400 text-sm">
                    Available: {formatBalance(actionVault.availableBalance, actionVault.decimals)}
                    <button
                      onClick={() => setActionAmount((parseFloat(actionVault.availableBalance) / Math.pow(10, actionVault.decimals || 9)).toString())}
                      className="ml-2 text-blue-400 hover:text-blue-300"
                    >
                      Max
                    </button>
                  </div>
                )}
              </div>
              
              <div className="flex gap-3 justify-end">
                <button
                  onClick={() => { setActionType(null); setActionVault(null); setActionAmount(''); }}
                  className="px-4 py-2 bg-gray-600 hover:bg-gray-500 text-white rounded"
                >
                  Cancel
                </button>
                <button
                  onClick={actionType === 'deposit' ? handleDeposit : handleWithdraw}
                  disabled={!actionAmount || parseFloat(actionAmount) <= 0 || actionLoading}
                  className={`px-4 py-2 text-white rounded font-medium ${
                    actionType === 'deposit'
                      ? 'bg-green-600 hover:bg-green-700'
                      : 'bg-blue-600 hover:bg-blue-700'
                  } disabled:bg-gray-600 disabled:cursor-not-allowed`}
                >
                  {actionLoading ? 'Processing...' : actionType === 'deposit' ? 'Deposit' : 'Withdraw'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="flex justify-end gap-3 pt-4 mt-6 border-t border-gray-700">
          <button
            onClick={fetchVaults}
            className="px-4 py-2 bg-gray-600 hover:bg-gray-500 text-white rounded"
          >
            Refresh
          </button>
          <button
            onClick={onClose}
            className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};


