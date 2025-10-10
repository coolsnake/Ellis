# Parameters Catalog
Use anchors (copy link) to reference parameters from the UI tooltips.

### Execution

<a id="cooldownMs"></a>
## Cooldown between trades (ms) (cooldownMs)
> Type: integer:ms • Default: 2000 • Min: 0 • Max: 60000
**Purpose**: Avoid spamming orders in bursts.
**When to change**: Increase if markets are choppy; decrease if opportunities are fleeting.
**Risks**: Too short causes churn; too long misses windows.
### Recommended ranges
- stable: 500–2000
- volatile: 1000–5000
### Examples
- Safe: 3000
- Aggressive: 500
Used by: threshold, grid

<a id="maxSlippageBps"></a>
## Max slippage (maxSlippageBps)
> Type: integer:bps • Default: 50 • Min: 0 • Max: 300
**Purpose**: Cap price impact on fills.
**When to change**: Increase for volatile/illiquid markets; decrease in tight markets.
**Risks**: Too low rejects trades; too high causes bad fills.
**Rationale**: Balance fill probability vs adverse selection.
### Recommended ranges
- stable: 10–30
- volatile: 40–100
### Examples
- Stable pools: 15 bps
- Volatile: 75 bps
Used by: threshold, grid

### Risk

<a id="notionalCap"></a>
## Max notional per trade (USD) (notionalCap)
> Type: number:usd • Default: 500 • Min: 0 • Max: 100000
**Purpose**: Limit exposure per fill.
**When to change**: Increase with strong liquidity and confidence; decrease when testing.
**Risks**: Too high concentrates risk; too low increases missed opportunities.
### Recommended ranges
- stable: 250–1,000
- volatile: 100–500
### Examples
- Safe: 100
- Balanced: 500
- Aggressive: 2000
Used by: threshold, grid

### Strategy

<a id="gridStepPercent"></a>
## Grid step percent (gridStepPercent)
> Type: number:percent • Default: 0.5 • Min: 0.05 • Max: 5
**Purpose**: Price spacing between grid levels.
**When to change**: Increase in high volatility; decrease in tight ranges.
**Risks**: Too small overtrades; too large misses trades.
### Recommended ranges
- stable: 0.25–0.75
- volatile: 0.75–2.0
### Examples
- Balanced: 0.5%
Used by: grid

<a id="minProfitBps"></a>
## Minimum target profit (minProfitBps)
> Type: integer:bps • Default: 20 • Min: 0 • Max: 500
**Purpose**: Discard routes below this net profit.
**When to change**: Increase if slippage is high; decrease if fills are rare.
**Risks**: Too high misses profitable routes; too low captures noise.
### Recommended ranges
- stable: 10–30
- volatile: 30–80
### Examples
- Stable: 20
- Volatile: 50
Used by: threshold

### Routing

<a id="maxHops"></a>
## Max route hops (maxHops)
> Type: integer • Default: 3 • Min: 1 • Max: 6
**Purpose**: Cap path complexity to control execution risk.
**When to change**: Increase if liquidity fragmented; decrease to reduce failure surface.
**Risks**: More hops increase slippage + failure probability.
### Recommended ranges
- stable: 2–3
- volatile: 2–4
### Examples
- Balanced: 3
Used by: threshold
