import React, { useEffect, useState } from 'react';

type Props = { apiBase: string; onClose: () => void };

export const ArbEngineConfig: React.FC<Props> = ({ apiBase, onClose }) => {
  const [cfg, setCfg] = useState<any>({
    enabled: true,
    min_profit_bps: 30,
    min_notional_usd: 50,
    max_hops: 3,
    max_paths_per_cycle: 10,
    poll_interval_ms: 2000,
    quote_size_usd: 50,
    max_slippage_bps: 100,
    fee_bps: 30,
    link_penalty_bps: 2,
    priority_fee_tier: 'h',
    sources: { jupiter: true, raydium: true, orca: true },
    execution_mode: 'simulate',
    dex_allow: ['Raydium','Orca','Jupiter'],
    dex_denylist: [] as string[],
    debug_emit_subthreshold: false,
    debug_top_n: 5,
    near_miss_enable: true,
    near_miss_epsilon: 0.0005,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch(`${apiBase}/arb/config`);
        if (r.ok) {
          const j = await r.json();
          setCfg((p: any) => ({
            ...p,
            enabled: j?.enabled ?? p.enabled,
            min_profit_bps: j?.min_profit_bps ?? p.min_profit_bps,
            min_notional_usd: j?.min_notional_usd ?? p.min_notional_usd,
            max_hops: j?.max_hops ?? p.max_hops,
            max_paths_per_cycle: j?.max_paths_per_cycle ?? p.max_paths_per_cycle,
            poll_interval_ms: j?.poll_interval_ms ?? p.poll_interval_ms,
            quote_size_usd: j?.quote_size_usd ?? p.quote_size_usd,
            max_slippage_bps: j?.max_slippage_bps ?? p.max_slippage_bps,
            fee_bps: j?.fee_bps ?? p.fee_bps,
            link_penalty_bps: j?.link_penalty_bps ?? p.link_penalty_bps,
            priority_fee_tier: j?.priority_fee_tier ?? p.priority_fee_tier,
            sources: j?.sources ?? p.sources,
            execution_mode: j?.execution_mode ?? p.execution_mode,
            dex_allow: Array.isArray(j?.dex_allow) ? j.dex_allow : (Array.isArray((j as any)?.dex_allowlist) ? (j as any).dex_allowlist : p.dex_allow),
            dex_denylist: Array.isArray((j as any)?.dex_denylist) ? (j as any).dex_denylist : p.dex_denylist,
            debug_emit_subthreshold: !!j?.debug_emit_subthreshold,
            debug_top_n: Number(j?.debug_top_n ?? p.debug_top_n),
            near_miss_enable: typeof j?.near_miss_enable === 'boolean' ? j.near_miss_enable : p.near_miss_enable,
            near_miss_epsilon: typeof j?.near_miss_epsilon === 'number' ? j.near_miss_epsilon : p.near_miss_epsilon,
          }));
        }
      } catch {}
    })();
  }, [apiBase]);

  const set = (k: string, v: any) => setCfg((p: any) => ({ ...p, [k]: v }));
  const setSource = (k: 'jupiter'|'raydium'|'orca', v: boolean) => setCfg((p: any) => ({ ...p, sources: { ...p.sources, [k]: v } }));

  const onSave = async () => {
    if (saving) return; setSaving(true); setError(null);
    const body = {
      enabled: !!cfg.enabled,
      min_profit_bps: Number(cfg.min_profit_bps),
      min_notional_usd: Number(cfg.min_notional_usd),
      max_hops: Number(cfg.max_hops),
      max_paths_per_cycle: Number(cfg.max_paths_per_cycle),
      poll_interval_ms: Number(cfg.poll_interval_ms),
      quote_size_usd: Number(cfg.quote_size_usd),
      max_slippage_bps: Number(cfg.max_slippage_bps),
      fee_bps: Number(cfg.fee_bps),
      link_penalty_bps: Number(cfg.link_penalty_bps),
      priority_fee_tier: cfg.priority_fee_tier,
      sources: cfg.sources,
      execution_mode: cfg.execution_mode,
      dex_allow: cfg.dex_allow,
      dex_denylist: cfg.dex_denylist,
      debug_emit_subthreshold: !!cfg.debug_emit_subthreshold,
      debug_top_n: Number(cfg.debug_top_n),
      near_miss_enable: !!cfg.near_miss_enable,
      near_miss_epsilon: Number(cfg.near_miss_epsilon),
    } as any;
    try {
      const r = await fetch(`${apiBase}/arb/config`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error('Failed to save');
      onClose();
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setSaving(false);
    }
  };

  const addListItem = (k: 'dex_allow'|'dex_denylist', v: string) => {
    if (!v) return; setCfg((p: any) => ({ ...p, [k]: (Array.isArray(p[k]) ? p[k] : []).includes(v) ? p[k] : [...(p[k]||[]), v] }));
  };
  const removeListItem = (k: 'dex_allow'|'dex_denylist', i: number) => setCfg((p: any) => ({ ...p, [k]: (p[k]||[]).filter((_: any, idx: number) => idx !== i) }));

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
            <h3 className="text-lg font-semibold mb-3">Core</h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <label className="flex items-center gap-2"><input type="checkbox" checked={!!cfg.enabled} onChange={(e)=>set('enabled', e.target.checked)} />Enabled</label>
              <div><label className="block text-sm mb-1">Execution Mode</label><select className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.execution_mode} onChange={(e)=>set('execution_mode', e.target.value)}><option value="simulate">simulate</option><option value="execute">execute</option></select></div>
              <div><label className="block text-sm mb-1">Priority Fee Tier</label><select className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.priority_fee_tier} onChange={(e)=>set('priority_fee_tier', e.target.value)}><option value="m">m</option><option value="h">h</option><option value="vh">vh</option></select></div>
              <div><label className="block text-sm mb-1">Min Profit (bps)</label><input type="number" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.min_profit_bps} onChange={(e)=>set('min_profit_bps', Number(e.target.value)||0)} /></div>
              <div><label className="block text-sm mb-1">Min Notional (USD)</label><input type="number" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.min_notional_usd} onChange={(e)=>set('min_notional_usd', Number(e.target.value)||0)} /></div>
              <div><label className="block text-sm mb-1">Max Hops</label><input type="number" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.max_hops} onChange={(e)=>set('max_hops', Number(e.target.value)||0)} /></div>
              <div><label className="block text-sm mb-1">Max Paths per Cycle</label><input type="number" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.max_paths_per_cycle} onChange={(e)=>set('max_paths_per_cycle', Number(e.target.value)||0)} /></div>
              <div><label className="block text-sm mb-1">Poll Interval (ms)</label><input type="number" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.poll_interval_ms} onChange={(e)=>set('poll_interval_ms', Number(e.target.value)||0)} /></div>
              <div><label className="block text-sm mb-1">Quote Size (USD)</label><input type="number" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.quote_size_usd} onChange={(e)=>set('quote_size_usd', Number(e.target.value)||0)} /></div>
              <div className="md:col-span-2 text-xs text-gray-300">If route starts with SOL, you can instead send a specific token amount from the opportunities panel using the Send action. This global USD setting controls detection heuristics and per-hop estimates.</div>
              <div><label className="block text-sm mb-1">Max Slippage (bps)</label><input type="number" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.max_slippage_bps} onChange={(e)=>set('max_slippage_bps', Number(e.target.value)||0)} /></div>
            </div>
          </div>

          <div className="bg-gray-700 rounded p-4">
            <h3 className="text-lg font-semibold mb-3">Sources</h3>
            <div className="grid grid-cols-3 gap-4">
              <label className="flex items-center gap-2"><input type="checkbox" checked={!!cfg.sources.jupiter} onChange={(e)=>setSource('jupiter', e.target.checked)} />Jupiter</label>
              <label className="flex items-center gap-2"><input type="checkbox" checked={!!cfg.sources.raydium} onChange={(e)=>setSource('raydium', e.target.checked)} />Raydium</label>
              <label className="flex items-center gap-2"><input type="checkbox" checked={!!cfg.sources.orca} onChange={(e)=>setSource('orca', e.target.checked)} />Orca</label>
            </div>
          </div>

          <div className="bg-gray-700 rounded p-4">
            <h3 className="text-lg font-semibold mb-3">Fees & Penalties</h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div><label className="block text-sm mb-1">Fee (bps)</label><input type="number" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.fee_bps} onChange={(e)=>set('fee_bps', Number(e.target.value)||0)} /></div>
              <div><label className="block text-sm mb-1">Link Penalty (bps)</label><input type="number" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.link_penalty_bps} onChange={(e)=>set('link_penalty_bps', Number(e.target.value)||0)} /></div>
            </div>
          </div>

          <div className="bg-gray-700 rounded p-4">
            <h3 className="text-lg font-semibold mb-3">DEX Lists</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div>
                <div className="text-sm mb-1">Allowlist</div>
                <div className="flex flex-wrap gap-2 mb-2">{(cfg.dex_allow||[]).map((d: string, i: number)=> <span key={i} className="inline-flex items-center bg-gray-700 text-gray-100 px-2 py-1 rounded">{d}<button className="ml-2" onClick={()=>removeListItem('dex_allow', i)}>×</button></span>)}</div>
                <input className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" placeholder="Add DEX" onKeyDown={(e)=>{const v=(e.target as HTMLInputElement).value.trim(); if(e.key==='Enter'&&v){ addListItem('dex_allow', v); (e.target as HTMLInputElement).value=''; }}} />
              </div>
              <div>
                <div className="text-sm mb-1">Denylist</div>
                <div className="flex flex-wrap gap-2 mb-2">{(cfg.dex_denylist||[]).map((d: string, i: number)=> <span key={i} className="inline-flex items-center bg-gray-700 text-gray-100 px-2 py-1 rounded">{d}<button className="ml-2" onClick={()=>removeListItem('dex_denylist', i)}>×</button></span>)}</div>
                <input className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" placeholder="Add DEX" onKeyDown={(e)=>{const v=(e.target as HTMLInputElement).value.trim(); if(e.key==='Enter'&&v){ addListItem('dex_denylist', v); (e.target as HTMLInputElement).value=''; }}} />
              </div>
            </div>
          </div>

          <div className="bg-gray-700 rounded p-4">
            <h3 className="text-lg font-semibold mb-3">Debug</h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <label className="flex items-center gap-2"><input type="checkbox" checked={!!cfg.debug_emit_subthreshold} onChange={(e)=>set('debug_emit_subthreshold', e.target.checked)} />Emit sub-threshold</label>
              <div><label className="block text-sm mb-1">Top-N Subthreshold</label><input type="number" className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.debug_top_n} onChange={(e)=>set('debug_top_n', Number(e.target.value)||0)} /></div>
              <label className="flex items-center gap-2"><input type="checkbox" checked={!!cfg.near_miss_enable} onChange={(e)=>set('near_miss_enable', e.target.checked)} />Enable near-miss (BF slack)</label>
              <div><label className="block text-sm mb-1">Near-miss epsilon</label><input type="number" step={0.0001} className="w-full bg-gray-600 border border-gray-500 rounded px-2 py-1" value={cfg.near_miss_epsilon} onChange={(e)=>set('near_miss_epsilon', Number(e.target.value)||0)} /></div>
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


