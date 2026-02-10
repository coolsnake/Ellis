# AMM Mathematics

## Constant Product Market Maker (CPMM)

The foundational AMM model used by Uniswap V2, Raydium AMM, and similar DEXs.

### Invariant

```
x × y = k
```

Where:
- `x` = reserve of token X
- `y` = reserve of token Y  
- `k` = constant (changes only on liquidity add/remove)

### Spot Price

```
price_Y_in_X = reserve_X / reserve_Y
price_X_in_Y = reserve_Y / reserve_X
```

### Swap Output (Exact Input)

Given input amount `Δx` of token X, output of token Y:

```
Δy = (reserve_Y × Δx × (1 - fee)) / (reserve_X + Δx × (1 - fee))
```

Or equivalently:

```
Δy = reserve_Y - k / (reserve_X + Δx × (1 - fee))
```

### Swap Input (Exact Output)

Given desired output `Δy` of token Y, required input of token X:

```
Δx = (reserve_X × Δy) / ((reserve_Y - Δy) × (1 - fee))
```

### Price Impact

```
price_impact = Δx / reserve_X  (approximate, for small trades)
```

Exact effective price vs spot price:

```
effective_price = Δx / Δy
spot_price = reserve_X / reserve_Y
price_impact = (effective_price - spot_price) / spot_price
```

### Implementation

```python
def cpmm_swap_exact_in(reserve_in: int, reserve_out: int, amount_in: int, fee_bps: int) -> int:
    """
    Calculate output amount for exact input swap.
    All amounts in smallest token units (no decimals).
    """
    fee_multiplier = 10000 - fee_bps
    amount_in_with_fee = amount_in * fee_multiplier
    numerator = reserve_out * amount_in_with_fee
    denominator = reserve_in * 10000 + amount_in_with_fee
    return numerator // denominator

def cpmm_swap_exact_out(reserve_in: int, reserve_out: int, amount_out: int, fee_bps: int) -> int:
    """
    Calculate input amount for exact output swap.
    """
    fee_multiplier = 10000 - fee_bps
    numerator = reserve_in * amount_out * 10000
    denominator = (reserve_out - amount_out) * fee_multiplier
    return (numerator // denominator) + 1  # Round up
```

---

## Constant Sum Market Maker (CSMM)

Rarely used due to complete liquidity drain vulnerability.

### Invariant

```
x + y = k
```

### Properties
- Constant price regardless of trade size
- Single large trade can drain one side completely
- Used in some stablecoin pools with price bands

---

## Concentrated Liquidity Market Maker (CLMM)

Used by Uniswap V3, Orca Whirlpools, Raydium CLMM.

### Core Concepts

**Liquidity concentration**: LPs provide liquidity only within price range [p_a, p_b].

**Virtual reserves**: Within a range, behaves like CPMM with "virtual" reserves.

**Ticks**: Price space divided into discrete ticks for gas efficiency.

### Price Representation

Uses sqrt-price for computational efficiency:

```
sqrt_price = √(price) = √(reserve_Y / reserve_X)
```

Price at tick `i`:

```
sqrt_price_at_tick(i) = 1.0001^(i/2)
price_at_tick(i) = 1.0001^i
```

Tick from price:

```
tick = floor(log(sqrt_price) / log(√1.0001))
     = floor(log(price) / log(1.0001))
```

### Liquidity

Within a single tick range, liquidity `L` relates to reserves:

```
L = √(x × y)

x = L × (1/√P - 1/√P_upper)
y = L × (√P - √P_lower)
```

Where `P` is current price, `P_lower` and `P_upper` are tick boundaries.

### Swap Within Single Tick

When price stays within one tick range:

```python
def clmm_swap_within_tick(
    liquidity: int,
    sqrt_price: int,      # Q64.64 fixed-point
    sqrt_price_limit: int,
    amount_in: int,
    zero_for_one: bool    # True if swapping token0 for token1
) -> tuple[int, int]:     # (amount_out, new_sqrt_price)
    """
    Simplified single-tick swap calculation.
    """
    if zero_for_one:
        # Price decreases (selling token0)
        # Δ√P = Δx × √P / L
        delta_sqrt_price = (amount_in * sqrt_price) // liquidity
        new_sqrt_price = sqrt_price - delta_sqrt_price
        new_sqrt_price = max(new_sqrt_price, sqrt_price_limit)
        
        # amount_out = L × (√P_old - √P_new)
        amount_out = liquidity * (sqrt_price - new_sqrt_price) // (1 << 64)
    else:
        # Price increases (selling token1)
        # Δ√P = Δy / L
        delta_sqrt_price = (amount_in << 64) // liquidity
        new_sqrt_price = sqrt_price + delta_sqrt_price
        new_sqrt_price = min(new_sqrt_price, sqrt_price_limit)
        
        # amount_out = L × (1/√P_new - 1/√P_old)
        amount_out = liquidity * (1/new_sqrt_price - 1/sqrt_price)  # simplified
    
    return amount_out, new_sqrt_price
```

### Cross-Tick Swaps

When swap crosses tick boundaries:

1. Consume liquidity in current tick up to boundary
2. Cross tick: add/remove liquidity based on positions at that tick
3. Continue swap in new tick range
4. Repeat until swap complete or slippage limit hit

```python
def clmm_swap(pool_state, amount_in, zero_for_one, sqrt_price_limit):
    """
    Full CLMM swap handling tick crossings.
    """
    amount_remaining = amount_in
    amount_out = 0
    sqrt_price = pool_state.sqrt_price
    liquidity = pool_state.liquidity
    tick = pool_state.tick
    
    while amount_remaining > 0:
        # Get next initialized tick
        next_tick = get_next_initialized_tick(pool_state, tick, zero_for_one)
        sqrt_price_next_tick = sqrt_price_at_tick(next_tick)
        
        # Clamp to price limit
        if zero_for_one:
            sqrt_price_target = max(sqrt_price_next_tick, sqrt_price_limit)
        else:
            sqrt_price_target = min(sqrt_price_next_tick, sqrt_price_limit)
        
        # Swap within current tick range
        (amount_in_step, amount_out_step, sqrt_price_new) = compute_swap_step(
            sqrt_price, sqrt_price_target, liquidity, amount_remaining
        )
        
        amount_remaining -= amount_in_step
        amount_out += amount_out_step
        sqrt_price = sqrt_price_new
        
        # Check if we crossed a tick
        if sqrt_price == sqrt_price_next_tick:
            # Cross tick - update liquidity
            liquidity_delta = get_liquidity_delta_at_tick(pool_state, next_tick)
            if zero_for_one:
                liquidity -= liquidity_delta
                tick = next_tick - 1
            else:
                liquidity += liquidity_delta
                tick = next_tick
        
        # Check price limit
        if sqrt_price == sqrt_price_limit:
            break
    
    return amount_out, sqrt_price, tick
```

### Fee Calculation

Fees accrue inside the swap formula. For CLMM:

```
fee_amount = amount_in × fee_rate
amount_in_after_fee = amount_in - fee_amount
```

Fees are distributed proportionally to active liquidity providers.

---

## Geometric Mean Market Maker (G3MM)

Generalization for N-token pools (Balancer-style).

### Invariant

```
∏(reserve_i^weight_i) = k
```

Where `weight_i` sum to 1.

### Spot Price

```
price_j_in_i = (reserve_i / weight_i) / (reserve_j / weight_j)
```

### Arbitrage

Closed-form optimal arbitrage exists for G3MMs [Angeris 2024]:

```
For 2-token: optimal_trade solves quadratic equation
For N-token: analytical solution with matrix operations
```

---

## StableSwap (Curve)

Hybrid between constant product and constant sum for correlated assets.

### Invariant

```
A × n^n × Σx_i + D = A × D × n^n + D^(n+1) / (n^n × ∏x_i)
```

Where:
- `A` = amplification coefficient (higher = flatter curve)
- `n` = number of tokens
- `D` = invariant (total value when balanced)

### Properties
- Low slippage for trades near peg
- Approaches constant sum when A → ∞
- Approaches constant product when A → 0

---

## Dynamic Liquidity Market Maker (DLMM)

Used by Meteora. Combines concentrated liquidity with dynamic fees.

### Key Features
- Liquidity in discrete price bins
- Variable fee based on volatility
- Bin step determines price granularity

### Bin Mechanics

```
price_at_bin(id) = (1 + bin_step)^(id - 8388608)
```

Each bin holds one token type:
- Bins below current price: hold token Y
- Bins above current price: hold token X
- Active bin: holds both tokens

---

## Common Gotchas

### Decimal Handling

Always normalize to common precision before calculations:

```python
def normalize_amount(amount: int, decimals: int, target_decimals: int = 18) -> int:
    if decimals < target_decimals:
        return amount * (10 ** (target_decimals - decimals))
    else:
        return amount // (10 ** (decimals - target_decimals))
```

### Rounding

- **Swap exact-in**: Round output DOWN (favor pool)
- **Swap exact-out**: Round input UP (favor pool)
- **Fee calculation**: Round UP (favor pool)

### Overflow Prevention

For CPMM with large reserves, use checked arithmetic:

```rust
// Bad: may overflow
let output = (reserve_out * amount_in) / (reserve_in + amount_in);

// Good: use u128 intermediate
let output = ((reserve_out as u128) * (amount_in as u128) 
    / ((reserve_in as u128) + (amount_in as u128))) as u64;
```

### Price Inversion

Be consistent about price direction:

```
price_X_per_Y = reserve_X / reserve_Y  (how much X for 1 Y)
price_Y_per_X = reserve_Y / reserve_X  (how much Y for 1 X)
```

Arbitrage graph edges should all use same convention.
