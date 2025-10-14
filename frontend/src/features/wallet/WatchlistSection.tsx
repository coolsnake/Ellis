import React from 'react';

export const WatchlistSection: React.FC<{
  watchlist: any[];
  prices: Record<string, { usdc: number | null; sol: number | null }>;
  strategies: any[];
  activitiesByStrategy: Record<string, any>;
  onAdd: () => void;
  onRemove: (t: any) => void;
  onFetchVerified: () => void;
  onBootstrapPools: () => void;
}> = ({ watchlist, prices, strategies, activitiesByStrategy, onAdd, onRemove, onFetchVerified, onBootstrapPools }) => {
  return (
    <section className="bg-gray-900 rounded p-4 mt-4 flex-1 overflow-auto">
      <div className="flex justify-between items-center mb-3">
        <h2 className="text-2xl font-semibold">Watchlist</h2>
        <div className="flex items-center space-x-2">
          <button onClick={onFetchVerified} className="px-3 py-1 bg-blue-600 text-white rounded text-sm hover:bg-blue-700" title="Fetch Jupiter verified tokens and seed prices">Fetch verified</button>
          <button onClick={onBootstrapPools} className="px-3 py-1 bg-indigo-600 text-white rounded text-sm hover:bg-indigo-700" title="Bootstrap prices for current universe">Bootstrap pools</button>
          <button onClick={onAdd} className="px-3 py-1 bg-green-600 text-white rounded text-sm hover:bg-green-700">+ Token</button>
        </div>
      </div>
      <ul className="space-y-1">
        {watchlist.map((t, index) => {
          const isString = typeof t === 'string';
          const id = isString ? t : (t as any)?.id;
          const label = isString ? (t as string) : ((t as any)?.symbol || ((t as any)?.id ? (t as any).id.slice(0,4) : ''));
          const priceUsd = id ? prices?.[id]?.usdc : null;
          const symUpper = (isString ? label : (t as any)?.symbol || '').toUpperCase?.() || '';
          const lstStrat = strategies.find((s) => {
            if (!s?.lst) return false;
            const cand = [s.toToken, s.token, s.fromToken].filter(Boolean).map((x: any) => String(x).toUpperCase());
            return cand.includes(symUpper);
          });
          const a = lstStrat ? (activitiesByStrategy[lstStrat.name || 'default'] as any) : undefined;
          const navPair = typeof a?.nav === 'number' ? (a.nav as number) : null;
          const premPct = typeof a?.premium === 'number' ? (a.premium as number) : null;
          return (
            <li key={id || label} className="text-sm text-gray-300 flex items-center justify-between px-3 py-1.5 bg-gray-800 rounded">
              <span className="font-medium">{label}</span>
              <div className="flex items-center space-x-2">
                <span>
                  {priceUsd ? `$${priceUsd.toFixed(4)}` : '-'}
                  {navPair ? <span className="ml-2 text-gray-400">NAV {navPair.toFixed(6)}{typeof premPct === 'number' ? ` (${(premPct*100).toFixed(2)}%)` : ''}</span> : null}
                </span>
                <button onClick={() => onRemove(t)} className="text-red-400 hover:text-red-300 text-xs px-2 py-1 rounded hover:bg-red-900" title="Remove token">×</button>
              </div>
            </li>
          );
        })}
        {watchlist.length === 0 && <li className="text-gray-400 text-sm px-3">No tokens yet (use terminal)</li>}
      </ul>
    </section>
  );
};


