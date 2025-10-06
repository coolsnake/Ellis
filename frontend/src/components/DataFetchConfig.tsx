import React, { useEffect, useState } from 'react';

type Props = {
  apiBase: string;
  initial?: any;
  onClose: () => void;
};

export const DataFetchConfig: React.FC<Props> = ({ apiBase, initial, onClose }) => {
  const [cfg, setCfg] = useState<any>({
		// System
		enablePoolWs: true,
    poolRefreshMinGapMs: 3000,
    tokenUniverseMode: 'jupiter',
    scopePoolsMode: 'jupiter',
    anchorMints: 'So11111111111111111111111111111111111111112,EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    universePrefilterOrca: false,
		// Raydium (HTTP)
		ray_cacheTtlMs: 300000,
		ray_httpConcurrency: 2,
		ray_httpPageSize: 50,
		ray_httpMaxPagesPerMint: 2,
		ray_minAmmLiqBase: 0,
		ray_minClmmLiquidity: 0,
    // Sanity
    sanity_enabled: true,
    sanity_maxPriceDeviation: 50,
    sanity_feeMin: 0,
    sanity_feeMax: 10000,
    sanity_writeSamples: false,
    sanity_sampleRate: 0.005,
    // Orca
    orca_mode: 'http',
    orca_cacheTtlMs: 300000,
    orca_maxHttpRetries: 2,
    orca_httpBackoffMs: 500,
    orca_pageSize: 200,
    orca_maxPages: 3,
    orca_minAmmLiqBase: 0,
    orca_minClmmLiquidity: 0,
    // Jupiter
    jupiterApiUrl: '',
    jupiterPauseApi: false,
    jupiterLimiterTargetMs: 2000,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch(`${apiBase}/system/config`);
        if (r.ok) {
          const j = await r.json();
				setCfg((prev: any) => ({
            ...prev,
					enablePoolWs: j?.system?.enablePoolWs !== false,
            poolRefreshMinGapMs: Number(j?.system?.poolRefreshMinGapMs ?? prev.poolRefreshMinGapMs),
            tokenUniverseMode: j?.system?.tokenUniverseMode || prev.tokenUniverseMode,
            scopePoolsMode: j?.system?.scopePoolsMode || prev.scopePoolsMode,
            anchorMints: Array.isArray(j?.system?.anchorMints) ? j.system.anchorMints.join(',') : (prev.anchorMints || ''),
            universePrefilterOrca: !!j?.system?.universePrefilterOrca,
            jupiterApiUrl: j?.system?.jupiterApiUrl || prev.jupiterApiUrl,
				ray_cacheTtlMs: Number(j?.raydium?.cacheTtlMs ?? prev.ray_cacheTtlMs),
				ray_httpConcurrency: Number(j?.raydium?.sdkConcurrency ?? prev.ray_httpConcurrency),
				ray_httpPageSize: Number(j?.raydium?.httpPageSize ?? prev.ray_httpPageSize),
				ray_httpMaxPagesPerMint: Number(j?.raydium?.httpMaxPagesPerMint ?? prev.ray_httpMaxPagesPerMint),
            ray_minAmmLiqBase: Number(j?.raydium?.minAmmLiqBase ?? prev.ray_minAmmLiqBase),
            ray_minClmmLiquidity: Number(j?.raydium?.minClmmLiquidity ?? prev.ray_minClmmLiquidity),
            orca_mode: j?.orca?.mode || prev.orca_mode,
            orca_cacheTtlMs: Number(j?.orca?.cacheTtlMs ?? prev.orca_cacheTtlMs),
            orca_maxHttpRetries: Number(j?.orca?.maxHttpRetries ?? prev.orca_maxHttpRetries),
            orca_httpBackoffMs: Number(j?.orca?.httpBackoffMs ?? prev.orca_httpBackoffMs),
            orca_pageSize: Number(j?.orca?.pageSize ?? prev.orca_pageSize),
            orca_maxPages: Number(j?.orca?.maxPages ?? prev.orca_maxPages),
            orca_minAmmLiqBase: Number(j?.orca?.minAmmLiqBase ?? prev.orca_minAmmLiqBase),
            orca_minClmmLiquidity: Number(j?.orca?.minClmmLiquidity ?? prev.orca_minClmmLiquidity),
            // Sanity
            sanity_enabled: (j?.sanity?.enabled ?? true) !== false,
            sanity_maxPriceDeviation: Number(j?.sanity?.maxPriceDeviation ?? prev.sanity_maxPriceDeviation),
            sanity_feeMin: Number(j?.sanity?.feeMin ?? prev.sanity_feeMin),
            sanity_feeMax: Number(j?.sanity?.feeMax ?? prev.sanity_feeMax),
            sanity_writeSamples: !!j?.sanity?.writeSamples,
            sanity_sampleRate: Number(j?.sanity?.sampleRate ?? prev.sanity_sampleRate),
          }));
        }
      } catch {}
    })();
  }, [apiBase]);

  const set = (k: string, v: any) => setCfg((p: any) => ({ ...p, [k]: v }));

  const onSave = async () => {
    if (saving) return; setSaving(true); setError(null);
		const body: any = {
      system: {
        enablePoolWs: !!cfg.enablePoolWs,
        poolRefreshMinGapMs: Number(cfg.poolRefreshMinGapMs),
        tokenUniverseMode: cfg.tokenUniverseMode,
        scopePoolsMode: cfg.scopePoolsMode,
        anchorMints: String(cfg.anchorMints || '').split(',').map(s => s.trim()).filter(Boolean),
        universePrefilterOrca: !!cfg.universePrefilterOrca,
        jupiterApiUrl: cfg.jupiterApiUrl,
      },
			raydium: {
			cacheTtlMs: Number(cfg.ray_cacheTtlMs),
			sdkConcurrency: Number(cfg.ray_httpConcurrency),
			httpPageSize: Number(cfg.ray_httpPageSize),
			httpMaxPagesPerMint: Number(cfg.ray_httpMaxPagesPerMint),
			minAmmLiqBase: Number(cfg.ray_minAmmLiqBase),
			minClmmLiquidity: Number(cfg.ray_minClmmLiquidity),
		},
      orca: {
        mode: cfg.orca_mode,
        cacheTtlMs: Number(cfg.orca_cacheTtlMs),
        maxHttpRetries: Number(cfg.orca_maxHttpRetries),
        httpBackoffMs: Number(cfg.orca_httpBackoffMs),
        pageSize: Number(cfg.orca_pageSize),
        maxPages: Number(cfg.orca_maxPages),
        minAmmLiqBase: Number(cfg.orca_minAmmLiqBase),
        minClmmLiquidity: Number(cfg.orca_minClmmLiquidity),
      },
      sanity: {
        enabled: !!cfg.sanity_enabled,
        maxPriceDeviation: Number(cfg.sanity_maxPriceDeviation),
        feeMin: Number(cfg.sanity_feeMin),
        feeMax: Number(cfg.sanity_feeMax),
        writeSamples: !!cfg.sanity_writeSamples,
        sampleRate: Number(cfg.sanity_sampleRate),
      },
    };
    try {
      const r = await fetch(`${apiBase}/system/config`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error('Failed to save');
      onClose();
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-gray-800 rounded-lg p-6 w-full max-w-4xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-2xl font-bold text-white">Data Fetchers & Normalizers</h2>
          <button className="text-gray-300 hover:text-white" onClick={onClose}>✕</button>
        </div>
        {error ? <div className="text-red-400 text-sm mb-2">{error}</div> : null}

        <div className="space-y-6">
          <div className="bg-gray-700 rounded p-4">
            <h3 className="text-lg font-semibold mb-3">System Refresh</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <label className="flex items-center gap-2"><input type="checkbox" checked={!!cfg.enablePoolWs} onChange={(e)=>set('enablePoolWs', e.target.checked)} />Enable Pool Websocket</label>
              <div>
                <label className="block text-sm mb-1">Min Gap Between Refreshes (ms)</label>
                <input type="number" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.poolRefreshMinGapMs} onChange={(e)=>set('poolRefreshMinGapMs', Number(e.target.value)||0)} />
              </div>
            </div>
          </div>

          <div className="bg-gray-700 rounded p-4">
            <h3 className="text-lg font-semibold mb-3">Token Universe & Scoping</h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm mb-1">Token Universe Mode</label>
                <select className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.tokenUniverseMode} onChange={(e)=>set('tokenUniverseMode', e.target.value)}>
                  <option value="jupiter">jupiter</option>
                  <option value="watchlist">watchlist</option>
                  <option value="intersection">intersection</option>
                  <option value="union">union</option>
                </select>
              </div>
              <div>
                <label className="block text-sm mb-1">Scope Pools Mode</label>
                <select className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.scopePoolsMode} onChange={(e)=>set('scopePoolsMode', e.target.value)}>
                  <option value="none">none</option>
                  <option value="watchlist">watchlist</option>
                  <option value="jupiter">jupiter</option>
                  <option value="intersection">intersection</option>
                  <option value="union">union</option>
                </select>
              </div>
              <div className="md:col-span-1">
                <label className="block text-sm mb-1">Anchor Mints (CSV)</label>
                <input type="text" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.anchorMints} onChange={(e)=>set('anchorMints', e.target.value)} placeholder="So111...,EPjF..." />
              </div>
              <label className="flex items-center gap-2 md:col-span-3"><input type="checkbox" checked={!!cfg.universePrefilterOrca} onChange={(e)=>set('universePrefilterOrca', e.target.checked)} />Prefilter Orca HTTP by universe (conservative)</label>
            </div>
          </div>

          <div className="bg-gray-700 rounded p-4">
            <h3 className="text-lg font-semibold mb-3">Raydium (HTTP)</h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm mb-1">Cache TTL (ms)</label>
                <input type="number" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.ray_cacheTtlMs} onChange={(e)=>set('ray_cacheTtlMs', Number(e.target.value)||0)} />
              </div>
              <div>
                <label className="block text-sm mb-1">HTTP Concurrency</label>
                <input type="number" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.ray_httpConcurrency} onChange={(e)=>set('ray_httpConcurrency', Number(e.target.value)||0)} />
              </div>
              <div>
                <label className="block text-sm mb-1">HTTP Page Size</label>
                <input type="number" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.ray_httpPageSize} onChange={(e)=>set('ray_httpPageSize', Number(e.target.value)||0)} />
              </div>
              <div>
                <label className="block text-sm mb-1">Max Pages Per Mint</label>
                <input type="number" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.ray_httpMaxPagesPerMint} onChange={(e)=>set('ray_httpMaxPagesPerMint', Number(e.target.value)||0)} />
              </div>
              <div>
                <label className="block text-sm mb-1">Min AMM TVL (USD)</label>
                <input type="number" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.ray_minAmmLiqBase} onChange={(e)=>set('ray_minAmmLiqBase', Number(e.target.value)||0)} />
              </div>
              <div>
                <label className="block text-sm mb-1">Min CLMM TVL (USD)</label>
                <input type="number" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.ray_minClmmLiquidity} onChange={(e)=>set('ray_minClmmLiquidity', Number(e.target.value)||0)} />
              </div>
            </div>
          </div>

        <div className="bg-gray-700 rounded p-4">
          <h3 className="text-lg font-semibold mb-3">Sanity Checks</h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <label className="flex items-center gap-2"><input type="checkbox" checked={!!cfg.sanity_enabled} onChange={(e)=>set('sanity_enabled', e.target.checked)} />Enable Sanity Filters</label>
              <div>
                <label className="block text-sm mb-1">Max Price Deviation (x)</label>
                <input type="number" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.sanity_maxPriceDeviation} onChange={(e)=>set('sanity_maxPriceDeviation', Number(e.target.value)||0)} />
              </div>
              <div>
                <label className="block text-sm mb-1">Fee Min (bps)</label>
                <input type="number" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.sanity_feeMin} onChange={(e)=>set('sanity_feeMin', Number(e.target.value)||0)} />
              </div>
              <div>
                <label className="block text-sm mb-1">Fee Max (bps)</label>
                <input type="number" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.sanity_feeMax} onChange={(e)=>set('sanity_feeMax', Number(e.target.value)||0)} />
              </div>
              <label className="flex items-center gap-2"><input type="checkbox" checked={!!cfg.sanity_writeSamples} onChange={(e)=>set('sanity_writeSamples', e.target.checked)} />Write Suspect Samples</label>
              <div>
                <label className="block text-sm mb-1">Sample Rate</label>
                <input type="number" step="0.001" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.sanity_sampleRate} onChange={(e)=>set('sanity_sampleRate', Number(e.target.value)||0)} />
              </div>
              <div className="md:col-span-3 grid grid-cols-1 md:grid-cols-3 gap-4">
                <label className="flex items-center gap-2"><input type="checkbox" checked={!!cfg.sanity_applyRaydiumAmm} onChange={(e)=>set('sanity_applyRaydiumAmm', e.target.checked)} />Apply to Raydium AMM</label>
                <label className="flex items-center gap-2"><input type="checkbox" checked={!!cfg.sanity_applyRaydiumClmm} onChange={(e)=>set('sanity_applyRaydiumClmm', e.target.checked)} />Apply to Raydium CLMM</label>
                <label className="flex items-center gap-2"><input type="checkbox" checked={!!cfg.sanity_applyOrcaClmm} onChange={(e)=>set('sanity_applyOrcaClmm', e.target.checked)} />Apply to Orca CLMM</label>
              </div>
            </div>
        </div>

          <div className="bg-gray-700 rounded p-4">
            <h3 className="text-lg font-semibold mb-3">Orca</h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm mb-1">Mode</label>
                <select className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.orca_mode} onChange={(e)=>set('orca_mode', e.target.value)}>
                  <option value="http">http</option>
                  <option value="v4">v4</option>
                  <option value="legacy">legacy</option>
                </select>
              </div>
              <div>
                <label className="block text-sm mb-1">Cache TTL (ms)</label>
                <input type="number" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.orca_cacheTtlMs} onChange={(e)=>set('orca_cacheTtlMs', Number(e.target.value)||0)} />
              </div>
              <div>
                <label className="block text-sm mb-1">Max HTTP Retries</label>
                <input type="number" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.orca_maxHttpRetries} onChange={(e)=>set('orca_maxHttpRetries', Number(e.target.value)||0)} />
              </div>
              <div>
                <label className="block text-sm mb-1">HTTP Backoff (ms)</label>
                <input type="number" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.orca_httpBackoffMs} onChange={(e)=>set('orca_httpBackoffMs', Number(e.target.value)||0)} />
              </div>
              <div>
                <label className="block text-sm mb-1">Page Size</label>
                <input type="number" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.orca_pageSize} onChange={(e)=>set('orca_pageSize', Number(e.target.value)||0)} />
              </div>
              <div>
                <label className="block text-sm mb-1">Max Pages</label>
                <input type="number" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.orca_maxPages} onChange={(e)=>set('orca_maxPages', Number(e.target.value)||0)} />
              </div>
              <div>
                <label className="block text-sm mb-1">Min AMM TVL (USD)</label>
                <input type="number" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.orca_minAmmLiqBase} onChange={(e)=>set('orca_minAmmLiqBase', Number(e.target.value)||0)} />
              </div>
              <div>
                <label className="block text-sm mb-1">Min CLMM TVL (USD)</label>
                <input type="number" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.orca_minClmmLiquidity} onChange={(e)=>set('orca_minClmmLiquidity', Number(e.target.value)||0)} />
              </div>
            </div>
          </div>

          <div className="bg-gray-700 rounded p-4">
            <h3 className="text-lg font-semibold mb-3">Jupiter</h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm mb-1">API URL</label>
                <input type="url" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.jupiterApiUrl} onChange={(e)=>set('jupiterApiUrl', e.target.value)} placeholder="https://quote-api.jup.ag/v6" />
              </div>
              <div className="col-span-2 text-xs text-gray-300">Limiting is controlled by the backend rate limiter; API pause is exposed via terminal commands today.</div>
            </div>
          </div>

          <div className="flex justify-end gap-3">
            <button className="px-4 py-2 bg-gray-600 rounded text-white" onClick={onClose} disabled={saving}>Cancel</button>
            <button className={`px-4 py-2 ${saving?'bg-blue-500/60':'bg-blue-600 hover:bg-blue-700'} rounded text-white`} onClick={onSave} disabled={saving}>{saving?'Saving…':'Save'}</button>
          </div>
        </div>
      </div>
    </div>
  );
};


