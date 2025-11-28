import React, { createContext, useContext, useEffect, useMemo, useState, useCallback } from 'react';
import { useAuth } from './auth';
import { apiBase } from '../../utils/apiBase';

// Types matching backend
export interface ProgramStatus {
  deployed: boolean;
  programId: string | null;
  dataSize: number | null;
  executable: boolean;
  upgradeAuthority: string | null;
  lastDeploySlot: number | null;
  cluster: string;
}

export interface RouterConfig {
  programId: string | null;
  deployedAt: string | null;
  cluster: 'devnet' | 'mainnet-beta' | 'localnet';
  executionMode: 'direct' | 'flash_loan' | 'auto';
  vaultOwner: string | null;
  flashLoanFeeBps: number;
  enabled: boolean;
}

export interface VaultInfo {
  address: string;
  owner: string;
  mint: string;
  tokenAccount: string;
  balance: string;
  borrowedAmount: string;
  availableBalance: string;
  flashLoanActive: boolean;
  bump: number;
  tokenSymbol?: string;
  decimals?: number;
}

export interface CliStatus {
  solana: boolean;
  anchor: boolean;
  cluster: string;
}

type RouterContextValue = {
  // State
  status: ProgramStatus | null;
  config: RouterConfig | null;
  vaults: VaultInfo[];
  cli: CliStatus | null;
  ready: boolean;
  flashLoanAvailable: boolean;
  loading: boolean;
  error: string | null;
  
  // Actions
  refreshStatus: () => Promise<void>;
  refreshVaults: () => Promise<void>;
  setExecutionMode: (mode: 'direct' | 'flash_loan' | 'auto') => Promise<void>;
  setEnabled: (enabled: boolean) => Promise<void>;
};

const RouterContext = createContext<RouterContextValue | undefined>(undefined);

export const RouterProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [status, setStatus] = useState<ProgramStatus | null>(null);
  const [config, setConfig] = useState<RouterConfig | null>(null);
  const [vaults, setVaults] = useState<VaultInfo[]>([]);
  const [cli, setCli] = useState<CliStatus | null>(null);
  const [ready, setReady] = useState(false);
  const [flashLoanAvailable, setFlashLoanAvailable] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  const { isAuthenticated } = useAuth();

  const refreshStatus = useCallback(async () => {
    if (!isAuthenticated) return;
    setLoading(true);
    setError(null);
    
    try {
      const res = await fetch(`${apiBase}/router/status`);
      if (!res.ok) throw new Error('Failed to fetch router status');
      
      const data = await res.json();
      if (data.success) {
        setStatus(data.status);
        setConfig(data.config);
        setCli(data.cli);
        setReady(data.ready);
        setFlashLoanAvailable(data.flashLoanAvailable);
      } else {
        setError(data.error || 'Unknown error');
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [isAuthenticated]);

  const refreshVaults = useCallback(async () => {
    if (!isAuthenticated) return;
    
    try {
      const res = await fetch(`${apiBase}/router/vaults`);
      if (!res.ok) throw new Error('Failed to fetch vaults');
      
      const data = await res.json();
      if (data.success) {
        setVaults(data.vaults || []);
      }
    } catch (err: any) {
      console.error('Failed to refresh vaults:', err);
    }
  }, [isAuthenticated]);

  const setExecutionMode = useCallback(async (mode: 'direct' | 'flash_loan' | 'auto') => {
    try {
      const res = await fetch(`${apiBase}/router/config/mode`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      });
      
      if (!res.ok) throw new Error('Failed to update mode');
      
      const data = await res.json();
      if (data.success && data.config) {
        setConfig(data.config);
      }
    } catch (err: any) {
      setError(err.message);
    }
  }, []);

  const setEnabled = useCallback(async (enabled: boolean) => {
    try {
      const res = await fetch(`${apiBase}/router/config/enabled`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      
      if (!res.ok) throw new Error('Failed to update enabled state');
      
      const data = await res.json();
      if (data.success && data.config) {
        setConfig(data.config);
      }
    } catch (err: any) {
      setError(err.message);
    }
  }, []);

  // Initial fetch on mount
  useEffect(() => {
    if (isAuthenticated) {
      refreshStatus();
      refreshVaults();
    }
  }, [isAuthenticated, refreshStatus, refreshVaults]);

  const value = useMemo<RouterContextValue>(() => ({
    status,
    config,
    vaults,
    cli,
    ready,
    flashLoanAvailable,
    loading,
    error,
    refreshStatus,
    refreshVaults,
    setExecutionMode,
    setEnabled,
  }), [
    status,
    config,
    vaults,
    cli,
    ready,
    flashLoanAvailable,
    loading,
    error,
    refreshStatus,
    refreshVaults,
    setExecutionMode,
    setEnabled,
  ]);

  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>;
};

export const useRouter = (): RouterContextValue => {
  const ctx = useContext(RouterContext);
  if (!ctx) throw new Error('useRouter must be used within RouterProvider');
  return ctx;
};


