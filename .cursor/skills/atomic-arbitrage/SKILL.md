---
name: atomic-arbitrage
description: Crypto atomic arbitrage knowledge including cycle detection algorithms (Bellman-Ford, SPFA), AMM mathematics (CPMM, CLMM), flash loans, and MEV protection. Use when working on arbitrage detection, execution, DEX integration, graph construction, cycle finding, or optimizing trading strategies.
---

# Atomic Arbitrage Knowledge Base

## Core Concepts

### Atomic vs Non-Atomic Arbitrage

| Type | Definition | Risk Profile |
|------|------------|--------------|
| **Atomic** | All trades execute in single transaction; reverts if unprofitable | Zero execution risk (only gas cost on failure) |
| **Non-Atomic** | Trades span multiple transactions or venues (DEX↔CEX) | Execution risk, requires inventory |

**Key insight**: >25% of volume on Ethereum's top 5 DEXs is non-atomic arbitrage (DEX↔CEX), totaling $132B, concentrated among ~11 searchers [Heimbach 2024].

### Cyclic Arbitrage

A closed-loop sequence A→B→C→A exploiting price discrepancies. Profitable when:

```
∏(exchange_rates) × ∏(1 - fees) > 1
```

Empirical data: 292,606 cyclic arbitrages on Uniswap V2 over 11 months, >$138M revenue [Wang 2021].

---

## Graph Representation

Model DEX pools as weighted directed graph:
- **Vertices**: Tokens
- **Edges**: Pool pairs with weight = `-log(effective_rate)`
- **Effective rate**: `reserve_out / reserve_in × (1 - fee)`

**Arbitrage exists** ⟺ **Negative cycle exists** in log-weighted graph

### Why Logarithms?

Converts multiplication chain to addition:
- Original: `∏(rates) > 1` (profit condition)
- Log form: `Σ(-log(rates)) < 0` (negative cycle)

This enables shortest-path algorithms (Bellman-Ford, SPFA) to detect arbitrage.

---

## Detection Algorithms

### Bellman-Ford
- Time: O(V × E)
- Detects negative cycles after V iterations
- Guaranteed correctness
- Use when: correctness is paramount, graph is dense

### SPFA (Shortest Path Faster Algorithm)
- Average: O(E), Worst: O(V × E)
- Queue-based optimization of Bellman-Ford
- Track path length; cycle detected when `len[v] >= n`
- Use when: graph is sparse, need speed
- **Caveat**: Slows when negative cycles exist (repeated recalculations)

See [cycle-detection.md](cycle-detection.md) for implementation details.

---

## AMM Price Mathematics

### Constant Product (CPMM): x × y = k

```
price = reserve_y / reserve_x
amount_out = (reserve_y × amount_in × (1 - fee)) / (reserve_x + amount_in × (1 - fee))
```

### Concentrated Liquidity (CLMM)

- Liquidity concentrated in price ranges [p_lower, p_upper]
- Uses sqrt-price representation: `sqrt_price = √(price)`
- Tick-based discretization: `tick = log₁.₀₀₀₁(sqrt_price)`
- More capital efficient but complex swap math

See [amm-mathematics.md](amm-mathematics.md) for full formulas.

---

## Flash Loans

Uncollateralized loans within single atomic transaction:
1. Borrow assets (no collateral required)
2. Execute arbitrage trades
3. Repay loan + fee
4. Transaction reverts if repayment fails

**Implications**: Enables capital-free arbitrage; attackers demonstrated 500k%+ returns [Qin 2021].

See [flash-loans.md](flash-loans.md) for patterns.

---

## MEV and Transaction Ordering

### Ethereum
- Block builders order transactions for MEV extraction
- Sandwich attacks: frontrun + backrun victim trades
- Flashbots/MEV-Boost for private transaction submission

### Solana (Jito)
- **Bundles**: atomic, sequential, all-or-nothing transaction groups
- **Block Engine**: off-chain auction for bundle inclusion
- **Statistics**: >96% of arb attempts fail; median profit ~$0.02 [Jito 2022]

See [mev-protection.md](mev-protection.md) for strategies.

---

## Optimal Trade Sizing

**Price impact** increases with trade size relative to pool liquidity:

```
impact ≈ amount_in / reserve_in  (for small trades)
```

**Optimal size** balances:
- Larger trade → more absolute profit per cycle
- Larger trade → more slippage, may eliminate profit margin

Closed-form solutions exist for N-token geometric mean AMMs [Angeris 2024].

See [optimal-execution.md](optimal-execution.md) for details.

---

## Quick Reference: Profitability Check

```python
def is_profitable(cycle_edges, input_amount, gas_cost_in_token):
    """Check if arbitrage cycle is profitable after fees and slippage."""
    amount = input_amount
    for edge in cycle_edges:
        amount = get_output_amount(edge.pool, amount, edge.direction)
    profit = amount - input_amount
    return profit > gas_cost_in_token
```

---

## Quick Reference: Edge Weight Calculation

```python
def calculate_edge_weight(reserve_in, reserve_out, fee_bps):
    """Calculate log-space edge weight for cycle detection."""
    fee_multiplier = 1 - (fee_bps / 10000)
    effective_rate = (reserve_out / reserve_in) * fee_multiplier
    return -math.log(effective_rate)
```

---

## Additional Resources

- [cycle-detection.md](cycle-detection.md) - Bellman-Ford, SPFA implementations
- [amm-mathematics.md](amm-mathematics.md) - Full AMM formulas for CPMM, CLMM
- [flash-loans.md](flash-loans.md) - Flash loan mechanics and patterns
- [mev-protection.md](mev-protection.md) - Jito bundles, frontrun protection
- [optimal-execution.md](optimal-execution.md) - Trade sizing, slippage models
- [references.md](references.md) - Academic paper citations
