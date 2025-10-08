import React, { createContext, useContext, useMemo, useState } from 'react';

type DriftContextValue = {
  status: any;
  setStatus: React.Dispatch<React.SetStateAction<any>>;
  subaccounts: any[];
  setSubaccounts: React.Dispatch<React.SetStateAction<any[]>>;
  selectedSubId: number;
  setSelectedSubId: React.Dispatch<React.SetStateAction<number>>;
  subBalances: any[];
  setSubBalances: React.Dispatch<React.SetStateAction<any[]>>;
  spotMarkets: any[];
  setSpotMarkets: React.Dispatch<React.SetStateAction<any[]>>;
  action: 'deposit' | 'withdraw';
  setAction: React.Dispatch<React.SetStateAction<'deposit' | 'withdraw'>>;
  amount: number;
  setAmount: React.Dispatch<React.SetStateAction<number>>;
  spotIndex: number;
  setSpotIndex: React.Dispatch<React.SetStateAction<number>>;
};

const DriftContext = createContext<DriftContextValue | undefined>(undefined);

export const DriftProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [status, setStatus] = useState<any>(null);
  const [subaccounts, setSubaccounts] = useState<any[]>([]);
  const [selectedSubId, setSelectedSubId] = useState<number>(0);
  const [subBalances, setSubBalances] = useState<any[]>([]);
  const [spotMarkets, setSpotMarkets] = useState<any[]>([]);
  const [action, setAction] = useState<'deposit' | 'withdraw'>('deposit');
  const [amount, setAmount] = useState<number>(0);
  const [spotIndex, setSpotIndex] = useState<number>(0);
  const value = useMemo<DriftContextValue>(() => ({
    status, setStatus,
    subaccounts, setSubaccounts,
    selectedSubId, setSelectedSubId,
    subBalances, setSubBalances,
    spotMarkets, setSpotMarkets,
    action, setAction,
    amount, setAmount,
    spotIndex, setSpotIndex,
  }), [status, subaccounts, selectedSubId, subBalances, spotMarkets, action, amount, spotIndex]);
  return <DriftContext.Provider value={value}>{children}</DriftContext.Provider>;
};

export const useDrift = (): DriftContextValue => {
  const ctx = useContext(DriftContext);
  if (!ctx) throw new Error('useDrift must be used within DriftProvider');
  return ctx;
};


