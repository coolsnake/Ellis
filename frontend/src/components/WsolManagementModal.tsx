// @ts-nocheck
import React, { useState, useEffect, useCallback } from 'react';
import { ROUTES } from '../utils/routes';

interface WsolModeConfig {
  usePreWrappedWsol: boolean;
  keepWsolAfterExecution: boolean;
}

interface WalletBalances {
  sol: number;
  tokens: { [mint: string]: number };
}

const WSOL_MINT = 'So11111111111111111111111111111111111111112';

export const WsolManagementModal: React.FC<{ onClose: () => void; apiBase: string }> = ({ onClose, apiBase }) => {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  
  // Balances
  const [solBalance, setSolBalance] = useState<number>(0);
  const [wsolBalance, setWsolBalance] = useState<number>(0);
  
  // WSOL mode settings
  const [wsolMode, setWsolMode] = useState<WsolModeConfig>({
    usePreWrappedWsol: false,
    keepWsolAfterExecution: false,
  });
  
  // Wrap/unwrap state
  const [wrapAmount, setWrapAmount] = useState<string>('');
  const [wrapping, setWrapping] = useState(false);
  const [unwrapping, setUnwrapping] = useState(false);
  const [savingMode, setSavingMode] = useState(false);

  // Fetch balances and WSOL mode
  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      
      // Fetch balances and WSOL mode in parallel
      const [balancesRes, wsolModeRes] = await Promise.all([
        fetch(`${apiBase}${ROUTES.wallet.base}`),
        fetch(`${apiBase}${ROUTES.router.wsolMode}`),
      ]);
      
      if (balancesRes.ok) {
        const data = await balancesRes.json();
        setSolBalance(data.balances?.sol || 0);
        setWsolBalance(data.balances?.tokens?.[WSOL_MINT] || 0);
      }
      
      if (wsolModeRes.ok) {
        const data = await wsolModeRes.json();
        setWsolMode({
          usePreWrappedWsol: data.usePreWrappedWsol ?? false,
          keepWsolAfterExecution: data.keepWsolAfterExecution ?? false,
        });
      }
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setLoading(false);
    }
  }, [apiBase]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Handle wrap SOL
  const handleWrap = async () => {
    const amount = parseFloat(wrapAmount);
    if (!isFinite(amount) || amount <= 0) {
      setError('Enter a valid amount to wrap');
      return;
    }
    if (amount > solBalance) {
      setError(`Insufficient SOL balance (${solBalance.toFixed(4)} available)`);
      return;
    }
    
    try {
      setWrapping(true);
      setError(null);
      setSuccess(null);
      
      const res = await fetch(`${apiBase}${ROUTES.wallet.wrap}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount }),
      });
      
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Wrap failed');
      
      setSuccess(`Wrapped ${amount} SOL successfully!`);
      setWrapAmount('');
      
      // Refresh balances
      await fetchData();
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setWrapping(false);
    }
  };

  // Handle unwrap all WSOL
  const handleUnwrap = async () => {
    if (wsolBalance <= 0) {
      setError('No WSOL to unwrap');
      return;
    }
    
    try {
      setUnwrapping(true);
      setError(null);
      setSuccess(null);
      
      const res = await fetch(`${apiBase}${ROUTES.wallet.unwrap}`, {
        method: 'POST',
      });
      
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Unwrap failed');
      
      setSuccess(`Unwrapped ${wsolBalance.toFixed(4)} WSOL successfully!`);
      
      // Refresh balances
      await fetchData();
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setUnwrapping(false);
    }
  };

  // Handle WSOL mode toggle
  const handleModeChange = async (usePreWrapped: boolean, keepWsol: boolean) => {
    try {
      setSavingMode(true);
      setError(null);
      setSuccess(null);
      
      const res = await fetch(`${apiBase}${ROUTES.router.wsolMode}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          usePreWrappedWsol: usePreWrapped,
          keepWsolAfterExecution: keepWsol,
        }),
      });
      
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Failed to update WSOL mode');
      
      setWsolMode({
        usePreWrappedWsol: usePreWrapped,
        keepWsolAfterExecution: keepWsol,
      });
      
      setSuccess('WSOL mode updated!');
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setSavingMode(false);
    }
  };

  // Quick enable/disable all
  const enableWsolMode = () => handleModeChange(true, true);
  const disableWsolMode = () => handleModeChange(false, false);

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div 
        className="bg-gray-900 rounded-lg shadow-xl w-full max-w-md mx-4 max-h-[90vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-gray-700">
          <h2 className="text-lg font-semibold text-white">WSOL Management</h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="p-4 space-y-6">
          {/* Error/Success Messages */}
          {error && (
            <div className="bg-red-900/50 border border-red-500 text-red-200 px-3 py-2 rounded text-sm">
              {error}
            </div>
          )}
          {success && (
            <div className="bg-green-900/50 border border-green-500 text-green-200 px-3 py-2 rounded text-sm">
              {success}
            </div>
          )}

          {loading ? (
            <div className="text-center py-8 text-gray-400">Loading...</div>
          ) : (
            <>
              {/* Balances Section */}
              <div className="space-y-3">
                <h3 className="text-sm font-medium text-gray-300 uppercase tracking-wide">Balances</h3>
                <div className="grid grid-cols-2 gap-3">
                  <div className="bg-gray-800 rounded-lg p-3">
                    <div className="text-xs text-gray-400 mb-1">Native SOL</div>
                    <div className="text-lg font-mono text-white">{solBalance.toFixed(4)}</div>
                  </div>
                  <div className="bg-gray-800 rounded-lg p-3">
                    <div className="text-xs text-gray-400 mb-1">Wrapped SOL</div>
                    <div className="text-lg font-mono text-amber-400">{wsolBalance.toFixed(4)}</div>
                  </div>
                </div>
              </div>

              {/* Wrap Section */}
              <div className="space-y-3">
                <h3 className="text-sm font-medium text-gray-300 uppercase tracking-wide">Wrap SOL</h3>
                <div className="flex gap-2">
                  <input
                    type="number"
                    value={wrapAmount}
                    onChange={e => setWrapAmount(e.target.value)}
                    placeholder="Amount to wrap"
                    step="0.01"
                    min="0"
                    max={solBalance}
                    className="flex-1 bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
                  />
                  <button
                    onClick={handleWrap}
                    disabled={wrapping || !wrapAmount}
                    className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 disabled:text-gray-500 text-white rounded font-medium transition-colors"
                  >
                    {wrapping ? 'Wrapping...' : 'Wrap'}
                  </button>
                </div>
                <div className="flex gap-2">
                  {[0.1, 0.5, 1, 5].map(amt => (
                    <button
                      key={amt}
                      onClick={() => setWrapAmount(String(Math.min(amt, solBalance)))}
                      className="flex-1 px-2 py-1 text-xs bg-gray-800 hover:bg-gray-700 text-gray-300 rounded transition-colors"
                    >
                      {amt} SOL
                    </button>
                  ))}
                  <button
                    onClick={() => setWrapAmount(String(Math.max(0, solBalance - 0.01)))}
                    className="flex-1 px-2 py-1 text-xs bg-gray-800 hover:bg-gray-700 text-gray-300 rounded transition-colors"
                  >
                    Max
                  </button>
                </div>
              </div>

              {/* Unwrap Section */}
              <div className="space-y-3">
                <h3 className="text-sm font-medium text-gray-300 uppercase tracking-wide">Unwrap WSOL</h3>
                <button
                  onClick={handleUnwrap}
                  disabled={unwrapping || wsolBalance <= 0}
                  className="w-full px-4 py-2 bg-amber-600 hover:bg-amber-700 disabled:bg-gray-700 disabled:text-gray-500 text-white rounded font-medium transition-colors"
                >
                  {unwrapping ? 'Unwrapping...' : `Unwrap All (${wsolBalance.toFixed(4)} WSOL)`}
                </button>
              </div>

              {/* WSOL Mode Section */}
              <div className="space-y-3">
                <h3 className="text-sm font-medium text-gray-300 uppercase tracking-wide">WSOL Mode</h3>
                <p className="text-xs text-gray-500">
                  Enable WSOL mode to save up to 4 instructions per SOL transaction, reducing transaction size.
                </p>
                
                <div className="space-y-2">
                  {/* Use Pre-wrapped WSOL Toggle */}
                  <label className="flex items-center justify-between bg-gray-800 rounded-lg p-3 cursor-pointer hover:bg-gray-750">
                    <div>
                      <div className="text-sm text-white">Use Pre-wrapped WSOL</div>
                      <div className="text-xs text-gray-500">Skip wrap instructions if WSOL balance is sufficient</div>
                    </div>
                    <input
                      type="checkbox"
                      checked={wsolMode.usePreWrappedWsol}
                      onChange={e => handleModeChange(e.target.checked, wsolMode.keepWsolAfterExecution)}
                      disabled={savingMode}
                      className="w-5 h-5 rounded bg-gray-700 border-gray-600 text-blue-500 focus:ring-blue-500 focus:ring-offset-gray-900"
                    />
                  </label>

                  {/* Keep WSOL After Execution Toggle */}
                  <label className="flex items-center justify-between bg-gray-800 rounded-lg p-3 cursor-pointer hover:bg-gray-750">
                    <div>
                      <div className="text-sm text-white">Keep WSOL After Execution</div>
                      <div className="text-xs text-gray-500">Don't auto-unwrap WSOL to native SOL</div>
                    </div>
                    <input
                      type="checkbox"
                      checked={wsolMode.keepWsolAfterExecution}
                      onChange={e => handleModeChange(wsolMode.usePreWrappedWsol, e.target.checked)}
                      disabled={savingMode}
                      className="w-5 h-5 rounded bg-gray-700 border-gray-600 text-blue-500 focus:ring-blue-500 focus:ring-offset-gray-900"
                    />
                  </label>
                </div>

                {/* Quick Mode Buttons */}
                <div className="flex gap-2 pt-2">
                  <button
                    onClick={enableWsolMode}
                    disabled={savingMode || (wsolMode.usePreWrappedWsol && wsolMode.keepWsolAfterExecution)}
                    className="flex-1 px-3 py-2 bg-green-600 hover:bg-green-700 disabled:bg-gray-700 disabled:text-gray-500 text-white rounded text-sm font-medium transition-colors"
                  >
                    Enable Both
                  </button>
                  <button
                    onClick={disableWsolMode}
                    disabled={savingMode || (!wsolMode.usePreWrappedWsol && !wsolMode.keepWsolAfterExecution)}
                    className="flex-1 px-3 py-2 bg-red-600 hover:bg-red-700 disabled:bg-gray-700 disabled:text-gray-500 text-white rounded text-sm font-medium transition-colors"
                  >
                    Disable Both
                  </button>
                </div>
              </div>

              {/* Info Section */}
              <div className="bg-gray-800/50 rounded-lg p-3 text-xs text-gray-400 space-y-1">
                <div className="font-medium text-gray-300">Transaction Size Savings:</div>
                <ul className="list-disc list-inside space-y-0.5">
                  <li>Pre-wrapped WSOL: saves 3 instructions (create ATA + transfer + sync)</li>
                  <li>Keep WSOL: saves 1 instruction (close/unwrap)</li>
                  <li>Total potential savings: ~200-300 bytes per SOL transaction</li>
                </ul>
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 p-4 border-t border-gray-700">
          <button
            onClick={fetchData}
            disabled={loading}
            className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded font-medium transition-colors"
          >
            Refresh
          </button>
          <button
            onClick={onClose}
            className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded font-medium transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};

export default WsolManagementModal;
