# Lockstone

A high-performance Solana arbitrage detection and execution system. Lockstone identifies profitable trading cycles across multiple DEXs and executes atomic multi-hop swaps using flash loans.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                           Frontend (React)                          │
│                    Real-time monitoring & visualization             │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                              Socket.IO
                                    │
┌─────────────────────────────────────────────────────────────────────┐
│                      Backend (Node.js/TypeScript)                   │
│  • Pool fetching from DEXs (Raydium, Orca, Meteora, PumpSwap)      │
│  • Real-time WebSocket subscriptions to DEX programs               │
│  • Graph construction & incremental updates                         │
│  • Opportunity validation & simulation                              │
│  • Transaction building & execution                                 │
└─────────────────────────────────────────────────────────────────────┘
                │                                    │
           HTTP/WebSocket                      Solana RPC
                │                                    │
┌───────────────────────────────┐    ┌────────────────────────────────┐
│       arb-rs (Rust)           │    │   arb-router (Anchor Program)  │
│  • Bellman-Ford cycle detect  │    │  • Flash loan vault management │
│  • SPFA optimization          │    │  • Atomic multi-hop execution  │
│  • High-throughput filtering  │    │  • DEX swap CPIs               │
└───────────────────────────────┘    └────────────────────────────────┘
```

### Components

| Component | Language | Description |
|-----------|----------|-------------|
| **backend/** | TypeScript | Express server handling pool fetching, graph construction, and trade execution |
| **frontend/** | React/Vite | Real-time dashboard with graph visualization (Cytoscape) |
| **arb-rs/** | Rust | High-performance arbitrage cycle detection service |
| **arb-router/** | Rust (Anchor) | On-chain program for atomic arbitrage execution |

## Supported DEXs

| DEX | Pool Types | Fetch Methods |
|-----|------------|---------------|
| **Raydium** | AMM v4, CLMM, CPMM | HTTP API, GraphQL, On-chain |
| **Orca** | Whirlpool (CLMM) | HTTP API, GraphQL |
| **Meteora** | DLMM, DAMM v1/v2 | HTTP API, GraphQL |
| **PumpSwap** | Bonding Curve | GraphQL, On-chain |

## Quick Start

### Prerequisites

- Node.js 20+ and npm 9+
- Rust (for arb-rs)
- Solana CLI and Anchor (for arb-router, optional)
- A Solana RPC endpoint (Helius, QuickNode, Alchemy, etc.)

### Installation

```bash
git clone https://github.com/your-org/lockstone.git
cd lockstone
npm install
```

### Configuration

1. Copy environment templates:
```bash
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env
```

2. Edit `backend/.env` with your RPC URL:
```bash
SOLANA_RPC_URL=https://your-rpc-provider.com/?api-key=YOUR_KEY
```

3. Create a wallet keypair (or use an existing one):
```bash
mkdir -p backend/wallet
solana-keygen new -o backend/wallet/keypair.json
```

### Running

**Development (backend + frontend):**
```bash
npm run dev
```
- Backend: http://localhost:3001
- Frontend: http://localhost:5173

**With arbitrage detection (includes arb-rs):**
```bash
# Terminal 1: Build and run arb-rs
cd arb-rs
cargo build --release
./target/release/arb-rs

# Terminal 2: Run backend + frontend
npm run dev
```

---

## How It Works

### 1. Pool Discovery & Fetching

The backend continuously fetches pool data from supported DEXs using multiple strategies:

**HTTP API Mode (Default)**
- Fetches pool lists from DEX REST APIs
- Pagination support with configurable page sizes
- Automatic retry with exponential backoff on rate limits (429)

**GraphQL Mode (Optional)**
- Lightweight summary queries by token mints
- Fetches full details only for qualifying pools
- Reduces API calls significantly for large pool sets

**On-Chain Fetching**
- Direct RPC queries for pool account data
- Used for real-time price updates and validation
- Supports account batching for efficiency

Each pool is normalized into a unified format containing:
- Token pair addresses and decimals
- Reserve amounts and liquidity metrics
- Fee tiers and price calculations
- Pool activity timestamps

### 2. Real-Time DEX Program Subscriptions

The backend maintains WebSocket connections to Solana for live pool updates:

**Account Subscriptions**
- Subscribes to individual pool accounts via `accountSubscribe`
- Receives instant notifications when pool state changes
- Per-account debouncing prevents duplicate processing

**Program Subscriptions**
- Monitors entire DEX programs via `programSubscribe`
- Automatically discovers new pools
- Optional filters for targeted monitoring

**Subscription Architecture**
- Connection pooling across multiple WebSocket connections
- Automatic reconnection with exponential backoff
- State tracking: CONNECTING → OPEN → CLOSING → CLOSED

**Real-Time Decoding**
- Specialized decoders for each DEX's account layout
- Validates account ownership and program IDs
- Price pipeline with sanity checks and clamping
- Optional worker thread processing for high throughput

### 3. Graph Construction

Pools are assembled into a directed weighted graph optimized for cycle detection:

**Graph Structure**
- **Nodes** = Token mints (with labels from Jupiter/watchlist)
- **Edges** = Swap routes with weights derived from `-log(exchange_rate)`

This negative-log transformation converts the multiplicative problem of finding profitable cycles into an additive shortest-path problem, enabling use of Bellman-Ford algorithm.

**Build Pipeline**
1. **Universe Filtering** - Scope to relevant tokens (Jupiter, watchlist, or intersection)
2. **Liquidity Filtering** - Remove low-TVL pools below threshold
3. **Activity Filtering** - Exclude stale pools (configurable max age)
4. **Cross-DEX Validation** - Detect and filter price anomalies between DEXs
5. **Graph Pruning** - Optional removal of dead-end nodes

**Incremental Updates**
- WebSocket updates trigger incremental graph diffs
- Only changed nodes/edges are recomputed
- Periodic full rebase for consistency (configurable threshold)
- Debounced rebuilds prevent excessive computation

### 4. Cycle Detection (arb-rs)

The Rust service receives graph snapshots/diffs and runs optimized algorithms:

**Bellman-Ford Algorithm**
- Detects negative-weight cycles indicating profitable arbitrage
- Handles arbitrary cycle lengths
- Tracks predecessor pointers for path reconstruction

**SPFA Optimization**
- Shortest Path Faster Algorithm variant
- Queue-based optimization for sparse graphs
- Early termination on cycle detection

**Opportunity Filtering**
- Minimum expected profit threshold
- Maximum path length constraints
- Liquidity validation against cycle size
- Duplicate/overlapping cycle removal

### 5. Atomic Execution (arb-router)

Validated opportunities are executed using the on-chain Anchor program:

1. **Flash Loan Borrow** - Borrow input tokens from vault (no collateral)
2. **Multi-Hop Swaps** - Execute swap sequence through DEX CPIs
3. **Flash Loan Repay** - Return borrowed amount plus fee
4. **Profit Capture** - Remaining tokens sent to executor wallet

All steps occur atomically in a single transaction - the entire cycle succeeds or reverts completely.

---

## Features

### Pool Fetching

| Feature | Description |
|---------|-------------|
| **Multi-DEX Support** | Raydium (AMM/CLMM/CPMM), Orca, Meteora (DLMM/DAMM), PumpSwap |
| **HTTP + GraphQL Modes** | Choose optimal fetch strategy per DEX |
| **Pagination Control** | Configurable page sizes and limits |
| **Rate Limit Handling** | Automatic retry with backoff on 429s |
| **Token Universe Scoping** | Filter pools by Jupiter tokens, watchlist, or custom set |
| **Anchor Bridging** | Allow routing through SOL/USDC/USDT bridges |
| **Activity Filtering** | Exclude inactive pools by timestamp |
| **TVL Thresholds** | Minimum liquidity requirements per pool type |
| **Cache Management** | Configurable TTL with force-refresh support |

### Real-Time Subscriptions

| Feature | Description |
|---------|-------------|
| **WebSocket Subscriptions** | Live pool account monitoring |
| **Program Subscriptions** | Automatic new pool discovery |
| **Connection Pooling** | Multiple WS connections for reliability |
| **Auto-Reconnection** | Exponential backoff retry logic |
| **Account Debouncing** | Prevent duplicate subscription processing |
| **Worker Thread Decoding** | Off-main-thread account parsing |
| **Retargeting** | Sync subscriptions with current graph state |

### Graph Engine

| Feature | Description |
|---------|-------------|
| **Incremental Updates** | Diff-based updates vs full rebuilds |
| **Cross-DEX Validation** | Price anomaly detection and filtering |
| **Dead-End Pruning** | Remove low-connectivity nodes |
| **Configurable Rebase** | Threshold-based full snapshot generation |
| **Debounced Rebuilds** | Batch rapid updates efficiently |
| **Token Labeling** | Jupiter + watchlist integration |

### Execution

| Feature | Description |
|---------|-------------|
| **Flash Loan Vaults** | Borrow without collateral |
| **Atomic Multi-Hop** | All-or-nothing execution |
| **DEX CPI Builders** | Native integration with each DEX |
| **Simulation** | Pre-flight transaction validation |
| **Jito Bundles** | MEV protection (optional) |

---

## Configuration Reference

### Environment Variables

#### Required

| Variable | Description |
|----------|-------------|
| `SOLANA_RPC_URL` | Solana RPC endpoint (with API key) |

#### Backend Server

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3001` | HTTP server port |
| `WALLET_PATH` | `./wallet/keypair.json` | Path to wallet keypair |
| `AUTH_USER` | - | Basic auth username (production) |
| `AUTH_PASS` | - | Basic auth password (production) |

#### Arbitrage Service

| Variable | Default | Description |
|----------|---------|-------------|
| `ARB_HOST` | `127.0.0.1` | arb-rs service host |
| `ARB_PORT` | `4010` | arb-rs service port |
| `ARB_SHARED_SECRET` | - | Auth token for backend→arb-rs |
| `ARB_WAIT_FOR_DETECT` | `false` | Wait for detection cycle after push |
| `ARB_ACK_TIMEOUT_MS` | `2500` | Timeout for arb-rs acknowledgment |

#### Pool Fetching

| Variable | Default | Description |
|----------|---------|-------------|
| `POOLS_REFRESH_MS` | `30000` | Pool refresh interval |
| `SCOPE_POOLS_MODE` | `jupiter` | Token filtering: `none`, `watchlist`, `jupiter`, `intersection`, `union` |
| `ORCA_MODE` | `http` | Orca fetch mode: `http`, `v4`, `legacy` |
| `RAYDIUM_ONCHAIN` | `false` | Enable Raydium on-chain fetching |
| `METEORA_MODE` | `http` | Meteora fetch mode |
| `SHYFT_API_KEY` | - | Shyft API key for PumpSwap |

#### Rate Limiting

| Variable | Default | Description |
|----------|---------|-------------|
| `API_MIN_GAP_MS_BASE` | `200` | Base request interval |
| `API_MIN_GAP_MS_MIN` | `100` | Minimum request interval |
| `API_MIN_GAP_MS_MAX` | `2000` | Maximum request interval (on backoff) |

### Runtime Configuration

The backend supports extensive runtime configuration via the `/api/system/config` endpoint:

<details>
<summary><strong>DEX Source Configuration</strong></summary>

```json
{
  "enabledDexSources": {
    "raydium": { "amm": true, "clmm": true, "cpmm": true },
    "orca": { "amm": true, "clmm": true },
    "meteora": true,
    "meteora_balanced": { "v1": true, "v2": true },
    "pumpswap": true
  }
}
```
</details>

<details>
<summary><strong>Pool Fetching Configuration</strong></summary>

```json
{
  "raydium": {
    "cacheTtlMs": 300000,
    "useGraphQL": false,
    "pageSize": 50,
    "maxPages": 10,
    "concurrency": 8
  },
  "orca": {
    "cacheTtlMs": 300000,
    "useGraphQL": false,
    "pageSize": 500,
    "maxPages": 5,
    "minTvl": 0,
    "sortBy": "liquidity"
  },
  "meteora": {
    "cacheTtlMs": 300000,
    "useGraphQL": false,
    "pageSize": 200,
    "maxPages": 3
  }
}
```
</details>

<details>
<summary><strong>Graph Configuration</strong></summary>

```json
{
  "system": {
    "graphSnapshotTtlMs": 30000,
    "graphRebaseDiffThreshold": 2000,
    "graphRebaseTimeMs": 300000,
    "graphMinRebuildGapMs": 500,
    "graphRebuildDebounceMs": 150,
    "graphIncrementalMode": true,
    "graphPruneDeadEnds": false,
    "graphPruneMinDegree": 1
  }
}
```
</details>

<details>
<summary><strong>Subscription Configuration</strong></summary>

```json
{
  "system": {
    "poolSubscriptionMode": "wss",
    "wsSubscribeMaxAttempts": 10,
    "wsSubscribeBackoffMs": 250,
    "workerDecodeEnabled": false,
    "workerDecodeThreads": 4,
    "workerDecodeBatchSize": 100
  }
}
```
</details>

<details>
<summary><strong>Filtering Configuration</strong></summary>

```json
{
  "system": {
    "tokenUniverseMode": "jupiter",
    "scopePools": true,
    "enableAnchorBridging": true,
    "minPoolsPerPair": 1,
    "minAmmLiqBase": 0,
    "minClmmLiquidity": 0,
    "maxInactivePoolMs": 43200000,
    "enableActivityFilter": true,
    "crossDexFilteringThreshold": 0.1
  }
}
```
</details>

---

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /api/system` | System status and configuration |
| `GET /api/system/config` | Get runtime configuration |
| `PUT /api/system/config` | Update runtime configuration |
| `GET /api/graph` | Current token graph snapshot |
| `GET /api/graph/path?from=MINT&to=MINT` | Find path between tokens |
| `GET /api/arb/pools/raydium` | Raydium pool data |
| `GET /api/arb/pools/orca` | Orca pool data |
| `GET /api/arb/pools/meteora` | Meteora pool data |
| `GET /api/arb/pools/subscriptions` | WebSocket subscription status |
| `POST /api/arb/pools/retarget` | Resync subscriptions with graph |
| `POST /api/arb/execute-direct` | Execute arbitrage opportunity |

## WebSocket Events

| Event | Description |
|-------|-------------|
| `graph-snapshot` | Full graph on connection |
| `graph-update` | Incremental graph changes |
| `pool-update` | Individual pool state change |
| `tx:start` | Transaction initiated |
| `tx:sim.ok` | Simulation succeeded |
| `tx:send.ok` | Transaction sent |
| `tx:resolved` | Transaction confirmed/failed |

---

## Building for Production

```bash
# Build all components
npm run build

# Or use Makefile (Linux/macOS)
make build

# Build individual components
npm run build:backend
npm run build:frontend
cd arb-rs && cargo build --release
```

## Testing

```bash
# Backend tests
npm test

# Rust tests
npm run test:rs

# All tests
npm run test:all
```

## Deployment

See the deployment section in CLAUDE.md for Ubuntu + Nginx + systemd setup.

Quick deploy with Makefile:
```bash
sudo make deploy    # Build + restart services + reload nginx
sudo make status    # Check service status
sudo make logs      # View logs
```

---

## Project Structure

```
lockstone/
├── backend/
│   ├── src/
│   │   ├── server/           # Express app, routes, Socket.IO
│   │   │   ├── routes/       # API route handlers
│   │   │   ├── graph*.ts     # Graph construction & updates
│   │   │   └── pools.ts      # DEX pool fetching orchestration
│   │   ├── pools/
│   │   │   ├── fetchers/     # Per-DEX HTTP/GraphQL fetchers
│   │   │   └── websockets/   # Real-time subscription handlers
│   │   │       └── decoders/ # Per-DEX account decoders
│   │   ├── execution/        # Trade execution
│   │   │   ├── arbExecutor.ts
│   │   │   └── builder/      # Transaction builders
│   │   ├── wallet/           # Keypair management
│   │   └── utils/            # Config, logging, helpers
│   └── config/               # Runtime configuration (gitignored)
├── frontend/
│   ├── src/
│   │   ├── app/              # Root layout, contexts, hooks
│   │   ├── features/         # Feature modules
│   │   │   ├── arbitrage/    # Arb monitoring UI
│   │   │   └── graph/        # Cytoscape visualization
│   │   └── components/       # Reusable UI components
├── arb-rs/
│   └── src/
│       ├── main.rs           # Axum HTTP/WS server
│       ├── graph.rs          # Graph representation
│       ├── algos.rs          # Bellman-Ford, SPFA
│       └── opportunities.rs  # Filtering & output
└── arb-router/
    └── programs/arb-router/
        ├── vault_*.rs        # Flash loan vaults
        ├── flash_*.rs        # Borrow/repay logic
        ├── execute.rs        # Multi-hop execution
        └── dex/              # DEX CPI builders
```

---

## Security

- Never commit `.env` files or wallet keypairs
- Use environment variables for all secrets
- The `backend/wallet/` directory is gitignored
- Rotate API keys if accidentally exposed
- Use `AUTH_USER` and `AUTH_PASS` in production

## License

MIT

## Contributing

1. Fork the repository
2. Create a feature branch
3. Submit a pull request

For major changes, please open an issue first to discuss.
