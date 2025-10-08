import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';

type Credentials = { user: string; pass: string; expiresAt?: number } | null;

type AuthContextValue = {
  credentials: Credentials;
  isAuthenticated: boolean;
  login: (user: string, pass: string, ttlMs?: number) => void;
  logout: () => void;
};

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [credentials, setCredentials] = useState<Credentials>(() => {
    try {
      const s = localStorage.getItem('authCreds');
      const obj = s ? JSON.parse(s) : null;
      const exp = Number(obj?.expiresAt ?? NaN);
      if (!obj || !Number.isFinite(exp) || exp <= Date.now()) {
        try { localStorage.removeItem('authCreds'); } catch {}
        return null;
      }
      return obj;
    } catch {
      return null;
    }
  });

  const login = useCallback((user: string, pass: string, ttlMs = 24 * 60 * 60 * 1000) => {
    const expiresAt = Date.now() + ttlMs;
    const obj = { user, pass, expiresAt };
    setCredentials(obj);
    try { localStorage.setItem('authCreds', JSON.stringify(obj)); } catch {}
  }, []);

  const logout = useCallback(() => {
    setCredentials(null);
    try { localStorage.removeItem('authCreds'); } catch {}
  }, []);

  const value = useMemo<AuthContextValue>(() => ({
    credentials,
    isAuthenticated: !!credentials,
    login,
    logout,
  }), [credentials, login, logout]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export const useAuth = (): AuthContextValue => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
};


