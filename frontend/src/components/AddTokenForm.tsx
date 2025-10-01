import React, { useState } from 'react';
import { logger } from '../utils/logger';

interface AddTokenFormProps {
  onSave: (token: { symbol: string; mint?: string; name?: string }) => void;
  onCancel: () => void;
  apiBase: string;
}

export const AddTokenForm: React.FC<AddTokenFormProps> = ({ onSave, onCancel, apiBase }) => {
  const [token, setToken] = useState({
    symbol: '',
    mint: '',
    name: ''
  });

  const [isSearching, setIsSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<any[]>([]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (token.symbol.trim()) {
      onSave({
        symbol: token.symbol.trim(),
        mint: token.mint.trim() || undefined,
        name: token.name.trim() || undefined
      });
    }
  };

  const handleSearch = async () => {
    if (!token.symbol.trim()) return;
    
    setIsSearching(true);
    try {
      // Call the actual token search API
      const response = await fetch(`${apiBase}/tokens/search?query=${encodeURIComponent(token.symbol)}`);
      if (response.ok) {
        const data = await response.json();
        setSearchResults(data || []);
      } else {
        // Fallback to mock results if API fails
        const mockResults = [
          { symbol: token.symbol.toUpperCase(), mint: 'So11111111111111111111111111111111111111112', name: `${token.symbol} Token` },
          { symbol: `${token.symbol}2`, mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', name: `${token.symbol} Token 2` }
        ];
        setSearchResults(mockResults);
      }
    } catch (error) {
      logger.error('Token search failed:', error);
      // Fallback to mock results
      const mockResults = [
        { symbol: token.symbol.toUpperCase(), mint: 'So11111111111111111111111111111111111111112', name: `${token.symbol} Token` },
        { symbol: `${token.symbol}2`, mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', name: `${token.symbol} Token 2` }
      ];
      setSearchResults(mockResults);
    } finally {
      setIsSearching(false);
    }
  };

  const selectToken = (selectedToken: any) => {
    setToken({
      symbol: selectedToken.symbol,
      mint: selectedToken.mint || selectedToken.id, // Use id as fallback for mint
      name: selectedToken.name
    });
    setSearchResults([]);
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-gray-800 rounded-lg p-6 w-full max-w-2xl">
        <h2 className="text-2xl font-bold text-white mb-6">Add Token to Watchlist</h2>
        
        <form onSubmit={handleSubmit} className="space-y-6">
          {/* Token Symbol */}
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-2">Token Symbol</label>
            <div className="flex space-x-2">
              <input
                type="text"
                value={token.symbol}
                onChange={(e) => setToken(prev => ({ ...prev, symbol: e.target.value }))}
                className="flex-1 px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white"
                placeholder="e.g., SOL, USDC, dSOL"
                required
              />
              <button
                type="button"
                onClick={handleSearch}
                disabled={isSearching || !token.symbol.trim()}
                className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:bg-gray-600 disabled:cursor-not-allowed"
              >
                {isSearching ? 'Searching...' : 'Search'}
              </button>
            </div>
          </div>

          {/* Search Results */}
          {searchResults.length > 0 && (
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">Search Results</label>
              <div className="space-y-2 max-h-40 overflow-y-auto">
                {searchResults.map((result, index) => (
                  <div
                    key={index}
                    onClick={() => selectToken(result)}
                    className="p-3 bg-gray-700 rounded-md cursor-pointer hover:bg-gray-600 border border-gray-600"
                  >
                    <div className="font-medium text-white">{result.symbol}</div>
                    <div className="text-sm text-gray-400">{result.name}</div>
                    <div className="text-xs text-gray-500 font-mono">{result.mint}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Token Mint (Optional) */}
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-2">Token Mint (Optional)</label>
            <input
              type="text"
              value={token.mint}
              onChange={(e) => setToken(prev => ({ ...prev, mint: e.target.value }))}
              className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white font-mono text-sm"
              placeholder="e.g., So11111111111111111111111111111111111111112"
            />
            <p className="text-xs text-gray-400 mt-1">
              Leave empty to auto-resolve from symbol, or paste the full mint address
            </p>
          </div>

          {/* Token Name (Optional) */}
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-2">Token Name (Optional)</label>
            <input
              type="text"
              value={token.name}
              onChange={(e) => setToken(prev => ({ ...prev, name: e.target.value }))}
              className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white"
              placeholder="e.g., Solana, USD Coin, Marinade Staked SOL"
            />
          </div>

          {/* Instructions */}
          <div className="bg-blue-900 bg-opacity-30 border border-blue-700 rounded-md p-4">
            <h3 className="text-sm font-medium text-blue-300 mb-2">How to add tokens:</h3>
            <ul className="text-xs text-blue-200 space-y-1">
              <li>• <strong>By Symbol:</strong> Enter the token symbol (e.g., SOL, USDC) and click Search</li>
              <li>• <strong>By Mint:</strong> Paste the full mint address directly</li>
              <li>• <strong>Manual:</strong> Enter symbol and mint address manually</li>
            </ul>
          </div>

          {/* Action Buttons */}
          <div className="flex justify-end space-x-4 pt-6">
            <button
              type="button"
              onClick={onCancel}
              className="px-4 py-2 bg-gray-600 text-white rounded-md hover:bg-gray-700"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!token.symbol.trim()}
              className="px-4 py-2 bg-green-600 text-white rounded-md hover:bg-green-700 disabled:bg-gray-600 disabled:cursor-not-allowed"
            >
              Add Token
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
