/* Ambient shims to satisfy TS in Node runtime with undici */
/* eslint-disable @typescript-eslint/no-explicit-any */

declare const fetch: any;
declare const URL: any;
declare const URLSearchParams: any;
declare const setTimeout: any;
declare const clearInterval: any;
declare const setInterval: any;
declare const Buffer: any;

declare namespace NodeJS {
  // Minimal Timer type to allow NodeJS.Timer references
  type Timeout = any;
  type Timer = any;
}

declare module '@solana/web3.js';
declare module '@orca-so/whirlpools';
declare module '@orca-so/whirlpools-sdk';


