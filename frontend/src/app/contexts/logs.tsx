import React, { createContext, useContext, useMemo, useState } from 'react';

type LogEvent = { level: string; message: string; timestamp: string; context?: Record<string, unknown>; cat?: string; subcat?: string; code?: string; cid?: string; span?: 'start' | 'end'; muted?: boolean };

type LogsContextValue = {
  logsByWindow: Record<string, LogEvent[]>;
  setLogsByWindow: React.Dispatch<React.SetStateAction<Record<string, LogEvent[]>>>;
};

const LogsContext = createContext<LogsContextValue | undefined>(undefined);

export const LogsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [logsByWindow, setLogsByWindow] = useState<Record<string, LogEvent[]>>({});
  const value = useMemo<LogsContextValue>(() => ({ logsByWindow, setLogsByWindow }), [logsByWindow]);
  return <LogsContext.Provider value={value}>{children}</LogsContext.Provider>;
};

export const useLogs = (): LogsContextValue => {
  const ctx = useContext(LogsContext);
  if (!ctx) throw new Error('useLogs must be used within LogsProvider');
  return ctx;
};


