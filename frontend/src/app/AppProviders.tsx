import React from 'react';
import { AuthProvider, SocketProvider, SystemProvider, DriftProvider, LogsProvider, ArbProvider, WalletProvider } from './contexts';

export const AppProviders: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  return (
    <AuthProvider>
      <SocketProvider>
        <SystemProvider>
          <DriftProvider>
            <LogsProvider>
              <ArbProvider>
                <WalletProvider>
                  {children}
                </WalletProvider>
              </ArbProvider>
            </LogsProvider>
          </DriftProvider>
        </SystemProvider>
      </SocketProvider>
    </AuthProvider>
  );
};


