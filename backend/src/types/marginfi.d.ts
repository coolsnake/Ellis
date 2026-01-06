// Type declarations for @mrgnlabs/marginfi-client-v2
// This module is optional and may not be installed
// Using permissive types since the exact SDK API may vary

declare module '@mrgnlabs/marginfi-client-v2' {
  import { Connection, PublicKey, Keypair, Transaction, VersionedTransaction } from '@solana/web3.js';
  import { Wallet as AnchorWallet } from '@coral-xyz/anchor';

  export interface MarginfiConfig {
    environment: string;
    cluster: string;
    groupPk: PublicKey;
    programId: PublicKey;
    [key: string]: any;
  }

  export function getConfig(environment?: string): MarginfiConfig;

  export interface Bank {
    address: PublicKey;
    mint: PublicKey;
    tokenName?: string;
    liquidityVault: PublicKey;
    [key: string]: any;
  }

  export interface MarginfiGroup {
    address: PublicKey;
    getBanks(): Map<string, Bank>;
    getBankByMint(mint: PublicKey): Bank | null;
    getBankByTokenSymbol(symbol: string): Bank | null;
    [key: string]: any;
  }

  export interface MarginfiAccountWrapper {
    address: PublicKey;
    authority: PublicKey;
    makeFlashLoanBeginTx(amount: number, bank: Bank, opts?: any): Promise<VersionedTransaction>;
    makeFlashLoanEndTx(bank: Bank, opts?: any): Promise<VersionedTransaction>;
    makeBorrowIx(amount: number, bank: Bank | PublicKey, opts?: any): Promise<any>;
    makeRepayIx(amount: number, bank: Bank | PublicKey, opts?: any): Promise<any>;
    buildFlashLoanTx(params: any, opts?: any): Promise<any>;
    [key: string]: any;
  }

  export class MarginfiClient {
    static fetch(
      config: MarginfiConfig,
      wallet: AnchorWallet,
      connection: Connection,
      opts?: { readOnly?: boolean }
    ): Promise<MarginfiClient>;

    readonly group: MarginfiGroup;
    readonly banks: Map<string, Bank>;
    readonly config: MarginfiConfig;

    getMarginfiAccountsForAuthority(authority?: PublicKey): Promise<MarginfiAccountWrapper[]>;
    createMarginfiAccount(opts?: { dryRun?: boolean }): Promise<MarginfiAccountWrapper>;
    getBankByTokenSymbol(symbol: string): Bank | null;
    processTransaction(tx: any, opts?: any): Promise<any>;
    [key: string]: any;
  }
}
