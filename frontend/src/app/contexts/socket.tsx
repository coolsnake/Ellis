import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import { useAuth } from './auth';

type SocketContextValue = {
  socket: Socket | null;
  isConnected: boolean;
};

const SocketContext = createContext<SocketContextValue | undefined>(undefined);

export const SocketProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { credentials } = useAuth();
  const [isConnected, setIsConnected] = useState(false);
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    // Lazy-init only when creds exist; do not alter existing backend endpoints
    if (!credentials) {
      if (socketRef.current) {
        try { socketRef.current.disconnect(); } catch {}
        socketRef.current = null;
      }
      setIsConnected(false);
      return;
    }

    const enabled = (((import.meta as any)?.env?.VITE_USE_CONTEXT_SOCKET) ?? 'true') === 'true';
    if (!enabled) {
      if (socketRef.current) {
        try { socketRef.current.disconnect(); } catch {}
        socketRef.current = null;
      }
      setIsConnected(false);
      return;
    }

    const wsUrl = (import.meta as any)?.env?.VITE_WS_URL ?? (typeof window !== 'undefined' ? `${window.location.origin}` : '/');
    const s = io(wsUrl, {
      path: '/socket.io',
      transports: ['websocket', 'polling'],
      auth: { user: credentials.user, pass: credentials.pass },
    });
    socketRef.current = s;

    const onConnect = () => setIsConnected(true);
    const onDisconnect = () => setIsConnected(false);
    s.on('connect', onConnect);
    s.on('disconnect', onDisconnect);

    return () => {
      s.off('connect', onConnect);
      s.off('disconnect', onDisconnect);
      try { s.disconnect(); } catch {}
      socketRef.current = null;
      setIsConnected(false);
    };
  }, [credentials]);

  const value = useMemo<SocketContextValue>(() => ({
    socket: socketRef.current,
    isConnected,
  }), [isConnected]);

  return <SocketContext.Provider value={value}>{children}</SocketContext.Provider>;
};

export const useSocket = (): SocketContextValue => {
  const ctx = useContext(SocketContext);
  if (!ctx) throw new Error('useSocket must be used within SocketProvider');
  return ctx;
};


