import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { useAuth } from './auth';
import { apiBase } from '../../utils/apiBase';
import { ROUTES } from '../../utils/routes';

type WalletContextValue = {
  wallet: any;
  setWallet: React.Dispatch<React.SetStateAction<any>>;
  walletTokens: any[];
  setWalletTokens: React.Dispatch<React.SetStateAction<any[]>>;
  prices: Record<string, { usdc: number | null; sol: number | null }>;
  setPrices: React.Dispatch<React.SetStateAction<Record<string, { usdc: number | null; sol: number | null }>>>;
};

const WalletContext = createContext<WalletContextValue | undefined>(undefined);

export const WalletProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [wallet, setWallet] = useState<any>(null);
  const [walletTokens, setWalletTokens] = useState<any[]>([]);
  const [prices, setPrices] = useState<Record<string, { usdc: number | null; sol: number | null }>>({});
  const { isAuthenticated } = useAuth();

  useEffect(() => {
    if (!isAuthenticated) return;
    (async () => {
      try { const w = await fetch(`${apiBase}${ROUTES.wallet.base}`).then(r => r.json()); setWallet(w); } catch {}
      try { const t = await fetch(`${apiBase}${ROUTES.wallet.tokens}`).then(r => r.json()); setWalletTokens(Array.isArray(t.list) ? t.list : (t.walletTokens || [])); } catch {}
    })();
  }, [isAuthenticated]);
  const value = useMemo<WalletContextValue>(() => ({ wallet, setWallet, walletTokens, setWalletTokens, prices, setPrices }), [wallet, walletTokens, prices]);
  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
};

export const useWallet = (): WalletContextValue => {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error('useWallet must be used within WalletProvider');
  return ctx;
};


