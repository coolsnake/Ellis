import React, { useEffect, useMemo, useRef, useState } from 'react';
import { CollapsibleSection } from './CollapsibleSection';
import type { LogEvent, WindowId } from '../utils/logs';
import { getStorageKey } from '../utils/logs';

export const LogWindow: React.FC<{
  id: WindowId;
  title: string;
  logs: LogEvent[];
  className?: string;
}> = ({ id, title, logs, className = '' }) => {
  const [paused, setPaused] = useState<boolean>(false);
  const [autoscroll, setAutoscroll] = useState<boolean>(true);
  const [unread, setUnread] = useState<number>(0);
  const listRef = useRef<HTMLUListElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Persist control state per window
  useEffect(() => {
    try {
      const p = localStorage.getItem(getStorageKey(id, 'paused'));
      const a = localStorage.getItem(getStorageKey(id, 'autoscroll'));
      if (p === '1') setPaused(true);
      if (a === '0') setAutoscroll(false);
    } catch {}
  }, [id]);

  useEffect(() => {
    try { localStorage.setItem(getStorageKey(id, 'paused'), paused ? '1' : '0'); } catch {}
  }, [id, paused]);
  useEffect(() => {
    try { localStorage.setItem(getStorageKey(id, 'autoscroll'), autoscroll ? '1' : '0'); } catch {}
  }, [id, autoscroll]);

  // Unread counter: increment when paused or scrolled up
  const atBottom = useRef<boolean>(true);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onScroll = () => {
      try {
        const nearBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 8;
        atBottom.current = nearBottom;
        if (nearBottom) setUnread(0);
      } catch {}
    };
    el.addEventListener('scroll', onScroll);
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    if (!logs.length) return;
    if (paused) { setUnread(u => u + 1); return; }
    if (autoscroll && atBottom.current) {
      try { const el = containerRef.current; if (el) el.scrollTop = el.scrollHeight; } catch {}
    } else {
      setUnread(u => u + 1);
    }
  }, [logs]);

  const clear = () => {
    // Consumer owns logs state; this component signals via event
    const evt = new CustomEvent('logwin:clear', { detail: { id } });
    try { window.dispatchEvent(evt); } catch {}
  };

  const rows = useMemo(() => logs, [logs]);

  const right = (
    <div className="flex items-center gap-2">
      {unread > 0 && <span className="text-xs px-2 py-0.5 rounded bg-blue-900/40 text-blue-300">{unread} new</span>}
      <label className="text-xs flex items-center gap-1">
        <input type="checkbox" checked={paused} onChange={(e)=>setPaused(e.target.checked)} />
        Pause
      </label>
      <label className="text-xs flex items-center gap-1">
        <input type="checkbox" checked={autoscroll} onChange={(e)=>setAutoscroll(e.target.checked)} />
        Autoscroll
      </label>
      <button className="text-xs px-2 py-1 rounded bg-gray-800 hover:bg-gray-700" onClick={clear}>Clear</button>
    </div>
  );

  return (
    <CollapsibleSection title={title} storageKey={`logwin:${id}:collapsed`} rightActions={right} className={className}>
      <div ref={containerRef} className="h-[32vh] overflow-auto">
        <ul ref={listRef} className="space-y-1">
          {rows.map((l, i) => {
            const colorByCat: Record<string,string> = {
              api: 'text-blue-300', jupiter: 'text-blue-300', raydium: 'text-emerald-300', orca: 'text-amber-300', meteora: 'text-teal-300',
              arb: 'text-indigo-300', strategy: 'text-green-300', pretrade: 'text-purple-300', trade: 'text-cyan-300',
              terminal: 'text-gray-300', graph: 'text-pink-300', pools: 'text-teal-300', price: 'text-orange-300',
              wallet: 'text-lime-300', server: 'text-slate-300', auth: 'text-fuchsia-300', system: 'text-zinc-300', other: 'text-gray-300', rust: 'text-red-300', drift: 'text-rose-300'
            };
            const cat = (l as any).cat as string | undefined;
            const color = l.level === 'error' ? 'text-red-400' : l.level === 'warn' ? 'text-yellow-400' : (cat ? (colorByCat as any)[cat] : null) || 'text-gray-300';
            const ctx = l.context as Record<string, unknown> | undefined;
            const reserved = new Set(['cat', 'subcat', 'code', 'cid', 'span']);
            const ctxParts: string[] = [];
            if (ctx && typeof ctx === 'object') {
              for (const [k, v] of Object.entries(ctx)) {
                if (reserved.has(k)) continue;
                if (v === undefined || v === null) continue;
                let vs: string;
                if (typeof v === 'number' || typeof v === 'boolean') {
                  vs = String(v);
                } else if (typeof v === 'string') {
                  vs = v;
                } else if (Array.isArray(v)) {
                  vs = `[${v.length}]`;
                } else {
                  try { vs = JSON.stringify(v); } catch { vs = '[obj]'; }
                }
                if (vs.length > 120) vs = vs.slice(0, 117) + '...';
                ctxParts.push(`${k}=${vs}`);
              }
            }
            return (
              <li key={i} className={`text-sm ${color}`}>
                <span className="text-gray-500">[{l.timestamp}]</span> <span className="uppercase text-gray-400">{l.level}</span> {cat ? <span className={`uppercase ${color}`}>[{cat}]</span> : null} {(l as any).code ? <span className="text-blue-300">[{(l as any).code}]</span> : null} {(l as any).cid ? <span className="text-gray-400">(cid={(l as any).cid})</span> : null} {l.message} {ctxParts.length ? <span className="text-gray-400">{ctxParts.map((p, idx) => (<span key={idx}>({p}) </span>))}</span> : null}
              </li>
            );
          })}
          {rows.length === 0 && <li className="text-sm text-gray-500">No logs</li>}
        </ul>
      </div>
    </CollapsibleSection>
  );
};


