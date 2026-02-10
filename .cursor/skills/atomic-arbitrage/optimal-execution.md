# Optimal Execution

## Slippage and Price Impact

### Definitions

**Slippage**: Difference between expected and actual execution price, caused by:
- Market movement between quote and execution
- Other transactions executing first
- Network/block delays

**Price Impact**: Adverse price movement caused by your own trade's effect on the pool.

### Price Impact in CPMM

For constant product pools (x × y = k):

```
price_impact ≈ trade_size / reserve_in  (for small trades)
```

Exact calculation:

```python
def price_impact_cpmm(reserve_in: float, reserve_out: float, amount_in: float) -> float:
    """Calculate exact price impact for CPMM swap."""
    spot_price = reserve_out / reserve_in
    
    # Actual output (ignoring fees for simplicity)
    amount_out = (reserve_out * amount_in) / (reserve_in + amount_in)
    effective_price = amount_in / amount_out
    
    impact = (effective_price - spot_price) / spot_price
    return impact
```

### Price Impact in CLMM

Concentrated liquidity pools have variable impact based on liquidity distribution:

- **Within single tick**: Similar to CPMM scaled by concentration factor
- **Cross-tick swaps**: Impact compounds as liquidity changes at tick boundaries
- **Empty ticks**: Price can jump significantly if liquidity gaps exist

---

## Optimal Trade Sizing

### The Core Tradeoff

```
Larger trade → More absolute profit (if opportunity exists)
Larger trade → More price impact → Reduced profit margin
```

There exists an optimal trade size that maximizes profit.

### Analytical Solution for CPMM Arbitrage

For triangular arbitrage A→B→C→A:

```python
def optimal_trade_size_triangular(
    r1_in: float, r1_out: float, fee1: float,  # Pool A→B
    r2_in: float, r2_out: float, fee2: float,  # Pool B→C  
    r3_in: float, r3_out: float, fee3: float,  # Pool C→A
) -> float:
    """
    Calculate optimal input amount for triangular arbitrage.
    
    Based on solving d(profit)/d(amount) = 0 for CPMM.
    """
    # Effective rate for each leg (including fees)
    e1 = (r1_out / r1_in) * (1 - fee1)
    e2 = (r2_out / r2_in) * (1 - fee2)
    e3 = (r3_out / r3_in) * (1 - fee3)
    
    # Combined rate
    combined_rate = e1 * e2 * e3
    
    # If no arbitrage opportunity
    if combined_rate <= 1:
        return 0
    
    # Optimal amount (simplified, assumes small relative to reserves)
    # More accurate: solve cubic equation from derivative
    
    # Approximate optimal as fraction of smallest reserve
    min_reserve = min(r1_in, r2_in / e1, r3_in / (e1 * e2))
    
    # Heuristic: optimal around (rate - 1) * reserve / 4
    optimal = min_reserve * (combined_rate - 1) / 4
    
    return optimal
```

### Binary Search for Optimal Size

When analytical solution is complex, use binary search:

```python
def find_optimal_trade_size(
    simulate_profit: Callable[[float], float],
    max_amount: float,
    tolerance: float = 0.001
) -> float:
    """
    Find optimal trade size using ternary search.
    
    Assumes profit function is unimodal (increases then decreases).
    """
    lo, hi = 0, max_amount
    
    while hi - lo > tolerance:
        mid1 = lo + (hi - lo) / 3
        mid2 = hi - (hi - lo) / 3
        
        profit1 = simulate_profit(mid1)
        profit2 = simulate_profit(mid2)
        
        if profit1 < profit2:
            lo = mid1
        else:
            hi = mid2
    
    return (lo + hi) / 2
```

### Closed-Form for N-Token AMMs

Recent research provides analytical solutions for geometric mean AMMs [Angeris 2024]:

```python
def optimal_arbitrage_gmm(
    reserves: List[float],
    weights: List[float],
    external_prices: List[float],
    fees: List[float]
) -> List[float]:
    """
    Closed-form optimal arbitrage for Geometric Mean Market Makers.
    
    Returns optimal trade amounts for each token.
    Based on arXiv:2402.06731
    """
    # Implementation involves matrix operations
    # See paper for full derivation
    pass
```

Advantages of closed-form:
- Deterministic computation time
- Parallelizable (GPU-friendly)
- No iteration/convergence issues

---

## Slippage Tolerance Setting

### For Arbitrage Execution

```python
def calculate_slippage_tolerance(
    expected_profit_bps: float,
    confidence_level: float = 0.95
) -> float:
    """
    Set slippage tolerance based on expected profit.
    
    If opportunity has 50 bps profit, set tolerance < 50 bps
    to ensure profitability.
    """
    # Leave buffer for gas costs and safety
    safety_margin = 0.2  # Keep 20% of profit as buffer
    
    max_slippage = expected_profit_bps * (1 - safety_margin)
    
    return max_slippage / 10000  # Convert to decimal
```

### Dynamic Slippage

Adjust based on market conditions:

```python
def dynamic_slippage(
    base_slippage: float,
    volatility_24h: float,
    trade_size_vs_liquidity: float
) -> float:
    """
    Adjust slippage for current conditions.
    """
    # Higher volatility → need more slippage tolerance
    volatility_multiplier = 1 + (volatility_24h / 0.1)  # Normalize to 10% vol
    
    # Larger trade relative to liquidity → more impact
    size_multiplier = 1 + trade_size_vs_liquidity
    
    return min(base_slippage * volatility_multiplier * size_multiplier, 0.05)  # Cap at 5%
```

---

## Multi-Hop Optimization

### Path vs Direct Trade

Sometimes A→C via A→B→C is better than direct A→C:

```python
def compare_routes(
    amount_in: float,
    direct_pool: Pool,          # A→C directly
    hop_pools: List[Pool],      # A→B→C
) -> str:
    """Compare direct vs multi-hop execution."""
    
    # Direct route
    direct_out = direct_pool.get_output(amount_in)
    
    # Multi-hop
    current = amount_in
    for pool in hop_pools:
        current = pool.get_output(current)
    hop_out = current
    
    if hop_out > direct_out:
        return 'multi-hop'
    else:
        return 'direct'
```

### Split Routing

For large trades, split across multiple pools:

```python
def optimal_split(
    amount_in: float,
    pools: List[Pool],  # Multiple pools for same pair
) -> List[float]:
    """
    Find optimal split across pools to minimize total impact.
    
    Uses convex optimization (each pool has diminishing returns).
    """
    from scipy.optimize import minimize
    
    def negative_total_output(splits):
        total = 0
        for i, pool in enumerate(pools):
            if splits[i] > 0:
                total += pool.get_output(splits[i])
        return -total
    
    # Constraints: splits sum to amount_in, all non-negative
    constraints = [
        {'type': 'eq', 'fun': lambda x: sum(x) - amount_in}
    ]
    bounds = [(0, amount_in) for _ in pools]
    
    # Initial guess: equal split
    x0 = [amount_in / len(pools)] * len(pools)
    
    result = minimize(negative_total_output, x0, bounds=bounds, constraints=constraints)
    
    return list(result.x)
```

---

## Gas/CU Cost Considerations

### Solana Compute Unit Estimation

```typescript
const CU_COSTS = {
    base_tx: 5000,
    token_transfer: 3000,
    cpmm_swap: 50000,
    clmm_swap: 150000,  // Higher due to tick math
    flash_borrow: 20000,
    flash_repay: 20000,
};

function estimateTotalCU(swaps: SwapType[]): number {
    let total = CU_COSTS.base_tx;
    
    for (const swap of swaps) {
        total += swap.poolType === 'clmm' 
            ? CU_COSTS.clmm_swap 
            : CU_COSTS.cpmm_swap;
    }
    
    return total;
}
```

### Profitability Threshold

```typescript
function isProfitable(
    grossProfit: number,
    estimatedCU: number,
    priorityFeePerCU: number,
    baseFee: number,
    jitoTip: number
): boolean {
    const cuCost = estimatedCU * priorityFeePerCU / 1_000_000;  // Convert microlamports
    const totalCost = baseFee + cuCost + jitoTip;
    
    const netProfit = grossProfit - totalCost;
    const MIN_PROFIT_LAMPORTS = 10000;  // 0.00001 SOL minimum
    
    return netProfit > MIN_PROFIT_LAMPORTS;
}
```

---

## Execution Timing

### Opportunity Decay

Arbitrage opportunities decay rapidly:

```python
def opportunity_value_decay(
    initial_profit: float,
    age_ms: float,
    half_life_ms: float = 200
) -> float:
    """
    Model opportunity decay as exponential.
    
    Half-life of ~200ms means opportunity loses 50% value
    every 200ms due to competition.
    """
    decay_factor = 0.5 ** (age_ms / half_life_ms)
    return initial_profit * decay_factor
```

### Staleness Check

```python
MAX_OPPORTUNITY_AGE_MS = 500

def should_execute(opportunity: Opportunity) -> bool:
    age = time.time() * 1000 - opportunity.detected_at_ms
    
    if age > MAX_OPPORTUNITY_AGE_MS:
        return False
    
    decayed_profit = opportunity_value_decay(
        opportunity.expected_profit,
        age
    )
    
    return decayed_profit > MIN_PROFIT_THRESHOLD
```

---

## Simulation Best Practices

### Always Simulate Before Execution

```typescript
async function simulateArbitrage(
    connection: Connection,
    transaction: VersionedTransaction
): Promise<SimulationResult> {
    const sim = await connection.simulateTransaction(transaction, {
        sigVerify: false,
        replaceRecentBlockhash: true,
    });
    
    if (sim.value.err) {
        return { success: false, error: sim.value.err };
    }
    
    // Parse logs for profit
    const profitLog = sim.value.logs?.find(l => l.includes('profit'));
    const profit = profitLog ? parseProfit(profitLog) : 0;
    
    return {
        success: true,
        unitsConsumed: sim.value.unitsConsumed,
        profit,
        logs: sim.value.logs,
    };
}
```

### Simulation Caveats

1. **State may change**: Between simulation and execution, pool state can change
2. **CU estimation**: Actual CU may differ slightly from simulation
3. **Blockhash expiry**: Simulated tx may expire before landing

Mitigations:
- Use recent blockhash with adequate lifetime
- Add buffer to CU limit (10-20%)
- Re-simulate if significant delay before submission
