import React, { useEffect, useState } from 'react';
import { ROUTES } from '../utils/routes';
import type { ExecEngineConfigPublic } from 'shared/config-types';
import { useModalConfig } from '../app/hooks/useModalConfig';

type Props = { apiBase: string; onClose: () => void };

export const ArbEngineConfig: React.FC<Props> = ({ apiBase, onClose }) => {
  // Persist UI preferences AND form values to localStorage
  const [uiPrefs, updateUiPrefs] = useModalConfig('arbEngineConfig', {
    expandedSections: {
      execution: true,
      nearMiss: true,
      edgeAllow: true,
    },
    // Save last used configuration values
    lastValues: null as any,
  });
  
  const [cfg, setCfg] = useState<any>(uiPrefs.lastValues || {
    mode: 'simulate',
    slippageBpsDefault: 50,
    computeUnitLimit: 1000000,
    computeUnitPriceMicroLamports: 500000,
    createAtasInTx: true,
    dynamicCompute: true,
    maxTxSizeBytes: 1200,
    near_miss_enable: true,
    debug_top_n: 5,
    edge_allow: {
      raydium: { amm: true, clmm: true },
      orca: { amm: true, clmm: true },
      meteora: { clmm: true },
      meteoraBalanced: { amm: true },
      pumpswap: { amm: true },
    },
  });
  
  // Save configuration values to localStorage when they change
  useEffect(() => {
    updateUiPrefs({ lastValues: cfg });
  }, [cfg]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        // Load execution config (backend)
        const ex = await fetch(`${apiBase}${ROUTES.exec.config}`).then(r => r.ok ? r.json() : null).catch(() => null);
        // Load detector config (arb-rs)
        const det = await fetch(`${apiBase}${ROUTES.arb.config}`).then(r => r.ok ? r.json() : null).catch(() => null);
        setCfg((p: any) => ({
          ...p,
          ...(ex || {}),
          near_miss_enable: (det?.near_miss_enable ?? p.near_miss_enable),
          debug_top_n: (det?.debug_top_n ?? p.debug_top_n),
          edge_allow: {
            raydium: {
              amm: det?.edge_allow?.raydium?.amm !== false,
              clmm: det?.edge_allow?.raydium?.clmm !== false,
            },
            orca: {
              amm: det?.edge_allow?.orca?.amm !== false,
              clmm: det?.edge_allow?.orca?.clmm !== false,
            },
            meteora: {
              clmm: det?.edge_allow?.meteora?.clmm !== false,
            },
            meteoraBalanced: {
              amm: det?.edge_allow?.meteoraBalanced?.amm !== false,
            },
            pumpswap: {
              amm: det?.edge_allow?.pumpswap?.amm !== false,
            },
          },
        }));
      } catch {}
    })();
  }, [apiBase]);

  const set = (k: string, v: any) => setCfg((p: any) => ({ ...p, [k]: v }));
  const setSource = (k: 'jupiter'|'raydium'|'orca', v: boolean) => setCfg((p: any) => ({ ...p, sources: { ...p.sources, [k]: v } }));

  const onSave = async () => {
    if (saving) return; setSaving(true); setError(null);
    const execBody: ExecEngineConfigPublic = {
      mode: (cfg.mode === 'direct' ? 'direct' : 'simulate'),
      slippageBpsDefault: Number(cfg.slippageBpsDefault) || 0,
      computeUnitLimit: Number(cfg.computeUnitLimit) || 0,
      computeUnitPriceMicroLamports: Number(cfg.computeUnitPriceMicroLamports) || 0,
      createAtasInTx: !!cfg.createAtasInTx,
      dynamicCompute: !!cfg.dynamicCompute,
      maxTxSizeBytes: Number(cfg.maxTxSizeBytes || 0) || undefined,
    };
    try {
      const [r1, r2] = await Promise.all([
        fetch(`${apiBase}${ROUTES.exec.config}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(execBody) }),
        fetch(`${apiBase}${ROUTES.arb.config}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ near_miss_enable: !!cfg.near_miss_enable, debug_top_n: Number(cfg.debug_top_n || 0), edge_allow: cfg.edge_allow }) }),
      ]);
      if (!r1.ok || !r2.ok) throw new Error('Failed to save');
      onClose();
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setSaving(false);
    }
  };

  const addListItem = (k: 'dex_allow', v: string) => {
    if (!v) return; setCfg((p: any) => ({ ...p, [k]: (Array.isArray(p[k]) ? p[k] : []).includes(v) ? p[k] : [...(p[k]||[]), v] }));
  };
  const removeListItem = (k: 'dex_allow', i: number) => setCfg((p: any) => ({ ...p, [k]: (p[k]||[]).filter((_: any, idx: number) => idx !== i) }));

  const toggleSection = (section: 'execution' | 'nearMiss' | 'edgeAllow') => {
    updateUiPrefs({
      expandedSections: {
        ...uiPrefs.expandedSections,
        [section]: !uiPrefs.expandedSections[section],
      },
    });
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-gray-800 rounded-lg p-6 w-full max-w-4xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-2xl font-bold text-white">Arbitrage Engine</h2>
          <button className="text-gray-300 hover:text-white" onClick={onClose}>✕</button>
        </div>
        {error ? <div className="text-red-400 text-sm mb-2">{error}</div> : null}

        <div className="space-y-6">
          <div className="bg-gray-700 rounded p-4">
            <h3 className="text-lg font-semibold mb-3">Direct Execution</h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div><label className="block text-sm mb-1">Mode</label><select className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.mode} onChange={(e)=>set('mode', e.target.value)}><option value="simulate">simulate</option><option value="direct">direct</option></select></div>
              <div><label className="block text-sm mb-1">Default Slippage (bps)</label><input type="number" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.slippageBpsDefault} onChange={(e)=>set('slippageBpsDefault', Number(e.target.value)||0)} /></div>
              <div><label className="block text-sm mb-1">Compute Unit Limit</label><input type="number" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.computeUnitLimit} onChange={(e)=>set('computeUnitLimit', Number(e.target.value)||0)} /></div>
              <div><label className="block text-sm mb-1">Priority Fee (microLamports)</label><input type="number" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.computeUnitPriceMicroLamports} onChange={(e)=>set('computeUnitPriceMicroLamports', Number(e.target.value)||0)} /></div>
              <label className="flex items-center gap-2"><input type="checkbox" checked={!!cfg.createAtasInTx} onChange={(e)=>set('createAtasInTx', e.target.checked)} />Create ATAs in transaction</label>
              <label className="flex items-center gap-2"><input type="checkbox" checked={!!cfg.dynamicCompute} onChange={(e)=>set('dynamicCompute', e.target.checked)} />Dynamic Compute</label>
              <div><label className="block text-sm mb-1">Max Tx Size (bytes)</label><input type="number" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.maxTxSizeBytes ?? ''} onChange={(e)=>set('maxTxSizeBytes', Number(e.target.value)||0)} /></div>
              <label className="flex items-center gap-2 md:col-span-3"><input type="checkbox" checked={!!cfg.near_miss_enable} onChange={(e)=>set('near_miss_enable', e.target.checked)} />Enable near-miss output (arb-rs)</label>
              <div><label className="block text-sm mb-1">Debug Top-N Near Misses</label><input type="number" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.debug_top_n} onChange={(e)=>set('debug_top_n', Number(e.target.value)||0)} /></div>
            </div>
          </div>

          <div className="bg-gray-700 rounded p-4">
            <h3 className="text-lg font-semibold mb-3">Arb Graph Edges</h3>
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <div className="col-span-1">
                <div className="font-semibold mb-2">Raydium</div>
                <label className="flex items-center gap-2 mb-2"><input type="checkbox" checked={!!cfg.edge_allow?.raydium?.amm} onChange={(e)=>set('edge_allow', { ...cfg.edge_allow, raydium: { ...(cfg.edge_allow?.raydium||{}), amm: e.target.checked } })} />AMM</label>
                <label className="flex items-center gap-2"><input type="checkbox" checked={!!cfg.edge_allow?.raydium?.clmm} onChange={(e)=>set('edge_allow', { ...cfg.edge_allow, raydium: { ...(cfg.edge_allow?.raydium||{}), clmm: e.target.checked } })} />CLMM</label>
              </div>
              <div className="col-span-1">
                <div className="font-semibold mb-2">Orca</div>
                <label className="flex items-center gap-2 mb-2"><input type="checkbox" checked={!!cfg.edge_allow?.orca?.amm} onChange={(e)=>set('edge_allow', { ...cfg.edge_allow, orca: { ...(cfg.edge_allow?.orca||{}), amm: e.target.checked } })} />AMM</label>
                <label className="flex items-center gap-2"><input type="checkbox" checked={!!cfg.edge_allow?.orca?.clmm} onChange={(e)=>set('edge_allow', { ...cfg.edge_allow, orca: { ...(cfg.edge_allow?.orca||{}), clmm: e.target.checked } })} />Whirlpool</label>
              </div>
              <div className="col-span-1">
                <div className="font-semibold mb-2">Meteora</div>
                <label className="flex items-center gap-2 mb-2"><input type="checkbox" checked={!!cfg.edge_allow?.meteora?.clmm} onChange={(e)=>set('edge_allow', { ...cfg.edge_allow, meteora: { ...(cfg.edge_allow?.meteora||{}), clmm: e.target.checked } })} />DLMM</label>
                <label className="flex items-center gap-2"><input type="checkbox" checked={!!cfg.edge_allow?.meteoraBalanced?.amm} onChange={(e)=>set('edge_allow', { ...cfg.edge_allow, meteoraBalanced: { ...(cfg.edge_allow?.meteoraBalanced||{}), amm: e.target.checked } })} />Balanced</label>
              </div>
              <div className="col-span-1">
                <div className="font-semibold mb-2">Pumpswap</div>
                <label className="flex items-center gap-2 mb-2"><input type="checkbox" checked={!!cfg.edge_allow?.pumpswap?.amm} onChange={(e)=>set('edge_allow', { ...cfg.edge_allow, pumpswap: { ...(cfg.edge_allow?.pumpswap||{}), amm: e.target.checked } })} />AMM</label>
              </div>
            </div>
            <div className="text-xs opacity-70 mt-3">Uncheck to exclude edges from the arbitrage graph. Changes take effect on save.</div>
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


