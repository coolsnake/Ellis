import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { useAuth } from './auth';
import { apiBase } from '../../utils/apiBase';
import { ROUTES } from '../../utils/routes';

type SystemContextValue = {
  system: any;
  setSystem: React.Dispatch<React.SetStateAction<any>>;
};

const SystemContext = createContext<SystemContextValue | undefined>(undefined);

export const SystemProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [system, setSystem] = useState<any>({});
  const { isAuthenticated } = useAuth();

  useEffect(() => {
    if (!isAuthenticated) return;
    (async () => {
      try {
        const sys = await fetch(`${apiBase}${ROUTES.system.base}`).then(r => r.json());
        setSystem(sys);
      } catch {}
    })();
  }, [isAuthenticated]);
  const value = useMemo<SystemContextValue>(() => ({ system, setSystem }), [system]);
  return <SystemContext.Provider value={value}>{children}</SystemContext.Provider>;
};

export const useSystem = (): SystemContextValue => {
  const ctx = useContext(SystemContext);
  if (!ctx) throw new Error('useSystem must be used within SystemProvider');
  return ctx;
};


