import { useEffect } from 'react';
import { useSocket } from '../contexts/socket';

type Handlers = {
  onStrategiesUpdate?: (list: any[]) => void | Promise<void>;
  onPositions?: (p: any) => void;
  onGridPositions?: (payload: any) => void;
  onWalletHistory?: (h: any) => void;
  onActivity?: (a: any) => void;
  onWatchlist?: (list: any[]) => void;
};

export function useSocketExtraEvents(h: Handlers): void {
  const { socket } = useSocket();

  useEffect(() => {
    if (!socket) return;
    if (h.onStrategiesUpdate) socket.on('strategies-update', h.onStrategiesUpdate as any);
    if (h.onPositions) socket.on('positions', h.onPositions as any);
    if (h.onGridPositions) socket.on('grid-positions', h.onGridPositions as any);
    if (h.onWalletHistory) socket.on('wallet-history', h.onWalletHistory as any);
    if (h.onActivity) socket.on('activity', h.onActivity as any);
    if (h.onWatchlist) socket.on('watchlist-update', h.onWatchlist as any);
    return () => {
      try { if (h.onStrategiesUpdate) socket.off('strategies-update', h.onStrategiesUpdate as any); } catch {}
      try { if (h.onPositions) socket.off('positions', h.onPositions as any); } catch {}
      try { if (h.onGridPositions) socket.off('grid-positions', h.onGridPositions as any); } catch {}
      try { if (h.onWalletHistory) socket.off('wallet-history', h.onWalletHistory as any); } catch {}
      try { if (h.onActivity) socket.off('activity', h.onActivity as any); } catch {}
      try { if (h.onWatchlist) socket.off('watchlist-update', h.onWatchlist as any); } catch {}
    };
  }, [socket, h.onStrategiesUpdate, h.onPositions, h.onGridPositions, h.onWalletHistory, h.onActivity, h.onWatchlist]);
}


