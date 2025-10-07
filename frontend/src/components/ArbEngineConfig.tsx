import React, { useEffect, useState } from 'react';

type Props = { apiBase: string; onClose: () => void };

export const ArbEngineConfig: React.FC<Props> = ({ apiBase, onClose }) => {
  const [cfg, setCfg] = useState<any>({
    mode: 'simulate',
    slippageBpsDefault: 50,
    computeUnitLimit: 1000000,
    computeUnitPriceMicroLamports: 1000,
    createAtasInTx: true,
    dynamicCompute: true,
    maxTxSizeBytes: 1200,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch(`${apiBase}/arb/config`);
        if (r.ok) {
          const j = await r.json();
          setCfg((p: any) => ({ ...p, ...j }));
        }
      } catch {}
    })();
  }, [apiBase]);

  const set = (k: string, v: any) => setCfg((p: any) => ({ ...p, [k]: v }));
  const setSource = (k: 'jupiter'|'raydium'|'orca', v: boolean) => setCfg((p: any) => ({ ...p, sources: { ...p.sources, [k]: v } }));

  const onSave = async () => {
    if (saving) return; setSaving(true); setError(null);
    const body = {
      mode: cfg.mode,
      slippageBpsDefault: Number(cfg.slippageBpsDefault),
      computeUnitLimit: Number(cfg.computeUnitLimit),
      computeUnitPriceMicroLamports: Number(cfg.computeUnitPriceMicroLamports),
      createAtasInTx: !!cfg.createAtasInTx,
      dynamicCompute: !!cfg.dynamicCompute,
      maxTxSizeBytes: Number(cfg.maxTxSizeBytes || 0) || undefined,
    } as any;
    try {
      const r = await fetch(`${apiBase}/arb/config`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error('Failed to save');
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


