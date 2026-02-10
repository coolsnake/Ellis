# MEV Protection

## What is MEV?

**Maximal Extractable Value (MEV)** is value extracted by including, excluding, or reordering transactions in a block. Originally "Miner Extractable Value" on PoW Ethereum.

### Common MEV Extraction Methods

| Method | Description | Impact |
|--------|-------------|--------|
| **Arbitrage** | Profit from price discrepancies across venues | Generally positive (price alignment) |
| **Sandwich Attack** | Frontrun + backrun victim trade | Negative for victim (worse execution) |
| **Liquidation** | Race to liquidate undercollateralized positions | Neutral (necessary for protocol health) |
| **Frontrunning** | Copy profitable transaction with higher priority | Negative for original submitter |

---

## Ethereum MEV Landscape

### Pre-Merge (PoW)
- Miners controlled transaction ordering
- Priority Gas Auctions (PGA): bots bid up gas for favorable position
- Network congestion from failed arbitrage attempts

### Post-Merge (PoS)
- Block builders construct blocks, proposers include them
- **Flashbots/MEV-Boost**: Private transaction submission
- PBS (Proposer-Builder Separation): Reduces validator centralization pressure

### Block Building Flow

```
1. Users submit transactions to public mempool OR private relay
2. Searchers find MEV opportunities
3. Searchers create "bundles" (ordered transaction groups)
4. Builders combine bundles into blocks
5. Builders bid for block inclusion
6. Proposer selects highest-bidding block
```

---

## Solana MEV with Jito

Solana's architecture differs from Ethereum:
- Continuous block production (not discrete slots)
- Leader schedule known in advance
- No native mempool (direct leader submission)

### Jito Infrastructure

**Jito-Solana**: Modified validator client optimized for MEV.

**Block Engine**: Off-chain system that:
- Receives bundles from searchers
- Simulates and validates bundles
- Auctions block space to highest bidders
- Forwards winning bundles to validators

**Bundles**: Atomic transaction groups with properties:
- Execute sequentially in specified order
- All-or-nothing: entire bundle succeeds or fails
- Tip attached to incentivize inclusion

### Bundle Structure

```typescript
interface JitoBundle {
    transactions: VersionedTransaction[];  // Ordered list
    tip: number;                           // Tip in lamports
}
```

### Submitting Bundles

```typescript
import { SearcherClient } from 'jito-ts/dist/sdk/block-engine/searcher';

async function submitBundle(
    client: SearcherClient,
    transactions: VersionedTransaction[],
    tipLamports: number
) {
    // Create tip instruction
    const tipIx = SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: JITO_TIP_ACCOUNT,  // Rotates each epoch
        lamports: tipLamports,
    });
    
    // Add tip to last transaction
    const tipTx = new Transaction().add(tipIx);
    transactions.push(tipTx);
    
    // Send bundle
    const bundleId = await client.sendBundle(transactions);
    
    // Monitor status
    const status = await client.getBundleStatuses([bundleId]);
    return status;
}
```

### Jito Tip Accounts

Tips go to one of 8 tip accounts (rotates):

```typescript
const JITO_TIP_ACCOUNTS = [
    '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
    'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
    'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
    'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
    'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
    'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
    'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
    '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
];

function getRandomTipAccount(): PublicKey {
    const idx = Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length);
    return new PublicKey(JITO_TIP_ACCOUNTS[idx]);
}
```

---

## Sandwich Attack Protection

### What is a Sandwich Attack?

```
1. Victim submits swap: Buy TOKEN with USDC
2. Attacker sees in mempool
3. Attacker frontrun: Buy TOKEN (raises price)
4. Victim's trade executes at worse price
5. Attacker backrun: Sell TOKEN (profit from victim's price impact)
```

### Protection Strategies

**1. Slippage Limits**
```typescript
// Set tight slippage to make sandwich unprofitable
const maxSlippage = 0.005;  // 0.5%
const minOutput = expectedOutput * (1 - maxSlippage);
```

**2. Private Transaction Submission**
- Ethereum: Flashbots Protect RPC
- Solana: Jito bundles (your arb is the bundle, not in mempool)

**3. Commit-Reveal Schemes**
- Commit: Submit hash of trade intent
- Reveal: Execute after commitment recorded
- Attacker can't know trade details during commit phase

**4. DEX-Level Protection**
- Some DEXs implement MEV protection
- Time-weighted execution
- Batch auctions

---

## Arbitrage MEV Strategy

As an arbitrageur, you ARE the MEV extractor. Strategies:

### 1. Speed Optimization

Win by being faster:
- Co-located infrastructure
- Optimized transaction construction
- Pre-signed transactions ready to send
- WebSocket for lowest latency pool updates

### 2. Bundle Strategy (Jito)

```typescript
async function executeArbitrageBundle(opportunity: Opportunity) {
    const transactions = buildArbitrageTransactions(opportunity);
    
    // Calculate optimal tip
    // Higher tip = higher inclusion probability
    // But cuts into profit
    const profitLamports = opportunity.expectedProfit;
    const tipLamports = Math.floor(profitLamports * 0.5);  // 50% to tip
    
    // Submit as bundle
    await submitBundle(jitoClient, transactions, tipLamports);
}
```

### 3. Backrun Strategy

Instead of competing for same opportunity, backrun other transactions:

```
1. Monitor mempool/block engine for large swaps
2. Identify arbitrage created by the swap
3. Submit bundle: [victim_tx, your_arb_tx]
4. Your arb executes immediately after, capturing created inefficiency
```

### 4. Multi-Block Strategy

For opportunities too large for single block:
- Split across multiple transactions
- Accept some execution risk
- Use TWAPs or gradual execution

---

## Priority Fee Optimization

### Solana Priority Fees

```typescript
const computeBudgetIx = ComputeBudgetProgram.setComputeUnitPrice({
    microLamports: priorityFeePerCU,
});

// Add as first instruction
transaction.instructions.unshift(computeBudgetIx);
```

### Dynamic Fee Calculation

```typescript
async function calculateOptimalPriorityFee(
    expectedProfit: number,
    estimatedCU: number,
    competitionLevel: 'low' | 'medium' | 'high'
): Promise<number> {
    // Base fee from recent blocks
    const recentFees = await getRecentPriorityFees();
    const medianFee = percentile(recentFees, 50);
    
    // Adjust for competition
    const multiplier = {
        low: 1.0,
        medium: 1.5,
        high: 2.5,
    }[competitionLevel];
    
    const suggestedFee = medianFee * multiplier;
    
    // Cap at fraction of profit
    const maxFee = (expectedProfit * 0.3) / estimatedCU;
    
    return Math.min(suggestedFee, maxFee);
}
```

---

## Monitoring and Analytics

### MEV Dashboard Metrics

Track these for your arbitrage bot:

| Metric | Description |
|--------|-------------|
| **Success Rate** | % of submitted bundles/txs that land |
| **Profit per Opportunity** | Gross and net (after fees, tips) |
| **Latency** | Time from opportunity detection to submission |
| **Revert Rate** | % of landed txs that revert |
| **Tip Efficiency** | Tip paid vs minimum needed for inclusion |

### Jito Bundle Status

```typescript
type BundleStatus = 
    | 'Pending'      // In queue
    | 'Landed'       // Included in block
    | 'Failed'       // Simulation failed
    | 'Dropped'      // Not included (outbid or expired)
    | 'Invalid';     // Malformed bundle

async function monitorBundle(bundleId: string) {
    const status = await jitoClient.getBundleStatuses([bundleId]);
    
    if (status[0].status === 'Landed') {
        console.log(`Bundle landed in slot ${status[0].slot}`);
    } else if (status[0].status === 'Dropped') {
        console.log('Bundle dropped - consider higher tip');
    }
}
```

---

## Security Best Practices

### 1. Simulation Before Submission

Always simulate to verify profitability:

```typescript
async function simulateAndSubmit(tx: VersionedTransaction) {
    const simulation = await connection.simulateTransaction(tx);
    
    if (simulation.value.err) {
        console.log('Simulation failed:', simulation.value.err);
        return;
    }
    
    // Check logs for expected profit
    const profitLog = simulation.value.logs?.find(l => l.includes('profit:'));
    if (!profitLog || extractProfit(profitLog) < MIN_PROFIT) {
        console.log('Insufficient profit in simulation');
        return;
    }
    
    // Submit only if simulation passes
    await submitBundle(tx);
}
```

### 2. Timeout and Staleness

Opportunities are time-sensitive:

```typescript
const OPPORTUNITY_TTL_MS = 500;  // 500ms max age

function isOpportunityFresh(opportunity: Opportunity): boolean {
    return Date.now() - opportunity.detectedAt < OPPORTUNITY_TTL_MS;
}
```

### 3. Rate Limiting

Avoid burning compute on stale/competed opportunities:

```typescript
const submissionRateLimiter = new RateLimiter({
    tokensPerInterval: 10,
    interval: 'second',
});

async function submitWithRateLimit(bundle: Bundle) {
    await submissionRateLimiter.removeTokens(1);
    return submitBundle(bundle);
}
```
