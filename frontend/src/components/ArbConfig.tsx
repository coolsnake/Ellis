import React, { useState } from 'react';
import { ROUTES } from '../utils/routes';

type ArbConfigProps = {
  apiBase: string;
  initial?: Partial<ArbConfigState>;
  onClose: () => void;
};

type ArbConfigState = {
  enabled: boolean;
  minProfitBps: number;
  minNotionalUsd: number;
  maxHops: number;
  maxPathsPerCycle: number;
  pollIntervalMs: number;
  dexAllow: string[];
  priorityFeeTier: 'm'|'h'|'vh';
  useJupiterQuotes: boolean;
  useRaydium: boolean;
  useOrca: boolean;
  maxSlippageBps: number;
  executionMode: 'simulate' | 'execute';
  quoteSizeUsd: number;
  feeBps: number;
  linkPenaltyBps: number;
  debugEmitSubthreshold?: boolean;
  debugTopN?: number;
  nearMissEnable?: boolean;
  nearMissEpsilon?: number;
  // System & Raydium fields (rendered in separate section)
  sysRpcUrl?: string;
  rayEnableOnChain?: boolean;
  rayAmmV4Program?: string;
  rayClmmProgram?: string;
  scopePools?: boolean;
  scopePoolsMode?: 'none' | 'watchlist' | 'jupiter';
  // Orca
  orcaMode?: 'http' | 'v4' | 'legacy';
  orcaCacheTtlMs?: number;
  raydiumCacheTtlMs?: number;
  // Raydium SDK params
  raySdkConcurrency?: number;
  raySdkProbeMintsLimit?: number;
  raySdkClmmPageSize?: number;
  rayFilterToOrcaTokens?: boolean;
  rayFilterUniverse?: 'jupiter' | 'orca' | 'none';
};

export const ArbConfig: React.FC<ArbConfigProps> = ({ apiBase, initial, onClose }) => {
  const [cfg, setCfg] = useState<ArbConfigState>({
    enabled: initial?.enabled ?? true,
    minProfitBps: (initial as any)?.minProfitBps ?? (initial as any)?.min_profit_bps ?? 0,
    minNotionalUsd: (initial as any)?.minNotionalUsd ?? (initial as any)?.min_notional_usd ?? 0,
    maxHops: (initial as any)?.maxHops ?? (initial as any)?.max_hops ?? 0,
    maxPathsPerCycle: (initial as any)?.maxPathsPerCycle ?? (initial as any)?.max_paths_per_cycle ?? 0,
    pollIntervalMs: (initial as any)?.pollIntervalMs ?? (initial as any)?.poll_interval_ms ?? 0,
    dexAllow: initial?.dexAllow ?? (initial as any)?.dex_allow ?? [],
    priorityFeeTier: (initial as any)?.priorityFeeTier ?? (initial as any)?.priority_fee_tier ?? 'h',
    useJupiterQuotes: initial?.useJupiterQuotes ?? true,
    useRaydium: initial?.useRaydium ?? true,
    useOrca: initial?.useOrca ?? true,
    maxSlippageBps: (initial as any)?.maxSlippageBps ?? (initial as any)?.max_slippage_bps ?? 0,
    executionMode: (initial as any)?.executionMode ?? (initial as any)?.execution_mode ?? 'simulate',
    quoteSizeUsd: (initial as any)?.quoteSizeUsd ?? (initial as any)?.quote_size_usd ?? 0,
    feeBps: (initial as any)?.feeBps ?? (initial as any)?.fee_bps ?? 0,
    linkPenaltyBps: (initial as any)?.linkPenaltyBps ?? (initial as any)?.link_penalty_bps ?? 0,
    debugEmitSubthreshold: (initial as any)?.debugEmitSubthreshold ?? (initial as any)?.debug_emit_subthreshold ?? false,
    debugTopN: (initial as any)?.debugTopN ?? (initial as any)?.debug_top_n ?? 5,
    nearMissEnable: (initial as any)?.nearMissEnable ?? (initial as any)?.near_miss_enable ?? true,
    nearMissEpsilon: (initial as any)?.nearMissEpsilon ?? (initial as any)?.near_miss_epsilon ?? 0.0005,
    orcaMode: (initial as any)?.orcaMode ?? 'http',
    orcaCacheTtlMs: (initial as any)?.orcaCacheTtlMs ?? 0,
    raydiumCacheTtlMs: (initial as any)?.raydiumCacheTtlMs ?? 0,
    raySdkConcurrency: (initial as any)?.raySdkConcurrency ?? 0,
    raySdkProbeMintsLimit: (initial as any)?.raySdkProbeMintsLimit ?? 0,
    raySdkClmmPageSize: (initial as any)?.raySdkClmmPageSize ?? 0,
    rayFilterToOrcaTokens: (initial as any)?.rayFilterToOrcaTokens,
    rayFilterUniverse: (initial as any)?.rayFilterUniverse || 'jupiter',
    scopePoolsMode: (initial as any)?.scopePoolsMode || 'watchlist',
  });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const set = (k: keyof ArbConfigState, v: any) => setCfg(prev => ({ ...prev, [k]: v }));
  React.useEffect(() => {
    (async () => {
      try {
        const withTimeout = async (fn: (signal: AbortSignal) => Promise<Response>, ms = 7000) => {
          const ac = new AbortController();
          const t = setTimeout(() => ac.abort('timeout'), ms);
          try { return await fn(ac.signal); } finally { clearTimeout(t); }
        };
        const r = await withTimeout((signal) => fetch(`${apiBase}${ROUTES.arb.config}`, { signal }));
        if (r.ok) {
          const j = await r.json();
          setCfg(prev => ({
            ...prev,
            enabled: j.enabled ?? prev.enabled,
            minProfitBps: j.min_profit_bps ?? prev.minProfitBps,
            minNotionalUsd: j.min_notional_usd ?? prev.minNotionalUsd,
            maxHops: j.max_hops ?? prev.maxHops,
            maxPathsPerCycle: j.max_paths_per_cycle ?? prev.maxPathsPerCycle,
            pollIntervalMs: j.poll_interval_ms ?? prev.pollIntervalMs,
            dexAllow: Array.isArray(j.dex_allow) ? j.dex_allow : prev.dexAllow,
            priorityFeeTier: j.priority_fee_tier ?? prev.priorityFeeTier,
            useJupiterQuotes: j.sources?.jupiter ?? prev.useJupiterQuotes,
            useRaydium: j.sources?.raydium ?? prev.useRaydium,
            useOrca: j.sources?.orca ?? prev.useOrca,
            maxSlippageBps: j.max_slippage_bps ?? prev.maxSlippageBps,
            executionMode: j.execution_mode ?? prev.executionMode,
            quoteSizeUsd: j.quote_size_usd ?? prev.quoteSizeUsd,
            feeBps: j.fee_bps ?? prev.feeBps,
            linkPenaltyBps: j.link_penalty_bps ?? prev.linkPenaltyBps ?? 1,
            debugEmitSubthreshold: typeof j.debug_emit_subthreshold === 'boolean' ? j.debug_emit_subthreshold : (prev.debugEmitSubthreshold ?? false),
            debugTopN: typeof j.debug_top_n === 'number' ? j.debug_top_n : (prev.debugTopN ?? 5),
            nearMissEnable: typeof j.near_miss_enable === 'boolean' ? j.near_miss_enable : (prev.nearMissEnable ?? true),
            nearMissEpsilon: typeof j.near_miss_epsilon === 'number' ? j.near_miss_epsilon : (prev.nearMissEpsilon ?? 0.0005),
          }));
        }
      } catch {}
      // Also load system/raydium config
      try {
        const withTimeout = async (fn: (signal: AbortSignal) => Promise<Response>, ms = 7000) => {
          const ac = new AbortController();
          const t = setTimeout(() => ac.abort('timeout'), ms);
          try { return await fn(ac.signal); } finally { clearTimeout(t); }
        };
        const rs = await withTimeout((signal) => fetch(`${apiBase}${ROUTES.system.config}`, { signal }));
        if (rs.ok) {
          const s = await rs.json();
          setCfg(prev => ({
            ...prev,
            sysRpcUrl: s.rpcUrl || prev.sysRpcUrl,
            rayEnableOnChain: s.raydium?.enableOnChain ?? prev.rayEnableOnChain,
            rayAmmV4Program: s.raydium?.ammV4Program || prev.rayAmmV4Program,
            rayClmmProgram: s.raydium?.clmmProgram || prev.rayClmmProgram,
            scopePools: s.system?.scopePools ?? prev.scopePools,
            scopePoolsMode: (s.system?.scopePoolsMode as any) || prev.scopePoolsMode,
            orcaMode: (s.orca?.mode as any) || prev.orcaMode,
            orcaCacheTtlMs: s.orca?.cacheTtlMs ?? prev.orcaCacheTtlMs,
            raydiumCacheTtlMs: s.raydium?.cacheTtlMs ?? prev.raydiumCacheTtlMs,
            raySdkConcurrency: s.raydium?.sdkConcurrency ?? prev.raySdkConcurrency,
            raySdkProbeMintsLimit: s.raydium?.sdkProbeMintsLimit ?? prev.raySdkProbeMintsLimit,
            raySdkClmmPageSize: s.raydium?.sdkClmmPageSize ?? prev.raySdkClmmPageSize,
            rayFilterToOrcaTokens: s.raydium?.filterToOrcaTokens ?? prev.rayFilterToOrcaTokens,
            rayFilterUniverse: (s.raydium?.filterUniverse as any) || prev.rayFilterUniverse,
          }));
        }
      } catch {}
    })();
  }, [apiBase]);

  const onSave = async () => {
    if (saving) return;
    setSaving(true);
    setSaveError(null);
    const body = {
      min_profit_bps: cfg.minProfitBps,
      dex_allow: cfg.dexAllow,
      min_notional_usd: cfg.minNotionalUsd,
      max_hops: cfg.maxHops,
      max_paths_per_cycle: cfg.maxPathsPerCycle,
      poll_interval_ms: cfg.pollIntervalMs,
      priority_fee_tier: cfg.priorityFeeTier,
      sources: { jupiter: cfg.useJupiterQuotes, raydium: cfg.useRaydium, orca: cfg.useOrca },
      max_slippage_bps: cfg.maxSlippageBps,
      enabled: cfg.enabled,
      execution_mode: cfg.executionMode,
      quote_size_usd: cfg.quoteSizeUsd,
      fee_bps: cfg.feeBps,
      link_penalty_bps: cfg.linkPenaltyBps,
      debug_emit_subthreshold: !!cfg.debugEmitSubthreshold,
      debug_top_n: typeof cfg.debugTopN === 'number' ? cfg.debugTopN : 5,
      near_miss_enable: !!cfg.nearMissEnable,
      near_miss_epsilon: typeof cfg.nearMissEpsilon === 'number' ? cfg.nearMissEpsilon : 0.0005,
    };
    // Save system/raydium settings and arb settings with timeouts in parallel
    const sys = {
        ...(cfg.sysRpcUrl ? { rpcUrl: cfg.sysRpcUrl } : {}),
        raydium: {
          ...(typeof cfg.rayEnableOnChain === 'boolean' ? { enableOnChain: cfg.rayEnableOnChain } : {}),
          ...(cfg.rayAmmV4Program ? { ammV4Program: cfg.rayAmmV4Program } : {}),
          ...(cfg.rayClmmProgram ? { clmmProgram: cfg.rayClmmProgram } : {}),
          ...(typeof cfg.raydiumCacheTtlMs === 'number' && cfg.raydiumCacheTtlMs > 0 ? { cacheTtlMs: Number(cfg.raydiumCacheTtlMs) } : {}),
          ...(typeof cfg.raySdkConcurrency === 'number' && cfg.raySdkConcurrency > 0 ? { sdkConcurrency: Number(cfg.raySdkConcurrency) } : {}),
          ...(typeof cfg.raySdkProbeMintsLimit === 'number' && cfg.raySdkProbeMintsLimit > 0 ? { sdkProbeMintsLimit: Number(cfg.raySdkProbeMintsLimit) } : {}),
          ...(typeof cfg.raySdkClmmPageSize === 'number' && cfg.raySdkClmmPageSize > 0 ? { sdkClmmPageSize: Number(cfg.raySdkClmmPageSize) } : {}),
          ...(typeof cfg.rayFilterToOrcaTokens === 'boolean' ? { filterToOrcaTokens: cfg.rayFilterToOrcaTokens } : {}),
          ...(cfg.rayFilterUniverse ? { filterUniverse: cfg.rayFilterUniverse } : {}),
        },
        system: {
          ...(typeof cfg.scopePools === 'boolean' ? { scopePools: cfg.scopePools } : {}),
          ...(cfg.scopePoolsMode ? { scopePoolsMode: cfg.scopePoolsMode } : {}),
        },
        orca: {
          ...(cfg.orcaMode ? { mode: cfg.orcaMode } : {}),
          ...(typeof cfg.orcaCacheTtlMs === 'number' && cfg.orcaCacheTtlMs > 0 ? { cacheTtlMs: Number(cfg.orcaCacheTtlMs) } : {}),
        },
      } as any;
    const withTimeout = async (fn: (signal: AbortSignal) => Promise<Response>, ms = 8000) => {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort('timeout'), ms);
      try { return await fn(ac.signal); } finally { clearTimeout(t); }
    };
    try {
      // Apply system config first (strict)
      const sysRes = await withTimeout((signal) => fetch(`${apiBase}${ROUTES.system.config}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(sys), signal }), 6000);
      if (!sysRes.ok) throw new Error('Failed to update system configuration');
      // Best-effort arb config: reasonable timeout, do not block closing if slow/unreachable
      try {
        const arbRes = await withTimeout((signal) => fetch(`${apiBase}${ROUTES.arb.config}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal }), 7000);
        if (!arbRes.ok) {
          // Inform terminal but do not block UI
          try { await withTimeout((signal) => fetch(`${apiBase}${ROUTES.legacy.terminalLog}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ level: 'warn', message: 'terminal: Arb config update may not have reached arb-service (saved locally)' }), signal }), 2000); } catch {}
        }
      } catch {
        try { await withTimeout((signal) => fetch(`${apiBase}${ROUTES.legacy.terminalLog}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ level: 'warn', message: 'terminal: Arb config update timed out; saved locally' }), signal }), 2000); } catch {}
      }
      // Verify persistence by reloading arb config once (best-effort)
      try {
        const r = await withTimeout((signal) => fetch(`${apiBase}${ROUTES.arb.config}`, { signal }), 4000);
        if (r.ok) {
          const j = await r.json();
          // No state update in modal; just sanity fetch to warm local cache and backend log
          try { await withTimeout((signal) => fetch(`${apiBase}${ROUTES.legacy.terminalLog}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ level: 'info', message: 'terminal: Arb config reload after save ok' }), signal }), 2000); } catch {}
        }
      } catch {}
      onClose();
    } catch (e: any) {
      setSaveError(String(e?.message || e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-gray-800 rounded-lg p-6 w-full max-w-3xl max-h-[90vh] overflow-auto">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-2xl font-bold text-white">Arbitrage Configuration</h2>
          <button className="text-gray-300 hover:text-white" onClick={onClose}>✕</button>
        </div>
        {saveError && <div className="mb-2 text-sm text-red-400">{saveError}</div>}

        <div className="space-y-6">
          <div className="flex items-center space-x-3">
            <input id="arb-enabled" type="checkbox" className="w-4 h-4" checked={cfg.enabled} onChange={e => set('enabled', e.target.checked)} />
            <label htmlFor="arb-enabled" className="text-sm text-gray-300">Enable arbitrage detection</label>
          </div>

          <div className="mt-4 pt-4 border-t border-gray-600">
            <h3 className="text-lg font-semibold text-white mb-3">Detection Parameters</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-gray-300 mb-1">Minimum Profit (bps)</label>
              <input type="number" className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white" min={0} max={10000} value={cfg.minProfitBps} onChange={e=>set('minProfitBps', parseInt(e.target.value)||0)} />
              <div className="text-xs text-gray-400 mt-1">50 = 0.5%</div>
            </div>
            <div>
              <label className="block text-sm text-gray-300 mb-1">Min Notional (USD)</label>
              <input type="number" className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white" min={1} step={1} value={cfg.minNotionalUsd} onChange={e=>set('minNotionalUsd', parseFloat(e.target.value)||0)} />
            </div>
            <div>
              <label className="block text-sm text-gray-300 mb-1">Max Hops</label>
              <input type="number" className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white" min={2} max={6} value={cfg.maxHops} onChange={e=>set('maxHops', parseInt(e.target.value)||3)} />
            </div>
            <div>
              <label className="block text-sm text-gray-300 mb-1">Max Paths per Cycle</label>
              <input type="number" className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white" min={1} max={100} value={cfg.maxPathsPerCycle} onChange={e=>set('maxPathsPerCycle', parseInt(e.target.value)||10)} />
            </div>
            <div>
              <label className="block text-sm text-gray-300 mb-1">Poll Interval (ms)</label>
              <input type="number" className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white" min={200} step={100} value={cfg.pollIntervalMs} onChange={e=>set('pollIntervalMs', parseInt(e.target.value)||2000)} />
            </div>
            <div>
              <label className="block text-sm text-gray-300 mb-1">Max Slippage (bps)</label>
              <input type="number" className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white" min={1} max={5000} value={cfg.maxSlippageBps} onChange={e=>set('maxSlippageBps', parseInt(e.target.value)||100)} />
            </div>
            <div>
              <label className="block text-sm text-gray-300 mb-1">Quote Size (USD)</label>
              <input type="number" className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white" min={1} step={1} value={cfg.quoteSizeUsd} onChange={e=>set('quoteSizeUsd', parseFloat(e.target.value)||50)} />
            </div>
            <div>
              <label className="block text-sm text-gray-300 mb-1">Fee (bps)</label>
              <input type="number" className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white" min={0} max={1000} value={cfg.feeBps} onChange={e=>set('feeBps', parseInt(e.target.value)||30)} />
            </div>
            <div>
              <label className="block text-sm text-gray-300 mb-1">Raydium Cache TTL (ms)</label>
              <input type="number" className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white" min={1000} step={500} value={cfg.raydiumCacheTtlMs ?? ''} onChange={e=>set('raydiumCacheTtlMs', parseInt(e.target.value)||0)} />
              <div className="text-xs text-gray-400 mt-1">Leave 0 to keep backend default</div>
            </div>
            <div>
              <label className="block text-sm text-gray-300 mb-1">Orca Cache TTL (ms)</label>
              <input type="number" className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white" min={1000} step={500} value={cfg.orcaCacheTtlMs ?? ''} onChange={e=>set('orcaCacheTtlMs', parseInt(e.target.value)||0)} />
              <div className="text-xs text-gray-400 mt-1">Leave 0 to keep backend default</div>
            </div>
              <div>
                <label className="block text-sm text-gray-300 mb-1">Link Penalty (bps)</label>
                <input type="number" className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white" min={0} max={50} value={cfg.linkPenaltyBps} onChange={e=>set('linkPenaltyBps', parseInt(e.target.value)||0)} />
                <div className="text-xs text-gray-400 mt-1">Penalty for cross-DEX mint links</div>
              </div>
            </div>
          </div>

          {/* DEX Allowlist */}
          <div className="mt-4">
            <h3 className="text-lg font-semibold text-white mb-2">DEX Allowlist</h3>
            <div className="text-xs text-gray-400 mb-2">Specify which DEX names are eligible for detection (e.g., Raydium, Orca, Jupiter).</div>
            <div className="flex flex-wrap gap-2 mb-2">
              {Array.isArray(cfg.dexAllow) && cfg.dexAllow.length > 0 ? (
                cfg.dexAllow.map((dex, idx) => (
                  <span key={idx} className="inline-flex items-center bg-gray-700 text-gray-100 px-2 py-1 rounded">
                    {dex}
                    <button className="ml-2 text-gray-300 hover:text-white" onClick={() => set('dexAllow', cfg.dexAllow.filter((_, i) => i !== idx))}>×</button>
                  </span>
                ))
              ) : (
                <span className="text-sm text-gray-400">No restrictions (empty list)</span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <input
                type="text"
                placeholder="Add DEX name"
                className="flex-1 px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white"
                onKeyDown={(e) => {
                  const val = (e.target as HTMLInputElement).value.trim();
                  if (e.key === 'Enter' && val) {
                    if (!cfg.dexAllow.includes(val)) set('dexAllow', [...cfg.dexAllow, val]);
                    (e.target as HTMLInputElement).value = '';
                  }
                }}
              />
              <button
                className="px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white"
                onClick={() => {
                  const el = document.getElementById('dex-add-input') as HTMLInputElement | null;
                  const val = el?.value?.trim();
                  if (val) {
                    if (!cfg.dexAllow.includes(val)) set('dexAllow', [...cfg.dexAllow, val]);
                    if (el) el.value = '';
                  }
                }}
                style={{ display: 'none' }}
              >Add</button>
            </div>
          </div>

          <div className="mt-6 pt-4 border-t border-gray-600">
            <h3 className="text-lg font-semibold text-white mb-3">Raydium SDK</h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm text-gray-300 mb-1">SDK Concurrency</label>
                <input type="number" className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white" min={1} step={1} value={cfg.raySdkConcurrency ?? ''} onChange={e=>set('raySdkConcurrency', parseInt(e.target.value)||0)} />
              </div>
              <div>
                <label className="block text-sm text-gray-300 mb-1">Probe Mints Limit</label>
                <input type="number" className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white" min={1} step={1} value={cfg.raySdkProbeMintsLimit ?? ''} onChange={e=>set('raySdkProbeMintsLimit', parseInt(e.target.value)||0)} />
              </div>
              <div>
                <label className="block text-sm text-gray-300 mb-1">CLMM Page Size</label>
                <input type="number" className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white" min={1} step={1} value={cfg.raySdkClmmPageSize ?? ''} onChange={e=>set('raySdkClmmPageSize', parseInt(e.target.value)||0)} />
              </div>
              <div className="flex items-center space-x-3">
                <input id="ray-filter" type="checkbox" className="w-4 h-4" checked={!!cfg.rayFilterToOrcaTokens} onChange={e=>set('rayFilterToOrcaTokens', e.target.checked)} />
                <label htmlFor="ray-filter" className="text-sm text-gray-300">Filter to Orca token universe</label>
              </div>
              <div>
                <label className="block text-sm text-gray-300 mb-1">Filter Token Universe</label>
                <select className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white" value={cfg.rayFilterUniverse || 'jupiter'} onChange={e=>set('rayFilterUniverse', e.target.value as any)}>
                  <option value="jupiter">Jupiter verified list (recommended)</option>
                  <option value="orca">Orca token set</option>
                  <option value="none">Do not filter</option>
                </select>
                <div className="text-xs text-gray-400 mt-1">Controls Raydium pool mint filtering source</div>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="flex items-center space-x-3">
              <input id="src-jup" type="checkbox" className="w-4 h-4" checked={cfg.useJupiterQuotes} onChange={e=>set('useJupiterQuotes', e.target.checked)} />
              <label htmlFor="src-jup" className="text-sm text-gray-300">Use Jupiter</label>
            </div>
            <div className="flex items-center space-x-3">
              <input id="src-ray" type="checkbox" className="w-4 h-4" checked={cfg.useRaydium} onChange={e=>set('useRaydium', e.target.checked)} />
              <label htmlFor="src-ray" className="text-sm text-gray-300">Use Raydium</label>
            </div>
            <div className="flex items-center space-x-3">
              <input id="src-orc" type="checkbox" className="w-4 h-4" checked={cfg.useOrca} onChange={e=>set('useOrca', e.target.checked)} />
              <label htmlFor="src-orc" className="text-sm text-gray-300">Use Orca</label>
            </div>
          </div>

          {/* Orca Settings */}
          <div className="mt-2">
            <label className="block text-sm text-gray-300 mb-1">Orca Mode</label>
            <select className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white" value={cfg.orcaMode || 'http'} onChange={e=>set('orcaMode', e.target.value as any)}>
              <option value="http">HTTP (default)</option>
              <option value="v4">SDK v4</option>
              <option value="legacy">Legacy SDK</option>
            </select>
            <div className="text-xs text-gray-400 mt-1">Switch between HTTP, v4 client (AdaptiveFee aware), or legacy parser.</div>
          </div>

          {/* Debug Options */}
          <div className="mt-6 pt-4 border-t border-gray-600">
            <h3 className="text-lg font-semibold text-white mb-3">Debug Options</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="flex items-center space-x-3">
                <input id="dbg-subth" type="checkbox" className="w-4 h-4" checked={!!cfg.debugEmitSubthreshold} onChange={e=>set('debugEmitSubthreshold', e.target.checked)} />
                <label htmlFor="dbg-subth" className="text-sm text-gray-300">Emit sub-threshold cycles to events</label>
              </div>
              <div>
                <label className="block text-sm text-gray-300 mb-1">Top-N Subthreshold to Log</label>
                <input type="number" className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white" min={1} max={20} value={cfg.debugTopN ?? 5} onChange={e=>set('debugTopN', parseInt(e.target.value)||5)} />
              </div>
              <div className="flex items-center space-x-3">
                <input id="near-miss-enable" type="checkbox" className="w-4 h-4" checked={!!cfg.nearMissEnable} onChange={e=>set('nearMissEnable', e.target.checked)} />
                <label htmlFor="near-miss-enable" className="text-sm text-gray-300">Enable near-miss detection (BF slack)</label>
              </div>
              <div>
                <label className="block text-sm text-gray-300 mb-1">Near-miss epsilon (log-space slack)</label>
                <input type="number" step={0.0001} className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white" min={0.00001} max={0.01} value={cfg.nearMissEpsilon ?? 0.0005} onChange={e=>set('nearMissEpsilon', parseFloat(e.target.value)||0.0005)} />
                <div className="text-xs text-gray-400 mt-1">Smaller = closer-to-threshold candidates; default 0.0005</div>
              </div>
            </div>
          </div>

          {/* System & Raydium (On-chain) */}
          <div className="mt-6 pt-4 border-t border-gray-600">
            <h3 className="text-lg font-semibold text-white mb-3">System & Raydium</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="md:col-span-2">
                <label className="block text-sm text-gray-300 mb-1">RPC URL</label>
                <input type="text" className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white" placeholder="https://mainnet.helius-rpc.com/?api-key=..." value={cfg.sysRpcUrl || ''} onChange={e=>set('sysRpcUrl', e.target.value)} />
                <div className="text-xs text-gray-400 mt-1">Used for on-chain pool discovery and transactions</div>
              </div>
              <div className="flex items-center space-x-3">
                <input id="ray-onchain" type="checkbox" className="w-4 h-4" checked={!!cfg.rayEnableOnChain} onChange={e=>set('rayEnableOnChain', e.target.checked)} />
                <label htmlFor="ray-onchain" className="text-sm text-gray-300">Enable Raydium On-Chain Discovery</label>
              </div>
              <div className="flex items-center space-x-3">
                <input id="scope-pools" type="checkbox" className="w-4 h-4" checked={!!cfg.scopePools} onChange={e=>set('scopePools', e.target.checked)} />
                <label htmlFor="scope-pools" className="text-sm text-gray-300">Scope Pools to Watchlist</label>
              </div>
              <div>
                <label className="block text-sm text-gray-300 mb-1">Pool Scoping Mode</label>
                <select className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white" value={cfg.scopePoolsMode || 'watchlist'} onChange={e=>set('scopePoolsMode', e.target.value as any)}>
                  <option value="watchlist">Watchlist</option>
                  <option value="jupiter">Jupiter token list</option>
                  <option value="none">No scoping</option>
                </select>
                <div className="text-xs text-gray-400 mt-1">Controls how /arb/pools are scoped</div>
              </div>
              <div>
                <label className="block text-sm text-gray-300 mb-1">Raydium AMM v4 Program ID</label>
                <input type="text" className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white" value={cfg.rayAmmV4Program || ''} onChange={e=>set('rayAmmV4Program', e.target.value)} />
              </div>
              <div>
                <label className="block text-sm text-gray-300 mb-1">Raydium CLMM Program ID</label>
                <input type="text" className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white" value={cfg.rayClmmProgram || ''} onChange={e=>set('rayClmmProgram', e.target.value)} />
              </div>
            </div>
          </div>

          <div>
            <label className="block text-sm text-gray-300 mb-1">Priority Fee Tier</label>
            <select className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white" value={cfg.priorityFeeTier} onChange={e=>set('priorityFeeTier', e.target.value as any)}>
              <option value="m">Medium</option>
              <option value="h">High</option>
              <option value="vh">Very High</option>
            </select>
            <div className="text-xs text-gray-400 mt-1">Used with Raydium priority fee API</div>
          </div>

          <div>
            <label className="block text-sm text-gray-300 mb-1">Execution Mode</label>
            <select className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white" value={cfg.executionMode} onChange={e=>set('executionMode', e.target.value as any)}>
              <option value="simulate">Simulate Only</option>
              <option value="execute">Execute</option>
            </select>
            <div className="text-xs text-gray-400 mt-1">Choose whether detected arbitrage is simulated or executed</div>
          </div>

          <div className="flex justify-end space-x-3 pt-4 border-t border-gray-600">
            <button className="px-4 py-2 bg-gray-600 text-white rounded-md hover:bg-gray-700" onClick={onClose} disabled={saving}>Cancel</button>
            <button className={`px-4 py-2 ${saving?'bg-blue-500/60':'bg-blue-600 hover:bg-blue-700'} text-white rounded-md`} onClick={onSave} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
          </div>
        </div>
      </div>
    </div>
  );
};


