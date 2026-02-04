// @ts-nocheck
import React, { useEffect, useMemo, useState } from 'react';
import { ROUTES } from '../utils/routes';
import { useModalConfig } from '../app/hooks/useModalConfig';

interface Props {
  apiBase?: string;
  onClose: () => void;
  onSaved?: () => void;
}

export const ExecutionConfigModal: React.FC<Props> = ({ apiBase = '/api', onClose, onSaved }) => {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  // Persist UI preferences AND form values to localStorage
  const [uiPrefs, updateUiPrefs] = useModalConfig('executionConfig', {
    expandedSections: {
      txSend: true,
      jito: true,
      rpcSend: true,
      drift: true,
    },
    // Save last used form values (excluding sensitive fields like keypaths)
    lastValues: null as any,
  });
  
  const [form, setForm] = useState<any>(() => {
    const defaults = {
      txSend: { resendEnabled: true, maxResendAttempts: 10, maxConfirmTimeMs: 30000 },
      jito: { enabled: false, blockEngineUrl: '', tipPayerKeypath: '', bundleTimeoutMs: 1200, tipMode: 'dynamic', fixedTipLamports: 10000, tipShare: 0.3, useDontFrontAccount: false, tipAccount: '' },
      rpcSend: { secondaryRpcUrls: '', sendTimeoutMs: 1200 },
      driftBots: {
        enabled: true,
        port: 3015,
        respawn: true,
        useTsx: false,
        callbackUrl: '',
        secret: '',
      },
      drift: {
        altRefreshMs: 300000,
        maxOracleDelaySlots: 40,
        fillerPriorityFloorMicroLamports: 15000,
        triggerPriorityFloorMicroLamports: 10000,
        marketCacheTtlMs: 2000,
        hotMarketsPerLoop: 25,
        verboseNodeLogs: false,
        nodeLogSampleRate: 0,
        nodeMapTtlMs: 60000,
        nodeMapMax: 20000,
        liquidator: {
          oracleTwapGuardPct: 0.5,
          oracleGuardCooldownMs: 5000,
          hotUsersPerTick: 25,
        },
        feeMultipliersText: '{"perp-0":1.0}',
      },
    };
    const saved = uiPrefs.lastValues;
    if (!saved) return defaults;
    return {
      ...defaults,
      ...saved,
      txSend: { ...defaults.txSend, ...(saved.txSend || {}) },
      jito: { ...defaults.jito, ...(saved.jito || {}), tipPayerKeypath: '' },
      rpcSend: { ...defaults.rpcSend, ...(saved.rpcSend || {}) },
      driftBots: { ...defaults.driftBots, ...(saved.driftBots || {}), secret: '' },
      drift: {
        ...defaults.drift,
        ...(saved.drift || {}),
        liquidator: {
          ...defaults.drift.liquidator,
          ...((saved.drift || {}).liquidator || {}),
        },
      },
    };
  });
  
  // Save form values to localStorage when they change (excluding sensitive fields)
  useEffect(() => {
    const sanitized = {
      txSend: form.txSend,
      jito: {
        ...form.jito,
        tipPayerKeypath: '', // Don't persist keypaths
      },
      rpcSend: form.rpcSend,
      driftBots: { ...form.driftBots, secret: '' },
      drift: form.drift,
    };
    updateUiPrefs({ lastValues: sanitized });
  }, [form]);

  useEffect(() => {
    let ok = true;
    (async () => {
      try {
        setLoading(true);
        const res = await fetch(`${apiBase}${ROUTES.exec.config}`);
        const cfg = await res.json().catch(() => ({}));
        if (!ok) return;
        const jito = cfg?.jito || {};
        const rpcSend = cfg?.rpcSend || {};
        const drift = cfg?.drift || {};
        const driftBots = cfg?.driftBots || {};
        const liq = drift?.liquidator || {};
        const feeMultipliersText = (() => {
          try { return JSON.stringify(drift?.feeMultipliers || {}, null, 2); } catch { return '{}'; }
        })();
        const secondaryRpcUrls = Array.isArray(rpcSend?.secondaryRpcUrls) ? (rpcSend.secondaryRpcUrls as string[]).join('\n') : (rpcSend?.secondaryRpcUrls || '');
        setForm({
          txSend: {
            resendEnabled: cfg?.resendEnabled !== false, // Default: true
            maxResendAttempts: Number.isFinite(Number(cfg?.maxResendAttempts)) ? Number(cfg.maxResendAttempts) : 10,
            maxConfirmTimeMs: Number.isFinite(Number(cfg?.maxConfirmTimeMs)) ? Number(cfg.maxConfirmTimeMs) : 30000,
          },
          jito: {
            enabled: !!jito.enabled,
            blockEngineUrl: String(jito.blockEngineUrl || ''),
            tipPayerKeypath: String(jito.tipPayerKeypath || ''),
            bundleTimeoutMs: Number.isFinite(Number(jito.bundleTimeoutMs)) ? Number(jito.bundleTimeoutMs) : 1200,
            tipMode: String(jito.tipMode || 'dynamic'),
            fixedTipLamports: Number.isFinite(Number(jito.fixedTipLamports)) ? Number(jito.fixedTipLamports) : 10000,
            tipShare: Number.isFinite(Number(jito.tipShare)) ? Number(jito.tipShare) : 0.3,
            useDontFrontAccount: !!jito.useDontFrontAccount,
            tipAccount: String(jito.tipAccount || ''),
          },
          rpcSend: {
            secondaryRpcUrls,
            sendTimeoutMs: Number.isFinite(Number(rpcSend.sendTimeoutMs)) ? Number(rpcSend.sendTimeoutMs) : 1200,
          },
          driftBots: {
            enabled: driftBots.enabled !== false,
            port: Number.isFinite(Number(driftBots.port)) ? Number(driftBots.port) : 3015,
            respawn: driftBots.respawn !== false,
            useTsx: !!driftBots.useTsx,
            callbackUrl: String(driftBots.callbackUrl || ''),
            secret: String(driftBots.secret || ''),
          },
          drift: {
            altRefreshMs: Number.isFinite(Number(drift.altRefreshMs)) ? Number(drift.altRefreshMs) : 300000,
            maxOracleDelaySlots: Number.isFinite(Number(drift.maxOracleDelaySlots)) ? Number(drift.maxOracleDelaySlots) : 40,
            fillerPriorityFloorMicroLamports: Number.isFinite(Number(drift.fillerPriorityFloorMicroLamports)) ? Number(drift.fillerPriorityFloorMicroLamports) : 15000,
            triggerPriorityFloorMicroLamports: Number.isFinite(Number(drift.triggerPriorityFloorMicroLamports)) ? Number(drift.triggerPriorityFloorMicroLamports) : 10000,
            marketCacheTtlMs: Number.isFinite(Number(drift.marketCacheTtlMs)) ? Number(drift.marketCacheTtlMs) : 2000,
            hotMarketsPerLoop: Number.isFinite(Number(drift.hotMarketsPerLoop)) ? Number(drift.hotMarketsPerLoop) : 25,
            verboseNodeLogs: !!drift.verboseNodeLogs,
            nodeLogSampleRate: Number.isFinite(Number(drift.nodeLogSampleRate)) ? Number(drift.nodeLogSampleRate) : 0,
            nodeMapTtlMs: Number.isFinite(Number(drift.nodeMapTtlMs)) ? Number(drift.nodeMapTtlMs) : 60000,
            nodeMapMax: Number.isFinite(Number(drift.nodeMapMax)) ? Number(drift.nodeMapMax) : 20000,
            liquidator: {
              oracleTwapGuardPct: Number.isFinite(Number(liq.oracleTwapGuardPct)) ? Number(liq.oracleTwapGuardPct) : 0.5,
              oracleGuardCooldownMs: Number.isFinite(Number(liq.oracleGuardCooldownMs)) ? Number(liq.oracleGuardCooldownMs) : 5000,
              hotUsersPerTick: Number.isFinite(Number(liq.hotUsersPerTick)) ? Number(liq.hotUsersPerTick) : 25,
            },
            feeMultipliersText,
          },
        });
      } catch (e: any) {
        setError(String(e?.message || e));
      } finally {
        setLoading(false);
      }
    })();
    return () => { ok = false; };
  }, [apiBase]);

  const handleSave = async () => {
    try {
      setSaving(true);
      setError(null);
      // Parse feeMultipliers
      let feeMultipliers: Record<string, number> = {};
      try {
        const parsed = JSON.parse(String(form.drift.feeMultipliersText || '{}'));
        if (parsed && typeof parsed === 'object') feeMultipliers = parsed;
      } catch {
        throw new Error('feeMultipliers must be valid JSON');
      }
      const secondaryRpcUrls = String(form.rpcSend.secondaryRpcUrls || '')
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
      const body: any = {
        // Transaction send settings (stored at top level of exec config)
        resendEnabled: !!form.txSend.resendEnabled,
        maxResendAttempts: Math.max(0, Math.min(50, Number(form.txSend.maxResendAttempts || 10))),
        maxConfirmTimeMs: Math.max(5000, Math.min(120000, Number(form.txSend.maxConfirmTimeMs || 30000))),
        jito: {
          enabled: !!form.jito.enabled,
          blockEngineUrl: String(form.jito.blockEngineUrl || ''),
          tipPayerKeypath: String(form.jito.tipPayerKeypath || ''),
          bundleTimeoutMs: Math.max(250, Number(form.jito.bundleTimeoutMs || 1200)),
          tipMode: String(form.jito.tipMode || 'dynamic'),
          fixedTipLamports: Math.max(0, Number(form.jito.fixedTipLamports || 0)),
          tipShare: Math.max(0, Math.min(1, Number(form.jito.tipShare || 0.3))),
          useDontFrontAccount: !!form.jito.useDontFrontAccount,
          tipAccount: String(form.jito.tipAccount || ''),
        },
        rpcSend: {
          secondaryRpcUrls,
          sendTimeoutMs: Math.max(250, Number(form.rpcSend.sendTimeoutMs || 1200)),
        },
        driftBots: {
          enabled: !!form.driftBots?.enabled,
          port: Math.max(1, Number(form.driftBots?.port || 3015)),
          respawn: !!form.driftBots?.respawn,
          useTsx: !!form.driftBots?.useTsx,
          callbackUrl: String(form.driftBots?.callbackUrl || ''),
          secret: String(form.driftBots?.secret || ''),
        },
        drift: {
          altRefreshMs: Math.max(60000, Number(form.drift.altRefreshMs || 300000)),
          maxOracleDelaySlots: Math.max(0, Number(form.drift.maxOracleDelaySlots || 40)),
          fillerPriorityFloorMicroLamports: Math.max(0, Number(form.drift.fillerPriorityFloorMicroLamports || 15000)),
          triggerPriorityFloorMicroLamports: Math.max(0, Number(form.drift.triggerPriorityFloorMicroLamports || 10000)),
          marketCacheTtlMs: Math.max(500, Number(form.drift.marketCacheTtlMs || 2000)),
          hotMarketsPerLoop: Math.max(1, Number(form.drift.hotMarketsPerLoop || 25)),
          verboseNodeLogs: !!form.drift.verboseNodeLogs,
          nodeLogSampleRate: Math.max(0, Math.min(1, Number(form.drift.nodeLogSampleRate || 0))),
          nodeMapTtlMs: Math.max(1000, Number(form.drift.nodeMapTtlMs || 60000)),
          nodeMapMax: Math.max(1000, Number(form.drift.nodeMapMax || 20000)),
          liquidator: {
            oracleTwapGuardPct: Math.max(0, Number(form.drift?.liquidator?.oracleTwapGuardPct ?? 0.5)),
            oracleGuardCooldownMs: Math.max(1000, Number(form.drift?.liquidator?.oracleGuardCooldownMs ?? 5000)),
            hotUsersPerTick: Math.max(1, Number(form.drift?.liquidator?.hotUsersPerTick ?? 25)),
          },
          feeMultipliers,
        },
      };
      const res = await fetch(`${apiBase}${ROUTES.exec.config}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error(await res.text());
      try { onSaved && onSaved(); } catch {}
      onClose();
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setSaving(false);
    }
  };

  const toggleSection = (section: 'txSend' | 'jito' | 'rpcSend' | 'drift') => {
    updateUiPrefs({
      expandedSections: {
        ...uiPrefs.expandedSections,
        [section]: !uiPrefs.expandedSections[section],
      },
    });
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-gray-800 rounded-lg p-6 w-full max-w-4xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-2xl font-bold text-white">Execution Configuration</h2>
          <button onClick={onClose} className="px-3 py-1 bg-gray-600 text-white rounded hover:bg-gray-700">Close</button>
        </div>

        {error && <div className="mb-4 p-3 rounded bg-red-900 text-red-200 text-sm">{error}</div>}

        <div className="space-y-4">
          {/* Transaction Send */}
          <div className="border border-gray-700 rounded">
            <div 
              className="md:col-span-2 bg-gray-700 px-4 py-2 text-gray-200 font-semibold cursor-pointer flex items-center justify-between"
              onClick={() => toggleSection('txSend')}
            >
              <span>Transaction Send</span>
              <span className="text-lg">{uiPrefs.expandedSections.txSend ? '▼' : '▶'}</span>
            </div>
            {uiPrefs.expandedSections.txSend && (
              <div className="p-4 grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
                <label className="flex items-center gap-2 md:col-span-2">
                  <input type="checkbox" className="h-4 w-4" checked={!!form.txSend?.resendEnabled}
                    onChange={(e) => setForm((p: any) => ({ ...p, txSend: { ...p.txSend, resendEnabled: e.target.checked } }))} />
                  <span className="text-gray-300">Enable Resend Until Confirmed</span>
                  <span className="text-gray-500 text-xs">(Aggressively resend transaction until confirmed or blockhash expires)</span>
                </label>
                <div>
                  <div className="text-gray-400 mb-1">Max Resend Attempts</div>
                  <input type="number" className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white" 
                    value={form.txSend?.maxResendAttempts ?? 10}
                    disabled={!form.txSend?.resendEnabled}
                    onChange={(e) => setForm((p: any) => ({ ...p, txSend: { ...p.txSend, maxResendAttempts: Number(e.target.value) } }))} />
                  <div className="text-gray-500 text-xs mt-1">Number of times to resend tx (0-50)</div>
                </div>
                <div>
                  <div className="text-gray-400 mb-1">Max Confirm Time (ms)</div>
                  <input type="number" className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white" 
                    value={form.txSend?.maxConfirmTimeMs ?? 30000}
                    disabled={!form.txSend?.resendEnabled}
                    onChange={(e) => setForm((p: any) => ({ ...p, txSend: { ...p.txSend, maxConfirmTimeMs: Number(e.target.value) } }))} />
                  <div className="text-gray-500 text-xs mt-1">Total time to wait for confirmation (5000-120000ms)</div>
                </div>
              </div>
            )}
          </div>

          {/* Jito */}
          <div className="border border-gray-700 rounded">
            <div 
              className="md:col-span-2 bg-gray-700 px-4 py-2 text-gray-200 font-semibold cursor-pointer flex items-center justify-between"
              onClick={() => toggleSection('jito')}
            >
              <span>Jito Bundling</span>
              <span className="text-lg">{uiPrefs.expandedSections.jito ? '▼' : '▶'}</span>
            </div>
            {uiPrefs.expandedSections.jito && (
              <div className="p-4 grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
                <label className="flex items-center gap-2">
                  <input type="checkbox" className="h-4 w-4" checked={!!form.jito.enabled} onChange={(e) => setForm((p: any) => ({ ...p, jito: { ...p.jito, enabled: e.target.checked } }))} />
                  <span className="text-gray-300">Enable Jito Bundling</span>
                </label>
                <div>
                  <div className="text-gray-400 mb-1">Block Engine URL</div>
                  <input type="text" className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white" value={form.jito.blockEngineUrl}
                    onChange={(e) => setForm((p: any) => ({ ...p, jito: { ...p.jito, blockEngineUrl: e.target.value } }))} placeholder="https://mainnet.block-engine.jito.wtf" />
                </div>
                <div>
                  <div className="text-gray-400 mb-1">Tip Payer Keypath</div>
                  <input type="text" className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white" value={form.jito.tipPayerKeypath}
                    onChange={(e) => setForm((p: any) => ({ ...p, jito: { ...p.jito, tipPayerKeypath: e.target.value } }))} placeholder="/path/to/tip-payer.json (optional)" />
                </div>
                <div>
                  <div className="text-gray-400 mb-1">Bundle Timeout (ms)</div>
                  <input type="number" className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white" value={form.jito.bundleTimeoutMs}
                    onChange={(e) => setForm((p: any) => ({ ...p, jito: { ...p.jito, bundleTimeoutMs: Number(e.target.value) } }))} />
                </div>
                <div>
                  <div className="text-gray-400 mb-1">Tip Mode</div>
                  <select className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white" value={form.jito.tipMode}
                    onChange={(e)=>setForm((p:any)=>({...p, jito:{...p.jito, tipMode:e.target.value}}))}>
                    <option value="dynamic">dynamic</option>
                    <option value="fixed">fixed</option>
                  </select>
                </div>
                <div>
                  <div className="text-gray-400 mb-1">Fixed Tip (lamports)</div>
                  <input type="number" className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white" value={form.jito.fixedTipLamports}
                    onChange={(e)=>setForm((p:any)=>({...p, jito:{...p.jito, fixedTipLamports:Number(e.target.value)}}))} />
                </div>
                <div>
                  <div className="text-gray-400 mb-1">Tip Share (0..1)</div>
                  <input type="number" step="0.05" className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white" value={form.jito.tipShare}
                    onChange={(e)=>setForm((p:any)=>({...p, jito:{...p.jito, tipShare:Number(e.target.value)}}))} />
                </div>
                <label className="flex items-center gap-2">
                  <input type="checkbox" className="h-4 w-4" checked={!!form.jito.useDontFrontAccount}
                    onChange={(e)=>setForm((p:any)=>({...p, jito:{...p.jito, useDontFrontAccount:e.target.checked}}))} />
                  <span className="text-gray-300">Use Jito "don't front" account</span>
                </label>
                <div>
                  <div className="text-gray-400 mb-1">Tip Account (pubkey)</div>
                  <input type="text" className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white" value={form.jito.tipAccount}
                    onChange={(e)=>setForm((p:any)=>({...p, jito:{...p.jito, tipAccount:e.target.value}}))} placeholder="TIP_RECIPIENT_PUBKEY" />
                </div>
              </div>
            )}
          </div>

          {/* RPC Send Fallback */}
          <div className="border border-gray-700 rounded">
            <div 
              className="md:col-span-2 bg-gray-700 px-4 py-2 text-gray-200 font-semibold cursor-pointer flex items-center justify-between"
              onClick={() => toggleSection('rpcSend')}
            >
              <span>RPC Send Fallback</span>
              <span className="text-lg">{uiPrefs.expandedSections.rpcSend ? '▼' : '▶'}</span>
            </div>
            {uiPrefs.expandedSections.rpcSend && (
              <div className="p-4 grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
                <div className="md:col-span-2">
                  <div className="text-gray-400 mb-1">Secondary RPC URLs (one per line)</div>
                  <textarea className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white min-h-[80px]" value={form.rpcSend.secondaryRpcUrls}
                    onChange={(e) => setForm((p: any) => ({ ...p, rpcSend: { ...p.rpcSend, secondaryRpcUrls: e.target.value } }))} placeholder="https://api.mainnet-beta.solana.com&#10;https://rpc.ankr.com/solana" />
                </div>
                <div>
                  <div className="text-gray-400 mb-1">Send Timeout (ms)</div>
                  <input type="number" className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white" value={form.rpcSend.sendTimeoutMs}
                    onChange={(e) => setForm((p: any) => ({ ...p, rpcSend: { ...p.rpcSend, sendTimeoutMs: Number(e.target.value) } }))} />
                </div>
              </div>
            )}
          </div>

          {/* Drift */}
          <div className="border border-gray-700 rounded">
            <div 
              className="md:col-span-2 bg-gray-700 px-4 py-2 text-gray-200 font-semibold cursor-pointer flex items-center justify-between"
              onClick={() => toggleSection('drift')}
            >
              <span>Drift Runtime</span>
              <span className="text-lg">{uiPrefs.expandedSections.drift ? '▼' : '▶'}</span>
            </div>
            {uiPrefs.expandedSections.drift && (
              <div className="p-4 grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
                <div>
                  <div className="text-gray-400 mb-1">ALT Refresh (ms)</div>
                  <input type="number" className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white" value={form.drift.altRefreshMs}
                    onChange={(e) => setForm((p: any) => ({ ...p, drift: { ...p.drift, altRefreshMs: Number(e.target.value) } }))} />
                </div>
                <div>
                  <div className="text-gray-400 mb-1">Max Oracle Delay (slots)</div>
                  <input type="number" className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white" value={form.drift.maxOracleDelaySlots}
                    onChange={(e) => setForm((p: any) => ({ ...p, drift: { ...p.drift, maxOracleDelaySlots: Number(e.target.value) } }))} />
                </div>
                <div>
                  <div className="text-gray-400 mb-1">Filler Priority Floor (µ-lamports)</div>
                  <input type="number" className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white" value={form.drift.fillerPriorityFloorMicroLamports}
                    onChange={(e) => setForm((p: any) => ({ ...p, drift: { ...p.drift, fillerPriorityFloorMicroLamports: Number(e.target.value) } }))} />
                </div>
                <div>
                  <div className="text-gray-400 mb-1">Trigger Priority Floor (µ-lamports)</div>
                  <input type="number" className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white" value={form.drift.triggerPriorityFloorMicroLamports}
                    onChange={(e) => setForm((p: any) => ({ ...p, drift: { ...p.drift, triggerPriorityFloorMicroLamports: Number(e.target.value) } }))} />
                </div>
                <div>
                  <div className="text-gray-400 mb-1">Market Cache TTL (ms)</div>
                  <input type="number" className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white" value={form.drift.marketCacheTtlMs}
                    onChange={(e) => setForm((p: any) => ({ ...p, drift: { ...p.drift, marketCacheTtlMs: Number(e.target.value) } }))} />
                </div>
                <div>
                  <div className="text-gray-400 mb-1">Hot Markets per Loop</div>
                  <input type="number" className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white" value={form.drift.hotMarketsPerLoop}
                    onChange={(e) => setForm((p: any) => ({ ...p, drift: { ...p.drift, hotMarketsPerLoop: Number(e.target.value) } }))} />
                </div>
                <label className="flex items-center gap-2 md:col-span-2">
                  <input type="checkbox" className="h-4 w-4" checked={!!form.drift.verboseNodeLogs}
                    onChange={(e) => setForm((p: any) => ({ ...p, drift: { ...p.drift, verboseNodeLogs: e.target.checked } }))} />
                  <span className="text-gray-300">Verbose per-node logs (debug level)</span>
                </label>
                <div>
                  <div className="text-gray-400 mb-1">Node Log Sample Rate (0..1)</div>
                  <input type="number" step="0.05" className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white" value={form.drift.nodeLogSampleRate}
                    onChange={(e) => setForm((p: any) => ({ ...p, drift: { ...p.drift, nodeLogSampleRate: Number(e.target.value) } }))} />
                </div>
                <div>
                  <div className="text-gray-400 mb-1">Node Map TTL (ms)</div>
                  <input type="number" className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white" value={form.drift.nodeMapTtlMs}
                    onChange={(e) => setForm((p: any) => ({ ...p, drift: { ...p.drift, nodeMapTtlMs: Number(e.target.value) } }))} />
                </div>
                <div>
                  <div className="text-gray-400 mb-1">Node Map Max (entries)</div>
                  <input type="number" className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white" value={form.drift.nodeMapMax}
                    onChange={(e) => setForm((p: any) => ({ ...p, drift: { ...p.drift, nodeMapMax: Number(e.target.value) } }))} />
                </div>
                <div className="md:col-span-2 border-t border-gray-700 pt-3 font-semibold text-gray-200">Drift Bots Process</div>
                <label className="flex items-center gap-2 md:col-span-2">
                  <input type="checkbox" className="h-4 w-4" checked={!!form.driftBots?.enabled}
                    onChange={(e) => setForm((p: any) => ({ ...p, driftBots: { ...p.driftBots, enabled: e.target.checked } }))} />
                  <span className="text-gray-300">Enable separate drift-bots process</span>
                </label>
                <div>
                  <div className="text-gray-400 mb-1">Bot Port</div>
                  <input type="number" className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white" value={form.driftBots?.port}
                    onChange={(e) => setForm((p: any) => ({ ...p, driftBots: { ...p.driftBots, port: Number(e.target.value) } }))} />
                </div>
                <label className="flex items-center gap-2">
                  <input type="checkbox" className="h-4 w-4" checked={!!form.driftBots?.respawn}
                    onChange={(e) => setForm((p: any) => ({ ...p, driftBots: { ...p.driftBots, respawn: e.target.checked } }))} />
                  <span className="text-gray-300">Respawn on exit</span>
                </label>
                <label className="flex items-center gap-2">
                  <input type="checkbox" className="h-4 w-4" checked={!!form.driftBots?.useTsx}
                    onChange={(e) => setForm((p: any) => ({ ...p, driftBots: { ...p.driftBots, useTsx: e.target.checked } }))} />
                  <span className="text-gray-300">Use tsx in dev</span>
                </label>
                <div className="md:col-span-2">
                  <div className="text-gray-400 mb-1">Callback URL</div>
                  <input type="text" className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white" value={form.driftBots?.callbackUrl}
                    onChange={(e) => setForm((p: any) => ({ ...p, driftBots: { ...p.driftBots, callbackUrl: e.target.value } }))} placeholder="http://127.0.0.1:3001/api/internal/drift-bots/events" />
                </div>
                <div className="md:col-span-2">
                  <div className="text-gray-400 mb-1">Shared Secret (optional)</div>
                  <input type="password" className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white" value={form.driftBots?.secret}
                    onChange={(e) => setForm((p: any) => ({ ...p, driftBots: { ...p.driftBots, secret: e.target.value } }))} placeholder="leave blank for localhost-only" />
                </div>
                <div className="md:col-span-2 border-t border-gray-700 pt-3 font-semibold text-gray-200">Liquidator Guardrails</div>
                <div>
                  <div className="text-gray-400 mb-1">Oracle/TWAP Guard (pct)</div>
                  <input type="number" step="0.01" className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white"
                    value={form.drift?.liquidator?.oracleTwapGuardPct}
                    onChange={(e) => setForm((p: any) => ({
                      ...p,
                      drift: {
                        ...p.drift,
                        liquidator: { ...(p.drift?.liquidator || {}), oracleTwapGuardPct: Number(e.target.value) }
                      }
                    }))} />
                </div>
                <div>
                  <div className="text-gray-400 mb-1">Oracle Guard Cooldown (ms)</div>
                  <input type="number" className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white"
                    value={form.drift?.liquidator?.oracleGuardCooldownMs}
                    onChange={(e) => setForm((p: any) => ({
                      ...p,
                      drift: {
                        ...p.drift,
                        liquidator: { ...(p.drift?.liquidator || {}), oracleGuardCooldownMs: Number(e.target.value) }
                      }
                    }))} />
                </div>
                <div>
                  <div className="text-gray-400 mb-1">Hot Users per Tick</div>
                  <input type="number" className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white"
                    value={form.drift?.liquidator?.hotUsersPerTick}
                    onChange={(e) => setForm((p: any) => ({
                      ...p,
                      drift: {
                        ...p.drift,
                        liquidator: { ...(p.drift?.liquidator || {}), hotUsersPerTick: Number(e.target.value) }
                      }
                    }))} />
                </div>
                <div className="md:col-span-2">
                  <div className="text-gray-400 mb-1">Fee Multipliers (JSON)</div>
                  <textarea className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white min-h-[120px]" value={form.drift.feeMultipliersText}
                    onChange={(e) => setForm((p: any) => ({ ...p, drift: { ...p.drift, feeMultipliersText: e.target.value } }))} placeholder='{"perp-0":1.0, "perp-1":1.2}' />
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <button disabled={saving} onClick={onClose} className="px-4 py-2 bg-gray-700 text-white rounded hover:bg-gray-600 disabled:opacity-60">Cancel</button>
          <button disabled={saving || loading} onClick={handleSave} className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-60">{saving ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </div>
  );
};

export default ExecutionConfigModal;


