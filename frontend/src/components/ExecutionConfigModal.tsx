// @ts-nocheck
import React, { useEffect, useMemo, useState } from 'react';
import { ROUTES } from '../utils/routes';

interface Props {
  apiBase?: string;
  onClose: () => void;
  onSaved?: () => void;
}

export const ExecutionConfigModal: React.FC<Props> = ({ apiBase = '/api', onClose, onSaved }) => {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<any>({
    jito: { enabled: false, blockEngineUrl: '', tipPayerKeypath: '', bundleTimeoutMs: 1200 },
    rpcSend: { secondaryRpcUrls: '', sendTimeoutMs: 1200 },
    drift: {
      altRefreshMs: 300000,
      maxOracleDelaySlots: 40,
      fillerPriorityFloorMicroLamports: 15000,
      feeMultipliersText: '{"perp-0":1.0}',
    },
  });

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
        const feeMultipliersText = (() => {
          try { return JSON.stringify(drift?.feeMultipliers || {}, null, 2); } catch { return '{}'; }
        })();
        const secondaryRpcUrls = Array.isArray(rpcSend?.secondaryRpcUrls) ? (rpcSend.secondaryRpcUrls as string[]).join('\n') : (rpcSend?.secondaryRpcUrls || '');
        setForm({
          jito: {
            enabled: !!jito.enabled,
            blockEngineUrl: String(jito.blockEngineUrl || ''),
            tipPayerKeypath: String(jito.tipPayerKeypath || ''),
            bundleTimeoutMs: Number.isFinite(Number(jito.bundleTimeoutMs)) ? Number(jito.bundleTimeoutMs) : 1200,
          },
          rpcSend: {
            secondaryRpcUrls,
            sendTimeoutMs: Number.isFinite(Number(rpcSend.sendTimeoutMs)) ? Number(rpcSend.sendTimeoutMs) : 1200,
          },
          drift: {
            altRefreshMs: Number.isFinite(Number(drift.altRefreshMs)) ? Number(drift.altRefreshMs) : 300000,
            maxOracleDelaySlots: Number.isFinite(Number(drift.maxOracleDelaySlots)) ? Number(drift.maxOracleDelaySlots) : 40,
            fillerPriorityFloorMicroLamports: Number.isFinite(Number(drift.fillerPriorityFloorMicroLamports)) ? Number(drift.fillerPriorityFloorMicroLamports) : 15000,
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
        jito: {
          enabled: !!form.jito.enabled,
          blockEngineUrl: String(form.jito.blockEngineUrl || ''),
          tipPayerKeypath: String(form.jito.tipPayerKeypath || ''),
          bundleTimeoutMs: Math.max(250, Number(form.jito.bundleTimeoutMs || 1200)),
        },
        rpcSend: {
          secondaryRpcUrls,
          sendTimeoutMs: Math.max(250, Number(form.rpcSend.sendTimeoutMs || 1200)),
        },
        drift: {
          altRefreshMs: Math.max(60000, Number(form.drift.altRefreshMs || 300000)),
          maxOracleDelaySlots: Math.max(0, Number(form.drift.maxOracleDelaySlots || 40)),
          fillerPriorityFloorMicroLamports: Math.max(0, Number(form.drift.fillerPriorityFloorMicroLamports || 15000)),
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

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-gray-800 rounded-lg p-6 w-full max-w-4xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-2xl font-bold text-white">Execution Configuration</h2>
          <button onClick={onClose} className="px-3 py-1 bg-gray-600 text-white rounded hover:bg-gray-700">Close</button>
        </div>

        {error && <div className="mb-4 p-3 rounded bg-red-900 text-red-200 text-sm">{error}</div>}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
          {/* Jito */}
          <div className="md:col-span-2 border-b border-gray-700 pb-2 text-gray-200 font-semibold">Jito</div>
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

          {/* RPC Send Fallback */}
          <div className="md:col-span-2 border-b border-gray-700 pb-2 text-gray-200 font-semibold mt-2">RPC Send Fallback</div>
          <div className="md:col-span-2">
            <div className="text-gray-400 mb-1">Secondary RPC URLs (one per line)</div>
            <textarea className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white min-h-[80px]" value={form.rpcSend.secondaryRpcUrls}
              onChange={(e) => setForm((p: any) => ({ ...p, rpcSend: { ...p.rpcSend, secondaryRpcUrls: e.target.value } }))} placeholder="https://api.mainnet-beta.solana.com\nhttps://rpc.ankr.com/solana" />
          </div>
          <div>
            <div className="text-gray-400 mb-1">Send Timeout (ms)</div>
            <input type="number" className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white" value={form.rpcSend.sendTimeoutMs}
              onChange={(e) => setForm((p: any) => ({ ...p, rpcSend: { ...p.rpcSend, sendTimeoutMs: Number(e.target.value) } }))} />
          </div>

          {/* Drift */}
          <div className="md:col-span-2 border-b border-gray-700 pb-2 text-gray-200 font-semibold mt-2">Drift Runtime</div>
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
          <div className="md:col-span-2">
            <div className="text-gray-400 mb-1">Fee Multipliers (JSON)</div>
            <textarea className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white min-h-[120px]" value={form.drift.feeMultipliersText}
              onChange={(e) => setForm((p: any) => ({ ...p, drift: { ...p.drift, feeMultipliersText: e.target.value } }))} placeholder='{"perp-0":1.0, "perp-1":1.2}' />
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


