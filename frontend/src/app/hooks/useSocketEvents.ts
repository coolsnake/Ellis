import { useEffect, useRef } from 'react';
import { useSocket } from '../contexts/socket';
import { useSystem } from '../contexts/system';
import { useWallet } from '../contexts/wallet';
import { useLogs } from '../contexts/logs';
import { catToWindowId } from '../../utils/logs';
import { getLogLevel } from '../../utils/logger';
import { enqueueFrame, enqueueCritical } from '../../utils/scheduler';

type LogEvent = { level: string; message: string; timestamp: string; context?: Record<string, unknown>; cat?: string; subcat?: string; code?: string; cid?: string; span?: 'start' | 'end'; muted?: boolean };

type Options = {
  socket?: any;
  onConnect?: () => void;
  onDisconnect?: () => void;
  onSystem?: (data: any) => void;
};

export function useSocketEvents(opts?: Options): void {
  const { socket: ctxSocket } = useSocket();
  const socket = opts?.socket ?? ctxSocket;
  const { system, setSystem } = useSystem();
  const { setWallet, setPrices } = useWallet();
  const { setLogsByWindow } = useLogs();
  const systemRef = useRef(system);
  useEffect(() => { systemRef.current = system; }, [system]);
  const allowedCatsRef = useRef<string[] | null>(null);
  useEffect(() => {
    try {
      const serverCats: string[] | undefined = (systemRef.current as any)?.system?.frontendEnabledLogCategories || (systemRef.current as any)?.system?.enabledLogCategories;
      const localCatsJson = typeof window !== 'undefined' ? window.localStorage.getItem('frontendEnabledLogCategories') : null;
      const localCats: string[] | null = localCatsJson ? JSON.parse(localCatsJson) : null;
      allowedCatsRef.current = (Array.isArray(localCats) && localCats.length ? localCats : (Array.isArray(serverCats) ? serverCats : null)) || null;
    } catch {
      allowedCatsRef.current = null;
    }
  }, [system]);

  useEffect(() => {
    if (!socket) return;
    const boundKey = '__ls_bound_events_base';
    if ((socket as any)[boundKey]) return;
    (socket as any)[boundKey] = true;

    const onConnect = () => { try { opts?.onConnect?.(); } catch {} };
    const onDisconnect = () => { try { opts?.onDisconnect?.(); } catch {} };
    const onSystem = (data: any) => {
      enqueueFrame(() => {
        try { opts?.onSystem?.(data); } catch {}
        try { setSystem((prev: any) => ({ ...prev, ...data })); } catch {}
      });
    };
    const onWalletUpdate = (data: any) => {
      enqueueFrame(() => {
        try { setWallet((prev: any) => ({ ...prev, ...data })); } catch {}
      });
    };
    const onLog = (evt: LogEvent & { cat?: string; muted?: boolean }) => {
      try {
        const cat = (evt?.cat || '').toLowerCase();
        const allowedCats = allowedCatsRef.current || [];
        // Default mute of chatty graph logs unless explicitly allowed client-side or by server-config
        if (!allowedCats.length && cat === 'graph') return;
        if (allowedCats.length && cat && !allowedCats.includes(cat)) return;
        if (evt.muted === true) return;
        // Apply frontend log level filter: hide messages below current level
        const levelOrder: Record<string, number> = { error: 0, warn: 1, info: 2, debug: 3 };
        const currentLevel = getLogLevel();
        const eventLevel = String((evt as any)?.level || 'info').toLowerCase();
        if (levelOrder[currentLevel] < (levelOrder as any)[eventLevel]) return;
        const id = catToWindowId.get(cat) || 'system';
        // Per-frame buffered merge; cap 300 entries per window
        const store: any = (window as any).__ls_log_buffer__ || ((window as any).__ls_log_buffer__ = { buf: new Map<string, LogEvent[]>(), scheduled: false, seq: 0 });
        // Throttle high-rate graph logs to avoid main-thread jank
        try {
          if (cat === 'graph') {
            const now = Date.now();
            const last = Number((window as any).__ls_last_graph_at || 0);
            if (now - last < 75) return;
            (window as any).__ls_last_graph_at = now;
          }
        } catch {}
        // Assign a stable local key for React row identity
        try {
          store.seq = Number(store.seq || 0) + 1;
          (evt as any).__k = `${evt.timestamp}|${(evt as any).code || ''}|${(evt as any).cid || ''}|${evt.message}|${store.seq}`;
        } catch {}

        const list = store.buf.get(id) || [];
        list.push(evt);
        store.buf.set(id, list);
        if (!store.scheduled) {
          store.scheduled = true;
          const flush = () => {
            try {
              setLogsByWindow((prev) => {
                const next: any = { ...(prev as any) };
                for (const [wid, items] of store.buf.entries()) {
                  const base = Array.isArray(next[wid]) ? next[wid] : [];
                  // Append new items at the end; keep last 300 entries
                  const merged = base.length ? base.concat(items) : items;
                  const len = merged.length;
                  next[wid] = len > 300 ? merged.slice(len - 300) : merged;
                }
                return next;
              });
            } finally {
              store.buf.clear();
              store.scheduled = false;
            }
          };
          const ric: any = (window as any).requestIdleCallback;
          if (typeof ric === 'function') ric(flush, { timeout: 32 }); else requestAnimationFrame(flush);
        }
      } catch {}
    };
    const onPrices = (p: any) => {
      enqueueFrame(() => { try { setPrices(p || {}); } catch {} });
    };
    // Optional: future critical lane hooks (e.g., detector alerts)
    try { socket.on('arb:signal', (msg: any) => enqueueCritical(() => {})); } catch {}

    try { socket.on('connect', onConnect); } catch {}
    try { socket.on('disconnect', onDisconnect); } catch {}
    try { socket.on('system', onSystem); } catch {}
    try { socket.on('wallet-update', onWalletUpdate); } catch {}
    try { socket.on('log', onLog); } catch {}
    try { socket.on('prices-update', onPrices); } catch {}

    return () => {
      try { socket.off('connect', onConnect); } catch {}
      try { socket.off('disconnect', onDisconnect); } catch {}
      try { socket.off('system', onSystem); } catch {}
      try { socket.off('wallet-update', onWalletUpdate); } catch {}
      try { socket.off('log', onLog); } catch {}
      try { socket.off('prices-update', onPrices); } catch {}
      try { delete (socket as any)[boundKey]; } catch {}
    };
  }, [socket]);
}


