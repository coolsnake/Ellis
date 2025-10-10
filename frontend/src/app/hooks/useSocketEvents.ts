import { useEffect } from 'react';
import { useSocket } from '../contexts/socket';
import { useSystem } from '../contexts/system';
import { useWallet } from '../contexts/wallet';
import { useLogs } from '../contexts/logs';
import { catToWindowId } from '../../utils/logs';
import { getLogLevel } from '../../utils/logger';

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

  useEffect(() => {
    if (!socket) return;
    const boundKey = '__ls_bound_events_base';
    if ((socket as any)[boundKey]) return;
    (socket as any)[boundKey] = true;

    const onConnect = () => { try { opts?.onConnect?.(); } catch {} };
    const onDisconnect = () => { try { opts?.onDisconnect?.(); } catch {} };
    const onSystem = (data: any) => {
      try { opts?.onSystem?.(data); } catch {}
      try { setSystem((prev: any) => ({ ...prev, ...data })); } catch {}
    };
    const onWalletUpdate = (data: any) => {
      try { setWallet((prev: any) => ({ ...prev, ...data })); } catch {}
    };
    const onLog = (evt: LogEvent & { cat?: string; muted?: boolean }) => {
      try {
        const cat = (evt?.cat || '').toLowerCase();
        const serverCats: string[] | undefined = (system as any)?.system?.frontendEnabledLogCategories || (system as any)?.system?.enabledLogCategories;
        const localCatsJson = typeof window !== 'undefined' ? window.localStorage.getItem('frontendEnabledLogCategories') : null;
        const localCats: string[] | null = localCatsJson ? JSON.parse(localCatsJson) : null;
        const allowedCats = Array.isArray(localCats) && localCats.length ? localCats : (Array.isArray(serverCats) ? serverCats : null);
        if (allowedCats && allowedCats.length && cat && !allowedCats.includes(cat)) return;
        if (evt.muted === true) return;
        // Apply frontend log level filter: hide messages below current level
        const levelOrder: Record<string, number> = { error: 0, warn: 1, info: 2, debug: 3 };
        const currentLevel = getLogLevel();
        const eventLevel = String((evt as any)?.level || 'info').toLowerCase();
        if (levelOrder[currentLevel] < (levelOrder as any)[eventLevel]) return;
        const id = catToWindowId.get(cat) || 'system';
        setLogsByWindow((prev) => {
          const base = Array.isArray((prev as any)[id]) ? (prev as any)[id] : [];
          return { ...(prev as any), [id]: [evt, ...base].slice(0, 500) } as any;
        });
      } catch {}
    };
    const onPrices = (p: any) => { try { setPrices(p || {}); } catch {} };

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
  }, [socket, system, setSystem, setWallet, setLogsByWindow, setPrices]);
}


