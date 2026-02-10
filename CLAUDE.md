# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Lockstone is a Solana trading bot with arbitrage detection and execution capabilities. It consists of four main components:

- **backend/** - Node.js/TypeScript Express server with Socket.IO for real-time updates
- **frontend/** - React/Vite SPA with Tailwind CSS and Cytoscape for graph visualization
- **arb-rs/** - High-performance Rust service for arbitrage cycle detection (Bellman-Ford + SPFA)
- **arb-router/** - Anchor program for on-chain atomic multi-hop swaps and flash loan vaults

## Common Commands

### Development
```bash
npm install          # Install all workspaces (backend, frontend, arb-router)
npm run dev          # Start backend (port 3001) and frontend (port 5173) concurrently
npm run dev:backend  # Backend only with tsx watch
npm run dev:frontend # Frontend only with Vite
```

### Building
```bash
npm run build                # Build both backend and frontend
make build                   # Full build including arb-rs and arb-router (use sudo)
make arb                     # Build arb-rs only: cd arb-rs && cargo build --release
make arb-router              # Build Anchor program (requires Solana 2.x + Anchor 0.32.1+)
```

### Testing
```bash
npm test                     # Run backend tests (vitest)
npm run test:backend         # Same as above
npm run test:pipeline        # Backend pipeline tests via shell script
npm run test:real            # Real E2E tests (requires RUN_REAL_E2E=true)
npm run test:rs              # Rust tests: cargo test --manifest-path arb-rs/Cargo.toml
npm run test:all             # Run both backend and Rust tests

# Drift-specific tests
npm run test:drift:unit      # Drift unit tests (mocked)
npm run test:drift:real      # Real Drift E2E (needs WALLET_PATH, SOLANA_RPC_URL)
npm run test:drift:mutating  # Mainnet mutating tests (needs DRIFT_MUTATING_MAINNET_ACK=I_ACCEPT_RISK)
```

### Deployment (Ubuntu + systemd)
```bash
make deploy        # Build + restart lockstone-backend, lockstone-arb, reload nginx
make start         # Start services
make stop          # Stop services
make status        # Show service status
make logs          # Open tmux log dashboard
```

## Architecture

### Data Flow
1. Backend fetches pools from DEXs (Raydium, Orca, Meteora, PumpSwap) → builds graph
2. Graph snapshots pushed to arb-rs via HTTP/WebSocket
3. arb-rs runs cycle detection (Bellman-Ford + SPFA), emits opportunities
4. Backend validates, simulates, executes via arb-router Anchor program
5. Results broadcast to frontend via Socket.IO

### Backend Structure (`backend/src/`)
- `server/` - Express + Socket.IO entry point, routes under `server/routes/`
- `server/graph*.ts` - DEX pool graph construction and pathfinding
- `server/pools.ts` - Pool fetching/caching for Raydium, Orca, Meteora
- `execution/` - Trade execution: `arbExecutor.ts`, transaction builders in `builder/`
- `drift/` - Drift Protocol integration (perpetuals, liquidation)
- `jupiter/` - Jupiter Aggregator integration
- `wallet/` - Keypair management, RPC connection
- `utils/` - Config, logging, ALT manager, blockhash warmer

### Frontend Structure (`frontend/src/`)
- `app/` - Root layout, contexts (auth, api, websocket), hooks
- `features/` - Feature modules: arbitrage, drift, strategies, wallet, graph
- `components/` - Reusable UI components
- `utils/` - API route definitions, helpers

### arb-rs Structure (`arb-rs/src/`)
- `main.rs` - Axum HTTP/WS server receiving graph updates
- `graph.rs` - Pool graph representation
- `algos.rs` - Cycle detection algorithms
- `opportunities.rs` - Opportunity filtering and data structures

### arb-router Structure (`arb-router/programs/arb-router/`)
- `vault_*.rs` - Flash loan vault management
- `flash_*.rs` - Flash loan borrow/repay
- `execute.rs` - Multi-hop atomic arbitrage execution
- `dex/` - DEX-specific instruction builders (Raydium, Orca, Meteora, PumpSwap)

## Key Configuration

### Environment Variables
- `SOLANA_RPC_URL` - Solana RPC endpoint
- `WALLET_PATH` - Path to keypair JSON (default: `backend/wallet/keypair.json`)
- `PORT` - Backend port (default: 3001)
- `VITE_API_BASE` - Frontend API URL (default: `http://localhost:3001/api`)
- `ARB_SHARED_SECRET` - Auth token for backend→arb-rs communication

### Pool Configuration
- `ORCA_MODE` - `http` | `v4` | `legacy`
- `RAYDIUM_ONCHAIN` - Enable direct RPC scanning
- `METEORA_MODE` - `http` (default)
- `POOLS_REFRESH_MS` - Unified refresh cadence
- `SCOPE_POOLS_MODE` - `none` | `watchlist` | `jupiter` | `intersection` | `union`

### Known-good Dependency Pins (backend)
- `@solana/web3.js`: 1.98.0
- `rpc-websockets`: 9.1.3 (enforced via overrides)

## API Routes

Routes are modularized under `backend/src/server/routes/`:
- `/api/system` - System status and config
- `/api/wallet` - Wallet info and operations
- `/api/arb/pools/*` - Pool data (raydium, orca, meteora)
- `/api/arb/config` - Execution config
- `/api/arb/execute-direct` - Direct trade execution
- `/api/graph` - Graph snapshot and paths
- `/api/drift/*` - Drift status, L2, funding
- `/api/strategies/*` - Strategy CRUD (leveraged-grid, liquidator)

## WebSocket Events

Socket.IO channels for real-time updates:
- `graph-snapshot` - Full graph on first build
- `graph-update` - Incremental graph diffs
- `tx:start`, `tx:resolved`, `tx:sim.ok`, `tx:send.ok` - Transaction lifecycle
- `strategies-update` - Strategy state changes

## Persistence

- `backend/config/strategies.json` - Trading strategies
- `backend/config/watchlist.json` - Token watchlist
- `backend/config/walletTokens.json` - Tracked wallet tokens
- `backend/logs/` - Trade summaries, quotes, intents (JSONL)

## Domain Knowledge (`.cursor/skills/`)

Deep reference docs live in `.cursor/skills/`. Read the relevant skill files before working on the corresponding area of the codebase.

### Component Skills
| Skill | Path | Use when working on |
|-------|------|---------------------|
| lockstone-backend | `lockstone-backend/SKILL.md` | Backend server, pool fetching, graph construction, execution flow, WebSocket events |
| lockstone-arb-rs | `lockstone-arb-rs/SKILL.md` | Rust cycle detection service, graph algorithms, opportunity filtering, arb-rs HTTP/WS API |
| lockstone-arb-router | `lockstone-arb-router/SKILL.md` | Anchor program, vault system, DEX CPIs, transaction building, on-chain execution |

### DEX Integration Skills
| Skill | Path | Use when working on |
|-------|------|---------------------|
| dex-raydium | `dex-raydium/SKILL.md` | Raydium AMM v4, CLMM, CPMM pool types, swap instructions |
| dex-orca | `dex-orca/SKILL.md` | Orca Whirlpool, concentrated liquidity, tick arrays, sqrt price math |
| dex-meteora | `dex-meteora/SKILL.md` | Meteora DLMM, DAMM v1/v2, bin arrays, swap/swap2 variants |
| dex-pumpswap | `dex-pumpswap/SKILL.md` | PumpSwap buy/sell instructions, bonding curve graduation |

### Arbitrage Theory
| Skill | Path | Covers |
|-------|------|--------|
| atomic-arbitrage | `atomic-arbitrage/SKILL.md` | Overview and index for all sub-topics below |
| | `atomic-arbitrage/cycle-detection.md` | Bellman-Ford, SPFA algorithm implementations |
| | `atomic-arbitrage/amm-mathematics.md` | CPMM and CLMM swap math formulas |
| | `atomic-arbitrage/flash-loans.md` | Flash loan mechanics and patterns |
| | `atomic-arbitrage/mev-protection.md` | Jito bundles, frontrun protection strategies |
| | `atomic-arbitrage/optimal-execution.md` | Trade sizing, slippage models, price impact |
| | `atomic-arbitrage/references.md` | Academic paper citations |

All paths above are relative to `.cursor/skills/`.
