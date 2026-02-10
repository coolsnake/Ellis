---
name: lockstone-backend
description: Lockstone backend Node.js/TypeScript server for pool fetching, graph construction, and arbitrage execution. Use when working on the backend codebase, pool integration, graph building, execution flow, or WebSocket events.
---

# Lockstone Backend

Node.js/TypeScript Express server with Socket.IO for real-time updates, pool fetching, graph construction, and arbitrage execution.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        Backend Server                            │
├─────────────────────────────────────────────────────────────────┤
│  Express + Socket.IO Server                                      │
│  ├── /api/arb/*      - Arbitrage execution, pools               │
│  ├── /api/graph/*    - Graph snapshots, paths                   │
│  ├── /api/wallet/*   - Wallet operations                        │
│  ├── /api/drift/*    - Drift Protocol integration               │
│  └── /api/strategies/* - Strategy CRUD                          │
├─────────────────────────────────────────────────────────────────┤
│  Pool Layer                                                      │
│  ├── Raydium (AMM v4, CLMM, CPMM)                               │
│  ├── Orca Whirlpool                                              │
│  ├── Meteora (DLMM, DAMM v1/v2)                                 │
│  └── PumpSwap                                                    │
├─────────────────────────────────────────────────────────────────┤
│  Graph Layer                                                     │
│  ├── Pool → Edge conversion                                      │
│  ├── Incremental diff computation                                │
│  └── Push to arb-rs                                              │
├─────────────────────────────────────────────────────────────────┤
│  Execution Layer                                                 │
│  ├── Plan resolution                                             │
│  ├── Transaction building (router or SDK)                        │
│  ├── Simulation                                                  │
│  └── Sending (Jito/RPC)                                          │
└─────────────────────────────────────────────────────────────────┘
```

## Key Directories

| Directory | Purpose |
|-----------|---------|
| `server/` | Express routes, Socket.IO, graph construction |
| `server/routes/` | Modular API route handlers |
| `server/pools/` | DEX-specific pool fetchers |
| `execution/` | Trade execution pipeline |
| `execution/builder/` | Transaction builders |
| `execution/resolver/` | Quote resolution |
| `utils/` | Config, logging, helpers |

## Data Flow

```
1. Pool Fetching
   DEX APIs → getRaydiumPools(), getOrcaPools(), etc.
   
2. Normalization
   Raw pools → PoolsPayload { amm[], clmm[], cpmm[] }
   
3. Graph Construction
   PoolsPayload → GraphSnapshot { nodes[], edges[] }
   
4. Push to arb-rs
   GraphSnapshot/GraphDiff → HTTP POST to arb-rs
   
5. Opportunity Detection (arb-rs)
   arb-rs detects cycles → WebSocket stream
   
6. Execution
   Opportunity → Plan → Transaction → Simulation → Send
```

## Core Types

### Pool Types

```typescript
interface PoolsPayload {
  amm: AmmPool[];
  clmm: ClmmPool[];
  cpmm: CpmmPool[];
  timestamp: number;
}

interface CommonPoolFields {
  id: string;
  dex: string;
  mint_a: string;
  mint_b: string;
  fee_bps: number;
  liquidity: number;
  price_a_per_b: number;
  pool_kind: 'amm' | 'clmm' | 'cpmm';
}
```

### Graph Types

```typescript
interface GraphNode {
  id: string;      // Token mint address
  label?: string;
  degree?: number;
}

interface GraphEdge {
  id: string;
  source: string;  // Mint A
  target: string;  // Mint B
  dex: string;
  pool_id: string;
  fee_bps: number;
  liquidity: number;
  weight: number;
  price_a_per_b: number;
  pool_kind: 'amm' | 'clmm' | 'cpmm';
  // Native data for execution
  native_mint_a?: string;
  native_reserve_a_raw?: string;
  // ...
}

interface GraphSnapshot {
  version: number;
  timestamp: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

interface GraphDiff {
  version: number;
  timestamp: number;
  addedNodes?: GraphNode[];
  updatedNodes?: GraphNode[];
  removedNodeIds?: string[];
  addedEdges?: GraphEdge[];
  updatedEdges?: GraphEdge[];
  removedEdgeIds?: string[];
}
```

### Execution Types

```typescript
interface ExecutionPlan {
  hops: DirectHop[];
  inputMint: string;
  outputMint: string;
  inputAmount: bigint;
  expectedOutput: bigint;
}

interface DirectHop {
  dex: DexType;
  poolId: string;
  inputMint: string;
  outputMint: string;
  aToB: boolean;
  // Pool-specific data
}
```

## Pool Fetching

### Raydium

```typescript
// AMM v4, CLMM, CPMM pools
const pools = await getRaydiumPoolsNormalized();

// Files:
// - pools/raydium.ts - Main fetcher
// - pools/raydium.clmm.ts - CLMM specific
// - pools/raydium.cpmm.ts - CPMM specific
```

### Orca

```typescript
const pools = await getOrcaPoolsCached();

// Files:
// - pools/orca.ts - Whirlpool fetcher
// - pools/orca.normalize.ts - Normalization
```

### Meteora

```typescript
const pools = await getMeteoraPoolsCached();

// Files:
// - pools/meteora.ts - DLMM fetcher
// - pools/meteora.damm.ts - DAMM v1/v2
```

### PumpSwap

```typescript
const pools = await getPumpSwapPools();

// Files:
// - pools/pumpswap.ts - Via Shyft GraphQL
```

## Graph Construction

### Edge Building (`graph.edges.ts`)

```typescript
function edgesFromPoolIncremental(
  pool: NormalizedPool,
  existingEdges: Map<string, GraphEdge>
): GraphEdge[]

// Validation:
// - Fee bounds check
// - Price sanity check
// - USD deviation check
// - Edge allowlist filtering
```

### Diff Computation (`graph.diff.ts`)

```typescript
function computeGraphDiff(
  oldSnapshot: GraphSnapshot,
  newSnapshot: GraphSnapshot
): GraphDiff

// Epsilon thresholds for "significant" changes
```

### Push to arb-rs (`graph.orchestrator.ts`)

```typescript
// Full snapshot
await pushArbGraphSnapshot(snapshot);

// Incremental diff
await pushArbGraphDiff(diff);
```

## Execution Pipeline

### 1. Plan Resolution (`execution/resolver/`)

```typescript
const plan = await resolveDirectPlan(opportunity);

// Resolvers by DEX:
// - raydiumClmm.ts
// - raydiumAmm.ts
// - raydiumCpmm.ts
// - orca.ts
// - meteora.ts
// - meteoraDamm.ts
// - pumpswap.ts
```

### 2. Transaction Building (`execution/builder/`)

```typescript
// Router program transaction
const tx = await buildRouterTransaction(plan, {
  useFlashLoan: true,
  compact: true,
});

// Files:
// - routerTx.ts - Main builder
// - ix.ts - DEX instruction builders
// - tx.ts - Transaction utilities
```

### 3. Simulation

```typescript
const result = await assembleAndSimulate(tx, connection);
```

### 4. Sending

```typescript
// Via Jito bundle
await sendViaJito(tx, tipLamports);

// Via RPC
await sendViaRpc(tx);
```

## WebSocket Events

### Graph Events

| Event | Direction | Description |
|-------|-----------|-------------|
| `graph-snapshot` | Server→Client | Full graph snapshot |
| `graph-update` | Server→Client | Incremental diff |
| `graph:request-snapshot` | Client→Server | Request snapshot |

### Transaction Events

| Event | Direction | Description |
|-------|-----------|-------------|
| `tx:start` | Server→Client | Execution started |
| `tx:resolved` | Server→Client | Plan resolved |
| `tx:sim.ok` | Server→Client | Simulation passed |
| `tx:sim.err` | Server→Client | Simulation failed |
| `tx:send.ok` | Server→Client | Transaction sent |
| `tx:send.err` | Server→Client | Send failed |

### System Events

| Event | Direction | Description |
|-------|-----------|-------------|
| `system` | Server→Client | System status |
| `log` | Server→Client | Structured logs |
| `strategies-update` | Server→Client | Strategy changes |

## Configuration (`utils/config.ts`)

### Key Config Sections

```typescript
CONFIG = {
  system: {
    poolsRefreshMs: number,
    graphRebuildMs: number,
    // ...
  },
  raydium: {
    enabled: boolean,
    clmmEnabled: boolean,
    cpmmEnabled: boolean,
    // ...
  },
  orca: {
    enabled: boolean,
    mode: 'http' | 'v4' | 'legacy',
    // ...
  },
  meteora: {
    enabled: boolean,
    dlmmEnabled: boolean,
    dammEnabled: boolean,
    // ...
  },
  execution: {
    simulationSkip: boolean,
    useRouter: boolean,
    // ...
  },
  jito: {
    enabled: boolean,
    tipLamports: number,
    // ...
  },
}
```

### Environment Variables

| Variable | Purpose |
|----------|---------|
| `SOLANA_RPC_URL` | RPC endpoint |
| `WALLET_PATH` | Keypair path |
| `PORT` | Server port (default: 3001) |
| `ARB_SHARED_SECRET` | Auth for arb-rs |
| `ORCA_MODE` | Orca fetch mode |
| `RAYDIUM_ONCHAIN` | Enable RPC scanning |

## API Routes

### Arbitrage (`/api/arb/*`)

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/arb/execute-direct` | POST | Execute arbitrage |
| `/api/arb/config` | GET/POST | Execution config |
| `/api/arb/pools/raydium` | GET | Raydium pools |
| `/api/arb/pools/orca` | GET | Orca pools |
| `/api/arb/pools/meteora` | GET | Meteora pools |

### Graph (`/api/graph/*`)

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/graph/snapshot` | GET | Current snapshot |
| `/api/graph/snapshot/lite` | GET | Lightweight snapshot |
| `/api/graph/paths` | POST | Find paths |

### System (`/api/system`)

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/system` | GET | System status |
| `/api/system/config` | GET/POST | System config |

## Common Tasks

### Adding a New DEX

1. Create `pools/newdex.ts` with fetcher
2. Create normalizer to output `PoolsPayload`
3. Add to `pools.ts` aggregation
4. Create resolver in `execution/resolver/newdex.ts`
5. Create instruction builder in `execution/builder/ix/newdex.ts`
6. Update router transaction builder
7. Add config section

### Modifying Graph Edge Logic

1. Edit `graph.edges.ts` for edge derivation
2. Update validation in `edgesFromPoolIncremental()`
3. Update `EdgeAllow` config if needed

### Adding WebSocket Event

1. Define event type
2. Emit from appropriate location:
   ```typescript
   io.to(GRAPH_ROOM).emit('event-name', data);
   ```
3. Document in this skill

### Debugging Execution

1. Enable verbose logging: `CONFIG.execution.verbose = true`
2. Check session logs in `logs/`
3. Use `tx:*` events for real-time status
4. Simulation errors logged with full context

## Logging

### Structured Logger

```typescript
import { log } from './utils/logger';

log.info('message', { category: 'execution', data: {...} });
log.error('message', { category: 'pools', error });
```

### Categories

- `system` - Server lifecycle
- `pools` - Pool fetching
- `graph` - Graph construction
- `execution` - Trade execution
- `websocket` - Socket.IO events

### Session Logs

Transaction sessions recorded to `logs/session-*.jsonl` with full context for debugging.
