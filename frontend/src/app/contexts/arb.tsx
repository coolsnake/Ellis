import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { useAuth } from './auth';
import { apiBase } from '../../utils/apiBase';
import { ROUTES } from '../../utils/routes';

type ArbContextValue = {
  arbConfig: any;
  setArbConfig: React.Dispatch<React.SetStateAction<any>>;
  strategies: any[];
  setStrategies: React.Dispatch<React.SetStateAction<any[]>>;
};

const ArbContext = createContext<ArbContextValue | undefined>(undefined);

export const ArbProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [arbConfig, setArbConfig] = useState<any>(null);
  const [strategies, setStrategies] = useState<any[]>([]);
  const { isAuthenticated } = useAuth();

  useEffect(() => {
    if (!isAuthenticated) return;
    (async () => {
      try { const cfg = await fetch(`${apiBase}${ROUTES.arb.config}`).then(r => r.json()); setArbConfig(cfg); } catch {}
      try {
        const base = await (await fetch(`${apiBase}${ROUTES.legacy.strategy}`)).json();
        const baseList = base?.strategies || [];
        setStrategies(baseList);
      } catch {}
    })();
  }, [isAuthenticated]);
  const value = useMemo<ArbContextValue>(() => ({ arbConfig, setArbConfig, strategies, setStrategies }), [arbConfig, strategies]);
  return <ArbContext.Provider value={value}>{children}</ArbContext.Provider>;
};

export const useArb = (): ArbContextValue => {
  const ctx = useContext(ArbContext);
  if (!ctx) throw new Error('useArb must be used within ArbProvider');
  return ctx;
};


