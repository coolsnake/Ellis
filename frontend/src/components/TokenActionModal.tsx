import React, { useState, useEffect, useCallback } from 'react';
import { ROUTES } from '../utils/routes';

interface TokenInfo {
  mint: string;
  symbol: string;
  balance: number;
}

interface TokenActionModalProps {
  tokens: TokenInfo[];
  initialToken?: TokenInfo;
  prices: Record<string, { usdc: number | null; sol: number | null }>;
  onClose: () => void;
  apiBase: string;
  onSuccess: () => void;
}

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

export const TokenActionModal: React.FC<TokenActionModalProps> = ({
  tokens,
  initialToken,
  prices,
  onClose,
  apiBase,
  onSuccess,
}) => {
  const [selectedTokenMint, setSelectedTokenMint] = useState<string>(initialToken?.mint || tokens[0]?.mint || '');
  
  // Get the currently selected token
  const token = tokens.find(t => t.mint === selectedTokenMint) || tokens[0];
  const [tab, setTab] = useState<'send' | 'swap'>('swap');
  const [amount, setAmount] = useState('');
  const [percentage, setPercentage] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Send state
  const [destination, setDestination] = useState('');

  // Swap state
  const [targetToken, setTargetToken] = useState<'SOL' | 'USDC'>('SOL');
  const [estimatedOutput, setEstimatedOutput] = useState<number | null>(null);

  // Calculate estimated output for swap
  useEffect(() => {
    if (tab !== 'swap' || !amount || Number(amount) <= 0) {
      setEstimatedOutput(null);
      return;
    }

    const inputPrice = prices[token.mint]?.usdc;
    const targetMint = targetToken === 'SOL' ? SOL_MINT : USDC_MINT;
    const outputPrice = targetToken === 'USDC' ? 1 : prices[targetMint]?.usdc;

    if (inputPrice && outputPrice && outputPrice > 0) {
      const inputValue = Number(amount) * inputPrice;
      setEstimatedOutput(inputValue / outputPrice);
    } else {
      setEstimatedOutput(null);
    }
  }, [amount, tab, targetToken, prices, token.mint]);

  // Handle percentage selection
  const handlePercentage = useCallback((pct: number) => {
    setPercentage(pct);
    const newAmount = (token.balance * pct / 100);
    setAmount(newAmount.toFixed(6));
  }, [token.balance]);

  // Handle amount change (reset percentage selection)
  const handleAmountChange = (value: string) => {
    setAmount(value);
    setPercentage(null);
  };

  // Handle send
  const handleSend = async () => {
    if (!destination.trim()) {
      setError('Please enter a destination address');
      return;
    }
    if (!amount || Number(amount) <= 0) {
      setError('Please enter a valid amount');
      return;
    }
    if (Number(amount) > token.balance) {
      setError(`Insufficient balance (${token.balance.toFixed(6)} available)`);
      return;
    }

    try {
      setLoading(true);
      setError(null);
      setSuccess(null);

      const res = await fetch(`${apiBase}${ROUTES.wallet.send}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: token.mint,
          destination: destination.trim(),
          amount: Number(amount),
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Send failed');

      setSuccess(`Sent ${amount} ${token.symbol} successfully! Signature: ${data.signature?.slice(0, 8)}...`);
      onSuccess();
      
      // Close modal after short delay
      setTimeout(() => onClose(), 2000);
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setLoading(false);
    }
  };

  // Handle swap
  const handleSwap = async () => {
    if (!amount || Number(amount) <= 0) {
      setError('Please enter a valid amount');
      return;
    }
    if (Number(amount) > token.balance) {
      setError(`Insufficient balance (${token.balance.toFixed(6)} available)`);
      return;
    }

    // Don't swap to the same token
    const targetMint = targetToken === 'SOL' ? SOL_MINT : USDC_MINT;
    if (token.mint === targetMint) {
      setError(`Cannot swap ${token.symbol} to itself`);
      return;
    }

    try {
      setLoading(true);
      setError(null);
      setSuccess(null);

      const res = await fetch(`${apiBase}${ROUTES.swap}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: token.mint,
          to: targetMint,
          amount: Number(amount),
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Swap failed');

      setSuccess(`Swapped ${amount} ${token.symbol} to ${targetToken} successfully! Signature: ${data.signature?.slice(0, 8)}...`);
      onSuccess();
      
      // Close modal after short delay
      setTimeout(() => onClose(), 2000);
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setLoading(false);
    }
  };

  // Reset amount when token changes
  useEffect(() => {
    setAmount('');
    setPercentage(null);
  }, [selectedTokenMint]);

  // Get token USD value
  const tokenUsdValue = token ? prices[token.mint]?.usdc : null;
  const amountUsdValue = tokenUsdValue && amount ? Number(amount) * tokenUsdValue : null;

  if (!token) {
    return (
      <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
        <div className="bg-gray-900 rounded-lg shadow-xl w-full max-w-md mx-4 p-6" onClick={(e) => e.stopPropagation()}>
          <p className="text-gray-400">No tokens available to manage.</p>
          <button onClick={onClose} className="mt-4 px-4 py-2 bg-gray-700 text-white rounded">Close</button>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-gray-900 rounded-lg shadow-xl w-full max-w-md mx-4 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-gray-700">
          <div>
            <h2 className="text-lg font-semibold text-white">Manage Tokens</h2>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Token Selector */}
        <div className="p-4 border-b border-gray-700">
          <label className="block text-sm font-medium text-gray-300 mb-2">Select Token</label>
          <select
            value={selectedTokenMint}
            onChange={(e) => setSelectedTokenMint(e.target.value)}
            className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white focus:outline-none focus:border-blue-500"
          >
            {tokens.map((t) => (
              <option key={t.mint} value={t.mint}>
                {t.symbol} - {t.balance.toFixed(6)} {prices[t.mint]?.usdc ? `($${(t.balance * prices[t.mint]!.usdc!).toFixed(2)})` : ''}
              </option>
            ))}
          </select>
          <div className="mt-2 text-sm text-gray-400">
            Balance: {token.balance.toFixed(6)} {token.symbol}
            {tokenUsdValue && <span className="ml-2">(${(token.balance * tokenUsdValue).toFixed(2)})</span>}
          </div>
        </div>

        {/* Tab Switcher */}
        <div className="flex border-b border-gray-700">
          <button
            onClick={() => setTab('swap')}
            className={`flex-1 px-4 py-3 text-sm font-medium transition-colors ${
              tab === 'swap'
                ? 'text-blue-400 border-b-2 border-blue-400 bg-gray-800/50'
                : 'text-gray-400 hover:text-white'
            }`}
          >
            Swap
          </button>
          <button
            onClick={() => setTab('send')}
            className={`flex-1 px-4 py-3 text-sm font-medium transition-colors ${
              tab === 'send'
                ? 'text-blue-400 border-b-2 border-blue-400 bg-gray-800/50'
                : 'text-gray-400 hover:text-white'
            }`}
          >
            Send
          </button>
        </div>

        {/* Content */}
        <div className="p-4 space-y-4">
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

          {/* Amount Input */}
          <div className="space-y-2">
            <label className="block text-sm font-medium text-gray-300">Amount</label>
            <input
              type="number"
              value={amount}
              onChange={(e) => handleAmountChange(e.target.value)}
              placeholder={`0.00 ${token.symbol}`}
              step="any"
              min="0"
              max={token.balance}
              className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
            />
            {amountUsdValue !== null && amount && (
              <div className="text-xs text-gray-500">~${amountUsdValue.toFixed(2)} USD</div>
            )}
          </div>

          {/* Percentage Shortcuts */}
          <div className="flex gap-2">
            {[25, 50, 75, 100].map((pct) => (
              <button
                key={pct}
                onClick={() => handlePercentage(pct)}
                className={`flex-1 px-2 py-1.5 text-xs rounded font-medium transition-colors ${
                  percentage === pct
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
                }`}
              >
                {pct}%
              </button>
            ))}
          </div>

          {/* Swap-specific: Target Token */}
          {tab === 'swap' && (
            <div className="space-y-2">
              <label className="block text-sm font-medium text-gray-300">Swap To</label>
              <div className="flex gap-2">
                {(['SOL', 'USDC'] as const).map((t) => {
                  const isDisabled = 
                    (t === 'SOL' && token.mint === SOL_MINT) ||
                    (t === 'USDC' && token.mint === USDC_MINT);
                  return (
                    <button
                      key={t}
                      onClick={() => !isDisabled && setTargetToken(t)}
                      disabled={isDisabled}
                      className={`flex-1 px-3 py-2 rounded font-medium transition-colors ${
                        targetToken === t
                          ? 'bg-blue-600 text-white'
                          : isDisabled
                          ? 'bg-gray-800 text-gray-600 cursor-not-allowed'
                          : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
                      }`}
                    >
                      {t}
                    </button>
                  );
                })}
              </div>

              {/* Estimated Output */}
              {estimatedOutput !== null && (
                <div className="bg-gray-800 rounded-lg p-3 mt-3">
                  <div className="text-xs text-gray-400 mb-1">Estimated Output</div>
                  <div className="text-lg font-mono text-green-400">
                    ~{estimatedOutput.toFixed(6)} {targetToken}
                  </div>
                  <div className="text-xs text-gray-500 mt-1">
                    Final amount may vary due to slippage and market conditions
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Send-specific: Destination */}
          {tab === 'send' && (
            <div className="space-y-2">
              <label className="block text-sm font-medium text-gray-300">Destination Address</label>
              <input
                type="text"
                value={destination}
                onChange={(e) => setDestination(e.target.value)}
                placeholder="Enter Solana wallet address"
                className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white placeholder-gray-500 focus:outline-none focus:border-blue-500 font-mono text-sm"
              />
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 p-4 border-t border-gray-700">
          <button
            onClick={onClose}
            disabled={loading}
            className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded font-medium transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={tab === 'swap' ? handleSwap : handleSend}
            disabled={loading || !amount || Number(amount) <= 0 || (tab === 'send' && !destination.trim())}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 disabled:text-gray-500 text-white rounded font-medium transition-colors"
          >
            {loading ? 'Processing...' : tab === 'swap' ? 'Swap' : 'Send'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default TokenActionModal;
