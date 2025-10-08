import React from 'react';
import { App as LegacyApp } from '../pages/App';
import { useSocketEvents } from './hooks/useSocketEvents';
import { useAuth } from './contexts/auth';
import { useSocketExtraEvents } from './hooks/useSocketExtraEvents';
import { useArb } from './contexts/arb';
import { useWallet } from './contexts/wallet';

export const AppShell: React.FC = () => {
  const { credentials } = useAuth();
  useSocketEvents();
  const { setStrategies } = useArb();
  const { setWatchlist, setWalletHistory } = useWallet();
  useSocketExtraEvents({
    onStrategiesUpdate: async (list: any[]) => {
      try { const base = Array.isArray(list) ? list : []; setStrategies(base); } catch {}
    },
    onPositions: (p) => { /* positions are local to App UI; no-op here */ },
    onGridPositions: (payload) => { /* grid position summary remains in App for now */ },
    onWalletHistory: (h) => { try { setWalletHistory(Array.isArray(h) ? h : []); } catch {} },
    onActivity: (a) => { /* activity map remains in App for now */ },
    onWatchlist: (list) => { try { setWatchlist(Array.isArray(list) ? list : []); } catch {} },
  });
  // Render legacy App until sections are fully extracted
  return <LegacyApp />;
};


