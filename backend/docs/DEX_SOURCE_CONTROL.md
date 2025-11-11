# DEX Source Control

This document describes how to control which DEX sources are fetched during pool refresh operations.

## Overview

You can now selectively enable/disable individual DEX fetchers and control which pool types (AMM/CLMM) to fetch. This is useful for:
- Testing specific DEX integrations
- Reducing API load during development
- Focusing on specific pool types
- Debugging individual fetchers

## Configuration

### 1. Config File (Default Settings)

Add to your `backend/config/arbConfig.json` or set via `CONFIG.system.enabledDexSources`:

```json
{
  "system": {
    "enabledDexSources": {
      "raydium": true,
      "orca": true,
      "meteora": true,
      "meteora_balanced": true,
      "pumpswap": true
    }
  }
}
```

### 2. Runtime Control via API

#### Disable Specific DEXes

```bash
# Fetch only Raydium and Orca
curl -X POST http://localhost:3001/api/arb/pools/refresh \
  -H "Content-Type: application/json" \
  -d '{
    "force": true,
    "subscribe": true,
    "sources": {
      "raydium": true,
      "orca": true,
      "meteora": false,
      "meteora_balanced": false,
      "pumpswap": false
    }
  }'
```

#### Fetch Only Specific Pool Types

```bash
# Fetch only Raydium AMM pools (no CLMM)
curl -X POST http://localhost:3001/api/arb/pools/refresh \
  -H "Content-Type: application/json" \
  -d '{
    "force": true,
    "subscribe": true,
    "sources": {
      "raydium": { "amm": true, "clmm": false },
      "orca": false,
      "meteora": false,
      "meteora_balanced": false,
      "pumpswap": false
    }
  }'
```

#### Fetch Only Pumpswap

```bash
curl -X POST http://localhost:3001/api/arb/pools/refresh \
  -H "Content-Type: application/json" \
  -d '{
    "force": true,
    "subscribe": false,
    "sources": {
      "raydium": false,
      "orca": false,
      "meteora": false,
      "meteora_balanced": false,
      "pumpswap": true
    }
  }'
```

#### Fetch Only CLMM Pools from Multiple DEXes

```bash
curl -X POST http://localhost:3001/api/arb/pools/refresh \
  -H "Content-Type: application/json" \
  -d '{
    "force": true,
    "sources": {
      "raydium": { "amm": false, "clmm": true },
      "orca": { "amm": false, "clmm": true },
      "meteora": true,
      "meteora_balanced": false,
      "pumpswap": false
    }
  }'
```

## Programmatic Usage

### TypeScript/JavaScript

```typescript
import { refreshAllSources, RefreshSourcesOptions } from './server/pools.js';

// Fetch only Raydium
const options: RefreshSourcesOptions = {
  force: true,
  subscribe: false,
  sources: {
    raydium: true,
    orca: false,
    meteora: false,
    meteora_balanced: false,
    pumpswap: false
  }
};

const result = await refreshAllSources(true, false, options);
console.log('Raydium pools:', result.raydium);
```

### Granular Control Example

```typescript
// Fetch only AMM pools from Raydium and Orca
const result = await refreshAllSources(true, false, {
  sources: {
    raydium: { amm: true, clmm: false },
    orca: { amm: true, clmm: false },
    meteora: false,
    meteora_balanced: false,
    pumpswap: false
  }
});
```

## Source Options

### Boolean Control

- `true`: Enable fetching for this DEX
- `false`: Skip fetching for this DEX
- `undefined`: Use config default (or `true` if no config)

### Granular Control (Raydium & Orca only)

For DEXes that support both AMM and CLMM:

```typescript
{
  raydium: {
    amm: true,   // Fetch Raydium AMM pools
    clmm: false  // Skip Raydium CLMM pools
  }
}
```

### Pool Type Support

| DEX                | AMM | CLMM |
|--------------------|-----|------|
| Raydium            | ✅  | ✅   |
| Orca               | ✅  | ✅   |
| Meteora            | ❌  | ✅   |
| Meteora Balanced   | ✅  | ❌   |
| Pumpswap           | ✅  | ❌   |

## Logging

When sources are disabled, you'll see log messages:

```
pools.refresh.phase.fetch.raydium.skipped { reason: 'disabled', cat: 'pools' }
pools.refresh.phase.fetch.orca.skipped { reason: 'disabled', cat: 'pools' }
```

When sources are enabled, you'll see:

```
pools.refresh.phase.fetch { enabled: { raydium: true, orca: false, ... }, cat: 'pools' }
pools.refresh.phase.fetch.complete { counts: { raydium: {...}, ... } }
```

## Response Format

The API response includes detailed counts:

```json
{
  "ok": true,
  "counts": {
    "raydium": { "amm": 150, "clmm": 75 },
    "orca": { "amm": 0, "clmm": 0 },
    "meteora": { "clmm": 0 },
    "meteora_balanced": { "amm": 0 },
    "pumpswap": { "amm": 0 }
  },
  "graph": {
    "nodes": 450,
    "edges": 900
  }
}
```

## Default Behavior

If no `sources` configuration is provided:
- **All DEXes are enabled by default**
- Config file settings are used if present
- Falls back to `true` for all sources

## Use Cases

### Development/Testing

```bash
# Test only Pumpswap integration
POST /api/arb/pools/refresh
{ "sources": { "pumpswap": true, "raydium": false, "orca": false, "meteora": false, "meteora_balanced": false } }
```

### Production with Limited DEXes

```json
{
  "system": {
    "enabledDexSources": {
      "raydium": true,
      "orca": true,
      "meteora": true,
      "meteora_balanced": false,
      "pumpswap": false
    }
  }
}
```

### Focus on High-Liquidity Sources

```bash
# Only major DEXes with CLMM support
POST /api/arb/pools/refresh
{
  "sources": {
    "raydium": { "amm": false, "clmm": true },
    "orca": { "amm": false, "clmm": true },
    "meteora": true,
    "meteora_balanced": false,
    "pumpswap": false
  }
}
```

## Notes

- Disabled sources still appear in the response with empty arrays
- Filtering and subscription phases respect disabled sources
- WebSocket subscriptions are only created for enabled sources
- Cache timestamps are preserved for skipped sources


