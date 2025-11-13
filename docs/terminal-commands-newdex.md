# Terminal Commands for New DEXes

## UI Terminal Commands

These commands can be used in the web interface terminal to test single-hop swaps on the newly integrated DEXes.

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

## Examples

### Simulate Swaps (Safe - No Real Transactions)

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

### Execute Swaps (Real Transactions - Use with Caution!)

```bash
# Execute Meteora Balanced v1 swap
arb singlehop exec damm-v1 0.01 50

# Execute Meteora Balanced v2 swap
arb singlehop exec damm-v2 0.01 50

# Execute Pumpswap swap
arb singlehop exec pumpswap 0.01 50
```

## Pool Discovery

To find available pools before running swaps:

```bash
# Via API (curl)
curl http://127.0.0.1:3001/api/arb/pools/meteora-balanced?minUsd=10000
curl http://127.0.0.1:3001/api/arb/pools/pumpswap?minUsd=1000
```

## Notes

1. **Auto-selection**: If no pool ID is provided, the system automatically selects a pool with the highest TVL for the SOL/USDC pair
2. **Default path**: Currently defaults to SOL → USDC
3. **Simulation first**: Always run `sim` mode before `exec` mode to verify the transaction builds correctly
4. **Gas fees**: Execution mode requires SOL for gas fees and the swap amount

## API Endpoints

The terminal commands use these underlying endpoints:

### Simulate (Dry Run)
- `/api/arb/simulate-send/meteora-balanced-v1`
- `/api/arb/simulate-send/meteora-balanced-v2`
- `/api/arb/simulate-send/pumpswap`

### Execute (Live Transactions)
- `/api/arb/execute/meteora-balanced-v1`
- `/api/arb/execute/meteora-balanced-v2`
- `/api/arb/execute/pumpswap`

## Testing Without UI

You can also test using the vitest test suite:

```bash
# In backend directory
RUN_LIVE_SINGLEHOP=true vitest run tests/singlehop.newdex.test.ts

# With actual execution (requires real SOL)
RUN_LIVE_SINGLEHOP=true RUN_LIVE_SINGLEHOP_EXECUTE=true \
vitest run tests/singlehop.newdex.test.ts
```

