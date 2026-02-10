import React, { useEffect, useState } from 'react';
import { ROUTES } from '../utils/routes';

type Props = { apiBase: string; onClose: () => void };

export const GraphConfig: React.FC<Props> = ({ apiBase, onClose }) => {
  const [cfg, setCfg] = useState<any>({
    graphRebaseDiffThreshold: 2000,
    graphRebaseTimeMs: 300000,
    graphSnapshotTtlMs: 30000,
    graphRebuildDebounceMs: 200,
    graphRebuildMinDebounceMs: 50,
    graphDeltaRebuildThreshold: 0,
    graphDiffFilterEnable: true,
    graphDiffPriceEps: 0.002,
    graphDiffLiqEps: 0.01,
    graphDiffWeightEps: 0.01,
    sanity_enabled: true,
    sanity_maxPriceDeviation: 50,
    sanity_feeMin: 0,
    sanity_feeMax: 10000,
    sanity_applyRaydiumAmm: true,
    sanity_applyRaydiumClmm: true,
    sanity_applyOrcaClmm: true,
    logMinLevel: 'info',
    logAllowCats: '',
    // Pool activation mode
    poolActivationMode: 'immediate' as 'immediate' | 'lazy' | 'hybrid',
    poolSubscriptionMode: 'wss' as 'wss' | 'wss-program' | 'grpc' | 'disabled',
    poolActivationStats: null as null | { enabled: boolean; activatedCount: number; pendingBatchCount: number },
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch(`${apiBase}${ROUTES.system.config}`);
        if (r.ok) {
          const j = await r.json();
          setCfg((p: any) => ({
            ...p,
            graphRebaseDiffThreshold: Number(j?.system?.graphRebaseDiffThreshold ?? p.graphRebaseDiffThreshold),
            graphRebaseTimeMs: Number(j?.system?.graphRebaseTimeMs ?? p.graphRebaseTimeMs),
            graphSnapshotTtlMs: Number(j?.system?.graphSnapshotTtlMs ?? p.graphSnapshotTtlMs),
            graphRebuildDebounceMs: Number(j?.system?.graphRebuildDebounceMs ?? p.graphRebuildDebounceMs),
            graphRebuildMinDebounceMs: Number(j?.system?.graphRebuildMinDebounceMs ?? p.graphRebuildMinDebounceMs),
            graphDeltaRebuildThreshold: Number(j?.system?.graphDeltaRebuildThreshold ?? p.graphDeltaRebuildThreshold),
            graphDiffFilterEnable: (j?.system?.graphDiffFilterEnable ?? true) !== false,
            graphDiffPriceEps: Number(j?.system?.graphDiffPriceEps ?? p.graphDiffPriceEps),
            graphDiffLiqEps: Number(j?.system?.graphDiffLiqEps ?? p.graphDiffLiqEps),
            graphDiffWeightEps: Number(j?.system?.graphDiffWeightEps ?? p.graphDiffWeightEps),
            logMinLevel: String(j?.system?.logMinLevel ?? p.logMinLevel ?? 'info'),
            logAllowCats: Array.isArray(j?.system?.logAllowCats) ? (j?.system?.logAllowCats as string[]).join(',') : (p.logAllowCats || ''),
            sanity_enabled: (j?.sanity?.enabled ?? true) !== false,
            sanity_maxPriceDeviation: Number(j?.sanity?.maxPriceDeviation ?? p.sanity_maxPriceDeviation),
            sanity_feeMin: Number(j?.sanity?.feeMin ?? p.sanity_feeMin),
            sanity_feeMax: Number(j?.sanity?.feeMax ?? p.sanity_feeMax),
            sanity_applyRaydiumAmm: (j?.sanity?.sanity_applyRaydiumAmm ?? true) !== false,
            sanity_applyRaydiumClmm: (j?.sanity?.sanity_applyRaydiumClmm ?? true) !== false,
            sanity_applyOrcaClmm: (j?.sanity?.sanity_applyOrcaClmm ?? true) !== false,
            // Pool activation mode
            poolActivationMode: j?.pools?.activationMode || 'immediate',
            poolSubscriptionMode: j?.system?.poolSubscriptionMode || 'wss',
            poolActivationStats: j?.pools?.activationStats || null,
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
        graphRebaseDiffThreshold: Number(cfg.graphRebaseDiffThreshold),
        graphRebaseTimeMs: Number(cfg.graphRebaseTimeMs),
        graphSnapshotTtlMs: Number(cfg.graphSnapshotTtlMs),
        graphRebuildDebounceMs: Number(cfg.graphRebuildDebounceMs),
        graphRebuildMinDebounceMs: Number(cfg.graphRebuildMinDebounceMs),
        graphDeltaRebuildThreshold: Number(cfg.graphDeltaRebuildThreshold),
        graphDiffFilterEnable: !!cfg.graphDiffFilterEnable,
        graphDiffPriceEps: Number(cfg.graphDiffPriceEps),
        graphDiffLiqEps: Number(cfg.graphDiffLiqEps),
        graphDiffWeightEps: Number(cfg.graphDiffWeightEps),
        logMinLevel: String(cfg.logMinLevel || 'info'),
        logAllowCats: String(cfg.logAllowCats || '').split(',').map((s)=>s.trim()).filter(Boolean),
        poolSubscriptionMode: cfg.poolSubscriptionMode,
      },
      sanity: {
        enabled: !!cfg.sanity_enabled,
        maxPriceDeviation: Number(cfg.sanity_maxPriceDeviation),
        feeMin: Number(cfg.sanity_feeMin),
        feeMax: Number(cfg.sanity_feeMax),
        sanity_applyRaydiumAmm: !!cfg.sanity_applyRaydiumAmm,
        sanity_applyRaydiumClmm: !!cfg.sanity_applyRaydiumClmm,
        sanity_applyOrcaClmm: !!cfg.sanity_applyOrcaClmm,
      },
      pools: {
        activationMode: cfg.poolActivationMode,
      },
    };
    try {
      const r = await fetch(`${apiBase}${ROUTES.system.config}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
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
      <div className="bg-gray-800 rounded-lg p-6 w-full max-w-3xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-2xl font-bold text-white">Graph Configuration</h2>
          <button className="text-gray-300 hover:text-white" onClick={onClose}>✕</button>
        </div>
        {error ? <div className="text-red-400 text-sm mb-2">{error}</div> : null}

        <div className="space-y-6">
          <div className="bg-gray-700 rounded p-4">
            <h3 className="text-lg font-semibold mb-3">Rebase & Diff Policy</h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div><label className="block text-sm mb-1">Rebase Diff Threshold (edges)</label><input type="number" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.graphRebaseDiffThreshold} onChange={(e)=>set('graphRebaseDiffThreshold', Number(e.target.value)||0)} /></div>
              <div><label className="block text-sm mb-1">Rebase Time (ms)</label><input type="number" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.graphRebaseTimeMs} onChange={(e)=>set('graphRebaseTimeMs', Number(e.target.value)||0)} /></div>
              <div><label className="block text-sm mb-1">Snapshot TTL (ms)</label><input type="number" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.graphSnapshotTtlMs} onChange={(e)=>set('graphSnapshotTtlMs', Number(e.target.value)||0)} /></div>
              <div><label className="block text-sm mb-1">Rebuild Debounce (ms)</label><input type="number" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.graphRebuildDebounceMs} onChange={(e)=>set('graphRebuildDebounceMs', Number(e.target.value)||0)} /></div>
              <div><label className="block text-sm mb-1">Min Debounce (ms)</label><input type="number" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.graphRebuildMinDebounceMs} onChange={(e)=>set('graphRebuildMinDebounceMs', Number(e.target.value)||0)} /></div>
              <div><label className="block text-sm mb-1">Delta Rebuild Threshold</label><input type="number" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.graphDeltaRebuildThreshold} onChange={(e)=>set('graphDeltaRebuildThreshold', Number(e.target.value)||0)} /></div>
              <label className="flex items-center gap-2 col-span-1 md:col-span-3"><input type="checkbox" checked={!!cfg.graphDiffFilterEnable} onChange={(e)=>set('graphDiffFilterEnable', e.target.checked)} />Enable Diff Filter</label>
              <div><label className="block text-sm mb-1">Price Eps (fraction)</label><input step="0.0001" type="number" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.graphDiffPriceEps} onChange={(e)=>set('graphDiffPriceEps', Number(e.target.value)||0)} /></div>
              <div><label className="block text-sm mb-1">Liquidity Eps (fraction)</label><input step="0.0001" type="number" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.graphDiffLiqEps} onChange={(e)=>set('graphDiffLiqEps', Number(e.target.value)||0)} /></div>
              <div><label className="block text-sm mb-1">Weight Eps (fraction)</label><input step="0.0001" type="number" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.graphDiffWeightEps} onChange={(e)=>set('graphDiffWeightEps', Number(e.target.value)||0)} /></div>
            </div>
          </div>

          <div className="bg-gray-700 rounded p-4">
            <h3 className="text-lg font-semibold mb-3">Logstream (UI)</h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm mb-1">Min Level</label>
                <select className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.logMinLevel} onChange={(e)=>set('logMinLevel', e.target.value)}>
                  <option value="error">error</option>
                  <option value="warn">warn</option>
                  <option value="info">info</option>
                  <option value="debug">debug</option>
                </select>
              </div>
              <div className="md:col-span-2">
                <label className="block text-sm mb-1">Allowed Categories (comma-separated)</label>
                <input type="text" placeholder="e.g. system,arb" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.logAllowCats} onChange={(e)=>set('logAllowCats', e.target.value)} />
                <div className="text-xs text-gray-300 mt-1">Leave empty to allow all cats but still respect min level. Keep empty to avoid chatty 'graph' logs in UI.</div>
              </div>
            </div>
          </div>

          <div className="bg-gray-700 rounded p-4">
            <h3 className="text-lg font-semibold mb-3">Sanity Filters</h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <label className="flex items-center gap-2"><input type="checkbox" checked={!!cfg.sanity_enabled} onChange={(e)=>set('sanity_enabled', e.target.checked)} />Enable</label>
              <div><label className="block text-sm mb-1">Max Price Deviation (x)</label><input type="number" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.sanity_maxPriceDeviation} onChange={(e)=>set('sanity_maxPriceDeviation', Number(e.target.value)||0)} /></div>
              <div><label className="block text-sm mb-1">Fee Min (bps)</label><input type="number" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.sanity_feeMin} onChange={(e)=>set('sanity_feeMin', Number(e.target.value)||0)} /></div>
              <div><label className="block text-sm mb-1">Fee Max (bps)</label><input type="number" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.sanity_feeMax} onChange={(e)=>set('sanity_feeMax', Number(e.target.value)||0)} /></div>
              <label className="flex items-center gap-2"><input type="checkbox" checked={!!cfg.sanity_applyRaydiumAmm} onChange={(e)=>set('sanity_applyRaydiumAmm', e.target.checked)} />Apply to Raydium AMM</label>
              <label className="flex items-center gap-2"><input type="checkbox" checked={!!cfg.sanity_applyRaydiumClmm} onChange={(e)=>set('sanity_applyRaydiumClmm', e.target.checked)} />Apply to Raydium CLMM</label>
              <label className="flex items-center gap-2"><input type="checkbox" checked={!!cfg.sanity_applyOrcaClmm} onChange={(e)=>set('sanity_applyOrcaClmm', e.target.checked)} />Apply to Orca CLMM</label>
            </div>
          </div>

          <div className="bg-gray-700 rounded p-4">
            <h3 className="text-lg font-semibold mb-3">Pool Subscriptions</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm mb-1">Subscription Mode</label>
                <select
                  className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1"
                  value={cfg.poolSubscriptionMode}
                  onChange={(e) => set('poolSubscriptionMode', e.target.value)}
                >
                  <option value="wss">WebSocket Per-Pool (RPC)</option>
                  <option value="wss-program">WebSocket Programs (RPC)</option>
                  <option value="grpc">gRPC (Yellowstone/Shyft)</option>
                  <option value="disabled">Disabled</option>
                </select>
                <div className="text-xs text-gray-300 mt-1">
                  {cfg.poolSubscriptionMode === 'wss' && 'Subscribe to each pool account individually via RPC WebSocket.'}
                  {cfg.poolSubscriptionMode === 'wss-program' && 'Subscribe to DEX programs instead of individual pools (9 subscriptions total). Avoids the 100-sub-per-connection limit.'}
                  {cfg.poolSubscriptionMode === 'grpc' && 'Use Yellowstone/Shyft gRPC stream for pool updates.'}
                  {cfg.poolSubscriptionMode === 'disabled' && 'Pool subscriptions disabled. Graph will only update on manual refresh.'}
                </div>
              </div>
              <div>
                <label className="block text-sm mb-1">Activation Mode</label>
                <select 
                  className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" 
                  value={cfg.poolActivationMode} 
                  onChange={(e) => set('poolActivationMode', e.target.value)}
                >
                  <option value="immediate">Immediate (all pools in graph)</option>
                  <option value="lazy">Lazy (require first WS update)</option>
                  <option value="hybrid">Hybrid (RPC prefetch + subscribe)</option>
                </select>
                <div className="text-xs text-gray-300 mt-1">
                  Lazy mode only adds pools to graph after receiving their first WebSocket update with valid pricing.
                  Hybrid mode prefetches on-chain pool state via RPC before subscribing, then activates pools with valid prices.
                </div>
              </div>
              {cfg.poolActivationStats && (
                <div className="bg-gray-800 rounded p-3">
                  <div className="text-sm font-medium mb-2">Activation Status</div>
                  <div className="text-xs space-y-1">
                    <div>Mode: <span className={cfg.poolActivationStats.enabled ? 'text-yellow-400' : 'text-green-400'}>
                      {cfg.poolActivationStats.enabled ? 'LAZY' : 'IMMEDIATE'}
                    </span></div>
                    <div>Activated Pools: <span className="text-blue-400">{cfg.poolActivationStats.activatedCount}</span></div>
                    <div>Pending Batch: <span className="text-gray-400">{cfg.poolActivationStats.pendingBatchCount}</span></div>
                  </div>
                </div>
              )}
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


