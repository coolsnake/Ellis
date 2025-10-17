import dotenv from 'dotenv';
dotenv.config();

import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = resolve(__dirname, '..', '..');
const CACHE_DIR = process.env.CACHE_DIR || resolve(BACKEND_ROOT, 'cache');
// Allow overriding default directories for Linux deployments
const CONFIG_DIR = process.env.CONFIG_DIR || resolve(BACKEND_ROOT, 'config');
const WALLET_DIR = process.env.WALLET_DIR || resolve(BACKEND_ROOT, 'wallet');
const LOG_DIR = process.env.LOG_DIR || resolve(BACKEND_ROOT, 'logs');

// Consolidated session log envs
const ARB_SESSION_JSON_PATH = process.env.ARB_SESSION_JSON_PATH;
const ARB_LOG_DIR = process.env.ARB_LOG_DIR;
const CONSOLIDATED_LOG_MAX = Number(process.env.CONSOLIDATED_LOG_MAX || 2000);
const CONSOLIDATED_LOG_PATH = process.env.CONSOLIDATED_LOG_PATH || resolve(LOG_DIR, 'consolidated-session.json');

export const CONFIG = {
  port: Number(process.env.PORT || 3001),
  rpcUrl: process.env.SOLANA_RPC_URL || 'https://mainnet.helius-rpc.com/?api-key=4673beb7-dcca-4942-91ac-c69babdf1f02',
  websocketIntervalMs: Number(process.env.WEBSOCKET_INTERVAL_MS || 400),
  walletPath: process.env.WALLET_PATH || resolve(WALLET_DIR, 'keypair.json'),
  strategyConfigPath: process.env.STRATEGY_CONFIG_PATH || resolve(CONFIG_DIR, 'strategy.json'),
  // Expose centralized config file paths for Linux deployments
  watchlistPath: process.env.WATCHLIST_PATH || resolve(CONFIG_DIR, 'watchlist.json'),
  tokensPath: process.env.TOKENS_PATH || resolve(CONFIG_DIR, 'tokens.json'),
  jupTokensPath: (process.env.JUP_TOKENS_PATH as any) || resolve(CONFIG_DIR, 'jupTokens.json'),
  strategyListPath: (process.env.STRATEGIES_PATH as any) || resolve(CONFIG_DIR, 'strategies.json'),
  walletTokensPath: (process.env.WALLET_TOKENS_PATH as any) || resolve(CONFIG_DIR, 'walletTokens.json'),
  walletHistoryPath: (process.env.WALLET_HISTORY_PATH as any) || resolve(CONFIG_DIR, 'walletHistory.json'),
  appInfoPath: (process.env.APP_INFO_PATH as any) || resolve(CONFIG_DIR, 'appInfo.json'),
  // Centralized wallet token accounts path (for Linux deployments)
  tokenAccountsPath: (process.env.TOKEN_ACCOUNTS_PATH as any) || resolve(CONFIG_DIR, 'tokenAccounts.json'),
  logDir: LOG_DIR,
  cacheDir: CACHE_DIR,
  // Consolidated session log configuration
  consolidated: {
    max: CONSOLIDATED_LOG_MAX,
    path: CONSOLIDATED_LOG_PATH,
    arbSessionPath: ARB_SESSION_JSON_PATH,
    arbLogDir: ARB_LOG_DIR,
  },
  socketIoPath: process.env.SOCKETIO_PATH || '/socket.io',
  // Orca configuration
  orca: {
    mode: (process.env.ORCA_MODE as any) || 'http', // 'http' | 'v4' | 'legacy'
    apiUrl: process.env.ORCA_API_URL || 'https://api.orca.so/v2/solana/pools',
    pageSize: Number(process.env.ORCA_HTTP_PAGE_SIZE || 50),
    maxPages: Number(process.env.ORCA_HTTP_MAX_PAGES || 10),
    // Mainnet-beta defaults from Orca docs
    programId: process.env.ORCA_WHIRLPOOLS_PROGRAM_ID || 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
    configPubkey: process.env.ORCA_WHIRLPOOLS_CONFIG || '2LecshUwdy9xi7meFgHtFJQNSKk4KdTrcpvaB56dP2NQ',
    configExtensionPubkey: process.env.ORCA_WHIRLPOOLS_CONFIG_EXT || '777H5H3Tp9U11uRVRzFwM8BinfiakbaLT8vQpeuhvEiH',
    // Optional: devnet overrides (left undefined by default)
    devnet: {
      programId: process.env.ORCA_WHIRLPOOLS_PROGRAM_ID_DEVNET,
      configPubkey: process.env.ORCA_WHIRLPOOLS_CONFIG_DEVNET,
      configExtensionPubkey: process.env.ORCA_WHIRLPOOLS_CONFIG_EXT_DEVNET,
    },
    cacheTtlMs: Number(process.env.ORCA_CACHE_TTL_MS || 60_000),
    maxHttpRetries: Number(process.env.ORCA_HTTP_MAX_RETRIES || 2),
    httpBackoffMs: Number(process.env.ORCA_HTTP_BACKOFF_MS || 500),
    // HTTP API filters and pagination (cursor-based)
    size: Number(process.env.ORCA_HTTP_SIZE || 50),
    sortBy: process.env.ORCA_HTTP_SORT_BY || 'tvl',
    sortDirection: process.env.ORCA_HTTP_SORT_DIR || 'desc',
    hasRewards: process.env.ORCA_HTTP_HAS_REWARDS === 'true' ? true : (process.env.ORCA_HTTP_HAS_REWARDS === 'false' ? false : undefined),
    hasWarning: process.env.ORCA_HTTP_HAS_WARNING === 'true' ? true : (process.env.ORCA_HTTP_HAS_WARNING === 'false' ? false : undefined),
    hasAdaptiveFee: process.env.ORCA_HTTP_HAS_ADAPTIVE_FEE ? (process.env.ORCA_HTTP_HAS_ADAPTIVE_FEE === 'true') : undefined,
    isWavebreak: process.env.ORCA_HTTP_IS_WAVEBREAK ? (process.env.ORCA_HTTP_IS_WAVEBREAK === 'true') : undefined,
    minTvl: process.env.ORCA_HTTP_MIN_TVL ? Number(process.env.ORCA_HTTP_MIN_TVL) : undefined,
    minVolume: process.env.ORCA_HTTP_MIN_VOLUME ? Number(process.env.ORCA_HTTP_MIN_VOLUME) : undefined,
    minLockedLiquidityPercent: process.env.ORCA_HTTP_MIN_LOCKED_LIQUIDITY ? Number(process.env.ORCA_HTTP_MIN_LOCKED_LIQUIDITY) : undefined,
    token: process.env.ORCA_HTTP_TOKEN || undefined,
    tokensBothOf: process.env.ORCA_HTTP_TOKENS_BOTH_OF || undefined,
    addresses: process.env.ORCA_HTTP_ADDRESSES || undefined,
    includeBlocked: process.env.ORCA_HTTP_INCLUDE_BLOCKED ? (process.env.ORCA_HTTP_INCLUDE_BLOCKED === 'true') : true,
    stats: (process.env.ORCA_HTTP_STATS || '5m,1h,24h').split(',').map(s => s.trim()).filter(Boolean),
    // TVL filtering (raw liquidity proxies)
    // Minimum AMM base liquidity (proxy for TVL) required to include a pool
    minAmmLiqBase: Number(process.env.ORCA_MIN_AMM_LIQ_BASE || 0),
    // Minimum CLMM liquidity required to include a pool (prefer USD TVL when available)
    minClmmLiquidity: Number(process.env.ORCA_MIN_CLMM_LIQUIDITY || 0),
  },
  
  // System configuration
  system: {
    // Unified pools refresh cadence (drives both Raydium and Orca timers)
    poolsRefreshMs: Number(process.env.POOLS_REFRESH_MS || 60_000),
    jupiterApiUrl: process.env.JUPITER_API_URL || 'https://quote-api.jup.ag/v6',
    targetTickTimeMs: Number(process.env.TARGET_TICK_TIME_MS || 2000),
    graphStartDelayMs: Number(process.env.GRAPH_START_DELAY_MS || 5000),
    // Graph push cadence; when 0, rely entirely on event-driven rebuilds
    graphStreamIntervalMs: Number(process.env.GRAPH_STREAM_INTERVAL_MS || 1000),
    // Enable detect-driven graph push cadence (default: false)
    detectDrivenGraphPush: (process.env.DETECT_DRIVEN_GRAPH_PUSH || 'true') === 'true',
    // Debounce and delta threshold for event-driven graph rebuilds
    graphRebuildDebounceMs: Number(process.env.GRAPH_REBUILD_DEBOUNCE_MS || 25),
    graphRebuildMinDebounceMs: Number(process.env.GRAPH_REBUILD_MIN_DEBOUNCE_MS || 10),
    graphDeltaRebuildThreshold: Number(process.env.GRAPH_DELTA_REBUILD_THRESHOLD || 0),
    graphRebaseDiffThreshold: Number(process.env.GRAPH_REBASE_DIFF_THRESHOLD || 2000),
    graphRebaseTimeMs: Number(process.env.GRAPH_REBASE_TIME_MS || (5 * 60 * 1000)),
    graphSnapshotTtlMs: Number(process.env.GRAPH_SNAPSHOT_TTL_MS || 1500),
    // Enable incremental graph updates (diff-first); fallback to rebuild when disabled
    graphIncrementalMode: (process.env.GRAPH_INCREMENTAL_MODE || 'true') !== 'false',
    // Graph diff filter knobs
    graphDiffFilterEnable: (process.env.GRAPH_DIFF_FILTER_ENABLE || 'true') !== 'false',
    graphDiffPriceEps: Number(process.env.GRAPH_DIFF_PRICE_EPS || 0.002),
    graphDiffLiqEps: Number(process.env.GRAPH_DIFF_LIQ_EPS || 0.01),
    graphDiffWeightEps: Number(process.env.GRAPH_DIFF_WEIGHT_EPS || 0.01),
    maxRetries: Number(process.env.MAX_RETRIES || 3),
    retryDelayMs: Number(process.env.RETRY_DELAY_MS || 1000),
    connectionTimeoutMs: Number(process.env.CONNECTION_TIMEOUT_MS || 30000),
    enableLogging: process.env.ENABLE_LOGGING !== 'false',
    logLevel: process.env.LOG_LEVEL || 'info',
    txCommitment: (process.env.TX_COMMITMENT as any) || 'confirmed',
    wrapAndUnwrapSol: process.env.WRAP_AND_UNWRAP_SOL !== 'false',
    scopePools: (process.env.SCOPE_POOLS || 'false') === 'true',
    // New: scoping mode for /arb/pools endpoints: 'none' | 'watchlist' | 'jupiter' | 'intersection' | 'union'
    scopePoolsMode: (process.env.SCOPE_POOLS_MODE as any) || 'none',
    // New: token-universe mode used to filter pools at source: 'jupiter' | 'watchlist' | 'intersection' | 'union'
    tokenUniverseMode: (process.env.TOKEN_UNIVERSE_MODE as any) || 'union',
    // Control whether anchors are injected into the universe set (default: true)
    includeAnchorsInUniverse: (process.env.INCLUDE_ANCHORS_IN_UNIVERSE || 'true') !== 'false',
    // Route-level scoping (disable to avoid double-scoping if sources already scoped)
    routeLevelScoping: (process.env.ROUTE_LEVEL_SCOPING || 'false') === 'true',
    // Whether to allow anchor-bridging when scoping (include pools if either side is an anchor mint)
    enableAnchorBridging: (process.env.ENABLE_ANCHOR_BRIDGING || 'true') !== 'false',
    // Optional canonicalization of pair orientation for normalized outputs
    // Modes: 'quoteHierarchy' | 'lex' | 'preferA' | 'preferB' | 'preferLists'
    canonicalizePairs: (process.env.CANONICALIZE_PAIRS as any) || 'quoteHierarchy',
    // Quote hierarchy (highest-ranked mint should be on the B side as quote)
    // Env: SYSTEM_QUOTE_HIERARCHY=Mint1,Mint2,... (defaults to stables: [USDC, USDT])
    quoteHierarchy: (process.env.SYSTEM_QUOTE_HIERARCHY
      ? String(process.env.SYSTEM_QUOTE_HIERARCHY)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [
          'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
          'Es9vMFrzaCERfCkS7fGXx9bK6A7bP4J1yDrJZGB48JpN', // USDT
        ]),
    // System-wide TVL/liquidity thresholds (applied in addition to per-source thresholds)
    // Lower defaults to avoid over-pruning during discovery; tune via env in prod
    minAmmLiqBase: process.env.MIN_AMM_LIQ_BASE ? Number(process.env.MIN_AMM_LIQ_BASE) : 0,
    minClmmLiquidity: process.env.MIN_CLMM_LIQUIDITY ? Number(process.env.MIN_CLMM_LIQUIDITY) : 0,
    // Minimum number of distinct DEXes a token pair must appear on to include (1..3)
    minDexOverlap: Number(process.env.MIN_DEX_OVERLAP || 1),
    // Stable pruning controls
    // Comma-separated list of stablecoin mints; defaults to USDC, USDT, USD1
    stableMints: (process.env.STABLE_MINTS || 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v,Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB,USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean),
    // If true, drop stable<->stable edges at graph build time
    dropStableStableEdges: (process.env.DROP_STABLE_STABLE_EDGES || 'false') === 'true',
    // Optional: anchors always included in universe and bridging exceptions
    anchorMints: (process.env.ANCHOR_MINTS || 'So11111111111111111111111111111111111111112,EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v,cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean),
    // Optional: enable Orca HTTP prefiltering using config-only params (conservative)
    universePrefilterOrca: (process.env.UNIVERSE_PREFILTER_ORCA || 'false') === 'true',
    // Enable websocket subscriptions for pool state changes
    enablePoolWs: process.env.ENABLE_POOL_WS !== 'false',
    // WS program-level fallbacks: allow subscribing at program level when no targeted pools (default false)
    wsFallbackPrograms: (process.env.WS_FALLBACK_PROGRAMS || 'false') === 'true',
    // Meteora WS retry tuning
    meteoraWsRetryCount: Number(process.env.METEORA_WS_RETRY_COUNT || 2),
    meteoraWsRetryDelayMs: Number(process.env.METEORA_WS_RETRY_DELAY_MS || 600),
    // Meteora program-level fallback (default false)
    meteoraWsProgramFallback: (process.env.METEORA_WS_PROGRAM_FALLBACK || 'false') === 'true',
    // Limit how many new targeted pool websocket subscriptions we attach per second
    // Default aligns with common RPC free-tier limits; increase when provider allows more
    wsAttachPerSec: Number(process.env.WS_ATTACH_PER_SEC || 10),
    // Minimum gap between forced pool refreshes per source (ms)
    poolRefreshMinGapMs: Number(process.env.POOL_REFRESH_MIN_GAP_MS || 3000),
    // Price feed TTL - how often to fetch fresh prices from Jupiter (default 15s for rate limiting)
    priceFeedTtlMs: Number(process.env.PRICE_FEED_TTL_MS || 15000),
    // Price feed responsiveness - if true, always fetch prices when older than targetTickTimeMs
    priceFeedResponsive: (process.env.PRICE_FEED_RESPONSIVE || 'false') === 'true',
    // Log categories and filtering (legacy)
    logCategories: [
      'api',
      'jupiter',
      'raydium',
      'orca',
      'meteora',
      'arb',
      'tx',
      'opportunity',
      'drift',
      'strategy',
      'pretrade',
      'trade',
      'terminal',
      'graph',
      'pools',
      'price',
      'wallet',
      'server',
      'auth',
      'system',
      'other'
    ],
    // If provided, backend will tag logs outside this set as muted
    enabledLogCategories: undefined as undefined | string[],
    // New structured logging controls (optional). When present, these take precedence.
    log: {
      level: (process.env.LOG_LEVEL as any) || 'info',
      // Per-category minimum levels. Keys can be nested like "pretrade.sim".
      categories: {
        api: 'debug',
        pretrade: 'debug',
        'pretrade.sim': 'debug',
        strategy: 'debug',
        'strategy.grid': 'debug',
        drift: 'debug',
        jupiter: 'debug',
        graph: 'info',
        pools: 'info',
        arb: 'info',
        system: 'debug',
        wallet: 'debug',
        opportunity: 'info',
        tx: 'info',
      } as Record<string, 'error' | 'warn' | 'info' | 'debug'>,
      // Force-include or exclude specific codes (supports * globs)
      enableCodes: [] as string[],
      disableCodes: [] as string[],
      // Sampling probability per code (0..1)
      sample: {} as Record<string, number>,
      // Simple per-code rate limits
      rateLimit: {
        // Reduce noisy UI log traffic under load (optional/env tunable)
        'GRAPH.PUSH_DIFF': { perSec: 2 },
        'GRAPH.PUSH_SNAPSHOT': { perSec: 1 },
        'PRETRADE.SIM.START': { perSec: 1 },
        'PRETRADE.SIM.END': { perSec: 1 },
      } as Record<string, { perSec?: number; minIntervalMs?: number }>,
      // Named presets the UI can apply (optional)
      presets: {
        dev: {
          categories: { api: 'debug', 'pretrade.sim': 'info', strategy: 'info', drift: 'warn', jupiter: 'warn' }
        },
        ops: {
          categories: { api: 'warn', pretrade: 'warn', 'strategy.grid': 'info', graph: 'info', pools: 'info', arb: 'info', opportunity: 'info', tx: 'info', drift: 'info', strategy: 'info',  }
        },
        research: {
          categories: { arb: 'debug', graph: 'debug', pools: 'info', api: 'debug', 'drift.dlob': 'info' }
        }
      } as Record<string, any>,
    },
    // Optional: CORS allowlist (comma-separated origins), '*' to allow all
    corsOrigin: process.env.CORS_ORIGIN,
    // Enforce HTTPS by redirecting non-secure requests (behind reverse proxy)
    requireHttps: process.env.REQUIRE_HTTPS === 'true',
    // Optional: frontend-only default categories; UI may override locally
    frontendEnabledLogCategories: (
      process.env.FRONTEND_ENABLED_LOG_CATEGORIES
        ? String(process.env.FRONTEND_ENABLED_LOG_CATEGORIES)
            .split(',')
            .map((s) => s.trim().toLowerCase())
            .filter(Boolean)
        : ['system','server','opportunity','tx','arb','graph']
    ) as any,
    // DEPRECATED: pool refresh loops are coordinated via /arb/pools/refresh (kept for compatibility)
    autoStartPools: (process.env.AUTO_START_POOLS || 'false') === 'true',
    // Pause watchlist price feed and Jupiter API during deep price bootstrap
    pausePriceFeedDuringBootstrap: (process.env.PAUSE_FEED_DURING_BOOTSTRAP || 'true') !== 'false',
    // Max requests for deep Jupiter price bootstrap
    deepJupiterBootstrapMaxRequests: Number(process.env.DEEP_JUPITER_BOOTSTRAP_MAX_REQUESTS || 6),
    // Token mint blocklist: comma-separated list of mint addresses to exclude from pools
    tokenBlocklistMints: (process.env.TOKEN_BLOCKLIST_MINTS || 'pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn,USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean),
    // Token-2022 routing mode: 'block' | 'allow' | 'auto'
    token2022Mode: (process.env.TOKEN2022_MODE as any) || 'auto',
    // Additional slippage (bps) applied only to Token-2022 hops
    token2022ExtraSlippageBps: Number(process.env.TOKEN2022_EXTRA_SLIPPAGE_BPS || 20),
    // Default USD quote size used when neither size nor sizeUsd is provided
    defaultQuoteSizeUsd: Number(process.env.DEFAULT_QUOTE_SIZE_USD || 0),
    // Token-2022 allowlist per-DEX (default: blocked everywhere)
    token2022Allow: {
      raydium: (process.env.TOKEN2022_ALLOW_RAYDIUM || 'false') === 'true',
      orca: (process.env.TOKEN2022_ALLOW_ORCA || 'false') === 'true',
      meteora: (process.env.TOKEN2022_ALLOW_METEORA || 'false') === 'true',
    },
  },
  // Optional simple Basic Auth for API/WS (prefer Nginx for static site)
  auth: {
    // Mandatory auth: default to dev creds if unspecified (override in production)
    enabled: true,
    user: process.env.AUTH_USER || (process.env.NODE_ENV !== 'production' ? 'admin' : ''),
    pass: process.env.AUTH_PASS || (process.env.NODE_ENV !== 'production' ? 'admin' : ''),
    realm: process.env.AUTH_REALM || 'Lockstone',
  },
  // Sanity checks configuration
  sanity: {
    enabled: (process.env.SANITY_ENABLED || 'true') !== 'false',
    maxPriceDeviation: Number(process.env.SANITY_MAX_PRICE_DEVIATION || 50), // allow up to 50x deviation vs USD ref
    feeMin: Number(process.env.SANITY_FEE_MIN || 0),
    feeMax: Number(process.env.SANITY_FEE_MAX || 10000),
    // Avoid double-applying source-specific sanity at graph level
    avoidDoubleApply: (process.env.SANITY_AVOID_DOUBLE_APPLY || 'true') !== 'false',
    applyAtGraph: (process.env.SANITY_APPLY_AT_GRAPH || 'true') !== 'false',
    // Optional clamps for prices to drop absurd magnitudes
    priceClampMin: Number(process.env.SANITY_PRICE_CLAMP_MIN || 1e-12),
    priceClampMax: Number(process.env.SANITY_PRICE_CLAMP_MAX || 1e12),
    // Per-source sanity application toggles
    sanity_applyRaydiumAmm: (process.env.SANITY_APPLY_RAYDIUM_AMM || 'true') !== 'false',
    sanity_applyOrcaClmm: (process.env.SANITY_APPLY_ORCA_CLMM || 'true') !== 'false',
    writeSamples: process.env.SANITY_WRITE_SAMPLES === 'true',
    sampleRate: Number(process.env.SANITY_SAMPLE_RATE || 0.005),
    // Drop edges when neither side has a USD quote (non-anchor). Default false
    dropEdgesNoUsdBoth: (process.env.SANITY_DROP_EDGES_NO_USD_BOTH || 'false') !== 'false',
  },
  // Raydium configuration (HTTP fetcher only; SDK kept for tx building and WS decode)
  raydium: {
    // Classic AMM v4 program (mainnet)
    ammV4Program: process.env.RAYDIUM_AMM_V4_PROGRAM || '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
    // Optional: AMM v5 program (set via env if needed)
    ammV5Program: process.env.RAYDIUM_AMM_V5_PROGRAM || 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C',
    // Concentrated Liquidity (CLMM) program (mainnet)
    clmmProgram: process.env.RAYDIUM_CLMM_PROGRAM || 'CAMMCzo5nKXjotvLkGQ6r1N1C8QXr8iY6pYwWf3V8mGk',
    // Optional CLMM authority/observation id overrides (sdk will derive when unset)
    clmmAuthority: process.env.RAYDIUM_CLMM_AUTHORITY,
    clmmObservationId: process.env.RAYDIUM_CLMM_OBSERVATION_ID,
    cacheTtlMs: Number(process.env.RAYDIUM_CACHE_TTL_MS || 60_000),
    // HTTP controls
    concurrency: Number(process.env.RAYDIUM_HTTP_CONCURRENCY || process.env.RAYDIUM_SDK_CONCURRENCY || 8),
    sdkConcurrency: Number(process.env.RAYDIUM_SDK_CONCURRENCY || 8),
    pageSize: Number(process.env.RAYDIUM_HTTP_PAGE_SIZE || 50),
    maxPages: Number(process.env.RAYDIUM_HTTP_MAX_PAGES || process.env.RAYDIUM_HTTP_MAX_PAGES_GLOBAL || 10),
    maxHttpRetries: Number(process.env.RAYDIUM_HTTP_MAX_RETRIES || 2),
    httpBackoffMs: Number(process.env.RAYDIUM_HTTP_BACKOFF_MS || 300),
    sdkProbeMintsLimit: Number(process.env.RAYDIUM_SDK_PROBE_MINTS_LIMIT || 200),
    sdkClmmPageSize: Number(process.env.RAYDIUM_SDK_CLMM_PAGE_SIZE || 5000),
    filterToOrcaTokens: process.env.RAYDIUM_FILTER_TO_ORCA_TOKENS === 'true',
    filterUniverse: (process.env.RAYDIUM_FILTER_UNIVERSE as any) || 'jupiter',
    enableApiFetchByMints: process.env.RAYDIUM_ENABLE_FETCH_BY_MINTS === 'true',
    // TVL filtering (raw liquidity proxies)
    minAmmLiqBase: Number(process.env.RAYDIUM_MIN_AMM_LIQ_BASE || 0),
    minClmmLiquidity: Number(process.env.RAYDIUM_MIN_CLMM_LIQUIDITY || 0),
  }, 
  // Meteora configuration (DLMM HTTP-first)
  meteora: {
    mode: (process.env.METEORA_MODE as any) || 'http', // 'http' | 'sdk'
    apiUrl: process.env.METEORA_API_URL || 'https://dlmm-api.meteora.ag/pair/all_with_pagination',
    // Optional DLMM program id for websocket subscriptions
    programId: process.env.METEORA_PROGRAM_ID || 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',
    // Optional: Meteora balanced (DAMM) program ids (mainnet defaults)
    amm: {
      v1ProgramId: process.env.METEORA_AMM_V1_PROGRAM_ID || 'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB',
      v2ProgramId: process.env.METEORA_AMM_V2_PROGRAM_ID || 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG',
    },
    pageSize: Number(process.env.METEORA_HTTP_PAGE_SIZE || 50),
    maxPages: Number(process.env.METEORA_HTTP_MAX_PAGES || 10),
    cacheTtlMs: Number(process.env.METEORA_CACHE_TTL_MS || 60_000),
    maxHttpRetries: Number(process.env.METEORA_HTTP_MAX_RETRIES || 2),
    httpBackoffMs: Number(process.env.METEORA_HTTP_BACKOFF_MS || 500),
    // Canonicalization policy for Meteora only (default: keep incoming orientation)
    canonicalizePairs: (process.env.METEORA_CANONICALIZE_PAIRS as any) || 'lex',
    // TVL filtering (raw liquidity proxies)
    minClmmLiquidity: Number(process.env.METEORA_MIN_CLMM_LIQUIDITY || 0),
    // Optional conservative prefiltering by universe
    universePrefilter: (process.env.METEORA_UNIVERSE_PREFILTER || 'false') === 'true',
  },
  
  // Transaction fee configuration
  fees: {
    baseFee: Number(process.env.BASE_FEE_LAMPORTS || 5000), // 0.000005 SOL default
    priorityFee: Number(process.env.PRIORITY_FEE_LAMPORTS || 1000), // 0.000001 SOL default
    maxFee: Number(process.env.MAX_FEE_LAMPORTS || 100000), // 0.0001 SOL max
    dynamicFees: process.env.DYNAMIC_FEES === 'true',
    feeMultiplier: Number(process.env.FEE_MULTIPLIER || 1.0),
    minFee: Number(process.env.MIN_FEE_LAMPORTS || 1000),
    maxFeeMultiplier: Number(process.env.MAX_FEE_MULTIPLIER || 10.0),
    feeUpdateInterval: Number(process.env.FEE_UPDATE_INTERVAL || 30000),
    networkCongestionThreshold: Number(process.env.NETWORK_CONGESTION_THRESHOLD || 0.8),
    
    // Jupiter-specific settings
    jupiterPriorityFee: Number(process.env.JUPITER_PRIORITY_FEE_LAMPORTS || 1000),
    jupiterMaxAccounts: Number(process.env.JUPITER_MAX_ACCOUNTS || 64),
    jupiterDynamicCompute: process.env.JUPITER_DYNAMIC_COMPUTE !== 'false',
    jupiterLegacyTransaction: process.env.JUPITER_LEGACY_TRANSACTION === 'true',
    jupiterSlippageBps: Number(process.env.JUPITER_SLIPPAGE_BPS || 50),
    jupiterMaxSlippageBps: Number(process.env.JUPITER_MAX_SLIPPAGE_BPS || 500),
  },
  // Drift configuration
  drift: {
    cluster: (process.env.DRIFT_CLUSTER as any) || 'mainnet-beta',
    // Public Drift program IDs per cluster can be derived inside the SDK; allow override via env
    programId: process.env.DRIFT_PROGRAM_ID,
    dlobUrl: process.env.DRIFT_DLOB_URL || 'https://dlob.drift.trade',
    // Optional DLOB websocket for real-time L2 updates
    dlobWsUrl: process.env.DRIFT_DLOB_WS_URL || 'wss://dlob.drift.trade/ws',
    // Gate using websocket-driven prices (fallback to HTTP when disabled or stale)
    enableWsPrices: (process.env.DRIFT_ENABLE_WS_PRICES || 'true') !== 'false',
    // WS-only pricing by default; set DRIFT_WS_ONLY_PRICES=false to enable HTTP fallback
    wsOnlyPrices: (process.env.DRIFT_WS_ONLY_PRICES || 'true') === 'true',
    // Consider WS prices fresh within this window
    priceStaleMs: Number(process.env.DRIFT_PRICE_STALE_MS || 3000),
    // WS connection heartbeat/reconnect tuning
    wsHeartbeatMs: Number(process.env.DRIFT_WS_HEARTBEAT_MS || 15000),
    wsReconnectMinMs: Number(process.env.DRIFT_WS_RECONNECT_MIN_MS || 1000),
    // Optional preselected markets (by market index or symbol) for the UI
    marketsAllowlist: (process.env.DRIFT_MARKETS || (
      '0:SOL-PERP,' +
      '1:BTC-PERP,' +
      '2:ETH-PERP,' +
      '3:APT-PERP,' +
      '4:1MBONK-PERP,' +
      '5:POL-PERP,' +
      '6:ARB-PERP,' +
      '7:DOGE-PERP,' +
      '8:BNB-PERP,' +
      '9:SUI-PERP,' +
      '10:1MPEPE-PERP,' +
      '11:OP-PERP,' +
      '12:RENDER-PERP,' +
      '13:XRP-PERP,' +
      '14:HNT-PERP,' +
      '15:INJ-PERP,' +
      '16:LINK-PERP,' +
      '17:RLB-PERP,' +
      '18:PYTH-PERP,' +
      '19:TIA-PERP,' +
      '20:JTO-PERP,' +
      '21:SEI-PERP,' +
      '22:AVAX-PERP,' +
      '23:WIF-PERP,' +
      '24:JUP-PERP,' +
      '25:DYM-PERP,' +
      '26:TAO-PERP,' +
      '27:W-PERP,' +
      '28:KMNO-PERP,' +
      '29:TNSR-PERP,' +
      '30:DRIFT-PERP,' +
      '31:CLOUD-PERP,' +
      '32:IO-PERP,' +
      '33:ZEX-PERP,' +
      '34:POPCAT-PERP,' +
      '35:1KWEN-PERP,' +
      '36:TRUMP-WIN-2024-BET,' +
      '37:KAMALA-POPULAR-VOTE-2024-BET,' +
      '38:FED-CUT-50-SEPT-2024-BET,' +
      '39:REPUBLICAN-POPULAR-AND-WIN-BET,' +
      '40:BREAKPOINT-IGGYERIC-BET,' +
      '41:DEMOCRATS-WIN-MICHIGAN-BET,' +
      '42:TON-PERP,' +
      '43:LANDO-F1-SGP-WIN-BET,' +
      '44:MOTHER-PERP,' +
      '45:MOODENG-PERP,' +
      '46:WARWICK-FIGHT-WIN-BET,' +
      '47:DBR-PERP,' +
      '48:WLF-5B-1W-BET,' +
      '49:VRSTPN-WIN-F1-24-DRVRS-CHMP,' +
      '50:LNDO-WIN-F1-24-US-GP,' +
      '51:1KMEW-PERP,' +
      '52:MICHI-PERP,' +
      '53:GOAT-PERP,' +
      '54:FWOG-PERP,' +
      '55:PNUT-PERP,' +
      '56:RAY-PERP,' +
      '57:SUPERBOWL-LIX-LIONS-BET,' +
      '58:SUPERBOWL-LIX-CHIEFS-BET,' +
      '59:HYPE-PERP,' +
      '60:LTC-PERP,' +
      '61:ME-PERP,' +
      '62:PENGU-PERP,' +
      '63:AI16Z-PERP,' +
      '64:TRUMP-PERP,' +
      '65:MELANIA-PERP,' +
      '66:BERA-PERP,' +
      '67:NBAFINALS25-OKC-BET,' +
      '68:NBAFINALS25-BOS-BET,' +
      '69:KAITO-PERP,' +
      '70:IP-PERP,' +
      '71:FARTCOIN-PERP,' +
      '72:ADA-PERP,' +
      '73:PAXG-PERP,' +
      '74:LAUNCHCOIN-PERP,' +
      '75:PUMP-PERP,' +
      '76:ASTER-PERP,' +
      '77:XPL-PERP,' +
      '78:2Z-PERP'
    )).split(',').map(s => s.trim()).filter(Boolean),
    defaultSubaccountId: Number(process.env.DRIFT_DEFAULT_SUBACCOUNT_ID || 0),
    // Risk defaults
    maxLeverage: Number(process.env.DRIFT_MAX_LEVERAGE || 3),
    liquidationBufferPct: Number(process.env.DRIFT_LIQ_BUFFER_PCT || 0.25),
    maxFundingApy: Number(process.env.DRIFT_MAX_FUNDING_APY || 50),
    feeMakerBps: Number(process.env.DRIFT_FEE_MAKER_BPS || 0),
    feeTakerBps: Number(process.env.DRIFT_FEE_TAKER_BPS || 5),
    // Liquidator defaults
    liquidator: {
      enabled: (process.env.DRIFT_LIQUIDATOR_ENABLED || 'false') === 'true',
      pollMs: Number(process.env.DRIFT_LIQUIDATOR_POLL_MS || 1500),
      maxConcurrentTargets: Number(process.env.DRIFT_LIQUIDATOR_MAX_CONCURRENT || 2),
      dryRun: (process.env.DRIFT_LIQUIDATOR_DRY_RUN || 'true') === 'true',
      // Execution gate: default 0 => only execute when healthMaint <= 0
      executeHealthThreshold: Number(process.env.DRIFT_LIQ_EXEC_HEALTH_THRESH || 0),
      // Subaccount to perform liquidation actions (falls back to defaultSubaccountId when unset)
      subaccountId: process.env.DRIFT_LIQ_SUBACCOUNT_ID ? Number(process.env.DRIFT_LIQ_SUBACCOUNT_ID) : undefined,
      // Max total USD notional to attempt per target handling (across perp attempts)
      maxAttemptNotional: process.env.DRIFT_LIQ_MAX_ATTEMPT_NOTIONAL ? Number(process.env.DRIFT_LIQ_MAX_ATTEMPT_NOTIONAL) : undefined,
      // New discovery/scan defaults
      probeRps: Number(process.env.DRIFT_LIQ_PROBE_RPS || 100),
      riskHealthThreshold: Number(process.env.DRIFT_LIQ_RISK_HEALTH || 0.1),
      maxProbesPerTick: Number(process.env.DRIFT_LIQ_MAX_PROBES || 100),
      userCacheMax: Number(process.env.DRIFT_LIQ_USER_CACHE_MAX || 500),
      positionMinAbsBase: Number(process.env.DRIFT_LIQ_POSITION_MIN_ABS_BASE || 0),
      positionMaxAbsBase: process.env.DRIFT_LIQ_POSITION_MAX_ABS_BASE ? Number(process.env.DRIFT_LIQ_POSITION_MAX_ABS_BASE) : undefined,
      idleCooldownMs: Number(process.env.DRIFT_LIQ_IDLE_COOLDOWN_MS || 15000),
      outOfScopeCooldownMs: Number(process.env.DRIFT_LIQ_OOS_COOLDOWN_MS || 15000),
      healthyCooldownMs: Number(process.env.DRIFT_LIQ_HEALTHY_COOLDOWN_MS || 5000),
      usePriceTriggers: (process.env.DRIFT_LIQ_USE_PRICE_TRIGGERS || 'true') !== 'false',
      priceTriggerDebounceMs: Number(process.env.DRIFT_LIQ_PRICE_DEBOUNCE_MS || 400),
      httpPollMs: Number(process.env.DRIFT_LIQ_HTTP_POLL_MS || 800),
      maxUsersPerPriceTick: Number(process.env.DRIFT_LIQ_MAX_USERS_PER_PRICE_TICK || 200),
      targetCooldownMs: Number(process.env.DRIFT_LIQ_TARGET_COOLDOWN_MS || 6000),
      statsIntervalMs: Number(process.env.DRIFT_LIQ_STATS_INTERVAL_MS || 10000),
      usersListLimit: Number(process.env.DRIFT_LIQ_USERS_LIST_LIMIT || 300),
      recoveryBuffer: Number(process.env.DRIFT_LIQ_RECOVERY_BUFFER || 0.03),
      indexSpotExposure: (process.env.DRIFT_LIQ_INDEX_SPOT_EXPOSURE || 'false') === 'true',
      // Re-fetch SDK user accounts at most this often for at-risk users (ms)
      refreshAccountsMs: Number(process.env.DRIFT_LIQ_REFRESH_ACCOUNTS_MS || 12000),
      wsOnlyDiscovery: (process.env.DRIFT_LIQ_WS_ONLY_DISCOVERY || 'true') === 'true',
      limitedHttpDiscovery: (process.env.DRIFT_LIQ_LIMITED_HTTP_DISCOVERY || 'false') === 'true',
      discoveryIntervalMs: Number(process.env.DRIFT_LIQ_DISCOVERY_INTERVAL_MS || 60000),
      maxNewUsersPerTick: Number(process.env.DRIFT_LIQ_MAX_NEW_USERS_PER_TICK || 1000),
      scanBatchSize: Number(process.env.DRIFT_LIQ_SCAN_BATCH_SIZE || 1000),
      // Helius GPA bootstrap enumeration (optional)
      enumerateAllOnStart: (process.env.DRIFT_LIQ_ENUMERATE_ON_START || 'true') === 'true',
      enumerateMax: Number(process.env.DRIFT_LIQ_ENUMERATE_MAX || 20000),
      enumerateEnqueueChunk: Number(process.env.DRIFT_LIQ_ENUMERATE_ENQUEUE_CHUNK || 1000),
      enumerateEnqueueDelayMs: Number(process.env.DRIFT_LIQ_ENUMERATE_ENQUEUE_DELAY_MS || 200),
    },
  }, 
  // (Saber removed)
  // Meteora Balanced (mAMM) configuration
  meteoraBalanced: {
    apiUrl: process.env.METEORA_BALANCED_API_URL || 'https://damm-api.meteora.ag/pools',
    apiUrlV2: process.env.METEORA_BALANCED_API_URL_V2 || 'https://dammv2-api.meteora.ag/pools',
    // Optional: hide pools below this TVL threshold (USD) for v1 API
    hideLowTvl: Number(process.env.METEORA_BALANCED_HIDE_LOW_TVL || 0),
    pageSize: Number(process.env.METEORA_BALANCED_HTTP_PAGE_SIZE || 50),
    maxPages: Number(process.env.METEORA_BALANCED_HTTP_MAX_PAGES || 10),
    cacheTtlMs: Number(process.env.METEORA_BALANCED_CACHE_TTL_MS || 300_000),
    maxHttpRetries: Number(process.env.METEORA_BALANCED_HTTP_MAX_RETRIES || 2),
    httpBackoffMs: Number(process.env.METEORA_BALANCED_HTTP_BACKOFF_MS || 500),
  },
};


