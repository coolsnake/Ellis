# Terminal Commands for New DEXes

## UI Terminal Commands

These commands can be used in the web interface terminal to test single-hop and multi-hop swaps on the newly integrated DEXes.

## Single-Hop Commands

### Syntax

```bash
arb singlehop <mode> <target> [SIZE_SOL] [SLIPPAGE_BPS] [POOL_ID]
```

**Parameters:**
- `mode`: `sim` (simulate) or `exec` (execute)
- `target`: DEX type
- `SIZE_SOL`: Amount in SOL (default: 0.01)
- `SLIPPAGE_BPS`: Slippage in basis points (default: 50)
- `POOL_ID`: Optional specific pool ID (auto-selects by TVL if omitted)

### Supported Targets

| Target | DEX | Pool Type |
|--------|-----|-----------|
| `ray-amm` | Raydium | AMM |
| `ray-clmm` | Raydium | CLMM |
| `orca` | Orca | Whirlpool |
| `meteora` | Meteora | DLMM |
| `damm-v1` | Meteora Balanced | DAMM v1 |
| `damm-v2` | Meteora Balanced | DAMM v2 |
| `pumpswap` | Pumpswap | AMM |

### Single-Hop Examples

#### Simulate Swaps (Safe - No Real Transactions)

```bash
# Simulate Meteora Balanced v1 swap (SOL → USDC)
arb singlehop sim damm-v1

# Simulate Meteora Balanced v2 swap with custom size
arb singlehop sim damm-v2 0.1 100

# Simulate Pumpswap swap
arb singlehop sim pumpswap 0.01 50

# Simulate with specific pool ID
arb singlehop sim damm-v1 0.01 50 <pool_id>
```

#### Execute Swaps (Real Transactions - Use with Caution!)

```bash
# Execute Meteora Balanced v1 swap
arb singlehop exec damm-v1 0.01 50

# Execute Meteora Balanced v2 swap
arb singlehop exec damm-v2 0.01 50

# Execute Pumpswap swap
arb singlehop exec pumpswap 0.01 50
```

## Multi-Hop Commands

Multi-hop commands allow you to test arbitrage routes across multiple pools, either on the same DEX or across different DEXes.

### Syntax

```bash
# Single-DEX multi-hop (2+ hops on same DEX)
arb multihop <mode> <target> [SIZE_SOL] [SLIPPAGE_BPS] [POOL_ID_1] [POOL_ID_2] ...

# Multi-DEX multi-hop (2 hops across 2 DEXes)
arb multihop <mode> <dex1>+<dex2> [SIZE_SOL] [SLIPPAGE_BPS] [POOL_ID_1] [POOL_ID_2]
```

**Parameters:**
- `mode`: `sim` (simulate) or `exec` (execute)
- `target`: Single DEX for all hops
- `dex1+dex2`: Two DEXes separated by `+` for cross-DEX arbitrage
- `SIZE_SOL`: Amount in SOL (default: 0.01)
- `SLIPPAGE_BPS`: Slippage in basis points (default: 50)
- `POOL_ID_N`: Optional pool IDs (auto-selects if omitted)

### Multi-Hop Examples

#### Single-DEX Multi-Hop

```bash
# 2-hop Meteora Balanced v1 (SOL → USDC → SOL)
arb multihop sim damm-v1

# 2-hop Meteora Balanced v2 with custom params
arb multihop sim damm-v2 0.1 100

# 2-hop Pumpswap
arb multihop sim pumpswap 0.01 50
```

#### Multi-DEX Multi-Hop (Cross-DEX Arbitrage)

```bash
# Raydium CLMM → Meteora Balanced v1
arb multihop sim ray-clmm+damm-v1

# Orca → Meteora Balanced v2
arb multihop sim orca+damm-v2

# Meteora DLMM → Meteora Balanced v1
arb multihop sim meteora+damm-v1

# Raydium AMM → Pumpswap
arb multihop sim ray-amm+pumpswap

# With custom size and slippage
arb multihop sim damm-v1+damm-v2 0.1 100
```

#### Execute Multi-Hop (Real Transactions)

```bash
# Execute 2-hop DAMM v1 route
arb multihop exec damm-v1 0.01 100

# Execute cross-DEX arbitrage
arb multihop exec ray-clmm+damm-v1 0.01 100
```

## Pool Discovery

To find available pools before running swaps:

```bash
# Via API (curl)
curl http://127.0.0.1:3001/api/arb/pools/meteora-balanced?minUsd=10000
curl http://127.0.0.1:3001/api/arb/pools/pumpswap?minUsd=1000
```

## Notes

1. **Auto-selection**: If no pool IDs are provided, the system automatically selects pools with the highest TVL for SOL/USDC pairs
2. **Default paths**: 
   - Single-hop: SOL → USDC
   - Multi-hop (single DEX): SOL → USDC → SOL
   - Multi-hop (multi DEX): SOL → USDC → SOL
3. **Simulation first**: Always run `sim` mode before `exec` mode to verify the transaction builds correctly
4. **Gas fees**: Execution mode requires SOL for gas fees and the swap amount
5. **Slippage**: Multi-hop routes should use higher slippage (100+ bps) to account for price impact across multiple hops

## API Endpoints

The terminal commands use these underlying endpoints:

### Simulate (Dry Run)
- `/api/arb/simulate-send/meteora-balanced-v1`
- `/api/arb/simulate-send/meteora-balanced-v2`
- `/api/arb/simulate-send/pumpswap`
- `/api/arb/simulate-send` (generic for multi-hop)

### Execute (Live Transactions)
- `/api/arb/execute/meteora-balanced-v1`
- `/api/arb/execute/meteora-balanced-v2`
- `/api/arb/execute/pumpswap`
- `/api/arb/execute` (generic for multi-hop)

## Testing Without UI

You can also test using the vitest test suites:

### Single-Hop Tests

```bash
# In backend directory
RUN_LIVE_SINGLEHOP=true vitest run tests/singlehop.newdex.test.ts

# With actual execution (requires real SOL)
RUN_LIVE_SINGLEHOP=true RUN_LIVE_SINGLEHOP_EXECUTE=true \
vitest run tests/singlehop.newdex.test.ts
```

### Multi-Hop Tests

```bash
# Test multi-hop routes (simulation only)
RUN_LIVE_MULTIHOP=true vitest run tests/multihop.newdex.test.ts

# With actual execution (requires real SOL)
RUN_LIVE_MULTIHOP=true RUN_LIVE_MULTIHOP_EXECUTE=true \
vitest run tests/multihop.newdex.test.ts
```

## Example Test Scenarios

### Scenario 1: New DEX Validation
Test each new DEX individually with single-hop swaps:
```bash
arb singlehop sim damm-v1
arb singlehop sim damm-v2
arb singlehop sim pumpswap
```

### Scenario 2: Cross-DEX Arbitrage
Test arbitrage opportunities across different DEXes:
```bash
arb multihop sim ray-clmm+damm-v1
arb multihop sim orca+damm-v2
arb multihop sim meteora+damm-v1
```

### Scenario 3: Multi-Version Testing
Test routes using both versions of Meteora Balanced:
```bash
arb multihop sim damm-v1+damm-v2
```

### Scenario 4: Production-Like Test
Run a full test with execution (use small amounts):
```bash
# Simulate first
arb multihop sim damm-v1+damm-v2 0.01 100

# If simulation passes, execute
arb multihop exec damm-v1+damm-v2 0.01 100
```


