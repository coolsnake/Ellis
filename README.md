
## Overview
**Lockstone** is an advanced Solana trading bot (Node/TypeScript backend + React frontend) designed for sophisticated token pair trading (e.g., SOL/USDC, SOL/dSOL). It leverages Jupiter Aggregator API for optimal routing, implements persistent token account management, and supports multiple trading strategies with real-time monitoring and configuration.

### Key Features

#### 🎯 **Trading Strategies**
- **Threshold Trading**: Mean-reversion strategy with optional scaling (pyramiding)
- **Grid Trading**: Multi-level buy/sell grid strategies with automatic execution
  - **Arithmetic Grids**: Fixed price interval spacing
  - **Geometric Grids**: Fixed percentage interval spacing  
  - **Fibonacci Grids**: Natural spacing using Fibonacci ratios
- **Sliding Center Price**: Adaptive grid center that follows market movements
- **LST NAV-aware Trading**: Premium/discount trading with hysteresis and cooldown

#### 🔧 **Advanced Management**
- **Persistent Token Accounts**: Smart caching prevents unnecessary account creation/deletion
- **Configurable Transaction Fees**: Jupiter fee optimization with user controls
- **Multiple Grid Monitors**: Simultaneous monitoring of multiple grid strategies
- **Enhanced Position Tracking**: Buy/sell pairing with automatic position closure
- **System Configuration**: RPC endpoints, Jupiter API settings, tick time controls

#### 📊 **Real-time Monitoring**
- **Live Price Feeds**: Jupiter API integration with adaptive rate limiting
- **WebSocket Updates**: Real-time strategy and position updates
- **Enhanced UI**: Collapsible strategy cards, detailed position information
- **Wallet Integration**: SOLscan transaction links, comprehensive history
- **System Logging**: Advanced error tracking and performance monitoring

#### 🛡️ **Safety & Performance**
- **In-flight Transaction Protection**: Prevents duplicate transactions
- **Pre-trade Validation**: Balance and fee checks before execution
- **Rate Limiting**: Adaptive throttling with priority lanes
- **Error Recovery**: Comprehensive error handling and logging

## Installation & Requirements

### Prerequisites
- Node.js 20 LTS and npm 9+
- A Solana RPC endpoint (HTTPS). Default is `https://api.mainnet-beta.solana.com` (set `SOLANA_RPC_URL` to override)
- Internet access to Jupiter Lite API

Installers:
- Node.js (LTS) installer: [Download Node.js](https://nodejs.org/en/download/)
- npm is bundled with Node.js. See [npm install guide](https://docs.npmjs.com/downloading-and-installing-node-js-and-npm)

### Clone & Install
```
git clone <your-repo-url>
cd test2
npm install
```

This installs root dependencies and workspaces (frontend and backend).

### Known-good dependency pins (backend)
- @solana/web3.js: 1.98.0
- rpc-websockets: 9.1.3 (enforced via overrides)

If you see websocket/CommonClient or exports errors, do a clean install:
```
rm -rf backend/node_modules backend/package-lock.json
npm -C backend ci --no-audit --no-fund
```

### Environment Variables (optional)
- Backend:
  - `PORT`: default 3001
  - `SOLANA_RPC_URL`: RPC endpoint
  - `WALLET_PATH`: path for keypair JSON (default `backend/wallet/keypair.json`)
  - `STRATEGY_CONFIG_PATH`, `WATCHLIST_PATH`, `TOKENS_PATH`: override config locations
  - `API_MIN_GAP_MS_BASE`, `API_MIN_GAP_MS_MIN`, `API_MIN_GAP_MS_MAX`: rate limiter pacing
  - `MIN_SOL_FOR_FEES`: minimum SOL reserve for fees (default ~0.02)
  - `ARB_SHARED_SECRET`: shared token for backend→arb-rs graph pushes (Authorization: Bearer <secret>)
  - `ARB_WAIT_FOR_DETECT` (backend): when set to `true`, backend waits for a detection cycle to complete after each graph push. Default `false` for better concurrency.
  - `ARB_ACK_TIMEOUT_MS` (backend): time in ms to wait for arb-rs to report a graph version >= pushed version. Default `2500`.
  - `SHYFT_API_KEY`: Shyft GraphQL API key for Pumpswap pool fetching (optional)
- Frontend:
  - `VITE_API_BASE`: e.g., `http://localhost:3001/api`
  - `VITE_WS_URL`: e.g., `http://localhost:3001`

Create `.env` files if needed (`frontend/.env`, `backend/.env`) and/or use system envs.

### Run (Dev)
```
npm run dev
```
- Backend on `http://localhost:3001`
- Frontend on `http://localhost:5173`

Open the frontend URL in your browser. The UI will connect to the backend via REST/WebSocket.

### Migration Notes (routes refactor)

- Backend `routes.ts` was modularized under `backend/src/server/routes/*`.
- Frontend centralizes endpoints in `frontend/src/utils/routes.ts` and base in `frontend/src/utils/apiBase.ts`.
- Notable changes:
  - Arbitrage direct endpoints → `/api/arb/simulate`, `/api/arb/execute`.
  - Pool subscriptions returns `{ wsEnabled, wsHealthy, lastEventMs, ws }`.
  - Wallet tokens returns `{ list }`.

Fallbacks retained: `/api/api/start|stop|reset`, `/api/bot/start|stop`, `/api/config/reset`.

### QA Checklist (post-refactor)

- System/auth: `/api/system` loads; `/api/system/config` saves and log level reflects on frontend.
- Arbitrage: metrics refresh; start/stop; opportunities; simulate/execute; pools refresh/subscriptions/retarget; Graph reacts.
- Strategies: threshold/grid CRUD via `/api/strategy`; Grid Monitor rebalance and onlyClose toggle; Drift leveraged grid status/start/stop/update.
- Wallet: wallet info loads; add token, wrap/unwrap, send; `/api/wallet/tokens` returns `{ list }`.
- Liquidation: liquidator start/stop/update; queue updates over WS and HTTP.

## UI Guide

### Main Dashboard
- **System Info**: Bot/API/Backend status with colored indicators, Target Tick Time, Last Price Update, RPC endpoint display, and system configuration options
- **Wallet**: Address, SOL balance, SPL balances, Portfolio value (USDC/SOL), PnL since start, Wallet History with Solscan transaction links
- **System Log**: Real-time error tracking and system monitoring (renamed from "Error Log")
- **Terminal**: Enter commands; acknowledgements appear as `-> ...` lines

### Trading Interface
- **Positions**: Active positions with Pair, Side, Strategy, Size, Opened time, Duration, Entry/Target/Current, PnL (USDC)
- **Activity**: Per-strategy panel showing waiting state and recent actions (newest first)
- **Watchlist**: Tokens being tracked with current prices. If a token participates in an LST strategy, shows `NAV <ema-or-protocol> (premium %)`
- **Strategy Cards**: Configured strategies with all defined parameters, current anchor, triggers, expected/realized PnL, and Active/Inactive toggle. Cards can be collapsed for better organization

### Grid Trading Interface
- **Grid Monitors**: Real-time monitoring of grid strategies with:
  - **Grid Levels**: Buy/sell levels with current price indicators
  - **Active Positions**: Detailed position information including buy/sell IDs, intentions, and time open (HH:MM:SS format)
  - **Trade Summary**: Historical trades and performance metrics
  - **Sliding Center**: Visual indicator when center price is adjusting
- **Multiple Monitors**: Open multiple grid strategy monitors simultaneously
- **Enhanced Position Display**: Comprehensive position information with automatic pairing and closure

### Configuration Modals
- **Fee Configuration**: Comprehensive transaction fee settings with Jupiter optimization
- **System Configuration**: RPC URLs, Jupiter API settings, tick time, retry settings, and logging controls
- **Strategy Configuration**: Advanced strategy parameters including sliding center settings

## Terminal Commands (Quick Reference)

- wallet: generate | refresh | send TOKEN|MINT AMOUNT ADDRESS | addtoken TOKEN|MINT
  - Examples: `wallet generate`, `wallet refresh`, `wallet send SOL 0.01 EkqY...MY9X`, `wallet addtoken dSOL`

- watchlist: add QUERY|MINT | remove SYMBOL|MINT | list
  - Examples: `watchlist add SOL`, `watchlist remove dSOL`, `watchlist list`

- strategy (essentials):
  - `strategy set name=STR fromToken=SYMBOL|MINT toToken=SYMBOL|MINT buyPct=NUM sellPct=NUM amount=NUM active=true|false test=true|false`
  - Examples: `strategy set name=SOL-long fromToken=USDC toToken=SOL buyPct=0.005 sellPct=0.015 amount=0.01 active=true`,
    `strategy set name=SOL-short fromToken=SOL toToken=USDC sellPct=0.0075 buyPct=0.0015 amount=0.003 active=true`
  - Other: `strategy list`, `strategy status name=STR active=true|false`, `strategy remove NAME`

- strategy (grid trading):
  - `strategy set name=STR fromToken=SYMBOL|MINT toToken=SYMBOL|MINT gridType=TYPE gridSpacing=NUM gridLevels=NUM totalAmount=NUM levelAmount=NUM active=true|false`
  - Examples: `strategy set name=SOL-grid fromToken=USDC toToken=SOL gridType=arithmetic gridSpacing=0.01 gridLevels=5 totalAmount=1.0 levelAmount=0.1 active=true`,
    `strategy set name=SOL-advanced-grid fromToken=USDC toToken=SOL gridType=geometric gridSpacing=0.005 gridLevels=10 totalAmount=5.0 levelAmount=0.2 maxPositions=20 rebalanceThreshold=0.05 active=true`

- strategy (advanced — see section below):
  - slippageBps, scaleAggressiveness, scaleStepPct, maxOpenPositions, maxPositionSize,
  - hysteresisBps, cooldownMs, feeBps, extraSlippageBps,
  - fixedAnchor, anchorPairAtSetup,
  - lst, navSource,
  - slidingAnchor, slideRateBpsPerSec, slideMaxPct,
  - marketEnter

- bot: start | stop
- api: start | stop | reset
- ticktime: MS (set target tick time in ms)
- swap: AMOUNT FROM TO (priority lane)
- config: reset | ticktime MS
- help

## Grid Trading Strategies

Grid trading is a systematic approach that places multiple buy and sell orders at predetermined price levels around a center price. This strategy is particularly effective in ranging markets where prices oscillate between support and resistance levels.

### Grid Trading Features

- **Multiple Grid Types**: Arithmetic, Geometric, and Fibonacci spacing
- **Automatic Execution**: Orders execute automatically when price hits grid levels
- **Sliding Center Price**: Adaptive center that follows market movements
- **Dynamic Rebalancing**: Grids can be rebalanced when price moves significantly
- **Risk Management**: Stop-loss, take-profit, and position size controls
- **Real-time Monitoring**: Live grid level visualization and performance tracking
- **Position Pairing**: Automatic buy/sell position matching and closure
- **Multiple Monitors**: Simultaneous monitoring of multiple grid strategies

### Grid Strategy Configuration

Grid strategies are configured using the same strategy management system as threshold strategies, but with additional grid-specific parameters:

```bash
# Create a basic grid strategy
strategy set name=SOL-grid fromToken=USDC toToken=SOL gridType=arithmetic gridSpacing=0.01 gridLevels=5 totalAmount=1.0 levelAmount=0.1 active=true

# Advanced grid strategy with risk management
strategy set name=SOL-advanced-grid fromToken=USDC toToken=SOL gridType=geometric gridSpacing=0.005 gridLevels=10 totalAmount=5.0 levelAmount=0.2 maxPositions=20 stopLoss=0.1 takeProfit=0.2 rebalanceThreshold=0.05 adaptiveSpacing=true active=true

# Long-biased grid example (compress buys, expand sells)
strategy set name=SOL-long-bias fromToken=USDC toToken=SOL gridType=arithmetic gridSpacing=0.01 gridLevels=5 totalAmount=1.0 levelAmount=0.1 bias=long biasStrength=0.5 active=true
```

### Grid Strategy Parameters

#### Basic Configuration
- `gridType`: Grid spacing type (`arithmetic`, `geometric`, `fibonacci`)
- `gridSpacing`: Spacing between levels (as decimal, e.g., 0.01 = 1%)
- `gridLevels`: Number of levels above and below center price
- `centerPrice`: Center price for the grid (0 = use current market price)
- `totalAmount`: Total amount to be distributed across all levels
- `levelAmount`: Amount per individual grid level
- `bias` (optional): Grid side preference. One of `neutral` (default), `long`, or `short`.
- `biasStrength` (optional): Strength of bias from 0 to 1 (default 0). Bias compresses spacing and initial range toward the preferred side and nudges execution priority.

#### Sliding Center Configuration
- `slidingCenter`: Enable adaptive center price that follows market movements (`true`/`false`)
- `slideRate`: Rate of center price adjustment in basis points per second (e.g., 50 = 0.5% per second)
- `slideMaxDistance`: Maximum distance the center can slide as percentage of original center (e.g., 5 = 5%)

#### Risk Management
- `maxPositions`: Maximum number of concurrent positions
- `stopLoss`: Stop-loss percentage below center price
- `takeProfit`: Take-profit percentage above center price
- `rebalanceThreshold`: Rebalance when price moves this % from center

#### Advanced Features
- `adaptiveSpacing`: Enable volatility-based spacing adjustment
- `volatilityPeriod`: Period for volatility calculation (in ticks)
- `minLevelSpacing`: Minimum spacing between levels
- `maxLevelSpacing`: Maximum spacing between levels

### Grid Types Explained

#### Arithmetic Grid
Levels are spaced at fixed price intervals:
- Buy Level 1: Center - (1 × Spacing × Center)
- Buy Level 2: Center - (2 × Spacing × Center)
- Sell Level 1: Center + (1 × Spacing × Center)
- Sell Level 2: Center + (2 × Spacing × Center)

#### Geometric Grid
Levels are spaced at fixed percentage intervals:
- Buy Level 1: Center × (1 - Spacing)
- Buy Level 2: Center × (1 - Spacing)²
- Sell Level 1: Center × (1 + Spacing)
- Sell Level 2: Center × (1 + Spacing)²

#### Fibonacci Grid
Levels are spaced using Fibonacci ratios:
- Uses Fibonacci sequence ratios (1, 1, 2, 3, 5, 8, ...)
- Provides more natural spacing that adapts to market movements
- Particularly effective in trending markets

### Grid Monitoring

The UI provides comprehensive grid monitoring including:

- **Grid Overview**: Center price, current price, total levels, filled levels
- **Performance Metrics**: Total PnL, win rate, active positions
- **Level Visualization**: Real-time display of buy/sell levels with fill status
- **Position Tracking**: Active positions with entry prices and PnL
- **Recent Trades**: History of executed grid trades

### Grid Strategy Examples

#### Conservative Range Trading
```bash
strategy set name=SOL-conservative-grid fromToken=USDC toToken=SOL gridType=arithmetic gridSpacing=0.005 gridLevels=8 totalAmount=2.0 levelAmount=0.125 rebalanceThreshold=0.03 active=true
```

#### Aggressive Volatility Capture
```bash
strategy set name=SOL-aggressive-grid fromToken=USDC toToken=SOL gridType=geometric gridSpacing=0.01 gridLevels=12 totalAmount=5.0 levelAmount=0.2 adaptiveSpacing=true volatilityPeriod=10 active=true
```

#### Fibonacci Trend Following
```bash
strategy set name=SOL-fibonacci-grid fromToken=USDC toToken=SOL gridType=fibonacci gridSpacing=0.008 gridLevels=6 totalAmount=3.0 levelAmount=0.25 rebalanceThreshold=0.08 active=true
```

#### Adaptive Sliding Center Grid
```bash
strategy set name=SOL-adaptive-grid fromToken=USDC toToken=SOL gridType=arithmetic gridSpacing=0.01 gridLevels=5 totalAmount=1.0 levelAmount=0.2 slidingCenter=true slideRate=50 slideMaxDistance=5 active=true
```

#### High-Frequency Sliding Grid
```bash
strategy set name=SOL-fast-sliding-grid fromToken=USDC toToken=SOL gridType=geometric gridSpacing=0.005 gridLevels=10 totalAmount=3.0 levelAmount=0.15 slidingCenter=true slideRate=100 slideMaxDistance=10 active=true
```

#### Conservative Sliding Grid
```bash
strategy set name=SOL-slow-sliding-grid fromToken=USDC toToken=SOL gridType=arithmetic gridSpacing=0.008 gridLevels=6 totalAmount=2.0 levelAmount=0.167 slidingCenter=true slideRate=25 slideMaxDistance=3 active=true
```

## New Features & Configuration

### Sliding Center Price
The sliding center feature allows grid strategies to adapt to market movements by gradually adjusting the center price towards the current market price.

**How it works:**
- When `slidingCenter=true`, the center price slides towards the current market price
- `slideRate` controls how fast the center moves (basis points per second)
- `slideMaxDistance` limits how far the center can slide from its original position
- Grid levels automatically adjust proportionally as the center slides

**Example Configuration:**
```bash
strategy set name=SOL-adaptive-grid fromToken=USDC toToken=SOL gridType=arithmetic gridSpacing=0.01 gridLevels=5 totalAmount=1.0 levelAmount=0.2 slidingCenter=true slideRate=50 slideMaxDistance=5 active=true
```

### Enhanced Position Tracking
Grid strategies now feature advanced position management with automatic pairing and closure.

**Features:**
- **Position Pairing**: Buy and sell positions are automatically matched and closed
- **Detailed Information**: Each position shows buy/sell ID, intention, and time open
- **Time Formatting**: Positions display time open in HH:MM:SS format
- **PnL Calculation**: Accurate profit/loss calculation for each position

### Multiple Grid Monitors
You can now monitor multiple grid strategies simultaneously without conflicts.

**Features:**
- Open monitors on different grid strategies independently
- Each monitor shows real-time grid levels and positions
- Collapsible strategy cards for better organization
- Enhanced active positions display with detailed information

### System Configuration
Advanced system settings can now be configured through the UI.

**Configurable Parameters:**
- **RPC URLs**: Set custom Solana RPC endpoints
- **Jupiter API URLs**: Configure Jupiter aggregator endpoints
- **Target Tick Time**: Adjust update frequency (milliseconds)
- **Retry Settings**: Configure retry attempts and delays
- **Connection Timeout**: Set connection timeout values
- **Logging Level**: Control logging verbosity

### Fee Configuration
Transaction fees can now be optimized through comprehensive fee settings.

**Fee Parameters:**
- **Base Fee**: Minimum transaction fee
- **Priority Fee**: Additional fee for faster processing
- **Max Fee**: Maximum fee limit
- **Dynamic Fees**: Enable adaptive fee calculation
- **Jupiter Settings**: Configure Jupiter-specific fee parameters
- **Slippage Control**: Set maximum slippage tolerance

### Orca Whirlpools Integration

Lockstone now defaults to an HTTP-first Orca pools fetch to avoid legacy SDK parsing issues with AdaptiveFee tiers. You can control behavior with env vars:

```
ORCA_MODE=http            # http | v4 | legacy (fallback chain tries all)
ORCA_API_URL=https://api.orca.so/v2/solana/pools
ORCA_WHIRLPOOLS_PROGRAM_ID=whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc
ORCA_WHIRLPOOLS_CONFIG=7cSHePZUPCXKmgkkCm1cW8XkyRjB6rQAtv6vZ9VJ4N8S
ORCA_CACHE_TTL_MS=60000
ORCA_HTTP_MAX_RETRIES=2
ORCA_HTTP_BACKOFF_MS=500
```

Notes:
- HTTP response is normalized to CLMM pools only (amm: []).
- Set `ORCA_MODE=v4` to use the v4 client which supports AdaptiveFee tiers. Legacy SDK is available via `ORCA_MODE=legacy` but may fail on adaptive fee accounts.

## Graph Visualizer

The UI includes an optional Graph view that visualizes the token graph built from Raydium and Orca pools.

- Backend endpoints:
  - `GET /api/graph`: returns a snapshot `{ version, timestamp, nodes, edges }`
  - `GET /api/graph/path?from=MINT&to=MINT`: returns a simple path `{ path: string[] }`
- Websocket channels:
  - `graph-snapshot`: emits a full snapshot on first build
  - `graph-update`: emits diffs `{ addedNodes, updatedNodes, removedNodeIds, addedEdges, updatedEdges, removedEdgeIds }`

Frontend:
- Toggle via the "Show Graph" button under System Info.
- Uses Cytoscape with `fcose` layout; filter by DEX and choose layouts.
- Elements:
  - Nodes: token mints with labels when available (via token map/watchlist)
  - Edges: undirected between token mints, colored by DEX; weight derived from liquidity/fee

### Performance notes (UI responsiveness)
- The frontend coalesces `graph-update`/`graph-snapshot` events and applies them during idle time to keep the main thread responsive.
- Cytoscape mutations are batched to reduce layout/reflow work.
- Opportunities and metrics refreshes triggered by graph/log events are debounced (~750 ms) to avoid redundant fetches under event bursts.
- Optional backend knob: set `system.graphStreamIntervalMs` (e.g., 6000–8000 ms) in backend config to reduce event cadence if your environment is resource‑constrained.


## Strategy Configuration Fields (Detailed)
- name: Identifier of the strategy.
- fromToken: Base asset (quote denominator), e.g., USDC or SOL.
- toToken: Quote asset (numerator), e.g., SOL or dSOL. Pair price is fromToken->toToken.
- buyPct: Fractional drop below anchor that triggers a long entry. Example: 0.004 = 0.4%.
- sellPct: Fractional rise above anchor that triggers a short entry (or close long). Example: 0.004 = 0.4%.
- amount: Trade size in fromToken units (for long) or quote-equivalent (for short open calculations).
- testMode: If true, simulate without sending transactions.
- fixedAnchor: When true, anchor is captured at setup/refresh and stays fixed until position resets to idle (after closure).
- marketEnter: Optional one-shot `long` or `short` immediate entry on next tick.
- scaleAggressiveness: Fraction of base amount to add per scaling step (e.g., 0.5 adds 50% of base).
- scaleStepPct: Price movement step from entry to trigger next scale (e.g., 0.002 = 0.2%).
- slippageBps: Slippage basis points used for quotes/swaps.
- maxOpenPositions: Max simultaneous positions for this strategy.
- maxPositionSize: Max cumulative base exposure via scaling to protect against runaway exposure.
- lst: Enable LST NAV-aware logic.
- navSource: `protocol` (placeholder) or `ema` for NAV estimate.
- hysteresisBps: Extra buffer (bps) to avoid churn around triggers.
- cooldownMs: Minimum time between actions to avoid flapping.
- feeBps: Estimated fees in basis points (Jupiter + AMMs) for edge calculations.
- extraSlippageBps: Additional slippage budget for conservative triggers.
 - slidingAnchor: Enable anchor to drift toward current while idle to keep triggers reachable.
 - slideRateBpsPerSec: Drift rate in basis points per second (e.g., 5 = 0.05% per second).
 - slideMaxPct: Cap on drift distance as a fraction (e.g., 0.02 = 2%) from the planned anchor between resets.

### Advanced Parameter Explanations
- slippageBps: Maximum allowed price impact relative to quote; higher values tolerate worse fills but increase fill probability.
- scaleAggressiveness: Fraction of the base amount to add when scaling in. 0.5 means each scale adds 50% of the configured amount.
- scaleStepPct: Required favorable move from entry per scale step. With 0.003 (0.3%), the bot adds at +0.3%, +0.6%, etc. for longs.
- maxOpenPositions: Limit on concurrent entries for this strategy, preventing multiple overlapping legs.
- maxPositionSize: Cap on cumulative base exposure (sum of base amounts across scales) to avoid runaway exposure.
- hysteresisBps: Extra buffer (bps) added to buy/sell thresholds to avoid flapping at the boundary. Example: with 10 bps, a 0.50% trigger becomes 0.51%.
- cooldownMs: Minimum time between actions to reduce churn and abide microstructure; prevents immediate re-entries or scales.
- feeBps: Estimated aggregate fees (Jupiter + AMMs). Used in pretrade edge considerations.
- extraSlippageBps: Additional slippage budget on top of slippageBps to create conservative triggers.
- fixedAnchor: If true, anchor is captured once (at setup or refresh) and not updated until position returns to idle.
- slidingAnchor: If true, while idle the anchor drifts toward current each tick at slideRateBpsPerSec, capped by slideMaxPct, so the bot stays near actionable prices.
- lst/navSource: LST-specific NAV-aware logic. With `ema`, NAV is estimated as an EMA of price; premium = price/NAV − 1 and can be used in conditions.
- marketEnter: One-shot instruction to open a position on next tick: `long` (buy) or `short` (sell) regardless of thresholds.

### Strategy Examples

SOL/USDC (Long bias):
```
strategy set name=SOL-long fromToken=USDC toToken=SOL buyPct=0.005 sellPct=0.015 amount=0.01 active=true test=false slippageBps=100 hysteresisBps=10 cooldownMs=3000 feeBps=30 extraSlippageBps=50 minEdgeBps=60 slidingAnchor=true slideRateBpsPerSec=5 slideMaxPct=0.02
```

SOL/USDC (Light short):
```
strategy set name=SOL-short fromToken=SOL toToken=USDC sellPct=0.0075 buyPct=0.0015 amount=0.003 active=true test=false slippageBps=100 hysteresisBps=8 cooldownMs=2000 feeBps=30 extraSlippageBps=50 minEdgeBps=60 slidingAnchor=true slideRateBpsPerSec=2 slideMaxPct=0.01
```

SOL/dSOL (Long):
```
strategy set name=SOLdSOL-long fromToken=SOL toToken=dSOL buyPct=0.004 sellPct=0.012 amount=0.02 active=true test=false lst=true navSource=ema hysteresisBps=10 cooldownMs=60000 feeBps=30 extraSlippageBps=20 minEdgeBps=60 fixedAnchor=true slidingAnchor=false
```

SOL/dSOL (Short):
```
strategy set name=SOLdSOL-short fromToken=dSOL toToken=SOL sellPct=0.008 buyPct=0.002 amount=0.02 active=true test=false lst=true navSource=ema hysteresisBps=10 cooldownMs=60000 feeBps=30 extraSlippageBps=20 minEdgeBps=60 fixedAnchor=true slidingAnchor=false
```

## PnL Calculation
- Long: PnL_USD ≈ (SOL_now_USD − SOL_open_USD) × SOL_size
- Short: PnL_USD ≈ (SOL_open_USD − SOL_now_USD) × SOL_size
  - The UI uses SOL delta × size to avoid orientation confusion for small legs; backend summaries record realized PnL on close.

## Logs
- Terminal Log: user commands and bot acknowledgements (e.g., `-> swapping 0.02 SOL dSOL`).
- Error Log: API/backend errors, pretrade and trade lifecycle messages; timestamps use local time (no ms).
 - Categories: [jupiter, strategy, pretrade, trade, terminal]; UI color-codes by category.
- Trade summaries: appended to `backend/logs/trade_summaries.jsonl` on position closes with time, strategy, side, pair, entry/exit, size, and PnL (USDC).
- Quotes/Intents/Trades logs: `backend/logs/quotes.jsonl`, `backend/logs/intents.jsonl`, `backend/logs/trades.jsonl`.

## Rate Limiting
- Adaptive limiter reacts to 429s and latency; target tick time is configurable with `ticktime`.
- User swaps bypass queue using priority lane.

## Persistence
- `backend/config/watchlist.json`
- `backend/config/strategies.json`
- `backend/config/walletTokens.json`
- `backend/config/walletHistory.json`
- Wallet keypair: `backend/wallet/keypair.json`

## Troubleshooting
- 0x1 or 0x1788 errors: bot captures `SendTransactionError` logs and surfaces a brief explanation in Terminal; see Error Log for full details.
- If watchlist prices stall on boot, watchdog re-enables the feed when watchlist is non-empty.
- If Strategy tab does not reflect new fields immediately, the UI auto-fetches `/api/strategy` upon `strategies-update`. You can also run `strategy list` in the terminal.

## How LST NAV (EMA) works
- Each tick, if a strategy has `lst=true`, the bot computes an EMA of the pair price when `navSource=ema` using: `ema = prev*(1-α) + price*α` (α=0.2 ≈ EMA-9).
- NAV and premium (`price/nav - 1`) are broadcast in activity events.
- The Watchlist row shows `NAV` and premium for tokens involved in an LST strategy.

## Production Notes
- Use a dedicated RPC provider; mainnet trading requires stable throughput.
- Consider setting tighter `API_MIN_GAP_MS_*` bounds to respect rate limits.
- Always keep a SOL fee buffer (MIN_SOL_FOR_FEES) in the wallet.



## Deployment (Ubuntu + Nginx + TLS)

This consolidated guide describes deploying to a single Ubuntu VM behind Nginx with Let’s Encrypt TLS. The recommended workflow uses the repo’s Makefile and the helper script `scripts/lockstone.sh` for build and deploy. Manual commands are included only for one‑time server setup (systemd units, Nginx, TLS).

### Prerequisites
- Ubuntu 22.04/24.04 LTS VM with static IP
- DNS A record to the VM (e.g., `bot.example.com`)
- Open ports: 22, 80, 443

### One‑time server setup
```bash
sudo apt update && sudo apt -y upgrade
sudo apt -y install git ufw nginx curl rsync build-essential pkg-config libssl-dev

# Node.js (LTS)
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
sudo apt -y install nodejs

# Rust (for arb-rs)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
source $HOME/.cargo/env

# Certbot (TLS)
sudo snap install core; sudo snap refresh core
sudo snap install --classic certbot
sudo ln -s /snap/bin/certbot /usr/bin/certbot

# Firewall
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw --force enable

# Service user and runtime dirs
sudo adduser --disabled-password --gecos "" lockstone
sudo usermod -aG sudo lockstone
sudo mkdir -p /var/lockstone/{config,wallet,logs}
sudo chown -R lockstone:lockstone /var/lockstone
sudo chmod -R 750 /var/lockstone
```

### Clone repository
```bash
sudo mkdir -p /opt/lockstone && sudo chown -R $USER:$USER /opt/lockstone
cd /opt/lockstone
git clone <YOUR_REPO_URL> Lockstone
cd Lockstone
```

### Backend environment
Create the backend `.env` with your values and secure permissions:
```bash
sudo nano /opt/lockstone/Lockstone/backend/.env
```
Paste the following, then save and exit:
```
PORT=4000
SOLANA_RPC_URL=<your-rpc-url>
CONFIG_DIR=/var/lockstone/config
WALLET_DIR=/var/lockstone/wallet
LOG_DIR=/var/lockstone/logs
SOCKETIO_PATH=/socket.io
# Optional: restrict CORS to your domain
# CORS_ORIGIN=https://bot.example.com
```
Secure permissions:
```bash
sudo chown lockstone:lockstone /opt/lockstone/Lockstone/backend/.env
sudo chmod 640 /opt/lockstone/Lockstone/backend/.env
```

### Systemd units (one‑time)
Create the unit files with `nano` and paste the contents.

Backend service:
```bash
sudo nano /etc/systemd/system/lockstone-backend.service
```
```ini
[Unit]
Description=Lockstone Backend
After=network.target

[Service]
User=lockstone
WorkingDirectory=/opt/lockstone/Lockstone/backend
Environment=NODE_ENV=production
Environment=PORT=4000
Environment=SOLANA_RPC_URL=<your-rpc-url>
Environment=CONFIG_DIR=/var/lockstone/config
Environment=WALLET_DIR=/var/lockstone/wallet
Environment=LOG_DIR=/var/lockstone/logs
Environment=SOCKETIO_PATH=/socket.io
ExecStart=/usr/bin/node /opt/lockstone/Lockstone/backend/dist/server/index.js
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

Arb service:
```bash
sudo nano /etc/systemd/system/lockstone-arb.service
```
```ini
[Unit]
Description=Lockstone Arbitrage Worker (arb-rs)
After=network.target

[Service]
User=lockstone
WorkingDirectory=/opt/lockstone/Lockstone/arb-rs
Environment=RUST_LOG=info
Environment=ARB_PORT=4010
Environment=ARB_HOST=127.0.0.1
Environment=ARB_CONFIG_PATH=/var/lockstone/config/arb-config.json
# Optional: require Authorization header from backend pushes
# Environment=ARB_SHARED_SECRET=<secret>
ExecStart=/opt/lockstone/Lockstone/arb-rs/target/release/arb-rs
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

Optional target to manage both:
```bash
sudo nano /etc/systemd/system/lockstone.target
```
```ini
[Unit]
Description=Lockstone Services Target
Requires=lockstone-backend.service lockstone-arb.service
After=lockstone-backend.service lockstone-arb.service

[Install]
WantedBy=multi-user.target
```

Apply and enable:
```bash
sudo systemctl daemon-reload
sudo systemctl enable --now lockstone-backend lockstone-arb
sudo systemctl enable lockstone.target || true
```

### Nginx (reverse proxy) and TLS
Create the site file with `nano` and paste the config:
```bash
sudo nano /etc/nginx/sites-available/lockstone
```
```nginx
server {
  listen 80;
  server_name bot.example.com;

  root /var/www/lockstone;
  index index.html;

  location / {
    try_files $uri /index.html;
  }

  location /api/ {
    proxy_pass http://127.0.0.1:4000/;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }

  location /socket.io/ {
    proxy_pass http://127.0.0.1:4000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
  }
}
```
Enable and test, then issue the certificate:
```bash
sudo ln -s /etc/nginx/sites-available/lockstone /etc/nginx/sites-enabled/lockstone
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d bot.example.com --redirect --agree-tos -m you@example.com --non-interactive
```

### Build and deploy (preferred: Makefile or helper script)
From the repo root (`/opt/lockstone/Lockstone`):

Using Makefile:
```bash
sudo make build         # build backend, frontend (syncs to /var/www/lockstone), arb-rs
sudo make deploy        # restart backend+arb, reload nginx
sudo make start         # start nginx + backend + arb
sudo make stop          # stop nginx + backend + arb
sudo make status        # service status
```

Using helper script:
```bash
sudo ./scripts/lockstone.sh build
sudo ./scripts/lockstone.sh deploy
sudo ./scripts/lockstone.sh start
sudo ./scripts/lockstone.sh stop
sudo ./scripts/lockstone.sh status
```

Notes:
- Frontend artifacts sync to `/var/www/lockstone` by default. Override with `WWW_DIR=/custom/path`.
- Commands assume unit names `lockstone-backend`, `lockstone-arb`, and optional `lockstone.target`.

### Update and redeploy
```bash
cd /opt/lockstone/Lockstone
git pull --ff-only
sudo make deploy
# or: sudo ./scripts/lockstone.sh deploy
```

### Verify
```bash
curl -I https://bot.example.com
curl -s https://bot.example.com/api/system | jq
sudo systemctl status lockstone-backend | cat
```

### Files to customize
- `/etc/nginx/sites-available/lockstone`: domain, `root`, API/socket proxy destinations
- `/etc/systemd/system/lockstone-backend.service`: `SOLANA_RPC_URL`, paths, `ExecStart`
- `/etc/systemd/system/lockstone-arb.service`: paths, `ExecStart`, `ARB_PORT`
- DNS: A record for your domain to the VM IP
- Certbot command: your email and domain

### Authentication
- App enforces auth for REST and WebSocket. In production set strong credentials via env on the backend service:
  - `Environment=AUTH_USER=<username>`
  - `Environment=AUTH_PASS=<strong-password>`
  - Optional: `Environment=AUTH_REALM=Lockstone`
  - Then: `sudo systemctl daemon-reload && sudo systemctl restart lockstone-backend`

### Troubleshooting
- `journalctl -u lockstone-backend -e -n 200 | cat`
- `sudo ls -ld /var/lockstone /var/lockstone/{config,wallet,logs}`
- `ls -l /opt/lockstone/Lockstone/backend/dist/server/index.js`
- `which node` and adjust `ExecStart` if needed