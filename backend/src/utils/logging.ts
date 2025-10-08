// Centralized logging constants for categories, subcategories, and codes
// Importers should use these to ensure uniform logging across execution pathways.

export const LogCat = {
  api: 'api',
  pools: 'pools',
  raydium: 'raydium',
  orca: 'orca',
  meteora: 'meteora',
  graph: 'graph',
  drift: 'drift',
  tx: 'tx',
  arb: 'arb',
  pretrade: 'pretrade',
  trade: 'trade',
  server: 'server',
  wallet: 'wallet',
  system: 'system',
  auth: 'auth',
  rust: 'rust',
} as const;

export const LogSubcat = {
  http: 'http',
  ws: 'ws',
  calib: 'calib',
  consistency: 'consistency',
  build: 'build',
  resolve: 'resolve',
} as const;

export const LogCode = {
  // API lifecycle
  API_REQUEST: 'API.REQUEST',
  API_RESPONSE: 'API.RESPONSE',

  // Pools HTTP lifecycle
  POOLS_HTTP_REQUEST: 'POOLS.HTTP.REQUEST',
  POOLS_HTTP_RESPONSE: 'POOLS.HTTP.RESPONSE',
  POOLS_HTTP_429: 'POOLS.HTTP.429',
  POOLS_HTTP_NON_OK: 'POOLS.HTTP.NON_OK',
  POOLS_WS_UNHEALTHY: 'POOLS.WS.UNHEALTHY',

  // Graph milestones
  GRAPH_REBUILD_SCHEDULED: 'GRAPH.REBUILD.SCHEDULED',
  GRAPH_REBUILD_BATCH: 'GRAPH.REBUILD.BATCH',
  GRAPH_PUSH_SNAPSHOT: 'GRAPH.PUSH.SNAPSHOT',
  GRAPH_PUSH_DIFF: 'GRAPH.PUSH.DIFF',
  GRAPH_TVL_STATS: 'GRAPH.TVL.STATS',

  // Drift lifecycle
  DRIFT_WS_OPEN: 'DRIFT.WS.OPEN',
  DRIFT_WS_CLOSE: 'DRIFT.WS.CLOSE',
  DRIFT_WS_ERROR: 'DRIFT.WS.ERROR',
  DRIFT_LIQ_START: 'DRIFT.LIQ.START',
  DRIFT_LIQ_STOP: 'DRIFT.LIQ.STOP',
  DRIFT_LIQ_TICK_ERROR: 'DRIFT.LIQ.TICK_ERROR',
  DRIFT_GRID_START: 'DRIFT.GRID.START',
  DRIFT_GRID_STOP: 'DRIFT.GRID.STOP',
  DRIFT_GRID_TICK_ERROR: 'DRIFT.GRID.TICK_ERROR',

  // TX lifecycle
  TX_RESOLVE_START: 'TX.RESOLVE.START',
  TX_RESOLVE_OK: 'TX.RESOLVE.OK',
  TX_BUILD_HOP: 'TX.BUILD.HOP',
  TX_BUILD_OK: 'TX.BUILD.OK',
  TX_BUILD_ERR: 'TX.BUILD.HOP.ERR',
} as const;

export type LogCodeValues = typeof LogCode[keyof typeof LogCode];


