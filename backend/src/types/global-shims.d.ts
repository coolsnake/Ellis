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

// Ambient module shims to satisfy type resolution in constrained environments
declare module 'socket.io' {
  export class Server {
    emit: (...args: any[]) => any;
  }
}

declare module 'undici' {
  export const fetch: any;
}

declare module 'vitest' {
  export const describe: any;
  export const it: any;
  export const expect: any;
}


// Optional SDK shims for environments without these deps installed
declare module '@solana/web3.js' { const anyExport: any; export = anyExport; }
declare module '@raydium-io/raydium-sdk-v2' { const anyExport: any; export = anyExport; }
declare module '@orca-so/whirlpools-sdk' { const anyExport: any; export = anyExport; }
declare module '@orca-so/whirlpools' { const anyExport: any; export = anyExport; }


